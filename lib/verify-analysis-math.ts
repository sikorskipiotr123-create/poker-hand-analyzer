import { AnalysisInputError, toCard } from './ai-analysis';
import type { AIAnalysisContext, EquityFact } from './ai-context';
import { calculateCallAnalysis } from './calculations';
import { calculateEquity } from './poker';
export { verifyDeterministicMath } from './analysis-validation';
import { calculateRangeEquity, getAvailableRangeCombinations, RANGE_HANDS } from './range';

// Server policy constants, never request parameters. No Monte Carlo runs in the API.
export const SERVER_EQUITY_CASE_LIMIT = 1_000;
export const SERVER_EQUITY_DEADLINE_MS = 250;
const YIELD_EVERY = 32;
const EPSILON = 1e-7;
let equityInFlight = false; // Per process: reject admission without an unbounded queue.

function withEquity(context: AIAnalysisContext, equity: EquityFact): AIAnalysisContext {
  const analysis = calculateCallAnalysis(context.pot.currentPotBb, context.pot.villainBetBb, context.pot.callAmountBb, equity.status === 'known' ? equity.value : null);
  return { ...context, mathematicalContext: { equity, requiredEquity: analysis.requiredEquity, callEV: equity.status === 'known' && analysis.callAmount > 0 && analysis.callEv !== null ? { status: 'known', value: analysis.callEv } : { status: 'unknown', reason: equity.status === 'unknown' ? 'equity-unknown' : 'no-active-call' } } };
}

/** Called only after attempt admission and concurrency protection, before analysis quota admission. Partial, Monte Carlo and client results never become facts. */
export async function verifyEquity(context: AIAnalysisContext, signal?: AbortSignal): Promise<AIAnalysisContext> {
  const unknown = (reason: Extract<EquityFact, { status: 'unknown' }>['reason']) => withEquity(context, { status: 'unknown', reason });
  const hero = context.hero.cards.map(toCard), board = context.board.map(toCard);
  const knownVillain = context.villain.cards.map(toCard);
  const source = knownVillain.length === 2 ? 'known-hand' : 'custom-range';
  if (!knownVillain.length && context.villain.range.mode === 'auto') return unknown('auto-range');
  const keys = context.villain.range.mode === 'custom' ? context.villain.range.selectedHands.map((label) => RANGE_HANDS.find((hand) => hand.label === label)!.key) : [];
  const combos = knownVillain.length ? [knownVillain] : getAvailableRangeCombinations(keys, [...hero, ...board]);
  if (!combos.length) throw new AnalysisInputError('Villain range has no legal combinations.');
  // Counts for the only possible board lengths, from the remaining 52 - 4 - board cards.
  const runouts = board.length === 5 ? 1 : board.length === 4 ? 44 : board.length === 3 ? 990 : 1_712_304;
  const cases = combos.length * runouts;
  if (cases > SERVER_EQUITY_CASE_LIMIT) return unknown('verification-limit');
  if (equityInFlight) return unknown('verification-busy');
  equityInFlight = true;
  const started = performance.now();
  const shouldCancel = () => signal?.aborted === true || performance.now() - started >= SERVER_EQUITY_DEADLINE_MS;
  try {
    // Yield before admission work, then every 32 cases (range batches at most 44 runouts).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const options = { exactCaseLimit: SERVER_EQUITY_CASE_LIMIT, samples: 1, yieldEvery: YIELD_EVERY, shouldCancel };
    const result = combos.length === 1 ? await calculateEquity(hero, board, combos[0], options) : await calculateRangeEquity(hero, board, keys, options);
    if (shouldCancel() || result.samples !== cases || result.method !== 'exact') return unknown('verification-timeout');
    const submitted = context.mathematicalContext.equity;
    if (submitted.status === 'known') {
      // Independent simulations need not be identical. This is a gross inconsistency check,
      // not certification of a client simulation. Only exact server numbers reach the provider.
      const tolerance = submitted.method === 'exact' ? EPSILON : 0.10;
      if (Math.abs(submitted.value - result.equity) > tolerance || Math.abs(submitted.tiePercent - result.tiePercent / 100) > tolerance || (submitted.method === 'exact' && submitted.evaluatedCases !== cases)) throw new AnalysisInputError('Client equity contradicts server mathematical verification.');
    }
    return withEquity(context, { status: 'known', value: result.equity, villainEquity: 1 - result.equity, tiePercent: result.tiePercent / 100, source, method: 'exact', evaluatedCases: result.samples });
  } finally { equityInFlight = false; }
}
