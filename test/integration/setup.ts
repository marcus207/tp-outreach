/**
 * Per-worker setup, runs before every test file's imports.
 *  - Re-asserts isolation inside the worker (env actually seen by src/).
 *  - Network guard: any outbound HTTP(S)/fetch to a non-loopback host throws.
 *    Defence in depth on top of the SEND_MODE switch and the Gmail seam: even
 *    a code path that forgot to go through the seam cannot reach Google,
 *    Apollo, Anthropic, Strapi, etc.
 */
import http from 'http';
import https from 'https';
import { assertIsolatedEnv } from './safety';

assertIsolatedEnv();

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostOf(input: unknown): string {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === 'object') {
      const o = input as { hostname?: string; host?: string; url?: string };
      if (o.url) return new URL(o.url).hostname;
      return (o.hostname || o.host || 'localhost').split(':')[0];
    }
  } catch { /* fall through */ }
  return 'localhost';
}

function guard(mod: typeof http | typeof https, name: string): void {
  for (const fn of ['request', 'get'] as const) {
    const orig = mod[fn] as (...a: unknown[]) => unknown;
    (mod as unknown as Record<string, unknown>)[fn] = function guarded(this: unknown, ...args: unknown[]) {
      const host = hostOf(args[0]);
      if (!LOOPBACK.has(host)) {
        throw new Error(`[integration net-guard] blocked outbound ${name}.${fn} to ${host}`);
      }
      return orig.apply(this, args);
    };
  }
}
guard(http, 'http');
guard(https, 'https');

const origFetch = globalThis.fetch;
if (origFetch) {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = hostOf(typeof input === 'object' && 'url' in (input as object) ? (input as Request).url : input);
    if (!LOOPBACK.has(host)) {
      throw new Error(`[integration net-guard] blocked outbound fetch to ${host}`);
    }
    return origFetch(input, init);
  }) as typeof fetch;
}
