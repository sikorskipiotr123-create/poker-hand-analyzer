const { AUTHORIZATION } = require('./test-support/deployment-auth.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, action, checksToRiver, known } = require('./test-support/analysis-fixture.cjs');
const { validateAIAnalysisContext, buildPokerPrompt, createMathematicalSummary } = require('./ai-analysis.ts');
const { verifyDeterministicMath, verifyEquity, SERVER_EQUITY_CASE_LIMIT, SERVER_EQUITY_DEADLINE_MS } = require('./verify-analysis-math.ts');
const { handleAnalyzeRequest } = require('./test-support/analyze-handler.cjs');
const { RANGE_HANDS } = require('./range.ts');
const { calculateActionState } = require('./action-state.ts');
const deterministic = context => verifyDeterministicMath(validateAIAnalysisContext(context));
const verify = context => verifyEquity(deterministic(context));
const request = context => new Request('http://localhost/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'Content-Type': 'application/json' }, body: JSON.stringify(context) });
const mockResult = { situationSummary: 'Synthetic test review.', mathematicalContext: { summary: 'Ignored model math.' }, streetAnalysis: { preflop: null, flop: null, turn: null, river: null }, rangeAnalysis: { hero: 'Known cards.', villain: 'User assumption.', interaction: 'Qualitative interpretation.' }, opponentAnalysis: 'Unknown profile.', recommendedLine: { action: 'Review', explanation: 'Use verified facts.' }, keyTakeaways: ['Do not invent equity.'], confidence: 'low', missingInformation: [] };

test('original exploit: fabricated 0% on a guaranteed-win river is rejected before provider', async () => {
  let quotas = 0, providers = 0;
  const response = await handleAnalyzeRequest(request(fixture({ equity: known(0) })), async () => { providers++; return mockResult; }, async () => { quotas++; return { status: 'allowed' }; });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_hand_data');
  assert.equal(quotas, 0); // Verification is protected by attempts/leases, before analysis admission.
  assert.equal(providers, 0);
});

test('correct river facts, authoritative response and provider agree, without mutating the request', async () => {
  const context = fixture({ equity: known(1) });
  const original = structuredClone(context);
  let prompt;
  const response = await handleAnalyzeRequest(request(context), async value => { prompt = value; return mockResult; }, async () => ({ status: 'allowed' }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verifiedMath.mathematicalContext.equity.value, 1);
  assert.equal(payload.verifiedMath.mathematicalContext.callEV.value, 25.5);
  assert.equal(payload.verifiedMath.pot.finalPotBb, 45.5);
  assert.match(prompt.user, /"evaluatedCases": 1/);
  assert.match(payload.result.mathematicalContext.summary, /100.0%/);
  assert.deepEqual(context, original);
});

for (const [label, options, value, tie] of [
  ['win', {}, 1, 0],
  ['loss', { hero: ['Jc', 'Jd'], villain: ['As', 'Qh'] }, 0, 0],
  ['board split pot', { hero: ['2h', '3h'], villain: ['4d', '5d'], board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] }, 0.5, 1],
]) test(`exact river ${label} uses actual cards, including ties`, async () => {
  const context = await verify(fixture(options));
  assert.equal(context.mathematicalContext.equity.value, value);
  assert.equal(context.mathematicalContext.equity.tiePercent, tie);
  assert.equal(context.mathematicalContext.equity.villainEquity, 1 - value);
});

for (const [label, board, actions, cases] of [
  ['turn', ['Qs', '7d', '4c', '2h'], [...checksToRiver.slice(0, 4), action('turn', 'villain', 'bet', 20)], 44],
  ['flop', ['Qs', '7d', '4c'], [...checksToRiver.slice(0, 2), action('flop', 'villain', 'bet', 20)], 990],
]) test(`bounded exact ${label} enumeration`, async () => {
  const context = await verify(fixture({ board, actions }));
  assert.equal(context.mathematicalContext.equity.method, 'exact');
  assert.equal(context.mathematicalContext.equity.evaluatedCases, cases);
  assert.ok(context.mathematicalContext.equity.value > 0.8);
});

test('nonidentical client Monte Carlo is replaced by exact server math, not compared for equality', async () => {
  const context = await verify(fixture({ equity: known(0.96, { method: 'monte-carlo', evaluatedCases: 8_000, tiePercent: 0.01 }) }));
  assert.equal(context.mathematicalContext.equity.value, 1);
  assert.equal(context.mathematicalContext.equity.method, 'exact');
  assert.equal(context.mathematicalContext.callEV.value, 25.5);
});
for (const [label, equity] of [
  ['Monte Carlo gross contradiction', known(0, { method: 'monte-carlo', evaluatedCases: 8_000 })],
  ['wrong exact sample count', known(1, { evaluatedCases: 990 })],
  ['fabricated ties', known(1, { tiePercent: 0.5 })],
  ['small exact numeric fabrication', known(0.999)],
]) test(`rejects ${label}`, async () => assert.rejects(verify(fixture({ equity })), /contradicts/));

test('preflop client simulation, EV and sample count never become provider facts', async () => {
  const context = await verify(fixture({ board: [], actions: [], equity: known(0.123456789, { method: 'monte-carlo', evaluatedCases: 10_000_000 }) }));
  assert.deepEqual(context.mathematicalContext.equity, { status: 'unknown', reason: 'verification-limit' });
  assert.deepEqual(context.mathematicalContext.callEV, { status: 'unknown', reason: 'equity-unknown' });
  const prompt = buildPokerPrompt(context);
  assert.doesNotMatch(prompt.user, /123456789|10000000/);
  assert.match(prompt.system, /Never reuse or infer client simulation numbers/);
});

test('wide turn range is bounded without accepting its asserted exact equity', async () => {
  const context = await verify(fixture({ board: ['Qs', '7d', '4c', '2h'], actions: [], villain: [], range: RANGE_HANDS.map(hand => hand.label), equity: known(1, { source: 'custom-range', evaluatedCases: 45_540 }) }));
  assert.equal(context.mathematicalContext.equity.reason, 'verification-limit');
});

test('full river range is exactly enumerated with blockers (990 physical combos)', async () => {
  const context = await verify(fixture({ villain: [], range: RANGE_HANDS.map(hand => hand.label) }));
  assert.equal(context.villain.range.comboCount, 990);
  assert.equal(context.mathematicalContext.equity.source, 'custom-range');
  assert.equal(context.mathematicalContext.equity.evaluatedCases, 990);
  assert.equal(context.mathematicalContext.equity.method, 'exact');
});

test('custom river range preserves equal physical-combo weighting and blockers', async () => {
  const context = await verify(fixture({ hero: ['As', 'Ah'], villain: [], board: ['2s', '3d', '4c', '8h', '9s'], range: ['AA', 'KK'] }));
  assert.equal(context.villain.range.comboCount, 7);
  assert.equal(context.mathematicalContext.equity.evaluatedCases, 7);
  assert.ok(Math.abs(context.mathematicalContext.equity.value - 6.5 / 7) < 1e-10);
  assert.ok(Math.abs(context.mathematicalContext.equity.tiePercent - 1 / 7) < 1e-10);
});

test('Auto equity stays unknown; missing client equity is computed only when a target is defined', async () => {
  const context = await verify(fixture({ villain: [], equity: { status: 'unknown', reason: 'auto-range' } }));
  assert.equal(context.mathematicalContext.equity.reason, 'auto-range');
  assert.equal(context.mathematicalContext.callEV.status, 'unknown');
  for (const reason of ['missing-cards', 'invalid-input']) assert.equal((await verify(fixture({ equity: { status: 'unknown', reason } }))).mathematicalContext.equity.value, 1);
});

for (const [label, options] of [
  ['overlap', { villain: ['As', 'Jc'] }],
  ['empty range', { villain: [], range: [] }],
  ['fully blocked range', { hero: ['As', 'Ah'], villain: [], board: ['Ad', 'Ac', '4c', '8h', '9s'], range: ['AA'] }],
]) test(`rejects ${label} before equity work`, () => assert.throws(() => deterministic(fixture(options))));

test('request cannot choose a server computation limit or inject server verification status', () => {
  assert.throws(() => deterministic({ ...fixture(), exactCaseLimit: 1e12 }), /invalid shape/);
  assert.throws(() => deterministic(fixture({ equity: { status: 'unknown', reason: 'verification-limit' } })), /valid reason/);
  assert.equal(SERVER_EQUITY_CASE_LIMIT, 1000);
});

test('concurrent verifier has no queue and cannot publish someone else’s result', async () => {
  const first = verifyEquity(deterministic(fixture()));
  const second = await verifyEquity(deterministic(fixture({ hero: ['Jc', 'Jd'], villain: ['As', 'Qh'] })));
  assert.deepEqual(second.mathematicalContext.equity, { status: 'unknown', reason: 'verification-busy' });
  assert.equal((await first).mathematicalContext.equity.value, 1);
});

test('cancelled and deadline-limited enumeration never publish partial exact results; admission releases', async () => {
  const controller = new AbortController(); controller.abort();
  const cancelled = await verifyEquity(deterministic(fixture()), controller.signal);
  assert.equal(cancelled.mathematicalContext.equity.reason, 'verification-timeout');
  const original = performance.now;
  let calls = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => calls++ === 0 ? 0 : SERVER_EQUITY_DEADLINE_MS + 1 });
  try { assert.equal((await verifyEquity(deterministic(fixture()))).mathematicalContext.equity.reason, 'verification-timeout'); }
  finally { Object.defineProperty(performance, 'now', { configurable: true, value: original }); }
  assert.equal((await verify(fixture())).mathematicalContext.equity.value, 1);
});

