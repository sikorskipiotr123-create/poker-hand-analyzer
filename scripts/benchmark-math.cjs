// Offline benchmark: synthetic deals; no provider, Redis, environment files or network.
const { fixture, action, checksToRiver } = require('../lib/test-support/analysis-fixture.cjs');
const { validateAIAnalysisContext } = require('../lib/ai-analysis.ts');
const { verifyDeterministicMath, verifyEquity } = require('../lib/verify-analysis-math.ts');
const { RANGE_HANDS } = require('../lib/range.ts');
const os = require('node:os');
const cases = [
  ['river known hand', fixture()],
  ['turn known hand', fixture({ board: ['Qs', '7d', '4c', '2h'], actions: [...checksToRiver.slice(0, 4), action('turn', 'villain', 'bet', 20)] })],
  ['flop known hand', fixture({ board: ['Qs', '7d', '4c'], actions: [...checksToRiver.slice(0, 2), action('flop', 'villain', 'bet', 20)] })],
  ['river full range', fixture({ villain: [], range: RANGE_HANDS.map(hand => hand.label) })],
  ['turn full range / unknown', fixture({ board: ['Qs', '7d', '4c', '2h'], actions: [], villain: [], range: RANGE_HANDS.map(hand => hand.label) })],
  ['preflop / unknown', fixture({ board: [], actions: [] })],
  ['60-action replay / preflop', fixture({ board: [], actions: Array.from({ length: 60 }, (_, index) => action('preflop', index % 2 === 0 ? 'hero' : 'villain', 'raise', index + 2)), stacks: { hero: 1000, villain: 1000 } })],
  ['Auto / unknown', fixture({ villain: [], equity: { status: 'unknown', reason: 'auto-range' } })],
];
(async () => {
  const results = [];
  for (const [name, input] of cases) {
    const timings = [], pauses = [];
    let result;
    for (let trial = 0; trial < 12; trial++) {
      let lastTick = performance.now(), maxPause = 0;
      const timer = setInterval(() => { const now = performance.now(); maxPause = Math.max(maxPause, now - lastTick); lastTick = now; }, 1);
      const started = performance.now();
      result = await verifyEquity(verifyDeterministicMath(validateAIAnalysisContext(input)));
      const elapsed = performance.now() - started;
      maxPause = Math.max(maxPause, performance.now() - lastTick);
      clearInterval(timer);
      if (trial >= 2) { timings.push(elapsed); pauses.push(maxPause); }
    }
    timings.sort((a, b) => a - b);
    results.push({ case: name, medianMs: +timings[5].toFixed(2), maxMs: +timings.at(-1).toFixed(2), maxTimerGapMs: +Math.max(...pauses).toFixed(2), equity: result.mathematicalContext.equity.status === 'known' ? { method: result.mathematicalContext.equity.method, cases: result.mathematicalContext.equity.evaluatedCases } : result.mathematicalContext.equity });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model, warmups: 2, measuredRuns: 10, results }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
