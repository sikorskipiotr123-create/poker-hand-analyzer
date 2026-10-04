const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(output, filename);
};
const { getLegalActions, getNextStreet, suggestNextAction } = require('./next-action.ts');
const { calculateActionState } = require('./action-state.ts');
const { translate } = require('./i18n.ts');

const blinds = { smallBlindBb: 0, bigBlindBb: 0 };
const stacks = { hero: 100, villain: 100 };
const positions = { hero: 'BTN', villain: 'BB' };
const action = (street, actor, type, amountBb = null) => ({ street, actor, action: type, amountBb });

test('regression: BTN raises to 3 preflop, BB owes 2 and round remains open', () => {
  const actions = [action('preflop', 'hero', 'raise', 3)];
  const suggestion = suggestNextAction(actions, positions, { smallBlindBb: 0.5, bigBlindBb: 1 }, stacks, 'river');
  assert.deepEqual({ street: suggestion.street, player: suggestion.player, action: suggestion.defaultAction, callAmountBb: suggestion.callAmountBb, bettingRoundComplete: suggestion.bettingRoundComplete }, {
    street: 'preflop', player: 'villain', action: 'call', callAmountBb: 2, bettingRoundComplete: false,
  });
  const replay = calculateActionState(actions, positions, { smallBlindBb: 0.5, bigBlindBb: 1 }, stacks, suggestion.street);
  assert.equal(replay.streetContributions.villain, 1);
  assert.equal(replay.amountToCall.villain, 2);
});

test('BTN raise and BB call close preflop; one next Add Action is BB check on flop', () => {
  const actions = [action('preflop', 'hero', 'raise', 3), action('preflop', 'villain', 'call')];
  const suggestion = suggestNextAction(actions, positions, { smallBlindBb: 0.5, bigBlindBb: 1 }, stacks);
  assert.deepEqual({ street: suggestion.street, player: suggestion.player, action: suggestion.defaultAction, callAmountBb: suggestion.callAmountBb, bettingRoundComplete: suggestion.bettingRoundComplete, advancedStreet: suggestion.advancedStreet }, {
    street: 'flop', player: 'villain', action: 'check', callAmountBb: 0, bettingRoundComplete: true, advancedStreet: true,
  });
});

test('A: Villain check, Hero bet 5 suggests Villain call 5 on flop', () => {
  const suggestion = suggestNextAction([action('flop', 'villain', 'check'), action('flop', 'hero', 'bet', 5)], positions, blinds, stacks);
  assert.deepEqual([suggestion.street, suggestion.player, suggestion.defaultAction, suggestion.callAmountBb, suggestion.bettingRoundComplete], ['flop', 'villain', 'call', 5, false]);
});

test('B: bet/call on flop closes it and advances one street with BB first', () => {
  const suggestion = suggestNextAction([action('flop', 'villain', 'check'), action('flop', 'hero', 'bet', 5), action('flop', 'villain', 'call')], positions, blinds, stacks);
  assert.deepEqual([suggestion.street, suggestion.player, suggestion.defaultAction, suggestion.advancedStreet], ['turn', 'villain', 'check', true]);
});

test('C: bet/raise leaves Hero owing 10 on the flop', () => {
  const suggestion = suggestNextAction([action('flop', 'hero', 'bet', 5), action('flop', 'villain', 'raise', 15)], positions, blinds, stacks);
  assert.deepEqual([suggestion.street, suggestion.player, suggestion.defaultAction, suggestion.callAmountBb, suggestion.bettingRoundComplete], ['flop', 'hero', 'call', 10, false]);
});

test('D: bet/raise/call advances exactly one street', () => {
  const actions = [action('flop', 'hero', 'bet', 5), action('flop', 'villain', 'raise', 15), action('flop', 'hero', 'call')];
  const suggestion = suggestNextAction(actions, positions, blinds, stacks);
  assert.deepEqual([suggestion.street, suggestion.player, suggestion.defaultAction, suggestion.advancedStreet], ['turn', 'villain', 'check', true]);
});

