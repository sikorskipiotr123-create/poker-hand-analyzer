import type { NextConfig } from 'next';
import { BASE_SECURITY_HEADERS, BASE_CSP } from './lib/security-headers';

const nextConfig: NextConfig = {
  async headers() {
    // Baseline also covers public static assets and framework-generated responses.
    // Middleware supplies a fresh nonce policy for documents; the API supplies default-src none.
    return [{ source: '/:path*', headers: Object.entries({ ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': BASE_CSP }).map(([key, value]) => ({ key, value })) }];
  },
};
export default nextConfig;
