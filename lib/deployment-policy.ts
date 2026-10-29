/** Explicit server-only policy; requests and hosting markers never select access mode. */
export function getApplicationAccessMode(): 'private' | 'public' {
  const mode = process.env.APPLICATION_ACCESS_MODE;
  if (mode === undefined || mode === 'private') return 'private';
  if (mode === 'public') return 'public';
  throw new Error('Application access configuration is invalid.');
}