test('E: check/check advances exactly one street', () => {
  const suggestion = suggestNextAction([action('flop', 'villain', 'check'), action('flop', 'hero', 'check')], positions, blinds, stacks);
  assert.deepEqual([suggestion.street, suggestion.player, suggestion.defaultAction, suggestion.advancedStreet], ['turn', 'villain', 'check', true]);
});

test('F: fold finishes the hand and disables another action', () => {
  const suggestion = suggestNextAction([action('flop', 'hero', 'bet', 5), action('flop', 'villain', 'fold')], positions, blinds, stacks);
  assert.equal(suggestion.player, null);
  assert.equal(suggestion.reason, 'fold');
});

test('G: short stack facing 20 defaults to an all-in call for 12', () => {
  const suggestion = suggestNextAction([action('flop', 'villain', 'bet', 20)], positions, blinds, { hero: 12, villain: 100 });
  assert.deepEqual([suggestion.player, suggestion.defaultAction, suggestion.callAmountBb, suggestion.callIsAllIn], ['hero', 'call', 12, true]);
});

test('H: both players all-in disables further actions', () => {
  const suggestion = suggestNextAction([action('flop', 'villain', 'bet', 20), action('flop', 'hero', 'call')], positions, blinds, { hero: 20, villain: 20 });
  assert.equal(suggestion.player, null);
  assert.equal(suggestion.reason, 'all-in');
});

test('I: street advancement is explicit and cannot skip from preflop to river', () => {
  assert.equal(getNextStreet('preflop'), 'flop');
  assert.equal(getNextStreet('flop'), 'turn');
  assert.equal(getNextStreet('turn'), 'river');
  assert.equal(getNextStreet('river'), null);
});

test('J: no outstanding wager can default to Check', () => {
  const suggestion = suggestNextAction([action('turn', 'villain', 'bet', 20)], positions, blinds, stacks);
  assert.ok(suggestion.callAmountBb > 0);
  assert.notEqual(suggestion.defaultAction, 'check');
});

test('one player already all-in is skipped when selecting the next actor', () => {
  const suggestion = suggestNextAction([], { hero: 'SB', villain: 'BB' }, { smallBlindBb: 0.5, bigBlindBb: 1 }, { hero: 0.4, villain: 100 });
  assert.deepEqual([suggestion.player, suggestion.defaultAction], ['villain', 'check']);
});

test('preflop blind and BB check option are retained after a limp', () => {
  const positions = { hero: 'SB', villain: 'BB' };
  const blindConfig = { smallBlindBb: 0.5, bigBlindBb: 1 };
  const first = suggestNextAction([], positions, blindConfig, stacks);
  assert.deepEqual([first.player, first.street, first.defaultAction, first.callAmountBb], ['hero', 'preflop', 'call', 0.5]);
  const bbOption = suggestNextAction([action('preflop', 'hero', 'call')], positions, blindConfig, stacks);
  assert.deepEqual([bbOption.player, bbOption.street, bbOption.defaultAction, bbOption.bettingRoundComplete], ['villain', 'preflop', 'check', false]);
  const afterCheck = suggestNextAction([action('preflop', 'hero', 'call'), action('preflop', 'villain', 'check')], positions, blindConfig, stacks);
  assert.deepEqual([afterCheck.street, afterCheck.player, afterCheck.defaultAction], ['flop', 'hero', 'check']);
});

test('a short all-in preflop call still leaves the big blind its check option', () => {
  const positions = { hero: 'BTN', villain: 'BB' };
  const blindConfig = { smallBlindBb: 0.5, bigBlindBb: 1 };
  const shortAllIn = [action('preflop', 'hero', 'all_in')];
  const bbSuggestion = suggestNextAction(shortAllIn, positions, blindConfig, { hero: 0.4, villain: 100 });
  assert.deepEqual([bbSuggestion.street, bbSuggestion.player, bbSuggestion.defaultAction, bbSuggestion.bettingRoundComplete], ['preflop', 'villain', 'check', false]);
  const afterCheck = suggestNextAction([...shortAllIn, action('preflop', 'villain', 'check')], positions, blindConfig, { hero: 0.4, villain: 100 });
  assert.equal(afterCheck.street, 'flop');
});

