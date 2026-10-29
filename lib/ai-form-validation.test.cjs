const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const compile = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
require.extensions['.ts'] = compile;
require.extensions['.tsx'] = compile;
const { translate, formatNumber, translateHandValidation } = require('./i18n.ts');
const { validateAIAnalysisContext } = require('./ai-analysis.ts');
const { verifyDeterministicMath, HandValidationError } = require('./analysis-validation.ts');
const { parseCard } = require('./poker.ts');

// Exercise the real form component and its event handlers, payload builder and validators.
// Only React hook scheduling and language context are replaced; effects are paused so these
// tests never run random equity simulations or network requests.
let active;
const react = require('react');
const load = Module._load;
Module._load = function(request, parent, ...args) {
  if (request === 'react') return { ...react, useState: initial => {
    const i = active.cursor++;
    if (!(i in active.state)) active.state[i] = initial;
    return [active.state[i], value => { active.state[i] = typeof value === 'function' ? value(active.state[i]) : value; }];
  }, useEffect: () => {} };
  if (request === './providers' && parent.filename.endsWith('/app/ai-mode.tsx')) return { useLanguage: () => ({ language: active.language, t: active.t, number: (v, n) => formatNumber(active.language, v, n) }) };
  return load.call(this, request, parent, ...args);
};
const { AIModePanel } = require('../app/ai-mode.tsx');
Module._load = load;
function nodes(root, predicate) {
  if (Array.isArray(root)) return root.flatMap(n => nodes(n, predicate));
  if (!root || typeof root !== 'object' || !root.props) return [];
  return [...(predicate(root) ? [root] : []), ...nodes(root.props.children, predicate)];
}
function text(root) {
  if (Array.isArray(root)) return root.map(text).join('');
  if (root == null || typeof root === 'boolean') return '';
  return typeof root === 'object' ? text(root.props?.children) : String(root);
}
function form(language = 'en') {
  const f = { cursor: 0, state: [], language, t: (key, values) => translate(language, key, values), props: { cards: {}, getCard: () => null, setActive: () => {}, hero: ['14s', '12h'].map(parseCard), villain: [], board: [], ready: true, duplicate: false, boardGap: false } };
  f.render = () => { active = f; f.cursor = 0; f.tree = AIModePanel(f.props); return f.tree; };
  f.find = (predicate, root = f.tree) => nodes(root, predicate)[0];
  f.rows = () => nodes(f.tree, n => n.props.className === 'ai-action-row');
  f.field = (key, root = f.tree) => f.find(n => n.type === 'label' && text(n.props.children?.[0]) === f.t(key), root);
  f.change = (key, value, root = f.tree) => { const label = f.field(key, root); assert.ok(label, key); const control = f.find(n => n.type === 'select' || n.type === 'input', label); control.props.onChange({ target: { value: String(value) } }); f.render(); };
  f.stack = (actor, value) => { const label = f.find(n => n.type === 'label' && text(n.props.children?.[0]).includes(f.t(actor) + ' · ' + f.t('startingStack'))); f.find(n => n.type === 'input', label).props.onChange({ target: { value: String(value) } }); f.render(); };
  f.edit = (index, key, value) => f.change(key, value, f.rows()[index]);
  f.amount = (index, value) => { const control = f.find(n => n.type === 'input', f.rows()[index]); assert.ok(control); control.props.onChange({ target: { value: String(value) } }); f.render(); };
  f.add = () => { const button = f.find(n => n.type === 'button' && text(n) === f.t('addAction')); assert.equal(button.props.disabled, false); button.props.onClick(); f.render(); };
  f.submit = () => f.find(n => n.props.className === 'button button-primary ai-submit');
  f.alerts = () => nodes(f.tree, n => n.props.role === 'alert').map(text).join('\n');
  f.board = cards => { f.props.board = cards.map(parseCard); f.render(); };
  f.payload = async (errorCode = 'provider_error') => {
    assert.equal(f.submit().props.disabled, false, f.alerts());
    let payload;
    const original = global.fetch;
    global.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: false, json: async () => ({ error: errorCode }) }; };
    try { await f.submit().props.onClick(); } finally { global.fetch = original; }
    f.render();
    assert.ok(payload);
    const verified = verifyDeterministicMath(validateAIAnalysisContext(payload));
    assert.deepEqual(verified.pot, payload.pot);
    assert.deepEqual(verified.stackState, payload.stackState);
    return payload;
  };
  f.render(); return f;
}
function raise(f, amount) { f.add(); f.edit(f.rows().length - 1, 'action', 'raise'); f.amount(f.rows().length - 1, amount); }
function checks(f, board) { f.board(board); f.add(); f.add(); }

for (const language of ['pl', 'en']) {
  test(`${language}: illegal preflop raise to 1.5 blocks actual submission, preserves value, then accepts correction`, async () => {
    const f = form(language); raise(f, 1.5);
    assert.equal(f.submit().props.disabled, true);
    assert.match(f.alerts(), language === 'pl' ? /Minimalny.*2,00 BB/ : /minimum.*2.00 BB/);
    assert.equal(f.find(n => n.type === 'input', f.rows()[0]).props.value, 1.5);
    let requests = 0;
    const original = global.fetch; global.fetch = async () => { requests++; throw new Error('Unexpected request'); };
    try { await f.submit().props.onClick(); } finally { global.fetch = original; }
    assert.equal(requests, 0);
    f.amount(0, 2.5);
    const payload = await f.payload(); assert.equal(payload.actionHistory[0].amountBb, 2.5);
  });
  test(`${language}: skipped street and out-of-turn edits are localized and block submission`, () => {
    const f = form(language); raise(f, 2.5); f.add();
    f.board(['12s', '7d', '4c', '2h']); f.add(); f.edit(2, 'street', 'turn');
    assert.equal(f.submit().props.disabled, true);
    assert.match(f.alerts(), language === 'pl' ? /kolejność akcji/ : /action order/);
    f.edit(2, 'street', 'flop'); assert.equal(f.submit().props.disabled, false);
    f.edit(2, 'player', 'hero'); assert.equal(f.submit().props.disabled, true);
  });
  test(`${language}: unresolved wager blocks advanced board; call corrects it without discarding cards`, async () => {
    const f = form(language); raise(f, 2.5); f.board(['12s', '7d', '4c']);
    assert.equal(f.submit().props.disabled, true);
    assert.match(f.alerts(), language === 'pl' ? /Najpierw rozstrzygnij/ : /Resolve the wager/);
    f.add(); const payload = await f.payload();
    assert.equal(payload.board.length, 3);
    assert.equal(payload.actionHistory[1].amountBb, 1.5);
  });
}

