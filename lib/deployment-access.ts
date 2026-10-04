const BASIC_AUTH_USERNAME = 'access';
const MIN_SECRET_LENGTH = 32;
const MAX_AUTHORIZATION_LENGTH = 8_192;

export type DeploymentAccessDecision = 'authorized' | 'unauthorized' | 'misconfigured';

async function constantTimeTextEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const digests = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const actualBytes = new Uint8Array(digests[0]);
  const expectedBytes = new Uint8Array(digests[1]);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= actualBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

/** Validates the temporary Basic Auth gate without exposing its secret to client code. */
export async function checkDeploymentAccess(
  authorization: string | null,
  secret: string | undefined,
): Promise<DeploymentAccessDecision> {
  if (!secret || secret.length < MIN_SECRET_LENGTH || secret.trim() !== secret) return 'misconfigured';
  if (!authorization || authorization.length > MAX_AUTHORIZATION_LENGTH) return 'unauthorized';

  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) return 'unauthorized';

  let credentials: string;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    credentials = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'unauthorized';
  }

  const expected = BASIC_AUTH_USERNAME + ':' + secret;
  if (await constantTimeTextEqual(credentials, expected)) return 'authorized';
  return 'unauthorized';
}
