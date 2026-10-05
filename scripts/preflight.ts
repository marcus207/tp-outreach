/**
 * Go-live preflight for tp.finance cold outreach.
 *
 *   npx tsx scripts/preflight.ts [--skip-tests] [--json-only]
 *
 * READ-ONLY: DNS lookups, SELECTs, Gmail users.getProfile. Never sends mail,
 * never writes to the DB, never writes OAuth tokens back.
 * Exit code 0 only if no check FAILs (WARNs are allowed).
 * Writes a JSON report to logs/preflight-<timestamp>.json.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { google } from 'googleapis';
import { query, pool, TENANT } from '../src/db/connection';
import { COLD_SENDER_DOMAIN } from '../src/services/send-gate';
import { isCircuitBreakerEnabled } from '../src/services/circuit-breaker';

export type Status = 'PASS' | 'WARN' | 'FAIL';
export interface CheckResult { section: string; name: string; status: Status; detail: string }

const ROOT = path.resolve(__dirname, '..');
const r = (section: string, name: string, status: Status, detail = ''): CheckResult => ({ section, name, status, detail });

// ── a/b. DNS ────────────────────────────────────────────────────────────

export interface Resolver {
  resolveMx(host: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(host: string): Promise<string[][]>;
}

async function txt(resolver: Resolver, host: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(host)).map(chunks => chunks.join(''));
  } catch {
    return [];
  }
}

export async function checkDns(resolver: Resolver = dns, coldDomain = COLD_SENDER_DOMAIN, rootDomain = 'tp.finance'): Promise<CheckResult[]> {
  const S = 'a. DNS ' + coldDomain;
  const out: CheckResult[] = [];

  let mx: { exchange: string }[] = [];
  try { mx = await resolver.resolveMx(coldDomain); } catch { /* none */ }
  out.push(mx.length
    ? r(S, 'MX present', 'PASS', mx.map(m => m.exchange).join(', '))
    : r(S, 'MX present', 'FAIL', 'no MX records'));

  const spf = (await txt(resolver, coldDomain)).filter(t => t.toLowerCase().startsWith('v=spf1'));
  if (spf.length === 0) out.push(r(S, 'SPF', 'FAIL', 'no v=spf1 TXT'));
  else if (spf.length > 1) out.push(r(S, 'SPF', 'FAIL', `multiple SPF records (${spf.length})`));
  else if (!/include:_spf\.google\.com/i.test(spf[0])) out.push(r(S, 'SPF', 'FAIL', `missing include:_spf.google.com: ${spf[0]}`));
  else out.push(r(S, 'SPF', 'PASS', spf[0]));

  out.push(dmarcResult(S, await txt(resolver, `_dmarc.${coldDomain}`)));

  const dkim = (await txt(resolver, `google._domainkey.${coldDomain}`)).filter(t => /v=DKIM1|p=/i.test(t));
  out.push(dkim.length
    ? r(S, 'DKIM google._domainkey', 'PASS', 'published')
    : r(S, 'DKIM google._domainkey', 'FAIL', 'not published'));

  const S2 = 'b. DNS ' + rootDomain;
  out.push(dmarcResult(S2, await txt(resolver, `_dmarc.${rootDomain}`)));
  const s2026 = (await txt(resolver, `s2026._domainkey.${rootDomain}`)).filter(t => /p=/i.test(t));
  out.push(s2026.length
    ? r(S2, 'DKIM s2026._domainkey', 'PASS', 'published')
    : r(S2, 'DKIM s2026._domainkey', 'WARN', 'not published'));
  return out;
}

function dmarcResult(section: string, records: string[]): CheckResult {
  const d = records.filter(t => t.toUpperCase().startsWith('V=DMARC1'));
  if (d.length === 0) return r(section, 'DMARC', 'FAIL', 'no _dmarc TXT');
  const policy = (/;\s*p=([a-z]+)/i.exec(d[0])?.[1] || '').toLowerCase();
  if (policy === 'none') return r(section, 'DMARC', 'WARN', `p=none (monitoring only): ${d[0]}`);
  if (!policy) return r(section, 'DMARC', 'FAIL', `no p= tag: ${d[0]}`);
  return r(section, 'DMARC', 'PASS', `p=${policy}`);
}

