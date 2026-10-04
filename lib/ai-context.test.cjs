const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { buildAIAnalysisContext, createAnalysisRange, DEFAULT_ANALYSIS_RANGE_MODE, formatCard, serializeActions, validateOpponentStats } = require('./ai-context.ts');
const rangeUtils = require('./range.ts');
const { calculateCallAnalysis } = require('./calculations.ts');

const base = {
  language: 'pl',
  hero: { cards: ['As', 'Qh'], position: 'CO', range: { mode: 'auto' } },
  villain: { cards: [], position: 'BB', profile: 'unknown', stats: { vpip: null, pfr: null, threeBet: null, aggressionFactor: null }, range: { mode: 'auto' } },
  board: ['Qs', '7d', '4c', '2h', '9s'],
  actionHistory: [],
  pot: { currentPotBb: 50, villainBetBb: 20, callAmountBb: 20, finalPotBb: 90 },
  stackState: { hero: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, villain: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, startingEffectiveStackBb: 100, currentEffectiveStackBb: 80, spr: 80 / 70, streetStartPotBb: 0, streetStartEffectiveStackBb: null, streetStartSpr: null, facingAllIn: false, canFullCall: true },
  mathematicalContext: { equity: { status: 'known', value: 0.542, source: 'known-hand', villainEquity: 0.4, tiePercent: 0.058, method: 'exact', evaluatedCases: 990 }, requiredEquity: 20 / 90, callEV: { status: 'known', value: 28.78 } },
};

test('card formatter emits standard poker notation', () => {
  assert.equal(formatCard('14s'), 'As');
  assert.equal(formatCard('10h'), 'Th');
  assert.equal(formatCard('2c'), '2c');
});

test('AI context contains cards, positions, profiles, stats, pot, and mathematical context', () => {
  const context = buildAIAnalysisContext({ ...base, villain: { ...base.villain, profile: 'custom', stats: { vpip: 31, pfr: 24, threeBet: 9, aggressionFactor: 3.2 } } });
  assert.deepEqual(context.hero, { cards: ['As', 'Qh'], position: 'CO', range: { mode: 'auto' } });
  assert.equal(context.villain.profile, 'custom');
  assert.deepEqual(context.villain.stats, { vpip: 31, pfr: 24, threeBet: 9, aggressionFactor: 3.2 });
  assert.equal(context.pot.finalPotBb, 90);
  assert.equal(context.mathematicalContext.equity.value, 0.542);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(context)));
});

test('optional custom statistics remain null and invalid statistics are rejected', () => {
  assert.equal(validateOpponentStats(base.villain.stats), null);
  assert.equal(validateOpponentStats({ vpip: 30, pfr: 31, threeBet: null, aggressionFactor: null }), 'PFR cannot be higher than VPIP.');
  assert.match(validateOpponentStats({ vpip: 101, pfr: null, threeBet: null, aggressionFactor: null }), /no greater than 100/);
  assert.throws(() => buildAIAnalysisContext({ ...base, villain: { ...base.villain, profile: 'custom', stats: { vpip: 20, pfr: 21, threeBet: null, aggressionFactor: null } } }), /PFR cannot be higher/);
});

test('action history serialization preserves order, street, action, amount, and actor position', () => {
  const actions = [
    { street: 'preflop', actor: 'hero', action: 'raise', amountBb: 2.5 },
    { street: 'flop', actor: 'villain', action: 'call', amountBb: 4 },
    { street: 'river', actor: 'villain', action: 'bet', amountBb: 35 },
  ];
  const serialized = serializeActions(actions, 'CO', 'BB');
  assert.deepEqual(serialized.map(({ position, street, action, amountBb }) => ({ position, street, action, amountBb })), [
    { position: 'CO', street: 'preflop', action: 'raise', amountBb: 2.5 },
    { position: 'BB', street: 'flop', action: 'call', amountBb: 4 },
    { position: 'BB', street: 'river', action: 'bet', amountBb: 35 },
  ]);
  assert.equal(JSON.parse(JSON.stringify(serialized))[2].amountBb, 35);
});

test('position and profile are context only and never rewrite deterministic math', () => {
  const math = base.mathematicalContext;
  const context1 = buildAIAnalysisContext(base);
  const context2 = buildAIAnalysisContext({ ...base, hero: { ...base.hero, position: 'UTG' }, villain: { ...base.villain, profile: 'maniac' } });
  assert.deepEqual(context1.mathematicalContext, math);
  assert.deepEqual(context2.mathematicalContext, math);
  assert.equal(context1.mathematicalContext.equity.value, context2.mathematicalContext.equity.value);
});


