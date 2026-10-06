import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 10000,
    // Unit tests mock the DB/Redis, but pin every connection string to the
    // isolated test resources anyway so nothing can ever reach prod (and so the
    // NODE_ENV=test guards in src/db/connection.ts + src/db/redis.ts pass).
    env: {
      DATABASE_URL: 'postgresql://tpca@localhost:5432/tpca_outreach_test',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      BULL_PREFIX: 'bull-test-unit',
      SEND_MODE: 'dryrun',
    },
  },
});
