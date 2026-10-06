/**
 * SHADOW RUN: replay the next N weekdays of tp.finance sequence sending against a
 * READ-ONLY copy of real prod data, in dryrun, inside the isolated `shadow` lane.
 *
 * Run (no npm script needed):
 *   cd /root/tp-outreach && TEST_LANE=shadow NODE_ENV=test npx tsx scripts/shadow-run.ts
 *   options: --days 5        weekdays to simulate (default 5)
 *            --skip-copy     reuse the data already in the shadow DB (re-runs the copy otherwise)
 *
 * Safety:
 *   - Refuses unless TEST_LANE=shadow and the target DB is tpca_outreach_test_shadow.
 *     Every env var the vitest integration config pins is pinned here too, BEFORE
 *     any src/ import (dotenv never overrides an already-set variable).
 *   - Imports test/integration/setup.ts: isolation assertions + outbound network guard.
 *   - SEND_MODE=dryrun + NODE_ENV=test: sends land in test_outbox only.
 *   - Prod (tpca_platform) is only ever read: `COPY (SELECT ...) TO STDOUT` through a psql
 *     session started with default_transaction_read_only=on. Nothing is written to prod.
 *   - oauth_tokens are replaced with '{}' on copy; secret-looking settings keys are not copied.
 *   - Redis: DB 15, prefix bull-test-shadow only.
 */
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SHADOW_DB = 'tpca_outreach_test_shadow';
const SHADOW_URL = `postgresql://tpca@localhost:5432/${SHADOW_DB}`;
const PROD_URL = 'postgresql://tpca@localhost:5432/tpca_platform';
const HISTORY_DAYS = 120;
const NOREPLY_RE = '(^|[._-])(no-?reply|donotreply|notifications?|enews|newsletter|mailer|bounce|alerts?|news)[@.]|@(notifications?|enews|email|mail|news|user)\\.';

// ── 1. Guards + env pinning (before any src/ import) ─────────────────────
function refuse(msg: string): never {
  console.error(`[shadow-run] REFUSING: ${msg}`);
  process.exit(2);
}
if ((process.env.TEST_LANE || '').toLowerCase() !== 'shadow') refuse('TEST_LANE must be "shadow"');
if (process.env.NODE_ENV !== 'test') refuse('NODE_ENV must be "test"');
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.endsWith(`/${SHADOW_DB}`)) {
  refuse(`DATABASE_URL points at '${process.env.DATABASE_URL.split('/').pop()}', only ${SHADOW_DB} is allowed`);
}
if (process.env.SEND_MODE === 'live') refuse('SEND_MODE=live');

const PINNED: Record<string, string> = {
  TEST_LANE: 'shadow', NODE_ENV: 'test', SEND_MODE: 'dryrun', TENANT: 'tp',
  DATABASE_URL: SHADOW_URL, REDIS_URL: 'redis://127.0.0.1:6379/15', BULL_PREFIX: 'bull-test-shadow',
  TRACKING_DOMAIN: 'https://track.test.invalid', COLD_SENDER_DOMAIN: 'go.tp.finance',
  BRAND_EMAIL: 'marcus@tp.finance', BRAND_NAME: 'Turning Point Capital Advisory', BRAND_DOMAIN: 'tp.finance',
  PORT: '0', GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/test/oauth/callback', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
  APOLLO_API_KEY: '', APOLLO_WEBHOOK_SECRET: '', BRAVE_API_KEY: '', BRAVE_SEARCH_API_KEY: '',
  STRAPI_URL: 'http://localhost:1/strapi-disabled', STRAPI_API_TOKEN: '', BETTERSTACK_API_KEY: '',
  DRIPIFY_INGEST_KEY: 'test-dripify-key', APOLLO_SYNC_ENABLED: 'false', APOLLO_WEBHOOK_ENABLED: 'false',
  TP_AUTO_ENROL_ENABLED: 'false', TRACK_OPENS: 'false', TRACK_CLICKS: 'false',
  SESSION_SECRET: 'test-session-secret', DASHBOARD_EMAIL: 'test@tp.finance', DASHBOARD_PASSWORD: 'test-password',
};
Object.assign(process.env, PINNED);

