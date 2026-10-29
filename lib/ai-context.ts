import type { EquityMethod } from './poker';
import { getRangeHand, type RangeHandKey } from './range';
import type { AppLanguage } from './i18n';

export const POSITIONS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const;
export type Position = (typeof POSITIONS)[number];
export const OPPONENT_PROFILES = ['unknown', 'nit', 'tag', 'lag', 'passive_fish', 'aggressive_fish', 'maniac', 'custom'] as const;
export type OpponentProfile = (typeof OPPONENT_PROFILES)[number];
export type OpponentStats = { vpip: number | null; pfr: number | null; threeBet: number | null; aggressionFactor: number | null };
export const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export type Street = (typeof STREETS)[number];
export const ACTION_TYPES = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export type ActionDraft = { street: Street; actor: 'hero' | 'villain'; action: ActionType; amountBb: number | null };
export type SerializedAction = ActionDraft & { position: Position; resolution?: { additionalContributionBb: number; streetTotalBb: number; allInKind: 'bet-all-in' | 'raise-all-in' | 'call-all-in' | null } };
/** Auto means qualitative inference only; Custom is a user-supplied assumption with no inferred frequencies. */
export type AnalysisRange = { mode: 'auto' } | { mode: 'custom'; selectedHands: RangeHandKey[]; comboCount: number; percentage: number };
export type AnalysisRangeMode = AnalysisRange['mode'];
export const DEFAULT_ANALYSIS_RANGE_MODE: AnalysisRangeMode = 'auto';

export function createAnalysisRange(mode: AnalysisRangeMode, selectedHands: RangeHandKey[], comboCount: number, percentage: number): AnalysisRange {
  if (mode === 'auto') return { mode: 'auto' };
  if (!Number.isInteger(comboCount) || comboCount < 0 || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new RangeError('Custom range summary must contain a non-negative combo count and percentage from 0 to 100.');
  return { mode: 'custom', selectedHands: selectedHands.map((key) => getRangeHand(key)?.label ?? key), comboCount, percentage };
}

export type EquityFact =
  | { status: 'known'; value: number; source: 'known-hand' | 'custom-range'; villainEquity: number; tiePercent: number; method: EquityMethod; evaluatedCases: number }
  | { status: 'unknown'; reason: 'auto-range' | 'missing-cards' | 'invalid-input' | 'verification-limit' | 'verification-busy' | 'verification-timeout' };
export type CallEVFact =
  | { status: 'known'; value: number }
  | { status: 'unknown'; reason: 'equity-unknown' | 'no-active-call' };
export type MathematicalContext = { equity: EquityFact; requiredEquity: number; callEV: CallEVFact };
export type AIAnalysisContext = {
  language: AppLanguage;
  blinds: { smallBlindBb: number; bigBlindBb: number };
  hero: { cards: string[]; position: Position; range: AnalysisRange };
  villain: { cards: string[]; position: Position; profile: OpponentProfile; stats: OpponentStats; range: AnalysisRange };
  board: string[];
  actionHistory: SerializedAction[];
  pot: { currentPotBb: number; villainBetBb: number; callAmountBb: number; finalPotBb: number };
  stackState: { hero: { startingStackBb: number; remainingStackBb: number; isAllIn: boolean }; villain: { startingStackBb: number; remainingStackBb: number; isAllIn: boolean }; startingEffectiveStackBb: number; currentEffectiveStackBb: number; spr: number | null; streetStartPotBb: number; streetStartEffectiveStackBb: number | null; streetStartSpr: number | null; facingAllIn: boolean; canFullCall: boolean };
  mathematicalContext: MathematicalContext;
};
export type ContextInput = AIAnalysisContext;

export function formatCard(key: string): string {
  const suit = key.slice(-1);
  const rank = Number(key.slice(0, -1));
  const rankLabel = ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' } as Record<number, string>)[rank] ?? String(rank);
  return `${rankLabel}${suit}`;
}

export function serializeActions(actions: ActionDraft[], heroPosition: Position, villainPosition: Position, resolutions?: { additionalContributionBb: number; streetTotalBb: number; allInKind: 'bet-all-in' | 'raise-all-in' | 'call-all-in' | null }[]): SerializedAction[] {
  return actions.map((action, index) => ({ ...action, position: action.actor === 'hero' ? heroPosition : villainPosition, ...(resolutions?.[index] ? { resolution: { additionalContributionBb: resolutions[index].additionalContributionBb, streetTotalBb: resolutions[index].streetTotalBb, allInKind: resolutions[index].allInKind } } : {}) }));
}

export function validateOpponentStats(stats: OpponentStats): string | null {
  for (const [key, value] of Object.entries(stats)) {
    if (value === null) continue;
    if (!Number.isFinite(value) || value < 0 || (key !== 'aggressionFactor' && value > 100)) return `${key} must be a valid non-negative value${key === 'aggressionFactor' ? '' : ' no greater than 100'}.`;
  }
  if (stats.vpip !== null && stats.pfr !== null && stats.pfr > stats.vpip) return 'PFR cannot be higher than VPIP.';
  return null;
}

function cloneRange(range: AnalysisRange): AnalysisRange {
  return range.mode === 'auto' ? { mode: 'auto' } : { ...range, selectedHands: [...range.selectedHands] };
}

/**
 * Builds an immutable hand-off object. AI consumers should preserve Custom ranges as user assumptions.
 * Auto ranges have no invented combinations or frequencies; if inferred later, describe them as estimates.
 * Villain profile may inform only Villain's qualitative interpretation, never Hero's Auto range.
 */
export function buildAIAnalysisContext(input: ContextInput): AIAnalysisContext {
  const statsError = validateOpponentStats(input.villain.stats);
  if (statsError) throw new RangeError(statsError);
  return {
    ...input,
    hero: { ...input.hero, cards: [...input.hero.cards], range: cloneRange(input.hero.range) },
    villain: { ...input.villain, cards: [...input.villain.cards], stats: { ...input.villain.stats }, range: cloneRange(input.villain.range) },
    board: [...input.board],
    actionHistory: input.actionHistory.map((action) => ({ ...action })),
  };
}
