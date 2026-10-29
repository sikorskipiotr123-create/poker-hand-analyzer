import { getApplicationAccessMode } from './lib/deployment-policy';
import { NextResponse, type NextRequest } from 'next/server';
import { documentSecurityHeaders, API_SECURITY_HEADERS } from './lib/security-headers';
import { BASIC_AUTH_CHALLENGE } from './lib/analyze-access';
import { checkDeploymentAccess } from './lib/deployment-access';

function isApiRequest(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let decision: 'authorized' | 'unauthorized' | 'misconfigured';
  try {
    decision = getApplicationAccessMode() === 'public' ? 'authorized' : await checkDeploymentAccess(
      request.headers.get('authorization'), process.env.DEPLOYMENT_ACCESS_SECRET,
    );
  } catch { decision = 'misconfigured'; }
  const api = isApiRequest(request.nextUrl.pathname);
  if (decision === 'authorized') {
    // Replace any client-supplied CSP/nonce metadata. Nonces must never come from the caller.
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const securityHeaders = api ? API_SECURITY_HEADERS : documentSecurityHeaders(nonce);
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete('x-nonce');
    forwardedHeaders.delete('content-security-policy-report-only');
    forwardedHeaders.set('content-security-policy', securityHeaders['Content-Security-Policy']);
    const response = NextResponse.next({ request: { headers: forwardedHeaders } });
    for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }

  const status = decision === 'misconfigured' ? 503 : 401;
  const headers = new Headers({
    'Cache-Control': 'no-store',
    ...API_SECURITY_HEADERS,
  });

  if (decision === 'unauthorized') {
    headers.set('WWW-Authenticate', BASIC_AUTH_CHALLENGE);
  }

  if (api) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new NextResponse(JSON.stringify({
      error: decision === 'misconfigured' ? 'deployment_access_unavailable' : 'deployment_access_required',
    }), { status, headers });
  }

  return new NextResponse(
    decision === 'misconfigured' ? 'Preview access is temporarily unavailable.' : 'Authentication is required to access this preview.',
    { status, headers },
  );
}

/** Next static assets remain public so the authenticated UI can load its CSS, scripts, and images. */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
