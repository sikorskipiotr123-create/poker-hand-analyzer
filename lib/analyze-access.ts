import { getApplicationAccessMode } from './deployment-policy';
import { checkDeploymentAccess } from './deployment-access';

export const BASIC_AUTH_CHALLENGE = 'Basic realm="Poker Hand Analyzer Preview", charset="UTF-8"';

/** Private-deployment policy seam for the paid API, independent of middleware execution.
 * Public access requires the explicit server-only public policy; private is the safe default.
 * Missing credentials/configuration, NODE_ENV, proxy headers and client flags never disable it.
 */
export async function checkAnalyzeAccess(request: Request): Promise<null | {
  status: 401 | 503;
  error: 'deployment_access_required' | 'deployment_access_unavailable';
}> {
  try { if (getApplicationAccessMode() === 'public') return null; }
  catch { return { status: 503, error: 'deployment_access_unavailable' }; }
  const decision = await checkDeploymentAccess(request.headers.get('authorization'), process.env.DEPLOYMENT_ACCESS_SECRET);
  if (decision === 'authorized') return null;
  return decision === 'misconfigured'
    ? { status: 503, error: 'deployment_access_unavailable' }
    : { status: 401, error: 'deployment_access_required' };
}
