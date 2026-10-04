const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { validateAIAnalysisContext, buildPokerPrompt, deriveInputQuality, createMathematicalSummary, MAX_ANALYSIS_BODY_BYTES } = require('./ai-analysis.ts');
const { validateAIAnalysisResult, AI_ANALYSIS_JSON_SCHEMA } = require('./ai-response.ts');
const { handleAnalyzeRequest } = require('./analyze-handler.ts');
const { AnalysisServiceError, requestOpenAIAnalysis } = require('./ai-provider.ts');
const { getRangeSummary, RANGE_HANDS } = require('./range.ts');
const rangeKey = (label) => RANGE_HANDS.find((hand) => hand.label === label).key;
const parseCard = (key) => ({ rank: ({ A: 14, K: 13, Q: 12, J: 11, T: 10 }[key[0]] ?? Number(key[0])), suit: key[1] });

const base = {
  language: 'en',
  hero: { cards: ['As', 'Qh'], position: 'CO', range: { mode: 'auto' } },
  villain: { cards: ['Jc', 'Jd'], position: 'BB', profile: 'unknown', stats: { vpip: null, pfr: null, threeBet: null, aggressionFactor: null }, range: { mode: 'auto' } },
  board: ['Qs', '7d', '4c', '2h', '9s'],
  actionHistory: [
    { street: 'preflop', actor: 'hero', action: 'raise', amountBb: 2.5, position: 'CO' },
    { street: 'preflop', actor: 'villain', action: 'call', amountBb: 2.5, position: 'BB' },
    { street: 'flop', actor: 'villain', action: 'check', amountBb: null, position: 'BB' },
    { street: 'flop', actor: 'hero', action: 'bet', amountBb: 5, position: 'CO' },
  ],
  pot: { currentPotBb: 50, villainBetBb: 20, callAmountBb: 20, finalPotBb: 90 },
  stackState: { hero: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, villain: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, startingEffectiveStackBb: 100, currentEffectiveStackBb: 80, spr: 80 / 70, streetStartPotBb: 0, streetStartEffectiveStackBb: null, streetStartSpr: null, facingAllIn: false, canFullCall: true },
  mathematicalContext: { equity: { status: 'known', value: 0.542, source: 'known-hand', villainEquity: 0.458, tiePercent: 0.058, method: 'exact', evaluatedCases: 990 }, requiredEquity: 20 / 90, callEV: { status: 'known', value: 28.78 } },
};
const result = {
  situationSummary: 'Top pair faces a river bet on a relatively dry board.',
  mathematicalContext: { summary: 'Model must not author this fact.' },
  streetAnalysis: {
    preflop: { assessment: 'Reasonable open', explanation: 'The CO can open a broad range.' },
    flop: { assessment: 'Thin value', explanation: 'The bet can get value from weaker pairs.' },
    turn: { assessment: 'Pot control', explanation: 'No turn action was supplied.' },
    river: { assessment: 'Close decision', explanation: 'Compare the engine equity to the required equity.' },
  },
  rangeAnalysis: { hero: 'The actual hand is a pair of queens.', villain: 'Villain range is estimated.', interaction: 'The board favors neither range clearly.' },
  opponentAnalysis: 'With an unknown profile, avoid strong exploitative assumptions.',
  recommendedLine: { action: 'Call if the supplied equity remains above the threshold', explanation: 'This is a strategic interpretation, not solver output.' },
  keyTakeaways: ['Use the supplied math as the decision baseline.'],
  confidence: 'high',
  missingInformation: [],
};
const request = (context = base, headers = {}) => new Request('http://localhost/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(context) });

test('API context validator accepts the typed analysis contract', () => {
  assert.deepEqual(validateAIAnalysisContext(base), base);
});

test('API context requires a supported Polish or English language code', () => {
  assert.equal(validateAIAnalysisContext({ ...base, language: 'en' }).language, 'en');
  assert.throws(() => validateAIAnalysisContext({ ...base, language: 'fr' }), /language must be pl or en/);
  const { language: _language, ...withoutLanguage } = base;
  assert.throws(() => validateAIAnalysisContext(withoutLanguage), /invalid shape/);
});
test('API context rejects malformed shapes, duplicate/impossible cards, and invalid board counts', () => {
  assert.throws(() => validateAIAnalysisContext({ ...base, extra: true }), /invalid shape/);
  assert.throws(() => validateAIAnalysisContext({ ...base, villain: { ...base.villain, cards: ['As', 'Kd'] } }), /more than once/);
  assert.throws(() => validateAIAnalysisContext({ ...base, board: ['2c', '3d'] }), /malformed/);
  assert.throws(() => validateAIAnalysisContext({ ...base, board: ['As', '3d', '4h'] }), /more than once/);
});
test('positions, profiles, HUD stats, action histories, and pot amounts are validated', () => {
  assert.throws(() => validateAIAnalysisContext({ ...base, hero: { ...base.hero, position: 'BTN+' } }), /position is invalid/);
  assert.throws(() => validateAIAnalysisContext({ ...base, villain: { ...base.villain, profile: 'shark' } }), /profile is invalid/);
  assert.throws(() => validateAIAnalysisContext({ ...base, villain: { ...base.villain, profile: 'custom', stats: { ...base.villain.stats, vpip: 15, pfr: 20 } } }), /PFR cannot be higher/);
  assert.throws(() => validateAIAnalysisContext({ ...base, actionHistory: [{ ...base.actionHistory[0], position: 'UTG' }] }), /does not match/);
  assert.throws(() => validateAIAnalysisContext({ ...base, actionHistory: [{ ...base.actionHistory[0], amountBb: -1 }] }), /invalid street/);
  assert.throws(() => validateAIAnalysisContext({ ...base, pot: { ...base.pot, finalPotBb: 800 } }), /Final pot/);
});
test('custom Hero and Villain ranges validate hand classes, blockers, combos, and percentages', () => {
  const heroBlockers = ['Qs', '7d', '4c', '2h', '9s'].map(parseCard);
  const villainBlockers = ['As', 'Qh', 'Qs', '7d', '4c', '2h', '9s'].map(parseCard);
  const heroSummary = getRangeSummary(['AA', 'AQs'].map(rangeKey), heroBlockers);
  const villainSummary = getRangeSummary(['KK', 'AKo'].map(rangeKey), villainBlockers);
  const custom = {
    ...base,
    hero: { ...base.hero, range: { mode: 'custom', selectedHands: ['AA', 'AQs'], comboCount: heroSummary.selectedCombos, percentage: heroSummary.percentage } },
    villain: { ...base.villain, profile: 'nit', range: { mode: 'custom', selectedHands: ['KK', 'AKo'], comboCount: villainSummary.selectedCombos, percentage: villainSummary.percentage } },
  };
  assert.equal(validateAIAnalysisContext(custom).hero.range.mode, 'custom');
  assert.throws(() => validateAIAnalysisContext({ ...custom, hero: { ...custom.hero, range: { ...custom.hero.range, selectedHands: ['made-up'] } } }), /valid starting-hand/);
  assert.throws(() => validateAIAnalysisContext({ ...custom, hero: { ...custom.hero, range: { ...custom.hero.range, comboCount: 1 } } }), /count does not match/);
  assert.throws(() => validateAIAnalysisContext({ ...custom, hero: { ...custom.hero, range: { mode: 'custom', selectedHands: ['AA'], comboCount: 6, percentage: 0 } } }), /percentage does not match/);
});
test('empty and fully blocked custom ranges are rejected', () => {
  assert.throws(() => validateAIAnalysisContext({ ...base, hero: { ...base.hero, range: { mode: 'custom', selectedHands: [], comboCount: 0, percentage: 0 } } }), /valid starting-hand/);
  const blocked = { ...base, hero: { cards: ['Kh', 'Qh'], position: 'CO', range: { mode: 'custom', selectedHands: ['AA'], comboCount: 1, percentage: 1 } }, villain: { ...base.villain, cards: ['As', 'Ah'] }, board: ['Ad', 'Ac', '2c', '3d', '4h'] };
  assert.throws(() => validateAIAnalysisContext(blocked), /fully blocked/);
});
test('math inputs are bounded and pot odds and call EV must agree with the authoritative context', () => {
  assert.throws(() => validateAIAnalysisContext({ ...base, mathematicalContext: { ...base.mathematicalContext, equity: { ...base.mathematicalContext.equity, value: 1.2 } } }), /Known equity/);
  assert.throws(() => validateAIAnalysisContext({ ...base, mathematicalContext: { ...base.mathematicalContext, requiredEquity: 0.5 } }), /required equity/i);
  assert.throws(() => validateAIAnalysisContext({ ...base, mathematicalContext: { ...base.mathematicalContext, callEV: { status: 'known', value: 0 } } }), /call EV/i);
});
test('prompt separates authoritative math, user assumptions, estimates, opponent, actions, and decision point', () => {
  const context = validateAIAnalysisContext(base);
  const prompt = buildPokerPrompt(context);
  assert.match(prompt.system, /Do not recalculate, alter, approximate, or invent equity/);
  assert.match(prompt.user, /MATHEMATICAL FACTS/);
  assert.match(prompt.user, /USER-SUPPLIED ASSUMPTIONS/);
  assert.match(prompt.user, /AUTO \/ ESTIMATED INFORMATION/);
  assert.match(prompt.user, /OPPONENT INFORMATION/);
  assert.match(prompt.user, /ACTION HISTORY/);
  assert.match(prompt.user, /DECISION POINT/);
  assert.match(prompt.user, /As Qh/);
  assert.match(prompt.user, /28\.78/);
  assert.match(prompt.user, /"currentPotBb": 50/);
  assert.match(prompt.user, /"villainBetBb": 20/);
  assert.match(prompt.user, /"callAmountBb": 20/);
  assert.match(prompt.user, /"finalPotBb": 90/);
  assert.equal((prompt.user.match(/"startingStackBb"/g) ?? []).length, 2, 'each player stack is sent once in the authoritative math facts');
  assert.match(prompt.user, /PREFLOP/);
  assert.match(prompt.user, /FLOP/);
});
test('custom ranges are marked as user assumptions and profile cannot overwrite them', () => {
  const villainBlockers = ['As', 'Qh', 'Qs', '7d', '4c', '2h', '9s'].map(parseCard);
  const summary = getRangeSummary(['KK', 'AKs'].map(rangeKey), villainBlockers);
  const context = validateAIAnalysisContext({ ...base, villain: { ...base.villain, profile: 'passive_fish', range: { mode: 'custom', selectedHands: ['KK', 'AKs'], comboCount: summary.selectedCombos, percentage: summary.percentage } } });
  const prompt = buildPokerPrompt(context).user;
  assert.match(prompt, /VILLAIN CUSTOM USER ASSUMPTION: KK, AKs/);
  assert.match(prompt, /must not overwrite this assumption/);
  assert.match(prompt, /passive_fish/);
});
test('Auto ranges carry no hand list and are explicitly estimates without invented frequencies', () => {
  const prompt = buildPokerPrompt(validateAIAnalysisContext(base));
  assert.match(prompt.user, /HERO AUTO: no exact combos or frequencies supplied/);
  assert.match(prompt.user, /Infer a plausible qualitative range/);
  assert.match(prompt.system, /never invent stats, sample sizes, or bluff\/fold frequencies/);
});
test('confidence and missing information are derived from supplied completeness', () => {
  const quality = deriveInputQuality(validateAIAnalysisContext(base));
  assert.equal(quality.confidence, 'medium');
  assert.ok(quality.missingInformation.some((item) => /Effective stack/.test(item)));
  assert.ok(quality.missingInformation.some((item) => /No action history/.test(item)) === false);
});
test('validated AI output replaces model-authored math and uncertainty with server facts', () => {
  const context = validateAIAnalysisContext(base);
  const normalized = validateAIAnalysisResult(result, context);
  assert.match(normalized.mathematicalContext.summary, /Hero equity vs Villain: 54\.2% vs a known Villain hand/);
  assert.doesNotMatch(normalized.mathematicalContext.summary, /Model must not/);
  assert.equal(normalized.confidence, 'medium');
  assert.ok(normalized.missingInformation.length > 0);
});
test('response schema and runtime validator reject malformed model output', () => {
  assert.equal(AI_ANALYSIS_JSON_SCHEMA.additionalProperties, false);
  assert.throws(() => validateAIAnalysisResult({ ...result, unrelated: true }, base), /hand-review format/);
  assert.throws(() => validateAIAnalysisResult({ ...result, rangeAnalysis: { hero: 'ok' } }, base), /range analysis/);
  assert.throws(() => validateAIAnalysisResult({ ...result, keyTakeaways: [] }, base), /incomplete or malformed/);
  assert.throws(() => validateAIAnalysisResult({ ...result, streetAnalysis: { ...result.streetAnalysis, flop: 'not an object' } }, base), /flop analysis/);
});
test('streets without matching board or action history are hidden in normalized results', () => {
  const preflop = { ...base, stackState: { ...base.stackState, spr: 40 }, board: [], actionHistory: [base.actionHistory[0]], pot: { currentPotBb: 2, villainBetBb: 0, callAmountBb: 0, finalPotBb: 2 }, mathematicalContext: { equity: base.mathematicalContext.equity, requiredEquity: 0, callEV: { status: 'unknown', reason: 'no-active-call' } } };
  const normalized = validateAIAnalysisResult(result, validateAIAnalysisContext(preflop));
  assert.ok(normalized.streetAnalysis.preflop);
  assert.equal(normalized.streetAnalysis.flop, null);
  assert.equal(normalized.streetAnalysis.turn, null);
  assert.equal(normalized.streetAnalysis.river, null);
});
test('request handler rejects malformed JSON, oversize payloads, and bad context', async () => {
  const never = async () => { throw new Error('provider must not be called'); };
  const invalidJson = await handleAnalyzeRequest(new Request('http://localhost/api/analyze', { method: 'POST', body: '{' }), never);
  assert.equal(invalidJson.status, 400);
  const large = await handleAnalyzeRequest(new Request('http://localhost/api/analyze', { method: 'POST', body: 'x'.repeat(MAX_ANALYSIS_BODY_BYTES + 1) }), never);
  assert.equal(large.status, 413);
  const invalidContext = await handleAnalyzeRequest(request({ ...base, extra: true }), never);
  assert.equal(invalidContext.status, 400);
});
test('request handler enforces rate limits before calling the AI provider', async () => {
  let providerCalls = 0;
  const limited = await handleAnalyzeRequest(request(), async () => { providerCalls++; return result; }, async () => ({ status: 'limited', retryAfterSeconds: 77 }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '77');
  assert.equal((await limited.json()).error, 'rate_limited');
  assert.equal(providerCalls, 0);

  const unavailable = await handleAnalyzeRequest(request(), async () => { providerCalls++; return result; }, async () => ({ status: 'unavailable' }));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'rate_limit_unavailable');
  assert.equal(providerCalls, 0);
});
test('API success uses the provider mock and returns only validated result, without raw JSON text', async () => {
  let calls = 0;
  const response = await handleAnalyzeRequest(request(), async (prompt) => { calls++; assert.match(prompt.system, /not a solver/); return result; });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.ok(payload.result);
  assert.equal(payload.result.mathematicalContext.summary.includes('Model must not'), false);
  assert.equal(payload.prompt, undefined);
});
test('API maps missing-key, provider failure, timeout and malformed-model outputs to safe errors', async () => {
  const missingKey = await handleAnalyzeRequest(request(), async () => { throw new AnalysisServiceError('not_configured'); });
  assert.equal(missingKey.status, 503);
  assert.match((await missingKey.json()).message, /server-side API key/);
  const providerError = await handleAnalyzeRequest(request(), async () => { throw new AnalysisServiceError('provider_error'); });
  assert.equal(providerError.status, 502);
  const timeout = await handleAnalyzeRequest(request(), async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; });
  assert.equal(timeout.status, 504);
  const malformed = await handleAnalyzeRequest(request(), async () => ({ output_text: 'raw invalid' }));
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json()).stack, undefined);
});
test('missing API key short-circuits before any paid provider request', async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  delete process.env.OPENAI_API_KEY;
  global.fetch = async () => { throw new Error('must not call fetch without key'); };
  try { await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error instanceof AnalysisServiceError && error.code === 'not_configured'); }
  finally { global.fetch = originalFetch; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
});

