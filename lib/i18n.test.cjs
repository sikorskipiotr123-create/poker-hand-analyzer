const { AUTHORIZATION } = require('./test-support/deployment-auth.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { DEFAULT_APP_LANGUAGE, readStoredLanguage, translate, formatNumber, languageMismatchKey, translateMissingInformation, translateActionError } = require('./i18n.ts');
const { calculateCallAnalysis } = require('./calculations.ts');
const { buildPokerPrompt, createMathematicalSummary, deriveInputQuality, validateAIAnalysisContext } = require('./ai-analysis.ts');
const { buildAIAnalysisContext } = require('./ai-context.ts');
const { handleAnalyzeRequest } = require('./test-support/analyze-handler.cjs');
const { calculateActionState, getSprCategory } = require('./action-state.ts');
const { AI_ANALYSIS_JSON_SCHEMA } = require('./ai-response.ts');
const base = {
  language: 'pl', blinds: { smallBlindBb: 0.5, bigBlindBb: 1 }, hero: { cards: ['As', 'Kd'], position: 'BTN', range: { mode: 'auto' } },
  villain: { cards: ['Qc', 'Qh'], position: 'BB', profile: 'unknown', stats: { vpip: null, pfr: null, threeBet: null, aggressionFactor: null }, range: { mode: 'auto' } },
  board: ['Ks', '7d', '2c', '9h', '3s'], actionHistory: [],
  pot: { currentPotBb: 50, villainBetBb: 20, callAmountBb: 20, finalPotBb: 90 },
  stackState: { hero: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, villain: { startingStackBb: 100, remainingStackBb: 80, isAllIn: false }, startingEffectiveStackBb: 100, currentEffectiveStackBb: 80, spr: 80 / 70, streetStartPotBb: 0, streetStartEffectiveStackBb: null, streetStartSpr: null, facingAllIn: false, canFullCall: true },
  mathematicalContext: { equity: { status: 'unknown', reason: 'auto-range' }, requiredEquity: 20 / 90, callEV: { status: 'unknown', reason: 'equity-unknown' } },
};

test('Polish is the default language and persisted language values restore safely', () => {
  assert.equal(DEFAULT_APP_LANGUAGE, 'pl');
  assert.equal(readStoredLanguage(null), 'pl');
  assert.equal(readStoredLanguage('invalid'), 'pl');
  assert.equal(readStoredLanguage('en'), 'en');
  assert.equal(readStoredLanguage('pl'), 'pl');
});

test('representative interface copy and numeric formatting are localized in both languages', () => {
  assert.equal(translate('pl', 'mathMode'), 'Analiza matematyczna');
  assert.equal(translate('en', 'mathMode'), 'Mathematical Analysis');
  assert.match(translate('pl', 'descriptionUnknown'), /Nieznany gracz/);
  assert.match(translate('en', 'descriptionUnknown'), /Unknown player/);
  assert.equal(formatNumber('pl', 54.2, 1), '54,2');
  assert.equal(formatNumber('en', 54.2, 1), '54.2');
});

test('language switching labels an existing AI result without forcing another request', () => {
  assert.equal(languageMismatchKey('pl', 'en'), 'generatedInOtherLanguagePl');
  assert.equal(languageMismatchKey('en', 'pl'), 'generatedInOtherLanguageEn');
  assert.equal(languageMismatchKey('en', 'en'), null);
  const source = fs.readFileSync(require.resolve('../app/ai-mode.tsx'), 'utf8');
  assert.match(source, /buildAIAnalysisContext\(\{\s*language,/);
  assert.match(source, /body:\s*JSON\.stringify\(context\)/);
  assert.match(source, /const analyze = async \(\) => \{[\s\S]*?fetch\('\/api\/analyze'/);
  const stateEffects = source.slice(source.indexOf('useEffect('), source.indexOf('const analyze = async'));
  assert.doesNotMatch(stateEffects, /fetch\('\/api\/analyze'/);
  assert.match(source, /analysisFingerprint = JSON\.stringify\(\{/);
  assert.doesNotMatch(source.match(/analysisFingerprint = JSON\.stringify\(\{[\s\S]*?\}\);/)?.[0] ?? '', /language/);
});

test('the UI context and server prompt preserve PL/EN and enforce every natural-language response field', () => {
  const knownFacts = { equity: { status: 'known', value: 0.5, source: 'known-hand', villainEquity: 0.5, tiePercent: 0, method: 'exact', evaluatedCases: 1 }, requiredEquity: 20 / 90, callEV: { status: 'known', value: 25 } };
  const uiPlContext = buildAIAnalysisContext({ ...base, mathematicalContext: knownFacts });
  const uiEnContext = buildAIAnalysisContext({ ...base, language: 'en', mathematicalContext: knownFacts });
  assert.equal(JSON.parse(JSON.stringify(uiPlContext)).language, 'pl');
  assert.equal(JSON.parse(JSON.stringify(uiEnContext)).language, 'en');
  const plPrompt = buildPokerPrompt(validateAIAnalysisContext(uiPlContext));
  const enPrompt = buildPokerPrompt(validateAIAnalysisContext(uiEnContext));
  const outputFields = ['situationSummary', 'mathematicalContext.summary', 'streetAnalysis assessment and explanation', 'rangeAnalysis.hero', 'rangeAnalysis.villain', 'rangeAnalysis.interaction', 'opponentAnalysis', 'recommendedLine.action', 'recommendedLine.explanation', 'keyTakeaways', 'missingInformation'];
  for (const field of outputFields) {
    assert.ok(plPrompt.system.includes(field), `Polish language instruction must name ${field}`);
    assert.ok(enPrompt.system.includes(field), `English language instruction must name ${field}`);
  }
  assert.match(plPrompt.system, /Write ALL natural-language content in Polish/);
  assert.match(plPrompt.system, /Do not write explanatory sentences in English/);
  assert.match(plPrompt.system, /Keep every JSON property name exactly as specified by the schema; translate values only/);
  assert.match(enPrompt.system, /Write ALL natural-language content in English/);
  assert.match(enPrompt.system, /Do not write explanatory sentences in another language/);
  assert.notDeepEqual(plPrompt, enPrompt);

  // Pin the public structured-output key contract so localization never translates JSON keys.
  assert.deepEqual(Object.keys(AI_ANALYSIS_JSON_SCHEMA.properties), ['situationSummary', 'mathematicalContext', 'streetAnalysis', 'rangeAnalysis', 'opponentAnalysis', 'recommendedLine', 'keyTakeaways', 'confidence', 'missingInformation']);
  assert.deepEqual(AI_ANALYSIS_JSON_SCHEMA.required, Object.keys(AI_ANALYSIS_JSON_SCHEMA.properties));
  assert.deepEqual(Object.keys(AI_ANALYSIS_JSON_SCHEMA.properties.mathematicalContext.properties), ['summary']);
  assert.deepEqual(Object.keys(AI_ANALYSIS_JSON_SCHEMA.properties.rangeAnalysis.properties), ['hero', 'villain', 'interaction']);

  const plSummary = createMathematicalSummary(validateAIAnalysisContext(uiPlContext));
  const enSummary = createMathematicalSummary(validateAIAnalysisContext(uiEnContext));
  assert.match(plSummary, /Wymagane equity/);
  assert.match(plSummary, /Pula przed betem/);
  assert.ok(validateAIAnalysisContext(uiPlContext));
  assert.doesNotMatch(plSummary, /Required equity|user-selected|without a known|auto-range|equity-unknown|Villain range/);
  assert.match(enSummary, /Required equity/);
  assert.match(enSummary, /final pot after call/);
  assert.match(deriveInputQuality(validateAIAnalysisContext(uiPlContext)).missingInformation[0], /Zakres Hero/);
  assert.match(deriveInputQuality(validateAIAnalysisContext(uiEnContext)).missingInformation[0], /Hero range/);

  const plMath = calculateCallAnalysis(50, 20, 20, 0.542);
  const enMath = calculateCallAnalysis(50, 20, 20, 0.542);
  assert.deepEqual(plMath, enMath);
  assert.equal(plMath.requiredEquity, 20 / 90);
  assert.equal(plMath.callEv, 0.542 * 90 - 20);
});


test('POST forwards the selected language through server validation to the provider prompt without calling OpenAI', async () => {
  for (const language of ['pl', 'en']) {
    const context = buildAIAnalysisContext({ ...base, language, villain: { ...base.villain, cards: [] }, pot: { currentPotBb: 1.5, villainBetBb: 0, callAmountBb: 0, finalPotBb: 1.5 }, stackState: { ...base.stackState, hero: { startingStackBb: 100, remainingStackBb: 100, isAllIn: false }, villain: { startingStackBb: 100, remainingStackBb: 99, isAllIn: false }, currentEffectiveStackBb: 99, spr: 66, canFullCall: false }, mathematicalContext: { ...base.mathematicalContext, requiredEquity: 0 } });
    const body = JSON.stringify(context);
    assert.equal(JSON.parse(body).language, language);
    let receivedPrompt = null;
    const response = await handleAnalyzeRequest(new Request('http://local/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' }, body }), async (prompt) => {
      receivedPrompt = prompt;
      throw new Error('stop at injected provider; no network request');
    });
    assert.equal(response.status, 502);
    assert.ok(receivedPrompt);
    assert.match(receivedPrompt.system, language === 'pl' ? /Write ALL natural-language content in Polish/ : /Write ALL natural-language content in English/);
  }
});

test('SPR labels, help text, and stack terminology are fully localized', () => {
  assert.equal(getSprCategory(0.99), 'very-low');
  assert.equal(getSprCategory(1), 'low');
  assert.equal(getSprCategory(3), 'medium');
  assert.equal(getSprCategory(6), 'medium');
  assert.equal(getSprCategory(6.01), 'high');
  assert.match(translate('pl', 'sprVeryLow'), /Bardzo niski SPR/);
  assert.match(translate('pl', 'sprHelp'), /stosunek pozostałego efektywnego stacka do puli/);
  assert.match(translate('en', 'sprHelp'), /ratio of the remaining effective stack to the pot/);
  assert.equal(translate('pl', 'callAllIn', { amount: '12' }), 'Call all-in: 12 BB');
  assert.equal(translate('en', 'callAllIn', { amount: '12' }), 'All-in call: 12 BB');
  assert.equal(formatNumber('pl', 2.4, 1), '2,4');
  assert.equal(formatNumber('en', 2.4, 1), '2.4');
  assert.equal(translate('pl', 'streetStart'), 'na początku ulicy');
  assert.equal(translate('en', 'streetStart'), 'at street start');
  const tPl = (key, values) => translate('pl', key, values);
  const tEn = (key, values) => translate('en', key, values);
  assert.equal(translateActionError('Gracz ma tylko 30.00 BB w stacku.', 'pl', tPl), 'Gracz ma tylko 30 BB w stacku.');
  assert.equal(translateActionError('Gracz ma tylko 30.00 BB w stacku.', 'en', tEn), 'Player has only 30 BB remaining.');
});

test('stack replay is locale-independent and AI receives deterministic stack and SPR facts', () => {
  const actions = [];
  const input = { hero: 'CO', villain: 'HJ' };
  const stacks = { hero: 100, villain: 60 };
  const plMath = calculateActionState(actions, input, { smallBlindBb: 0, bigBlindBb: 0 }, stacks, 'flop');
  const enMath = calculateActionState(actions, input, { smallBlindBb: 0, bigBlindBb: 0 }, stacks, 'flop');
  assert.deepEqual(plMath, enMath);
  assert.equal(plMath.startingEffectiveStackBb, 60);
  assert.equal(plMath.streetStartSpr, null); // zero pot cannot define an SPR
  const context = buildAIAnalysisContext({ ...base, villain: { ...base.villain, cards: [] }, stackState: { hero: { startingStackBb: 60, remainingStackBb: 40, isAllIn: false }, villain: { startingStackBb: 80, remainingStackBb: 50, isAllIn: false }, startingEffectiveStackBb: 60, currentEffectiveStackBb: 40, spr: 40 / 70, streetStartPotBb: 0, streetStartEffectiveStackBb: null, streetStartSpr: null, facingAllIn: false, canFullCall: true } });
  const prompt = buildPokerPrompt(validateAIAnalysisContext(context));
  assert.match(prompt.user, /"startingEffectiveStackBb": 60/);
  assert.match(prompt.system, /never recalculate, alter, or invent them/);
  assert.match(prompt.system, /Discuss SPR only as context, not as an automatic action rule/);
});

test('server missing-information copy can be presented in either language', () => {
  const tPl = (key, values) => translate('pl', key, values);
  const tEn = (key, values) => translate('en', key, values);
  const missing = 'Board is incomplete (3 of 5 cards).';
  assert.match(translateMissingInformation(missing, 'pl', tPl), /niekompletny/);
  assert.match(translateMissingInformation(missing, 'en', tEn), /incomplete/);
});

test('request protection failures have localized UI messages', () => {
  for (const key of ['errorUnsupportedMediaType', 'errorRequestOrigin', 'errorRequestSecurity']) {
    const pl = translate('pl', key), en = translate('en', key);
    assert.ok(pl.length > 10 && en.length > 10);
    assert.notEqual(pl, en);
    assert.notEqual(pl, key);
    assert.notEqual(en, key);
  }
  const ui = fs.readFileSync(require.resolve('../app/ai-mode.tsx'), 'utf8');
  assert.match(ui, /unsupported_media_type: t\('errorUnsupportedMediaType'\)/);
  assert.match(ui, /request_origin_forbidden: t\('errorRequestOrigin'\)/);
  assert.match(ui, /request_security_unavailable: t\('errorRequestSecurity'\)/);
});
