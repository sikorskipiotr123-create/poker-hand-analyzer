const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(output, filename);
};
const poker = require('./poker.ts');
const range = require('./range.ts');
const { calculateCallAnalysis, EV_BREAK_EVEN_TOLERANCE } = require('./calculations.ts');
const c = poker.parseCard;
const cards = (values) => { const list = Array.isArray(values) ? values : values.split(' '); return list.length && typeof list[0] === 'string' ? list.map(c) : list; }
const deterministicRng = () => {
  let seed = 0x12345678;
  return () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
};
function assertOutcome(result, expected) {
  assert.equal(result.wins, expected.wins);
  assert.equal(result.losses, expected.losses);
  assert.equal(result.ties, expected.ties);
  assert.equal(result.samples, expected.wins + expected.losses + expected.ties);
  assert.ok(result.equity >= 0 && result.equity <= 1, `equity ${result.equity} must be between 0 and 1`);
  assert.equal(result.equity, (result.wins + result.ties / 2) / result.samples);
  assert.equal(result.heroWinPercent, result.wins / result.samples * 100);
  assert.equal(result.villainWinPercent, result.losses / result.samples * 100);
  assert.equal(result.tiePercent, result.ties / result.samples * 100);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
}

test('all nine standard hand categories are ranked in order', () => {
  const samples = [
    ['14s 13d 9c 6h 3s', 0], ['14s 14h 13d 9c 3s', 1],
    ['14s 14h 13d 13h 3s', 2], ['14s 14h 14c 13d 3s', 3],
    ['9s 8d 7c 6h 5s', 4], ['14s 11s 8s 5s 2s', 5],
    ['14s 14h 14c 13d 13h', 6], ['14s 14h 14c 14d 13h', 7],
    ['9s 8s 7s 6s 5s', 8],
  ];
  for (const [input, category] of samples) assert.equal(poker.evaluate(cards(input.split(' '))).category, category, input);
});

test('wheel straight is five-high and loses to a six-high straight', () => {
  const wheel = poker.evaluate(cards('14s 2d 3c 4h 5s'.split(' ')));
  const sixHigh = poker.evaluate(cards('2s 3d 4c 5h 6s'.split(' ')));
  assert.equal(wheel.category, 4);
  assert.deepEqual(wheel.tiebreak, [5]);
  assert.equal(poker.compare(sixHigh, wheel), 1);
});

test('flush, full house, quads and straight-flush kickers compare correctly', () => {
  const flush = poker.evaluate(cards('14s 11s 8s 5s 2s'.split(' ')));
  const straight = poker.evaluate(cards('9s 8d 7c 6h 5s'.split(' ')));
  const fullHouse = poker.evaluate(cards('14s 14h 14c 13d 13h'.split(' ')));
  assert.equal(poker.compare(flush, straight), 1);
  assert.equal(poker.compare(fullHouse, flush), 1);
  assert.equal(poker.compare(poker.evaluate(cards('14s 11s 8s 5s 2s'.split(' '))), poker.evaluate(cards('13h 12h 9h 6h 3h'.split(' ')))), 1);
  assert.equal(poker.compare(poker.evaluate(cards('14s 14h 14c 13d 13h'.split(' '))), poker.evaluate(cards('13s 13h 13c 14d 14s'.split(' ')))), 1);
  assert.equal(poker.compare(poker.evaluate(cards('12s 12h 12c 12d 14h'.split(' '))), poker.evaluate(cards('11s 11h 11c 11d 14d'.split(' ')))), 1);
  assert.equal(poker.compare(poker.evaluate(cards('9s 8s 7s 6s 5s'.split(' '))), poker.evaluate(cards('8h 7h 6h 5h 4h'.split(' ')))), 1);
});

test('the board plays for both players and produces a split pot', async () => {
  const board = cards('2c 3h 4s 5d 6c');
  const hero = cards('14s 13d'); const villain = cards('14h 13h');
  const a = poker.evaluate([...hero, ...board]); const b = poker.evaluate([...villain, ...board]);
  assert.equal(poker.compare(a, b), 0);
  const result = await poker.calculateEquity(hero, board, villain);
  assertOutcome(result, { wins: 0, losses: 0, ties: 1 });
});

