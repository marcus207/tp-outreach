/**
 * Requirement 8: Apollo.
 *   Sync (ApolloSyncService.syncContacts, enabled in-test, Apollo HTTP stubbed):
 *     - existing unsubscribed contact keeps the tag after an update (tags merged)
 *     - suppressed emails are never inserted
 *     - new contacts get contact_type NULL, no list membership, no enrolment
 *   Webhook (/api/webhooks/apollo):
 *     - disabled by default: 200, creates nothing
 *     - enabled + no secret: creates nothing
 *     - enabled + secret + bad / missing signature: creates nothing
 *     - enabled + valid signature must still honour suppression and protected tags
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import axios from 'axios';
import request from 'supertest';
import { query } from '../../../src/db/connection';
import { ApolloSyncService } from '../../../src/services/apollo-sync';
import { restoreClock, closeAll, createContact, createSequence, suppress } from '../factories';
import { freshWorld, getApp, waitFor, attemptSequenceEnroll, AccountRow } from './helpers';

let account: AccountRow;
const ENV_KEYS = ['APOLLO_SYNC_ENABLED', 'APOLLO_WEBHOOK_ENABLED', 'APOLLO_WEBHOOK_SECRET'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  ({ account } = await freshWorld());
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) process.env[k] = savedEnv[k];
  vi.restoreAllMocks();
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

function apolloPerson(email: string, extra: Record<string, unknown> = {}) {
  return {
    id: `apollo-${email}`, email, first_name: 'Ana', last_name: 'Apollo', title: 'Director',
    organization_name: 'Apollo Sourced Ltd', linkedin_url: null, city: 'London', country: 'UK',
    label_names: ['Apollo List A'], email_status: 'verified', updated_at: new Date().toISOString(),
    ...extra,
  };
}

async function runSync(people: unknown[]) {
  process.env.APOLLO_SYNC_ENABLED = 'true';
  const post = vi.spyOn(axios, 'post').mockResolvedValue({
    data: { contacts: people, pagination: { page: 1, per_page: 100, total_entries: people.length, total_pages: 1 } },
  });
  await new ApolloSyncService('fake-apollo-key').syncContacts('full');
  expect(post).toHaveBeenCalled(); // the stub (not the network) answered
}

async function contactByEmail(email: string, tenant = 'tp') {
  return (await query<{ id: string; tags: string[]; contact_type: string | null; first_name: string | null; title: string | null }>(
    `SELECT id, tags, contact_type, first_name, title FROM contacts WHERE LOWER(email) = LOWER($1) AND tenant = $2`, [email, tenant])).rows[0];
}

describe('R8 Apollo sync (invoked directly, enabled in-test)', () => {
  it('is a no-op when APOLLO_SYNC_ENABLED is not true (default)', async () => {
    process.env.APOLLO_SYNC_ENABLED = 'false';
    const post = vi.spyOn(axios, 'post');
    await new ApolloSyncService('fake-apollo-key').syncContacts('full');
    expect(post).not.toHaveBeenCalled();
  });

  it('existing contact tagged unsubscribed keeps the tag after a sync update; Apollo labels are merged in', async () => {
    const c = await createContact({ email: 'keepme@dev-co.test', tags: ['unsubscribed', 'vip'] });
    await runSync([apolloPerson('KeepMe@dev-co.test', { label_names: ['Apollo List A'], title: 'CFO' })]);
    const after = await contactByEmail(c.email);
    expect(after.title).toBe('CFO'); // the update did happen
    expect(after.tags).toEqual(expect.arrayContaining(['unsubscribed', 'vip', 'Apollo List A']));
    expect((await attemptSequenceEnroll(account.id, after.id)).refused).toBe(true);
  });

  it('bounced and hold tags also survive a sync whose labels are empty', async () => {
    const c = await createContact({ email: 'tags@dev-co.test', tags: ['bounced', 'hold'] });
    await runSync([apolloPerson(c.email, { label_names: [] })]);
    expect((await contactByEmail(c.email)).tags).toEqual(expect.arrayContaining(['bounced', 'hold']));
  });

  it('suppressed emails are never inserted (exact, any case)', async () => {
    await suppress('gone@dev-co.test', { source: 'unsubscribe-link' });
    await runSync([apolloPerson('Gone@Dev-Co.test'), apolloPerson('fresh@dev-co.test')]);
    expect(await contactByEmail('gone@dev-co.test')).toBeUndefined();
    expect(await contactByEmail('fresh@dev-co.test')).toBeDefined();
  });

  it('a deleted contact (row gone, suppression source=manual-delete, as DELETE /api/contacts writes) is not re-created by the next sync', async () => {
    const c = await createContact({ email: 'deleted@dev-co.test' });
    await suppress(c.email, { source: 'manual-delete', reason: 'deleted by user' });
    await query(`DELETE FROM contacts WHERE id = $1`, [c.id]);
    await runSync([apolloPerson(c.email)]);
    expect(await contactByEmail(c.email)).toBeUndefined();
  });

  it('new contacts get contact_type NULL, no list membership and no enrolment', async () => {
    await query(`INSERT INTO contact_lists (name, tenant) VALUES ('Intro list', 'tp')`);
    await createSequence({ accountIds: [account.id], steps: [{ subject: 'Intro' }] });
    await runSync([apolloPerson('newbie@dev-co.test', { label_names: ['Lenders'] })]);
    const c = await contactByEmail('newbie@dev-co.test');
    expect(c).toBeDefined();
    expect(c.contact_type).toBeNull();
    expect((await query(`SELECT 1 FROM contact_list_members WHERE contact_id = $1`, [c.id])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM sequence_enrollments WHERE contact_id = $1`, [c.id])).rows).toHaveLength(0);
  });

  it('sync update never changes contact_type (a lender stays a lender)', async () => {
    const c = await createContact({ email: 'banker@bank.test', type: 'lender' });
    await runSync([apolloPerson(c.email)]);
    expect((await contactByEmail(c.email)).contact_type).toBe('lender');
  });

  it('sync never touches a loan-intel contact with the same address', async () => {
    const li = await createContact({ email: 'shared@both.test', tenant: 'loan-intel', tags: ['li-tag'] });
    await runSync([apolloPerson(li.email, { title: 'Changed' })]);
    const liAfter = await contactByEmail(li.email, 'loan-intel');
    expect(liAfter.title).toBeNull();
    expect(liAfter.tags).toEqual(['li-tag']);
  });
});

describe('R8 Apollo webhook', () => {
  const SECRET = 'whsec_test_comp_lane';
  const sign = (body: string, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const payload = (email: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ event_type: 'contact_updated', data: { id: `ap-${email}`, email, first_name: 'Web', last_name: 'Hook', label_names: ['Webhook'], ...extra } });

  async function post(body: string, headers: Record<string, string> = {}) {
    const app = await getApp();
    let req = request(app).post('/api/webhooks/apollo').set('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    const res = await req.send(body);
    await new Promise(r => setTimeout(r, 250)); // handler continues after responding
    return res;
  }

  it('disabled by default: returns 200 but creates nothing', async () => {
    delete process.env.APOLLO_WEBHOOK_ENABLED;
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    const body = payload('hook1@dev-co.test');
    const res = await post(body, { 'X-Apollo-Signature': sign(body) });
    expect(res.status).toBe(200);
    expect(await contactByEmail('hook1@dev-co.test')).toBeUndefined();
  });

  it('enabled with NO secret configured: creates nothing (fail closed)', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    process.env.APOLLO_WEBHOOK_SECRET = '';
    const body = payload('hook2@dev-co.test');
    const res = await post(body, { 'X-Apollo-Signature': sign(body, '') });
    expect(res.status).toBe(200);
    expect(await contactByEmail('hook2@dev-co.test')).toBeUndefined();
  });

  it('enabled + secret + BAD signature: creates nothing', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    const body = payload('hook3@dev-co.test');
    await post(body, { 'X-Apollo-Signature': sign(body, 'wrong-secret') });
    expect(await contactByEmail('hook3@dev-co.test')).toBeUndefined();
  });

  it('enabled + secret + MISSING signature: creates nothing', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    await post(payload('hook4@dev-co.test'));
    expect(await contactByEmail('hook4@dev-co.test')).toBeUndefined();
  });

  it('control: enabled + valid signature creates an unclassified, unenrolled contact', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    await createSequence({ accountIds: [account.id], steps: [{ subject: 'Intro' }] });
    const body = payload('hook5@dev-co.test');
    await post(body, { 'X-Apollo-Signature': sign(body) });
    const c = await waitFor(() => contactByEmail('hook5@dev-co.test'), v => !!v);
    expect(c).toBeDefined();
    expect(c.contact_type).toBeNull();
    expect((await query(`SELECT 1 FROM sequence_enrollments WHERE contact_id = $1`, [c.id])).rows).toHaveLength(0);
  });

  it('valid signature: an existing contact tagged unsubscribed KEEPS the tag (tags merged, not replaced)', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    const c = await createContact({ email: 'hook6@dev-co.test', tags: ['unsubscribed'] });
    const body = payload(c.email, { title: 'Updated by webhook' });
    await post(body, { 'X-Apollo-Signature': sign(body) });
    const after = await waitFor(() => contactByEmail(c.email), v => v?.title === 'Updated by webhook');
    expect(after.title).toBe('Updated by webhook');
    expect(after.tags).toContain('unsubscribed');
  });

  it('valid signature: a suppressed address is NOT inserted', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    await suppress('hook7@dev-co.test', { source: 'manual-delete', reason: 'deleted by user' });
    const body = payload('hook7@dev-co.test');
    await post(body, { 'X-Apollo-Signature': sign(body) });
    expect(await contactByEmail('hook7@dev-co.test')).toBeUndefined();
  });
});
