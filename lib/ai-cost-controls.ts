/** Server-only operational policy. No request field can select these limits. */
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 16_000;
export const DEFAULT_AI_MAX_CONCURRENT_REQUESTS = 3;
export class AICostConfigurationError extends Error {
  constructor() { super('AI cost controls are misconfigured.'); }
}
function integerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new AICostConfigurationError();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new AICostConfigurationError();
  return number;
}
export function getAICostPolicy() {
  const disabled = process.env.AI_ANALYSIS_DISABLED;
  if (disabled !== undefined && disabled !== 'true' && disabled !== 'false') throw new AICostConfigurationError();
  return {
    disabled: disabled === 'true',
    maxOutputTokens: integerSetting(process.env.AI_MAX_OUTPUT_TOKENS, DEFAULT_AI_MAX_OUTPUT_TOKENS, 8_192, 25_000),
    maxConcurrentRequests: integerSetting(process.env.AI_MAX_CONCURRENT_REQUESTS, DEFAULT_AI_MAX_CONCURRENT_REQUESTS, 1, 10),
  };
}
