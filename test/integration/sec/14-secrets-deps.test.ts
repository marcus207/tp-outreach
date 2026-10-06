/**
 * SEC-14 Secrets hygiene (ASVS V2.10.4, V6.4.1, V14.3) and dependency audit (V14.2.1).
 * Static, read-only: scans `git ls-files` content; reads .env only to compare
 * values (values are never printed).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { trackedFiles, ROOT } from './helpers';

const SELF_DIR = path.join(ROOT, 'test/integration/sec');

const PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ['Google refresh token', /\b1\/\/0[A-Za-z0-9_-]{30,}/],
  ['refresh_token value', /"?refresh_token"?\s*[:=]\s*["'](?!fake|test|\$|<|x+["'])[A-Za-z0-9/_.-]{20,}["']/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Stripe key', /\b(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['Postgres URL with password', /postgres(ql)?:\/\/[^:\s/]+:[^@\s/'"`$]{6,}@/],
];

function textFiles(): string[] {
  return trackedFiles().filter(f => {
    if (f.startsWith(SELF_DIR)) return false;
    if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|mp4|mov|lock)$/i.test(f)) return false;
    try { return fs.statSync(f).size < 5 * 1024 * 1024; } catch { return false; }
  });
}

describe('SEC-14 secrets in tracked files', () => {
  it('.env is gitignored and not tracked', () => {
    const tracked = execFileSync('git', ['ls-files', '.env', '.env.local', '.env.production'], { cwd: ROOT }).toString().trim();
    expect(tracked).toBe('');
    const r = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: ROOT });
    expect(r.status).toBe(0);
  });

  it('no credential patterns in any tracked file', () => {
    const hits: string[] = [];
    for (const f of textFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      for (const [name, re] of PATTERNS) {
        const m = s.match(re);
        if (m) {
          const line = s.slice(0, m.index).split('\n').length;
          hits.push(`${path.relative(ROOT, f)}:${line} ${name}`);
        }
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('the DB password (from the runtime DATABASE_URL) is not committed', () => {
    // The password lives outside the repo: prod .env DATABASE_URL, ~/.pgpass, or PGPASSWORD (CI)
    const fromUrl = (u: string) => decodeURIComponent(u.match(/:\/\/[^:/@]+:([^@]+)@/)?.[1] || '');
    const prodEnv = '/root/tp-outreach/.env';
    const pgpass = path.join(process.env.HOME || '/root', '.pgpass');
    const pw = fromUrl(process.env.DATABASE_URL || '')
      || (fs.existsSync(prodEnv) ? fromUrl(fs.readFileSync(prodEnv, 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1] || '') : '')
      || (fs.existsSync(pgpass) ? (fs.readFileSync(pgpass, 'utf8').split('\n').find(l => l.includes(':tpca:'))?.split(':').slice(4).join(':') || '') : '')
      || process.env.PGPASSWORD || '';
    expect(pw.length).toBeGreaterThan(0);
    const hits = textFiles().filter(f => fs.readFileSync(f, 'utf8').includes(pw)).map(f => path.relative(ROOT, f));
    expect(hits, `DB password committed in:\n${hits.join('\n')}`).toEqual([]);
  });

  it('no secret VALUE from the live .env appears in any tracked file (names only reported)', () => {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    const secrets: Array<[string, string]> = [];
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (/KEY|SECRET|PASSWORD|TOKEN|PASS|DATABASE_URL/.test(k) && v.length >= 8 && !/^(true|false|https?:\/\/[^@]*)$/i.test(v)) secrets.push([k, v]);
    }
    const hits: string[] = [];
    for (const f of textFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      for (const [k, v] of secrets) if (s.includes(v)) hits.push(`${path.relative(ROOT, f)} contains the value of ${k}`);
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('no default/fallback session secret in source (fail closed if SESSION_SECRET unset)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    expect(/SESSION_SECRET\s*\|\|\s*['"]/.test(src), "src/index.ts falls back to 'dev-secret-change-me' when SESSION_SECRET is unset").toBe(false);
  });

  it('dashboard password is not persisted in plaintext by the app', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    expect(/DASHBOARD_PASSWORD=\$\{new_password\}/.test(src), 'reset-password writes the new password in plaintext to .env').toBe(false);
  });
});

describe('SEC-14 dependency audit', () => {
  it('npm audit --omit=dev: no critical or high advisories', (ctx) => {
    const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    let j: { metadata?: { vulnerabilities?: Record<string, number> }; vulnerabilities?: Record<string, { severity: string; via: unknown[] }>; error?: unknown };
    try { j = JSON.parse(r.stdout || '{}'); } catch { ctx.skip(); return; }
    if (j.error || !j.metadata) { console.warn('[sec-14] npm audit unavailable:', JSON.stringify(j.error || r.stderr).slice(0, 200)); ctx.skip(); return; }
    const v = j.metadata.vulnerabilities || {};
    const names = Object.entries(j.vulnerabilities || {}).filter(([, x]) => ['high', 'critical'].includes(x.severity)).map(([n, x]) => `${n} (${x.severity})`);
    console.log(`[sec-14] npm audit (prod deps): ${JSON.stringify(v)}${names.length ? '\n  high/critical: ' + names.join(', ') : ''}`);
    expect({ critical: v.critical || 0, high: v.high || 0 }, names.join(', ')).toEqual({ critical: 0, high: 0 });
  });
});
