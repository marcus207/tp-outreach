/**
 * Runs once, in the vitest main process, before any test file is loaded.
 *  1. Asserts the environment is isolated (test DB, Redis DB 15, bull-test prefix,
 *     NODE_ENV=test, SEND_MODE!=live). Aborts otherwise.
 *  2. Resets tpca_outreach_test from test/schema.sql (scripts/test-db-reset.sh,
 *     which itself refuses any other database name).
 *  3. Deletes only bull-test* keys in Redis DB 15 (never FLUSHDB, never DB 0).
 */
import { execFileSync } from 'child_process';
import path from 'path';
import Redis from 'ioredis';
import { assertIsolatedEnv, TEST_BULL_PREFIX, TEST_REDIS_DB } from './safety';

export async function clearTestRedis(): Promise<number> {
  const redis = new Redis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    // Confirm the live connection really is on DB 15 before deleting anything
    const info = await redis.call('CLIENT', 'INFO');
    const m = String(info).match(/\bdb=(\d+)/);
    if (!m || Number(m[1]) !== TEST_REDIS_DB) {
      throw new Error(`[integration] Redis connection is on db=${m?.[1]}, expected ${TEST_REDIS_DB}. Aborting.`);
    }
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${TEST_BULL_PREFIX}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) deleted += await redis.del(...keys);
    } while (cursor !== '0');
    return deleted;
  } finally {
    await redis.quit();
  }
}

export default async function globalSetup(): Promise<void> {
  assertIsolatedEnv();

  const root = path.resolve(__dirname, '../..');
  execFileSync(path.join(root, 'scripts/test-db-reset.sh'), {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL },
  });

  const deleted = await clearTestRedis();
  console.log(`[integration] Redis DB ${TEST_REDIS_DB}: cleared ${deleted} ${TEST_BULL_PREFIX}:* keys`);
}
