import { translate } from './i18n';
import { getAICostPolicy } from './ai-cost-controls';
import { acquireAnalysisSlot, type AIConcurrencyLimiter, type AIConcurrencyAdmission } from './analyze-concurrency';
import { AnalysisBodyError, readAnalysisBody } from './analyze-request-body';
import { ANALYZE_BODY_DEADLINE_MS, ANALYZE_PROVIDER_DEADLINE_MS, ANALYZE_REQUEST_DEADLINE_MS, OperationCancelledError, awaitWithSignal, createDeadline } from './request-cancellation';
import { checkAnalyzeAccess, BASIC_AUTH_CHALLENGE } from './analyze-access';
import { API_SECURITY_HEADERS } from './security-headers';
import { verifyDeterministicMath, verifyEquity } from './verify-analysis-math';
import { checkAnalyzeRequestSecurity } from './analyze-request-security';
import { AnalysisInputError, buildPokerPrompt, validateAIAnalysisContext } from './ai-analysis';
import { AIResponseValidationError, validateAIAnalysisResult } from './ai-response';
import { AnalysisServiceError, type AnalysisServiceErrorCode, type ProviderResponseDiagnostics } from './ai-provider';
import type { AIAnalysisContext } from './ai-context';
import type { PromptParts } from './ai-analysis';
import { checkAnalyzeAttemptLimit, checkAnalyzeRateLimit, type RateLimitDecision } from './analyze-rate-limit';