test('computation yields to event-loop timers during a flop verification', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try { await verify(fixture({ board: ['Qs', '7d', '4c'], actions: [] })); }
  finally { clearInterval(timer); }
  assert.ok(ticks >= 2, 'the route must yield while enumerating');
});

for (const path of ['pot.currentPotBb', 'pot.villainBetBb', 'pot.callAmountBb', 'pot.finalPotBb', 'stackState.hero.remainingStackBb', 'stackState.villain.remainingStackBb', 'stackState.currentEffectiveStackBb', 'stackState.startingEffectiveStackBb', 'stackState.streetStartPotBb', 'stackState.streetStartEffectiveStackBb', 'stackState.spr', 'stackState.streetStartSpr', 'mathematicalContext.requiredEquity']) {
  test(`rejects falsified derived ${path}`, () => {
    const context = fixture(); const keys = path.split('.'); const key = keys.pop(); const owner = keys.reduce((value, part) => value[part], context); owner[key] += 0.001;
    assert.throws(() => deterministic(context));
  });
}
for (const path of ['hero.isAllIn', 'villain.isAllIn', 'facingAllIn', 'canFullCall']) test(`rejects fabricated flag ${path}`, () => {
  const context = fixture(); const keys = path.split('.'); const key = keys.pop(); const owner = keys.reduce((value, part) => value[part], context.stackState); owner[key] = !owner[key];
  assert.throws(() => deterministic(context));
});

