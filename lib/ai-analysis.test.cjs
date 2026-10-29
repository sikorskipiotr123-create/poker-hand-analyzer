const { AUTHORIZATION } = require('./test-support/deployment-auth.cjs');
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
const { handleAnalyzeRequest } = require('./test-support/analyze-handler.cjs');
const { AnalysisServiceError, requestOpenAIAnalysis, getAIConfiguration } = require('./ai-provider.ts');
const { getRangeSummary, RANGE_HANDS } = require('./range.ts');
const rangeKey = (label) => RANGE_HANDS.find((hand) => hand.label === label).key;
const parseCard = (key) => ({ rank: ({ A: 14, K: 13, Q: 12, J: 11, T: 10 }[key[0]] ?? Number(key[0])), suit: key[1] });
async function captureConsoleErrors(callback) {
  const original = console.error;
  const records = [];
  console.error = (...args) => records.push(args);
  try { await callback(); } finally { console.error = original; }
  return records.map(([message, details]) => ({ message, details }));
}

const base = {
  language: 'en',
  blinds: { smallBlindBb: 0.5, bigBlindBb: 1 },
  hero: { cards: ['As', 'Qh'], position: 'CO', range: { mode: 'auto' } },
  villain: { cards: ['Jc', 'Jd'], position: 'BB', profile: 'unknown', stats: { vpip: null, pfr: null, threeBet: null, aggressionFactor: null }, range: { mode: 'auto' } },
  board: ['Qs', '7d', '4c', '2h', '9s'],
  actionHistory: [
    { street: 'preflop', actor: 'hero', action: 'raise', amountBb: 2.5, position: 'CO' },
    { street: 'preflop', actor: 'villain', action: 'call', amountBb: 1.5, position: 'BB' },
    { street: 'flop', actor: 'villain', action: 'check', amountBb: null, position: 'BB' },
    { street: 'flop', actor: 'hero', action: 'check', amountBb: null, position: 'CO' },
    { street: 'turn', actor: 'villain', action: 'check', amountBb: null, position: 'BB' },
    { street: 'turn', actor: 'hero', action: 'check', amountBb: null, position: 'CO' },
    { street: 'river', actor: 'villain', action: 'bet', amountBb: 20, position: 'BB' },
  ],
  pot: { currentPotBb: 5.5, villainBetBb: 20, callAmountBb: 20, finalPotBb: 45.5 },
  stackState: { hero: { startingStackBb: 100, remainingStackBb: 97.5, isAllIn: false }, villain: { startingStackBb: 100, remainingStackBb: 77.5, isAllIn: false }, startingEffectiveStackBb: 100, currentEffectiveStackBb: 77.5, spr: 77.5 / 25.5, streetStartPotBb: 5.5, streetStartEffectiveStackBb: 97.5, streetStartSpr: 97.5 / 5.5, facingAllIn: false, canFullCall: true },
  mathematicalContext: { equity: { status: 'known', value: 1, source: 'known-hand', villainEquity: 0, tiePercent: 0, method: 'exact', evaluatedCases: 1 }, requiredEquity: 20 / 45.5, callEV: { status: 'known', value: 25.5 } },
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
const request = (context = base, headers = {}) => new Request('http://localhost/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json', ...headers }, body: JSON.stringify(context) });

