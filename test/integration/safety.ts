/**
 * Isolation assertions shared by global-setup (main process) and setup
 * (each test worker). Any failure aborts the run before a single query.
 */
// TEST_LANE lets several suites run in parallel, each with its own database and
// queue prefix: lane 'main' -> tpca_outreach_test / bull-test-main,
// lane 'x' -> tpca_outreach_test_x / bull-test-x.
export const TEST_LANE = (process.env.TEST_LANE || 'main').toLowerCase();
if (!/^[a-z0-9]+$/.test(TEST_LANE)) throw new Error(`[integration] invalid TEST_LANE '${TEST_LANE}'`);
export const TEST_DB_NAME = TEST_LANE === 'main' ? 'tpca_outreach_test' : `tpca_outreach_test_${TEST_LANE}`;
export const TEST_REDIS_DB = 15;
export const TEST_BULL_PREFIX = `bull-test-${TEST_LANE}`;

export function assertIsolatedEnv(): void {
  const errors: string[] = [];
  const dbUrl = process.env.DATABASE_URL || '';
  const dbName = (dbUrl.split('/').pop() || '').split('?')[0];
  if (!dbUrl.endsWith(`/${TEST_DB_NAME}`) || dbName !== TEST_DB_NAME) {
    errors.push(`DATABASE_URL must end with /${TEST_DB_NAME} (got database '${dbName}')`);
  }
  let redisDb = -1;
  try {
    const u = new URL(process.env.REDIS_URL || '');
    redisDb = parseInt(u.pathname.replace(/^\/+/, '') || '0', 10);
  } catch { /* invalid URL */ }
  if (redisDb !== TEST_REDIS_DB) {
    errors.push(`REDIS_URL must point at logical DB ${TEST_REDIS_DB} (got ${process.env.REDIS_URL})`);
  }
  if (process.env.BULL_PREFIX !== TEST_BULL_PREFIX) {
    errors.push(`BULL_PREFIX must be ${TEST_BULL_PREFIX} (got ${process.env.BULL_PREFIX})`);
  }
  if (process.env.NODE_ENV !== 'test') errors.push(`NODE_ENV must be 'test' (got ${process.env.NODE_ENV})`);
  if (process.env.SEND_MODE === 'live') errors.push('SEND_MODE must not be live');
  if (process.env.TENANT !== 'tp') errors.push(`TENANT must be 'tp' (got ${process.env.TENANT})`);
  if (errors.length) {
    throw new Error('[integration] ABORTING, environment is not isolated:\n  - ' + errors.join('\n  - '));
  }
}
