/**
 * Requirement 10: every outbound message captured in test_outbox, on every
 * channel (sequence, blast, article broadcast, press release), carries:
 *   - List-Unsubscribe with an https URL (+ mailto if implemented)
 *   - List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *   - a visible, resolved unsubscribe link in the HTML (and the text part)
 *   - From on @go.tp.finance
 *   - company identification in the footer (Companies Act 2006 s82 + the
 *     Company, LLP and Business Names Regulations 2015: registered name,
 *     company number, registered office address on business emails)
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../../../src/db/connection';
import { restoreClock, closeAll, createContact, createAccount, outbox, OutboxRow } from '../factories';
import {
  freshWorld, sentStepOne, attemptBlast, attemptBroadcast, attemptPressRelease, attemptManualQueuedSend,
  footerProblems, AccountRow,
} from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

type Channel = 'sequence' | 'blast' | 'broadcast' | 'press release';

async function produce(channel: Channel): Promise<OutboxRow> {
  if (channel === 'sequence') {
    await sentStepOne({ account, email: 'seq@clean-dev.test' });
  } else if (channel === 'blast') {
    const c = await createContact({ email: 'blast@clean-dev.test', firstName: 'Bea' });
    expect(await attemptBlast([c.id])).toEqual([c.email]);
  } else if (channel === 'broadcast') {
    const c = await createContact({ email: 'bc@clean-dev.test', firstName: 'Ben' });
    expect((await attemptBroadcast([c.id])).delivered).toEqual([c.email]);
  } else {
    expect((await attemptPressRelease('desk@clean-press.test')).delivered).toBe(true);
  }
  const rows = await outbox();
  expect(rows).toHaveLength(1);
  return rows[0];
}

const channels: Channel[] = ['sequence', 'blast', 'broadcast', 'press release'];

describe.each(channels)('R10 %s message', (channel) => {
  it('has List-Unsubscribe (https, this send\'s tracking id) and List-Unsubscribe-Post One-Click headers', async () => {
    const m = await produce(channel);
    const lu = m.headers['List-Unsubscribe'];
    expect(lu).toBeDefined();
    const urls = lu.split(',').map(s => s.trim().replace(/^<|>$/g, ''));
    const https = urls.find(u => u.startsWith('https://'));
    expect(https).toBeDefined();
    const sendRow = (await query<{ tracking_id: string }>(`SELECT tracking_id FROM email_sends WHERE gmail_message_id = $1`, [m.fake_message_id])).rows[0];
    expect(https).toBe(`https://track.test.invalid/t/${sendRow.tracking_id}/unsubscribe`);
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // raw RFC 822 carries the same headers
    expect(m.raw_message).toMatch(/\r\nList-Unsubscribe: <https:\/\//);
  });

  it('has a visible, resolved unsubscribe link in the HTML body and the URL in the text part', async () => {
    const m = await produce(channel);
    const url = m.headers['List-Unsubscribe'].replace(/^<|>$/g, '').split('>,')[0];
    expect(m.html_body).toMatch(new RegExp(`<a [^>]*href="${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>\\s*Unsubscribe\\s*</a>`, 'i'));
    expect(m.html_body).not.toMatch(/\{\{\s*unsubscribe_url\s*\}\}|href="#unsubscribe"|href=""/i);
    expect(m.text_body).toContain(url);
  });

  it('is From an @go.tp.finance mailbox (never the root tp.finance domain)', async () => {
    const m = await produce(channel);
    expect(m.from_email).toMatch(/@go\.tp\.finance$/);
    expect(m.from_header).toMatch(/<[^>]+@go\.tp\.finance>$/);
    expect(m.account_email).toMatch(/@go\.tp\.finance$/);
  });

  it('identifies the company in the footer: registered name, company number, registered office', async () => {
    const m = await produce(channel);
    expect(footerProblems(m.html_body), `missing in ${channel} email footer`).toEqual([]);
  });
});

describe('R10 sender domain enforcement', () => {
  it('the gate refuses an external send from a root-domain mailbox (marcus@tp.finance)', async () => {
    const root = await createAccount({ email: 'marcus@tp.finance', limits: { daily: 50, hourly: 50 } });
    const r = await attemptManualQueuedSend(root.id, 'someone@external-dev.test', null);
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/not on go\.tp\.finance/);
  });
});
