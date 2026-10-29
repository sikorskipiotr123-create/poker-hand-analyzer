import { calculateActionState } from './action-state';
import { AnalysisInputError, toCard, validateAIAnalysisContext } from './ai-analysis';
import { serializeActions, STREETS, type AIAnalysisContext, type Street } from './ai-context';
import { calculateCallAnalysis } from './calculations';
import { suggestNextAction } from './next-action';
import { getRangeSummary, RANGE_HANDS } from './range';

const EPSILON = 1e-7;
export type HandValidationCode = 'sequence' | 'boardBehind' | 'wager' | 'amount' | 'notReopened' | 'minimumRaise' | 'unresolvedBoard' | 'facts' | 'input';
export class HandValidationError extends AnalysisInputError {
  constructor(public code: HandValidationCode, public index: number | null, public detail?: string, public minimumBb?: number) {
    const messages: Record<HandValidationCode, string> = {
      sequence: 'Action history has an out-of-turn action, skipped street, or unfinished betting round.',
      boardBehind: 'Action history is ahead of the supplied board.',
      wager: 'Action history contains an illegal wager or stack deduction.',
      amount: 'Action history contains an unexpected explicit amount.',
      notReopened: 'Action history attempts to raise when betting has not reopened.',
      minimumRaise: 'Action history contains a bet or raise below the legal minimum.',
      unresolvedBoard: 'Decision point board does not match the unresolved action-history street.',
      facts: 'Call EV status conflicts with the supplied equity and active decision.',
      input: 'Analysis request contains invalid inputs.',
    };
    super(detail ?? messages[code]);
  }
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) <= EPSILON;
function assertFacts(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number' && typeof actual === 'number' && sameNumber(actual, expected)) return;
  if (actual === expected) return;
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    for (const key of Object.keys(expected)) assertFacts((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    return;
  }
  throw new HandValidationError('facts', null, `Mathematical verification failed at ${path}.`);
}
const boardStreet = (count: number): Street => count === 5 ? 'river' : count === 4 ? 'turn' : count === 3 ? 'flop' : 'preflop';

/** Replay validated primitive assumptions; never use submitted totals as replay inputs. */
export function verifyDeterministicMath(context: AIAnalysisContext): AIAnalysisContext {
  const { actionHistory: actions, blinds } = context;
  const positions = { hero: context.hero.position, villain: context.villain.position };
  const stacks = { hero: context.stackState.hero.startingStackBb, villain: context.stackState.villain.startingStackBb };
  let minimumRaise = blinds.bigBlindBb;
  let street: Street = 'preflop';
  const actedSinceFullRaise = new Set<string>();
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    const prefix = actions.slice(0, index);
    const next = suggestNextAction(prefix, positions, blinds, stacks);
    if (!next.player || action.actor !== next.player || action.street !== next.street) throw new HandValidationError('sequence', index);
    if (STREETS.indexOf(action.street) > STREETS.indexOf(boardStreet(context.board.length))) throw new HandValidationError('boardBehind', index);
    if (action.street !== street) { street = action.street; minimumRaise = blinds.bigBlindBb; actedSinceFullRaise.clear(); }
    const before = calculateActionState(prefix, positions, blinds, stacks, action.street);
    const after = calculateActionState(actions.slice(0, index + 1), positions, blinds, stacks, action.street);
    if (after.errors.length) throw new HandValidationError('wager', index, after.errors[0].message);
    const normalized = after.normalizedActions[index];
    const resolution = after.actionResolutions[index];
    if (action.action === 'check' || action.action === 'fold' || action.action === 'all_in') {
      if (action.amountBb !== null) throw new HandValidationError('amount', index);
    } else assertFacts(action.amountBb, normalized.amountBb, `actionHistory[${index}].amountBb`);
    if (action.resolution) assertFacts(action.resolution, { additionalContributionBb: resolution.additionalContributionBb, streetTotalBb: resolution.streetTotalBb, allInKind: resolution.allInKind }, `actionHistory[${index}].resolution`);
    const increase = resolution.streetTotalBb - before.currentWagerBb;
    if (increase > EPSILON) {
      if (actedSinceFullRaise.has(action.actor)) throw new HandValidationError('notReopened', index);
      if (increase + EPSILON < minimumRaise && !resolution.player.isAllIn) throw new HandValidationError('minimumRaise', index, undefined, before.currentWagerBb + minimumRaise);
      if (increase + EPSILON >= minimumRaise) { minimumRaise = increase; actedSinceFullRaise.clear(); }
    }
    actedSinceFullRaise.add(action.actor);
  }
  const next = suggestNextAction(actions, positions, blinds, stacks);
  const state = calculateActionState(actions, positions, blinds, stacks, next.street);
  if (state.errors.length) throw new HandValidationError('wager', null, state.errors[0].message);
  const decision = state.decisionPoint;
  const last = actions.at(-1);
  if (last && (state.amountToCall.hero > EPSILON || state.amountToCall.villain > EPSILON) && last.action !== 'fold' && last.street !== boardStreet(context.board.length)) throw new HandValidationError('unresolvedBoard', actions.length - 1);
  // A Villain all-in call closes action; it is not a new wager facing Hero.
  const activeDecision = decision && decision.amountDueBb > EPSILON ? decision : null;
  const analysis = calculateCallAnalysis(activeDecision?.potBeforeOpponentActionBb ?? state.potBb, activeDecision?.contestableOpponentBetBb ?? 0, activeDecision?.callAmountBb ?? 0, null);
  const pot = { currentPotBb: analysis.pot, villainBetBb: analysis.villainBet, callAmountBb: analysis.callAmount, finalPotBb: analysis.finalPot };
  const player = (name: 'hero' | 'villain') => ({ startingStackBb: state.players[name].startingStackBb, remainingStackBb: state.players[name].remainingStackBb, isAllIn: state.players[name].isAllIn });
  const stackState = { hero: player('hero'), villain: player('villain'), startingEffectiveStackBb: state.startingEffectiveStackBb, currentEffectiveStackBb: state.currentEffectiveStackBb, spr: activeDecision?.spr ?? state.spr, streetStartPotBb: state.streetStartPotBb, streetStartEffectiveStackBb: state.streetStartEffectiveStackBb, streetStartSpr: state.streetStartSpr, facingAllIn: activeDecision?.facingAllIn ?? false, canFullCall: activeDecision?.canFullCall ?? false };
  assertFacts(context.pot, pot, 'pot');
  assertFacts(context.stackState, stackState, 'stackState');
  assertFacts(context.mathematicalContext.requiredEquity, analysis.requiredEquity, 'requiredEquity');
  const submittedMath = context.mathematicalContext;
  const expectedClientEV = calculateCallAnalysis(pot.currentPotBb, pot.villainBetBb, pot.callAmountBb, submittedMath.equity.status === 'known' ? submittedMath.equity.value : null);
  if (submittedMath.callEV.status === 'known') assertFacts(submittedMath.callEV.value, expectedClientEV.callEv, 'callEV');
  else if (submittedMath.equity.status === 'known' && (pot.callAmountBb > 0 || submittedMath.callEV.reason !== 'no-active-call')) throw new HandValidationError('facts', null);

  // Range counts were validated during shape validation; replace tolerated rounding with engine output.
  const verifiedRange = (owner: 'hero' | 'villain') => {
    const range = context[owner].range;
    if (range.mode === 'auto') return range;
    const blockers = [...context.board, ...context[owner === 'hero' ? 'villain' : 'hero'].cards].map(toCard);
    const keys = range.selectedHands.map((label) => RANGE_HANDS.find((hand) => hand.label === label)!.key);
    const summary = getRangeSummary(keys, blockers);
    return { ...range, comboCount: summary.selectedCombos, percentage: summary.percentage };
  };
  return { ...context, hero: { ...context.hero, range: verifiedRange('hero') }, villain: { ...context.villain, range: verifiedRange('villain') }, pot, stackState, actionHistory: serializeActions(state.normalizedActions, positions.hero, positions.villain, state.actionResolutions), mathematicalContext: { ...context.mathematicalContext, requiredEquity: analysis.requiredEquity } };
}

/** Validate the exact form payload with the same shape and deterministic checks used by the API.
 * Does not perform equity enumeration, network requests, or mutate the entered hand.
 */
export function validateAnalysisSubmission(createContext: () => AIAnalysisContext): { context: AIAnalysisContext | null; issue: HandValidationError | null } {
  try {
    const context = validateAIAnalysisContext(createContext());
    verifyDeterministicMath(context);
    return { context, issue: null };
  } catch (error) {
    return { context: null, issue: error instanceof HandValidationError ? error : new HandValidationError('input', null) };
  }
}
