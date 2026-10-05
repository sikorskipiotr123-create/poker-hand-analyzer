import { AI_ANALYSIS_JSON_SCHEMA } from './ai-response';
import type { PromptParts } from './ai-analysis';

export type AnalysisServiceErrorCode = 'not_configured' | 'configuration_error' | 'billing_quota' | 'timeout' | 'network_error' | 'provider_error' | 'malformed_response';
export class AnalysisServiceError extends Error {
  constructor(readonly code: AnalysisServiceErrorCode) { super(code); this.name = 'AnalysisServiceError'; }
}

const DEFAULT_MODEL = 'gpt-5.6-terra';
export function getAIConfiguration() {
  return { apiKey: process.env.OPENAI_API_KEY?.trim() || null, model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL };
}

export type SafeProviderStatus = 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'queued' | 'in_progress' | 'unknown';
export type SafeIncompleteReason = 'max_output_tokens' | 'content_filter' | 'other' | 'unknown' | null;
export type ProviderResponseDiagnostics = {
  httpStatus: number;
  responseStatus: SafeProviderStatus;
  incompleteReason: SafeIncompleteReason;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  responseDurationMs: number;
};
export type MalformedResponseCategory = 'incomplete_response' | 'output_token_exhaustion' | 'invalid_provider_json' | 'missing_structured_response' | 'other_malformed_response';

const RESPONSE_STATUSES = new Set<SafeProviderStatus>(['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress']);
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function safeStatus(value: unknown): SafeProviderStatus {
  return typeof value === 'string' && RESPONSE_STATUSES.has(value as SafeProviderStatus) ? value as SafeProviderStatus : 'unknown';
}
function safeIncompleteReason(value: unknown): SafeIncompleteReason {
  if (value === 'max_output_tokens' || value === 'content_filter') return value;
  if (typeof value === 'string' && value.length > 0) return 'other';
  return 'unknown';
}
function makeDiagnostics(payload: unknown, httpStatus: number, startedAt: number): ProviderResponseDiagnostics {
  const record = isObject(payload) ? payload : {};
  const incompleteDetails = isObject(record.incomplete_details) ? record.incomplete_details : {};
  const usage = isObject(record.usage) ? record.usage : {};
  const inputDetails = isObject(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return {
    httpStatus,
    responseStatus: safeStatus(record.status),
    incompleteReason: record.status === 'incomplete' ? safeIncompleteReason(incompleteDetails.reason) : null,
    inputTokens: safeCount(usage.input_tokens),
    outputTokens: safeCount(usage.output_tokens),
    cachedTokens: safeCount(inputDetails.cached_tokens),
    reasoningTokens: safeCount(outputDetails.reasoning_tokens),
    responseDurationMs: Date.now() - startedAt,
  };
}
function logMalformedResponse(category: MalformedResponseCategory, diagnostics: ProviderResponseDiagnostics, extra: Record<string, number | string> = {}): void {
  console.error('[OpenAI Responses API] malformed response', { category, ...diagnostics, ...extra });
}

function extractText(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) return payload.output_text;
  if (!Array.isArray(payload.output)) return null;
  const content = payload.output.flatMap((item) => isObject(item) && Array.isArray(item.content) ? item.content : []);
  const text = content.find((item) => isObject(item) && item.type === 'output_text' && typeof item.text === 'string');
  return text && isObject(text) && typeof text.text === 'string' ? text.text : null;
}

export type ProviderResponseObserver = (diagnostics: ProviderResponseDiagnostics) => void;

