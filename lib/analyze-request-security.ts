export type RequestSecurityFailure = {
  status: 403 | 415 | 503;
  error: 'unsupported_media_type' | 'request_origin_forbidden' | 'request_security_unavailable';
  message: string;
};

// Strict field syntax: reject combined media types and malformed parameters instead of
// relying on a permissive MIME parser. JSON remains a non-safelisted browser media type.
const JSON_CONTENT_TYPE = /^application\/json(?:[ \t]*;[ \t]*[!#$%&'*+.^_`|~\w-]+[ \t]*=[ \t]*(?:[!#$%&'*+.^_`|~\w-]+|"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*"))*[ \t]*$/i;

/** Accept an HTTP(S) origin only, never URL paths, credentials, wildcards or lists. */
function parseOrigin(value: string): string | null {
  if (value.length > 2048 || !/^https?:\/\/[^\s/\\?#,@%*]+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.origin === 'null' || url.username || url.password ? null : url.origin;
  } catch { return null; }
}

const forbidden = (): RequestSecurityFailure => ({
  status: 403, error: 'request_origin_forbidden', message: 'This analysis request is not permitted.',
});

/** Header-only gate. Must run before touching the body, rate limiter or provider.
 * Authentication stays in middleware; Authorization is never evidence of same-origin intent.
 * Request.url must come from the framework's trusted request URL, not reconstructed here
 * from Host, Forwarded or X-Forwarded-* headers. Proxy aliases use explicit server config.
 */
export function checkAnalyzeRequestSecurity(
  request: Request,
  trustedOrigins = process.env.AI_TRUSTED_ORIGINS,
): RequestSecurityFailure | null {
  const contentType = request.headers.get('content-type');
  if (!contentType || contentType.length > 1024 || !JSON_CONTENT_TYPE.test(contentType)) {
    return { status: 415, error: 'unsupported_media_type', message: 'Analysis requests must use application/json.' };
  }

  const site = request.headers.get('sec-fetch-site');
  const mode = request.headers.get('sec-fetch-mode');
  const destination = request.headers.get('sec-fetch-dest');
  // Explicit cross-site intent always loses, including for configured trusted origins.
  // Navigation, no-cors, malformed/combined metadata and partial metadata fail closed.
  if (request.headers.has('sec-fetch-user')) return forbidden();
  if (site !== null && site !== 'same-origin' && site !== 'same-site') return forbidden();
  if (mode !== null && mode !== 'cors' && mode !== 'same-origin') return forbidden();
  if (destination !== null && destination !== 'empty') return forbidden();
  if (site === null && (mode !== null || destination !== null)) return forbidden();
  if (site === 'same-site' && mode === 'same-origin') return forbidden();

  const allowed = new Set<string>();
  const unavailable = (): RequestSecurityFailure => ({
    status: 503, error: 'request_security_unavailable', message: 'Analysis request protection is temporarily unavailable.',
  });
  try {
    const target = parseOrigin(new URL(request.url).origin);
    if (!target) return unavailable();
    allowed.add(target);
  } catch { return unavailable(); }
  if (trustedOrigins?.trim()) {
    if (trustedOrigins.length > 8192) return unavailable();
    const entries = trustedOrigins.split(',');
    if (entries.length > 16) return unavailable();
    for (const entry of entries) {
      const origin = parseOrigin(entry.trim());
      if (!origin) return unavailable();
      allowed.add(origin);
    }
  }

  const header = request.headers.get('origin');
  if (header !== null) {
    const origin = parseOrigin(header);
    if (!origin || !allowed.has(origin)) return forbidden();
  } else if (site === 'same-site') {
    // A sibling site is not an origin: without Origin its membership cannot be checked.
    return forbidden();
  }
  // Missing Origin is allowed for same-origin browser fetches and for non-browser JSON
  // clients with no Fetch Metadata. Cross-origin browser JSON needs a CORS preflight;
  // this endpoint grants no CORS permission. Neither Basic auth nor Referer bypasses this.
  return null;
}
