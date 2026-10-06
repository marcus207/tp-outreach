/**
 * Send window (Mon-Fri 08:00-17:00 Europe/London) is a PECR-adjacent
 * expectation for B2B cold email and a house rule: nothing leaves outside it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { restoreClock, closeAll, setClock, createContact, createSequence, enroll, runPlannerPass, outbox } from '../factories';
import { freshWorld, attemptManualQueuedSend, AccountRow } from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

const outside: Array<[string, Date]> = [
  ['Saturday 10:00 London', new Date('2026-10-10T09:00:00Z')],
  ['Monday 07:59 London', new Date('2026-10-05T06:59:00Z')],
  ['Friday 17:00 London', new Date('2026-10-09T16:00:00Z')],
  ['Tuesday 07:59 London (GMT, after the clocks go back)', new Date('2026-11-03T07:59:00Z')],
];

describe.each(outside)('outside the window: %s', (_label, at) => {
  it('planner plans nothing and a hand-queued send stays queued (not sent)', async () => {
    const c = await createContact({ email: 'window@dev.test' });
    const seq = await createSequence({ accountIds: [account.id], steps: [{ subject: 'Hi' }] });
    await enroll(seq.id, c.id);
    setClock(at);
    expect((await runPlannerPass()).planned).toBe(0);
    const r = await attemptManualQueuedSend(account.id, 'window2@dev.test', null);
    expect(r.delivered).toBe(false);
    expect(r.status).toBe('queued');
    expect(await outbox()).toHaveLength(0);
  });
});
