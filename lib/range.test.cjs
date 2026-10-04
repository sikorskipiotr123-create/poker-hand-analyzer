const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');

// Use the project's TypeScript compiler to run these focused tests without adding a test dependency.
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(output, filename);
};
const { parseCard } = require('./poker.ts');
const { calculateRangeEquity, getAvailableRangeCombinations, getHandCombinations, getRangeHand } = require('./range.ts');

const hand = (key) => getRangeHand(key);

test('starting-hand classes generate correct physical combo counts', () => {
  assert.equal(getHandCombinations(hand('1414p')).length, 6, 'AA has six combos');
  assert.equal(getHandCombinations(hand('1413s')).length, 4, 'AKs has four combos');
  assert.equal(getHandCombinations(hand('1413o')).length, 12, 'AKo has twelve combos');
});

test('hero blockers remove impossible suited combinations', () => {
  const blockers = [parseCard('14s'), parseCard('13s')];
  const combos = getAvailableRangeCombinations(['1413s'], blockers);
  assert.equal(combos.length, 3);
  assert.ok(combos.every((combo) => !combo.some((card) => blockers.some((blocked) => card.rank === blocked.rank && card.suit === blocked.suit))));
  const withBoardBlocker = getAvailableRangeCombinations(['1414p'], [...blockers, parseCard('14h')]);
  assert.equal(withBoardBlocker.length, 1, 'Hero and board blockers leave one legal AA combo');
});

test('changing the selected matrix range changes exact river equity', async () => {
  const hero = [parseCard('14s'), parseCard('14h')];
  const board = [parseCard('13c'), parseCard('7d'), parseCard('4h'), parseCard('9s'), parseCard('3c')];
  const againstAces = await calculateRangeEquity(hero, board, ['1414p']);
  const againstDeuces = await calculateRangeEquity(hero, board, ['22p']);
  assert.equal(againstAces.method, 'exact');
  assert.equal(againstAces.equity, 0.5);
  assert.equal(againstDeuces.equity, 1);
  assert.notEqual(againstAces.equity, againstDeuces.equity);
});
