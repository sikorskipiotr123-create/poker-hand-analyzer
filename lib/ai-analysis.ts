import { AI_RECOMMENDATION_LIMITS } from './ai-recommendation-limits';
import { ACTION_TYPES, OPPONENT_PROFILES, POSITIONS, STREETS, validateOpponentStats, type AIAnalysisContext, type AnalysisRange, type Position, type Street } from './ai-context';
import { validateEquityInput, type Card } from './poker';
import { getAvailableRangeCombinations, RANGE_HANDS } from './range';
import { formatNumber, translate } from './i18n';

export const MAX_ANALYSIS_BODY_BYTES = 32 * 1024;
const MAX_ACTIONS = 60;
const MAX_BB = 1_000_000;
const rangeLabels = new Set(RANGE_HANDS.map(({ label }) => label));

export type AIAnalysisResult = {
  situationSummary: string;
  mathematicalContext: { summary: string };
  streetAnalysis: Record<Street, { assessment: string; explanation: string } | null>;
  rangeAnalysis: { hero: string; villain: string; interaction: string };
  opponentAnalysis: string;
  recommendedLine: { action: string; explanation: string };
  keyTakeaways: string[];
  confidence: 'low' | 'medium' | 'high';
  missingInformation: string[];
};
export type PromptParts = { system: string; user: string };
export class AnalysisInputError extends Error {
  constructor(message: string) { super(message); this.name = 'AnalysisInputError'; }
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function finite(value: unknown, min = -Infinity, max = Infinity): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }

/** Keep structured keys in English; only natural-language string values follow the UI language. */
function responseLanguageInstructions(language: AIAnalysisContext['language']): string {
  if (language === 'pl') return `RESPONSE LANGUAGE — STRICT REQUIREMENT: Write ALL natural-language content in Polish. Every natural-language string in the structured response must be Polish, including situationSummary, mathematicalContext.summary, every streetAnalysis assessment and explanation, rangeAnalysis.hero, rangeAnalysis.villain, rangeAnalysis.interaction, opponentAnalysis, recommendedLine.action, recommendedLine.explanation, every keyTakeaways item, and every missingInformation item. Use natural Polish poker terminology. Standard poker terms such as Hero, Villain, range, call, fold, raise, bet, check, equity, EV, blocker, bluff, value bet, and bluff-catcher may remain in English where natural. Do not write explanatory sentences in English. Keep every JSON property name exactly as specified by the schema; translate values only. This requirement applies even though the instructions and input facts contain English text.`;
  return `RESPONSE LANGUAGE — STRICT REQUIREMENT: Write ALL natural-language content in English. Every natural-language string in the structured response must be English, including situationSummary, mathematicalContext.summary, every streetAnalysis assessment and explanation, rangeAnalysis.hero, rangeAnalysis.villain, rangeAnalysis.interaction, opponentAnalysis, recommendedLine.action, recommendedLine.explanation, every keyTakeaways item, and every missingInformation item. Keep every JSON property name exactly as specified by the schema; only values are natural-language content. Do not write explanatory sentences in another language.`;
}
function parseCards(value: unknown, allowedLengths: number[], label: string): string[] {
  if (!Array.isArray(value) || !allowedLengths.includes(value.length) || value.some((card) => typeof card !== 'string' || !/^(?:[2-9TJQKA])[shdc]$/.test(card))) throw new AnalysisInputError(`${label} cards are malformed.`);
  return value as string[];
}
export function toCard(key: string): Card {
  const rank = ({ A: 14, K: 13, Q: 12, J: 11, T: 10 } as Record<string, number>)[key[0]] ?? Number(key[0]);
  return { rank, suit: key[1] as Card['suit'] };
}
function assertRange(value: unknown, owner: 'hero' | 'villain', blockers: string[], totalKnownCards: string[]): asserts value is AnalysisRange {
  if (!isObject(value) || !('mode' in value)) throw new AnalysisInputError(`${owner} range is malformed.`);
  if (value.mode === 'auto') {
    if (!exactKeys(value, ['mode'])) throw new AnalysisInputError(`${owner} Auto range contains unsupported fields.`);
    return;
  }
  if (value.mode !== 'custom' || !exactKeys(value, ['mode', 'selectedHands', 'comboCount', 'percentage'])) throw new AnalysisInputError(`${owner} range is malformed.`);
  if (!Array.isArray(value.selectedHands) || value.selectedHands.length < 1 || value.selectedHands.length > RANGE_HANDS.length || value.selectedHands.some((hand) => typeof hand !== 'string' || !rangeLabels.has(hand)) || new Set(value.selectedHands).size !== value.selectedHands.length) throw new AnalysisInputError(`${owner} custom range must contain unique valid starting-hand classes.`);
  if (!finite(value.comboCount, 1, 1326) || !Number.isInteger(value.comboCount) || !finite(value.percentage, 0, 100)) throw new AnalysisInputError(`${owner} custom range summary is invalid.`);
  const keys = value.selectedHands.map((label) => RANGE_HANDS.find((hand) => hand.label === label)?.key).filter((key): key is string => Boolean(key));
  const legal = getAvailableRangeCombinations(keys, totalKnownCards.map(toCard));
  if (!legal.length) throw new AnalysisInputError(`${owner} custom range is fully blocked.`);
  if (legal.length !== value.comboCount) throw new AnalysisInputError(`${owner} custom range combination count does not match its cards and blockers.`);
  const available = getAvailableRangeCombinations(RANGE_HANDS.map(({ key }) => key), blockers.map(toCard)).length;
  const percentage = available ? legal.length / available * 100 : 0;
  if (Math.abs(percentage - value.percentage) > 0.11) throw new AnalysisInputError(`${owner} custom range percentage does not match its blockers.`);
}

