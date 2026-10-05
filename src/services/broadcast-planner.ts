/**
 * Broadcast planner: runs each hour during the send window (09-16 UTC).
 * Picks queued broadcast emails (broadcast_id IS NOT NULL) and distributes
 * them across accounts at 15/hr/account, independent of sequence sending.
 */
import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
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

    // Window check: 08:00-18:00 UTC, 7 days/week
    const now = new Date();
    const hour = now.getUTCHours();
    if (hour < 8 || hour >= 18) {
      console.log(`[Broadcast Planner] Outside send window — skipping`);
      return result;
    }

    // Get active accounts
    const accounts = await query<EmailAccount>(
      `SELECT * FROM email_accounts WHERE tenant = $1 AND is_active = true ORDER BY email`,
      [TENANT]
    );
    if (accounts.rows.length === 0) return result;

    // Get queued broadcast emails (oldest first)
    const queued = await query<{ id: string; email_account_id: string }>(
      `SELECT id, email_account_id FROM email_sends
       WHERE tenant = $1 AND broadcast_id IS NOT NULL AND status = 'queued'
       ORDER BY created_at ASC
       LIMIT $2`,
      [TENANT, accounts.rows.length * BROADCAST_HOURLY_LIMIT]
    );

    if (queued.rows.length === 0) {
      console.log(`[Broadcast Planner] No queued broadcast emails`);
      await this.checkCompletedBroadcasts();
      return result;
    }

    // Budget per account
    const budget = new Map<string, number>();
    for (const acct of accounts.rows) {
      budget.set(acct.id, BROADCAST_HOURLY_LIMIT);
      result.distribution[acct.email] = 0;
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

        // Reassign to the chosen account if different
        if (email.email_account_id !== assigned) {
          const acct = accounts.rows.find(a => a.id === assigned)!;
          await query(
            `UPDATE email_sends SET email_account_id = $1, from_email = $2 WHERE id = $3`,
            [assigned, acct.email, email.id]
          );
        }

        // Jitter across the hour (0-50 minutes)
        const jitterMs = Math.floor(Math.random() * 3000000);
        await sendQueue.add('send-email', { emailSendId: email.id }, { delay: jitterMs });

        const acct = accounts.rows.find(a => a.id === assigned)!;
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
