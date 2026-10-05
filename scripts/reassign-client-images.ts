/**
 * Reassign hero images for all Client templates so that:
 * 1. Every email in a sequence gets a unique image (no repeats within 6 steps)
 * 2. Images stay relevant — each sector uses only its own sector images
 * 3. We have 12 images per sector, only need 6, so plenty of variety
 */

import * as fs from 'fs';
import * as path from 'path';
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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Map sector name in template → hero image file prefix
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
    // Get sector-specific images (12 available)
    const sectorImages = allFiles.filter(f => f.startsWith(prefix + '_')).sort();
    console.log(`\n${sector} — ${sectorImages.length} images available`);

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

    // Shuffle and pick 6 unique images
    const picked = shuffle(sectorImages).slice(0, result.rows.length);

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

  console.log('\nDone — all client templates updated with unique sector-relevant hero images.');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