/** Strictly checks the client context before it can reach the model provider. */
export function validateAIAnalysisContext(input: unknown): AIAnalysisContext {
  if (!isObject(input) || !exactKeys(input, ['language', 'blinds', 'hero', 'villain', 'board', 'actionHistory', 'pot', 'stackState', 'mathematicalContext'])) throw new AnalysisInputError('Analysis request has an invalid shape.');
  if (input.language !== 'pl' && input.language !== 'en') throw new AnalysisInputError('Analysis language must be pl or en.');
  if (!isObject(input.blinds) || !exactKeys(input.blinds, ['smallBlindBb', 'bigBlindBb']) || !finite(input.blinds.smallBlindBb, 0, MAX_BB) || !finite(input.blinds.bigBlindBb, 0, MAX_BB) || input.blinds.smallBlindBb > input.blinds.bigBlindBb) throw new AnalysisInputError('Explicit valid blind amounts are required to replay action history.');
  if (!isObject(input.hero) || !exactKeys(input.hero, ['cards', 'position', 'range'])) throw new AnalysisInputError('Hero information is malformed.');
  if (!isObject(input.villain) || !exactKeys(input.villain, ['cards', 'position', 'profile', 'stats', 'range'])) throw new AnalysisInputError('Villain information is malformed.');
  const heroCards = parseCards(input.hero.cards, [2], 'Hero');
  const villainCards = parseCards(input.villain.cards, [0, 2], 'Villain');
  const board = parseCards(input.board, [0, 3, 4, 5], 'Board');
  const allCards = [...heroCards, ...villainCards, ...board];
  if (new Set(allCards).size !== allCards.length) throw new AnalysisInputError('A card cannot appear more than once.');
  try { validateEquityInput(heroCards.map(toCard), board.map(toCard), villainCards.map(toCard)); }
  catch { throw new AnalysisInputError('Cards or board are not a possible Hold’em deal.'); }
  if (!POSITIONS.includes(input.hero.position as Position) || !POSITIONS.includes(input.villain.position as Position)) throw new AnalysisInputError('A player position is invalid.');
  if (!OPPONENT_PROFILES.includes(input.villain.profile as (typeof OPPONENT_PROFILES)[number])) throw new AnalysisInputError('Opponent profile is invalid.');
  if (!isObject(input.villain.stats) || !exactKeys(input.villain.stats, ['vpip', 'pfr', 'threeBet', 'aggressionFactor'])) throw new AnalysisInputError('Opponent statistics are malformed.');
  const stats = input.villain.stats;
  if (Object.values(stats).some((entry) => entry !== null && !finite(entry, 0))) throw new AnalysisInputError('Opponent statistics must be non-negative finite numbers or unavailable.');
  const statsError = validateOpponentStats(stats as AIAnalysisContext['villain']['stats']);
  if (statsError) throw new AnalysisInputError(statsError);
  assertRange(input.hero.range, 'hero', [...board, ...villainCards], [...board, ...villainCards]);
  assertRange(input.villain.range, 'villain', [...heroCards, ...board], [...heroCards, ...board]);
  if (!Array.isArray(input.actionHistory) || input.actionHistory.length > MAX_ACTIONS) throw new AnalysisInputError('Action history is malformed or too long.');
  for (const action of input.actionHistory) {
    if (!isObject(action) || !(exactKeys(action, ['street', 'actor', 'action', 'amountBb', 'position']) || exactKeys(action, ['street', 'actor', 'action', 'amountBb', 'position', 'resolution'])) || !STREETS.includes(action.street as Street) || !['hero', 'villain'].includes(String(action.actor)) || !ACTION_TYPES.includes(action.action as (typeof ACTION_TYPES)[number]) || !POSITIONS.includes(action.position as Position) || (action.amountBb !== null && !finite(action.amountBb, 0, MAX_BB))) throw new AnalysisInputError('Action history contains an invalid street, player, action, position, or amount.');
    const expectedPosition = action.actor === 'hero' ? input.hero.position : input.villain.position;
    if (action.position !== expectedPosition) throw new AnalysisInputError('Action position does not match the selected player position.');
    if ('resolution' in action) { const resolution = action.resolution; if (!isObject(resolution) || !exactKeys(resolution, ['additionalContributionBb', 'streetTotalBb', 'allInKind']) || !finite(resolution.additionalContributionBb, 0, MAX_BB) || !finite(resolution.streetTotalBb, 0, MAX_BB) || ![null, 'bet-all-in', 'raise-all-in', 'call-all-in'].includes(resolution.allInKind as string | null)) throw new AnalysisInputError('Action resolution is invalid.'); }
  }
  if (!isObject(input.pot) || !exactKeys(input.pot, ['currentPotBb', 'villainBetBb', 'callAmountBb', 'finalPotBb']) || Object.values(input.pot).some((value) => !finite(value, 0, MAX_BB))) throw new AnalysisInputError('Decision point amounts must be finite non-negative big blind values.');
  const pot = input.pot;
  if (Math.abs((pot.currentPotBb as number) + (pot.villainBetBb as number) + (pot.callAmountBb as number) - (pot.finalPotBb as number)) > 0.02) throw new AnalysisInputError('Final pot does not match pot, bet, and call amounts.');
  if (!isObject(input.stackState) || !exactKeys(input.stackState, ['hero', 'villain', 'startingEffectiveStackBb', 'currentEffectiveStackBb', 'spr', 'streetStartPotBb', 'streetStartEffectiveStackBb', 'streetStartSpr', 'facingAllIn', 'canFullCall'])) throw new AnalysisInputError('Stack state is malformed.');
  const stackState = input.stackState;
  for (const player of ['hero', 'villain'] as const) {
    const stack = stackState[player];
    if (!isObject(stack) || !exactKeys(stack, ['startingStackBb', 'remainingStackBb', 'isAllIn']) || !finite(stack.startingStackBb, 0.000001, MAX_BB) || !finite(stack.remainingStackBb, 0, Number(stack.startingStackBb)) || typeof stack.isAllIn !== 'boolean' || stack.isAllIn !== (stack.remainingStackBb <= 0.00000001)) throw new AnalysisInputError(`${player} stack state is invalid.`);
  }
  if (!finite(stackState.startingEffectiveStackBb, 0, MAX_BB) || !finite(stackState.currentEffectiveStackBb, 0, MAX_BB) || (stackState.spr !== null && !finite(stackState.spr, 0, MAX_BB)) || !finite(stackState.streetStartPotBb, 0, MAX_BB) || (stackState.streetStartEffectiveStackBb !== null && !finite(stackState.streetStartEffectiveStackBb, 0, MAX_BB)) || (stackState.streetStartSpr !== null && !finite(stackState.streetStartSpr, 0, MAX_BB)) || typeof stackState.facingAllIn !== 'boolean' || typeof stackState.canFullCall !== 'boolean') throw new AnalysisInputError('Effective stack or SPR is invalid.');
  if (Math.abs((stackState.startingEffectiveStackBb as number) - Math.min((stackState.hero as Record<string, unknown>).startingStackBb as number, (stackState.villain as Record<string, unknown>).startingStackBb as number)) > 0.02 || Math.abs((stackState.currentEffectiveStackBb as number) - Math.min((stackState.hero as Record<string, unknown>).remainingStackBb as number, (stackState.villain as Record<string, unknown>).remainingStackBb as number)) > 0.02) throw new AnalysisInputError('Effective stack does not match the supplied player stacks.');
  if ((pot.callAmountBb as number) > ((stackState.hero as Record<string, unknown>).remainingStackBb as number) + 0.02 || (stackState.facingAllIn && !(stackState.villain as Record<string, unknown>).isAllIn)) throw new AnalysisInputError('Call or all-in facts conflict with the supplied stacks.');
  const sprPot = (pot.currentPotBb as number) + (pot.villainBetBb as number);
  const expectedSpr = sprPot > 0 ? (stackState.currentEffectiveStackBb as number) / sprPot : null;
  if ((expectedSpr === null) !== (stackState.spr === null) || (expectedSpr !== null && Math.abs(expectedSpr - (stackState.spr as number)) > 0.02)) throw new AnalysisInputError('SPR does not match the effective stack and contestable pot.');
  const startPot = stackState.streetStartPotBb as number;
  const startEffective = stackState.streetStartEffectiveStackBb as number | null;
  const expectedStreetSpr = startEffective !== null && startPot > 0 ? startEffective / startPot : null;
  if ((expectedStreetSpr === null) !== (stackState.streetStartSpr === null) || (expectedStreetSpr !== null && Math.abs(expectedStreetSpr - (stackState.streetStartSpr as number)) > 0.02)) throw new AnalysisInputError('Street-start SPR does not match the supplied stack and pot.');
  if (!isObject(input.mathematicalContext) || !exactKeys(input.mathematicalContext, ['equity', 'requiredEquity', 'callEV'])) throw new AnalysisInputError('Mathematical context is malformed.');
  const math = input.mathematicalContext;
  if (!isObject(math.equity) || !isObject(math.callEV) || !finite(math.requiredEquity, 0, 1)) throw new AnalysisInputError('Mathematical context contains invalid values.');
  const equity = math.equity;
  if (equity.status === 'unknown') {
    if (!exactKeys(equity, ['status', 'reason']) || !['auto-range', 'missing-cards', 'invalid-input'].includes(String(equity.reason))) throw new AnalysisInputError('Unknown equity must include a valid reason and no numeric result.');
    if (equity.reason === 'auto-range' && (villainCards.length > 0 || (input.villain.range as AnalysisRange).mode !== 'auto')) throw new AnalysisInputError('Auto-range equity may be unknown only when no Villain hand or explicit range is supplied.');
  } else if (equity.status === 'known') {
    if (!exactKeys(equity, ['status', 'value', 'source', 'villainEquity', 'tiePercent', 'method', 'evaluatedCases']) || !finite(equity.value, 0, 1) || !finite(equity.villainEquity, 0, 1) || !finite(equity.tiePercent, 0, 1) || !['exact', 'monte-carlo'].includes(String(equity.method)) || !finite(equity.evaluatedCases, 1, 10_000_000) || !Number.isInteger(equity.evaluatedCases)) throw new AnalysisInputError('Known equity is missing valid calculation outcomes or provenance.');
    if (equity.source === 'known-hand') { if (villainCards.length !== 2) throw new AnalysisInputError('Known-hand equity requires both Villain cards.'); }
    else if (equity.source === 'custom-range') { if ((input.villain.range as AnalysisRange).mode !== 'custom' || villainCards.length !== 0) throw new AnalysisInputError('Range equity requires an explicit Custom Villain range and no exact Villain hand.'); }
    else throw new AnalysisInputError('Equity source must be a known hand or explicit Custom range.');
    if (Math.abs((equity.value as number) + (equity.villainEquity as number) - 1) > 0.000001) throw new AnalysisInputError('Hero and Villain equity must be complementary.');
  } else throw new AnalysisInputError('Equity status must be known or unknown.');
  const expectedRequiredEquity = (pot.finalPotBb as number) > 0 ? (pot.callAmountBb as number) / (pot.finalPotBb as number) : 0;
  if (Math.abs((math.requiredEquity as number) - expectedRequiredEquity) > 0.000001) throw new AnalysisInputError('Required equity does not match the supplied pot odds.');
  const callEV = math.callEV;
  if (callEV.status === 'unknown') {
    if (!exactKeys(callEV, ['status', 'reason']) || !['equity-unknown', 'no-active-call'].includes(String(callEV.reason))) throw new AnalysisInputError('Unknown Call EV must include a valid reason and no numeric result.');
    if (equity.status === 'unknown' && callEV.reason !== 'equity-unknown') throw new AnalysisInputError('Call EV is unknown because equity is unknown.');
  } else if (callEV.status === 'known') {
    if (!exactKeys(callEV, ['status', 'value']) || !finite(callEV.value, -MAX_BB, MAX_BB) || equity.status !== 'known' || (pot.callAmountBb as number) <= 0) throw new AnalysisInputError('Known Call EV requires known equity and an active call.');
    if (Math.abs((callEV.value as number) - ((equity.value as number) * (pot.finalPotBb as number) - (pot.callAmountBb as number))) > 0.02) throw new AnalysisInputError('Call EV does not match the supplied equity and pot.');
  } else throw new AnalysisInputError('Call EV status must be known or unknown.');
  return input as unknown as AIAnalysisContext;
}

