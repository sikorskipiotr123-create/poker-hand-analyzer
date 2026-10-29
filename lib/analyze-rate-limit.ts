import { awaitWithSignal, createDeadline, throwIfCancelled } from './request-cancellation';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export const ANALYZE_RATE_LIMIT = 5;
export const ANALYZE_RATE_WINDOW_SECONDS = 10 * 60;
export const GLOBAL_ANALYZE_DAILY_LIMIT = 100;
// Cheap abuse protection is separate from the unchanged validated-analysis quota.
export const ANALYZE_ATTEMPT_IP_LIMIT = 20;
export const ANALYZE_ATTEMPT_GLOBAL_LIMIT = 1_000;
const RATE_WINDOW_MS = ANALYZE_RATE_WINDOW_SECONDS * 1000;
const REDIS_TIMEOUT_MS = 2_000;

export type RedisFailureCategory =
  | 'missing_environment_variable'
  | 'missing_client_ip'
  | 'invalid_client_ip'
  | 'untrusted_client_ingress'
  | 'invalid_redis_url'
  | 'redis_timeout'
  | 'redis_network_error'
  | 'redis_http_401_403'
  | 'redis_http_other'
  | 'malformed_redis_response'
  | 'invalid_lua_result';

class RedisRateLimitError extends Error {
  constructor(readonly category: RedisFailureCategory, readonly httpStatus?: number) {
    super(category);
    this.name = 'RedisRateLimitError';
  }
}

type RedisConfig = { endpoint: URL; token: string };
type RedisCommandResult = { result: unknown; httpStatus: number };

function logRedisFailure(category: RedisFailureCategory, metadata: Record<string, string | number> = {}): void {
  if (process.env.NODE_ENV !== 'production') return;
  // Metadata is built only from fixed labels/status codes; never include request or provider data.
  console.error(JSON.stringify({ event: 'upstash_rate_limiter_failure', category, ...metadata }));
}

export function getRedisConfig(): RedisConfig {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!restUrl || !restToken) {
    throw new RedisRateLimitError('missing_environment_variable');
  }

  let endpoint: URL;
  try { endpoint = new URL(restUrl); } catch {
    throw new RedisRateLimitError('invalid_redis_url');
  }
  if (endpoint.protocol !== 'https:') throw new RedisRateLimitError('invalid_redis_url');
  return { endpoint, token: restToken };
}

export async function sendRedisCommand(config: RedisConfig, command: string[], signal?: AbortSignal): Promise<RedisCommandResult> {
  const deadline = createDeadline(signal, REDIS_TIMEOUT_MS, 'redis');
  try {
    deadline.check();
    let response: Response;
    try {
      response = await awaitWithSignal(deadline.signal, () => fetch(config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: deadline.signal,
        cache: 'no-store',
      }));
      deadline.check();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new RedisRateLimitError(name === 'TimeoutError' || name === 'AbortError' ? 'redis_timeout' : 'redis_network_error');
    }

    if (!response.ok) {
      const category = response.status === 401 || response.status === 403 ? 'redis_http_401_403' : 'redis_http_other';
      throw new RedisRateLimitError(category, response.status);
    }

    let payload: unknown;
    try { payload = await awaitWithSignal(deadline.signal, () => response.json()); deadline.check(); } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const category = name === 'TimeoutError' || name === 'AbortError' ? 'redis_timeout' : 'malformed_redis_response';
      throw new RedisRateLimitError(category, response.status);
    }
    if (!payload || typeof payload !== 'object' || !('result' in payload)) {
      throw new RedisRateLimitError('malformed_redis_response', response.status);
    }
    return { result: payload.result, httpStatus: response.status };
  } finally { deadline.dispose(); }
}

/** Canonicalize one bare address; never parse a proxy chain, port, zone or hostname. */
export function normalizeClientIP(value: string): string | null {
  if (value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  // WHATWG serialization compresses/lowercases IPv6, including embedded IPv4.
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return canonical;
}

/** Server configuration attests to ingress, not request headers. See docs/trusted-client-ip.md. */
export function trustedClientAddress(request: Request): string {
  if (process.env.AI_CLIENT_IP_POLICY !== 'vercel' || process.env.VERCEL !== '1' ||
      !['production', 'preview'].includes(process.env.VERCEL_ENV ?? '')) {
    throw new RedisRateLimitError('untrusted_client_ingress');
  }
  const value = request.headers.get('x-vercel-forwarded-for');
  if (!value) throw new RedisRateLimitError('missing_client_ip');
  const address = normalizeClientIP(value);
  if (!address) throw new RedisRateLimitError('invalid_client_ip');
  return address;
}

function isLocalDevelopment(): boolean {
  return (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') &&
    process.env.VERCEL === undefined && process.env.VERCEL_ENV === undefined &&
    (process.env.AI_CLIENT_IP_POLICY === undefined || process.env.AI_CLIENT_IP_POLICY === 'local');
}

function addressDigest(address: string, secret: string): string {
  return createHmac('sha256', secret).update(address).digest('hex');
}

export function createInMemoryRateLimiter(limit = ANALYZE_RATE_LIMIT, windowMs = RATE_WINDOW_MS, now = () => Date.now()) {
  const buckets = new Map<string, { count: number; window: number }>();
  let operations = 0;
  return (key: string): RateLimitDecision => {
    const current = now();
    const window = Math.floor(current / windowMs);
    if (++operations % 128 === 0) {
      for (const [bucketKey, bucket] of buckets) if (bucket.window < window) buckets.delete(bucketKey);
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.window !== window) {
      buckets.set(key, { count: 1, window });
      if (buckets.size > 10_000) buckets.clear();
      return { status: 'allowed' };
    }
    if (bucket.count >= limit) return { status: 'limited', scope: 'ip', retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * windowMs - current) / 1000)) };
    bucket.count += 1;
    return { status: 'allowed' };
  };
}