/** OpenAI Responses API adapter. Secrets and model configuration never enter client code. */
export async function requestOpenAIAnalysis(prompt: PromptParts, signal: AbortSignal, observeResponse?: ProviderResponseObserver): Promise<unknown> {
  const { apiKey, model } = getAIConfiguration();
  if (!apiKey) throw new AnalysisServiceError('not_configured');
  const requestStartedAt = Date.now();
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        store: false,
        // The cap includes hidden reasoning tokens, so leave room for the full JSON review.
        max_output_tokens: 25_000,
        reasoning: { effort: 'low' },
        input: [
          { role: 'system', content: [{ type: 'input_text', text: prompt.system }] },
          { role: 'user', content: [{ type: 'input_text', text: prompt.user }] },
        ],
        text: { format: { type: 'json_schema', name: 'poker_hand_review', strict: true, schema: AI_ANALYSIS_JSON_SCHEMA } },
      }),
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error('[OpenAI Responses API] network request failed', { errorName, aborted: signal.aborted, elapsedMs: Date.now() - requestStartedAt, timeoutSource: signal.aborted ? 'application_provider_deadline' : errorName === 'TimeoutError' ? 'provider_transport' : 'network_connection' });
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new AnalysisServiceError('timeout');
    throw new AnalysisServiceError('network_error');
  }
  if (!response.ok) {
    // Log only provider status metadata. Never log request headers, request bodies, or credentials.
    let providerError: Record<string, unknown> = {};
    try {
      const payload: unknown = await response.clone().json();
      if (isObject(payload) && isObject(payload.error)) providerError = payload.error;
    } catch { /* Some upstream failures return no JSON body. */ }
    console.error('[OpenAI Responses API] request rejected', {
      status: response.status,
      elapsedMs: Date.now() - requestStartedAt,
      type: typeof providerError.type === 'string' ? providerError.type : undefined,
      code: typeof providerError.code === 'string' ? providerError.code : undefined,
      param: typeof providerError.param === 'string' ? providerError.param : undefined,
    });
    if (response.status === 401) throw new AnalysisServiceError('not_configured');
    if ([403, 404].includes(response.status)) throw new AnalysisServiceError('configuration_error');
    if (response.status === 402 || ['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active', 'usage_limit_reached'].includes(String(providerError.code))) throw new AnalysisServiceError('billing_quota');
    if (response.status === 408 || response.status === 504) throw new AnalysisServiceError('timeout');
    throw new AnalysisServiceError('provider_error');
  }

  let payload: unknown;
  try { payload = await response.json(); } catch {
    logMalformedResponse('invalid_provider_json', {
      httpStatus: response.status,
      responseStatus: 'unknown',
      incompleteReason: null,
      responseDurationMs: Date.now() - requestStartedAt,
    }, { source: 'response_body' });
    throw new AnalysisServiceError('malformed_response');
  }

  const diagnostics = makeDiagnostics(payload, response.status, requestStartedAt);
  if (!isObject(payload)) {
    logMalformedResponse('other_malformed_response', diagnostics, { source: 'response_payload' });
    throw new AnalysisServiceError('malformed_response');
  }
  if (diagnostics.responseStatus !== 'completed') {
    const category = diagnostics.responseStatus === 'incomplete'
      ? diagnostics.incompleteReason === 'max_output_tokens' ? 'output_token_exhaustion' : 'incomplete_response'
      : 'other_malformed_response';
    logMalformedResponse(category, diagnostics, { source: 'response_status' });
    throw new AnalysisServiceError('malformed_response');
  }

  const text = extractText(payload);
  if (!text) {
    logMalformedResponse('missing_structured_response', diagnostics, { source: 'output_text' });
    throw new AnalysisServiceError('malformed_response');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    logMalformedResponse('invalid_provider_json', diagnostics, { source: 'structured_output_text', outputCharacters: text.length });
    throw new AnalysisServiceError('malformed_response');
  }

  observeResponse?.(diagnostics);
  console.info('[OpenAI Responses API] response completed', {
    httpStatus: diagnostics.httpStatus,
    status: diagnostics.responseStatus,
    elapsedMs: diagnostics.responseDurationMs,
    inputTokens: diagnostics.inputTokens,
    outputTokens: diagnostics.outputTokens,
    cachedTokens: diagnostics.cachedTokens,
    reasoningTokens: diagnostics.reasoningTokens,
  });
  return parsed;
}