export function buildPokerPrompt(context: AIAnalysisContext): PromptParts {
  const actualVillain = context.villain.cards.length ? context.villain.cards.join(' ') : 'unknown';
  const board = context.board.length ? context.board.join(' ') : '(preflop; no board cards)';
  const actions = context.actionHistory.length ? context.actionHistory.map((item) => {
    const amount = item.amountBb === null ? '' : item.action === 'raise' ? ` to ${item.amountBb} bb` : item.action === 'call' ? ` ${item.amountBb} bb additional` : item.action === 'bet' || item.action === 'all_in' ? ` to ${item.amountBb} bb total on street` : '';
    const resolution = item.resolution ? ` · actual additional contribution ${item.resolution.additionalContributionBb} bb · street total ${item.resolution.streetTotalBb} bb${item.resolution.allInKind ? ` · normalized ${item.resolution.allInKind}` : ''}` : '';
    return `${item.street.toUpperCase()} · ${item.position} (${item.actor}) ${item.action}${amount}${resolution}`;
  }).join('\n') : 'Not supplied.';
  const rangeLabel = (range: AnalysisRange, player: string) => range.mode === 'custom'
    ? `${player} CUSTOM USER ASSUMPTION: ${range.selectedHands.join(', ')} (${range.comboCount} currently legal combinations; ${range.percentage.toFixed(2)}% of unblocked combos). Preserve exactly as supplied; do not replace it.`
    : `${player} AUTO: no exact combos or frequencies supplied. Any range discussion is a qualitative estimate, not a known range.`;
  const villainStats = Object.entries(context.villain.stats).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${value}`).join(', ') || 'No HUD statistics supplied.';
  const mathematicalFacts = JSON.stringify({ ...context.mathematicalContext, pot: context.pot, stackState: context.stackState }, null, 2);
  const userFacts = JSON.stringify({ blinds: context.blinds, startingStacks: { hero: context.stackState.hero.startingStackBb, villain: context.stackState.villain.startingStackBb }, heroActualHand: context.hero.cards.join(' '), heroPosition: context.hero.position, villainKnownCards: actualVillain, villainPosition: context.villain.position, board, heroRange: rangeLabel(context.hero.range, 'HERO'), villainRange: rangeLabel(context.villain.range, 'VILLAIN') }, null, 2);
  const opponentInfo = `Profile: ${context.villain.profile}. Profile is a qualitative tendency, never a guarantee. ${context.villain.profile === 'custom' ? `User-supplied HUD observations: ${villainStats}` : villainStats}`;
  const decision = 'Use the authoritative pot and stack values in MATHEMATICAL FACTS above as the Decision Point. Do not recalculate or infer missing values.';
  return {
    system: `You are a Texas Hold'em hand-review assistant. Provide strategic interpretation only; you are not a solver. Cards, starting stacks, blinds, positions, ranges and the completeness of the action history are user assumptions, not independently observed real-world facts. Arithmetic is verified only within this two-player model with dead blinds, no rake, antes or side pots. Equity is server-enumerated exactly when within its computation budget; otherwise equity and dependent Call EV are unknown. Never reuse or infer client simulation numbers. Treat MATHEMATICAL FACTS as immutable input facts: Required equity from pot odds and final pot are authoritative. Do not recalculate, alter, approximate, or invent equity, pot odds, EV, frequencies, or solver outputs. When equity status is unknown because Villain Range is Auto, never invent exact equity, exact bluff frequency, an exact Villain range, or Call EV. State that equity versus Villain's betting range is unknown and Call EV requires a defined range. Use position, actions, sizing, board, profile, and blockers qualitatively. Clearly distinguish theoretical reasoning from exploitative assumptions. If a value is null, unavailable, or zero evaluated cases, say it is unavailable. Your response must use the supplied JSON schema. Analyze all supplied action-history streets, and include only applicable streets. Distinguish actual Hero cards from Hero's overall range. CUSTOM ranges are explicit user assumptions and must not be silently changed; AUTO ranges are qualitative estimates, with no invented exact combo or action frequencies. Profiles and HUD stats are context only; never invent stats, sample sizes, or bluff/fold frequencies. Unknown profile means avoid strong exploitative assumptions. Distinguish theoretical reasoning from exploitative adjustments, and never claim exact GTO frequencies. State uncertainty and missing information based on input completeness. Stack sizes, effective stacks, all-in state, and SPR supplied in the context are deterministic authoritative facts: never recalculate, alter, or invent them. Never claim one player covers the other unless the supplied starting and remaining stacks support that claim. Discuss SPR only as context, not as an automatic action rule. Consider it together with hand, ranges, board, actions, positions, sizing, and opponent context. For recommendedLine.action, provide the recommended action, sizing and essential conditions concisely, within ${AI_RECOMMENDATION_LIMITS.action} Unicode characters. Put detailed reasoning in recommendedLine.explanation, within ${AI_RECOMMENDATION_LIMITS.explanation} Unicode characters. Preserve useful conditions rather than abbreviating or cutting off a recommendation. Be concise, clear, and avoid irrelevant jargon. Aim for 600–900 words total, with 1–3 sentences per street assessment/explanation and 3–6 concise takeaways; cover every applicable street without filling fields to their maximum lengths.\n\n${responseLanguageInstructions(context.language)}`,
    user: `MATHEMATICAL FACTS (server-recomputed conditional on user assumptions; unknown values must remain unknown):\n${mathematicalFacts}\n\nUSER-SUPPLIED ASSUMPTIONS (including actual cards and chosen range assumptions):\n${userFacts}\n\nAUTO / ESTIMATED INFORMATION:\nHero: ${context.hero.range.mode === 'auto' ? 'Hero range must be described only as a qualitative estimate using Hero position and actions.' : 'Use the custom Hero range exactly as the user supplied it.'}\nVillain: ${context.villain.range.mode === 'auto' ? 'Infer a plausible qualitative range from position, action, and opponent context; no exact frequencies.' : 'Use the custom Villain range exactly as the user supplied it. Opponent profile must not overwrite this assumption.'}\n\nOPPONENT INFORMATION:\n${opponentInfo}\n\nACTION HISTORY (in order; review every supplied street):\n${actions}\n\nDECISION POINT:\n${decision}\n\nReview where Hero's actual hand sits within Hero's overall range when useful. Consider board/range/nut advantage, value/bluff regions, draws and blockers only when relevant. Recommend a practical line as strategic interpretation, while preserving mathematical facts above. Do not infer a solver frequency.`,
  };
}