test('form-generated normal raises, calls and checks transition through all streets', async () => {
  const f = form(); raise(f, 2.5); f.add();
  checks(f, ['12s', '7d', '4c']); checks(f, ['12s', '7d', '4c', '2h']); checks(f, ['12s', '7d', '4c', '2h', '9s']);
  const payload = await f.payload();
  assert.deepEqual(payload.actionHistory.map(a => a.street), ['preflop', 'preflop', 'flop', 'flop', 'turn', 'turn', 'river', 'river']);
});
for (const response of ['call', 'all_in', 'fold']) test(`form-generated unequal all-in ${response} has the server's settled accounting`, async () => {
  const f = form(); f.stack('villain', 30); f.add(); f.edit(0, 'action', 'all_in'); f.add(); f.edit(1, 'action', response);
  const payload = await f.payload();
  assert.equal(payload.pot.currentPotBb, response === 'fold' ? 2.5 : 60.5);
  assert.equal(payload.stackState.hero.remainingStackBb, response === 'fold' ? 99 : 70);
  assert.equal(f.find(n => n.type === 'button' && text(n) === f.t('addAction')).props.disabled, true);
});

test('form-generated short blind all-ins are accepted with 0.1 BB returned', async () => {
  const f = form(); f.change('heroPosition', 'SB'); f.stack('hero', 0.3); f.stack('villain', 0.4);
  const payload = await f.payload();
  assert.ok(Math.abs(payload.pot.currentPotBb - 0.6) < 1e-8);
  assert.ok(Math.abs(payload.stackState.villain.remainingStackBb - 0.1) < 1e-8);
});

test('form blocks actions ahead of board, oversized stacks and excessive wagers', () => {
  const f = form(); raise(f, 2.5); f.add(); f.add();
  assert.equal(f.submit().props.disabled, true);
  assert.match(f.alerts(), /board cards/);
  f.board(['12s', '7d', '4c']); assert.equal(f.submit().props.disabled, false);
  f.stack('hero', 1000001); assert.equal(f.submit().props.disabled, true);
  f.stack('hero', 100); f.edit(2, 'action', 'bet'); f.amount(2, 200);
  assert.equal(f.submit().props.disabled, true);
});

test('retry also becomes disabled after the hand is edited to an illegal raise', async () => {
  const f = form(); raise(f, 2.5); await f.payload(); f.amount(0, 1.5);
  const retry = f.find(n => n.type === 'button' && text(n) === f.t('retry'));
  assert.equal(retry.props.disabled, true);
  assert.equal(f.submit().props.disabled, true);
});

for (const code of ['sequence', 'boardBehind', 'wager', 'amount', 'notReopened', 'minimumRaise', 'unresolvedBoard', 'facts', 'input']) test(`shared ${code} validation has Polish and English messages`, () => {
  const issue = new HandValidationError(code, 0, undefined, 2);
  const pl = translateHandValidation(issue, 'pl', (key, values) => translate('pl', key, values));
  const en = translateHandValidation(issue, 'en', (key, values) => translate('en', key, values));
  assert.ok(pl.length > 15 && en.length > 15);
  assert.notEqual(pl, en);
  assert.ok(!pl.includes('{{') && !en.includes('{{'));
});

test('a legal short all-in raise below the usual minimum remains accepted', async () => {
  const f = form(); f.stack('hero', 1.5); raise(f, 1.5);
  assert.equal(f.submit().props.disabled, false, f.alerts());
  f.add(); const payload = await f.payload();
  assert.equal(payload.actionHistory[0].resolution.allInKind, 'raise-all-in');
  assert.equal(payload.pot.currentPotBb, 3.5);
});

test('form edits cannot leave actions after a fold or matched all-in', () => {
  const f = form(); raise(f, 2.5); f.add(); f.board(['12s', '7d', '4c']); f.add();
  f.edit(0, 'action', 'fold'); assert.equal(f.submit().props.disabled, true);
  assert.equal(f.rows().length, 3); // Preserve the entered history for correction.
  f.edit(0, 'action', 'raise'); f.amount(0, 2.5); assert.equal(f.submit().props.disabled, false);
  f.stack('hero', 2.5); assert.equal(f.submit().props.disabled, true);
});

for (const [code, key] of [['ip_daily_limit_reached', 'errorIPDailyLimitReached'], ['daily_limit_reached', 'errorDailyLimitReached'], ['ai_disabled', 'errorAIDisabled'], ['ai_busy', 'errorAIBusy'], ['ai_concurrency_unavailable', 'errorAIConcurrencyUnavailable'], ['ai_limits_configuration_error', 'errorAILimitsConfiguration']]) {
  for (const language of ['pl', 'en']) test(`${language}: actual AI form localizes ${code}`, async () => {
    const f = form(language); await f.payload(code); assert.ok(f.alerts().includes(f.t(key)));
  });
}
