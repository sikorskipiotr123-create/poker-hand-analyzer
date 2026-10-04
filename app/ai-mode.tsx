'use client';
import { useEffect, useState } from 'react';
import type { Card } from '../lib/poker';
import type { CallAnalysis } from '../lib/calculations';
import type { AIAnalysisResult } from '../lib/ai-analysis';
import type { MathematicalContext } from '../lib/ai-context';
import { getAIEquityTarget, buildAIMathematicalContext } from '../lib/ai-equity';
import { calculateMatchupEquity, type RangeEquityResult } from '../lib/range';
import { ACTION_TYPES, buildAIAnalysisContext, createAnalysisRange, DEFAULT_ANALYSIS_RANGE_MODE, formatCard, OPPONENT_PROFILES, POSITIONS, STREETS, validateOpponentStats, serializeActions, type ActionDraft, type ActionType, type OpponentProfile, type OpponentStats, type Position, type Street } from '../lib/ai-context';
import { getRangeHand, getRangeHandKey, getRangeSummary, includesActualHand, type RangeHandKey } from '../lib/range';
import { RangeMatrixPanel } from './range-matrix';
import { calculateActionState, getSprCategory } from '../lib/action-state';
import { getLegalActions, suggestNextAction } from '../lib/next-action';
import { calculateCallAnalysis } from '../lib/calculations';
import { useLanguage } from './providers';
import { languageMismatchKey, translateActionError, translateMissingInformation, translateStatsError } from '../lib/i18n';

const profileDescriptionKeys: Record<OpponentProfile, 'descriptionUnknown' | 'descriptionNit' | 'descriptionTag' | 'descriptionLag' | 'descriptionPassiveFish' | 'descriptionAggressiveFish' | 'descriptionManiac' | 'descriptionCustom'> = { unknown: 'descriptionUnknown', nit: 'descriptionNit', tag: 'descriptionTag', lag: 'descriptionLag', passive_fish: 'descriptionPassiveFish', aggressive_fish: 'descriptionAggressiveFish', maniac: 'descriptionManiac', custom: 'descriptionCustom' };
const profileLabelKeys: Record<OpponentProfile, 'profileUnknown' | 'profileNit' | 'profileTag' | 'profileLag' | 'profilePassiveFish' | 'profileAggressiveFish' | 'profileManiac' | 'profileCustom'> = { unknown: 'profileUnknown', nit: 'profileNit', tag: 'profileTag', lag: 'profileLag', passive_fish: 'profilePassiveFish', aggressive_fish: 'profileAggressiveFish', maniac: 'profileManiac', custom: 'profileCustom' };
const streetKeys: Record<Street, 'preflop' | 'flop' | 'turn' | 'river'> = { preflop: 'preflop', flop: 'flop', turn: 'turn', river: 'river' };
const actionKeys: Record<ActionType, 'actionFold' | 'actionCheck' | 'actionCall' | 'actionBet' | 'actionRaise' | 'actionAllIn' | 'allInAction'> = { fold: 'actionFold', check: 'actionCheck', call: 'actionCall', bet: 'actionBet', raise: 'actionRaise', all_in: 'allInAction' };
const statKeys: [keyof OpponentStats, string][] = [['vpip', 'VPIP %'], ['pfr', 'PFR %'], ['threeBet', '3Bet %'], ['aggressionFactor', 'AF']];

type Props = {
  cards: Record<string, string>;
  getCard: (id: string) => Card | null;
  setActive: (id: string) => void;
  hero: Card[]; villain: Card[]; board: Card[]; ready: boolean; duplicate: boolean; boardGap: boolean;
};

function CardPicker({ card, label, onClick }: { card: Card | null; label: string; onClick: () => void }) {
  const { t } = useLanguage();
  const rank = card ? ({14:'A',13:'K',12:'Q',11:'J',10:'T'} as Record<number,string>)[card.rank] ?? String(card.rank) : '';
  const suit = card ? ({s:'♠',h:'♥',d:'♦',c:'♣'} as Record<string,string>)[card.suit] : '';
  const displayLabel = label === '0' ? `${t('flop')} 1` : label === '1' ? `${t('flop')} 2` : label === '2' ? `${t('flop')} 3` : label === '3' ? t('turn') : label === '4' ? t('river') : label;
  return <button type="button" className={`ai-card-pick ${card && ['h','d'].includes(card.suit) ? 'red' : ''}`} onClick={onClick} aria-label={`${displayLabel}${card ? ` ${rank}${card.suit}` : `, ${t('selectCard')}`}`}><span>{card ? rank : '+'}</span><strong>{card ? suit : displayLabel}</strong></button>;
}
function CardGroup({ title, slots, getCard, setActive }: { title: string; slots: string[]; getCard: Props['getCard']; setActive: Props['setActive'] }) {
  return <div className="ai-card-group"><span className="ai-label">{title}</span><div className="ai-card-row">{slots.map((slot) => <CardPicker key={slot} card={getCard(slot)} label={slot.startsWith('h') ? 'Hero' : slot.startsWith('v') ? 'Villain' : slot.slice(1)} onClick={() => setActive(slot)} />)}</div></div>;
}
function readStat(raw: string): number | null { return raw.trim() === '' ? null : Number(raw); }

