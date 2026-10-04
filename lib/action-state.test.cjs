const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { calculateActionState } = require('./action-state.ts');
const { calculateCallAnalysis } = require('./calculations.ts');
const { getRangeSummary } = require('./range.ts');
const { parseCard } = require('./poker.ts');
const positions = { hero: 'BTN', villain: 'BB' };
const action = (actor, actionType, amountBb = null, street = 'preflop') => ({ street, actor, action: actionType, amountBb });

test('posts blinds automatically and derives BB call as 1.5 after BTN raises to 2.5', () => {
  const state = calculateActionState([action('hero', 'raise', 2.5)], positions);
  assert.equal(state.potBb, 4);
  assert.equal(state.amountToCall.villain, 1.5);
  const called = calculateActionState([action('hero', 'raise', 2.5), action('villain', 'call')], positions);
  assert.equal(called.normalizedActions[1].amountBb, 1.5);
  assert.equal(called.potBb, 5.5);
});

test('call after bet 5 is derived as 5', () => {
  const state = calculateActionState([action('hero', 'bet', 5), action('villain', 'call')], { hero: 'CO', villain: 'HJ' });
  assert.equal(state.normalizedActions[1].amountBb, 5);
  assert.equal(state.potBb, 11.5);
});

test('raise-to 15 after bet 5 leaves 10 to call', () => {
  const state = calculateActionState([action('hero', 'bet', 5), action('villain', 'raise', 15)], { hero: 'CO', villain: 'HJ' });
  assert.equal(state.amountToCall.hero, 10);
  assert.equal(state.decisionPoint.potBeforeOpponentActionBb, 6.5);
  assert.equal(state.decisionPoint.opponentBetBb, 15);
  assert.equal(state.decisionPoint.contestableOpponentBetBb, 10);
  assert.equal(state.decisionPoint.callAmountBb, 10);
  assert.equal(state.decisionPoint.finalContestablePotBb, 26.5);
});

test('pot carries over while street contributions reset', () => {
  const state = calculateActionState([
    action('hero', 'bet', 5), action('villain', 'call'),
    action('hero', 'check', null, 'flop'), action('villain', 'bet', 3, 'flop'),
  ], { hero: 'CO', villain: 'BB' }, { smallBlindBb: 0, bigBlindBb: 0 });
  assert.equal(state.potBb, 13);
  assert.deepEqual(state.streetContributions, { hero: 0, villain: 3 });
  assert.equal(state.decisionPoint.potBeforeOpponentActionBb, 10);
  assert.equal(state.decisionPoint.callAmountBb, 3);
});

test('editing an earlier raise recalculates later calls and decision point', () => {
  const actions = [action('hero', 'raise', 2.5), action('villain', 'call')];
  assert.equal(calculateActionState(actions, positions).normalizedActions[1].amountBb, 1.5);
  actions[0].amountBb = 4;
  assert.equal(calculateActionState(actions, positions).normalizedActions[1].amountBb, 3);
});

test('validates check while facing bet, call without wager, and bet facing wager', () => {
  assert.match(calculateActionState([action('hero', 'bet', 5), action('villain', 'check')], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }).errors[0].message, /Check jest niemożliwy/);
  assert.match(calculateActionState([action('hero', 'call')], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }).errors[0].message, /nie ma zakładu/);
  assert.match(calculateActionState([action('hero', 'bet', 5), action('villain', 'bet', 8)], { hero: 'CO', villain: 'HJ' }).errors[0].message, /wybierz Raise/);
});

test('validates non-increasing raise-to and actions after fold', () => {
  const raise = calculateActionState([action('hero', 'bet', 5), action('villain', 'raise', 5)], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 });
  assert.match(raise.errors.at(-1).message, /musi być większy/);
  const folded = calculateActionState([action('hero', 'fold'), action('villain', 'check')], positions);
  assert.match(folded.errors.at(-1).message, /po foldzie/);
});

test('derived decision point adapts to the existing pot-odds and EV formula without changing it', () => {
  const state = calculateActionState([action('hero', 'bet', 5), action('villain', 'raise', 15)], { hero: 'CO', villain: 'BB' });
  const point = state.decisionPoint;
  const analysis = calculateCallAnalysis(point.potBeforeOpponentActionBb, point.opponentBetBb, point.callAmountBb, 0.5);
  assert.equal(analysis.finalPot, point.potBeforeOpponentActionBb + point.opponentBetBb + point.callAmountBb);
  assert.equal(analysis.requiredEquity, point.callAmountBb / analysis.finalPot);
  assert.equal(analysis.callEv, 0.5 * analysis.finalPot - point.callAmountBb);
});

test('action-history calculation does not change range blockers or equity inputs', () => {
  const blockers = ['As', 'Ks'].map(parseCard);
  const before = getRangeSummary(['1413s'], blockers);
  calculateActionState([action('hero', 'bet', 5), action('villain', 'raise', 15)], positions);
  const after = getRangeSummary(['1413s'], blockers);
  assert.deepEqual(after, before);
});

