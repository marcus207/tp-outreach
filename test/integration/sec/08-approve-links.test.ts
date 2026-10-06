/**
 * SEC-08 Emailed approve / skip links (digest + draft-review).
 * GET = confirm page only; POST performs the action; token must match; links
 * older than 72h are refused; a second POST is a no-op; malformed ids => generic 400.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx, sleep } from './helpers';

let app: Express;

beforeAll(async () => { await resetAll(); installFakeGmail(); app = await getApp(); });
afterAll(async () => { await sleep(300); await closeAll(); });
beforeEach(async () => {
  await sleep(150); // let fire-and-forget executeApproved/executeDraftSend from the previous test settle
  await query(`TRUNCATE daily_digest, template_draft_reviews, templates CASCADE`);
});

let digestSeq = 0;
async function mkDigest(ageHours = 0) {
  digestSeq++; // digest_date is UNIQUE
  const r = await query<{ id: string; approval_token: string }>(
    `INSERT INTO daily_digest (digest_date, status, contacts, created_at)
     VALUES (CURRENT_DATE + $2::int, 'pending', '[]', NOW() - make_interval(hours => $1::int)) RETURNING id, approval_token`, [ageHours, digestSeq]);
  return { id: r.rows[0].id, token: String(r.rows[0].approval_token) };
}
async function mkDraft(ageHours = 0) {
  const r = await query<{ id: string; approval_token: string; skip_token: string }>(
    `INSERT INTO template_draft_reviews (theme, season, week_start, email_subject, email_html, status, created_at)
     VALUES ('Test theme', 'autumn', CURRENT_DATE, 'subj', '<p>x</p>', 'awaiting_approval', NOW() - make_interval(hours => $1::int))
     RETURNING id, approval_token, skip_token`, [ageHours]);
  return { id: r.rows[0].id, approval: String(r.rows[0].approval_token), skip: String(r.rows[0].skip_token) };
}
const digestRow = async (id: string) => (await query<{ status: string; approved_at: Date | null }>(`SELECT status, approved_at FROM daily_digest WHERE id = $1`, [id])).rows[0];
const draftRow = async (id: string) => (await query<{ status: string; approved_at: Date | null }>(`SELECT status, approved_at FROM template_draft_reviews WHERE id = $1`, [id])).rows[0];
const ip = () => viaNginx(freshIp());
const OTHER_UUID = '11111111-1111-4111-8111-111111111111';

describe('SEC-08 digest approval link', () => {
  it('GET renders a POST confirm form and changes nothing', async () => {
    const d = await mkDigest();
    for (let i = 0; i < 3; i++) {
      const r = await request(app).get(`/api/digest/${d.id}/approve?token=${d.token}`).set(ip());
      expect(r.status).toBe(200);
      expect(r.text).toMatch(/<form method="POST"/i);
    }
    expect((await digestRow(d.id)).status).toBe('pending');
  });

  it('POST with the right token approves; a second POST is a no-op', async () => {
    const d = await mkDigest();
    const r1 = await request(app).post(`/api/digest/${d.id}/approve/confirm`).set(ip()).type('form').send({ token: d.token });
    expect(r1.status).toBe(200);
    const after1 = await digestRow(d.id);
    expect(after1.approved_at).not.toBeNull();
    const r2 = await request(app).post(`/api/digest/${d.id}/approve/confirm`).set(ip()).type('form').send({ token: d.token });
    expect(r2.status).toBe(400);
    const after2 = await digestRow(d.id);
    expect(after2.approved_at?.toISOString()).toBe(after1.approved_at?.toISOString());
  });

  it('concurrent double POST approves exactly once', async () => {
    const d = await mkDigest();
    const rs = await Promise.all([0, 1, 2, 3].map(() =>
      request(app).post(`/api/digest/${d.id}/approve/confirm`).set(ip()).type('form').send({ token: d.token })));
    expect(rs.filter(r => r.status === 200)).toHaveLength(1);
  });

  it('wrong token (valid UUID shape) rejected on GET and POST, nothing changes', async () => {
    const d = await mkDigest();
    expect((await request(app).get(`/api/digest/${d.id}/approve?token=${OTHER_UUID}`).set(ip())).status).toBe(400);
    expect((await request(app).post(`/api/digest/${d.id}/approve/confirm`).set(ip()).type('form').send({ token: OTHER_UUID })).status).toBe(400);
    expect((await digestRow(d.id)).status).toBe('pending');
  });

  it('a token from a different digest does not work (no cross-object token use)', async () => {
    const a = await mkDigest(); const b = await mkDigest();
    expect((await request(app).post(`/api/digest/${a.id}/approve/confirm`).set(ip()).type('form').send({ token: b.token })).status).toBe(400);
    expect((await digestRow(a.id)).status).toBe('pending');
  });

  it('links older than 72h are refused', async () => {
    const d = await mkDigest(73);
    const r = await request(app).post(`/api/digest/${d.id}/approve/confirm`).set(ip()).type('form').send({ token: d.token });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/expired/i);
    expect((await digestRow(d.id)).status).toBe('pending');
  });

  it('non-UUID id or token => 400 with one generic page (no oracle)', async () => {
    const d = await mkDigest();
    const bodies = new Set<string>();
    for (const [id, tok] of [['abc', d.token], [`${d.id}'--`, d.token], [d.id, 'abc'], [d.id, ''], ['../../etc', d.token]]) {
      const g = await request(app).get(`/api/digest/${encodeURIComponent(id)}/approve?token=${encodeURIComponent(tok)}`).set(ip());
      expect(g.status).toBe(400);
      bodies.add(g.text);
      const p = await request(app).post(`/api/digest/${encodeURIComponent(id)}/approve/confirm`).set(ip()).type('form').send({ token: tok });
      expect(p.status).toBe(400);
    }
    // valid-shape-but-unknown id gives the same page as malformed
    bodies.add((await request(app).get(`/api/digest/${OTHER_UUID}/approve?token=${d.token}`).set(ip())).text);
    expect(bodies.size).toBe(1);
  });

  it('GET with ?token= in the query cannot trigger approval via a GET to the confirm path', async () => {
    const d = await mkDigest();
    const r = await request(app).get(`/api/digest/${d.id}/approve/confirm?token=${d.token}`).set(ip());
    expect(r.status).not.toBe(200);
    expect((await digestRow(d.id)).status).toBe('pending');
  });
});

describe('SEC-08 draft-review approve / skip links', () => {
  it('GET approve and GET skip only render confirm pages', async () => {
    const d = await mkDraft();
    const a = await request(app).get(`/api/draft-reviews/${d.id}/approve?token=${d.approval}`).set(ip());
    const s = await request(app).get(`/api/draft-reviews/${d.id}/skip?token=${d.skip}`).set(ip());
    expect(a.status).toBe(200); expect(s.status).toBe(200);
    expect(a.text).toMatch(/<form method="POST"/i);
    expect(s.text).toMatch(/<form method="POST"/i);
    expect((await draftRow(d.id)).status).toBe('awaiting_approval');
  });

  it('POST approve with the right token approves once; replay is a no-op', async () => {
    const d = await mkDraft();
    const r1 = await request(app).post(`/api/draft-reviews/${d.id}/approve`).set(ip()).type('form').send({ token: d.approval });
    expect(r1.status).toBe(200);
    const first = await draftRow(d.id);
    expect(first.approved_at).not.toBeNull();
    const r2 = await request(app).post(`/api/draft-reviews/${d.id}/approve`).set(ip()).type('form').send({ token: d.approval });
    expect(r2.status).toBe(400);
    const second = await draftRow(d.id);
    expect(second.approved_at?.toISOString()).toBe(first.approved_at?.toISOString());
    const tpl = await query(`SELECT COUNT(*)::int AS n FROM templates`);
    expect(tpl.rows[0].n).toBeLessThanOrEqual(1);
  });

  it('concurrent double POST approves exactly once', async () => {
    const d = await mkDraft();
    const rs = await Promise.all([0, 1, 2, 3].map(() =>
      request(app).post(`/api/draft-reviews/${d.id}/approve`).set(ip()).type('form').send({ token: d.approval })));
    expect(rs.filter(r => r.status === 200)).toHaveLength(1);
  });

  it('skip token cannot approve, approval token cannot skip, foreign token rejected', async () => {
    const d = await mkDraft();
    expect((await request(app).post(`/api/draft-reviews/${d.id}/approve`).set(ip()).type('form').send({ token: d.skip })).status).toBe(400);
    expect((await request(app).post(`/api/draft-reviews/${d.id}/skip`).set(ip()).type('form').send({ token: d.approval })).status).toBe(400);
    expect((await request(app).post(`/api/draft-reviews/${d.id}/approve`).set(ip()).type('form').send({ token: OTHER_UUID })).status).toBe(400);
    expect((await request(app).get(`/api/draft-reviews/${d.id}/approve?token=${d.skip}`).set(ip())).status).toBe(400);
    expect((await draftRow(d.id)).status).toBe('awaiting_approval');
  });

  it('approve links older than 72h are refused', async () => {
    const d = await mkDraft(73);
    const r = await request(app).post(`/api/draft-reviews/${d.id}/approve`).set(ip()).type('form').send({ token: d.approval });
    expect(r.status).toBe(400);
    expect((await draftRow(d.id)).status).toBe('awaiting_approval');
  });

  it('skip links older than 72h are refused too (same emailed-link lifetime)', async () => {
    const d = await mkDraft(73);
    const r = await request(app).post(`/api/draft-reviews/${d.id}/skip`).set(ip()).type('form').send({ token: d.skip });
    expect(r.status).toBe(400);
    expect((await draftRow(d.id)).status).toBe('awaiting_approval');
  });

  it('double POST skip is a no-op the second time', async () => {
    const d = await mkDraft();
    expect((await request(app).post(`/api/draft-reviews/${d.id}/skip`).set(ip()).type('form').send({ token: d.skip })).status).toBe(200);
    expect((await request(app).post(`/api/draft-reviews/${d.id}/skip`).set(ip()).type('form').send({ token: d.skip })).status).toBe(400);
    expect((await draftRow(d.id)).status).toBe('skipped');
  });

  it('non-UUID id / token => 400 generic page, identical for unknown-but-valid ids', async () => {
    const d = await mkDraft();
    const bodies = new Set<string>();
    for (const [id, tok] of [['abc', d.approval], [`${d.id}' OR 1=1--`, d.approval], [d.id, 'abc'], [d.id, ''], [OTHER_UUID, d.approval]]) {
      const g = await request(app).get(`/api/draft-reviews/${encodeURIComponent(id)}/approve?token=${encodeURIComponent(tok)}`).set(ip());
      expect(g.status).toBe(400);
      bodies.add(g.text);
    }
    expect(bodies.size).toBe(1);
    for (const [id, tok] of [['abc', d.approval], [d.id, 'nope']]) {
      const p = await request(app).post(`/api/draft-reviews/${encodeURIComponent(id)}/approve`).set(ip()).type('form').send({ token: tok });
      expect(p.status).toBe(400);
    }
  });

  it('POST error pages do not reveal draft state to a caller without the token', async () => {
    const d = await mkDraft();
    await query(`UPDATE template_draft_reviews SET status = 'sent' WHERE id = $1`, [d.id]);
    const r = await request(app).post(`/api/draft-reviews/${d.id}/skip`).set(ip()).type('form').send({ token: OTHER_UUID });
    expect(r.status).toBe(400);
    expect(r.text).not.toMatch(/already sent/i);
  });
});
