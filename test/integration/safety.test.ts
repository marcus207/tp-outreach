/**
 * The harness's own safety guarantees, asserted. If any of these fail, the
 * isolation story in test/README.md is no longer true.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import https from 'https';
import { gmailClient, setGmailTransportForTests } from '../../src/services/gmail-client';
import { getRedisConnection } from '../../src/db/redis';
import { BULL_PREFIX } from '../../src/db/connection';
import { resetAll, closeAll, createAccount, outbox } from './factories';
import type { EmailAccount } from '../../src/types';

describe('harness safety guarantees', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, SEND_MODE: process.env.SEND_MODE, REDIS_URL: process.env.REDIS_URL };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    process.env.SEND_MODE = saved.SEND_MODE;
    process.env.REDIS_URL = saved.REDIS_URL;
  });
  afterAll(async () => { await closeAll(); });

  it('runs against the test DB, Redis DB 15 and the bull-test prefix', () => {
    expect(process.env.DATABASE_URL).toMatch(/\/tpca_outreach_test(_[a-z0-9]+)?$/);
    expect(getRedisConnection().db).toBe(15);
    expect(BULL_PREFIX).toBe(process.env.BULL_PREFIX);
    expect(BULL_PREFIX).toMatch(/^bull-test-[a-z0-9]+$/);
    expect(process.env.SEND_MODE).not.toBe('live');
  });

  it('sendEmail outside NODE_ENV=test with SEND_MODE!=live throws and captures nothing', async () => {
    await resetAll();
    const account = (await createAccount()) as unknown as EmailAccount;
    process.env.NODE_ENV = 'production';
    process.env.SEND_MODE = 'dryrun';
    await expect(gmailClient.sendEmail(account, {
      to: 'someone@example.test', from: account.email, subject: 'x', htmlBody: '<p>x</p>', trackingId: 'abc',
    })).rejects.toThrow('SEND_MODE is not live');
    process.env.NODE_ENV = saved.NODE_ENV;
    expect(await outbox()).toHaveLength(0);
  });

  it('the Gmail seam cannot be installed outside NODE_ENV=test', () => {
    process.env.NODE_ENV = 'production';
    expect(() => setGmailTransportForTests(() => ({}))).toThrow(/only available under NODE_ENV=test/);
  });

  it('Redis connections to any DB other than 15 are refused under NODE_ENV=test', () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    expect(() => getRedisConnection()).toThrow(/DB 0/);
  });

  it('outbound network to non-loopback hosts is blocked', async () => {
    expect(() => https.request('https://gmail.googleapis.com/gmail/v1/users/me/profile')).toThrow(/net-guard/);
    await expect(fetch('https://api.anthropic.com/v1/messages')).rejects.toThrow(/net-guard/);
  });
});
