// One-off (Oct 5 2026 audit): classify tp contacts with no usable type.
import 'dotenv/config';
import { query } from '../../src/db/connection';
import { contactClassifier } from '../../src/services/contact-classifier';

async function main() {
  const rows = await query<{ id: string; email: string }>(
    `SELECT id, email FROM contacts
     WHERE tenant = 'tp' AND (contact_type IS NULL OR contact_type IN ('unknown', 'advisory'))
     ORDER BY created_at DESC`
  );
  console.log(`Classifying ${rows.rows.length} contacts`);
  let i = 0;
  for (const c of rows.rows) {
    i++;
    try {
      const r = await contactClassifier.classify(c.id);
      console.log(`${i}/${rows.rows.length} ${c.email} -> ${r?.contactType ?? 'null'}`);
    } catch (err) {
      console.error(`${i} ${c.email} FAILED: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  process.exit(0);
}
main();
