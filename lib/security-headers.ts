/** Shared by Next routing, middleware errors and direct API handler responses. */
export const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'X-Frame-Options': 'DENY',
};
export const BASE_CSP = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
export const API_SECURITY_HEADERS = { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': `default-src 'none'; ${BASE_CSP}` };

/** Next reads this policy on the forwarded request to nonce its bootstrap scripts. */
export function documentSecurityHeaders(nonce: string, development = process.env.NODE_ENV === 'development'): Record<string, string> {
  if (!/^[A-Za-z0-9+/]{22,}={0,2}$/.test(nonce)) throw new Error('Invalid CSP nonce.');
  const policy = [
    "default-src 'self'",
    `${BASE_CSP}`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    // React progress-bar style attributes and Next style handling require inline CSS.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "media-src 'none'",
  ].join('; ');
  return { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': policy, 'Cache-Control': 'private, no-store' };
}