type RangeMode = 'auto' | 'custom';
function RangeModeSection({ title, mode, setMode, selectedRange, onRangeChange, blockers, autoCopy, actualHandWarning }: { title: string; mode: RangeMode; setMode: (mode: RangeMode) => void; selectedRange: RangeHandKey[]; onRangeChange: (range: RangeHandKey[]) => void; blockers: Card[]; autoCopy: string; actualHandWarning?: string | null }) {
  const { t, number } = useLanguage();
  const summary = getRangeSummary(selectedRange, blockers);
  return <div className="ai-range-card"><div className="ai-range-card-head"><div><span className="ai-label">{title.toUpperCase()}</span><strong>{mode === 'auto' ? t('auto') : t('custom')}</strong></div><div className="segmented ai-range-toggle"><button type="button" aria-pressed={mode === 'auto'} className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>{t('auto')}</button><button type="button" aria-pressed={mode === 'custom'} className={mode === 'custom' ? 'active' : ''} onClick={() => setMode('custom')}>{t('custom')}</button></div></div>
    {mode === 'auto' ? <p className="ai-range-note">{autoCopy}. {t('noExactFrequencies')}</p> : <><div className="ai-range-summary"><span><b>{number(summary.selectedCombos,0)}</b> {t('selectedCombos')}</span><span><b>{number(summary.percentage,1)}%</b> {t('ofRange')}</span><small>{t('classesAvailable',{classes:summary.selectedHandClasses,combos:number(summary.availableCombos,0)})}</small></div>{actualHandWarning && <p className="ai-range-warning">{actualHandWarning}</p>}<details className="ai-range-editor"><summary>{t('editRangeMatrix')}</summary><RangeMatrixPanel title={title} eyebrow={t('matrixEyebrow')} description={t('customRangeDescription')} selectedRange={selectedRange} onRangeChange={onRangeChange} blockers={blockers} showEquity={false}/></details></>}
  </div>;
}