test('missing OPENAI_MODEL uses the approved production model rather than an expensive fallback', () => {
  const previousModel = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_MODEL;
  try { assert.equal(getAIConfiguration().model, 'gpt-5.6-terra'); }
  finally { if (previousModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previousModel; }
});

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
  assert.match(prompt.user, /25\.5/);
  assert.match(prompt.user, /"currentPotBb": 5\.5/);
  assert.match(prompt.user, /"villainBetBb": 20/);
  assert.match(prompt.user, /"callAmountBb": 20/);
  assert.match(prompt.user, /"finalPotBb": 45\.5/);
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
  assert.match(normalized.mathematicalContext.summary, /Hero equity vs Villain: 100\.0% vs a known Villain hand/);
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
  const preflop = { ...base, stackState: { ...base.stackState, spr: 77.5 / 2 }, board: [], actionHistory: [base.actionHistory[0]], pot: { currentPotBb: 2, villainBetBb: 0, callAmountBb: 0, finalPotBb: 2 }, mathematicalContext: { equity: base.mathematicalContext.equity, requiredEquity: 0, callEV: { status: 'unknown', reason: 'no-active-call' } } };
  const normalized = validateAIAnalysisResult(result, validateAIAnalysisContext(preflop));
  assert.ok(normalized.streetAnalysis.preflop);
  assert.equal(normalized.streetAnalysis.flop, null);
  assert.equal(normalized.streetAnalysis.turn, null);
  assert.equal(normalized.streetAnalysis.river, null);
});
test('request handler rejects malformed JSON, oversize payloads, and bad context', async () => {
  const never = async () => { throw new Error('provider must not be called'); };
  const invalidJson = await handleAnalyzeRequest(new Request('http://localhost/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' }, body: '{' }), never);
  assert.equal(invalidJson.status, 400);
  const large = await handleAnalyzeRequest(new Request('http://localhost/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' }, body: 'x'.repeat(MAX_ANALYSIS_BODY_BYTES + 1) }), never);
  assert.equal(large.status, 413);
  const invalidContext = await handleAnalyzeRequest(request({ ...base, extra: true }), never);
  assert.equal(invalidContext.status, 400);
});
test('request handler enforces per-IP and global rate limits before calling the AI provider', async () => {
  let providerCalls = 0;
  const ipLimited = await handleAnalyzeRequest(request(), async () => { providerCalls++; return result; }, async () => ({ status: 'limited', scope: 'ip', retryAfterSeconds: 77 }));
  assert.equal(ipLimited.status, 429);
  assert.equal(ipLimited.headers.get('retry-after'), '77');
  assert.equal((await ipLimited.json()).error, 'ip_daily_limit_reached');
  assert.equal(providerCalls, 0);

  const dailyLimited = await handleAnalyzeRequest(request(), async () => { providerCalls++; return result; }, async () => ({ status: 'limited', scope: 'global', retryAfterSeconds: 3600 }));
  assert.equal(dailyLimited.status, 429);
  assert.equal(dailyLimited.headers.get('retry-after'), '3600');
  const dailyBody = await dailyLimited.json();
  assert.equal(dailyBody.error, 'daily_limit_reached');
  assert.match(dailyBody.message, /daily/i);
  assert.doesNotMatch(JSON.stringify(dailyBody), /redis|203\.0\.113|poker-analyze/i);
  assert.equal(providerCalls, 0);

  const unavailable = await handleAnalyzeRequest(request(), async () => { providerCalls++; return result; }, async () => ({ status: 'unavailable' }));
  assert.equal(unavailable.status, 503);
  const unavailableBody = await unavailable.json();
  assert.equal(unavailableBody.error, 'rate_limit_unavailable');
  assert.doesNotMatch(unavailableBody.message, /redis|credential|configuration/i);
  assert.equal(providerCalls, 0);

  let limiterCalls = 0;
  const invalid = await handleAnalyzeRequest(new Request('http://localhost/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' }, body: '{' }), async () => { providerCalls++; return result; }, async () => { limiterCalls++; return { status: 'allowed' }; });
  assert.equal(invalid.status, 400);
  assert.equal(limiterCalls, 0);
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
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(result), usage: { output_tokens: 1200, output_tokens_details: { reasoning_tokens: 250 } } }), { status: 200, headers: { authorization: AUTHORIZATION, 'Content-Type': 'application/json' } });
  };
  try {
    const raw = await requestOpenAIAnalysis({ system: 'System instructions', user: 'Poker context' }, new AbortController().signal);
    assert.deepEqual(raw, result);
    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-key-never-a-real-secret');
    assert.equal(captured.payload.model, 'test-model');
    assert.equal(captured.payload.store, false);
    assert.equal(captured.payload.max_output_tokens, 16_000);
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
    stackState: { ...base.stackState, villain: { startingStackBb: 22.5, remainingStackBb: 0, isAllIn: true }, startingEffectiveStackBb: 22.5, currentEffectiveStackBb: 0, spr: 0, streetStartEffectiveStackBb: 20, streetStartSpr: 20 / 5.5, facingAllIn: true, canFullCall: true },
    mathematicalContext: { equity: { status: 'unknown', reason: 'auto-range' }, requiredEquity: 20 / 45.5, callEV: { status: 'unknown', reason: 'equity-unknown' } },
    actionHistory: base.actionHistory.map((action, i) => i === 0 ? { ...action, resolution: { additionalContributionBb: 2.5, streetTotalBb: 2.5, allInKind: null } } : action),
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
  const context = { ...base, villain: { ...base.villain, cards: [], range: { mode: 'custom', selectedHands: ['KK', 'AKs'], comboCount: summary.selectedCombos, percentage: summary.percentage } }, mathematicalContext: { ...base.mathematicalContext, equity: { status: 'unknown', reason: 'missing-cards' }, callEV: { status: 'unknown', reason: 'equity-unknown' } } };
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

test('incomplete Responses API output distinguishes token exhaustion and sanitizes metadata', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  try {
    const records = await captureConsoleErrors(async () => {
      global.fetch = async () => new Response(JSON.stringify({
        status: 'incomplete',
        output_text: 'PRIVATE_PARTIAL_JSON',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 1400, input_tokens_details: { cached_tokens: 20 }, output_tokens: 25_000, output_tokens_details: { reasoning_tokens: 12_000 } },
      }), { status: 200 });
      await assert.rejects(requestOpenAIAnalysis({ system: 'private prompt', user: 'private hand history' }, new AbortController().signal), (error) => error instanceof AnalysisServiceError && error.code === 'malformed_response');
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].details.category, 'output_token_exhaustion');
    assert.equal(records[0].details.httpStatus, 200);
    assert.equal(records[0].details.responseStatus, 'incomplete');
    assert.equal(records[0].details.incompleteReason, 'max_output_tokens');
    assert.equal(records[0].details.outputTokens, 25_000);
    assert.equal(records[0].details.reasoningTokens, 12_000);
    assert.equal(records[0].details.inputTokens, 1400);
    assert.equal(records[0].details.cachedTokens, 20);
    assert.equal(typeof records[0].details.responseDurationMs, 'number');
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_PARTIAL_JSON|private prompt|private hand history|test-key-never-a-real-secret/);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('incomplete Responses API output with another reason has its own safe category', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  try {
    const records = await captureConsoleErrors(async () => {
      global.fetch = async () => new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'PRIVATE_PROVIDER_REASON' }, usage: { output_tokens: 10 } }), { status: 200 });
      await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'malformed_response');
    });
    assert.equal(records[0].details.category, 'incomplete_response');
    assert.equal(records[0].details.incompleteReason, 'other');
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_PROVIDER_REASON/);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('invalid provider response JSON is categorized without logging its content', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  try {
    const records = await captureConsoleErrors(async () => {
      global.fetch = async () => new Response('PRIVATE_INVALID_PROVIDER_BODY', { status: 200 });
      await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'malformed_response');
    });
    assert.equal(records[0].details.category, 'invalid_provider_json');
    assert.equal(records[0].details.source, 'response_body');
    assert.equal(records[0].details.httpStatus, 200);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_INVALID_PROVIDER_BODY/);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('missing structured response and invalid structured JSON have distinct diagnostics', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  try {
    const missing = await captureConsoleErrors(async () => {
      global.fetch = async () => new Response(JSON.stringify({ status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 });
      await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'malformed_response');
    });
    assert.equal(missing[0].details.category, 'missing_structured_response');
    assert.equal(missing[0].details.responseStatus, 'completed');
    assert.equal(missing[0].details.inputTokens, 100);

    const invalidText = await captureConsoleErrors(async () => {
      global.fetch = async () => new Response(JSON.stringify({ status: 'completed', output_text: 'PRIVATE_INVALID_STRUCTURED_TEXT', usage: { input_tokens: 50, output_tokens: 8 } }), { status: 200 });
      await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'malformed_response');
    });
    assert.equal(invalidText[0].details.category, 'invalid_provider_json');
    assert.equal(invalidText[0].details.source, 'structured_output_text');
    assert.equal(invalidText[0].details.outputCharacters, 'PRIVATE_INVALID_STRUCTURED_TEXT'.length);
    assert.equal(invalidText[0].details.outputTokens, 8);
    assert.doesNotMatch(JSON.stringify(invalidText), /PRIVATE_INVALID_STRUCTURED_TEXT/);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('other malformed provider response states are categorized and sanitized', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key-never-a-real-secret';
  try {
    const records = await captureConsoleErrors(async () => {
      global.fetch = async () => new Response(JSON.stringify({ status: 'failed', error: { message: 'PRIVATE_PROVIDER_MESSAGE' }, usage: { output_tokens: 4 } }), { status: 200 });
      await assert.rejects(requestOpenAIAnalysis({ system: 'x', user: 'y' }, new AbortController().signal), (error) => error.code === 'malformed_response');
    });
    assert.equal(records[0].details.category, 'other_malformed_response');
    assert.equal(records[0].details.responseStatus, 'failed');
    assert.equal(records[0].details.outputTokens, 4);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_PROVIDER_MESSAGE/);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('runtime validator reports safe field diagnostics and retains the client error response', async () => {
  const invalidResult = { ...result, situationSummary: 'PRIVATE_MODEL_CONTENT_' + 'x'.repeat(1400) };
  const providerDiagnostics = { httpStatus: 200, responseStatus: 'completed', incompleteReason: null, inputTokens: 1500, outputTokens: 800, cachedTokens: 300, reasoningTokens: 25, responseDurationMs: 21000 };
  const records = await captureConsoleErrors(async () => {
    const response = await handleAnalyzeRequest(request(), async (_prompt, _signal, observeResponse) => {
      observeResponse(providerDiagnostics);
      return invalidResult;
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'malformed_response', message: 'The AI service returned an unreadable analysis. Please try again.' });
  });
  assert.equal(records[0].details.category, 'runtime_schema_validation_failure');
  assert.equal(records[0].details.fieldPath, 'situationSummary');
  assert.equal(records[0].details.validationCategory, 'text_too_long');
  assert.equal(records[0].details.constraint, 'max_length:1400');
  assert.equal(records[0].details.httpStatus, 200);
  assert.equal(records[0].details.responseStatus, 'completed');
  assert.equal(records[0].details.incompleteReason, null);
  assert.equal(records[0].details.inputTokens, 1500);
  assert.equal(records[0].details.cachedTokens, 300);
  assert.equal(records[0].details.outputTokens, 800);
  assert.equal(records[0].details.reasoningTokens, 25);
  assert.equal(records[0].details.responseDurationMs, 21000);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_MODEL_CONTENT/);
});

test('runtime validation errors expose only safe paths, categories, and constraints', () => {
  const { AIResponseValidationError } = require('./ai-response.ts');
  const context = validateAIAnalysisContext(base);
  assert.throws(
    () => validateAIAnalysisResult({ ...result, keyTakeaways: ['private text', 'x'.repeat(321)] }, context),
    (error) => error instanceof AIResponseValidationError && error.fieldPath === 'keyTakeaways[1]' && error.category === 'array_item_invalid' && error.constraint === 'max_length:320' && !error.message.includes('private text'),
  );
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

// Request-boundary regressions use only local mocks. Throwing from the body getter
// proves rejection occurs before parsing, not merely before a provider invocation.
const securityUrl = 'https://poker.example.test/api/analyze';
const browserHeaders = { 'content-type': 'application/json', origin: 'https://poker.example.test', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const jsonOnly = { 'content-type': 'application/json' };
function securityRequest(headers, url = securityUrl) {
  return new Request(url, { method: 'POST', headers: { authorization: AUTHORIZATION, ...headers }, body: new TextEncoder().encode(JSON.stringify(base)) });
}
async function withTrustedOrigins(value, run) {
  const previous = process.env.AI_TRUSTED_ORIGINS;
  if (value === undefined) delete process.env.AI_TRUSTED_ORIGINS;
  else process.env.AI_TRUSTED_ORIGINS = value;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.AI_TRUSTED_ORIGINS;
    else process.env.AI_TRUSTED_ORIGINS = previous;
  }
}
const acceptedRequests = [
  ['same-origin browser JSON', browserHeaders],
  ['JSON with charset', { ...browserHeaders, 'content-type': 'application/json; charset=utf-8' }],
  ['case-insensitive JSON and quoted parameter', { ...browserHeaders, 'content-type': 'Application/JSON; Charset="UTF-8"' }],
  ['valid quoted extension parameter', { ...browserHeaders, 'content-type': 'application/json; profile="a;b"' }],
  ['Origin without Fetch Metadata', { ...jsonOnly, origin: 'https://poker.example.test' }],
  ['same-origin Fetch Metadata without Origin', { ...jsonOnly, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin' }],
  ['non-browser without Origin or Fetch Metadata', jsonOnly],
  ['non-browser with Basic header still requires JSON', { ...jsonOnly, authorization: AUTHORIZATION }],
  ['default HTTPS port normalization', { ...browserHeaders, origin: 'https://poker.example.test:443' }],
  ['forwarded host cannot replace valid actual origin', { ...browserHeaders, host: 'untrusted.example', 'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'http', forwarded: 'host=untrusted.example;proto=http' }],
  ['trusted external origin behind internal proxy URL', { ...browserHeaders, origin: 'https://public.example.test' }, 'https://public.example.test', 'http://127.0.0.1:3000/api/analyze'],
  ['explicitly trusted sibling origin', { ...browserHeaders, origin: 'https://review.example.test', 'sec-fetch-site': 'same-site' }, 'https://review.example.test'],
  ['exact Vercel alias configured behind proxy', { ...browserHeaders, origin: 'https://poker-preview.vercel.app' }, 'https://poker-preview.vercel.app', 'http://127.0.0.1:3000/api/analyze'],
  ['local development origin', { ...browserHeaders, origin: 'http://localhost:3000' }, undefined, 'http://localhost:3000/api/analyze'],
  ['IPv6 local development origin', { ...browserHeaders, origin: 'http://[::1]:3000' }, undefined, 'http://[::1]:3000/api/analyze'],
];
for (const [label, headers, configured, url] of acceptedRequests) {
  test('request protection accepts ' + label, async () => withTrustedOrigins(configured, async () => {
    let limiterCalls = 0, providerCalls = 0;
    const response = await handleAnalyzeRequest(securityRequest(headers, url), async () => { providerCalls++; return result; }, async () => { limiterCalls++; return { status: 'allowed' }; });
    assert.equal(response.status, 200);
    assert.equal(limiterCalls, 1);
    assert.equal(providerCalls, 1);
    assert.equal(response.headers.has('access-control-allow-origin'), false);
  }));
}
const rejectedRequests = [
  ['plain text', { ...browserHeaders, 'content-type': 'text/plain' }, 415],
  ['HTML', { ...browserHeaders, 'content-type': 'text/html' }, 415],
  ['form encoding', { ...browserHeaders, 'content-type': 'application/x-www-form-urlencoded' }, 415],
  ['multipart', { ...browserHeaders, 'content-type': 'multipart/form-data; boundary=test' }, 415],
  ['JSON lookalike', { ...browserHeaders, 'content-type': 'application/jsonp' }, 415],
  ['JSON suffix type', { ...browserHeaders, 'content-type': 'application/problem+json' }, 415],
  ['missing media type', { origin: browserHeaders.origin }, 415],
  ['combined media types', { ...browserHeaders, 'content-type': 'application/json, text/plain' }, 415],
  ['malformed parameter', { ...browserHeaders, 'content-type': 'application/json; charset' }, 415],
  ['unterminated parameter', { ...browserHeaders, 'content-type': 'application/json; charset="utf-8' }, 415],
  ['oversized media type', { ...browserHeaders, 'content-type': 'application/json; x=' + 'a'.repeat(1024) }, 415],
  ['cross-site origin with spoofed same-origin metadata', { ...browserHeaders, origin: 'https://untrusted.example' }, 403],
  ['cross-site origin with no Fetch Metadata', { ...jsonOnly, origin: 'https://untrusted.example' }, 403],
  ['same-origin Origin conflicts with cross-site metadata', { ...browserHeaders, 'sec-fetch-site': 'cross-site' }, 403],
  ['allowlisted origin cannot override cross-site metadata', { ...browserHeaders, origin: 'https://trusted.example', 'sec-fetch-site': 'cross-site' }, 403, 'https://trusted.example'],
  ['cross-site metadata without Origin', { ...jsonOnly, 'sec-fetch-site': 'cross-site' }, 403],
  ['same-site metadata without Origin', { ...jsonOnly, 'sec-fetch-site': 'same-site' }, 403],
  ['sibling site is not automatically trusted', { ...browserHeaders, origin: 'https://other.example.test', 'sec-fetch-site': 'same-site' }, 403],
  ['same-site contradicts same-origin mode', { ...browserHeaders, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'same-origin' }, 403],
  ['navigation', { ...browserHeaders, 'sec-fetch-mode': 'navigate' }, 403],
  ['no-cors', { ...browserHeaders, 'sec-fetch-mode': 'no-cors' }, 403],
  ['document destination', { ...browserHeaders, 'sec-fetch-dest': 'document' }, 403],
  ['user-initiated navigation', { ...browserHeaders, 'sec-fetch-site': 'none' }, 403],
  ['navigation user flag without other metadata', { ...jsonOnly, 'sec-fetch-user': '?1' }, 403],
  ['navigation user flag conflicts with API fetch', { ...browserHeaders, 'sec-fetch-user': '?1' }, 403],
  ['partial Fetch Metadata', { ...jsonOnly, 'sec-fetch-mode': 'cors' }, 403],
  ['combined Fetch Metadata', { ...browserHeaders, 'sec-fetch-site': 'same-origin, cross-site' }, 403],
  ['unknown Fetch Metadata', { ...browserHeaders, 'sec-fetch-site': 'trusted' }, 403],
  ['opaque Origin', { ...browserHeaders, origin: 'null' }, 403],
  ['empty Origin', { ...browserHeaders, origin: '' }, 403],
  ['multiple Origins', { ...browserHeaders, origin: 'https://poker.example.test, https://untrusted.example' }, 403],
  ['Origin path', { ...browserHeaders, origin: 'https://poker.example.test/path' }, 403],
  ['Origin trailing slash', { ...browserHeaders, origin: 'https://poker.example.test/' }, 403],
  ['Origin credentials', { ...browserHeaders, origin: 'https://user@poker.example.test' }, 403],
  ['Origin backslash', { ...browserHeaders, origin: 'https://poker.example.test\\untrusted.example' }, 403],
  ['Origin suffix spoof', { ...browserHeaders, origin: 'https://poker.example.test.untrusted.example' }, 403],
  ['wrong scheme', { ...browserHeaders, origin: 'http://poker.example.test' }, 403],
  ['wrong port', { ...browserHeaders, origin: 'https://poker.example.test:444' }, 403],
  ['spoofed forwarding headers', { ...browserHeaders, origin: 'https://untrusted.example', host: 'untrusted.example', 'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'https', forwarded: 'host=untrusted.example;proto=https' }, 403],
  ['Referer does not override untrusted Origin', { ...browserHeaders, origin: 'https://untrusted.example', referer: 'https://poker.example.test/' }, 403],
  ['Basic header does not bypass Origin', { ...browserHeaders, origin: 'https://untrusted.example', authorization: AUTHORIZATION }, 403],
  ['Basic header does not bypass media type or missing metadata', { 'content-type': 'text/plain', authorization: AUTHORIZATION }, 415],
  ['wildcard configuration', browserHeaders, 503, 'https://*.example.test'],
  ['invalid configuration is fail closed even for non-browser', jsonOnly, 503, '*'],
  ['configuration path', browserHeaders, 503, 'https://public.example.test/path'],
  ['configuration trailing empty entry', browserHeaders, 503, 'https://public.example.test,'],
  ['configuration credentials', browserHeaders, 503, 'https://user@public.example.test'],
  ['too many configured origins', browserHeaders, 503, Array.from({ length: 17 }, (_, i) => `https://preview${i}.example.test`).join(',')],
  ['unlisted Vercel deployment', { ...browserHeaders, origin: 'https://attacker.vercel.app' }, 403, 'https://poker-preview.vercel.app'],
];
for (const [label, headers, status, configured] of rejectedRequests) {
  test('request protection rejects ' + label + ' before body, Redis or OpenAI', async () => withTrustedOrigins(configured, async () => {
    const req = securityRequest(headers);
    let bodyReads = 0, limiterCalls = 0, providerCalls = 0;
    Object.defineProperty(req, 'body', { get() { bodyReads++; throw new Error('Body must not be accessed'); } });
    const response = await handleAnalyzeRequest(req, async () => { providerCalls++; return result; }, async () => { limiterCalls++; return { status: 'allowed' }; });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, status === 415 ? 'unsupported_media_type' : status === 503 ? 'request_security_unavailable' : 'request_origin_forbidden');
    assert.equal(bodyReads, 0);
    assert.equal(limiterCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.has('access-control-allow-origin'), false);
    assert.equal(response.headers.has('access-control-allow-credentials'), false);
  }));
}

// Regression: completed Structured Outputs previously failed at the hidden 120-character action limit.
const { AI_RECOMMENDATION_LIMITS } = require('./ai-recommendation-limits.ts');
for (const language of ['en', 'pl']) test(`long ${language} recommendation is preserved through completed provider response and handler`, async () => {
  const action = language === 'pl'
    ? 'Sprawdź zakład, jeśli zakres rywala nadal zawiera słabsze układy i blefy; przeciwko bardzo wąskiemu zakresowi wartości rozważ pas zamiast automatycznego sprawdzenia każdej wielkości zakładu.'
    : 'Call the current bet if the opponent range still contains weaker hands and plausible bluffs; against a narrow value-only range, reconsider rather than automatically calling every future bet size.';
  assert.ok(action.length > 120);
  const full = { ...result, recommendedLine: { action, explanation: 'Keep the complete strategic explanation. '.repeat(20) } };
  const original = global.fetch, savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-test-only-provider-key';
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.text.format.schema.properties.recommendedLine, AI_ANALYSIS_JSON_SCHEMA.properties.recommendedLine);
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(full) }), { status: 200 });
  };
  try {
    const records = await captureConsoleErrors(async () => {
      const response = await handleAnalyzeRequest(request({ ...base, language }), requestOpenAIAnalysis);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).result.recommendedLine, full.recommendedLine);
    });
    assert.equal(records.length, 0);
  } finally {
    global.fetch = original;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  }
});
for (const field of ['action', 'explanation']) test(`recommendation ${field} schema/runtime boundary agrees without truncation`, () => {
  const schema = AI_ANALYSIS_JSON_SCHEMA.properties.recommendedLine.properties[field];
  assert.equal(schema.minLength, 1);
  assert.equal(schema.maxLength, AI_RECOMMENDATION_LIMITS[field]);
  const context = validateAIAnalysisContext(base);
  for (const character of ['ą', '🃏']) {
    const text = character.repeat(schema.maxLength);
    assert.equal(validateAIAnalysisResult({ ...result, recommendedLine: { ...result.recommendedLine, [field]: text } }, context).recommendedLine[field], text);
    assert.throws(() => validateAIAnalysisResult({ ...result, recommendedLine: { ...result.recommendedLine, [field]: text + character } }, context), error => error.fieldPath === 'recommendedLine.' + field && error.category === 'text_too_long' && error.constraint === 'max_length:' + schema.maxLength);
  }
  for (const value of ['', '   ', null, 123]) assert.throws(() => validateAIAnalysisResult({ ...result, recommendedLine: { ...result.recommendedLine, [field]: value } }, context));
});
test('recommendation guidance shares schema limits in both language prompts', () => {
  for (const language of ['pl', 'en']) {
    const prompt = buildPokerPrompt(validateAIAnalysisContext({ ...base, language }));
    assert.ok(prompt.system.includes(`recommendedLine.action`));
    assert.ok(prompt.system.includes(`within ${AI_RECOMMENDATION_LIMITS.action} Unicode characters`));
    assert.match(prompt.system, /Put detailed reasoning in recommendedLine.explanation/);
  }
});