test('OpenAI adapter sends only server-side credentials and a strict response schema', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  process.env.OPENAI_MODEL = 'test-model';
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options, payload: JSON.parse(options.body) };
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(result), usage: { output_tokens: 1200, output_tokens_details: { reasoning_tokens: 250 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const raw = await requestOpenAIAnalysis({ system: 'System instructions', user: 'Poker context' }, new AbortController().signal);
    assert.deepEqual(raw, result);
    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-key-never-a-real-secret');
    assert.equal(captured.payload.model, 'test-model');
    assert.equal(captured.payload.store, false);
    assert.equal(captured.payload.max_output_tokens, 25_000);
    assert.deepEqual(captured.payload.reasoning, { effort: 'low' });
    assert.equal(captured.payload.text.format.type, 'json_schema');
    assert.equal(captured.payload.text.format.strict, true);
    assert.equal(captured.payload.text.format.name, 'poker_hand_review');
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previousModel;
  }
});

test('Auto equity stays unknown and stack, SPR, all-in, and action resolution fields survive API validation', async () => {
  const auto = {
    ...base,
    villain: { ...base.villain, cards: [], range: { mode: 'auto' } },
    stackState: { ...base.stackState, hero: { startingStackBb: 100, remainingStackBb: 20, isAllIn: false }, villain: { startingStackBb: 100, remainingStackBb: 0, isAllIn: true }, currentEffectiveStackBb: 0, spr: 0, facingAllIn: true, canFullCall: true },
    mathematicalContext: { equity: { status: 'unknown', reason: 'auto-range' }, requiredEquity: 20 / 90, callEV: { status: 'unknown', reason: 'equity-unknown' } },
    actionHistory: [{ ...base.actionHistory[0], resolution: { additionalContributionBb: 2.5, streetTotalBb: 2.5, allInKind: null } }],
  };
  let capturedPrompt;
  const response = await handleAnalyzeRequest(request(auto), async (prompt) => { capturedPrompt = prompt; return result; });
  assert.equal(response.status, 200);
  assert.match(capturedPrompt.user, /AUTO/i);
  assert.match(capturedPrompt.user, /facingAllIn/);
  assert.match(capturedPrompt.user, /"spr": 0/);
});