function AIHandReview({ result, math, finalPot }: { result: AIAnalysisResult; math: MathematicalContext; finalPot: number }) {
  const { t, number, language } = useLanguage();
  const metric = (label: string, value: string) => <div className="ai-fact-metric" key={label}><span>{label}</span><strong>{value}</strong></div>;
  const streets: [Street, string][] = [['preflop', t('preflop')], ['flop', t('flop')], ['turn', t('turn')], ['river', t('river')]];
  const confidenceLabel = t(({ low: 'confidenceLow', medium: 'confidenceMedium', high: 'confidenceHigh' } as const)[result.confidence]);
  const equityLabel = math.equity.status === 'known' ? math.equity.source === 'known-hand' ? t('equityKnownHand') : t('equityCustomRange') : t('equityVsVillainRange');
  const equityValue = math.equity.status === 'known' ? `${number(math.equity.value * 100,1)}%` : t('unknownRangeNotDefined');
  const method = math.equity.status === 'known' ? `${t(math.equity.method === 'exact' ? 'exactEnumeration' : 'monteCarloEstimate')} · ${number(math.equity.evaluatedCases,0)} ${t(math.equity.method === 'exact' ? 'cases' : 'simulations')}` : math.equity.reason === 'auto-range' ? t('autoRangeQualitative') : t('equityUnavailable');
  const callEvValue = math.callEV.status === 'known' ? `${math.callEV.value >= 0 ? '+' : ''}${number(math.callEV.value,1)} bb` : t('unknown');
  return <section className="surface ai-review" aria-labelledby="ai-review-title">
    <div className="ai-review-header"><div><span className="eyebrow">{t('reviewEyebrow')}</span><h2 id="ai-review-title">{t('reviewTitle')}</h2></div><span className={`ai-confidence confidence-${result.confidence}`}>{t('dataConfidence',{confidence:confidenceLabel})}</span></div>
    <section className="ai-review-summary"><h3>{t('situationSummary')}</h3><p>{result.situationSummary}</p></section>
    <section className="ai-math-facts"><div><span className="ai-fact-kicker">{t('deterministicEngine')}</span><h3>{t('mathematicalFacts')}</h3><p>{t('mathFactExplanation')}</p></div><div className="ai-fact-grid">{metric(equityLabel,equityValue)}{metric(t('requiredEquityLabel'),`${number(math.requiredEquity*100,1)}%`)}{metric(t('callEvLabel'),callEvValue)}{metric(t('finalPot'),`${number(finalPot,1)} bb`)}</div><p className="ai-math-method">{method}{math.callEV.status === 'unknown' && math.callEV.reason === 'equity-unknown' ? ` · ${t('callEvNeedsRange')}` : ''} {result.mathematicalContext.summary}</p></section>
    <section className="ai-review-section"><h3>{t('streetByStreet')}</h3><div className="ai-street-list">{streets.filter(([street]) => result.streetAnalysis[street]).map(([street,label]) => <article className="ai-street-card" key={street}><span>{label}</span><h4>{result.streetAnalysis[street]?.assessment}</h4><p>{result.streetAnalysis[street]?.explanation}</p></article>)}</div>{streets.every(([street]) => !result.streetAnalysis[street]) && <p className="ai-review-muted">{t('noStreetActions')}</p>}</section>
    <section className="ai-review-section"><h3>{t('rangeAnalysis')}</h3><div className="ai-range-review-grid"><article><h4>{t('heroRangeResult')}</h4><p>{result.rangeAnalysis.hero}</p></article><article><h4>{t('villainRangeResult')}</h4><p>{result.rangeAnalysis.villain}</p></article><article className="ai-range-interaction"><h4>{t('rangeInteraction')}</h4><p>{result.rangeAnalysis.interaction}</p></article></div></section>
    <section className="ai-review-section ai-opponent-review"><h3>{t('opponentAnalysis')}</h3><p>{result.opponentAnalysis}</p></section>
    <section className="ai-recommendation"><span>{t('aiStrategicNotSolver')}</span><h3>{t('recommendedLine')}</h3><strong>{result.recommendedLine.action}</strong><p>{result.recommendedLine.explanation}</p></section>
    <section className="ai-review-section"><h3>{t('keyTakeaways')}</h3><ul className="ai-takeaways">{result.keyTakeaways.map((takeaway,index)=><li key={`${index}-${takeaway}`}>{takeaway}</li>)}</ul></section>
    <details className="ai-uncertainty"><summary>{t('confidenceAndMissing')}</summary><p>{t('confidenceMeaning')}</p><ul>{result.missingInformation.map(item=><li key={item}>{translateMissingInformation(item,language,t)}</li>)}</ul></details>
  </section>;
}