// ── c/d. Accounts, OAuth identity, limits ───────────────────────────────

export interface PreflightAccount {
  id: string;
  email: string;
  daily_limit: number;
  hourly_limit: number;
  created_at: Date | string;
  oauth_tokens: { refresh_token?: string; access_token?: string } | null;
}

export type IdentityVerifier = (a: PreflightAccount) => Promise<{ emailAddress: string | null; error?: string }>;

/** Read-only users.getProfile using the stored refresh token. Tokens are never persisted. */
export const verifyIdentityWithGmail: IdentityVerifier = async (a) => {
  const tokens = a.oauth_tokens || {};
  if (!tokens.refresh_token && !tokens.access_token) return { emailAddress: null, error: 'no OAuth tokens' };
  try {
    const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    // No 'tokens' listener: a refreshed access token stays in memory only.
    client.setCredentials(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : { access_token: tokens.access_token });
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return { emailAddress: profile.data.emailAddress || null };
  } catch (err) {
    const e = err as { message?: string; response?: { data?: { error?: string } } };
    return { emailAddress: null, error: e.response?.data?.error || e.message || String(err) };
  }
};

export async function loadActiveAccounts(): Promise<PreflightAccount[]> {
  const res = await query<PreflightAccount>(
    `SELECT id, email, daily_limit, hourly_limit, created_at, oauth_tokens
     FROM email_accounts WHERE tenant = $1 AND is_active = true ORDER BY email`,
    [TENANT]
  );
  return res.rows;
}

export async function checkAccounts(accounts: PreflightAccount[], verify: IdentityVerifier, coldDomain = COLD_SENDER_DOMAIN): Promise<CheckResult[]> {
  const S = 'c. Accounts';
  const out: CheckResult[] = [];
  let healthyCold = 0;
  for (const a of accounts) {
    const email = a.email.toLowerCase();
    const isCold = email.endsWith('@' + coldDomain);
    if (isCold) out.push(r(S, `${a.email} domain`, 'PASS', `on ${coldDomain}`));
    else if (a.daily_limit === 0 && a.hourly_limit === 0) out.push(r(S, `${a.email} domain`, 'PASS', `root-domain account, limits 0/0`));
    else out.push(r(S, `${a.email} domain`, 'FAIL', `not on ${coldDomain} but limits ${a.daily_limit}/day ${a.hourly_limit}/hr (must be 0)`));

    const id = await verify(a);
    if (id.error) {
      const msg = /invalid_grant/i.test(id.error) ? 'invalid_grant (re-authorise)' : id.error;
      out.push(r(S, `${a.email} OAuth`, 'FAIL', msg));
    } else if ((id.emailAddress || '').toLowerCase() !== email) {
      out.push(r(S, `${a.email} OAuth`, 'FAIL', `identity mismatch: token is for ${id.emailAddress}`));
    } else {
      out.push(r(S, `${a.email} OAuth`, 'PASS', 'getProfile identity matches'));
      if (isCold) healthyCold++;
    }
  }
  out.push(healthyCold > 0
    ? r(S, `active ${coldDomain} sender`, 'PASS', `${healthyCold} account(s) with working OAuth`)
    : r(S, `active ${coldDomain} sender`, 'FAIL', `no active ${coldDomain} account with working OAuth`));
  return out;
}

