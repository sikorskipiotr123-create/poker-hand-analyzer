import { AI_ANALYSIS_JSON_SCHEMA } from './ai-response';
import type { PromptParts } from './ai-analysis';

export type AnalysisServiceErrorCode = 'not_configured' | 'configuration_error' | 'billing_quota' | 'timeout' | 'network_error' | 'provider_error' | 'malformed_response';
export class AnalysisServiceError extends Error {
  constructor(readonly code: AnalysisServiceErrorCode) { super(code); this.name = 'AnalysisServiceError'; }
}

const DEFAULT_MODEL = 'gpt-6-astra';
export function getAIConfiguration() {
  return { apiKey: process.env.OPENAI_API_KEY?.trim() || null, model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL };
}

function extractText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const response = payload as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === 'string' && response.output_text.length > 0) return response.output_text;
  if (!Array.isArray(response.output)) return null;
  const content = response.output.flatMap((item) => typeof item === 'object' && item !== null && 'content' in item && Array.isArray(item.content) ? item.content : []);
  const text = content.find((item) => typeof item === 'object' && item !== null && 'type' in item && item.type === 'output_text' && 'text' in item);
  return text && typeof text === 'object' && 'text' in text && typeof text.text === 'string' ? text.text : null;
}

/** OpenAI Responses API adapter. Secrets and model configuration never enter client code. */
export async function requestOpenAIAnalysis(prompt: PromptParts, signal: AbortSignal): Promise<unknown> {
  const { apiKey, model } = getAIConfiguration();
  if (!apiKey) throw new AnalysisServiceError('not_configured');
  const requestStartedAt = Date.now();
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
      if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'object' && payload.error !== null) {
        providerError = payload.error as Record<string, unknown>;
      }
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
    console.error('[OpenAI Responses API] success response was not valid JSON', { httpStatus: response.status, elapsedMs: Date.now() - requestStartedAt });
    throw new AnalysisServiceError('malformed_response');
  }
  const responseMetadata = typeof payload === 'object' && payload !== null ? payload as { status?: unknown; incomplete_details?: { reason?: unknown }; usage?: { output_tokens?: unknown; output_tokens_details?: { reasoning_tokens?: unknown } } } : {};
  const outputTokens = typeof responseMetadata.usage?.output_tokens === 'number' ? responseMetadata.usage.output_tokens : undefined;
  const reasoningTokens = typeof responseMetadata.usage?.output_tokens_details?.reasoning_tokens === 'number' ? responseMetadata.usage.output_tokens_details.reasoning_tokens : undefined;
  if (responseMetadata.status !== 'completed') {
    console.error('[OpenAI Responses API] response was not completed', {
      httpStatus: response.status,
      status: responseMetadata.status,
      reason: typeof responseMetadata.incomplete_details?.reason === 'string' ? responseMetadata.incomplete_details.reason : 'unknown',
      elapsedMs: Date.now() - requestStartedAt,
      outputTokens,
      reasoningTokens,
    });
    throw new AnalysisServiceError('malformed_response');
  }
  const text = extractText(payload);
  if (!text) {
    const responsePayload = typeof payload === 'object' && payload !== null ? payload as { status?: unknown; incomplete_details?: { reason?: unknown } } : {};
    console.error('[OpenAI Responses API] completed response did not contain output text', {
      httpStatus: response.status,
      status: responsePayload.status,
      incompleteReason: responsePayload.incomplete_details?.reason,
      elapsedMs: Date.now() - requestStartedAt,
      outputTokens,
      reasoningTokens,
    });
    throw new AnalysisServiceError('malformed_response');
  }
  try {
    const parsed: unknown = JSON.parse(text);
    console.info('[OpenAI Responses API] response completed', { httpStatus: response.status, status: responseMetadata.status, elapsedMs: Date.now() - requestStartedAt, outputTokens, reasoningTokens });
    return parsed;
  } catch {
    console.error('[OpenAI Responses API] structured output was not valid JSON', {
      httpStatus: response.status,
      status: responseMetadata.status,
      incompleteReason: responseMetadata.incomplete_details?.reason,
      elapsedMs: Date.now() - requestStartedAt,
      outputTokens,
      reasoningTokens,
      outputCharacters: text.length,
    });
    throw new AnalysisServiceError('malformed_response');
  }
}
