/**
 * Shared BullMQ/ioredis connection options derived from REDIS_URL.
 *
 * Production: REDIS_URL=redis://127.0.0.1:6379 (no db path) yields exactly the
 * same options object as the per-service copies this replaced
 * ({ host, port, password }), i.e. logical DB 0.
 *
 * The logical DB in the URL path (redis://host:port/15) is now honoured, so the
 * integration-test harness can be isolated on DB 15. Under NODE_ENV=test any
 * DB other than 15 is refused outright, so a test can never enqueue onto the
 * production queues in DB 0.
 *
 * Deliberately has no imports from ./connection so unit tests that mock that
 * module keep working.
 */
export const TEST_REDIS_DB = 15;

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export function getRedisConnection(): RedisConnectionOptions {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  const dbPath = parsed.pathname.replace(/^\/+/, '');
  const db = dbPath ? parseInt(dbPath, 10) : 0;

  if (process.env.NODE_ENV === 'test' && db !== TEST_REDIS_DB) {
    throw new Error(
      `[redis] NODE_ENV=test but REDIS_URL points at DB ${db}. Tests must use redis://127.0.0.1:6379/${TEST_REDIS_DB}.`
    );
  }

  const conn: RedisConnectionOptions = {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
  if (db) conn.db = db;
  return conn;
}
