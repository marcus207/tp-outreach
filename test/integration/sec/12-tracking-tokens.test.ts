/**
 * SEC-12 Tracking / unsubscribe tokens (ASVS V3.5.x token entropy, V8.3 no leakage).
 * Tokens must be unguessable; unknown tokens must not leak information or change state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import {
  resetAll, installFakeGmail, closeAll, setClock, restoreClock, createAccount, createContact,
  createSequence, enroll, runPlannerPass, drainSendQueue, outbox,
} from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx, ROOT } from './helpers';

let app: Express;
let realId = '';

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  app = await getApp();
  // Produce a real send through the production pipeline to obtain a production-minted tracking id
  setClock();
  const acct = await createAccount({ email: 'marcus.emadi@go.tp.finance', limits: { daily: 10, hourly: 5 } });
  const c = await createContact({ email: 'track-me@harbour.test' });
  const seq = await createSequence({ accountIds: [acct.id], steps: [{ subject: 'Hello' }] });
  await enroll(seq.id, c.id);
  await runPlannerPass();
  await drainSendQueue();
  restoreClock();
  const box = await outbox();
  realId = box[0]?.tracking_id || '';
});
afterAll(async () => { restoreClock(); await closeAll(); });

const ip = () => viaNginx(freshIp());
const counts = async () => {
  const r = await query<{ ev: string; sup: string; tagged: string; cancelled: string }>(`
    SELECT (SELECT COUNT(*) FROM email_events) AS ev,
           (SELECT COUNT(*) FROM suppressed_emails) AS sup,
           (SELECT COUNT(*) FROM contacts WHERE 'unsubscribed' = ANY(tags)) AS tagged,
           (SELECT COUNT(*) FROM sequence_enrollments WHERE status = 'cancelled') AS cancelled`);
  return r.rows[0];
};

describe('SEC-12 token entropy', () => {
  it('production-minted tracking id is >= 128 bits of CSPRNG output (hex >= 32 chars)', () => {
    expect(realId).toMatch(/^[0-9a-f]{32,64}$/);
  });

  it('DB default and every generator in src use a CSPRNG with >= 128 bits', async () => {
    const r = await query<{ d: string }>(`SELECT column_default AS d FROM information_schema.columns WHERE table_name='email_sends' AND column_name='tracking_id'`);
    expect(r.rows[0].d).toMatch(/gen_random_bytes\((1[6-9]|[2-9]\d)\)/);
    const offenders: string[] = [];
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
    for (const f of walk(path.join(ROOT, 'src')).filter(f => f.endsWith('.ts'))) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/tracking_?id|token/i.test(l) && /Math\.random|Date\.now\(\)\.toString|randomBytes\((\d|1[0-5])\)/.test(l)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('1000 ids from the DB default are unique and well distributed', async () => {
    const r = await query<{ t: string }>(`SELECT encode(gen_random_bytes(32), 'hex') AS t FROM generate_series(1, 1000)`);
    const ids = r.rows.map(x => x.t);
    expect(new Set(ids).size).toBe(1000);
    const hist = new Array(16).fill(0);
    for (const id of ids) for (const ch of id) hist[parseInt(ch, 16)]++;
    const mean = hist.reduce((a, b) => a + b) / 16;
    for (const h of hist) expect(Math.abs(h - mean) / mean).toBeLessThan(0.08);
  });
});

describe('SEC-12 unknown tokens: no info leak, no state change', () => {
  const unknowns = ['0'.repeat(64), 'f'.repeat(32), 'abc', "x' OR '1'='1", '%00', 'a'.repeat(5000)];

  it('open/click/unsubscribe with unknown ids change nothing in the DB', async () => {
    const before = await counts();
    for (const u of unknowns) {
      await request(app).get(`/t/${encodeURIComponent(u)}/open`).set(ip());
      await request(app).get(`/t/${encodeURIComponent(u)}/click?url=https://www.tp.finance/`).set(ip());
      await request(app).get(`/t/${encodeURIComponent(u)}/unsubscribe?confirm=1`).set(ip());
      await request(app).post(`/t/${encodeURIComponent(u)}/unsubscribe`).set(ip()).type('form').send('List-Unsubscribe=One-Click');
    }
    expect(await counts()).toEqual(before);
  });

  it('responses for unknown and real ids are indistinguishable (no oracle)', async () => {
    expect(realId).not.toBe('');
    const unk = '0'.repeat(realId.length);
    const pairs: Array<[string, string]> = [
      [`/t/${realId}/open`, `/t/${unk}/open`],
      [`/t/${realId}/unsubscribe`, `/t/${unk}/unsubscribe`],
    ];
    for (const [a, b] of pairs) {
      const ra = await request(app).get(a).set(ip());
      const rb = await request(app).get(b).set(ip());
      expect(ra.status).toBe(rb.status);
      expect(ra.headers['content-type']).toBe(rb.headers['content-type']);
      expect(ra.body?.length ?? ra.text.length).toBe(rb.body?.length ?? rb.text.length);
    }
    const pa = await request(app).post(`/t/${unk}/unsubscribe`).set(ip()).type('form').send('List-Unsubscribe=One-Click');
    expect(pa.status).toBe(200);
    expect(pa.text).toBe('OK');
  });

  it('GET unsubscribe without confirm=1 never changes state (scanner-safe); POST needs the RFC 8058 body', async () => {
    const before = await counts();
    await request(app).get(`/t/${realId}/unsubscribe`).set(ip());
    await request(app).head(`/t/${realId}/unsubscribe`).set(ip());
    await request(app).post(`/t/${realId}/unsubscribe`).set(ip()).send({});
    await request(app).post(`/t/${realId}/unsubscribe`).set(ip()).type('form').send('List-Unsubscribe=Nope');
    expect(await counts()).toEqual(before);
  });

  it('pages for real ids do not disclose the recipient address or name', async () => {
    const a = await request(app).get(`/t/${realId}/unsubscribe`).set(ip());
    const b = await request(app).get(`/t/${realId}/unsubscribe?confirm=1`).set(ip());
    for (const r of [a, b]) {
      expect(r.text).not.toContain('track-me@harbour.test');
      expect(r.text).not.toContain(realId);
    }
  });

  it('tracking responses are not cacheable by intermediaries', async () => {
    const r = await request(app).get(`/t/${realId}/open`).set(ip());
    expect(String(r.headers['cache-control'])).toMatch(/no-store/);
  });
});