const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) > 0 && args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 5;
const SKIP_COPY = args.includes('--skip-copy');

// ── 2. JS clock shim (Date only; timers stay real) ───────────────────────
const RealDate = Date;
let simMs: number | null = null;
class SimDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(simMs ?? RealDate.now());
    else super(...(a as [string]));
  }
  static now(): number { return simMs ?? RealDate.now(); }
  static [Symbol.hasInstance](x: unknown): boolean { return x instanceof RealDate; }
}
(globalThis as unknown as { Date: DateConstructor }).Date = SimDate as unknown as DateConstructor;
const setJsClock = (d: Date) => { simMs = d.getTime(); };

// ── helpers ──────────────────────────────────────────────────────────────
function sh(cmd: string, env: Record<string, string> = {}): string {
  const r = spawnSync('bash', ['-o', 'pipefail', '-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf-8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`[shadow-run] command failed (${r.status}): ${cmd}\n${r.stderr}`);
  return r.stdout;
}
/** Read-only prod query, results as text. */
function prodQuery(sql: string): string {
  return sh(`psql "$PROD" -X -Atq -v ON_ERROR_STOP=1 -c "$SQL"`, { PROD: PROD_URL, SQL: sql, PGOPTIONS: '-c default_transaction_read_only=on' });
}
/** COPY rows from prod (read-only session) straight into a shadow table. */
function copyTable(table: string, cols: string[], selectSql: string): number {
  const target = `COPY public.${table} (${cols.map(c => `"${c}"`).join(', ')}) FROM STDIN`;
  sh(`PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD" -X -q -v ON_ERROR_STOP=1 -c "$SRC" | psql "$SHADOW" -X -q -v ON_ERROR_STOP=1 -c "$DST"`,
    { PROD: PROD_URL, SHADOW: SHADOW_URL, SRC: `COPY (${selectSql.replace(/\s+/g, ' ')}) TO STDOUT`, DST: target });
  return Number(sh(`psql "$SHADOW" -X -Atq -c "SELECT COUNT(*) FROM public.${table}"`, { SHADOW: SHADOW_URL }).trim());
}
function shadowCols(table: string): string[] {
  return sh(`psql "$SHADOW" -X -Atq -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position"`,
    { SHADOW: SHADOW_URL }).trim().split('\n').filter(Boolean);
}
const londonFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const london = (d: Date | string) => londonFmt.format(new RealDate(d as string));
const maskEmail = (e: string) => { const [l, d] = (e || '').split('@'); return `${(l || '').slice(0, 2)}***@${d || ''}`; };
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function mdTable(rows: Array<Record<string, unknown>>, cols?: string[]): string {
  if (!rows.length) return '_none_\n';
  const c = cols || Object.keys(rows[0]);
  return `| ${c.join(' | ')} |\n|${c.map(() => '---').join('|')}|\n` +
    rows.map(r => `| ${c.map(k => String(r[k] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`).join('\n') + '\n';
}

// ── 3. Copy prod -> shadow ───────────────────────────────────────────────
function copyProd(cutoffIso: string): Record<string, number> {
  console.log('[shadow-run] resetting shadow DB from test/schema.sql');
  execFileSync(path.join(ROOT, 'scripts/test-db-reset.sh'), { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: SHADOW_URL } });

  const counts: Record<string, number> = {};
  const plain = (t: string, where = 'TRUE') => {
    const cols = shadowCols(t);
    counts[t] = copyTable(t, cols, `SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM public.${t} WHERE ${where}`);
    console.log(`[shadow-run] copied ${t}: ${counts[t]}`);
  };
  const withOverrides = (t: string, overrides: Record<string, string>, where = 'TRUE') => {
    const cols = shadowCols(t);
    const sel = cols.map(c => overrides[c] ? `${overrides[c]} AS "${c}"` : `"${c}"`).join(', ');
    counts[t] = copyTable(t, cols, `SELECT ${sel} FROM public.${t} WHERE ${where}`);
    console.log(`[shadow-run] copied ${t}: ${counts[t]}`);
  };

  plain('contacts');
  plain('contact_lists');
  plain('contact_list_members');
  plain('templates');
  plain('sequences');
  plain('sequence_steps');
  plain('template_rotations');
  plain('sequence_enrollments');
  plain('suppressed_emails');
  plain('settings', `key !~* '(key|secret|token|password|oauth|api|credential|session)'`);
  withOverrides('email_accounts', { oauth_tokens: `'{}'::jsonb` });
  const sendWhere = `created_at >= '${cutoffIso}'`;
  // body_html blanked (history only needs ids/status/thread), broadcast_id nulled (article_broadcasts not copied)
  withOverrides('email_sends', { body_html: `''`, broadcast_id: 'NULL' }, sendWhere);
  plain('email_events', `email_send_id IN (SELECT id FROM public.email_sends WHERE ${sendWhere})`);

  // All-time replied / bounced contacts (any 'reply' event ever), for the invariants only
  sh(`psql "$SHADOW" -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE public.shadow_history_flags (kind text, email text, contact_id uuid)"`, { SHADOW: SHADOW_URL });
  counts.history_flags = copyTable('shadow_history_flags', ['kind', 'email', 'contact_id'],
    `SELECT DISTINCT CASE WHEN ee.event_type = 'reply' THEN 'reply' ELSE 'bounce' END, LOWER(es.to_email), es.contact_id
     FROM public.email_events ee JOIN public.email_sends es ON es.id = ee.email_send_id
     WHERE es.tenant = 'tp' AND ee.event_type IN ('reply', 'bounce')`);

  // Shadow-only: warm-up limits on the one cold sender, fresh counters
  sh(`psql "$SHADOW" -X -q -v ON_ERROR_STOP=1 -c "$SQL"`, { SHADOW: SHADOW_URL, SQL:
    `UPDATE email_accounts SET daily_limit = 10, hourly_limit = 2, sends_today = 0, sends_this_hour = 0 WHERE LOWER(email) = 'marcus.emadi@go.tp.finance';
     UPDATE email_accounts SET sends_today = 0, sends_this_hour = 0;
     ANALYZE;` });
  return counts;
}

// ── 4. Main ──────────────────────────────────────────────────────────────
async function main() {
  await import('../test/integration/setup'); // isolation asserts + network guard
  const realNow = new RealDate();
  const cutoff = new RealDate(realNow.getTime() - HISTORY_DAYS * 86400000).toISOString();
  const copyCounts = SKIP_COPY ? {} : copyProd(cutoff);

  const { query, pool } = await import('../src/db/connection');
  const sim = await import('../test/integration/shadow/sim');
  const { setGmailTransportForTests } = await import('../src/services/gmail-client');
  const { fakeGmail } = await import('../test/integration/fake-gmail');
  const { clearTestRedis } = await import('../test/integration/global-setup');
  const { sendQueue } = await import('../src/services/send-queue');
  const { sequenceEngine } = await import('../src/services/sequence-engine');
  sim.assertShadowDb();
  setGmailTransportForTests(fakeGmail.factory);
  await clearTestRedis();

  await sim.installSimDbClock();
  await query(`TRUNCATE test_outbox`);
  // Sim window: from the next full hour after real now, through the end of the Nth weekday after today
  const from = new RealDate(Math.ceil(realNow.getTime() / 3600000) * 3600000);
  let days = 0;
  let cursor = new RealDate(Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate(), 12));
  while (days < DAYS) { cursor = new RealDate(cursor.getTime() + 86400000); const wd = cursor.getUTCDay(); if (wd >= 1 && wd <= 5) days++; }
  const to = new RealDate(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 23)); // 00:00 BST next day
  await sim.setSimTime(from, setJsClock);
  await sim.assertSimClockWorks();
  const fromIso = from.toISOString();

  // ── Pre-sim snapshot: overdue enrolments ──
  const preDue = (await query<{ n: string }>(`SELECT COUNT(*)::text n FROM sequence_enrollments WHERE tenant='tp' AND status='active' AND next_step_due_at <= NOW()`)).rows[0].n;
  const preActive = (await query<{ n: string }>(`SELECT COUNT(*)::text n FROM sequence_enrollments WHERE tenant='tp' AND status='active'`)).rows[0].n;
  const preNullDue = (await query<{ n: string }>(`SELECT COUNT(*)::text n FROM sequence_enrollments WHERE tenant='tp' AND status='active' AND next_step_due_at IS NULL`)).rows[0].n;
  const overdueBuckets = (await query(`
    SELECT next_step_number AS step,
           COUNT(*) FILTER (WHERE next_step_due_at <= NOW()) AS due_now,
           COUNT(*) FILTER (WHERE next_step_due_at < NOW() - INTERVAL '30 days') AS over_30d,
           COUNT(*) FILTER (WHERE next_step_due_at < NOW() - INTERVAL '90 days') AS over_90d,
           to_char(MIN(next_step_due_at) AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS oldest_due
    FROM sequence_enrollments WHERE tenant='tp' AND status='active' AND next_step_due_at IS NOT NULL
    GROUP BY 1 ORDER BY 1`)).rows;
  const over30BySeq = (await query(`
    SELECT s.name AS sequence, e.next_step_number AS step, COUNT(*) AS over_30d
    FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
    WHERE e.tenant='tp' AND e.status='active' AND e.next_step_due_at < NOW() - INTERVAL '30 days'
    GROUP BY 1,2 ORDER BY 3 DESC LIMIT 25`)).rows;
  const mostOverdue = (await query<{ id: string; email: string; contact_type: string; sequence: string; seq_status: string; step: number; due: Date; days_overdue: string }>(`
    SELECT e.id, c.email, c.contact_type, s.name AS sequence, s.status AS seq_status, e.next_step_number AS step,
           e.next_step_due_at AS due, ROUND(EXTRACT(EPOCH FROM (NOW() - e.next_step_due_at)) / 86400)::text AS days_overdue
    FROM sequence_enrollments e JOIN contacts c ON c.id = e.contact_id JOIN sequences s ON s.id = e.sequence_id
    WHERE e.tenant='tp' AND e.status='active' AND e.next_step_due_at <= NOW()
    ORDER BY e.next_step_due_at ASC LIMIT 10`)).rows;
  const stranded = (await query(`
    SELECT n.current_step AS step,
           COALESCE((SELECT es.status || COALESCE(': ' || LEFT(es.error_message, 50), '') FROM email_sends es
                     WHERE es.enrollment_id = n.id ORDER BY es.created_at DESC LIMIT 1), '(no send in last ${HISTORY_DAYS}d)') AS last_send,
           COUNT(*) AS enrolments
    FROM sequence_enrollments n WHERE n.tenant='tp' AND n.status='active' AND n.next_step_due_at IS NULL
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15`)).rows;
  const noreplyDue = (await query<{ n: string }>(`SELECT COUNT(*)::text n FROM sequence_enrollments e JOIN contacts c ON c.id=e.contact_id
    WHERE e.tenant='tp' AND e.status='active' AND e.next_step_due_at <= NOW() AND c.email ~* '${NOREPLY_RE}'`)).rows[0].n;
  const accountsInfo = (await query(`SELECT email, is_active, daily_limit, hourly_limit FROM email_accounts WHERE tenant='tp' ORDER BY email`)).rows;
  const seqAccounts = (await query(`
    SELECT s.name, s.status, COALESCE((SELECT string_agg(a.email, ', ') FROM email_accounts a WHERE a.id = ANY(s.sending_account_ids)), '(all)') AS accounts,
           (SELECT COUNT(*) FROM sequence_enrollments e WHERE e.sequence_id = s.id AND e.status='active' AND e.next_step_due_at <= NOW()) AS due_now
    FROM sequences s WHERE s.tenant='tp' ORDER BY due_now DESC`)).rows;

  // ── Simulate ──
  console.log(`[shadow-run] simulating ${london(from)} -> ${london(to)} (${DAYS} weekdays), ${preDue} enrolments due now`);
  const stats = sim.newStats();
  const t0 = RealDate.now();
  await sim.simulate({ from, to, setJsClock, stats, quiet: true });
  const simWallS = Math.round((RealDate.now() - t0) / 1000);

  // ── Results ──
  const S = `email_sends es JOIN test_outbox o ON o.tracking_id = es.tracking_id`;
  const sends = (await query(`
    SELECT es.id, es.sent_at, es.enrollment_id, es.contact_id, es.sequence_step_id, o.from_email, o.to_email, o.subject, o.html_body, o.text_body,
           c.contact_type, c.subsector, c.tenant AS contact_tenant, s.name AS sequence, ss.step_number AS step, t.name AS template, t.subject AS template_subject,
           to_char(es.sent_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD Dy') AS day,
           EXTRACT(HOUR FROM es.sent_at AT TIME ZONE 'Europe/London')::int AS hour,
           EXTRACT(ISODOW FROM es.sent_at AT TIME ZONE 'Europe/London')::int AS dow
    FROM ${S}
    LEFT JOIN contacts c ON c.id = es.contact_id
    LEFT JOIN sequence_steps ss ON ss.id = es.sequence_step_id
    LEFT JOIN sequences s ON s.id = ss.sequence_id
    LEFT JOIN templates t ON t.id = es.template_id
    WHERE es.status = 'sent' AND es.sent_at >= $1
    ORDER BY es.sent_at`, [fromIso])).rows as Array<Record<string, any>>;

  const one = async (sql: string) => Number((await query<{ n: string }>(sql, [fromIso])).rows[0].n);
  const simSends = `email_sends es JOIN test_outbox o ON o.tracking_id = es.tracking_id WHERE es.status='sent' AND es.sent_at >= $1`;
  const stripped = `regexp_replace(o.html_body, '<[^>]+>', ' ', 'g')`;
  const invariants: Array<{ check: string; count: number }> = [
    { check: 'recipient is a lender (contact_type)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM contacts c WHERE c.tenant='tp' AND (c.id = es.contact_id OR LOWER(c.email)=LOWER(o.to_email)) AND LOWER(c.contact_type)='lender')`) },
    { check: 'recipient suppressed (exact or manual domain)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM suppressed_emails s WHERE s.tenant='tp' AND (LOWER(s.email)=LOWER(o.to_email) OR (s.source='manual' AND COALESCE(s.domain,'')<>'' AND LOWER(s.domain)=split_part(LOWER(o.to_email),'@',2))))`) },
    { check: 'recipient tagged unsubscribed/bounced/hold', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM contacts c WHERE c.tenant='tp' AND (c.id = es.contact_id OR LOWER(c.email)=LOWER(o.to_email)) AND c.tags && ARRAY['unsubscribed','bounced','hold'])`) },
    { check: "previously replied (any 'reply' event ever, or replied enrolment)", count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND (EXISTS (SELECT 1 FROM shadow_history_flags h WHERE h.kind='reply' AND (h.email=LOWER(o.to_email) OR h.contact_id=es.contact_id)) OR EXISTS (SELECT 1 FROM sequence_enrollments e2 WHERE e2.contact_id=es.contact_id AND (e2.replied_at IS NOT NULL OR e2.status='replied')))`) },
    { check: 'previously bounced (any bounce event ever)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM shadow_history_flags h WHERE h.kind='bounce' AND (h.email=LOWER(o.to_email) OR h.contact_id=es.contact_id))`) },
    { check: 'loan-intel tenant contact', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND (es.tenant<>'tp' OR EXISTS (SELECT 1 FROM contacts c WHERE c.id=es.contact_id AND c.tenant<>'tp'))`) },
    { check: 'same contact emailed by the same step within the previous 7 days', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM email_sends p WHERE p.id<>es.id AND p.status='sent' AND p.contact_id=es.contact_id AND p.sequence_step_id=es.sequence_step_id AND p.sent_at > es.sent_at - INTERVAL '7 days' AND p.sent_at <= es.sent_at)`) },
    { check: 'sender on @tp.finance (root domain)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND LOWER(o.from_email) LIKE '%@tp.finance'`) },
    { check: 'sender not on @go.tp.finance', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND LOWER(o.from_email) NOT LIKE '%@go.tp.finance'`) },
    { check: 'weekend send (Europe/London)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXTRACT(ISODOW FROM es.sent_at AT TIME ZONE 'Europe/London') IN (6,7)`) },
    { check: 'outside 08:00-17:00 Europe/London', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND (EXTRACT(HOUR FROM es.sent_at AT TIME ZONE 'Europe/London') < 8 OR EXTRACT(HOUR FROM es.sent_at AT TIME ZONE 'Europe/London') >= 17)`) },
    { check: "merge-field leftovers '{{' (subject/html/text)", count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND (o.subject LIKE '%{{%' OR o.html_body LIKE '%{{%' OR o.text_body LIKE '%{{%')`) },
    { check: "empty greeting ('Hey ,' / 'Hi ,' / 'Dear ,')", count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND (${stripped} ~* '\\m(hi|hey|hello|dear)(\\s|&nbsp;)*,' OR o.text_body ~* '\\m(hi|hey|hello|dear)\\s*,')`) },
    { check: "bare 'Turning Point Capital' without 'Advisory'", count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND (o.subject ~* 'Turning Point Capital(?!\\s+Advisory)' OR regexp_replace(${stripped}, '(\\s|&nbsp;)+', ' ', 'g') ~* 'Turning Point Capital(?! Advisory)' OR o.text_body ~* 'Turning Point Capital(?!\\s+Advisory)')`) },
    { check: 'base64 images (data:image / ;base64,)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND (o.html_body ~* 'data:image' OR o.html_body ~* ';base64,')`) },
    { check: 'same enrolment+step sent twice (ever)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM email_sends p WHERE p.id<>es.id AND p.status='sent' AND p.enrollment_id=es.enrollment_id AND p.sequence_step_id=es.sequence_step_id)`) },
  ];
  // Informational (not invariants)
  const info: Array<{ check: string; count: number }> = [
    { check: 'recipient emailed by ANY sequence/step in the previous 7 days (cross-sequence)', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM email_sends p WHERE p.id<>es.id AND p.status='sent' AND LOWER(p.to_email)=LOWER(o.to_email) AND p.sent_at > es.sent_at - INTERVAL '7 days' AND p.sent_at <= es.sent_at)`) },
    { check: 'recipient address also exists as a loan-intel tenant contact', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND EXISTS (SELECT 1 FROM contacts c WHERE c.tenant<>'tp' AND LOWER(c.email)=LOWER(o.to_email))`) },
    { check: 'recipient looks like a no-reply / notification / newsletter address', count: await one(`SELECT COUNT(*)::text n FROM ${simSends} AND o.to_email ~* '${NOREPLY_RE}'`) },
    { check: 'recipient emailed more than once during the shadow week', count: await one(`SELECT COUNT(*)::text n FROM (SELECT LOWER(o.to_email) FROM ${simSends} GROUP BY 1 HAVING COUNT(*) > 1) x`) },
  ];

  const failed = (await query(`SELECT COALESCE(error_message,'') AS reason, COUNT(*) AS n FROM email_sends WHERE created_at >= $1 AND status='failed' GROUP BY 1 ORDER BY 2 DESC`, [fromIso])).rows;
  const postStatus = (await query(`SELECT status, COUNT(*) AS n FROM sequence_enrollments WHERE tenant='tp' GROUP BY 1 ORDER BY 1`)).rows;
  const cancelledDuringSim = (await query(`SELECT COUNT(*) AS n FROM sequence_enrollments WHERE tenant='tp' AND status='cancelled' AND updated_at >= $1`, [fromIso])).rows[0];

  const group = (k: string) => {
    const m = new Map<string, number>();
    for (const r of sends) { const v = String(r[k] ?? '(null)'); m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ [k]: value, sends: n }));
  };
  const perDay = group('day').sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const perDayHour = new Map<string, number>();
  for (const r of sends) perDayHour.set(`${r.day} ${String(r.hour).padStart(2, '0')}:00`, (perDayHour.get(`${r.day} ${String(r.hour).padStart(2, '0')}:00`) || 0) + 1);
  const bySeqStep = new Map<string, number>();
  for (const r of sends) bySeqStep.set(`${r.sequence} | step ${r.step}`, (bySeqStep.get(`${r.sequence} | step ${r.step}`) || 0) + 1);
  const byTemplate = new Map<string, { template: string; subject: string; sends: number }>();
  for (const r of sends) { const k = `${r.template}`; const e = byTemplate.get(k) || { template: r.template, subject: r.template_subject, sends: 0 }; e.sends++; byTemplate.set(k, e); }

  const sentIds = new Map<string, { at: string; order: number }>();
  sends.forEach((r, i) => { if (r.enrollment_id) sentIds.set(r.enrollment_id, { at: london(r.sent_at), order: i + 1 }); });

  // Samples
  const day = realNow.toISOString().slice(0, 10);
  const reportDir = path.join(ROOT, 'test/reports');
  const sampleDir = path.join(reportDir, 'samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const samplePaths: string[] = [];
  for (let i = 0; i < Math.min(3, sends.length); i++) {
    const p = path.join(sampleDir, `shadow-run-${day}-${i + 1}.html`);
    fs.writeFileSync(p, `<!-- shadow run sample ${i + 1}: ${sends[i].sequence} step ${sends[i].step}, to ${maskEmail(sends[i].to_email)}, subject: ${String(sends[i].subject).replace(/--/g, '-')} -->\n${sends[i].html_body}`);
    samplePaths.push(path.relative(ROOT, p));
  }

  // CSV: one row per simulated send
  const csvCols = ['sent_at_london', 'day', 'hour', 'from_email', 'to_email_masked', 'contact_type', 'subsector', 'sequence', 'step', 'template', 'subject'];
  const csv = [csvCols.join(',')].concat(sends.map(r => [london(r.sent_at), r.day, r.hour, r.from_email, maskEmail(r.to_email), r.contact_type, r.subsector, r.sequence, r.step, r.template, r.subject].map(csvCell).join(','))).join('\n') + '\n';
  const csvPath = path.join(reportDir, `shadow-run-${day}.csv`);
  fs.writeFileSync(csvPath, csv);

  const p = stats.plannerPasses.map(x => x.ms);
  const invFail = invariants.filter(i => i.count > 0);
  const md = `# Shadow run ${day}

Read-only copy of prod (tpca_platform) -> \`${SHADOW_DB}\`, SEND_MODE=dryrun, simulated ${london(from)} -> ${london(to)} (${DAYS} weekdays, Europe/London).
Shadow-only change: marcus.emadi@go.tp.finance set to warm-up 10/day, 2/hr. Wall time ${simWallS}s.

## Headline

- **Simulated sends: ${sends.length}** (budget ${DAYS} x 10 = ${DAYS * 10})
- Active tp enrolments at start: ${preActive}; due now: ${preDue}; active with no due date (stranded): ${preNullDue}
- Enrolments cancelled during the run (planner/gate refusals): ${cancelledDuringSim.n}
- Invariants: **${invFail.length === 0 ? 'ALL ZERO' : `${invFail.length} NON-ZERO`}**
- Planner pass: p50 ${Math.round(sim.pct(p, 50))} ms, max ${Math.round(Math.max(0, ...p))} ms over ${p.length} in-window passes. Gate: p50 ${sim.pct(stats.gateMs, 50).toFixed(1)} ms, max ${Math.max(0, ...stats.gateMs).toFixed(1)} ms.

## INVARIANTS (all must be 0)

${mdTable(invariants.map(i => ({ check: i.check, count: i.count, result: i.count === 0 ? 'PASS' : 'FAIL' })))}
Informational:

${mdTable(info)}
## Sends per day

${mdTable(perDay)}
## Sends per day/hour

${mdTable([...perDayHour.entries()].map(([slot, n]) => ({ slot, sends: n })))}
## Recipients by contact_type

${mdTable(group('contact_type'))}
## Recipients by subsector

${mdTable(group('subsector'))}
## By sequence / step

${mdTable([...bySeqStep.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ sequence_step: k, sends: n })))}
## Templates / subjects going out

${mdTable([...byTemplate.values()].sort((a, b) => b.sends - a.sends))}
## First 20 rendered subjects

${mdTable(sends.slice(0, 20).map((r, i) => ({ '#': i + 1, sent_london: london(r.sent_at), to: maskEmail(r.to_email), sequence: r.sequence, step: r.step, subject: r.subject })))}
Rendered HTML samples: ${samplePaths.map(s => `\`${s}\``).join(', ') || '_none_'}