export function deriveInputQuality(context: AIAnalysisContext): { confidence: AIAnalysisResult['confidence']; missingInformation: string[] } {
  const missing: string[] = [];
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate(context.language, key, values);
  if (context.villain.cards.length === 0 && context.villain.range.mode === 'auto') missing.push(t('missingVillainHand'));
  if (context.hero.range.mode === 'auto') missing.push(t('missingHeroRange'));
  if (context.villain.range.mode === 'auto') missing.push(t('missingVillainRange'));
  if (context.actionHistory.length === 0) missing.push(t('missingActions'));
  if (context.board.length < 5) missing.push(context.board.length === 0 ? t('missingPreflop') : t('missingBoard', { count: context.board.length }));
  if (context.villain.profile === 'custom' && Object.values(context.villain.stats).every((value) => value === null)) missing.push(t('missingCustomStats'));
  missing.push(t('missingStack'));
  const serverUnverified = context.mathematicalContext.equity.status === 'unknown' && context.mathematicalContext.equity.reason.startsWith('verification-');
  if (serverUnverified) missing.push(t('mathServerUnverified'));
  const reliableRanges = context.hero.range.mode === 'custom' && (context.villain.range.mode === 'custom' || context.villain.cards.length === 2);
  const confidence: AIAnalysisResult['confidence'] = serverUnverified ? 'low' : context.board.length === 5 && context.actionHistory.length > 0 && reliableRanges ? 'high' : context.actionHistory.length > 0 && context.board.length >= 3 ? 'medium' : 'low';
  return { confidence, missingInformation: missing };
}
export function createMathematicalSummary(context: AIAnalysisContext): string {
  const math = context.mathematicalContext;
  const lang = context.language;
  const t = (key: Parameters<typeof translate>[1]) => translate(lang, key);
  const equity = math.equity.status === 'unknown'
    ? `${t('unknown')} (${math.equity.reason === 'auto-range' ? t('autoRangeQualitative') : math.equity.reason === 'missing-cards' ? t('mathMissingCards') : math.equity.reason.startsWith('verification-') ? t('mathServerUnverified') : t('mathInvalidInput')})`
    : `${formatNumber(lang, math.equity.value * 100, 1)}% ${t(math.equity.source === 'known-hand' ? 'mathVsKnownHand' : 'mathVsCustomRange')}`;
  const ev = math.callEV.status === 'unknown' ? `${t('unknown')} (${math.callEV.reason === 'equity-unknown' ? t('mathEvNeedsEquity') : t('mathNoActiveCall')})` : `${math.callEV.value >= 0 ? '+' : ''}${formatNumber(lang, math.callEV.value, 2)} bb`;
  const method = math.equity.status === 'known' ? (math.equity.method === 'exact' ? `${t('exactEnumeration')} (${formatNumber(lang, math.equity.evaluatedCases, 0)} ${t('cases')})` : `${t('monteCarloEstimate')} (${formatNumber(lang, math.equity.evaluatedCases, 0)} ${t('simulations')})`) : t('equityUnavailable');
  const pot = context.pot;
  return lang === 'pl'
    ? `Equity Hero przeciw Villainowi: ${equity}. Wymagane equity (pot odds): ${formatNumber(lang, math.requiredEquity * 100, 1)}%. EV calla: ${ev}. Metoda obliczeń: ${method}. Pula przed betem: ${formatNumber(lang, pot.currentPotBb, 2)} bb; bet Villaina: ${formatNumber(lang, pot.villainBetBb, 2)} bb; call Hero: ${formatNumber(lang, pot.callAmountBb, 2)} bb; pula po callu: ${formatNumber(lang, pot.finalPotBb, 2)} bb.`
    : `Hero equity vs Villain: ${equity}. Required equity (pot odds): ${formatNumber(lang, math.requiredEquity * 100, 1)}%. Call EV: ${ev}. Calculation method: ${method}. Pot before bet: ${formatNumber(lang, pot.currentPotBb, 2)} bb; Villain bet: ${formatNumber(lang, pot.villainBetBb, 2)} bb; Hero call: ${formatNumber(lang, pot.callAmountBb, 2)} bb; final pot after call: ${formatNumber(lang, pot.finalPotBb, 2)} bb.`;
}
