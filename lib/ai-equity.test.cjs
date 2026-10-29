const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { getAIEquityTarget, buildAIMathematicalContext } = require('./ai-equity.ts');
const { calculateCallAnalysis } = require('./calculations.ts');
const { calculateActionState } = require('./action-state.ts');
const { calculateMatchupEquity, RANGE_HANDS } = require('./range.ts');
const parseCard = (key) => ({ rank: ({ A: 14, K: 13, Q: 12, J: 11, T: 10 }[key[0]] ?? Number(key[0])), suit: key[1] });
const { validateAIAnalysisContext, buildPokerPrompt, createMathematicalSummary } = require('./ai-analysis.ts');

const hero = ['As', 'Js'].map(parseCard);
const board = ['Jh', '8s', '4s', '2d', 'Kc'].map(parseCard);
const rangeKey = (label) => RANGE_HANDS.find((hand) => hand.label === label).key;
const baseContext = {
  language: 'pl', blinds: { smallBlindBb: 0.5, bigBlindBb: 1 },
  hero: { cards: ['As', 'Js'], position: 'BTN', range: { mode: 'auto' } },
  villain: { cards: [], position: 'BB', profile: 'passive_fish', stats: { vpip: null, pfr: null, threeBet: null, aggressionFactor: null }, range: { mode: 'auto' } },
  board: ['Jh', '8s', '4s', '2d', 'Kc'],
  actionHistory: [],
  pot: { currentPotBb: 27.5, villainBetBb: 25, callAmountBb: 25, finalPotBb: 77.5 },
  stackState: { hero: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, villain: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, startingEffectiveStackBb: 100, currentEffectiveStackBb: 80, spr: 80 / 52.5, streetStartPotBb: 0, streetStartEffectiveStackBb: null, streetStartSpr: null, facingAllIn: false, canFullCall: true },
  mathematicalContext: { equity: { status: 'unknown', reason: 'auto-range' }, requiredEquity: 25 / 77.5, callEV: { status: 'unknown', reason: 'equity-unknown' } },
};

test('AI Auto range yields no deterministic matchup target; explicit Custom range and known Villain hand do', () => {
  assert.equal(getAIEquityTarget(hero, [], 'auto', [rangeKey('KK')]), null);
  assert.deepEqual(getAIEquityTarget(hero, [], 'custom', [rangeKey('KK')]).source, 'custom-range');
  assert.equal(getAIEquityTarget(hero, ['Qh', 'Qc'].map(parseCard), 'auto', []).source, 'known-hand');
});

test('exact exposed hand history retains pot odds while Auto-range equity and Call EV stay unknown', () => {
  const actions = [
    { street: 'preflop', actor: 'hero', action: 'raise', amountBb: 2.5 },
    { street: 'preflop', actor: 'villain', action: 'call', amountBb: null },
    { street: 'flop', actor: 'villain', action: 'check', amountBb: null },
    { street: 'flop', actor: 'hero', action: 'bet', amountBb: 5 },
    { street: 'flop', actor: 'villain', action: 'call', amountBb: null },
    { street: 'turn', actor: 'villain', action: 'check', amountBb: null },
    { street: 'turn', actor: 'hero', action: 'bet', amountBb: 6 },
    { street: 'turn', actor: 'villain', action: 'call', amountBb: null },
    { street: 'river', actor: 'villain', action: 'bet', amountBb: 25 },
  ];
  const state = calculateActionState(actions, { hero: 'BTN', villain: 'BB' });
  assert.equal(state.decisionPoint.potBeforeOpponentActionBb, 27.5);
  assert.equal(state.decisionPoint.opponentBetBb, 25);
  assert.equal(state.decisionPoint.callAmountBb, 25);
  const point = state.decisionPoint;
  const callAnalysis = calculateCallAnalysis(point.potBeforeOpponentActionBb, point.opponentBetBb, point.callAmountBb, null);
  const facts = buildAIMathematicalContext(null, null, 'auto-range', callAnalysis);
  assert.equal(callAnalysis.finalPot, 77.5);
  assert.ok(Math.abs(facts.requiredEquity - 0.3225806451612903) < 1e-12);
  assert.deepEqual(facts.equity, { status: 'unknown', reason: 'auto-range' });
  assert.deepEqual(facts.callEV, { status: 'unknown', reason: 'equity-unknown' });
  const context = validateAIAnalysisContext({ ...baseContext, actionHistory: actions.map((action) => ({ ...action, position: action.actor === 'hero' ? 'BTN' : 'BB' })), mathematicalContext: facts });
  const prompt = buildPokerPrompt(context);
  assert.doesNotMatch(prompt.user, /0\.682|68\.2%|0\.542/);
  assert.match(prompt.user, /"requiredEquity": 0\.3225806451612903/);
  assert.match(prompt.user, /"finalPotBb": 77\.5/);
  assert.match(prompt.system, /never invent exact equity, exact bluff frequency, an exact Villain range, or Call EV/);
  assert.match(createMathematicalSummary(context), /Equity Hero.*Nieznane.*Zakres Villaina w trybie Auto jest jakościowy/i);
});

test('AI API rejects fabricated numeric equity when Villain Auto range has no hand', () => {
  const fabricated = { ...baseContext, mathematicalContext: {
    equity: { status: 'known', value: 0.682, source: 'custom-range', villainEquity: 0.318, tiePercent: 0, method: 'exact', evaluatedCases: 1 },
    requiredEquity: 25 / 77.5,
    callEV: { status: 'known', value: 27.855 },
  } };
  assert.throws(() => validateAIAnalysisContext(fabricated), /explicit Custom Villain range/);
});

test('Custom-range equity and EV are calculated, while known-hand equity remains available in Auto mode', async () => {
  const target = getAIEquityTarget(hero, [], 'custom', [rangeKey('KK')]);
  const customEquity = await calculateMatchupEquity({ mode: 'hand', cards: hero }, board, target.villain);
  assert.equal(customEquity.method, 'exact');
  assert.equal(customEquity.samples, 3);
  const customFacts = buildAIMathematicalContext(customEquity, target.source, 'auto-range', calculateCallAnalysis(27.5, 25, 25, customEquity.equity));
  assert.equal(customFacts.equity.status, 'known');
  assert.equal(customFacts.equity.source, 'custom-range');
  assert.equal(customFacts.callEV.status, 'known');
  const knownTarget = getAIEquityTarget(hero, ['Qh', 'Qc'].map(parseCard), 'auto', []);
  const knownEquity = await calculateMatchupEquity({ mode: 'hand', cards: hero }, board, knownTarget.villain);
  assert.equal(buildAIMathematicalContext(knownEquity, knownTarget.source, 'auto-range', calculateCallAnalysis(27.5, 25, 25, knownEquity.equity)).equity.source, 'known-hand');
});