test('custom range requests reach the provider with their exact user-selected range', async () => {
  const blockers = ['As', 'Qh', 'Qs', '7d', '4c', '2h', '9s'].map(parseCard);
  const summary = getRangeSummary(['KK', 'AKs'].map(rangeKey), blockers);
  const context = { ...base, villain: { ...base.villain, cards: [], range: { mode: 'custom', selectedHands: ['KK', 'AKs'], comboCount: summary.selectedCombos, percentage: summary.percentage } }, mathematicalContext: { ...base.mathematicalContext, equity: { ...base.mathematicalContext.equity, source: 'custom-range' } } };
  const response = await handleAnalyzeRequest(request(context), async (prompt) => { assert.match(prompt.user, /VILLAIN CUSTOM USER ASSUMPTION: KK, AKs/); return result; });
  assert.equal(response.status, 200);
});

test('invalid action history is distinguished from invalid hand and non-finite stack data', async () => {
  const never = async () => { throw new Error('provider must not be called'); };
  const actionResponse = await handleAnalyzeRequest(request({ ...base, actionHistory: [{ ...base.actionHistory[0], position: 'UTG' }] }), never);
  assert.equal((await actionResponse.json()).error, 'invalid_action_history');
  const stackResponse = await handleAnalyzeRequest(request({ ...base, stackState: { ...base.stackState, spr: Infinity } }), never);
  assert.equal((await stackResponse.json()).error, 'invalid_hand_data');
});