export function AIModePanel(props: Props) {
  const { language, t, number } = useLanguage();
  const [heroPosition, setHeroPosition] = useState<Position>('CO');
  const [villainPosition, setVillainPosition] = useState<Position>('BB');
  const [profile, setProfile] = useState<OpponentProfile>('unknown');
  const [statInput, setStatInput] = useState<Record<keyof OpponentStats, string>>({ vpip: '', pfr: '', threeBet: '', aggressionFactor: '' });
  const [actions, setActions] = useState<ActionDraft[]>([]);
  const [aiEquity, setAiEquity] = useState<RangeEquityResult | null>(null);
  const [aiEquityLoading, setAiEquityLoading] = useState(false);
  const [aiEquityError, setAiEquityError] = useState<string | null>(null);
  const [smallBlind, setSmallBlind] = useState('0.5');
  const [bigBlind, setBigBlind] = useState('1');
  const [heroStartingStack, setHeroStartingStack] = useState('100');
  const [villainStartingStack, setVillainStartingStack] = useState('100');
  const [aiResult, setAiResult] = useState<AIAnalysisResult | null>(null);
  const [resultFingerprint, setResultFingerprint] = useState<string | null>(null);
  const [resultLanguage, setResultLanguage] = useState<'pl'|'en'|null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [heroRangeMode, setHeroRangeMode] = useState<RangeMode>(DEFAULT_ANALYSIS_RANGE_MODE);
  const [villainRangeMode, setVillainRangeMode] = useState<RangeMode>(DEFAULT_ANALYSIS_RANGE_MODE);
  const [heroSelectedRange, setHeroSelectedRange] = useState<RangeHandKey[]>([]);
  const [villainSelectedRange, setVillainSelectedRange] = useState<RangeHandKey[]>([]);
  const stats: OpponentStats = { vpip: readStat(statInput.vpip), pfr: readStat(statInput.pfr), threeBet: readStat(statInput.threeBet), aggressionFactor: readStat(statInput.aggressionFactor) };
  const rawStatsError = profile === 'custom' ? validateOpponentStats(stats) : null;
  const statsError = rawStatsError ? translateStatsError(rawStatsError,t) : null;
  const nextSuggestion = suggestNextAction(actions, { hero: heroPosition, villain: villainPosition }, { smallBlindBb: Number(smallBlind), bigBlindBb: Number(bigBlind) }, { hero: Number(heroStartingStack), villain: Number(villainStartingStack) });
  const actionState = calculateActionState(actions, { hero: heroPosition, villain: villainPosition }, { smallBlindBb: Number(smallBlind), bigBlindBb: Number(bigBlind) }, { hero: Number(heroStartingStack), villain: Number(villainStartingStack) }, nextSuggestion.street);
  const decision = actionState.decisionPoint;
  const decisionPot = decision?.potBeforeOpponentActionBb ?? actionState.potBb;
  const decisionBet = decision?.opponentBetBb ?? 0;
  const decisionCall = decision?.callAmountBb ?? 0;
  const decisionAnalysis = calculateCallAnalysis(decisionPot, decision?.contestableOpponentBetBb ?? decisionBet, decisionCall, aiEquity?.equity ?? null);
  const addAction = () => setActions((current) => { const suggestion = suggestNextAction(current, { hero: heroPosition, villain: villainPosition }, { smallBlindBb: Number(smallBlind), bigBlindBb: Number(bigBlind) }, { hero: Number(heroStartingStack), villain: Number(villainStartingStack) }); if (!suggestion.player || !suggestion.defaultAction) return current; return [...current, { street: suggestion.street, actor: suggestion.player, action: suggestion.defaultAction, amountBb: null }]; });
  const updateAction = (index: number, update: Partial<ActionDraft>) => setActions((current) => current.map((action, i) => i === index ? { ...action, ...update } : action));
  const isChipAction = (action: ActionType) => ['call', 'bet', 'raise', 'all_in'].includes(action);
  const { finalPot, requiredEquity, callEv } = decisionAnalysis;
  const sprCategoryKey = (value: number) => ({ 'very-low': 'sprVeryLow', low: 'sprLow', medium: 'sprMedium', high: 'sprHigh' } as const)[getSprCategory(value)];
  // Hero's actual two cards are the specific hand instance, not external blockers to the strategic Hero range.
  const heroRangeBlockers = [...props.board, ...props.villain];
  // Hero's actual cards block Villain combos; board and any known Villain cards block Hero combos.
  const villainRangeBlockers = [...props.hero, ...props.board];
  const heroHandClass = getRangeHandKey(props.hero);
  const heroActualRangeLabel = heroHandClass ? getRangeHand(heroHandClass)?.label : null;
  const heroRangeWarning = includesActualHand(props.hero, heroSelectedRange) === false && heroActualRangeLabel ? t('actualHandNotIncluded',{hand:heroActualRangeLabel}) : null;
  const heroRangeSummary = getRangeSummary(heroSelectedRange, heroRangeBlockers);
  const villainRangeSummary = getRangeSummary(villainSelectedRange, villainRangeBlockers);
  const equityTarget = getAIEquityTarget(props.hero, props.villain, villainRangeMode, villainSelectedRange);
  const aiEquitySource = equityTarget?.source ?? null;
  const equityUnavailableReason = props.villain.length === 0 && villainRangeMode === 'auto' ? 'auto-range' as const : props.hero.length !== 2 ? 'missing-cards' as const : 'invalid-input' as const;
  const mathContext = buildAIMathematicalContext(aiEquity, aiEquitySource, aiEquityError ? 'invalid-input' : equityUnavailableReason, decisionAnalysis);
  useEffect(() => {
    const target = getAIEquityTarget(props.hero, props.villain, villainRangeMode, villainSelectedRange);
    if (!target || props.duplicate || props.boardGap) { setAiEquity(null); setAiEquityLoading(false); setAiEquityError(null); return; }
    let cancelled = false;
    setAiEquity(null); setAiEquityLoading(true); setAiEquityError(null);
    calculateMatchupEquity({ mode: 'hand', cards: props.hero }, props.board, target.villain, { samples: 8000, shouldCancel: () => cancelled })
      .then((result) => { if (!cancelled) setAiEquity(result); })
      .catch((error) => { if (!cancelled) { setAiEquity(null); setAiEquityError('equityCalculationError'); } })
      .finally(() => { if (!cancelled) setAiEquityLoading(false); });
    return () => { cancelled = true; };
  }, [props.hero, props.villain, props.board, props.duplicate, props.boardGap, villainRangeMode, villainSelectedRange]);
  const emptyCustomRange = (heroRangeMode === 'custom' && heroRangeSummary.selectedCombos === 0) || (villainRangeMode === 'custom' && villainRangeSummary.selectedCombos === 0);
  const valid = props.ready && !props.duplicate && !props.boardGap && props.villain.length !== 1 && !statsError && !emptyCustomRange && actionState.errors.length === 0 && !aiEquityLoading && !(equityTarget && aiEquityError);
  const heroRange = createAnalysisRange(heroRangeMode, heroSelectedRange, heroRangeSummary.selectedCombos, heroRangeSummary.percentage);
  const villainRange = createAnalysisRange(villainRangeMode, villainSelectedRange, villainRangeSummary.selectedCombos, villainRangeSummary.percentage);
  const analysisFingerprint = JSON.stringify({ actionState: { normalizedActions: actionState.normalizedActions, errors: actionState.errors, decision }, blinds: [smallBlind, bigBlind], startingStacks: [heroStartingStack, villainStartingStack], hero: props.hero.map((card) => formatCard(`${card.rank}${card.suit}`)), villain: props.villain.map((card) => formatCard(`${card.rank}${card.suit}`)), board: props.board.map((card) => formatCard(`${card.rank}${card.suit}`)), heroPosition, villainPosition, profile, stats, actionHistory: actionState.normalizedActions, heroRange, villainRange, mathContext, callEv, requiredEquity });
  const hasCurrentResult = aiResult !== null && resultFingerprint === analysisFingerprint;

  const analyze = async () => {
    const requestFingerprint = analysisFingerprint;
    setIsAnalyzing(true);
    setAiError(null);
    setAiResult(null);
    try {
      const context = buildAIAnalysisContext({
        language,
        hero: { cards: props.hero.map((card) => formatCard(`${card.rank}${card.suit}`)), position: heroPosition, range: heroRange },
        villain: { cards: props.villain.map((card) => formatCard(`${card.rank}${card.suit}`)), position: villainPosition, profile, stats: profile === 'custom' ? stats : { vpip: null, pfr: null, threeBet: null, aggressionFactor: null }, range: villainRange },
        stackState: { hero: { startingStackBb: actionState.players.hero.startingStackBb, remainingStackBb: actionState.players.hero.remainingStackBb, isAllIn: actionState.players.hero.isAllIn }, villain: { startingStackBb: actionState.players.villain.startingStackBb, remainingStackBb: actionState.players.villain.remainingStackBb, isAllIn: actionState.players.villain.isAllIn }, startingEffectiveStackBb: actionState.startingEffectiveStackBb, currentEffectiveStackBb: actionState.currentEffectiveStackBb, spr: decision?.spr ?? actionState.spr, streetStartPotBb: actionState.streetStartPotBb, streetStartEffectiveStackBb: actionState.streetStartEffectiveStackBb, streetStartSpr: actionState.streetStartSpr, facingAllIn: decision?.facingAllIn ?? false, canFullCall: decision?.canFullCall ?? false },
        board: props.board.map((card) => formatCard(`${card.rank}${card.suit}`)),
        actionHistory: serializeActions(actionState.normalizedActions, heroPosition, villainPosition, actionState.actionResolutions),
        pot: { currentPotBb: decisionPot, villainBetBb: decision?.contestableOpponentBetBb ?? decisionBet, callAmountBb: decisionCall, finalPotBb: finalPot },
        mathematicalContext: {
          ...mathContext,
        },
      });
      const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context), signal: AbortSignal.timeout(70_000) });
      const payload = await response.json().catch(() => null) as { result?: AIAnalysisResult; error?: string } | null;
      if (!payload) {
        setAiError(t('errorMalformed'));
        return;
      }
      if (!response.ok || !payload.result) {
        const messages: Record<string, string> = {
          not_configured: t('errorNotConfigured'), configuration_error: t('errorConfiguration'), billing_quota: t('errorBillingQuota'),
          invalid_input: t('errorInvalidInput'), invalid_hand_data: t('errorInvalidHand'), invalid_action_history: t('errorInvalidActions'),
          invalid_request: t('errorInvalidRequest'), request_too_large: t('errorTooLarge'), timeout: t('errorTimeout'),
          network_error: t('errorConnection'), provider_error: t('errorProvider'), malformed_response: t('errorMalformed'),
          rate_limited: t('errorRateLimited'), rate_limit_unavailable: t('errorRateLimitUnavailable'),
        };
        setAiError(messages[payload.error ?? ''] ?? t('errorGeneric'));
        return;
      }
      setAiResult(payload.result);
      setResultFingerprint(requestFingerprint);
      setResultLanguage(language);
    } catch (error) {
      setAiError(error instanceof Error && error.name === 'TimeoutError' ? t('errorTimeout') : error instanceof TypeError ? t('errorConnection') : t('errorGeneric'));
    } finally {
      setIsAnalyzing(false);
    }
  };

  return <section className="ai-mode-panel">
    <div className="ai-mode-intro"><div><div className="eyebrow">{t('aiIntroEyebrow')}</div><h2>{t('aiMode')}</h2><p>{t('aiIntro')}</p></div><span className="ai-coming-badge ai-live-badge">{t('aiBeta')}</span></div>
    {(props.duplicate || props.boardGap || props.villain.length === 1 || emptyCustomRange || actionState.errors.length > 0) && <div className="validation-stack">{props.boardGap && <div className="validation warning">{t('boardGapError')}</div>}{props.duplicate && <div className="validation error">{t('duplicateError')}</div>}{props.villain.length === 1 && <div className="validation warning">{t('villainCardsOptional')}</div>}{emptyCustomRange && <div className="validation warning">{t('emptyCustomRange')}</div>}{actionState.errors.filter((error) => error.index === null).map((error) => <div className="validation error" key={error.message}>{translateActionError(error.message,language,t)}</div>)}</div>}
    <div className="ai-form-grid">
      <section className="surface ai-section"><div className="ai-section-title"><span>01</span><div><h3>{t('handSection')}</h3><p>{t('handSectionDescription')}</p></div></div><div className="ai-card-inputs"><CardGroup title="HERO" slots={['h1','h2']} getCard={props.getCard} setActive={props.setActive}/><CardGroup title={t('villainOptional')} slots={['v1','v2']} getCard={props.getCard} setActive={props.setActive}/><CardGroup title="BOARD" slots={['b0','b1','b2','b3','b4']} getCard={props.getCard} setActive={props.setActive}/></div><p className="ai-help">{t('aiCardHelp')}</p></section>
      <section className="surface ai-section"><div className="ai-section-title"><span>02</span><div><h3>{t('tableSection')}</h3><p>{t('positionAndProfile')}</p></div></div><div className="ai-select-grid"><label className="ai-field"><span>{t('heroPosition')}</span><select value={heroPosition} onChange={(e) => setHeroPosition(e.target.value as Position)}>{POSITIONS.map((position) => <option key={position}>{position}</option>)}</select></label><label className="ai-field"><span>{t('villainPosition')}</span><select value={villainPosition} onChange={(e) => setVillainPosition(e.target.value as Position)}>{POSITIONS.map((position) => <option key={position}>{position}</option>)}</select></label><label className="ai-field ai-profile-field"><span>{t('opponentProfile')}</span><select value={profile} onChange={(e) => setProfile(e.target.value as OpponentProfile)}>{OPPONENT_PROFILES.map((value) => <option key={value} value={value}>{t(profileLabelKeys[value])}</option>)}</select></label></div><p className="ai-profile-description" role="note">{t(profileDescriptionKeys[profile])}</p>{profile === 'custom' && <div className="custom-stats"><div className="ai-stat-fields">{statKeys.map(([key, label]) => <label className="ai-field" key={key}><span>{label}</span><input type="number" min="0" max={key === 'aggressionFactor' ? undefined : 100} step={key === 'aggressionFactor' ? '0.1' : '1'} value={statInput[key]} onChange={(e) => setStatInput((current) => ({ ...current, [key]: e.target.value }))} placeholder={t('optional')} /></label>)}</div>{statsError && <p className="ai-error">{statsError}</p>}</div>}</section>
      <section className="surface ai-section ai-ranges-section"><div className="ai-section-title"><span>03</span><div><h3>{t('rangesSection')}</h3><p>{t('actualAndStrategicRange')}</p></div></div><div className="ai-ranges-grid"><RangeModeSection title={t('heroRange')} mode={heroRangeMode} setMode={setHeroRangeMode} selectedRange={heroSelectedRange} onRangeChange={setHeroSelectedRange} blockers={heroRangeBlockers} autoCopy={t('heroAutoCopy')} actualHandWarning={heroRangeMode === 'custom' ? heroRangeWarning : null}/><RangeModeSection title={t('villainRange')} mode={villainRangeMode} setMode={setVillainRangeMode} selectedRange={villainSelectedRange} onRangeChange={setVillainSelectedRange} blockers={villainRangeBlockers} autoCopy={t('villainAutoCopy')}/></div></section>
      <section className="surface ai-section ai-actions-section"><div className="ai-section-title"><span>04</span><div><h3>{t('actionsSection')}</h3><p>{t('actionAmountHelp')}</p></div><button type="button" className="button button-secondary" onClick={addAction} disabled={!nextSuggestion.player || actionState.errors.length > 0}>{t('addAction')}</button></div><div className="ai-next-action-status" role="status">{nextSuggestion.reason === 'fold' ? t('handComplete') : nextSuggestion.reason === 'all-in' ? t('bothPlayersAllIn') : nextSuggestion.reason === 'river-complete' ? t('bettingRoundComplete') : nextSuggestion.bettingRoundComplete ? t('roundCompleteAdvance', { street: t(streetKeys[nextSuggestion.street]) }) : nextSuggestion.player && actionState.players[nextSuggestion.player].isAllIn ? t('playerAllIn') : null}</div><div className="ai-blinds-row"><label className="ai-field"><span>{t('smallBlind')}</span><input type="number" min="0" step="0.1" value={smallBlind} onChange={(e) => setSmallBlind(e.target.value)} /></label><label className="ai-field"><span>{t('bigBlind')}</span><input type="number" min="0" step="0.1" value={bigBlind} onChange={(e) => setBigBlind(e.target.value)} /></label><label className="ai-field"><span>{t('hero')} · {t('startingStack')} (BB)</span><input type="number" min="0.1" step="0.1" value={heroStartingStack} onChange={(e) => setHeroStartingStack(e.target.value)} /></label><label className="ai-field"><span>{t('villain')} · {t('startingStack')} (BB)</span><input type="number" min="0.1" step="0.1" value={villainStartingStack} onChange={(e) => setVillainStartingStack(e.target.value)} /></label><p>{t('blindsAuto')}</p></div><div className="ai-stack-summary"><span>{t('remainingStack')}: <b>{t('hero')} {number(actionState.players.hero.remainingStackBb,1)} BB</b> · <b>{t('villain')} {number(actionState.players.villain.remainingStackBb,1)} BB</b></span><span>{t('effectiveStack')}: <b>{number(actionState.currentEffectiveStackBb,1)} BB</b> · {t('startingEffectiveStack')}: <b>{number(actionState.startingEffectiveStackBb,1)} BB</b></span>{(actionState.decisionPoint?.spr ?? actionState.spr) !== null && <span title={t('sprHelp')} aria-label={t('sprHelp')}>{t('spr')}: <b>{number(actionState.decisionPoint?.spr ?? actionState.spr ?? 0,1)}</b> · {t(sprCategoryKey(actionState.decisionPoint?.spr ?? actionState.spr ?? 0))} ⓘ</span>}{actionState.streetStartSpr !== null && <span title={t('sprHelp')}>{t('spr')} {t('streetStart')}: <b>{number(actionState.streetStartSpr,1)}</b></span>}</div>{actions.length === 0 ? <div className="ai-empty-actions">{t('firstActionEmpty')}</div> : <div className="ai-action-list">{actions.map((action, index) => { const calculated = actionState.normalizedActions[index]; const issue = actionState.errors.find((error) => error.index === index); const resolution = actionState.actionResolutions[index]; const actionAmount = action.action === 'call' ? calculated?.amountBb : action.amountBb; const beforeAction = calculateActionState(actions.slice(0,index), { hero: heroPosition, villain: villainPosition }, { smallBlindBb: Number(smallBlind), bigBlindBb: Number(bigBlind) }, { hero: Number(heroStartingStack), villain: Number(villainStartingStack) }, action.street); const legalActions = new Set(getLegalActions(beforeAction, action.actor)); return <div className="ai-action-item" key={index}><div className="ai-action-row"><label className="ai-field"><span>{t('street')}</span><select value={action.street} onChange={(e) => updateAction(index, { street: e.target.value as Street })}>{STREETS.map((street) => <option key={street} value={street}>{t(streetKeys[street])}</option>)}</select></label><label className="ai-field"><span>{t('player')}</span><select value={action.actor} onChange={(e) => updateAction(index, { actor: e.target.value as 'hero' | 'villain' })}><option value="hero" disabled={actionState.players.hero.isAllIn}>{t('hero')} ({heroPosition})</option><option value="villain" disabled={actionState.players.villain.isAllIn}>{t('villain')} ({villainPosition})</option></select></label><label className="ai-field"><span>{t('action')}</span><select value={action.action} onChange={(e) => updateAction(index, { action: e.target.value as ActionType, amountBb: null })}>{ACTION_TYPES.map((type) => { return <option key={type} value={type} disabled={!legalActions.has(type)}>{t(actionKeys[type])}</option>; })}</select></label>{isChipAction(action.action) && action.action !== 'all_in' && <label className="ai-field ai-amount-field"><span>{action.action === 'call' ? resolution?.allInKind === 'call-all-in' ? t('callAllIn',{amount:number(resolution.additionalContributionBb,1)}) : t('calculatedCall') : action.action === 'raise' ? t('amountToRaise') : t('amountToBet')}</span><input className={action.action === 'call' ? 'derived-amount' : ''} type="number" min="0" step="0.1" value={actionAmount ?? ''} onChange={(e) => action.action !== 'call' && updateAction(index, { amountBb: e.target.value === '' ? null : Number(e.target.value) })} readOnly={action.action === 'call'} placeholder={t('enterAmount')} />{['bet','raise'].includes(action.action) && <small className="ai-action-resolution">{t('maximumAvailable')}: {number((resolution?.streetTotalBb ?? 0) + (resolution?.player.remainingStackBb ?? 0),1)} BB</small>}</label>}{resolution?.allInKind && action.action !== 'call' && <small className="ai-action-resolution">{t(resolution.allInKind === 'bet-all-in' ? 'betAllIn' : resolution.allInKind === 'raise-all-in' ? 'raiseAllIn' : 'callAllIn',{amount:number(resolution.additionalContributionBb,1)})} · {number(resolution.additionalContributionBb,1)} BB</small>}<button className="ai-remove-action" type="button" aria-label={t('removeAction')} onClick={() => setActions((current) => current.filter((_, i) => i !== index))}>×</button></div>{issue && <p className="ai-action-error" role="alert">{translateActionError(issue.message,language,t)}</p>}</div>; })}</div>}<div className="ai-action-pot">{t('potAfterActions')} <strong>{number(actionState.potBb,2)} bb</strong></div></section>
      <section className="surface ai-section"><div className="ai-section-title"><span>05</span><div><h3>{t('decisionSection')}</h3><p>{t('autoFromHistory')}</p></div></div><div className="ai-derived-point"><label className="ai-field"><span>{decision ? t('potBeforeVillainAction') : t('potAfterActions')}</span><div className="ai-derived-value">{number(decisionPot,2)} <b>bb</b></div></label><label className="ai-field"><span>{decision ? t('villainBetOrRaise') : t('villainWager')}</span><div className="ai-derived-value">{number(decision?.contestableOpponentBetBb ?? decisionBet,2)} <b>bb</b></div></label><label className="ai-field"><span>{t('amountToCall')}</span><div className="ai-derived-value">{number(decisionCall,2)} <b>bb</b></div></label></div><p className="ai-derived-note">{t('valuesFromHistory')}{decision ? ` ${t('decisionStreet',{street:t(streetKeys[decision.street])})}` : ` ${t('noVillainBet')}`}</p>{decision && <div className="ai-stack-summary"><span>{t('hero')} {t('remainingStack')}: <b>{number(decision.heroRemainingStackBb,1)} BB</b></span><span>{t('villain')} {t('remainingStack')}: <b>{number(decision.villainRemainingStackBb,1)} BB</b></span><span>{t('effectiveStack')}: <b>{number(decision.currentEffectiveStackBb,1)} BB</b></span>{decision.facingAllIn && <span>{t('facingAllIn')}</span>}{decision.heroIsAllIn && <span>{t('hero')}: {t('playerAllIn')}</span>}{decision.villainIsAllIn && <span>{t('villain')}: {t('playerAllIn')}</span>}<span>{decision.canFullCall ? t('canFullCall') : t('callAllIn',{amount:number(decisionCall,1)})}</span>{decision.spr !== null && <span title={t('sprHelp')} aria-label={t('sprHelp')}>{t('spr')}: <b>{number(decision.spr,1)}</b> · {t(sprCategoryKey(decision.spr))} ⓘ</span>}</div>}<div className="ai-math-preview"><span>{t('engineMath')}</span><strong>{aiEquity ? `${number(aiEquity.equity * 100,1)}% equity` : aiEquityLoading ? 'Obliczanie equity…' : equityUnavailableReason === 'auto-range' ? t('equityUnknownAuto') : aiEquityError ? t('equityCalculationError') : t('customOrKnownHand')}</strong><small>{t('callEvLabel')}: {callEv === null ? t('evRequiresEquity') : `${callEv >= 0 ? '+' : ''}${number(callEv,1)} bb`} · {t('potAfterCall')}: {number(finalPot,1)} bb</small></div><button type="button" className="button button-primary ai-submit" disabled={!valid || aiEquityLoading || isAnalyzing} onClick={analyze}>{isAnalyzing ? <><span className="ai-spinner" aria-hidden="true"/> Analizowanie rozdania…</> : hasCurrentResult ? 'Analizuj ponownie' : 'Analyze with AI'} {!isAnalyzing && <span>↗</span>}</button><p className="ai-disclaimer">{t('aiDisclaimer')}</p></section>
    </div>
    {aiError && <div className="ai-request-error" role="alert"><div><strong>{t('aiRequestTitle')}</strong><p>{aiError}</p></div><button type="button" className="button button-secondary" onClick={analyze} disabled={isAnalyzing || aiEquityLoading}>{t('retry')}</button></div>}
    {hasCurrentResult && aiResult && <>{resultLanguage && languageMismatchKey(language,resultLanguage) && <p className="ai-language-notice" role="status">{t(languageMismatchKey(language,resultLanguage)!)}</p>}<AIHandReview result={aiResult} math={mathContext} finalPot={finalPot}/></>}
  </section>;
}
