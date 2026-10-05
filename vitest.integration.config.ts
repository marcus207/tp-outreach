import { defineConfig } from 'vitest/config';

/**
 * ISOLATED integration tests (test/integration/**). See test/README.md.
 *
 * The environment is pinned HERE (in the main process, before globalSetup and
 * before any worker imports src/) so that dotenv's later load of the prod .env
 * can never supply DATABASE_URL / REDIS_URL / SEND_MODE: dotenv never overrides
 * a variable that is already set, even to ''.
 */
const LANE = (process.env.TEST_LANE || 'main').toLowerCase();
const LANE_DB = LANE === 'main' ? 'tpca_outreach_test' : `tpca_outreach_test_${LANE}`;

const TEST_ENV: Record<string, string> = {
  TEST_LANE: LANE,
  NODE_ENV: 'test',
  SEND_MODE: 'dryrun',
  TENANT: 'tp',
  DATABASE_URL: `postgresql://tpca:tpca_secure_2026@localhost:5432/${LANE_DB}`,
  REDIS_URL: 'redis://127.0.0.1:6379/15',
  BULL_PREFIX: `bull-test-${LANE}`,
  TRACKING_DOMAIN: 'https://track.test.invalid',
  COLD_SENDER_DOMAIN: 'go.tp.finance',
  BRAND_EMAIL: 'marcus@tp.finance',
  BRAND_NAME: 'Turning Point Capital Advisory',
  BRAND_DOMAIN: 'tp.finance',
  PORT: '0',
  // Credentials blanked/faked so no client can authenticate against a real service.
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/test/oauth/callback',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  APOLLO_API_KEY: '',
  APOLLO_WEBHOOK_SECRET: '',
  BRAVE_API_KEY: '',
  BRAVE_SEARCH_API_KEY: '',
  STRAPI_URL: 'http://localhost:1/strapi-disabled',
  STRAPI_API_TOKEN: '',
  BETTERSTACK_API_KEY: '',
  DRIPIFY_INGEST_KEY: 'test-dripify-key',
  APOLLO_SYNC_ENABLED: 'false',
  APOLLO_WEBHOOK_ENABLED: 'false',
  TP_AUTO_ENROL_ENABLED: 'false',
  TRACK_OPENS: 'false',
  TRACK_CLICKS: 'false',
  SESSION_SECRET: 'test-session-secret',
  DASHBOARD_EMAIL: 'test@tp.finance',
  DASHBOARD_PASSWORD: 'test-password',
};
Object.assign(process.env, TEST_ENV);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    setupFiles: ['test/integration/setup.ts'],
    env: TEST_ENV,
    // One shared DB + Redis DB: run files and tests strictly sequentially.
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
