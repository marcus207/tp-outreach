/**
 * Broadcast planner: runs each hour; no-op outside the shared send window
 * (send-gate isWithinSendWindow, Mon-Fri 08:00-17:00 Europe/London).
 * Picks queued broadcast emails (broadcast_id IS NOT NULL) and distributes
 * them across active @go.tp.finance accounts, capped per account by
 * BROADCAST_HOURLY_LIMIT and the account's remaining hourly AND daily budget.
 */
import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
import { isWithinSendWindow } from './send-gate';
import { BROADCAST_SENDER_DOMAIN } from '../routes/articles';
import { EmailAccount } from '../types';

// Per-account broadcast send rate. Tunable via env for reputation recovery:
// lower it hard after a deliverability hit, raise it slowly as reputation heals.
// Recovery default is deliberately low (10/hr/account).
const BROADCAST_HOURLY_LIMIT = parseInt(process.env.BROADCAST_HOURLY_LIMIT || '10', 10);

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

interface BroadcastPlanResult {
  planned: number;
  skipped: number;
  distribution: Record<string, number>;
}

export class BroadcastPlanner {
  async plan(): Promise<BroadcastPlanResult> {
    const result: BroadcastPlanResult = { planned: 0, skipped: 0, distribution: {} };

    // Shared cold-send window
    if (!isWithinSendWindow()) {
      console.log(`[Broadcast Planner] Outside send window — skipping`);
      return result;
    }

    // Active broadcast accounts only (@go.tp.finance; marcus@tp.finance is reply-scan only)
    const accounts = await query<EmailAccount & { pending: string }>(
      `SELECT ea.*,
              (SELECT COUNT(*) FROM email_sends es
               WHERE es.email_account_id = ea.id AND es.tenant = ea.tenant
                 AND es.status = 'queued' AND es.last_enqueued_at > NOW() - INTERVAL '1 hour') AS pending
       FROM email_accounts ea
       WHERE ea.tenant = $1 AND ea.is_active = true
         AND LOWER(ea.email) LIKE $2
         AND ea.daily_limit > 0 AND ea.hourly_limit > 0
       ORDER BY ea.email`,
      [TENANT, `%${BROADCAST_SENDER_DOMAIN}`]
    );
    if (accounts.rows.length === 0) {
      console.log(`[Broadcast Planner] No active ${BROADCAST_SENDER_DOMAIN} account with nonzero limits — skipping`);
      return result;
    }

    // Budget per account: min(broadcast rate, hourly remaining, daily remaining),
    // less anything already enqueued this hour but not yet sent.
    const budget = new Map<string, number>();
    for (const acct of accounts.rows) {
      const remaining = Math.min(
        BROADCAST_HOURLY_LIMIT,
        acct.hourly_limit - acct.sends_this_hour,
        acct.daily_limit - acct.sends_today,
      ) - parseInt(acct.pending || '0', 10);
      budget.set(acct.id, Math.max(0, remaining));
      result.distribution[acct.email] = 0;
    }
    const totalBudget = Array.from(budget.values()).reduce((a, b) => a + b, 0);
    if (totalBudget === 0) {
      console.log(`[Broadcast Planner] All broadcast accounts at limit — skipping`);
      return result;
    }

    // Get queued broadcast emails (oldest first) not already enqueued in the
    // last hour (avoids duplicate BullMQ jobs for rows still waiting to send)
    const queued = await query<{ id: string; email_account_id: string }>(
      `SELECT id, email_account_id FROM email_sends
       WHERE tenant = $1 AND broadcast_id IS NOT NULL AND status = 'queued'
         AND (last_enqueued_at IS NULL OR last_enqueued_at < NOW() - INTERVAL '1 hour')
       ORDER BY created_at ASC
       LIMIT $2`,
      [TENANT, totalBudget]
    );

    if (queued.rows.length === 0) {
      console.log(`[Broadcast Planner] No queued broadcast emails`);
      await this.checkCompletedBroadcasts();
      return result;
    }

    const accountIds = accounts.rows.map(a => a.id);
    let cursor = 0;

    const sendQueue = new Queue('email-sends', {
      connection: getRedisConnection(),
      prefix: BULL_PREFIX,
    });

    try {
      for (const email of queued.rows) {
        // Round-robin: find an account with budget
        let assigned: string | null = null;
        for (let i = 0; i < accountIds.length; i++) {
          const candidateId = accountIds[(cursor + i) % accountIds.length];
          const remaining = budget.get(candidateId) || 0;
          if (remaining > 0) {
            assigned = candidateId;
            budget.set(candidateId, remaining - 1);
            cursor = (cursor + i + 1) % accountIds.length;
            break;
          }
        }

        if (!assigned) {
          result.skipped++;
          continue;
        }

        // Assign to the chosen account and mark as enqueued
        const acct = accounts.rows.find(a => a.id === assigned)!;
        await query(
          `UPDATE email_sends SET email_account_id = $1, from_email = $2, last_enqueued_at = NOW() WHERE id = $3`,
          [assigned, acct.email, email.id]
        );

        // Jitter across the hour (0-50 minutes)
        const jitterMs = Math.floor(Math.random() * 3000000);
        await sendQueue.add('send-email', { emailSendId: email.id, fromName: acct.display_name || undefined }, { delay: jitterMs });

        result.distribution[acct.email] = (result.distribution[acct.email] || 0) + 1;
        result.planned++;
      }
    } finally {
      await sendQueue.close();
    }

    console.log(
      `[Broadcast Planner] ${TENANT}: planned=${result.planned}, skipped=${result.skipped}, ` +
      `distribution=${JSON.stringify(result.distribution)}`
    );

    return result;
  }

  private async checkCompletedBroadcasts(): Promise<void> {
    // Mark broadcasts as 'complete' if all their emails are sent/failed (none queued)
    await query(
      `UPDATE article_broadcasts SET status = 'complete'
       WHERE status = 'sending' AND id NOT IN (
         SELECT DISTINCT broadcast_id FROM email_sends
         WHERE broadcast_id IS NOT NULL AND status = 'queued' AND tenant = $1
       )`,
      [TENANT]
    );
  }
}

export const broadcastPlanner = new BroadcastPlanner();
