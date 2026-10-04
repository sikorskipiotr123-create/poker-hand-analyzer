import { AnalysisInputError, buildPokerPrompt, MAX_ANALYSIS_BODY_BYTES, validateAIAnalysisContext } from './ai-analysis';
import { validateAIAnalysisResult } from './ai-response';
import { AnalysisServiceError, type AnalysisServiceErrorCode } from './ai-provider';
import type { PromptParts } from './ai-analysis';
import { checkAnalyzeRateLimit, type RateLimitDecision } from './analyze-rate-limit';

export type AnalysisProvider = (prompt: PromptParts, signal: AbortSignal) => Promise<unknown>;
type AnalyzeErrorCode = AnalysisServiceErrorCode | 'rate_limited' | 'rate_limit_unavailable';
const errorMessages: Record<AnalyzeErrorCode, string> = {
  not_configured: 'AI analysis is not configured. Add a server-side API key to enable it.',
  configuration_error: 'AI model configuration is unavailable.',
  billing_quota: 'AI service usage or billing limit was reached.',
  timeout: 'The AI analysis took too long. Please try again.',
  network_error: 'Could not connect to the AI provider.',
  provider_error: 'The AI service is temporarily unavailable. Please try again.',
  malformed_response: 'The AI service returned an unreadable analysis. Please try again.',
  rate_limited: 'Too many AI analyses were requested. Please wait before trying again.',
  rate_limit_unavailable: 'AI analysis is temporarily unavailable because usage protection is not configured.',
};
function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders } });
}
function isTimeout(error: unknown, signal: AbortSignal) { return signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')); }

/** Request handler is provider-injectable so all route behavior can be tested without paid API calls. */
export type AnalysisRateLimiter = (request: Request) => Promise<RateLimitDecision>;

export async function handleAnalyzeRequest(request: Request, provider: AnalysisProvider, rateLimiter: AnalysisRateLimiter = checkAnalyzeRateLimit): Promise<Response> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > MAX_ANALYSIS_BODY_BYTES) return json({ error: 'request_too_large', message: 'Analysis request is too large.' }, 413);
  let raw: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'invalid_request', message: 'Analysis request body is required.' }, 400);
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ANALYSIS_BODY_BYTES) {
        await reader.cancel();
        return json({ error: 'request_too_large', message: 'Analysis request is too large.' }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    raw = new TextDecoder().decode(bytes);
  } catch { return json({ error: 'invalid_request', message: 'Analysis request could not be read.' }, 400); }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_request', message: 'Request body must be valid JSON.' }, 400); }
  let context;
  try { context = validateAIAnalysisContext(body); }
  catch (error) {
    const message = error instanceof AnalysisInputError ? error.message : 'Analysis input is invalid.';
    const code = /action history|action position|action resolution/i.test(message) ? 'invalid_action_history' : /card|board|hero|villain|range|position|profile|statistics|stack|spr|pot|equity|ev/i.test(message) ? 'invalid_hand_data' : 'invalid_input';
    console.warn('[Analyze API] request validation failed', { code });
    return json({ error: code, message }, 400);
  }
  const rateLimit = await rateLimiter(request);
  if (rateLimit.status === 'unavailable') {
    console.error('[Analyze API] request blocked because shared rate limiting is unavailable');
    return json({ error: 'rate_limit_unavailable', message: errorMessages.rate_limit_unavailable }, 503);
  }
  if (rateLimit.status === 'limited') {
    return json({ error: 'rate_limited', message: errorMessages.rate_limited }, 429, { 'Retry-After': String(rateLimit.retryAfterSeconds) });
  }
  const prompt = buildPokerPrompt(context);
  const timeout = AbortSignal.timeout(60_000);
  let rawResult: unknown;
  const providerStartedAt = Date.now();
  try { rawResult = await provider(prompt, timeout); }
  catch (error) {
    const code: AnalysisServiceErrorCode = error instanceof AnalysisServiceError ? error.code : isTimeout(error, timeout) ? 'timeout' : 'provider_error';
    console.error('[Analyze API] provider failed', { code, elapsedMs: Date.now() - providerStartedAt, timeoutSource: code === 'timeout' ? timeout.aborted ? 'application_provider_deadline' : 'provider_or_transport_timeout' : undefined });
    return json({ error: code, message: errorMessages[code] }, code === 'not_configured' || code === 'configuration_error' ? 503 : code === 'timeout' ? 504 : code === 'billing_quota' ? 429 : 502);
  }
  try { return json({ result: validateAIAnalysisResult(rawResult, context) }, 200); }
  catch {
    console.error('[Analyze API] structured response validation failed');
    return json({ error: 'malformed_response', message: errorMessages.malformed_response }, 502);
  }
}