export type AnalysisProvider = (prompt: PromptParts, signal: AbortSignal, observeResponse?: (diagnostics: ProviderResponseDiagnostics) => void) => Promise<unknown>;
type AnalyzeErrorCode = AnalysisServiceErrorCode | 'ip_daily_limit_reached' | 'rate_limited' | 'daily_limit_reached' | 'rate_limit_unavailable' | 'ai_busy' | 'ai_concurrency_unavailable';
const errorMessages: Record<AnalyzeErrorCode, string> = {
  ai_disabled: 'AI analysis is temporarily paused. Mathematical Analysis remains available.',
  ai_limits_configuration_error: 'AI analysis is temporarily unavailable because its operational configuration is invalid.',
  ai_busy: 'All AI analysis slots are busy. Please try again shortly.',
  ai_concurrency_unavailable: 'AI analysis is temporarily unavailable. Please try again later.',
  not_configured: 'AI analysis is not configured. Add a server-side API key to enable it.',
  configuration_error: 'AI model configuration is unavailable.',
  billing_quota: 'AI service usage or billing limit was reached.',
  timeout: 'The AI analysis took too long. Please try again.',
  network_error: 'Could not connect to the AI provider.',
  provider_error: 'The AI service is temporarily unavailable. Please try again.',
  malformed_response: 'The AI service returned an unreadable analysis. Please try again.',
  ip_daily_limit_reached: 'The daily limit of 5 AI analyses for this IP has been reached. It resets at 00:00 UTC.',
  rate_limited: 'Too many AI analyses were requested. Please wait before trying again.',
  daily_limit_reached: 'Today’s AI analysis limit has been reached. Please try again after the daily reset.',
  rate_limit_unavailable: 'AI analysis is temporarily unavailable. Please try again later.',
};
function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders } });
}
function isTimeout(error: unknown, signal: AbortSignal) { return signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')); }

/** Request handler is provider-injectable so all route behavior can be tested without paid API calls. */
export type AnalysisRateLimiter = (request: Request, signal?: AbortSignal) => Promise<RateLimitDecision>;

/** Optional shorter deadlines are an internal test seam, never request-controlled configuration. */
type AnalysisDeadlines = { requestMs: number; bodyMs: number; providerMs: number };
export async function handleAnalyzeRequest(request: Request, provider: AnalysisProvider, rateLimiter: AnalysisRateLimiter = checkAnalyzeRateLimit, deadlines: Partial<AnalysisDeadlines> = {}, concurrency: AIConcurrencyLimiter = acquireAnalysisSlot, attemptLimiter: AnalysisRateLimiter = checkAnalyzeAttemptLimit): Promise<Response> {
  const shorter = (value: number | undefined, maximum: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : maximum;
  const whole = createDeadline(request.signal, shorter(deadlines.requestMs, ANALYZE_REQUEST_DEADLINE_MS), 'request');
  try {
    whole.check();
    return await analyzeWithinDeadline(request, provider, rateLimiter, whole, shorter(deadlines.bodyMs, ANALYZE_BODY_DEADLINE_MS), shorter(deadlines.providerMs, ANALYZE_PROVIDER_DEADLINE_MS), concurrency, attemptLimiter);
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      return error.source === 'client'
        ? json({ error: 'invalid_request', message: 'Analysis request was cancelled.' }, 400)
        : json({ error: 'timeout', message: errorMessages.timeout }, error.source === 'body' ? 408 : 504);
    }
    throw error;
  } finally { whole.dispose(); }
}

async function analyzeWithinDeadline(request: Request, provider: AnalysisProvider, rateLimiter: AnalysisRateLimiter, whole: ReturnType<typeof createDeadline>, bodyMs: number, providerMs: number, concurrency: AIConcurrencyLimiter, attemptLimiter: AnalysisRateLimiter): Promise<Response> {
  const accessFailure = await awaitWithSignal(whole.signal, () => checkAnalyzeAccess(request));
  whole.check();
  if (accessFailure) return json({ error: accessFailure.error }, accessFailure.status, accessFailure.status === 401 ? { 'WWW-Authenticate': BASIC_AUTH_CHALLENGE } : {});
  const securityFailure = checkAnalyzeRequestSecurity(request);
  whole.check();
  if (securityFailure) return json({ error: securityFailure.error, message: securityFailure.message }, securityFailure.status);
  let policy: ReturnType<typeof getAICostPolicy>;
  try { policy = getAICostPolicy(); } catch { return json({ error: 'ai_limits_configuration_error', message: errorMessages.ai_limits_configuration_error }, 503); }
  if (policy.disabled) return json({ error: 'ai_disabled', message: errorMessages.ai_disabled }, 503);
  const attempt = await awaitWithSignal(whole.signal, () => attemptLimiter(request, whole.signal));
  whole.check();
  if (attempt.status === 'unavailable') return json({ error: 'rate_limit_unavailable', message: errorMessages.rate_limit_unavailable }, 503);
  if (attempt.status === 'limited') return json({ error: 'rate_limited', message: errorMessages.rate_limited }, 429, { 'Retry-After': String(attempt.retryAfterSeconds) });
  let raw: string;
  try { raw = await readAnalysisBody(request, whole.signal, bodyMs); }
  catch (error) {
    // Cancelling an incoming stream can itself mark the transport disconnected.
    // Preserve the initiating timeout/size error rather than reclassifying our cleanup as a client abort.
    if (error instanceof OperationCancelledError) throw error;
    if (error instanceof AnalysisBodyError && error.code === 'request_too_large') return json({ error: 'request_too_large', message: 'Analysis request is too large.' }, 413);
    whole.check();
    return json({ error: 'invalid_request', message: 'Analysis request could not be read.' }, 400);
  }
  whole.check();
  let body: unknown;
  try { body = JSON.parse(raw); } catch { whole.check(); return json({ error: 'invalid_request', message: 'Request body must be valid JSON.' }, 400); }
  whole.check();
  let context: AIAnalysisContext;
  try { context = verifyDeterministicMath(validateAIAnalysisContext(body)); }
  catch (error) {
    whole.check();
    const message = error instanceof AnalysisInputError ? error.message : 'Analysis input is invalid.';
    const code = /action history|action position|action resolution/i.test(message) ? 'invalid_action_history' : /card|board|hero|villain|range|position|profile|statistics|stack|spr|pot|equity|ev/i.test(message) ? 'invalid_hand_data' : 'invalid_input';
    console.warn('[Analyze API] request validation failed', { code });
    return json({ error: code, message }, 400);
  }
  whole.check();
  let slot: Extract<AIConcurrencyAdmission, { status: 'allowed' }> | undefined;
  try {
    const admission = await awaitWithSignal(whole.signal, async () => {
      const value = await concurrency(whole.signal, policy.maxConcurrentRequests);
      if (value.status === 'allowed') {
        if (whole.signal.aborted) await value.release();
        else slot = value;
      }
      return value;
    });
    whole.check();
    if (admission.status === 'unavailable') return json({ error: 'ai_concurrency_unavailable', message: errorMessages.ai_concurrency_unavailable }, 503);
    if (admission.status === 'limited') return json({ error: 'ai_busy', message: errorMessages.ai_busy }, 429, { 'Retry-After': String(admission.retryAfterSeconds) });
    try { context = await awaitWithSignal(whole.signal, () => verifyEquity(context, whole.signal)); whole.check(); }
    catch (error) {
      whole.check();
      if (error instanceof OperationCancelledError) throw error;
      if (error instanceof AnalysisInputError) return json({ error: 'invalid_hand_data', message: error.message }, 400);
      return json({ error: 'math_verification_unavailable', message: 'Mathematical verification is temporarily unavailable.' }, 503);
    }
    whole.check();
    try { policy = getAICostPolicy(); } catch { return json({ error: 'ai_limits_configuration_error', message: errorMessages.ai_limits_configuration_error }, 503); }
    if (policy.disabled) return json({ error: 'ai_disabled', message: errorMessages.ai_disabled }, 503);
    const prompt = buildPokerPrompt(context);
    whole.check();
    const rateLimit = await awaitWithSignal(whole.signal, () => rateLimiter(request, whole.signal));
    whole.check();
    if (rateLimit.status === 'unavailable') {
      console.error('[Analyze API] request blocked because shared rate limiting is unavailable');
      return json({ error: 'rate_limit_unavailable', message: errorMessages.rate_limit_unavailable }, 503);
    }
    if (rateLimit.status === 'limited') {
      const code = rateLimit.scope === 'global' ? 'daily_limit_reached' : 'ip_daily_limit_reached';
      return json({ error: code, message: translate(context.language, code === 'ip_daily_limit_reached' ? 'errorIPDailyLimitReached' : 'errorDailyLimitReached'), ...(rateLimit.resetAt ? { resetAt: rateLimit.resetAt } : {}) }, 429, { 'Retry-After': String(rateLimit.retryAfterSeconds) });
    }
    try { policy = getAICostPolicy(); } catch { return json({ error: 'ai_limits_configuration_error', message: errorMessages.ai_limits_configuration_error }, 503); }
    if (policy.disabled) return json({ error: 'ai_disabled', message: errorMessages.ai_disabled }, 503);
    const providerDeadline = createDeadline(whole.signal, providerMs, 'provider');
    const timeout = providerDeadline.signal;
    let rawResult: unknown;
    let providerDiagnostics: ProviderResponseDiagnostics | undefined;
    const providerStartedAt = Date.now();
    try { rawResult = await awaitWithSignal(timeout, () => provider(prompt, timeout, (diagnostics) => { providerDiagnostics = diagnostics; })); whole.check(); providerDeadline.check(); }
    catch (error) {
      whole.check();
      if (error instanceof OperationCancelledError) throw error;
      const code: AnalysisServiceErrorCode = error instanceof AnalysisServiceError ? error.code : isTimeout(error, timeout) ? 'timeout' : 'provider_error';
      console.error('[Analyze API] provider failed', { code, elapsedMs: Date.now() - providerStartedAt, timeoutSource: code === 'timeout' ? timeout.aborted ? 'application_provider_deadline' : 'provider_or_transport_timeout' : undefined });
      return json({ error: code, message: errorMessages[code] }, ['ai_disabled', 'ai_limits_configuration_error', 'not_configured', 'configuration_error'].includes(code) ? 503 : code === 'timeout' ? 504 : code === 'billing_quota' ? 429 : 502);
    }
    finally { providerDeadline.dispose(); }
    whole.check();
    try {
      const result = validateAIAnalysisResult(rawResult, context);
      whole.check();
      const response = json({ result, verifiedMath: { mathematicalContext: context.mathematicalContext, pot: context.pot } }, 200);
      whole.check();
      return response;
    }
    catch (error) {
      whole.check();
      if (error instanceof OperationCancelledError) throw error;
      if (error instanceof AIResponseValidationError) {
        console.error('[Analyze API] structured response validation failed', {
          category: 'runtime_schema_validation_failure',
          fieldPath: error.fieldPath,
          validationCategory: error.category,
          constraint: error.constraint,
          ...providerDiagnostics,
        });
      } else {
        console.error('[Analyze API] structured response validation failed', {
          category: 'other_malformed_response',
          fieldPath: '$',
          validationCategory: 'unexpected_validator_error',
          ...providerDiagnostics,
        });
      }
      return json({ error: 'malformed_response', message: errorMessages.malformed_response }, 502);
    }
  } finally { if (slot) await slot.release(); }
}
