import { google } from 'googleapis';
import { parseStringPromise } from 'xml2js';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { query, TENANT } from '../db/connection';
import { gmailClient } from './gmail-client';
import { EmailAccount } from '../types';

const gunzip = promisify(zlib.gunzip);

interface DmarcRecord {
  source_ip: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  header_from: string;
}

interface ParsedReport {
  org_name: string;
  report_id: string;
  domain: string;
  date_begin: Date;
  date_end: Date;
  policy: string;
  pct: number;
  records: DmarcRecord[];
}

export class DmarcScanner {

  async scanAndArchive(): Promise<{ processed: number; archived: number }> {
    const accounts = await gmailClient.getActiveAccounts();
    if (accounts.length === 0) return { processed: 0, archived: 0 };

    let totalProcessed = 0;
    let totalArchived = 0;

    for (const account of accounts) {
      try {
        const result = await this.scanAccount(account);
        totalProcessed += result.processed;
        totalArchived += result.archived;
      } catch (err) {
        console.error(`[DMARC Scanner] Error scanning ${account.email}:`, (err as Error).message);
      }
    }

    return { processed: totalProcessed, archived: totalArchived };
  }

  private async scanAccount(account: EmailAccount): Promise<{ processed: number; archived: number }> {
    const auth = await gmailClient.getAuthenticatedClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    const dmarcQuery = 'subject:("Report domain" OR "DMARC Aggregate" OR "DMARC report") OR (subject:DMARC from:(dmarc OR postmaster OR noreply OR mimecast OR google OR outlook OR yahoo))';

    let processed = 0;
    let archived = 0;
    let pageToken: string | undefined;

    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: dmarcQuery,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      });

      const messages = listRes.data.messages || [];
      pageToken = listRes.data.nextPageToken || undefined;

      for (const msg of messages) {
        if (!msg.id) continue;

        const exists = await query(
          `SELECT id FROM dmarc_reports WHERE gmail_message_id = $1`,
          [msg.id]
        );
        if (exists.rows.length > 0) {
          await this.archiveMessage(gmail, msg.id);
          archived++;
          continue;
        }

        try {
          const parsed = await this.fetchAndParse(gmail, msg.id);
          if (parsed) {
            await this.storeReport(parsed, msg.id, account.email);
            processed++;
          }
          await this.archiveMessage(gmail, msg.id);
          archived++;
        } catch (err) {
          console.warn(`[DMARC Scanner] Error processing message ${msg.id}:`, (err as Error).message);
        }
      }
    } while (pageToken);

    if (processed > 0 || archived > 0) {
      console.log(`[DMARC Scanner] ${account.email}: ${processed} reports parsed, ${archived} emails archived`);
    }

    return { processed, archived };
  }

  private async fetchAndParse(
    gmail: ReturnType<typeof google.gmail>,
    messageId: string
  ): Promise<ParsedReport | null> {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const parts = detail.data.payload?.parts || [];
    if (detail.data.payload?.body?.attachmentId) {
      parts.push(detail.data.payload as any);
    }

    for (const part of parts) {
      const filename = part.filename || '';
      const isXml = filename.endsWith('.xml') || filename.endsWith('.xml.gz') ||
                     filename.endsWith('.zip') || filename.endsWith('.gz') ||
                     (part.mimeType || '').includes('xml') ||
                     (part.mimeType || '').includes('gzip') ||
                     (part.mimeType || '').includes('zip');

      if (!isXml || !part.body) continue;

      let data: Buffer;

      if (part.body.attachmentId) {
        const attachment = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: part.body.attachmentId,
        });
        if (!attachment.data.data) continue;
        data = Buffer.from(attachment.data.data, 'base64');
      } else if (part.body.data) {
        data = Buffer.from(part.body.data, 'base64');
      } else {
        continue;
      }

      const xmlStr = await this.extractXml(data, filename);
      if (!xmlStr) continue;

      try {
        return await this.parseReport(xmlStr);
      } catch (err) {
        console.warn(`[DMARC Scanner] Failed to parse XML from ${filename}:`, (err as Error).message);
      }
    }

    return null;
  }

  private async extractXml(data: Buffer, filename: string): Promise<string | null> {
    if (filename.endsWith('.gz') || data[0] === 0x1f && data[1] === 0x8b) {
      try {
        const decompressed = await gunzip(data);
        return decompressed.toString('utf8');
      } catch {
        return null;
      }
    }

    if (filename.endsWith('.zip') || (data[0] === 0x50 && data[1] === 0x4b)) {
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(data);
        const entries = zip.getEntries();
        for (const entry of entries) {
          if (entry.entryName.endsWith('.xml')) {
            return entry.getData().toString('utf8');
          }
        }
      } catch {
        try {
          const decompressed = await gunzip(data);
          return decompressed.toString('utf8');
        } catch {
          return null;
        }
      }
    }

    const str = data.toString('utf8');
    if (str.includes('<feedback') || str.includes('<report_metadata')) {
      return str;
    }

    return null;
  }

  private async parseReport(xmlStr: string): Promise<ParsedReport> {
    const result: any = await parseStringPromise(xmlStr, { explicitArray: false, ignoreAttrs: true });
    const feedback = result.feedback || result;

    const meta = feedback.report_metadata || {};
    const policy = feedback.policy_published || {};
    const rawRecords = feedback.record;

    const records: DmarcRecord[] = [];
    const recordList = Array.isArray(rawRecords) ? rawRecords : (rawRecords ? [rawRecords] : []);

    for (const rec of recordList) {
      const row = rec.row || {};
      const pe = row.policy_evaluated || {};
      const ids = rec.identifiers || {};

      records.push({
        source_ip: row.source_ip || 'unknown',
        count: parseInt(row.count || '0', 10),
        disposition: pe.disposition || 'none',
        dkim: pe.dkim || 'none',
        spf: pe.spf || 'none',
        header_from: ids.header_from || policy.domain || '',
      });
    }

    const dateBegin = meta.date_range?.begin
      ? new Date(parseInt(meta.date_range.begin, 10) * 1000)
      : new Date();
    const dateEnd = meta.date_range?.end
      ? new Date(parseInt(meta.date_range.end, 10) * 1000)
      : new Date();

    return {
      org_name: meta.org_name || 'Unknown',
      report_id: meta.report_id || `${Date.now()}`,
      domain: policy.domain || '',
      date_begin: dateBegin,
      date_end: dateEnd,
      policy: policy.p || 'none',
      pct: parseInt(policy.pct || '100', 10),
      records,
    };
  }

  private async storeReport(
    report: ParsedReport,
    gmailMessageId: string,
    gmailAccount: string
  ): Promise<void> {
    const totalMessages = report.records.reduce((s, r) => s + r.count, 0);
    const passCount = report.records
      .filter(r => r.dkim === 'pass' || r.spf === 'pass')
      .reduce((s, r) => s + r.count, 0);
    const failCount = totalMessages - passCount;
    const spfPass = report.records.filter(r => r.spf === 'pass').reduce((s, r) => s + r.count, 0);
    const spfFail = totalMessages - spfPass;
    const dkimPass = report.records.filter(r => r.dkim === 'pass').reduce((s, r) => s + r.count, 0);
    const dkimFail = totalMessages - dkimPass;

    const sourceIps = report.records.map(r => ({
      ip: r.source_ip,
      count: r.count,
      dkim: r.dkim,
      spf: r.spf,
      disposition: r.disposition,
    }));

    await query(
      `INSERT INTO dmarc_reports (
        tenant, org_name, report_id, domain, date_begin, date_end,
        policy, pct, total_messages, pass_count, fail_count,
        spf_pass, spf_fail, dkim_pass, dkim_fail,
        source_ips, raw_records, gmail_message_id, gmail_account
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (tenant, report_id, org_name) DO UPDATE SET
        total_messages = EXCLUDED.total_messages,
        pass_count = EXCLUDED.pass_count,
        fail_count = EXCLUDED.fail_count,
        source_ips = EXCLUDED.source_ips`,
      [
        TENANT, report.org_name, report.report_id, report.domain,
        report.date_begin, report.date_end, report.policy, report.pct,
        totalMessages, passCount, failCount,
        spfPass, spfFail, dkimPass, dkimFail,
        JSON.stringify(sourceIps), JSON.stringify(report.records),
        gmailMessageId, gmailAccount,
      ]
    );
  }

  private async archiveMessage(
    gmail: ReturnType<typeof google.gmail>,
    messageId: string
  ): Promise<void> {
    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['INBOX'],
        },
      });
    } catch (err) {
      console.warn(`[DMARC Scanner] Failed to archive message ${messageId}:`, (err as Error).message);
    }
  }

  async createGmailFilter(account: EmailAccount): Promise<boolean> {
    try {
      const auth = await gmailClient.getAuthenticatedClient(account);
      const gmail = google.gmail({ version: 'v1', auth });

      const existing = await gmail.users.settings.filters.list({ userId: 'me' });
      const filters = existing.data.filter || [];
      const alreadyExists = filters.some(f =>
        f.criteria?.query?.includes('Report domain') && f.criteria?.query?.includes('DMARC')
      );

      if (alreadyExists) {
        console.log(`[DMARC Scanner] Gmail filter already exists for ${account.email}`);
        return true;
      }

      await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: {
            query: 'subject:("Report domain" OR "DMARC")',
          },
          action: {
            removeLabelIds: ['INBOX'],
          },
        },
      });

      console.log(`[DMARC Scanner] Created Gmail filter for ${account.email}`);
      return true;
    } catch (err) {
      console.error(`[DMARC Scanner] Failed to create Gmail filter:`, (err as Error).message);
      return false;
    }
  }

  async setupFiltersForAllAccounts(): Promise<number> {
    const accounts = await gmailClient.getActiveAccounts();
    let created = 0;
    for (const account of accounts) {
      const ok = await this.createGmailFilter(account);
      if (ok) created++;
    }
    return created;
  }

  async getSummary(days: number = 30): Promise<any> {
    const reports = await query(
      `SELECT * FROM dmarc_reports
       WHERE tenant = $1 AND date_end >= NOW() - INTERVAL '1 day' * $2
       ORDER BY date_end DESC`,
      [TENANT, days]
    );

    const totals = await query(
      `SELECT
         COUNT(*) AS total_reports,
         COALESCE(SUM(total_messages), 0) AS total_messages,
         COALESCE(SUM(pass_count), 0) AS total_pass,
         COALESCE(SUM(fail_count), 0) AS total_fail,
         COALESCE(SUM(spf_pass), 0) AS total_spf_pass,
         COALESCE(SUM(spf_fail), 0) AS total_spf_fail,
         COALESCE(SUM(dkim_pass), 0) AS total_dkim_pass,
         COALESCE(SUM(dkim_fail), 0) AS total_dkim_fail
       FROM dmarc_reports
       WHERE tenant = $1 AND date_end >= NOW() - INTERVAL '1 day' * $2`,
      [TENANT, days]
    );

    const byOrg = await query(
      `SELECT
         org_name,
         COUNT(*) AS report_count,
         SUM(total_messages) AS total_messages,
         SUM(pass_count) AS pass_count,
         SUM(fail_count) AS fail_count
       FROM dmarc_reports
       WHERE tenant = $1 AND date_end >= NOW() - INTERVAL '1 day' * $2
       GROUP BY org_name
       ORDER BY total_messages DESC`,
      [TENANT, days]
    );

    const daily = await query(
      `SELECT
         DATE(date_end) AS date,
         SUM(total_messages) AS messages,
         SUM(pass_count) AS pass_count,
         SUM(fail_count) AS fail_count
       FROM dmarc_reports
       WHERE tenant = $1 AND date_end >= NOW() - INTERVAL '1 day' * $2
       GROUP BY DATE(date_end)
       ORDER BY date ASC`,
      [TENANT, days]
    );

    const t = totals.rows[0] || {};
    const totalMessages = parseInt(t.total_messages, 10) || 0;
    const totalPass = parseInt(t.total_pass, 10) || 0;

    return {
      summary: {
        total_reports: parseInt(t.total_reports, 10) || 0,
        total_messages: totalMessages,
        pass_rate: totalMessages > 0 ? parseFloat(((totalPass / totalMessages) * 100).toFixed(1)) : 100,
        spf_pass_rate: totalMessages > 0
          ? parseFloat((((parseInt(t.total_spf_pass, 10) || 0) / totalMessages) * 100).toFixed(1))
          : 100,
        dkim_pass_rate: totalMessages > 0
          ? parseFloat((((parseInt(t.total_dkim_pass, 10) || 0) / totalMessages) * 100).toFixed(1))
          : 100,
      },
      by_org: byOrg.rows.map(r => ({
        org_name: r.org_name,
        report_count: parseInt(r.report_count, 10),
        total_messages: parseInt(r.total_messages, 10),
        pass_count: parseInt(r.pass_count, 10),
        fail_count: parseInt(r.fail_count, 10),
      })),
      daily: daily.rows.map(r => ({
        date: r.date,
        messages: parseInt(r.messages, 10),
        pass_count: parseInt(r.pass_count, 10),
        fail_count: parseInt(r.fail_count, 10),
      })),
      reports: reports.rows.map(r => ({
        id: r.id,
        org_name: r.org_name,
        domain: r.domain,
        date_begin: r.date_begin,
        date_end: r.date_end,
        policy: r.policy,
        total_messages: r.total_messages,
        pass_count: r.pass_count,
        fail_count: r.fail_count,
        spf_pass: r.spf_pass,
        spf_fail: r.spf_fail,
        dkim_pass: r.dkim_pass,
        dkim_fail: r.dkim_fail,
        source_ips: r.source_ips,
      })),
    };
  }
}

export const dmarcScanner = new DmarcScanner();
