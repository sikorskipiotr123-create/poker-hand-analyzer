const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(output, filename);
};
const { parseCard } = require('./poker.ts');
const { calculateMatchupEquity, calculateRangeVsRangeEquity, getAvailableRangeCombinations, getRangePreset } = require('./range.ts');
const c = (keys) => keys.map((key) => parseCard(key.replace(/^A/, '14').replace(/^K/, '13').replace(/^Q/, '12').replace(/^J/, '11')));
const boardRiver = c(['2c', '3d', '4h', '8s', '9c']);
const range = (key) => [key];
const hand = (cards) => ({ mode: 'hand', cards: c(cards) });
const hands = (keys) => ({ mode: 'range', range: keys });

test('all four matchup modes produce the independently verifiable river outcome', async () => {
  const hh = await calculateMatchupEquity(hand(['As', 'Ah']), boardRiver, hand(['Ks', 'Kh']));
  const hr = await calculateMatchupEquity(hand(['As', 'Ah']), boardRiver, hands(range('1313p')));
  const rh = await calculateMatchupEquity(hands(range('1414p')), boardRiver, hand(['Ks', 'Kh']));
  const rr = await calculateMatchupEquity(hands(range('1414p')), boardRiver, hands(range('1313p')));
  for (const result of [hh, hr, rh, rr]) {
    assert.equal(result.method, 'exact');
    assert.equal(result.equity, 1);
    assert.equal(result.heroWinPercent, 100);
    assert.equal(result.villainWinPercent, 0);
    assert.equal(result.tiePercent, 0);
  }
  assert.equal(hh.samples, 1);
  assert.equal(hr.samples, 6);
  assert.equal(rh.samples, 6);
  assert.equal(rr.samples, 36);
});

test('river range-vs-range board-playing tie counts every compatible physical pair', async () => {
  const result = await calculateRangeVsRangeEquity(range('99p'), range('88p'), c(['As', 'Ks', 'Qs', 'Js', '10s']));
  assert.equal(result.samples, 36);
  assert.equal(result.wins, 0);
  assert.equal(result.losses, 0);
  assert.equal(result.ties, 36);
  assert.equal(result.equity, 0.5);
});

test('turn range-vs-range enumerates all 44 rivers for each legal pair', async () => {
  const result = await calculateRangeVsRangeEquity(range('1414p'), range('1313p'), c(['2c', '3d', '4h', '8s']));
  assert.equal(result.method, 'exact');
  assert.equal(result.samples, 36 * 44);
  assert.equal(result.wins + result.losses + result.ties, result.samples);
  assert.equal(result.wins, 1512);
  assert.equal(result.losses, 72);
  assert.equal(result.ties, 0);
  assert.equal(result.equity, 1512 / 1584);
});

test('known villain cards block Hero range combinations', async () => {
  const result = await calculateMatchupEquity(hands(range('1414p')), boardRiver, hand(['As', 'Kh']));
  assert.equal(getAvailableRangeCombinations(range('1414p'), [...boardRiver, ...c(['As', 'Kh'])]).length, 3);
  assert.equal(result.samples, 3);
  assert.equal(result.equity, 1);
});

test('known Hero cards block Villain range combinations, including exact tie', async () => {
  const result = await calculateMatchupEquity(hand(['As', 'Ac']), boardRiver, hands(range('1414p')));
  assert.equal(getAvailableRangeCombinations(range('1414p'), [...boardRiver, ...c(['As', 'Ac'])]).length, 1);
  assert.equal(result.samples, 1);
  assert.equal(result.wins, 0);
  assert.equal(result.losses, 0);
  assert.equal(result.ties, 1);
  assert.equal(result.equity, 0.5);
});

test('cross-range collisions are removed and combo classes are not equally weighted', async () => {
  const result = await calculateRangeVsRangeEquity(['1414p', '1413s'], ['1414p'], boardRiver);
  // 6 AA + 4 AKs Hero combos versus 6 Villain AA combos. Each physical compatible pair counts once.
  assert.equal(result.samples, 18);
  assert.ok(result.equity >= 0 && result.equity <= 1);
});

test('unweighted ranges count legal physical matchups rather than equally weighting classes', async () => {
  const againstKings = await calculateRangeVsRangeEquity(['1414p', '1413s'], ['1313p'], boardRiver);
  assert.equal(againstKings.samples, 48); // 36 AA-vs-KK pairs + 12 collision-free AKs-vs-KK pairs.
  assert.equal(againstKings.wins, 36);
  assert.equal(againstKings.losses, 12);
  assert.equal(againstKings.ties, 0);
  assert.equal(againstKings.equity, 0.75);
  const sameAces = await calculateRangeVsRangeEquity(range('1414p'), range('1414p'), boardRiver);
  assert.equal(sameAces.samples, 6);
  assert.equal(sameAces.ties, 6);
  assert.equal(sameAces.equity, 0.5);
  assert.notEqual(againstKings.equity, sameAces.equity);
});

test('exact threshold falls back to reproducible Monte Carlo with requested simulations', async () => {
  let state = 123456789;
  const rng = () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296);
  const result = await calculateRangeVsRangeEquity(range('1414p'), range('1313p'), boardRiver, { exactCaseLimit: 1, samples: 500, rng });
  assert.equal(result.method, 'monte-carlo');
  assert.equal(result.samples, 500);
  assert.equal(result.wins + result.losses + result.ties, 500);
  assert.equal(result.equity, 1);
  assert.ok(result.equity >= 0 && result.equity <= 1);
});

test('empty, invalid, fully blocked, and incompatible ranges fail with clear validation', async () => {
  await assert.rejects(calculateRangeVsRangeEquity([], range('1414p'), boardRiver), /Hero range is empty/);
  await assert.rejects(calculateRangeVsRangeEquity(range('1414p'), [], boardRiver), /Villain range is empty/);
  await assert.rejects(calculateRangeVsRangeEquity(['bad-class'], range('1414p'), boardRiver), /invalid hand class/);
  await assert.rejects(calculateRangeVsRangeEquity(range('1414p'), range('1313p'), c(['As', 'Ah', 'Ad', 'Ac', '2s'])), /Hero range has no legal combinations/);
  await assert.rejects(calculateRangeVsRangeEquity(range('1414p'), range('1313p'), c(['Ks', 'Kh', 'Kd', 'Kc', '2s'])), /Villain range has no legal combinations/);
  await assert.rejects(calculateRangeVsRangeEquity(range('1414p'), range('1414p'), c(['As', '2c', '3d', '4h', '5s'])), /no legal Hero\/Villain combination pairs/);
});

test('range calculations retain independent selection arrays for math and AI consumers', () => {
  const math = getRangePreset('standard');
  const aiHero = getRangePreset('tight');
  const aiVillain = getRangePreset('wide');
  const changedMath = math.filter((key) => key !== '1414p');
  assert.ok(math.includes('1414p'));
  assert.ok(!changedMath.includes('1414p'));
  assert.notEqual(changedMath, aiHero);
  assert.deepEqual(aiHero, getRangePreset('tight'));
  assert.deepEqual(aiVillain, getRangePreset('wide'));
});
