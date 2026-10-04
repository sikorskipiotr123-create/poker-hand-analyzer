import { NextResponse, type NextRequest } from 'next/server';
import { checkDeploymentAccess } from './lib/deployment-access';

function isApiRequest(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const decision = await checkDeploymentAccess(
    request.headers.get('authorization'),
    process.env.DEPLOYMENT_ACCESS_SECRET,
  );
  if (decision === 'authorized') return NextResponse.next();

  const status = decision === 'misconfigured' ? 503 : 401;
  const api = isApiRequest(request.nextUrl.pathname);
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  if (decision === 'unauthorized') {
    headers.set('WWW-Authenticate', 'Basic realm="Poker Hand Analyzer Preview", charset="UTF-8"');
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