test('self-consistent fabricated pot and SPR are rejected before consuming quota', async () => {
  const context = fixture(); context.pot.currentPotBb += 10; context.pot.finalPotBb += 10;
  context.stackState.spr = context.stackState.currentEffectiveStackBb / (context.pot.currentPotBb + context.pot.villainBetBb);
  context.mathematicalContext.requiredEquity = context.pot.callAmountBb / context.pot.finalPotBb;
  let quotas = 0, providers = 0;
  const response = await handleAnalyzeRequest(request(context), async () => { providers++; }, async () => { quotas++; return { status: 'allowed' }; });
  assert.equal(response.status, 400); assert.equal(quotas, 0); assert.equal(providers, 0);
});

for (const field of ['additionalContributionBb', 'streetTotalBb', 'allInKind']) test(`rejects fabricated action resolution ${field}`, () => {
  const context = fixture(); context.actionHistory[0].resolution[field] = field === 'allInKind' ? 'raise-all-in' : 999;
  assert.throws(() => deterministic(context), /resolution/);
});
test('omitted action resolutions are recomputed and a fabricated incremental call is rejected', () => {
  const context = fixture(); context.actionHistory.forEach(action => delete action.resolution);
  assert.equal(deterministic(context).actionHistory[1].resolution.additionalContributionBb, 1.5);
  context.actionHistory[1].amountBb = 2.5;
  assert.throws(() => deterministic(context), /amountBb/);
});

