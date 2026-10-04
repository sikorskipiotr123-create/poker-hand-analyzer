import { createHmac } from 'node:crypto';

export const ANALYZE_RATE_LIMIT = 5;
export const ANALYZE_RATE_WINDOW_SECONDS = 10 * 60;
const RATE_WINDOW_MS = ANALYZE_RATE_WINDOW_SECONDS * 1000;
const REDIS_TIMEOUT_MS = 2_000;
const REDIS_INCREMENT_SCRIPT = "local hits = redis.call('INCR', KEYS[1]); if hits == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return hits";

export type RateLimitDecision =
  | { status: 'allowed' }
  | { status: 'limited'; retryAfterSeconds: number }
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
    if (bucket.count >= limit) return { status: 'limited', retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * windowMs - current) / 1000)) };
    bucket.count += 1;
    return { status: 'allowed' };
  };
}

const localLimiter = createInMemoryRateLimiter();

async function checkSharedRateLimit(address: string, restUrl: string, restToken: string): Promise<RateLimitDecision> {
  let endpoint: URL;
  try { endpoint = new URL(restUrl); } catch { return { status: 'unavailable' }; }
  if (endpoint.protocol !== 'https:') return { status: 'unavailable' };

  const now = Date.now();
  const window = Math.floor(now / RATE_WINDOW_MS);
  const addressKey = addressDigest(address, restToken);
  const redisKey = `poker-analyze:${addressKey}:${window}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${restToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', REDIS_INCREMENT_SCRIPT, '1', redisKey, String(ANALYZE_RATE_WINDOW_SECONDS + 2)]),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return { status: 'unavailable' };
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('result' in payload)) return { status: 'unavailable' };
    const count = Number(payload.result);
    if (!Number.isInteger(count) || count < 1) return { status: 'unavailable' };
    if (count > ANALYZE_RATE_LIMIT) {
      return { status: 'limited', retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * RATE_WINDOW_MS - now) / 1000)) };
    }
    return { status: 'allowed' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Production calls fail closed unless a shared limiter is configured; local dev uses a best-effort process-local bucket. */
export async function checkAnalyzeRateLimit(request: Request): Promise<RateLimitDecision> {
  const address = clientAddress(request);
  if (process.env.NODE_ENV === 'production') {
    const restUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const restToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    if (!restUrl || !restToken || !address) return { status: 'unavailable' };
    return checkSharedRateLimit(address, restUrl, restToken);
  }
  if (!address) return { status: 'allowed' };
  return localLimiter(addressDigest(address, 'poker-analyzer-local-rate-limit'));
}