test('rejects zero and negative wager targets', () => {
  const zero = calculateActionState([action('hero', 'bet', 0)], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 });
  const negative = calculateActionState([action('hero', 'bet', -2)], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 });
  assert.match(zero.errors[0].message, /dodatnią kwotę/);
  assert.match(negative.errors[0].message, /dodatnią kwotę/);
});

test('blinds remain in the pot even when their seats are outside the tracked heads-up pair', () => {
  const state = calculateActionState([], { hero: 'BTN', villain: 'CO' });
  assert.equal(state.potBb, 1.5);
  assert.deepEqual(state.streetContributions, { hero: 0, villain: 0 });
});


test('starting stacks fund blinds and short blind posts are capped', () => {
  const state = calculateActionState([], { hero: 'BB', villain: 'SB' }, { smallBlindBb: 0.5, bigBlindBb: 1 }, { hero: 100, villain: 100 });
  assert.equal(state.players.hero.remainingStackBb, 99);
  assert.equal(state.players.hero.totalContributionBb, 1);
  assert.equal(state.players.villain.remainingStackBb, 99.5);
  const short = calculateActionState([], { hero: 'BB', villain: 'SB' }, { smallBlindBb: 0.5, bigBlindBb: 1 }, { hero: 0.4, villain: 0.3 });
  assert.equal(short.players.hero.remainingStackBb, 0);
  assert.equal(short.players.villain.remainingStackBb, 0);
  assert.equal(short.potBb, 0.7);
});

test('All-in adds only remaining chips after prior-street contribution', () => {
  const state = calculateActionState([
    action('hero', 'bet', 35), action('villain', 'call'),
    action('hero', 'all_in', null, 'flop'),
  ], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 100, villain: 200 });
  assert.equal(state.actionResolutions[2].additionalContributionBb, 65);
  assert.equal(state.players.hero.remainingStackBb, 0);
  assert.equal(state.actionResolutions[2].streetTotalBb, 65);
  assert.equal(state.actionResolutions[2].allInKind, 'bet-all-in');
});

test('short stack automatic call is a 12 BB Call All-in and returns unmatched chips', () => {
  const state = calculateActionState([
    action('villain', 'bet', 20), action('hero', 'call'),
  ], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 12, villain: 80 });
  assert.equal(state.normalizedActions[1].amountBb, 12);
  assert.equal(state.actionResolutions[1].allInKind, 'call-all-in');
  assert.equal(state.actionResolutions[1].additionalContributionBb, 12);
  assert.equal(state.players.hero.remainingStackBb, 0);
  assert.equal(state.totalContributions.villain, 12);
  assert.equal(state.potBb, 24);
});

test('raise-to includes current-street contribution and cannot exceed stack', () => {
  const actions = [
    action('hero', 'bet', 5, 'flop'), action('villain', 'raise', 10, 'flop'),
    action('hero', 'raise', 30, 'flop'),
  ];
  const state = calculateActionState(actions, { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 30, villain: 100 });
  assert.equal(state.players.hero.remainingStackBb, 0);
  assert.equal(state.streetContributions.hero, 30);
  const invalid = calculateActionState([action('hero', 'bet', 40)], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 30, villain: 100 });
  assert.match(invalid.errors.at(-1).message, /ma tylko 30\.00 BB/);
  assert.equal(invalid.players.hero.remainingStackBb, 30);
});

test('effective stacks use the minimum starting and remaining stack', () => {
  const state = calculateActionState([], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 100, villain: 60 });
  assert.equal(state.startingEffectiveStackBb, 60);
  assert.equal(state.currentEffectiveStackBb, 60);
});

test('all-in action resolves to a bet, raise, or call and no player acts after being all-in', () => {
  const bet = calculateActionState([action('hero', 'all_in')], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 20, villain: 30 });
  assert.equal(bet.actionResolutions[0].allInKind, 'bet-all-in');
  const raise = calculateActionState([action('villain', 'bet', 5), action('hero', 'all_in')], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 20, villain: 30 });
  assert.equal(raise.actionResolutions[1].allInKind, 'raise-all-in');
  const call = calculateActionState([action('villain', 'bet', 5), action('hero', 'all_in')], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 5, villain: 30 });
  assert.equal(call.actionResolutions[1].allInKind, 'call-all-in');
  const blocked = calculateActionState([action('hero', 'all_in'), action('hero', 'check')], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 20, villain: 30 });
  assert.match(blocked.errors.at(-1).message, /już all-in/);
});

