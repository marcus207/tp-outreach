/**
 * Sync the Gmail sendAs signature of all tp.finance sending accounts to match marcus@tp.finance.
 * Default = PREVIEW (reads marcus@ signature + each account's current signature, writes nothing).
 * Pass --apply to push marcus@'s signature onto the other accounts.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { query, TENANT } from '../src/db/connection';
import { gmailClient } from '../src/services/gmail-client';
import { EmailAccount } from '../src/types';

const APPLY = process.argv.includes('--apply');
const SOURCE = 'marcus@tp.finance';

async function getSig(acct: EmailAccount): Promise<string> {
  const auth = await gmailClient.getAuthenticatedClient(acct);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.settings.sendAs.get({ userId: 'me', sendAsEmail: acct.email });
  return res.data.signature || '';
}

async function setSig(acct: EmailAccount, signature: string): Promise<void> {
  const auth = await gmailClient.getAuthenticatedClient(acct);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.settings.sendAs.patch({
    userId: 'me',
    sendAsEmail: acct.email,
    requestBody: { signature },
  });
}

async function main() {
  const { rows: accounts } = await query<EmailAccount>(
    `SELECT * FROM email_accounts WHERE tenant = $1 AND email LIKE '%@tp.finance' ORDER BY email`,
    [TENANT]
  );
  const source = accounts.find((a) => a.email === SOURCE);
  if (!source) throw new Error(`${SOURCE} not found among tp accounts`);

  const sourceSig = await getSig(source);
  console.log(`\n=== SOURCE ${SOURCE} signature (${sourceSig.length} chars) ===\n`);
  console.log(sourceSig || '(empty)');
  console.log('\n=== Targets ===');

  for (const acct of accounts) {
    if (acct.email === SOURCE) continue;
    const before = await getSig(acct);
    if (!APPLY) {
      console.log(`- ${acct.email}: current ${before.length} chars ${before === sourceSig ? '(already matches)' : '(differs)'}`);
      continue;
    }
    if (before === sourceSig) {
      console.log(`- ${acct.email}: already matches, skipped`);
      continue;
    }
    await setSig(acct, sourceSig);
    console.log(`- ${acct.email}: updated to match ${SOURCE}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.response?.data || e);
  process.exit(1);
});
