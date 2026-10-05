/**
 * Reassign hero images for all Client templates, deduplicating by actual file content.
 * Each sector uses its own images, but skips duplicate files (same content, different name).
 * If a sector doesn't have 6 unique images, supplements from visually-similar sectors.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT = 'tp';
const HERO_DIR = path.join(__dirname, '../data/hero');

const pool = new Pool({ connectionString: DATABASE_URL });

function imageToBase64(filename: string): string {
  const filePath = path.join(HERO_DIR, filename);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filename).slice(1) || 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

function fileMd5(filename: string): string {
  const buf = fs.readFileSync(path.join(HERO_DIR, filename));
  return crypto.createHash('md5').update(buf).digest('hex');
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CLIENT_SECTORS: Record<string, string> = {
  'BTR': 'btr',
  'Care': 'care',
  'Hospitality': 'hospitality',
  'Leisure': 'leisure',
  'Living': 'living',
  'Logistics': 'logistics',
  'Offices': 'office',
  'PBSA': 'pbsa',
  'Retail': 'retail',
  'SFH': 'sfh',
};

async function main() {
  const allFiles = fs.readdirSync(HERO_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

  for (const [sector, prefix] of Object.entries(CLIENT_SECTORS)) {
    // Get sector-specific images, deduplicated by content hash
    const sectorFiles = allFiles.filter(f => f.startsWith(prefix + '_'));
    const hashToFile = new Map<string, string>();
    for (const f of sectorFiles) {
      const hash = fileMd5(f);
      if (!hashToFile.has(hash)) hashToFile.set(hash, f);
    }
    const uniqueFiles = Array.from(hashToFile.values());

    console.log(`\n${sector} — ${sectorFiles.length} files, ${uniqueFiles.length} unique by content`);

    // Get the 6 templates
    const result = await pool.query(
      `SELECT id, name FROM templates
       WHERE tenant = $1 AND name LIKE $2
       ORDER BY name`,
      [TENANT, `Clients — ${sector} — %`]
    );

    if (result.rows.length === 0) {
      console.log(`  SKIP — no templates found`);
      continue;
    }

    // If not enough unique sector images, supplement from the full pool
    let pool_images = shuffle(uniqueFiles);
    if (pool_images.length < result.rows.length) {
      console.log(`  Only ${pool_images.length} unique — supplementing from full pool`);
      const usedHashes = new Set(hashToFile.keys());
      const extras = allFiles.filter(f => {
        const h = fileMd5(f);
        if (usedHashes.has(h)) return false;
        usedHashes.add(h);
        return true;
      });
      pool_images = [...pool_images, ...shuffle(extras)];
    }

    const picked = pool_images.slice(0, result.rows.length);

    for (let i = 0; i < result.rows.length; i++) {
      const template = result.rows[i];
      const newImageFile = picked[i];
      const newBase64 = imageToBase64(newImageFile);

      await pool.query(
        `UPDATE templates
         SET body_html = regexp_replace(body_html, 'data:image/[^"]+', $1),
             updated_at = NOW()
         WHERE id = $2`,
        [newBase64, template.id]
      );

      const stepName = template.name.replace(`Clients — ${sector} — `, '');
      console.log(`  ${stepName} → ${newImageFile}`);
    }
  }

  // Verify
  const check = await pool.query(`
    WITH img_data AS (
      SELECT split_part(name, ' — ', 2) as sector,
        md5(substring(body_html from 'data:image/[^"]+')) as img_hash
      FROM templates WHERE tenant='tp' AND name LIKE 'Clients — %' AND name LIKE '%—%—%'
    )
    SELECT sector, COUNT(*) as total, COUNT(DISTINCT img_hash) as unique_imgs
    FROM img_data GROUP BY sector ORDER BY sector
  `);
  console.log('\nVerification:');
  for (const row of check.rows) {
    const ok = row.total === row.unique_imgs ? 'OK' : 'STILL HAS DUPES';
    console.log(`  ${row.sector}: ${row.unique_imgs}/${row.total} unique — ${ok}`);
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