test('duplicate cards, invalid ranks and impossible board sizes are rejected', async () => {
  assert.throws(() => poker.evaluate(cards('14s 14s 13d 12c 11h'.split(' '))), /more than once/);
  assert.throws(() => poker.evaluate([{ rank: 1, suit: 's' }, ...cards('2s 3h 4d 5c'.split(' '))]), /invalid rank/);
  await assert.rejects(poker.calculateEquity(cards('14s 13d'), cards('2c 3d'), cards('12c 11h')), /Board must contain/);
  await assert.rejects(poker.calculateEquity(cards('14s 13d'), cards('2c 3d 4h'), cards('14s 11h')), /more than once/);
});

test('fixed hand equity on river checks a win, a loss and a tie independently', async () => {
  const board = cards('2c 3d 4h 8s 9c'.split(' '));
  const win = await poker.calculateEquity(cards('14s 13d'), board, cards('12c 11h'));
  assert.equal(win.method, 'exact'); assertOutcome(win, { wins: 1, losses: 0, ties: 0 });
  const loss = await poker.calculateEquity(cards('12c 11h'), board, cards('14s 13d'));
  assert.equal(loss.method, 'exact'); assertOutcome(loss, { wins: 0, losses: 1, ties: 0 });
  const tie = await poker.calculateEquity(cards('5s 6h'), board, cards('5h 6d'));
  assert.equal(tie.method, 'exact'); assertOutcome(tie, { wins: 0, losses: 0, ties: 1 });
});

test('flop and turn enumerate every legal runout with deterministic W/L/T totals', async () => {
  const hero = cards('14s 13d'); const villain = cards('12c 11h');
  const flop = await poker.calculateEquity(hero, cards('2c 3d 4h'), villain);
  assert.equal(flop.method, 'exact'); assertOutcome(flop, { wins: 773, losses: 189, ties: 28 });
  const turn = await poker.calculateEquity(hero, cards('2c 3d 4h 8s'), villain);
  assert.equal(turn.method, 'exact'); assertOutcome(turn, { wins: 38, losses: 6, ties: 0 });
});

test('preflop hand-vs-hand uses the requested deterministic Monte Carlo trials', async () => {
  const result = await poker.calculateEquity(cards('14s 13d'), [], cards('12c 11h'), { samples: 256, rng: deterministicRng() });
  assert.equal(result.method, 'monte-carlo');
  assertOutcome(result, { wins: 166, losses: 90, ties: 0 });
});

test('exact range equity applies combination weights and blockers', async () => {
  const hero = cards('14s 14h');
  const board = cards('13c 7d 4h 9s 3c');
  const versusAces = await range.calculateRangeEquity(hero, board, ['1414p']);
  assert.equal(versusAces.method, 'exact'); assertOutcome(versusAces, { wins: 0, losses: 0, ties: 1 });
  const versusDeuces = await range.calculateRangeEquity(hero, board, ['22p']);
  assert.equal(versusDeuces.method, 'exact'); assertOutcome(versusDeuces, { wins: 6, losses: 0, ties: 0 });
  assert.equal(versusAces.equity, 0.5);
  assert.equal(versusDeuces.equity, 1);
  const blockerCombos = range.getAvailableRangeCombinations(['1413s'], cards('14s 13s'.split(' ')));
  assert.equal(blockerCombos.length, 3);
  assert.ok(blockerCombos.every((combo) => !combo.some((card) => ['14s', '13s'].includes(poker.cardKey(card)))));
});

test('flop range exhaustively combines every legal hand and runout', async () => {
  const result = await range.calculateRangeEquity(cards('14s 13d'), cards('2c 3d 4h'), ['1414p']);
  assert.equal(result.method, 'exact');
  assertOutcome(result, { wins: 9, losses: 2451, ties: 510 });
});

