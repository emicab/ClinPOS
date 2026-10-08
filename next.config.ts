/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  allowedDevOrigins: ['127.0.0.1'],
  async headers() {
    return [
      // CORS: lo resuelve middleware.ts (orígenes permitidos). No fijar "*" acá.
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
  webpack: (config: any, { nextRuntime }: any) => {
    if (nextRuntime === 'edge') {
      config.devtool = false;
    }
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        '**/*.db',
        '**/*.db-journal',
        '**/*.sqlite',
        '**/*.sqlite-journal',
        '**/.next2/**',
        '**/prisma/*.db*',
        '**/*.log',
        ...(Array.isArray(config.watchOptions?.ignored) ? config.watchOptions.ignored : []),
      ],
    };
    return config;
  },
};
export default nextConfig;