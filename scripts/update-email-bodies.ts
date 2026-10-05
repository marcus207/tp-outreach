/**
 * Replace thin email body content with the richer LinkedIn post content.
 * Keeps the existing email shell (header, gradient, signature, footer).
 *
 * Run: npx tsx scripts/update-email-bodies.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function linkedinToHtmlParagraphs(text: string): string {
  return text
    .split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">${p.trim()}</p>`)
    .join('\n');
}

function buildEmailHtml(sectorUrl: string, bodyParagraphs: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 16px;">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#0f1a2e;padding:16px 28px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">TP</span><span style="color:#9ca3af;font-size:12px;margin-left:8px;font-family:Arial,sans-serif;">Turning Point Capital</span></td>
</tr></table>
</td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#4db8a4,#74DFF6);font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 24px;font-family:Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:15px;color:#0f1a2e;line-height:1.7;">Hey {{first_name}},</p>
${bodyParagraphs}
<p style="margin:0;"><a href="${sectorUrl}" style="color:#0D9488;font-size:14px;font-weight:600;text-decoration:none;">${sectorUrl}</a></p>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:20px 28px;font-family:Arial,sans-serif;">
<p style="margin:0;font-size:14px;font-weight:700;color:#0f1a2e;">Marcus Emadi</p>
<p style="margin:2px 0 0;font-size:13px;color:#4db8a4;font-weight:600;">Managing Director</p>
<p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Turning Point Capital Advisory</p>
<p style="margin:4px 0 0;font-size:12px;"><a href="mailto:marcus@tp.finance" style="color:#9ca3af;text-decoration:none;">marcus@tp.finance</a> · <a href="https://tp.finance" style="color:#9ca3af;text-decoration:none;">tp.finance</a></p>
</td></tr>
<tr><td style="background:#f8f9fb;padding:12px 28px;border-top:1px solid #e5e7eb;text-align:center;">
<p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Turning Point Capital Advisory Ltd · London · <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>
</td></tr>
</table>`;
}

const SECTOR_URLS: Record<string, string> = {
  'Hospitality': 'https://tp.finance/sectors/hospitality',
  'PBSA': 'https://tp.finance/sectors/pbsa',
  'Living': 'https://tp.finance/sectors/living',
  'Offices': 'https://tp.finance/sectors/offices',
  'Retail': 'https://tp.finance/sectors/retail',
  'Care': 'https://tp.finance/sectors/care',
  'BTR': 'https://tp.finance/sectors/btr',
  'Logistics': 'https://tp.finance/sectors/logistics',
  'SFH': 'https://tp.finance/sectors/sfh',
  'Leisure': 'https://tp.finance/sectors/leisure',
};

async function main() {
  const { rows } = await pool.query(
    `SELECT id, name, linkedin_content FROM templates WHERE tenant='tp' AND linkedin_content IS NOT NULL AND linkedin_content != '' ORDER BY name`
  );

  console.log(`Found ${rows.length} templates with LinkedIn content\n`);

  let updated = 0;
  for (const row of rows) {
    const sectorMatch = row.name.match(/Clients — (\w+)/);
    if (!sectorMatch) {
      console.log(`SKIP (not a client template): ${row.name}`);
      continue;
    }

    const sectorKey = sectorMatch[1];
    const sectorUrl = SECTOR_URLS[sectorKey];
    if (!sectorUrl) {
      console.log(`SKIP (no sector URL for ${sectorKey}): ${row.name}`);
      continue;
    }

    const bodyParagraphs = linkedinToHtmlParagraphs(row.linkedin_content);
    const newHtml = buildEmailHtml(sectorUrl, bodyParagraphs);

    await pool.query(`UPDATE templates SET body_html = $1 WHERE id = $2`, [newHtml, row.id]);
    updated++;
    console.log(`Updated: ${row.name}`);
  }

  console.log(`\nDone. Updated ${updated} templates.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
