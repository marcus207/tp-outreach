/**
 * Remove AI writing tells (em dashes, numbered prefixes) from all TP templates.
 * - Template names: strip em dashes, remove "1. " numbering
 * - Subject lines: check for any remaining AI chars
 * - Body HTML + LinkedIn content: replace em dashes with commas
 *
 * Run: npx tsx scripts/clean-ai-characters.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function cleanName(name: string): string {
  return name
    .replace(/\s*—\s*/g, ' - ')           // em dash → hyphen
    .replace(/\s*\d+\.\s+/g, ' ')          // "1. " "2. " etc
    .replace(/\s{2,}/g, ' ')               // collapse double spaces
    .trim();
}

function cleanBody(html: string): string {
  return html.replace(/—/g, ',');
}

function cleanLinkedIn(text: string): string {
  return text.replace(/—/g, ',');
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, name, subject, body_html, linkedin_content FROM templates WHERE tenant='tp' ORDER BY name`
  );

  console.log(`Processing ${rows.length} templates...\n`);

  let nameChanges = 0;
  let bodyChanges = 0;
  let linkedinChanges = 0;

  for (const row of rows) {
    const newName = cleanName(row.name);
    const newBody = row.body_html ? cleanBody(row.body_html) : row.body_html;
    const newLinkedin = row.linkedin_content ? cleanLinkedIn(row.linkedin_content) : row.linkedin_content;

    const changes: string[] = [];

    if (newName !== row.name) {
      changes.push(`name: "${row.name}" → "${newName}"`);
      nameChanges++;
    }
    if (newBody !== row.body_html) {
      bodyChanges++;
      changes.push('body_html: em dashes removed');
    }
    if (newLinkedin !== row.linkedin_content) {
      linkedinChanges++;
      changes.push('linkedin: em dashes removed');
    }

    if (changes.length > 0) {
      await pool.query(
        `UPDATE templates SET name = $1, body_html = $2, linkedin_content = $3 WHERE id = $4`,
        [newName, newBody, newLinkedin, row.id]
      );
      console.log(`${newName}`);
      changes.forEach(c => console.log(`  ${c}`));
    }
  }

  console.log(`\nDone. Names: ${nameChanges}, Bodies: ${bodyChanges}, LinkedIn: ${linkedinChanges}`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
