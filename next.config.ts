import type { NextConfig } from 'next';

// Build-time guard: the browser bundle inlines NEXT_PUBLIC_SB_PUBLISHABLE_KEY,
// so it must never hold a secret. Failing the build here is what stands
// between a paste mistake and a publicly downloadable service-role key.
const publicKey = process.env.NEXT_PUBLIC_SB_PUBLISHABLE_KEY ?? '';
if (publicKey.startsWith('sb_secret_') || publicKey.includes('service_role')) {
  throw new Error(
    'NEXT_PUBLIC_SB_PUBLISHABLE_KEY contains a SECRET key. Put the sb_publishable_ ' +
      'key there; the sb_secret_ key belongs only in SB_SECRET_KEY (server-side). ' +
      'Build aborted so the secret is not baked into the public bundle.'
  );
}

const nextConfig: NextConfig = {
  serverExternalPackages: ['nodemailer'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