const localLimiter = createInMemoryRateLimiter(ANALYZE_RATE_LIMIT, 86400 * 1000);
const localAttemptLimiter = createInMemoryRateLimiter(ANALYZE_ATTEMPT_IP_LIMIT);

function retrySecondsUntilNextIpWindow(now: number): number {
  const nextWindow = (Math.floor(now / RATE_WINDOW_MS) + 1) * RATE_WINDOW_MS;
  return Math.max(1, Math.ceil((nextWindow - now) / 1000));
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Attempt counters are admitted together; this script never touches analysis quotas. */
export const ATOMIC_RATE_LIMIT_SCRIPT = `
local values = redis.call('MGET', KEYS[1], KEYS[2])
local function parseCounter(value)
  if not value then return 0 end
  if not string.match(value, '^%d+$') then return nil end
  local count = tonumber(value)
  if not count or count < 0 or count > 9007199254740991 then return nil end
  return count
end
local ipCount = parseCounter(values[1])
local dailyCount = parseCounter(values[2])
if ipCount == nil or dailyCount == nil then return {-1, 0, 0} end
local ipLimit = tonumber(ARGV[1])
local ipTtl = tonumber(ARGV[2])
local dailyLimit = tonumber(ARGV[3])
local dailyExpiry = tonumber(ARGV[4])
if not ipLimit or not ipTtl or not dailyLimit or not dailyExpiry then return {-1, 0, 0} end
if ipCount >= ipLimit then return {1, ipCount, dailyCount} end
if dailyCount >= dailyLimit then return {2, ipCount, dailyCount} end
ipCount = redis.call('INCR', KEYS[1])
if ipCount == 1 then redis.call('EXPIRE', KEYS[1], ipTtl) end
dailyCount = redis.call('INCR', KEYS[2])
if dailyCount == 1 then redis.call('EXPIREAT', KEYS[2], dailyExpiry) end
return {0, ipCount, dailyCount}
`;

/** Redis TIME is authoritative. Stable hash keys avoid a midnight key-selection race. */
export const ATOMIC_DAILY_ANALYSIS_SCRIPT = `
local now = tonumber(redis.call('TIME')[1])
local day = math.floor(now / 86400)
local reset = (day + 1) * 86400
local function count(key)
  local fields = redis.call('HMGET', key, 'day', 'count')
  if not fields[1] and not fields[2] then return 0 end
  if not fields[1] or not fields[2] then return nil end
  if not string.match(fields[1], '^%d+$') or not string.match(fields[2], '^%d+$') then return nil end
  local storedDay, value = tonumber(fields[1]), tonumber(fields[2])
  if storedDay > day or value > 9007199254740991 then return nil end
  if storedDay < day then return 0 end
  return value
end
local ip, global = count(KEYS[1]), count(KEYS[2])
if ip == nil or global == nil then return {-1, 0, 0, now, reset} end
if ip >= 5 then return {1, ip, global, now, reset} end
if global >= 100 then return {2, ip, global, now, reset} end
ip, global = ip + 1, global + 1
redis.call('HSET', KEYS[1], 'day', day, 'count', ip)
redis.call('EXPIREAT', KEYS[1], reset + 2)
redis.call('HSET', KEYS[2], 'day', day, 'count', global)
redis.call('EXPIREAT', KEYS[2], reset + 2)
return {0, ip, global, now, reset}
`;

async function checkDailyAdmission(address: string, config: RedisConfig, signal?: AbortSignal): Promise<RateLimitDecision> {
  const { result, httpStatus } = await sendRedisCommand(config, [
    'EVAL', ATOMIC_DAILY_ANALYSIS_SCRIPT, '2',
    `poker-analyze:daily:ip:v2:${addressDigest(address, config.token)}`,
    'poker-analyze:daily:global:v2',
  ], signal);
  throwIfCancelled(signal);
  if (!Array.isArray(result) || result.length !== 5) throw new RedisRateLimitError('malformed_redis_response', httpStatus);
  const [code, ip, global, now, reset] = result;
  if (!Number.isInteger(code) || ![ip, global, now, reset].every(isSafeInteger) || now > 8_639_999_913_600 || reset !== (Math.floor(now / 86400) + 1) * 86400) invalidLuaResult(httpStatus);
  if (code === 0 && ip >= 1 && ip <= 5 && global >= 1 && global <= 100) return { status: 'allowed' };
  const retryAfterSeconds = reset - now;
  const resetAt = new Date(reset * 1000).toISOString();
  if (code === 1 && ip >= 5 && global <= 100) return { status: 'limited', scope: 'ip', retryAfterSeconds, resetAt };
  if (code === 2 && ip < 5 && global >= 100) return { status: 'limited', scope: 'global', retryAfterSeconds, resetAt };
  invalidLuaResult(httpStatus);
}

export type RateLimitDecision =
  | { status: 'allowed' }
  | { status: 'limited'; scope: 'ip' | 'global'; retryAfterSeconds: number; resetAt?: string }
  | { status: 'unavailable' };

function invalidLuaResult(httpStatus?: number): never {
  throw new RedisRateLimitError('invalid_lua_result', httpStatus);
}

async function checkSharedAttemptLimit(address: string, config: RedisConfig, now: number, signal?: AbortSignal): Promise<RateLimitDecision> {
  const ipLimit = ANALYZE_ATTEMPT_IP_LIMIT;
  const globalLimit = ANALYZE_ATTEMPT_GLOBAL_LIMIT;
  const ipWindow = Math.floor(now / RATE_WINDOW_MS);
  const ipKey = `poker-analyze:attempt:ip:v1:${addressDigest(address, config.token)}:${ipWindow}`;
  const dailyKey = `poker-analyze:attempt:global:v1:${ipWindow}`;
  const ipRetryAfter = retrySecondsUntilNextIpWindow(now);
  const dailyRetryAfter = ipRetryAfter;
  const dailyExpiry = Math.floor((ipWindow + 1) * RATE_WINDOW_MS / 1000) + 2;
  const { result, httpStatus } = await sendRedisCommand(config, [
    'EVAL', ATOMIC_RATE_LIMIT_SCRIPT, '2', ipKey, dailyKey,
    String(ipLimit), String(ANALYZE_RATE_WINDOW_SECONDS + 2),
    String(globalLimit), String(dailyExpiry),
  ], signal);
  throwIfCancelled(signal);
  if (!Array.isArray(result) || result.length !== 3) throw new RedisRateLimitError('malformed_redis_response', httpStatus);
  const [code, ipCount, dailyCount] = result;
  if (!Number.isInteger(code) || !isSafeInteger(ipCount) || !isSafeInteger(dailyCount)) invalidLuaResult(httpStatus);
  if (code === -1) invalidLuaResult(httpStatus);
  if (code === 0) {
    if (ipCount < 1 || ipCount > ipLimit || dailyCount < 1 || dailyCount > globalLimit) invalidLuaResult(httpStatus);
    return { status: 'allowed' };
  }
  if (code === 1) {
    if (ipCount < ipLimit || dailyCount > globalLimit) invalidLuaResult(httpStatus);
    return { status: 'limited', scope: 'ip', retryAfterSeconds: ipRetryAfter };
  }
  if (code === 2) {
    if (ipCount >= ipLimit || dailyCount < globalLimit) invalidLuaResult(httpStatus);
    return { status: 'limited', scope: 'global', retryAfterSeconds: dailyRetryAfter };
  }
  invalidLuaResult(httpStatus);
}

/** Only explicitly local dev/test uses a single local bucket; every deployment fails closed. */
async function checkLimit(request: Request, signal?: AbortSignal, attempts = false): Promise<RateLimitDecision> {
  throwIfCancelled(signal);
  if (!isLocalDevelopment()) {
    try {
      const address = trustedClientAddress(request);
      const config = getRedisConfig();
      return attempts ? await checkSharedAttemptLimit(address, config, Date.now(), signal) : await checkDailyAdmission(address, config, signal);
    } catch (error) {
      throwIfCancelled(signal);
      const category = error instanceof RedisRateLimitError ? error.category : 'redis_network_error';
      logRedisFailure(category, error instanceof RedisRateLimitError && error.httpStatus ? { httpStatus: error.httpStatus } : {});
      return { status: 'unavailable' };
    }
  }
  // Local-only convenience: ignore ALL request IP headers; never allow an unlimited missing-IP path.
  return (attempts ? localAttemptLimiter : localLimiter)(addressDigest('local-development', 'poker-analyzer-local-rate-limit'));
}

/** Cheap pre-body/verification attempt protection; never touches analysis quota keys. */
export const checkAnalyzeAttemptLimit = (request: Request, signal?: AbortSignal): Promise<RateLimitDecision> => checkLimit(request, signal, true);
/** Atomically admits fully validated analyses immediately before provider dispatch; no refunds. */
export const checkAnalyzeRateLimit = (request: Request, signal?: AbortSignal): Promise<RateLimitDecision> => checkLimit(request, signal);
