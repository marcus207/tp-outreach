import { query } from '../db/connection';
import { DripifySnapshot, DripifyAlert } from '../types';

interface DripifyIngestPayload {
  search_credits?: number;
  daily_invites_used?: number;
  daily_invites_limit?: number;
  daily_messages_used?: number;
  daily_messages_limit?: number;
  campaigns?: Array<{
    id: string;
    name: string;
    status: string;
    leads_count?: number;
    accepted?: number;
    replied?: number;
  }>;
  [key: string]: unknown;
}

export class DripifyMonitor {
  async ingestSnapshot(payload: DripifyIngestPayload): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO dripify_snapshots (
        snapshot_data, search_credits, daily_invites_used, daily_invites_limit,
        daily_messages_used, daily_messages_limit, campaigns
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [
        JSON.stringify(payload),
        payload.search_credits ?? null,
        payload.daily_invites_used ?? null,
        payload.daily_invites_limit ?? null,
        payload.daily_messages_used ?? null,
        payload.daily_messages_limit ?? null,
        payload.campaigns ? JSON.stringify(payload.campaigns) : null,
      ]
    );

    const snapshotId = result.rows[0].id;
    await this.checkAndCreateAlerts(snapshotId, payload);
    return snapshotId;
  }

  private async checkAndCreateAlerts(
    snapshotId: string,
    data: DripifyIngestPayload
  ): Promise<void> {
    // Get thresholds from settings
    const settingsResult = await query<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN ('dripify_alert_credits_threshold', 'dripify_alert_limit_pct')`
    );

    const settings: Record<string, number> = {};
    for (const row of settingsResult.rows) {
      settings[row.key] = parseInt(JSON.parse(row.value), 10);
    }

    const creditsThreshold = settings['dripify_alert_credits_threshold'] ?? 50;
    const limitPct = settings['dripify_alert_limit_pct'] ?? 90;

    // Check search credits
    if (
      data.search_credits !== undefined &&
      data.search_credits !== null &&
      data.search_credits < creditsThreshold
    ) {
      await this.createAlert(
        snapshotId,
        'low_credits',
        `Dripify search credits low: ${data.search_credits} remaining`,
        data.search_credits < creditsThreshold / 2 ? 'critical' : 'warning'
      );
    }

    // Check daily invites usage
    if (
      data.daily_invites_used !== undefined &&
      data.daily_invites_limit !== undefined &&
      data.daily_invites_limit > 0
    ) {
      const pct = (data.daily_invites_used / data.daily_invites_limit) * 100;
      if (pct >= limitPct) {
        await this.createAlert(
          snapshotId,
          'invite_limit',
          `Daily invite limit at ${pct.toFixed(0)}% (${data.daily_invites_used}/${data.daily_invites_limit})`,
          pct >= 100 ? 'critical' : 'warning'
        );
      }
    }

    // Check daily messages usage
    if (
      data.daily_messages_used !== undefined &&
      data.daily_messages_limit !== undefined &&
      data.daily_messages_limit > 0
    ) {
      const pct = (data.daily_messages_used / data.daily_messages_limit) * 100;
      if (pct >= limitPct) {
        await this.createAlert(
          snapshotId,
          'message_limit',
          `Daily message limit at ${pct.toFixed(0)}% (${data.daily_messages_used}/${data.daily_messages_limit})`,
          pct >= 100 ? 'critical' : 'warning'
        );
      }
    }
  }

  private async createAlert(
    snapshotId: string,
    alertType: string,
    message: string,
    severity: 'info' | 'warning' | 'critical'
  ): Promise<void> {
    // Deduplicate: don't create same alert type if unread one already exists
    const existing = await query(
      `SELECT id FROM dripify_alerts WHERE alert_type = $1 AND is_read = false`,
      [alertType]
    );

    if (existing.rows.length > 0) {
      // Update existing alert instead
      await query(
        `UPDATE dripify_alerts SET message = $1, severity = $2, snapshot_id = $3 WHERE alert_type = $4 AND is_read = false`,
        [message, severity, snapshotId, alertType]
      );
      return;
    }

    await query(
      `INSERT INTO dripify_alerts (alert_type, message, severity, snapshot_id) VALUES ($1, $2, $3, $4)`,
      [alertType, message, severity, snapshotId]
    );

    console.log(`[Dripify Monitor] Alert created: [${severity}] ${message}`);
  }

  async getLatestSnapshot(): Promise<DripifySnapshot | null> {
    const result = await query<DripifySnapshot>(
      `SELECT * FROM dripify_snapshots ORDER BY scraped_at DESC LIMIT 1`
    );
    return result.rows[0] || null;
  }

  async getUnreadAlerts(): Promise<DripifyAlert[]> {
    const result = await query<DripifyAlert>(
      `SELECT * FROM dripify_alerts WHERE is_read = false ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async markAlertRead(alertId: string): Promise<void> {
    await query(`UPDATE dripify_alerts SET is_read = true WHERE id = $1`, [alertId]);
  }

  async markAllAlertsRead(): Promise<void> {
    await query(`UPDATE dripify_alerts SET is_read = true WHERE is_read = false`);
  }

  async getSnapshots(limit = 10): Promise<DripifySnapshot[]> {
    const result = await query<DripifySnapshot>(
      `SELECT * FROM dripify_snapshots ORDER BY scraped_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

export const dripifyMonitor = new DripifyMonitor();