test('manual action, position, blind, and stack edits replay from scratch', () => {
  const oldState = suggestNextAction([action('flop', 'hero', 'bet', 5)], positions, blinds, stacks);
  assert.deepEqual([oldState.player, oldState.callAmountBb], ['villain', 5]);
  const editedAction = suggestNextAction([action('flop', 'villain', 'bet', 7)], positions, blinds, { hero: 5, villain: 100 });
  assert.deepEqual([editedAction.player, editedAction.defaultAction, editedAction.callAmountBb, editedAction.callIsAllIn], ['hero', 'call', 5, true]);
  const editedBlinds = suggestNextAction([action('preflop', 'hero', 'raise', 3)], positions, { smallBlindBb: 0.5, bigBlindBb: 2 }, stacks);
  assert.equal(editedBlinds.callAmountBb, 1);
  const editedPositions = suggestNextAction([], { hero: 'BB', villain: 'BTN' }, { smallBlindBb: 0.5, bigBlindBb: 1 }, stacks);
  assert.deepEqual([editedPositions.player, editedPositions.defaultAction], ['villain', 'call']);
  const deletedLastAction = suggestNextAction([], positions, { smallBlindBb: 0.5, bigBlindBb: 1 }, stacks);
  assert.deepEqual([deletedLastAction.street, deletedLastAction.player], ['preflop', 'hero']);
});

test('default calls replay through the existing state engine and recalculate pot', () => {
  const actions = [action('flop', 'hero', 'bet', 10)];
  const suggestion = suggestNextAction(actions, positions, blinds, stacks);
  actions.push(action(suggestion.street, suggestion.player, suggestion.defaultAction));
  const state = calculateActionState(actions, positions, blinds, stacks, suggestion.street);
  assert.equal(state.potBb, 20);
  assert.equal(state.amountToCall.hero, 0);
  assert.equal(suggestNextAction(actions, positions, blinds, stacks).street, 'turn');
});

test('legal action choices track the replayed wager state', () => {
  const facingRaise = calculateActionState([action('preflop', 'hero', 'raise', 3)], positions, { smallBlindBb: 0.5, bigBlindBb: 1 }, stacks, 'preflop');
  const facing = getLegalActions(facingRaise, 'villain');
  assert.ok(facing.includes('call') && facing.includes('fold') && facing.includes('raise'));
  assert.ok(!facing.includes('check') && !facing.includes('bet'));

  const noWager = calculateActionState([], positions, blinds, stacks, 'flop');
  const freeAction = getLegalActions(noWager, 'hero');
  assert.ok(freeAction.includes('check') && freeAction.includes('bet'));
  assert.ok(!freeAction.includes('call') && !freeAction.includes('raise'));

  const bbOption = calculateActionState([action('preflop', 'hero', 'call')], { hero: 'SB', villain: 'BB' }, { smallBlindBb: 0.5, bigBlindBb: 1 }, stacks, 'preflop');
  const bbChoices = getLegalActions(bbOption, 'villain');
  assert.ok(bbChoices.includes('check') && bbChoices.includes('raise'));
  assert.ok(!bbChoices.includes('call') && !bbChoices.includes('bet'));
});

test('smart-action messages are localized in PL/EN', () => {
  assert.equal(translate('pl', 'handComplete'), 'Brak dalszych akcji — rozdanie zakończone.');
  assert.equal(translate('en', 'handComplete'), 'No further actions — hand is complete.');
  assert.match(translate('pl', 'roundCompleteAdvance', { street: 'Flop' }), /Następna akcja: Flop/);
  assert.match(translate('en', 'roundCompleteAdvance', { street: 'Flop' }), /Next action: Flop/);
});
