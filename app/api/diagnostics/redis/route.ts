import { runRedisDiagnostics } from '../../../../lib/analyze-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noCacheHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV !== 'production') {
    return Response.json({ status: 'FAIL', failures: ['diagnostic_unavailable_outside_production'] }, { status: 404, headers: noCacheHeaders });
  }

  const result = await runRedisDiagnostics(request);
  return Response.json(result, { status: result.status === 'PASS' ? 200 : 503, headers: noCacheHeaders });
}