test('both players all-in and no later betting action is accepted', () => {
  const state = calculateActionState([
    action('hero', 'all_in'), action('villain', 'all_in'), action('hero', 'check', null, 'flop'),
  ], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 20, villain: 20 });
  assert.equal(state.players.hero.isAllIn, true);
  assert.equal(state.players.villain.isAllIn, true);
  assert.match(state.errors.at(-1).message, /all-in/);
});

test('editing or deleting earlier actions deterministically recalculates later stacks', () => {
  const actions = [action('hero', 'bet', 10), action('villain', 'call'), action('hero', 'all_in', null, 'flop')];
  const before = calculateActionState(actions, { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 50, villain: 100 });
  assert.equal(before.actionResolutions[2].additionalContributionBb, 40);
  actions[0].amountBb = 20;
  const edited = calculateActionState(actions, { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 50, villain: 100 });
  assert.equal(edited.actionResolutions[2].additionalContributionBb, 30);
  actions.splice(0, 2);
  const deleted = calculateActionState(actions, { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 50, villain: 100 });
  assert.equal(deleted.actionResolutions[0].additionalContributionBb, 50);
  assert.equal(deleted.players.hero.remainingStackBb, 0);
});

test('oversized Villain wager cannot inflate short Hero pot odds or final contestable pot', () => {
  const state = calculateActionState([action('villain', 'bet', 50)], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 20, villain: 80 });
  const point = state.decisionPoint;
  assert.equal(point.callAmountBb, 20);
  assert.equal(point.contestableOpponentBetBb, 20);
  assert.equal(point.finalContestablePotBb, 40);
  const analysis = calculateCallAnalysis(point.potBeforeOpponentActionBb, point.contestableOpponentBetBb, point.callAmountBb, null);
  assert.equal(analysis.requiredEquity, 0.5);
  const called = calculateActionState([action('villain', 'bet', 50), action('hero', 'call')], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 20, villain: 80 });
  assert.equal(called.potBb, 40);
  assert.equal(called.totalContributions.villain, 20);
});

test('automatic calls, blinds, and pot calculations remain derived from replay', () => {
  const state = calculateActionState([action('hero', 'raise', 2.5), action('villain', 'call')], positions);
  assert.equal(state.normalizedActions[1].amountBb, 1.5);
  assert.equal(state.potBb, 5.5);
  assert.equal(state.players.hero.remainingStackBb, 97.5);
});

test('SPR category boundaries are deterministic: 1 low, 3 and 6 medium', () => {
  const { getSprCategory } = require('./action-state.ts');
  assert.equal(getSprCategory(0.99), 'very-low');
  assert.equal(getSprCategory(1), 'low');
  assert.equal(getSprCategory(2.99), 'low');
  assert.equal(getSprCategory(3), 'medium');
  assert.equal(getSprCategory(6), 'medium');
  assert.equal(getSprCategory(6.01), 'high');
});

test('postflop SPR uses effective remaining stack divided by pot at street start', () => {
  const state = calculateActionState([
    action('hero', 'bet', 5), action('villain', 'call'), action('hero', 'check', null, 'flop'),
  ], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 30, villain: 60 });
  assert.equal(state.streetStartPotBb, 10);
  assert.equal(state.streetStartSpr, 2.5);
});

test('manual wager that exactly exhausts a stack is normalized as the matching all-in type', () => {
  const state = calculateActionState([action('hero', 'bet', 30)], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 30, villain: 60 });
  assert.equal(state.actionResolutions[0].allInKind, 'bet-all-in');
  assert.equal(state.players.hero.remainingStackBb, 0);
});

test('changing positions, blind sizes, and starting stacks replays blind deductions', () => {
  const base = calculateActionState([], { hero: 'SB', villain: 'BB' }, { smallBlindBb: 0.5, bigBlindBb: 1 }, { hero: 100, villain: 100 });
  assert.equal(base.players.hero.remainingStackBb, 99.5);
  assert.equal(base.players.villain.remainingStackBb, 99);
  const changed = calculateActionState([], { hero: 'SB', villain: 'BB' }, { smallBlindBb: 1, bigBlindBb: 2 }, { hero: 50, villain: 60 });
  assert.equal(changed.players.hero.remainingStackBb, 49);
  assert.equal(changed.players.villain.remainingStackBb, 58);
  assert.equal(changed.startingEffectiveStackBb, 50);
});

test('starting-stack cap rejects a 40 BB bet after Hero has invested 20 of a 50 BB stack', () => {
  const state = calculateActionState([
    action('hero', 'bet', 20), action('villain', 'call'), action('hero', 'bet', 40, 'flop'),
  ], { hero: 'CO', villain: 'HJ' }, { smallBlindBb: 0, bigBlindBb: 0 }, { hero: 50, villain: 100 });
  assert.equal(state.players.hero.remainingStackBb, 30);
  assert.match(state.errors.at(-1).message, /ma tylko 30\.00 BB/);
  assert.equal(state.players.hero.remainingStackBb, 30);
});