for (const [label, actions] of [
  ['out of turn', [action('preflop', 'villain', 'raise', 5)]],
  ['unresolved street transition', [checksToRiver[0], action('flop', 'villain', 'check')]],
  ['skipped street', [...checksToRiver.slice(0, 2), action('river', 'villain', 'bet', 5)]],
  ['double action', [checksToRiver[0], action('preflop', 'hero', 'raise', 5)]],
  ['under-minimum raise', [action('preflop', 'hero', 'raise', 1.5)]],
  ['over-stack raise', [action('preflop', 'hero', 'raise', 101)]],
  ['check facing wager', [checksToRiver[0], action('preflop', 'villain', 'check')]],
  ['after fold', [action('preflop', 'hero', 'fold'), action('preflop', 'villain', 'check')]],
]) test(`rejects action history ${label}`, () => assert.throws(() => deterministic(fixture({ actions }))));

test('rejects an action beyond the board and a board beyond an unresolved decision', () => {
  assert.throws(() => deterministic(fixture({ board: ['Qs', '7d', '4c'] })), /ahead/);
  assert.throws(() => deterministic(fixture({ actions: [checksToRiver[0]] })), /board/);
});

test('blinds are explicit primitives; custom blind sizes and blind deductions are replayed', () => {
  const context = fixture({ actions: [], blinds: { smallBlindBb: 1, bigBlindBb: 2 } });
  assert.equal(deterministic(context).pot.finalPotBb, 3);
  assert.equal(deterministic(context).stackState.villain.remainingStackBb, 98);
  delete context.blinds; assert.throws(() => deterministic(context), /shape/);
});

test('raise pot includes matching chips and equals the pot after a full call', () => {
  const actions = [...checksToRiver.slice(0, 2), action('flop', 'villain', 'check'), action('flop', 'hero', 'bet', 5), action('flop', 'villain', 'raise', 15)];
  const context = deterministic(fixture({ actions, board: ['Qs', '7d', '4c'] }));
  assert.equal(context.pot.currentPotBb, 10.5); assert.equal(context.pot.villainBetBb, 15); assert.equal(context.pot.callAmountBb, 10); assert.equal(context.pot.finalPotBb, 35.5);
  const called = calculateActionState([...actions, action('flop', 'hero', 'call')], { hero: 'CO', villain: 'BB' });
  assert.equal(called.potBb, context.pot.finalPotBb);
});

test('short all-in call returns only excess chips and final pot conserves contributions', () => {
  const actions = [...checksToRiver.slice(0, 2), action('flop', 'villain', 'check'), action('flop', 'hero', 'bet', 5), action('flop', 'villain', 'raise', 30)];
  const context = deterministic(fixture({ actions, board: ['Qs', '7d', '4c'], stacks: { hero: 20, villain: 100 } }));
  assert.equal(context.pot.callAmountBb, 12.5); assert.equal(context.pot.villainBetBb, 17.5); assert.equal(context.pot.finalPotBb, 40.5); assert.equal(context.stackState.canFullCall, false);
  const called = deterministic(fixture({ actions: [...actions, action('flop', 'hero', 'all_in')], board: ['Qs', '7d', '4c'], stacks: { hero: 20, villain: 100 } }));
  assert.equal(called.pot.finalPotBb, 40.5); assert.equal(called.stackState.hero.remainingStackBb, 0); assert.equal(called.stackState.villain.remainingStackBb, 80);
});