export function checkLimits(accounts: PreflightAccount[], now = new Date(), allowHigh = process.env.PREFLIGHT_ALLOW_HIGH_LIMITS === '1'): CheckResult[] {
  const S = 'd. Limits';
  const out: CheckResult[] = [];
  for (const a of accounts) {
    const problems: string[] = [];
    if (!allowHigh && a.daily_limit > 50) problems.push(`daily_limit ${a.daily_limit} > 50`);
    if (!allowHigh && a.hourly_limit > 10) problems.push(`hourly_limit ${a.hourly_limit} > 10`);
    const ageDays = (now.getTime() - new Date(a.created_at).getTime()) / 86400000;
    if (ageDays < 28) {
      const weeks = Math.floor(Math.max(0, ageDays) / 7);
      const cap = 10 * (weeks + 1);
      if (a.daily_limit > cap) problems.push(`warm-up: connected ${Math.floor(ageDays)}d ago, daily_limit ${a.daily_limit} > ${cap}`);
    }
    out.push(problems.length
      ? r(S, a.email, 'FAIL', problems.join('; '))
      : r(S, a.email, 'PASS', `${a.daily_limit}/day ${a.hourly_limit}/hr`));
  }
  if (accounts.length === 0) out.push(r(S, 'accounts', 'WARN', 'no active accounts'));
  return out;
}

// ── e. Data hygiene ─────────────────────────────────────────────────────

export const HYGIENE_CHECKS: { name: string; sql: string; hint: string }[] = [
  {
    name: 'no lender contacts',
    sql: `SELECT COUNT(*)::int AS n FROM contacts WHERE tenant = $1 AND contact_type = 'lender'`,
    hint: 'lender contacts in tp',
  },
  {
    name: 'no blocked active enrollments',
    sql: `SELECT COUNT(*)::int AS n
          FROM sequence_enrollments se JOIN contacts c ON c.id = se.contact_id
          WHERE se.tenant = $1 AND se.status = 'active'
            AND (c.contact_type = 'lender'
                 OR COALESCE(c.tags, '{}') && ARRAY['hold','unsubscribed','bounced']::text[]
                 OR EXISTS (SELECT 1 FROM suppressed_emails s
                            WHERE s.tenant = $1 AND LOWER(s.email) = LOWER(c.email)))`,
    hint: 'active enrollments for lender/hold/unsubscribed/bounced/suppressed contacts',
  },
  {
    name: 'no stale queued sends',
    sql: `SELECT COUNT(*)::int AS n FROM email_sends
          WHERE tenant = $1 AND status = 'queued' AND created_at < NOW() - INTERVAL '2 days'`,
    hint: 'queued email_sends older than 2 days',
  },
  {
    name: 'no internal active enrollments',
    sql: `SELECT COUNT(*)::int AS n
          FROM sequence_enrollments se JOIN contacts c ON c.id = se.contact_id
          WHERE se.tenant = $1 AND se.status = 'active'
            AND (LOWER(c.email) LIKE '%@tp.finance' OR LOWER(c.email) LIKE '%@go.tp.finance')`,
    hint: 'active enrollments for @tp.finance/@go.tp.finance contacts',
  },
  {
    name: 'unsubscribes all suppressed',
    sql: `SELECT COUNT(DISTINCT LOWER(es.to_email))::int AS n
          FROM email_events ev JOIN email_sends es ON es.id = ev.email_send_id
          WHERE es.tenant = $1 AND ev.event_type = 'unsubscribe'
            AND NOT EXISTS (SELECT 1 FROM suppressed_emails s
                            WHERE s.tenant = $1 AND LOWER(s.email) = LOWER(es.to_email))`,
    hint: 'unsubscribed addresses missing from suppressed_emails',
  },
];

export async function checkHygiene(): Promise<CheckResult[]> {
  const S = 'e. Data hygiene';
  const out: CheckResult[] = [];
  for (const c of HYGIENE_CHECKS) {
    try {
      const res = await query<{ n: number }>(c.sql, [TENANT]);
      const n = Number(res.rows[0]?.n ?? 0);
      out.push(n === 0 ? r(S, c.name, 'PASS', '0') : r(S, c.name, 'FAIL', `${n} ${c.hint}`));
    } catch (err) {
      out.push(r(S, c.name, 'FAIL', `query error: ${(err as Error).message}`));
    }
  }
  return out;
}

// ── f. Config ───────────────────────────────────────────────────────────