test('Hero and Villain ranges default to Auto and Auto serializes no invented combinations', () => {
  assert.equal(DEFAULT_ANALYSIS_RANGE_MODE, 'auto');
  assert.deepEqual(createAnalysisRange(DEFAULT_ANALYSIS_RANGE_MODE, ['1412s'], 3, 2.5), { mode: 'auto' });
  const context = buildAIAnalysisContext(base);
  assert.deepEqual(context.hero.range, { mode: 'auto' });
  assert.deepEqual(context.villain.range, { mode: 'auto' });
  assert.equal(JSON.stringify(context).includes('selectedHands'), false);
});

test('custom Hero and Villain ranges serialize independently with their supplied summaries', () => {
  const heroRange = createAnalysisRange('custom', ['1412s', '99p'], 18, 1.4);
  const villainRange = createAnalysisRange('custom', ['22p', '76s'], 17, 1.3);
  const context = buildAIAnalysisContext({ ...base, hero: { ...base.hero, range: heroRange }, villain: { ...base.villain, range: villainRange } });
  assert.deepEqual(context.hero.range, { mode: 'custom', selectedHands: ['AQs', '99'], comboCount: 18, percentage: 1.4 });
  assert.deepEqual(context.villain.range, { mode: 'custom', selectedHands: ['22', '76s'], comboCount: 17, percentage: 1.3 });
  assert.notDeepEqual(context.hero.range, context.villain.range);
});

test('range summaries use shared combo generation and blockers without unselecting classes', () => {
  const blockers = ['14s', '13s'].map(require('./poker.ts').parseCard);
  const summary = rangeUtils.getRangeSummary(['1413s'], blockers);
  assert.equal(summary.selectedHandClasses, 1);
  assert.equal(summary.selectedCombos, 3);
  assert.ok(summary.percentage > 0 && summary.percentage < 100);
  assert.equal(rangeUtils.getRangeHandKey(blockers), '1413s');
});

test('Hero actual hand class remains separate and can be checked against a custom Hero range', () => {
  const actualHandClass = rangeUtils.getRangeHandKey(['14s', '12s'].map(require('./poker.ts').parseCard));
  const heroRange = createAnalysisRange('custom', ['1412s'], 3, 0.2);
  assert.equal(heroRange.selectedHands.includes(rangeUtils.getRangeHand(actualHandClass).label), true);
  assert.equal(rangeUtils.includesActualHand(['14s', '12s'].map(require('./poker.ts').parseCard), ['1412s']), true);
  const outsideRange = createAnalysisRange('custom', ['99p'], 6, 0.5);
  assert.equal(outsideRange.selectedHands.includes(rangeUtils.getRangeHand(actualHandClass).label), false);
  assert.equal(rangeUtils.includesActualHand(['14s', '12s'].map(require('./poker.ts').parseCard), ['99p']), false);
  assert.deepEqual(heroRange.selectedHands, ['AQs']);
});

test('changing opponent profile does not change an explicitly selected Villain range', () => {
  const selected = createAnalysisRange('custom', ['22p', '76s'], 17, 1.3);
  const baseContext = buildAIAnalysisContext({ ...base, villain: { ...base.villain, range: selected } });
  const profileContext = buildAIAnalysisContext({ ...base, villain: { ...base.villain, profile: 'passive_fish', range: selected } });
  assert.deepEqual(profileContext.villain.range, baseContext.villain.range);
});

test('strategic ranges do not change deterministic pot odds or call EV', () => {
  const before = calculateCallAnalysis(50, 20, 20, 0.542);
  const _heroRange = createAnalysisRange('custom', ['1412s'], 3, 0.2);
  const _villainRange = createAnalysisRange('custom', ['22p'], 6, 0.5);
  const after = calculateCallAnalysis(50, 20, 20, 0.542);
  assert.deepEqual(after, before);
});

test('Math and AI mode own separate Range Matrix integration points and AI mode stays mounted for tab switching', () => {
  const page = fs.readFileSync(require.resolve('../app/page.tsx'), 'utf8');
  const aiMode = fs.readFileSync(require.resolve('../app/ai-mode.tsx'), 'utf8');
  assert.match(page, /<RangeMatrixPanel title=\{t\('matrixTitle'\)\}/);
  assert.match(aiMode, /<RangeMatrixPanel title=\{title\}/);
  assert.match(page, /hidden=\{analysisMode !== 'math'\}/);
  assert.match(page, /hidden=\{analysisMode !== 'ai'\}/);
  assert.match(aiMode, /useState<RangeHandKey\[]>\(\[\]\)/);
  assert.match(aiMode, /calculateMatchupEquity/);
  assert.doesNotMatch(aiMode, /props\.equity(?:Loading)?/);
  assert.doesNotMatch(page, /<AIModePanel[^>]*\bequity=/);
});