test('incomplete Responses API output is classified without logging response text', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  global.fetch = async () => new Response(JSON.stringify({ status: 'incomplete', output_text: '{\"situationSummary\":', incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 25_000, output_tokens_details: { reasoning_tokens: 24_000 } } }), { status: 200 });
  try {
    await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error instanceof AnalysisServiceError && error.code === 'malformed_response');
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});


test('OpenAI configuration, quota, and network failures use separate safe service categories', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  try {
    global.fetch = async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'model_not_found' } }), { status: 404 });
    await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'configuration_error');
    global.fetch = async () => new Response(JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota' } }), { status: 429 });
    await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'billing_quota');
    global.fetch = async () => new Response(JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' } }), { status: 429 });
    await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'provider_error');
    global.fetch = async () => { throw new TypeError('network unavailable'); };
    await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'network_error');
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('provider authentication and upstream status failures are normalized without leaking secrets', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  global.fetch = async () => new Response('upstream details', { status: 401 });
  try {
    await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'not_configured');
    const response = await handleAnalyzeRequest(request(), async () => { throw new AnalysisServiceError('not_configured'); });
    const text = await response.text();
    assert.equal(text.includes('test-key-never-a-real-secret'), false);
    assert.equal(text.includes('upstream details'), false);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});
test('frontend submits to the API, shows a loading state and renders a hand review rather than context JSON', () => {
  const ui = fs.readFileSync(require.resolve('../app/ai-mode.tsx'), 'utf8');
  assert.match(ui, /fetch\('\/api\/analyze'/);
  assert.match(ui, /Analizowanie rozdania/);
  assert.match(ui, /AIHandReview/);
  assert.match(ui, /billing_quota: t\('errorBillingQuota'\)/);
  assert.match(ui, /invalid_action_history: t\('errorInvalidActions'\)/);
  assert.match(ui, /malformed_response: t\('errorMalformed'\)/);
  assert.match(ui, /disabled=\{!valid \|\| aiEquityLoading \|\| isAnalyzing\}/);
  assert.doesNotMatch(ui, /contextJson|<pre>/);
});


test('AI prompt preserves explicit raise-to and incremental call semantics', () => {
  const context = { ...base, actionHistory: [
    { street: 'flop', actor: 'villain', position: 'BB', action: 'raise', amountBb: 15 },
    { street: 'flop', actor: 'hero', position: 'CO', action: 'call', amountBb: 10 },
  ] };
  const prompt = buildPokerPrompt(context).user;
  assert.match(prompt, /raise to 15 bb/);
  assert.match(prompt, /call 10 bb additional/);
});