export function checkConfig(env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  const S = 'f. Config';
  const out: CheckResult[] = [];
  for (const flag of ['APOLLO_SYNC_ENABLED', 'APOLLO_WEBHOOK_ENABLED', 'TP_AUTO_ENROL_ENABLED']) {
    const on = env[flag] === 'true';
    out.push(r(S, flag, on ? 'WARN' : 'PASS', on ? 'true' : `off (${env[flag] ?? 'unset'})`));
  }
  if (env.APOLLO_WEBHOOK_ENABLED === 'true') {
    out.push(env.APOLLO_WEBHOOK_SECRET
      ? r(S, 'APOLLO_WEBHOOK_SECRET', 'PASS', 'set')
      : r(S, 'APOLLO_WEBHOOK_SECRET', 'FAIL', 'webhook enabled without a secret'));
  } else {
    out.push(r(S, 'APOLLO_WEBHOOK_SECRET', 'PASS', `webhook off (secret ${env.APOLLO_WEBHOOK_SECRET ? 'set' : 'unset'})`));
  }
  out.push(env.SEND_MODE === 'live'
    ? r(S, 'SEND_MODE', 'PASS', 'live')
    : r(S, 'SEND_MODE', 'WARN', `SEND_MODE=${env.SEND_MODE ?? 'unset'} (not live)`));
  const cbOn = (env.CIRCUIT_BREAKER_ENABLED || '').trim().toLowerCase() !== 'false';
  out.push(cbOn
    ? r(S, 'CIRCUIT_BREAKER_ENABLED', 'PASS', env.CIRCUIT_BREAKER_ENABLED ? env.CIRCUIT_BREAKER_ENABLED : 'default on')
    : r(S, 'CIRCUIT_BREAKER_ENABLED', 'FAIL', 'disabled'));
  return out;
}

// ── g. Code health ──────────────────────────────────────────────────────

export function checkCodeHealth(skip: boolean): CheckResult[] {
  const S = 'g. Code health';
  if (skip) {
    return [r(S, 'tsc --noEmit', 'WARN', 'skipped (--skip-tests)'), r(S, 'vitest run', 'WARN', 'skipped (--skip-tests)')];
  }
  const run = (name: string, args: string[]): CheckResult => {
    const p = spawnSync('npx', args, { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: { ...process.env, CI: '1' } });
    if (p.status === 0) return r(S, name, 'PASS', 'exit 0');
    const tail = `${p.stdout || ''}${p.stderr || ''}`.trim().split('\n').slice(-3).join(' | ');
    return r(S, name, 'FAIL', `exit ${p.status ?? p.signal}: ${tail.slice(0, 300)}`);
  };
  return [run('tsc --noEmit', ['tsc', '--noEmit', '-p', '.']), run('vitest run', ['vitest', 'run'])];
}

// ── h. Templates ────────────────────────────────────────────────────────

/** True if gmail-client always appends an unsubscribe footer + List-Unsubscribe header. */
export function unsubscribeAlwaysAppended(gmailClientSource: string): boolean {
  return /List-Unsubscribe/.test(gmailClientSource)
    && /hasUnsubscribe/.test(gmailClientSource)
    && /Unsubscribe<\/a>/.test(gmailClientSource);
}

export const BARE_BRAND = /Turning Point Capital(?! Advisory)/;

export interface TemplateRow { id: string; name: string; subject: string; body_html: string; body_text: string | null }

export function checkTemplates(templates: TemplateRow[], gmailClientSource: string): CheckResult[] {
  const S = 'h. Templates';
  const out: CheckResult[] = [];
  const appended = unsubscribeAlwaysAppended(gmailClientSource);
  if (appended) {
    out.push(r(S, 'unsubscribe link', 'PASS', 'gmail-client appends footer + List-Unsubscribe header to every tracked send'));
  } else {
    const missing = templates.filter(t => !/\{\{\s*unsubscribe_url\s*\}\}/i.test(t.body_html));
    out.push(missing.length
      ? r(S, 'unsubscribe link', 'FAIL', `${missing.length} template(s) without {{unsubscribe_url}}: ${missing.slice(0, 5).map(t => t.name).join(', ')}`)
      : r(S, 'unsubscribe link', 'PASS', 'all templates contain {{unsubscribe_url}}'));
  }
  const b64 = templates.filter(t => /data:image/i.test(`${t.body_html}\n${t.body_text || ''}`));
  out.push(b64.length
    ? r(S, 'no base64 images', 'FAIL', `${b64.length}: ${b64.slice(0, 5).map(t => t.name).join(', ')}`)
    : r(S, 'no base64 images', 'PASS', `${templates.length} active templates`));
  const bare = templates.filter(t => BARE_BRAND.test(`${t.subject}\n${t.body_html}\n${t.body_text || ''}`));
  out.push(bare.length
    ? r(S, "no bare 'Turning Point Capital'", 'FAIL', `${bare.length}: ${bare.slice(0, 5).map(t => t.name).join(', ')}`)
    : r(S, "no bare 'Turning Point Capital'", 'PASS', ''));
  return out;
}

