/**
 * Rebuild the SEN broadcast emails into two audience-specific versions.
 *   A — introducers  (contact_type='introducer'): + £42k introducer fee hook
 *   B — clients      (contact_type='developer'):  + long income debt / pension fund hook
 *
 * Default = PREVIEW (renders samples, writes nothing).
 * Pass --apply to update body_html/subject on the cancelled SEN rows and set status='queued',
 * and flip the broadcast back to 'sending'.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { writeFileSync } from 'fs';

const SEN = '17559609-90e7-47b9-bf59-dcc6f89989b1';
const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const coverageUrl =
  'https://www.insidermedia.com/news/south-west/19m-funding-package-to-support-provision-of-sen-schools-across-the-midlands-and-south-of-england';

const SUBJECT_INTRODUCER = 'How the introducer on our £19m SEN deal earned £42,000';
const SUBJECT_CLIENT = 'Turning Point Capital Advisory arranges circa £19m to deliver three new SEN schools';

const p = (html: string, opts = '') =>
  `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;${opts}">${html}</p>`;

const summary = p(
  'Turning Point Capital Advisory arranged a <strong>circa £19m development and bridging facility</strong> to deliver <strong>three new SEN (Special Educational Needs) schools</strong> across the Midlands and the South of England. We structured it as two tranches over a 24-month term, a development line funding construction of one school and a bridging facility across two completed schools ahead of a longer-term refinance. Completing it required six firms of solicitors across two jurisdictions, a measure of the complexity we work through to get a deal done.'
);

const coverage = p(
  `The transaction has since been covered in the business press. <a href="${coverageUrl}" style="color:#0D9488;font-weight:600;text-decoration:none;">Read the coverage.</a>`
);

const feeHook = p(
  '<strong>The introducer who brought us this deal earned a £42,000 fee.</strong> We pay introducer fees promptly on completion, and every mandate receives senior, partner-led attention.'
);

const longIncomeHook = p(
  'Beyond development and bridging, we are also structuring long income debt facilities for larger portfolios. Several European pension funds are currently offering long-dated, index-linked debt, indicatively priced around CPI plus 1% with amortisation near 2.2% a year, so all-in debt service of roughly 6.6%. For portfolio refinancings above £75m it can be a strong alternative to refinancing every few years and absorbing the transaction costs each time. These funds are sector agnostic but hold strong conviction in social infrastructure, and having just arranged the facility above, we know the sector well on the capital-raising side.'
);

const ctaIntroducer = p(
  'We focus exclusively on operational real estate, typically facilities above £15m, and have arranged <strong>over £60m so far this year</strong>. If you have a client who needs this kind of funding, or know someone who does, introduce them and we will look after you.'
);

const ctaClient = p(
  'We focus exclusively on operational real estate, typically facilities above £15m, and have arranged <strong>over £60m so far this year</strong>. If you are planning a transaction, or weighing a portfolio refinance, we would be glad to talk it through.'
);

function build(firstName: string, audience: 'introducer' | 'client'): string {
  const greeting = firstName && firstName.trim() ? firstName.trim() : 'there';
  const opener =
    audience === 'introducer'
      ? p('I wanted to share a deal we recently completed, and what it meant for the introducer who brought it to us.')
      : p('I wanted to share a deal we recently completed. It shows the kind of operational real estate financing we structure.');
  const title = p('Turning Point Capital Advisory arranges circa £19m to deliver three new SEN schools', 'font-weight:600;color:#0f1a2e;');
  const middle =
    audience === 'introducer'
      ? summary + feeHook + coverage + ctaIntroducer
      : summary + longIncomeHook + coverage + ctaClient;

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
${p(`Hey ${greeting},`, 'color:#0f1a2e;')}
${opener}
${title}
${middle}
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:20px 28px;font-family:Arial,sans-serif;">
<p style="margin:0;font-size:14px;font-weight:700;color:#0f1a2e;">Marcus Emadi</p>
<p style="margin:2px 0 0;font-size:13px;color:#4db8a4;font-weight:600;">CEO</p>
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

async function main() {
  if (!APPLY) {
    writeFileSync('/tmp/sen_introducer_v2.html', build('Sarah', 'introducer'));
    writeFileSync('/tmp/sen_client_v2.html', build('James', 'client'));
    console.log('PREVIEW written to /tmp/sen_introducer_v2.html and /tmp/sen_client_v2.html');
    await pool.end();
    return;
  }

  const targets: Array<{ type: string; audience: 'introducer' | 'client'; subject: string }> = [
    { type: 'introducer', audience: 'introducer', subject: SUBJECT_INTRODUCER },
    { type: 'developer', audience: 'client', subject: SUBJECT_CLIENT },
  ];

  let total = 0;
  for (const t of targets) {
    const rows = await pool.query(
      `SELECT es.id, c.first_name
         FROM email_sends es JOIN contacts c ON c.id = es.contact_id
        WHERE es.broadcast_id = $1 AND es.status = 'cancelled' AND c.contact_type = $2
          AND NOT (c.tags @> ARRAY['unsubscribed'] OR c.tags @> ARRAY['bounced'])`,
      [SEN, t.type]
    );
    for (const r of rows.rows) {
      const html = build(r.first_name || '', t.audience);
      await pool.query(
        `UPDATE email_sends SET body_html = $1, subject = $2, status = 'queued' WHERE id = $3`,
        [html, t.subject, r.id]
      );
    }
    console.log(`${t.audience}: updated + queued ${rows.rows.length} rows`);
    total += rows.rows.length;
  }

  await pool.query(`UPDATE article_broadcasts SET status = 'sending' WHERE id = $1`, [SEN]);
  console.log(`Broadcast ${SEN} set to 'sending'. Total queued: ${total}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
