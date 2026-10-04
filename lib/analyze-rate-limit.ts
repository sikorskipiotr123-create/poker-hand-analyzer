import { createHmac } from 'node:crypto';

export const ANALYZE_RATE_LIMIT = 5;
export const ANALYZE_RATE_WINDOW_SECONDS = 10 * 60;
export const GLOBAL_ANALYZE_DAILY_LIMIT = 100;
const RATE_WINDOW_MS = ANALYZE_RATE_WINDOW_SECONDS * 1000;
const REDIS_TIMEOUT_MS = 2_000;

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

function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
  return forwarded?.split(',')[0]?.trim() || null;
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

async function checkSharedRateLimit(address: string, restUrl: string, restToken: string, now: number): Promise<RateLimitDecision> {
  let endpoint: URL;
  try { endpoint = new URL(restUrl); } catch { return { status: 'unavailable' }; }
  if (endpoint.protocol !== 'https:') return { status: 'unavailable' };

  const ipWindow = Math.floor(now / RATE_WINDOW_MS);
  const { day, nextMidnightMs } = getUtcDayWindow(now);
  const ipKey = `poker-analyze:ip:${addressDigest(address, restToken)}:${ipWindow}`;
  const dailyKey = `poker-analyze:global:${day}`;
  const ipRetryAfter = retrySecondsUntilNextIpWindow(now);
  const dailyRetryAfter = Math.max(1, Math.ceil((nextMidnightMs - now) / 1000));
  const dailyExpiry = Math.floor(nextMidnightMs / 1000) + 2;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${restToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        'EVAL', ATOMIC_RATE_LIMIT_SCRIPT, '2', ipKey, dailyKey,
        String(ANALYZE_RATE_LIMIT), String(ANALYZE_RATE_WINDOW_SECONDS + 2),
        String(GLOBAL_ANALYZE_DAILY_LIMIT), String(dailyExpiry),
      ]),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return { status: 'unavailable' };
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('result' in payload) || !Array.isArray(payload.result) || payload.result.length !== 3) return { status: 'unavailable' };
    const [code, ipCount, dailyCount] = payload.result;
    if (!Number.isInteger(code) || !isSafeInteger(ipCount) || !isSafeInteger(dailyCount)) return { status: 'unavailable' };
    if (code === -1) return { status: 'unavailable' };
    if (code === 0) {
      if (ipCount < 1 || ipCount > ANALYZE_RATE_LIMIT || dailyCount < 1 || dailyCount > GLOBAL_ANALYZE_DAILY_LIMIT) return { status: 'unavailable' };
      return { status: 'allowed' };
    }
    if (code === 1) {
      if (ipCount < ANALYZE_RATE_LIMIT || dailyCount > GLOBAL_ANALYZE_DAILY_LIMIT) return { status: 'unavailable' };
      return { status: 'limited', scope: 'ip', retryAfterSeconds: ipRetryAfter };
    }
    if (code === 2) {
      if (ipCount >= ANALYZE_RATE_LIMIT || dailyCount < GLOBAL_ANALYZE_DAILY_LIMIT) return { status: 'unavailable' };
      return { status: 'limited', scope: 'global', retryAfterSeconds: dailyRetryAfter };
    }
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Production calls fail closed unless shared Upstash limits are configured; local dev uses a process-local IP bucket. */
export async function checkAnalyzeRateLimit(request: Request): Promise<RateLimitDecision> {
  const address = clientAddress(request);
  if (process.env.NODE_ENV === 'production') {
    const restUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const restToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    if (!restUrl || !restToken || !address) return { status: 'unavailable' };
    return checkSharedRateLimit(address, restUrl, restToken, Date.now());
  }
  if (!address) return { status: 'allowed' };
  return localLimiter(addressDigest(address, 'poker-analyzer-local-rate-limit'));
}
