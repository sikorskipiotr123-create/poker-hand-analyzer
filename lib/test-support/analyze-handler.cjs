// Explicit quota/concurrency injection for isolated handler/provider tests.
// Production always uses Redis; this helper is never imported by application code.
const { handleAnalyzeRequest: actual } = require('../analyze-handler.ts');
const { throwIfCancelled } = require('../request-cancellation.ts');
exports.handleAnalyzeRequest = (request, provider, limiter, deadlines, attemptLimiter) => actual(request, provider, limiter ?? (async signalRequest => { throwIfCancelled(signalRequest.signal); return { status: 'allowed' }; }), deadlines, async signal => {
  throwIfCancelled(signal);
  return { status: 'allowed', release: async () => {} };
}, attemptLimiter ?? (async (_request, signal) => { throwIfCancelled(signal); return { status: 'allowed' }; }));
