import fs from 'fs';
import { query } from '../src/db/connection';
import { replyWatcher } from '../src/services/reply-watcher';

async function main() {
  const raw = fs.existsSync('/tmp/already_forwarded.txt')
    ? fs.readFileSync('/tmp/already_forwarded.txt', 'utf-8')
    : '';
  const already = new Set(raw.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean));

  const rows = (await query<{
    email_send_id: string; to_email: string; contact_name: string; sending_account: string;
  }>(`
    SELECT es.id AS email_send_id, es.to_email,
           COALESCE(c.first_name || ' ' || c.last_name, c.first_name, es.to_email) AS contact_name,
           ea.email AS sending_account
    FROM email_events ee
    JOIN email_sends es ON es.id = ee.email_send_id
    LEFT JOIN email_accounts ea ON ea.id = es.email_account_id
    LEFT JOIN contacts c ON c.id = es.contact_id
    WHERE ee.event_type = 'reply' AND es.tenant = 'tp'
      AND LOWER(ea.email) <> 'marcus@tp.finance'
      AND NOT EXISTS (SELECT 1 FROM email_events f WHERE f.email_send_id = es.id AND f.event_type = 'reply_fwd')
    ORDER BY ee.created_at ASC`)).rows;

  console.log(`Found ${rows.length} missed replies to process\n`);
  let sent = 0, marked = 0, other = 0;

  for (const r of rows) {
    if (already.has(r.to_email.toLowerCase())) {
      await replyWatcher.markForwarded(r.email_send_id);
      console.log(`MARKED (already forwarded historically): ${r.to_email}`);
      marked++;
      continue;
    }
    const res = await replyWatcher.backfillContact(r.email_send_id, r.to_email, r.contact_name, r.sending_account);
    console.log(`${res.toUpperCase().padEnd(12)} ${r.to_email}  (via ${r.sending_account})`);
    if (res === 'sent') sent++;
    else if (res === 'skip-done') marked++;
    else other++;
    await new Promise(res => setTimeout(res, 1500)); // gentle spacing between sends
  }

  console.log(`\nDone. forwarded=${sent}  marked-only=${marked}  needs-attention=${other}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