async function loadTemplates(): Promise<TemplateRow[]> {
  const res = await query<TemplateRow>(
    `SELECT id, name, subject, body_html, body_text FROM templates WHERE tenant = $1 AND is_active = true`,
    [TENANT]
  );
  return res.rows;
}

// ── Runner / output ─────────────────────────────────────────────────────

async function safe(section: string, fn: () => Promise<CheckResult[]> | CheckResult[]): Promise<CheckResult[]> {
  try {
    return await fn();
  } catch (err) {
    return [r(section, 'check crashed', 'FAIL', (err as Error).message)];
  }
}

export async function runPreflight(opts: { skipTests: boolean }): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(...await safe('a/b. DNS', () => checkDns()));
  const accounts = await loadActiveAccounts().catch(() => [] as PreflightAccount[]);
  results.push(...await safe('c. Accounts', () => checkAccounts(accounts, verifyIdentityWithGmail)));
  results.push(...await safe('d. Limits', () => checkLimits(accounts)));
  results.push(...await safe('e. Data hygiene', () => checkHygiene()));
  results.push(...await safe('f. Config', () => {
    const c = checkConfig();
    if (!isCircuitBreakerEnabled()) c.push(r('f. Config', 'circuit breaker module', 'FAIL', 'isCircuitBreakerEnabled() false'));
    return c;
  }));
  results.push(...await safe('g. Code health', () => checkCodeHealth(opts.skipTests)));
  results.push(...await safe('h. Templates', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/gmail-client.ts'), 'utf8');
    return checkTemplates(await loadTemplates(), src);
  }));
  return results;
}

export function formatTable(results: CheckResult[]): string {
  const w = (k: keyof CheckResult, max: number) => Math.min(max, Math.max(k.length, ...results.map(x => x[k].length)));
  const ws = [w('section', 22), w('name', 44), 6];
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const line = (c: string[]) => c.map((v, i) => (i < 3 ? pad(v, ws[i]) : v)).join(' | ');
  const rows = [line(['SECTION', 'CHECK', 'STATUS', 'DETAIL']), ws.map(n => '-'.repeat(n)).join('-+-') + '-+-' + '-'.repeat(20)];
  for (const x of results) rows.push(line([x.section, x.name, x.status, x.detail]));
  return rows.join('\n');
}

export function summarise(results: CheckResult[]) {
  const count = (s: Status) => results.filter(x => x.status === s).length;
  return { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL'), ok: count('FAIL') === 0 };
}

async function main() {
  const skipTests = process.argv.includes('--skip-tests');
  const started = new Date();
  const results = await runPreflight({ skipTests });
  const summary = summarise(results);

  console.log(`\ntp.finance outreach preflight (tenant ${TENANT}, cold domain ${COLD_SENDER_DOMAIN}) ${started.toISOString()}\n`);
  console.log(formatTable(results));
  console.log(`\n${summary.pass} PASS, ${summary.warn} WARN, ${summary.fail} FAIL => ${summary.ok ? 'GO' : 'NO-GO'}`);

  const logDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `preflight-${started.toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ started_at: started.toISOString(), tenant: TENANT, cold_domain: COLD_SENDER_DOMAIN, skip_tests: skipTests, summary, results }, null, 2));
  console.log(`JSON report: ${file}`);

  await pool.end().catch(() => undefined);
  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[preflight] fatal:', err);
    process.exit(2);
  });
}
