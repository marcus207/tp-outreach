/**
 * Requirement 11: Campaign Pause. campaign_settings.is_active = false means the
 * blast tick sends nothing.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll, createAccount, drainSendQueue, outbox, emailSends,
} from '../factories';
import { query } from '../../../src/db/connection';
import { campaignEngine } from '../../../src/services/campaign-engine';
import { T0, COLD_A, setCampaignActive, createBlast, queuedJobs } from './helpers';

const CONTACTS = [1, 2, 3].map(i => ({ email: `pause${i}@example-dev.test` }));

afterAll(async () => { await closeAll(); });

describe('campaign pause switch', () => {
  beforeEach(async () => {
    await resetAll(); installFakeGmail(); setClock(T0);
    await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
  });
  afterEach(() => restoreClock());

  it('is_active = false: blast tick creates no sends, queues no jobs, sends nothing', async () => {
    await setCampaignActive(false);
    await createBlast({ contacts: CONTACTS });
    const r = await campaignEngine.tick();
    expect(r.ran).toBe(false);
    expect(r.contacts_queued).toBe(0);
    expect(await emailSends()).toHaveLength(0);
    expect(await queuedJobs()).toHaveLength(0);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it('no campaign_settings row at all is treated as paused', async () => {
    await createBlast({ contacts: CONTACTS });
    const r = await campaignEngine.tick();
    expect(r.ran).toBe(false);
    expect(await emailSends()).toHaveLength(0);
  });

  it('is_active = true (control): the same blast queues and sends', async () => {
    await setCampaignActive(true);
    await createBlast({ contacts: CONTACTS });
    expect((await campaignEngine.tick()).contacts_queued).toBe(3);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(3);
  });

  it('pausing after a tick stops the blast emails already queued from going out', async () => {
    await setCampaignActive(true);
    await createBlast({ contacts: CONTACTS });
    expect((await campaignEngine.tick()).contacts_queued).toBe(3);
    await query(`UPDATE campaign_settings SET is_active = false WHERE tenant = 'tp'`);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it('pause then resume: nothing is lost or duplicated, each contact gets the blast once', async () => {
    await setCampaignActive(false);
    await createBlast({ contacts: CONTACTS });
    await campaignEngine.tick();
    await setCampaignActive(true);
    await campaignEngine.tick();
    await campaignEngine.tick();
    await drainSendQueue();
    const box = await outbox();
    expect(box).toHaveLength(3);
    expect(new Set(box.map(m => m.to_email)).size).toBe(3);
  });
});
