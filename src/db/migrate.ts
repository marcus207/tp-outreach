import fs from 'fs';
import path from 'path';
import { pool } from './connection';
import dotenv from 'dotenv';

dotenv.config();

async function migrate() {
  console.log('[Migrate] Starting database migration...');

  const client = await pool.connect();

  try {
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      // Check if migration already applied
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE filename = $1',
        [file]
      );

      if (rows.length > 0) {
        console.log(`[Migrate] Skipping ${file} (already applied)`);
        continue;
      }

      console.log(`[Migrate] Applying ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[Migrate] Applied ${file} successfully`);
      } catch (err) {
        await client.query('ROLLBACK');
        const error = err as Error;
        // Handle "already exists" errors gracefully
        if (
          error.message.includes('already exists') ||
          error.message.includes('duplicate key')
        ) {
          console.warn(`[Migrate] ${file} partially applied (some objects already exist)`);
          // Still mark as applied to avoid re-running
          try {
            await client.query('INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
          } catch {
            // ignore
          }
        } else {
          console.error(`[Migrate] Failed to apply ${file}:`, error.message);
          throw err;
        }
      }
    }

    console.log('[Migrate] All migrations complete');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('[Migrate] Fatal error:', err);
  process.exit(1);
});
