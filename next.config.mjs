/** @type {import('next').NextConfig} */
const nextConfig = {
  // The web container runs the standalone server (see Dockerfile).
  output: 'standalone',
  reactStrictMode: true,
  // §20: nothing here is public, and the headers cost nothing.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
