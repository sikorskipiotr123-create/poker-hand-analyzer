import type { Card } from './poker';
import type { CallAnalysis } from './calculations';
import type { AnalysisRangeMode, EquityFact, MathematicalContext } from './ai-context';
import type { RangeEquityResult, RangeHandKey } from './range';

export type AIEquitySource = 'known-hand' | 'custom-range';
export type AIEquityTarget = { source: AIEquitySource; villain: { mode: 'hand'; cards: Card[] } | { mode: 'range'; range: RangeHandKey[] } };

/** Only a dealt Villain hand or a user-selected Custom range can define math equity in AI mode. */
export function getAIEquityTarget(
  hero: Card[], villain: Card[], villainRangeMode: AnalysisRangeMode, selectedRange: RangeHandKey[],
): AIEquityTarget | null {
  if (hero.length !== 2 || villain.length === 1) return null;
  if (villain.length === 2) return { source: 'known-hand', villain: { mode: 'hand', cards: villain } };
  if (villain.length === 0 && villainRangeMode === 'custom' && selectedRange.length > 0) {
    return { source: 'custom-range', villain: { mode: 'range', range: selectedRange } };
  }
  return null;
}

export function buildAIMathematicalContext(
  equity: RangeEquityResult | null,
  source: AIEquitySource | null,
  unavailableReason: 'auto-range' | 'missing-cards' | 'invalid-input',
  analysis: CallAnalysis,
): MathematicalContext {
  const equityFact: EquityFact = equity && source
    ? { status: 'known', value: equity.equity, source, villainEquity: 1 - equity.equity, tiePercent: equity.tiePercent / 100, method: equity.method, evaluatedCases: equity.samples }
    : { status: 'unknown', reason: unavailableReason };
  const callEV = equityFact.status === 'known' && analysis.callAmount > 0 && analysis.callEv !== null
    ? { status: 'known' as const, value: analysis.callEv }
    : { status: 'unknown' as const, reason: equityFact.status === 'unknown' ? 'equity-unknown' as const : 'no-active-call' as const };
  return { equity: equityFact, requiredEquity: analysis.requiredEquity, callEV };
}