## Overdue enrolments (at sim start)

${mdTable(overdueBuckets)}
Over 30 days overdue, by sequence/step (top 25):

${mdTable(over30BySeq)}
10 most-overdue enrolments, and whether the shadow week sent them:

${mdTable(mostOverdue.map(r => ({ enrolment: r.id.slice(0, 8), contact: maskEmail(r.email), type: r.contact_type, sequence: r.sequence, seq_status: r.seq_status, step: r.step, due: london(r.due), days_overdue: r.days_overdue, sent_in_shadow: sentIds.has(r.id) ? `yes (#${sentIds.get(r.id)!.order}, ${sentIds.get(r.id)!.at})` : 'no' })))}
Due enrolments whose address looks like a no-reply / notification / newsletter mailbox: ${noreplyDue}

## Stranded: active enrolments with no next_step_due_at (the planner never picks these up)

${mdTable(stranded)}
## Sequences: accounts and due load at start

${mdTable(seqAccounts)}
## Accounts (tp)

${mdTable(accountsInfo)}
## Failed sends during the run

${mdTable(failed)}
## Enrolment status after the run

${mdTable(postStatus)}
## Copy counts

${mdTable(Object.entries(copyCounts).map(([t, n]) => ({ table: t, rows: n })))}
CSV (one row per simulated send): \`${path.relative(ROOT, csvPath)}\`
`;
  const mdPath = path.join(reportDir, `shadow-run-${day}.md`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(path.join(reportDir, `shadow-run-${day}.json`), JSON.stringify({ sends: sends.length, invariants, info, preDue, preActive, preNullDue, plannerMs: { p50: sim.pct(p, 50), max: Math.max(0, ...p) }, gateMs: { p50: sim.pct(stats.gateMs, 50), max: Math.max(0, ...stats.gateMs) }, mostOverdue: mostOverdue.map(r => ({ ...r, email: maskEmail(r.email), sent: sentIds.get(r.id) || null })), overdueBuckets }, null, 2));

  console.log(`[shadow-run] ${sends.length} simulated sends; invariants ${invFail.length === 0 ? 'ALL ZERO' : 'NON-ZERO: ' + invFail.map(i => `${i.check}=${i.count}`).join('; ')}`);
  console.log(`[shadow-run] report: ${mdPath}\n[shadow-run] csv: ${csvPath}`);

  setGmailTransportForTests(null);
  await sequenceEngine.close();
  await sendQueue.close();
  await pool.end();
  process.exit(invFail.length === 0 ? 0 : 1);
}

main().catch(err => { console.error('[shadow-run] FAILED:', err); process.exit(3); });