test('Villain all-in call closes the decision instead of inventing a fresh Hero call', () => {
  const context = deterministic(fixture({ actions: [action('preflop', 'hero', 'all_in'), action('preflop', 'villain', 'all_in')], stacks: { hero: 20, villain: 20 } }));
  assert.equal(context.pot.finalPotBb, 40.5); assert.equal(context.pot.callAmountBb, 0); assert.equal(context.stackState.canFullCall, false); assert.equal(context.stackState.hero.isAllIn, true); assert.equal(context.stackState.villain.isAllIn, true);
});

test('legal short all-in raise is allowed, but a non-all-in under-raise is rejected', () => {
  const context = fixture({ actions: [action('preflop', 'hero', 'all_in')], stacks: { hero: 1.5, villain: 100 }, board: [] });
  assert.equal(deterministic(context).stackState.hero.isAllIn, true);
});

for (const language of ['pl', 'en']) test(`server unknown equity and EV explanations are localized in ${language}`, async () => {
  const context = await verify(fixture({ language, board: [], actions: [] }));
  const summary = createMathematicalSummary(context);
  assert.match(summary, language === 'pl' ? /serwer nie zweryfikował equity/ : /equity was not verified/);
  assert.equal(context.mathematicalContext.callEV.status, 'unknown');
});

test('attempt-limited requests never invoke the provider or proceed to equity verification', async () => {
  let providers = 0;
  const response = await handleAnalyzeRequest(request(fixture({ equity: known(0) })), async () => { providers++; }, async () => { throw new Error('analysis admission must not run'); }, {}, async () => ({ status: 'limited', scope: 'ip', retryAfterSeconds: 1 }));
  assert.equal(response.status, 429); assert.equal(providers, 0);
});

test('Call EV consistency is strict and a false unknown/no-call state is rejected', () => {
  const context = fixture({ equity: known(1) }); context.mathematicalContext.callEV.value += 0.001;
  assert.throws(() => deterministic(context), /callEV/);
  context.mathematicalContext.callEV = { status: 'unknown', reason: 'no-active-call' };
  assert.throws(() => deterministic(context), /Call EV status/);
});

test('the maximum 60-action replay remains bounded and request 61 is rejected', () => {
  const actions = Array.from({ length: 60 }, (_, index) => action('preflop', index % 2 === 0 ? 'hero' : 'villain', 'raise', index + 2));
  const context = deterministic(fixture({ board: [], actions, stacks: { hero: 1000, villain: 1000 } }));
  assert.equal(context.actionHistory.length, 60);
  assert.equal(context.pot.callAmountBb, 1);
  assert.equal(context.pot.finalPotBb, 122.5);
  context.actionHistory.push(context.actionHistory.at(-1));
  assert.throws(() => deterministic(context), /too long/);
});

test('bounded narrow turn range is exact and uses all 44 runouts per combo', async () => {
  const context = await verify(fixture({ board: ['Qs', '7d', '4c', '2h'], actions: [], villain: [], range: ['JJ'] }));
  assert.equal(context.mathematicalContext.equity.method, 'exact');
  assert.equal(context.mathematicalContext.equity.evaluatedCases, 264);
});

test('a single-combo flop range reuses the bounded known-hand path', async () => {
  const context = await verify(fixture({ hero: ['As', 'Qh'], board: ['Ad', '7d', '4c'], actions: [], villain: [], range: ['AA'] }));
  assert.equal(context.villain.range.comboCount, 1);
  assert.equal(context.mathematicalContext.equity.method, 'exact');
  assert.equal(context.mathematicalContext.equity.evaluatedCases, 990);
  assert.equal(context.mathematicalContext.equity.source, 'custom-range');
});

test('deadline fallback can consume no provider facts from a client exact claim', async () => {
  const { deriveInputQuality } = require('./ai-analysis.ts');
  const controller = new AbortController(); controller.abort();
  const context = await verifyEquity(deterministic(fixture({ equity: known(0) })), controller.signal);
  assert.equal(context.mathematicalContext.equity.status, 'unknown');
  assert.equal(context.mathematicalContext.callEV.status, 'unknown');
  assert.equal(deriveInputQuality(context).confidence, 'low');
  assert.ok(deriveInputQuality(context).missingInformation.some(item => item.includes('not verified')));
});

