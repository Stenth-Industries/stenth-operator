import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The reliability suite talks to a real Postgres and migrates it.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
    fileParallelism: false,
    // config.ts fails fast on boot by design (§19). The suites that exercise a
    // real database build their own pools from TEST_ADMIN_DATABASE_URL; this
    // placeholder only satisfies the boot-time parse.
    env: {
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'test',
    },
  },
});
