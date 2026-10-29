import { randomUUID } from 'node:crypto';
import { getRedisConfig, sendRedisCommand } from './analyze-rate-limit';
import { createDeadline, throwIfCancelled } from './request-cancellation';

export const AI_CONCURRENCY_KEY = 'poker-analyze:openai:active:v1';
// Longer than the 65-second function lifetime; no heartbeat/renewal or unbounded waiting.
export const AI_CONCURRENCY_LEASE_MS = 75_000;
export const AI_SLOT_RELEASE_DEADLINE_MS = 1_000;
export const ACQUIRE_AI_SLOT_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local limit = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
if not limit or limit < 1 or limit > 10 or limit ~= math.floor(limit) or lease ~= 75000 then return {-1, 0} end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {1, math.max(1, math.ceil((tonumber(first[2]) - now) / 1000))}
end
local added = redis.call('ZADD', KEYS[1], 'NX', now + lease, ARGV[3])
if added ~= 1 then return {-1, 0} end
redis.call('PEXPIRE', KEYS[1], lease + 1000)
return {0, 0}
`;
export const RELEASE_AI_SLOT_SCRIPT = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return removed
`;
export type AIConcurrencyAdmission =
  | { status: 'allowed'; release: () => Promise<void> }
  | { status: 'limited'; retryAfterSeconds: number }
  | { status: 'unavailable' };
export type AIConcurrencyLimiter = (signal: AbortSignal, maximum: number) => Promise<AIConcurrencyAdmission>;

/** Independent factories have no process-local capacity state: all instances use one Redis key. */
export function createRedisConcurrencyLimiter(): AIConcurrencyLimiter {
  return async (signal, maximum) => {
    throwIfCancelled(signal);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10) return { status: 'unavailable' };
    let config: ReturnType<typeof getRedisConfig>;
    try { config = getRedisConfig(); } catch { return { status: 'unavailable' }; }
    const owner = randomUUID(); // Private per-acquisition token; never sent to the browser or logged.
    let released: Promise<void> | undefined;
    const release = () => released ??= (async () => {
      // Cleanup is independent of a disconnected client; one attempt, bounded to one second.
      const deadline = createDeadline(undefined, AI_SLOT_RELEASE_DEADLINE_MS, 'redis');
      try {
        const { result } = await sendRedisCommand(config, ['EVAL', RELEASE_AI_SLOT_SCRIPT, '1', AI_CONCURRENCY_KEY, owner], deadline.signal);
        if (result !== 0 && result !== 1) throw new Error('Invalid slot release result.');
      } catch {
        console.error('[Analyze API] concurrency slot cleanup unavailable; lease will expire');
      } finally { deadline.dispose(); }
    })();
    try {
      const { result } = await sendRedisCommand(config, ['EVAL', ACQUIRE_AI_SLOT_SCRIPT, '1', AI_CONCURRENCY_KEY, String(maximum), String(AI_CONCURRENCY_LEASE_MS), owner], signal);
      throwIfCancelled(signal);
      if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid slot admission result.');
      if (result[0] === 1 && Number.isInteger(result[1]) && result[1] >= 1 && result[1] <= 75) return { status: 'limited', retryAfterSeconds: result[1] };
      if (result[0] !== 0 || result[1] !== 0) throw new Error('Invalid slot admission result.');
      return { status: 'allowed', release };
    } catch {
      // Admission may have committed even if its HTTP response was lost. Release only our token.
      // If cleanup races a late commit, the 75-second lease remains the final recovery mechanism.
      await release();
      throwIfCancelled(signal);
      return { status: 'unavailable' };
    }
  };
}
export const acquireAnalysisSlot = createRedisConcurrencyLimiter();
