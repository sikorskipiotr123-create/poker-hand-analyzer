import { createHmac } from 'node:crypto';

export const ANALYZE_RATE_LIMIT = 5;
export const ANALYZE_RATE_WINDOW_SECONDS = 10 * 60;
export const GLOBAL_ANALYZE_DAILY_LIMIT = 100;
const RATE_WINDOW_MS = ANALYZE_RATE_WINDOW_SECONDS * 1000;
const REDIS_TIMEOUT_MS = 2_000;

export type RedisFailureCategory =
  | 'missing_environment_variable'
  | 'missing_client_ip'
  | 'invalid_redis_url'
  | 'redis_timeout'
  | 'redis_network_error'
  | 'redis_http_401_403'
  | 'redis_http_other'
  | 'malformed_redis_response'
  | 'invalid_lua_result';

export class RedisDiagnosticError extends Error {
  constructor(readonly category: RedisFailureCategory, readonly httpStatus?: number) {
    super(category);
    this.name = 'RedisDiagnosticError';
  }
}

type RedisConfig = { endpoint: URL; token: string };
type RedisDiagnosticResult = { result: unknown; httpStatus: number };

function logRedisFailure(category: RedisFailureCategory, metadata: Record<string, string | number> = {}): void {
  if (process.env.NODE_ENV !== 'production') return;
  // Metadata is built only from fixed labels/status codes; never include request or provider data.
  console.error(JSON.stringify({ event: 'upstash_rate_limiter_failure', category, ...metadata }));
}

function getRedisConfig(): RedisConfig {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!restUrl || !restToken) {
    throw new RedisDiagnosticError('missing_environment_variable');
  }

  let endpoint: URL;
  try { endpoint = new URL(restUrl); } catch {
    throw new RedisDiagnosticError('invalid_redis_url');
  }
  if (endpoint.protocol !== 'https:') throw new RedisDiagnosticError('invalid_redis_url');
  return { endpoint, token: restToken };
}

async function sendRedisCommand(config: RedisConfig, command: string[]): Promise<RedisDiagnosticResult> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new RedisDiagnosticError(name === 'TimeoutError' || name === 'AbortError' ? 'redis_timeout' : 'redis_network_error');
  }

  if (!response.ok) {
    const category = response.status === 401 || response.status === 403 ? 'redis_http_401_403' : 'redis_http_other';
    throw new RedisDiagnosticError(category, response.status);
  }

  let payload: unknown;
  try { payload = await response.json(); } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const category = name === 'TimeoutError' || name === 'AbortError' ? 'redis_timeout' : 'malformed_redis_response';
    throw new RedisDiagnosticError(category, response.status);
  }
  if (!payload || typeof payload !== 'object' || !('result' in payload)) {
    throw new RedisDiagnosticError('malformed_redis_response', response.status);
  }
  return { result: payload.result, httpStatus: response.status };
}

function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
  return forwarded?.split(',')[0]?.trim() || null;
}

