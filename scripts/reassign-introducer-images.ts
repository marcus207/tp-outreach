/**
 * Reassign hero images for all Introducer templates so that:
 * 1. Every email in a sequence gets a unique image (no repeats within 6 steps)
 * 2. Different introducer specialisms draw from the full image pool for variety
 * 3. No two consecutive emails in a sequence share the same image
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT = 'tp';
const HERO_DIR = path.join(__dirname, '../data/hero');

const pool = new Pool({ connectionString: DATABASE_URL });

// All available hero image files (mixing all categories)
function getAllHeroImages(): string[] {
  return fs.readdirSync(HERO_DIR)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();
}

function imageToBase64(filename: string): string {
  const filePath = path.join(HERO_DIR, filename);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filename).slice(1) || 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

// Shuffle array (Fisher-Yates)
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const INTRODUCER_SPECIALISMS = [
  'Accountant', 'Advisory', 'Agent', 'Construction',
  'Lawyer', 'Planning / Architect', 'Surveyor', 'Wealth',
];

async function main() {
  const allImages = getAllHeroImages();
  console.log(`Found ${allImages.length} hero images in pool`);

  // Exclude category-specific images for introducers — use a mix from ALL categories
  // This gives maximum variety across introducer specialisms
  const shuffled = shuffle(allImages);

  // Assign 6 unique images per specialism, cycling through the shuffled pool
  // Offset each specialism so they don't all start with the same images
  let poolIndex = 0;

  for (const specialism of INTRODUCER_SPECIALISMS) {
    // Get the 6 templates for this specialism, ordered by step
    const result = await pool.query(
      `SELECT id, name FROM templates
       WHERE tenant = $1 AND name LIKE $2
       ORDER BY name`,
      [TENANT, `Introducers — ${specialism} — %`]
    );

    if (result.rows.length === 0) {
      console.log(`  SKIP ${specialism} — no templates found`);
      continue;
    }

    console.log(`\n${specialism} (${result.rows.length} templates):`);

    // Pick 6 unique images for this specialism
    const assignedImages: string[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      // Cycle through pool, skip if same as previous in this sequence
      let attempts = 0;
      while (attempts < allImages.length) {
        const candidate = shuffled[poolIndex % shuffled.length];
        poolIndex++;
        attempts++;

        // Ensure not same as previous step's image
        if (assignedImages.length > 0 && candidate === assignedImages[assignedImages.length - 1]) {
          continue;
        }
        // Ensure not already used in this sequence
        if (assignedImages.includes(candidate)) {
          continue;
        }

        assignedImages.push(candidate);
        break;
      }
    }

    // Now update each template's body_html with the new hero image
    for (let i = 0; i < result.rows.length; i++) {
      const template = result.rows[i];
      const newImageFile = assignedImages[i];
      const newBase64 = imageToBase64(newImageFile);

      // Replace the existing base64 image in body_html
      // Pattern: src="data:image/..." — replace the entire data URI
      await pool.query(
        `UPDATE templates
         SET body_html = regexp_replace(
           body_html,
           'data:image/[^"]+',
           $1
         ),
         updated_at = NOW()
         WHERE id = $2`,
        [newBase64, template.id]
      );

      const stepName = template.name.replace(`Introducers — ${specialism} — `, '');
      console.log(`  ${stepName} → ${newImageFile}`);
    }
  }

  console.log('\nDone — all introducer templates updated with unique hero images.');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