test('exact range turn enumeration counts each legal opponent/runout case', async () => {
  const result = await range.calculateRangeEquity(cards('14s 13d'), cards('2c 3d 4h 8s'), ['1414p']);
  assert.equal(result.method, 'exact');
  assert.equal(result.samples, 132);
  assertOutcome(result, { wins: 0, losses: 120, ties: 12 });
});

test('preflop range uses reproducible Monte Carlo and changing range changes equity', async () => {
  const hero = cards('14s 14h');
  const board = cards('13c 7d 4h 9s 3c');
  const againstAces = await range.calculateRangeEquity(hero, board, ['1414p']);
  const againstDeuces = await range.calculateRangeEquity(hero, board, ['22p']);
  assert.equal(againstAces.equity, 0.5); assert.equal(againstDeuces.equity, 1);
  assert.notEqual(againstAces.equity, againstDeuces.equity);
  const preflop = await range.calculateRangeEquity(cards('14s 13d'), [], ['1414p'], { samples: 128, rng: deterministicRng() });
  assert.equal(preflop.method, 'monte-carlo');
  assertOutcome(preflop, { wins: 8, losses: 119, ties: 1 });
});

test('no legal range after blockers is reported as invalid instead of zero equity', async () => {
  await assert.rejects(range.calculateRangeEquity(cards('14s 14h'), cards('14c 14d 2s'), ['1414p']), /no legal combinations/);
});


test('Monte Carlo uses unique unseen cards and converges toward exact flop equity', async () => {
  const hero = cards('14s 13d'); const board = cards('2c 3d 4h'); const villain = cards('12c 11h');
  const exact = await poker.calculateEquity(hero, board, villain);
  const shortRun = await poker.calculateEquity(hero, board, villain, { samples: 256, exactCaseLimit: 1, rng: deterministicRng() });
  const longRun = await poker.calculateEquity(hero, board, villain, { samples: 20000, exactCaseLimit: 1, rng: deterministicRng() });
  assert.equal(shortRun.method, 'monte-carlo');
  assert.equal(shortRun.samples, 256);
  assert.equal(longRun.samples, 20000);
  assertOutcome(shortRun, { wins: shortRun.wins, losses: shortRun.losses, ties: shortRun.ties });
  assertOutcome(longRun, { wins: longRun.wins, losses: longRun.losses, ties: longRun.ties });
  assert.ok(Math.abs(longRun.equity - exact.equity) < Math.abs(shortRun.equity - exact.equity));
});

test('empty, invalid and fully blocked ranges are rejected', async () => {
  const hero = cards('14s 13d');
  await assert.rejects(range.calculateRangeEquity(hero, [], []), /no legal combinations/);
  await assert.rejects(range.calculateRangeEquity(hero, [], ['not-a-range-key']), /no legal combinations/);
  await assert.rejects(range.calculateRangeEquity(cards('14s 14h'), cards('14c 14d 2s 3c 4h'), ['1414p']), /no legal combinations/);
});

test('pot odds and call EV share one final-pot definition and classify decisions', () => {
  const breakEvenEquity = 20 / 90;
  const breakEven = calculateCallAnalysis(50, 20, 20, breakEvenEquity);
  assert.equal(breakEven.finalPot, 90);
  assert.equal(breakEven.requiredEquity, 20 / 90);
  assert.ok(Math.abs(breakEven.callEv) < 1e-10);
  assert.equal(breakEven.recommendation, '≈ BREAK-EVEN');

  const profitable = calculateCallAnalysis(50, 20, 20, 0.3);
  assert.equal(profitable.callEv, 7);
  assert.equal(profitable.recommendation, 'SPRAWDŹ · +EV');
  const losing = calculateCallAnalysis(50, 20, 20, 0.2);
  assert.equal(losing.callEv, -2);
  assert.equal(losing.recommendation, 'PASUJ · −EV');
  const nearBreakEven = calculateCallAnalysis(50, 20, 20, (20 + EV_BREAK_EVEN_TOLERANCE / 2) / 90);
  assert.equal(nearBreakEven.recommendation, '≈ BREAK-EVEN');
  assert.throws(() => calculateCallAnalysis(50, 20, 20, 1.01), /between 0 and 1/);
});
