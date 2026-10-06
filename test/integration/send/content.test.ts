/**
 * Requirement 8: template rendering (merge fields, missing names, HTML escaping,
 * no base64 images, brand name) across the sequence, blast and press paths.
 * Requirement 9: message hygiene of what lands in test_outbox.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll, runPlannerPass, drainSendQueue, outbox,
} from '../factories';
import type { OutboxRow } from '../factories';
import { query } from '../../../src/db/connection';
import { campaignEngine } from '../../../src/services/campaign-engine';
import {
  T0, COLD_A, setCampaignActive, createBlast, loggedInAgent, setContactFields,
} from './helpers';

const BARE_BRAND = /Turning Point Capital(?! Advisory)/;
const XSS_NAME = '<script>alert(1)</script>';

async function sendSequenceEmail(o: {
  subject?: string; bodyHtml?: string; contact?: Record<string, unknown>; displayName?: string | null;
} = {}): Promise<OutboxRow> {
  const a = await createAccount({ email: COLD_A, displayName: o.displayName === undefined ? 'Alice Adviser' : o.displayName, limits: { daily: 100, hourly: 50 } });
  const seq = await createSequence({
    accountIds: [a.id],
    steps: [{ subject: o.subject ?? 'Funding for {{company}}', bodyHtml: o.bodyHtml ?? '<p>Hi {{first_name}},</p><p>A note for {{company}}. See <a href="https://www.tp.finance/insights">our insights</a>.</p>' }],
  });
  const c = await createContact({ email: 'render@example-dev.test', firstName: 'Dana', lastName: 'Developer', company: 'Harbourside Homes' });
  if (o.contact) await setContactFields(c.id, o.contact);
  await enroll(seq.id, c.id);
  await runPlannerPass();
  await drainSendQueue();
  const box = await outbox();
  if (box.length !== 1) throw new Error(`expected 1 outbox row, got ${box.length}`);
  return box[0];
}

async function sendBlastEmail(contact: { firstName?: string | null; company?: string }, bodyCopy?: string): Promise<OutboxRow> {
  await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: 50 } });
  await setCampaignActive(true);
  await createBlast({ bodyCopy, contacts: [{ email: 'blastee@example-dev.test', ...contact }] });
  const r = await campaignEngine.tick();
  if (r.contacts_queued !== 1) throw new Error(`blast queued ${r.contacts_queued}: ${JSON.stringify(r)}`);
  await drainSendQueue();
  const box = await outbox();
  if (box.length !== 1) throw new Error(`expected 1 outbox row, got ${box.length}`);
  return box[0];
}

async function sendGeneratedPressRelease(): Promise<OutboxRow> {
  await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: 50 } });
  await query(`INSERT INTO press_contacts (publication, email, contact_name, is_primary) VALUES ('Property Week', 'news@example-press.test', 'Ed', true)`);
  const agent = await loggedInAgent();
  const gen = await agent.post('/api/press-releases/generate').send({ announcement_title: 'TPCA launch', announcement_body: 'Turning Point Capital Advisory launches a fund-side advisory desk.' });
  if (gen.status !== 200) throw new Error(`generate ${gen.status}: ${JSON.stringify(gen.body)}`);
  const sent = await agent.post('/api/press-releases/send-all').send({ announcement_title: 'TPCA launch' });
  if (sent.status !== 200) throw new Error(`send-all ${sent.status}: ${JSON.stringify(sent.body)}`);
  await drainSendQueue();
  return (await outbox())[0];
}

afterAll(async () => { await closeAll(); });

describe('templates: merge fields (sequence path)', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('renders {{first_name}}, {{last_name}}, {{full_name}} and {{company}} in subject and body', async () => {
    const m = await sendSequenceEmail({
      subject: '{{first_name}}, funding for {{company}}',
      bodyHtml: '<p>Hi {{first_name}} {{last_name}} ({{full_name}}) at {{company}}</p>',
    });
    expect(m.subject).toBe('Dana, funding for Harbourside Homes');
    expect(m.html_body).toContain('Hi Dana Developer (Dana Developer) at Harbourside Homes');
    expect(m.html_body).not.toContain('{{');
    expect(m.text_body).not.toContain('{{');
  });

  it.each([['empty string', ''], ['NULL', null]])('a contact with first_name %s never gets "Hi ," / "Hey ,"', async (_l, value) => {
    const m = await sendSequenceEmail({ bodyHtml: '<p>Hi {{first_name}},</p><p>Hey {{first_name}}, quick one.</p>', contact: { first_name: value } });
    expect(m.html_body).not.toMatch(/\b(Hi|Hey|Hello|Dear)\s*,/);
    expect(m.text_body).not.toMatch(/\b(Hi|Hey|Hello|Dear)\s*,/);
  });

  it('a subject made only of an empty merge field is never sent with an empty subject', async () => {
    const m = await sendSequenceEmail({ subject: '{{company}}', contact: { company: '' } }).catch(() => null);
    if (m) expect(m.subject.trim()).not.toBe('');
  });

  it('HTML-escapes a contact-supplied first_name of <script> (no markup injection)', async () => {
    const m = await sendSequenceEmail({ contact: { first_name: XSS_NAME } });
    expect(m.html_body).not.toContain('<script');
    expect(m.raw_message).not.toContain('<script>alert(1)</script>');
  });

  it('HTML-escapes a contact-supplied company containing an <img onerror> payload', async () => {
    const m = await sendSequenceEmail({ contact: { company: '<img src=x onerror=alert(1)>' } });
    expect(m.html_body).not.toMatch(/<img[^>]*onerror/i);
  });
});

describe('templates: blast path', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('renders first_name and company in blast subject and body', async () => {
    const m = await sendBlastEmail({ firstName: 'Bea', company: 'Blast Homes Ltd' });
    expect(m.subject).toBe('Market note for Blast Homes Ltd');
    expect(m.html_body).toContain('Hi Bea,');
  });

  it('a blast contact without first_name gets no raw "{{first_name}}" and no "Hi ,"', async () => {
    const m = await sendBlastEmail({ firstName: null });
    expect(m.html_body).not.toContain('{{first_name}}');
    expect(m.html_body).not.toMatch(/\bHi\s*,/);
  });

  it('HTML-escapes a blast contact first_name of <script>', async () => {
    const m = await sendBlastEmail({ firstName: XSS_NAME });
    expect(m.html_body).not.toContain('<script');
  });

  it('blast HTML contains the unsubscribe link resolved to the tracking URL (no raw {{unsubscribe_url}})', async () => {
    const m = await sendBlastEmail({ firstName: 'Bea' });
    expect(m.html_body).not.toContain('{{unsubscribe_url}}');
    expect(m.html_body).toMatch(/href="https:\/\/track\.test\.invalid\/t\/[0-9a-f]+\/unsubscribe"/);
  });
});

describe('templates: no base64 images and brand name on every path', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('sequence email: no data: URI images; footer brand is "Turning Point Capital Advisory", never bare', async () => {
    const m = await sendSequenceEmail();
    expect(m.raw_message).not.toMatch(/src\s*=\s*["']?data:/i);
    expect(m.html_body).toContain('Turning Point Capital Advisory');
    expect(m.raw_message).not.toMatch(BARE_BRAND);
  });

  it('blast email: no data: URI images; brand never bare "Turning Point Capital"', async () => {
    const m = await sendBlastEmail({ firstName: 'Bea' });
    expect(m.raw_message).not.toMatch(/src\s*=\s*["']?data:/i);
    expect(m.html_body).toContain('Turning Point Capital Advisory');
    expect(m.raw_message).not.toMatch(BARE_BRAND);
  });

  it('generated press release: no data: images, TPCA brand only, never Loan Intel boilerplate', async () => {
    const m = await sendGeneratedPressRelease();
    expect(m).toBeTruthy();
    expect(m.raw_message).not.toMatch(/src\s*=\s*["']?data:/i);
    expect(m.raw_message).not.toMatch(BARE_BRAND);
    expect(m.raw_message).not.toMatch(/Loan Intel/i);
    expect(m.raw_message).not.toMatch(/Kassi Emadi/);
  });
});

describe('message hygiene (requirement 9)', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('From carries a quoted display name and the go.tp.finance address', async () => {
    const m = await sendSequenceEmail();
    expect(m.from_header).toBe('"Alice Adviser" <alice@go.tp.finance>');
  });

  it('an account with no display_name still sends with a display name in From', async () => {
    const m = await sendSequenceEmail({ displayName: null });
    expect(m.from_header).toMatch(/^"?[^"<]+"?\s*<alice@go\.tp\.finance>$/);
  });

  it('Reply-To is present and valid', async () => {
    const m = await sendSequenceEmail();
    expect(m.reply_to).toMatch(/^.+<[^@\s]+@tp\.finance>$/);
  });

  it('has a Message-ID (own header or the Gmail-assigned id) and a non-empty subject', async () => {
    const m = await sendSequenceEmail();
    expect(m.headers['Message-ID'] || m.fake_message_id).toBeTruthy();
    expect(m.subject.trim().length).toBeGreaterThan(0);
  });

  it('is MIME multipart/alternative with a non-empty text/plain part before the HTML part', async () => {
    const m = await sendSequenceEmail();
    const raw = m.raw_message;
    expect(m.headers['MIME-Version']).toBe('1.0');
    expect(m.headers['Content-Type']).toMatch(/^multipart\/alternative; boundary="([^"]+)"$/);
    const boundary = m.headers['Content-Type'].match(/boundary="([^"]+)"/)![1];
    const parts = raw.split(`--${boundary}`);
    const plain = parts.find(p => /Content-Type: text\/plain/i.test(p));
    const html = parts.find(p => /Content-Type: text\/html/i.test(p));
    expect(plain).toBeTruthy();
    expect(html).toBeTruthy();
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
    const plainBody = plain!.split(/\r?\n\r?\n/).slice(1).join('\n').trim();
    expect(plainBody).toContain('Hi Dana');
    expect(plainBody).not.toMatch(/<[a-z][^>]*>/i);
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('the text/plain part keeps link targets (not just anchor text)', async () => {
    const m = await sendSequenceEmail();
    expect(m.text_body).toContain('https://www.tp.finance/insights');
  });

  it('has List-Unsubscribe (https) and List-Unsubscribe-Post one-click headers', async () => {
    const m = await sendSequenceEmail();
    // https one-click URL first; an optional mailto: alternative may follow (RFC 2369)
    expect(m.headers['List-Unsubscribe']).toMatch(/^<https:\/\/[^>]+\/unsubscribe>(, <mailto:[^>]+>)?$/);
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('no open-tracking pixel when TRACK_OPENS is unset/false', async () => {
    const m = await sendSequenceEmail();
    expect(m.html_body).not.toMatch(/\/t\/[0-9a-f]+\/open/);
    expect(m.html_body).not.toMatch(/<img[^>]*width="1"[^>]*height="1"/i);
  });

  it('links are not rewritten through the tracker when TRACK_CLICKS is unset/false', async () => {
    const m = await sendSequenceEmail();
    expect(m.html_body).toContain('href="https://www.tp.finance/insights"');
    expect(m.html_body).not.toContain('/click?url=');
  });

  it('a non-ASCII subject is RFC 2047 encoded in the raw header', async () => {
    const m = await sendSequenceEmail({ subject: '£5m facility for {{company}}' });
    expect(m.raw_message).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  });
});