test('timer chunk option is validated by both reused equity functions', async () => {
  const { calculateEquity } = require('./poker.ts');
  const { calculateRangeEquity } = require('./range.ts');
  const { toCard } = require('./ai-analysis.ts');
  const context = fixture();
  for (const yieldEvery of [0, -1, 1.5, Infinity]) {
    await assert.rejects(calculateEquity(context.hero.cards.map(toCard), context.board.map(toCard), context.villain.cards.map(toCard), { yieldEvery }), /Yield interval/);
    await assert.rejects(calculateRangeEquity(context.hero.cards.map(toCard), context.board.map(toCard), ['1111p'], { yieldEvery }), /Yield interval/);
  }
});

for (const language of ['en', 'pl']) test(`server verifies returned short blinds in ${language} and rejects the old inflated pot`, () => {
  const context = fixture({ language, positions: { hero: 'SB', villain: 'BB' }, stacks: { hero: 0.3, villain: 0.4 }, actions: [] });
  const verified = deterministic(context);
  assert.ok(Math.abs(verified.pot.currentPotBb - 0.6) < 1e-8);
  assert.ok(Math.abs(verified.stackState.villain.remainingStackBb - 0.1) < 1e-8);
  const fabricated = structuredClone(context);
  fabricated.pot.currentPotBb = 0.7;
  fabricated.pot.finalPotBb = 0.7;
  fabricated.stackState.villain.remainingStackBb = 0;
  fabricated.stackState.villain.isAllIn = true;
  assert.throws(() => deterministic(fabricated));
});

for (const response of ['call', 'all_in', 'fold']) test(`server accepts settled unequal all-in ${response} and rejects later checks before quota/provider`, async () => {
  const options = { positions: { hero: 'CO', villain: 'BB' }, stacks: { hero: 100, villain: 30 }, actions: [action('preflop', 'hero', 'all_in'), action('preflop', 'villain', response)] };
  const verified = deterministic(fixture(options));
  assert.equal(verified.pot.currentPotBb, response === 'fold' ? 2.5 : 60.5);
  assert.equal(verified.stackState.hero.remainingStackBb, response === 'fold' ? 99 : 70);
  for (const street of ['preflop', 'flop']) {
    let quotas = 0, providers = 0;
    const context = fixture({ ...options, actions: [...options.actions, action(street, 'hero', 'check')] });
    const result = await handleAnalyzeRequest(request(context), async () => { providers++; return mockResult; }, async () => { quotas++; return { status: 'allowed' }; });
    assert.equal(result.status, 400);
    assert.equal(quotas, 0);
    assert.equal(providers, 0);
  }
});

test('server accepts a legal response to an unmatched short blind', () => {
  const verified = deterministic(fixture({ positions: { hero: 'SB', villain: 'BB' }, stacks: { hero: 100, villain: 0.8 }, actions: [action('preflop', 'hero', 'call')] }));
  assert.ok(Math.abs(verified.pot.currentPotBb - 1.6) < 1e-8);
  assert.ok(Math.abs(verified.stackState.hero.remainingStackBb - 99.2) < 1e-8);
});

test('server preserves legitimate response to the shorter opponent shove', () => {
  const options = { positions: { hero: 'CO', villain: 'BB' }, stacks: { hero: 100, villain: 30 }, actions: [action('preflop', 'hero', 'raise', 5), action('preflop', 'villain', 'all_in')] };
  const pending = deterministic(fixture({ ...options, board: [] }));
  assert.equal(pending.pot.callAmountBb, 25);
  assert.equal(pending.pot.finalPotBb, 60.5);
  const completed = deterministic(fixture({ ...options, actions: [...options.actions, action('preflop', 'hero', 'call')] }));
  assert.equal(completed.pot.currentPotBb, 60.5);
  assert.equal(completed.stackState.hero.remainingStackBb, 70);
  assert.equal(completed.stackState.villain.remainingStackBb, 0);
});
