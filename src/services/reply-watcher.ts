import { query } from '../db/connection';
import { gmailClient } from './gmail-client';
import { sequenceEngine } from './sequence-engine';
import { EmailAccount } from '../types';

interface ReplyMatch {
  emailSendId: string;
  enrollmentId: string | null;
  sequenceId: string | null;
  stopOnReply: boolean;
}

export class ReplyWatcher {
  async pollAllAccounts(): Promise<void> {
    console.log('[Reply Watcher] Polling all active accounts for replies...');

    const accounts = await gmailClient.getActiveAccounts();

    if (accounts.length === 0) {
      console.log('[Reply Watcher] No active accounts to poll');
      return;
    }

    for (const account of accounts) {
      try {
        await this.pollAccount(account);
      } catch (err) {
        console.error(`[Reply Watcher] Error polling account ${account.email}:`, err);
      }
    }
  }

  private async pollAccount(account: EmailAccount): Promise<void> {
    // Poll for messages in the last 10 minutes
    const since = new Date(Date.now() - 10 * 60 * 1000);
    const messages = await gmailClient.checkForReplies(account, since);

    if (messages.length === 0) return;

    console.log(`[Reply Watcher] Found ${messages.length} messages for ${account.email}`);

    for (const message of messages) {
      try {
        await this.processMessage(message.id, message.threadId);
      } catch (err) {
        console.error(`[Reply Watcher] Error processing message ${message.id}:`, err);
      }
    }
  }

  private async processMessage(messageId: string, threadId: string): Promise<void> {
    // Check if we've already processed this exact message
    const existing = await query<{ id: string }>(
      `SELECT id FROM email_events
       WHERE event_type = 'reply'
         AND email_send_id IN (
           SELECT id FROM email_sends WHERE gmail_thread_id = $1
         )`,
      [threadId]
    );

    // Find the outbound send for this thread
    const match = await this.matchReply(threadId, messageId);

    if (!match) {
      // Not a thread we're tracking
      return;
    }

    // Skip if already logged
    if (existing.rows.length > 0) {
      return;
    }

    // Record reply event
    await query(
      `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, 'reply')`,
      [match.emailSendId]
    );

    console.log(`[Reply Watcher] Reply detected on thread ${threadId} -> send ${match.emailSendId}`);

    // Cancel enrollment if configured
    if (match.enrollmentId && match.stopOnReply) {
      await sequenceEngine.cancelEnrollment(match.enrollmentId, 'replied');
      console.log(`[Reply Watcher] Cancelled enrollment ${match.enrollmentId} due to reply`);
    }
  }

  async matchReply(threadId: string, _messageId: string): Promise<ReplyMatch | null> {
    const result = await query<{
      id: string;
      enrollment_id: string | null;
      sequence_id: string | null;
      stop_on_reply: boolean;
    }>(
      `SELECT
         es.id,
         es.enrollment_id,
         se.sequence_id,
         COALESCE(s.stop_on_reply, false) AS stop_on_reply
       FROM email_sends es
       LEFT JOIN sequence_enrollments se ON se.id = es.enrollment_id
       LEFT JOIN sequences s ON s.id = se.sequence_id
       WHERE es.gmail_thread_id = $1
       ORDER BY es.sent_at ASC
       LIMIT 1`,
      [threadId]
    );

    if (!result.rows[0]) return null;

    const row = result.rows[0];
    return {
      emailSendId: row.id,
      enrollmentId: row.enrollment_id,
      sequenceId: row.sequence_id,
      stopOnReply: row.stop_on_reply,
    };
  }
}

export const replyWatcher = new ReplyWatcher();
