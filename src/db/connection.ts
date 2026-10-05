import { Pool, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const TENANT = process.env.TENANT || 'tp';
export const BRAND_NAME = process.env.BRAND_NAME || 'Turning Point Capital';
export const BRAND_DOMAIN = process.env.BRAND_DOMAIN || 'tp.finance';
export const BRAND_EMAIL = process.env.BRAND_EMAIL || 'marcus@tp.finance';

export const BULL_PREFIX = `bull-${TENANT}`;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[DB] Slow query (${duration}ms):`, text.substring(0, 100));
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err);
    throw err;
  }
}

export async function getClient() {
  const client = await pool.connect();
  return client;
}

export default pool;