export function hasClientIpHeader(request: Request): boolean {
  return clientAddress(request) !== null;
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

const localLimiter = createInMemoryRateLimiter();

function retrySecondsUntilNextIpWindow(now: number): number {
  const nextWindow = (Math.floor(now / RATE_WINDOW_MS) + 1) * RATE_WINDOW_MS;
  return Math.max(1, Math.ceil((nextWindow - now) / 1000));
}

function getUtcDayWindow(now: number): { day: string; nextMidnightMs: number } {
  const date = new Date(now);
  const nextMidnightMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return { day: date.toISOString().slice(0, 10), nextMidnightMs };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Redis executes each EVAL atomically, so IP and daily counters are checked and updated together. */
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

export type RateLimitDecision =
  | { status: 'allowed' }
  | { status: 'limited'; scope: 'ip' | 'global'; retryAfterSeconds: number }
  | { status: 'unavailable' };

function invalidLuaResult(httpStatus?: number): never {
  throw new RedisDiagnosticError('invalid_lua_result', httpStatus);
}

async function checkSharedRateLimit(address: string, config: RedisConfig, now: number): Promise<RateLimitDecision> {
  const ipWindow = Math.floor(now / RATE_WINDOW_MS);
  const { day, nextMidnightMs } = getUtcDayWindow(now);
  const ipKey = `poker-analyze:ip:${addressDigest(address, config.token)}:${ipWindow}`;
  const dailyKey = `poker-analyze:global:${day}`;
  const ipRetryAfter = retrySecondsUntilNextIpWindow(now);
  const dailyRetryAfter = Math.max(1, Math.ceil((nextMidnightMs - now) / 1000));
  const dailyExpiry = Math.floor(nextMidnightMs / 1000) + 2;
  const { result, httpStatus } = await sendRedisCommand(config, [
    'EVAL', ATOMIC_RATE_LIMIT_SCRIPT, '2', ipKey, dailyKey,
    String(ANALYZE_RATE_LIMIT), String(ANALYZE_RATE_WINDOW_SECONDS + 2),
    String(GLOBAL_ANALYZE_DAILY_LIMIT), String(dailyExpiry),
  ]);
  if (!Array.isArray(result) || result.length !== 3) throw new RedisDiagnosticError('malformed_redis_response', httpStatus);
  const [code, ipCount, dailyCount] = result;
  if (!Number.isInteger(code) || !isSafeInteger(ipCount) || !isSafeInteger(dailyCount)) invalidLuaResult(httpStatus);
  if (code === -1) invalidLuaResult(httpStatus);
  if (code === 0) {
    if (ipCount < 1 || ipCount > ANALYZE_RATE_LIMIT || dailyCount < 1 || dailyCount > GLOBAL_ANALYZE_DAILY_LIMIT) invalidLuaResult(httpStatus);
    return { status: 'allowed' };
  }
  if (code === 1) {
    if (ipCount < ANALYZE_RATE_LIMIT || dailyCount > GLOBAL_ANALYZE_DAILY_LIMIT) invalidLuaResult(httpStatus);
    return { status: 'limited', scope: 'ip', retryAfterSeconds: ipRetryAfter };
  }
  if (code === 2) {
    if (ipCount >= ANALYZE_RATE_LIMIT || dailyCount < GLOBAL_ANALYZE_DAILY_LIMIT) invalidLuaResult(httpStatus);
    return { status: 'limited', scope: 'global', retryAfterSeconds: dailyRetryAfter };
  }
  invalidLuaResult(httpStatus);
}

export type RedisDiagnosticCheck = { status: 'PASS' | 'FAIL'; category?: RedisFailureCategory };
export type RedisDiagnostics = {
  status: 'PASS' | 'FAIL';
  checks: { redisPing: RedisDiagnosticCheck; readOnlyLuaEval: RedisDiagnosticCheck; clientIpHeaderPresent: 'PASS' | 'FAIL' };
  failures: RedisFailureCategory[];
};

/** Performs only PING and EVAL return 1 with zero keys; it never touches limiter data. */
export async function runRedisDiagnostics(request: Request): Promise<RedisDiagnostics> {
  const ipPresent = hasClientIpHeader(request);
  const checks: RedisDiagnostics['checks'] = {
    redisPing: { status: 'FAIL' },
    readOnlyLuaEval: { status: 'FAIL' },
    clientIpHeaderPresent: ipPresent ? 'PASS' : 'FAIL',
  };
  const failures: RedisFailureCategory[] = [];
  let config: RedisConfig;
  try { config = getRedisConfig(); } catch (error) {
    const category = error instanceof RedisDiagnosticError ? error.category : 'invalid_redis_url';
    failures.push(category);
    checks.redisPing = { status: 'FAIL', category };
    checks.readOnlyLuaEval = { status: 'FAIL', category };
    if (!ipPresent) failures.push('missing_client_ip');
    return { status: 'FAIL', checks, failures: [...new Set(failures)] };
  }

  const runCheck = async (command: string[], expected: unknown): Promise<RedisDiagnosticCheck> => {
    try {
      const response = await sendRedisCommand(config, command);
      if (response.result !== expected) throw new RedisDiagnosticError('malformed_redis_response', response.httpStatus);
      return { status: 'PASS' };
    } catch (error) {
      const category = error instanceof RedisDiagnosticError ? error.category : 'redis_network_error';
      failures.push(category);
      return { status: 'FAIL', category };
    }
  };

  checks.redisPing = await runCheck(['PING'], 'PONG');
  checks.readOnlyLuaEval = await runCheck(['EVAL', 'return 1', '0'], 1);
  if (!ipPresent) failures.push('missing_client_ip');
  return {
    status: checks.redisPing.status === 'PASS' && checks.readOnlyLuaEval.status === 'PASS' && ipPresent ? 'PASS' : 'FAIL',
    checks,
    failures: [...new Set(failures)],
  };
}

/** Production calls fail closed unless shared Upstash limits are configured; local dev uses a process-local IP bucket. */
export async function checkAnalyzeRateLimit(request: Request): Promise<RateLimitDecision> {
  const address = clientAddress(request);
  if (process.env.NODE_ENV === 'production') {
    try {
      if (!address) throw new RedisDiagnosticError('missing_client_ip');
      const config = getRedisConfig();
      return await checkSharedRateLimit(address, config, Date.now());
    } catch (error) {
      const category = error instanceof RedisDiagnosticError ? error.category : 'redis_network_error';
      logRedisFailure(category, error instanceof RedisDiagnosticError && error.httpStatus ? { httpStatus: error.httpStatus } : {});
      return { status: 'unavailable' };
    }
  }
  if (!address) return { status: 'allowed' };
  return localLimiter(addressDigest(address, 'poker-analyzer-local-rate-limit'));
}
