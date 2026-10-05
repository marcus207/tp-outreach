/**
 * In-memory Gmail API double, installed via setGmailTransportForTests().
 *
 * Implements the subset of `gmail_v1.Gmail` the codebase calls:
 *   users.getProfile, users.messages.{list,get,send,modify},
 *   users.threads.{get,modify,trash}
 *
 * Mailboxes are keyed by account email. Factories give each account
 * oauth_tokens.access_token = `fake-access:<email>`, which is how a call made
 * with that account's OAuth2 client is routed to its mailbox.
 *
 * Inbound mail is injected with injectReply / injectBounce / injectOOO.
 * Anything the app sends through the raw API (e.g. reply forwards to marcus@)
 * is captured in `sent`. Outreach sends never come here: GmailClient.sendEmail
 * writes them to test_outbox while SEND_MODE != live.
 */
import { randomUUID } from 'crypto';

type Header = { name: string; value: string };
type Part = { mimeType: string; headers?: Header[]; body: { data?: string; size?: number }; parts?: Part[] };

export interface FakeMessage {
  id: string;
  threadId: string;
  mailbox: string;
  labelIds: string[];
  internalDate: number;
  kind: 'reply' | 'bounce' | 'ooo' | 'other';
  payload: Part & { headers: Header[] };
}

export interface SentRawMessage {
  mailbox: string;
  id: string;
  threadId: string;
  raw: string;
  headers: Record<string, string>;
  body: string;
}

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

export function fakeAccessToken(email: string): string {
  return `fake-access:${email.toLowerCase()}`;
}

function mailboxOf(auth: unknown): string {
  const creds = (auth as { credentials?: { access_token?: string } } | undefined)?.credentials;
  const tok = creds?.access_token || '';
  return tok.startsWith('fake-access:') ? tok.slice('fake-access:'.length) : '*';
}

function parseQuery(q: string | undefined) {
  const s = q || '';
  return {
    inbox: /\bin:inbox\b/i.test(s),
    mailerDaemon: /\bfrom:mailer-daemon\b/i.test(s),
    from: (s.match(/\bfrom:(\S+)/i) || [])[1]?.toLowerCase(),
    after: Number((s.match(/\bafter:(\d+)/i) || [])[1] || 0),
  };
}

function header(m: FakeMessage, name: string): string {
  return m.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

export class FakeGmail {
  messages: FakeMessage[] = [];
  sent: SentRawMessage[] = [];
  calls: Array<{ mailbox: string; method: string; params: unknown }> = [];

  reset(): void {
    this.messages = [];
    this.sent = [];
    this.calls = [];
  }

  /** Factory with the google.gmail({version, auth}) signature. */
  factory = (opts: { version: 'v1'; auth?: unknown }) => this.clientFor(mailboxOf(opts.auth));

  private add(mailbox: string, kind: FakeMessage['kind'], threadId: string, headers: Header[], body: string): FakeMessage {
    const msg: FakeMessage = {
      id: `fake-in-${randomUUID()}`,
      threadId,
      mailbox: mailbox.toLowerCase(),
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: Date.now(),
      kind,
      payload: {
        mimeType: 'multipart/alternative',
        headers,
        body: { size: 0 },
        parts: [{ mimeType: 'text/plain', body: { data: b64url(body), size: body.length } }],
      },
    };
    this.messages.push(msg);
    return msg;
  }

  /** A genuine human reply landing in `mailbox` on `threadId`. */
  injectReply(o: { mailbox: string; threadId: string; from: string; subject: string; body?: string; headers?: Header[] }): FakeMessage {
    return this.add(o.mailbox, 'reply', o.threadId, [
      { name: 'From', value: o.from },
      { name: 'To', value: o.mailbox },
      { name: 'Subject', value: o.subject },
      ...(o.headers || []),
    ], o.body ?? 'Thanks for getting in touch. Happy to have a call next week.');
  }

  /** An out-of-office auto-reply (Auto-Submitted header + OOO subject). */
  injectOOO(o: { mailbox: string; threadId: string; from: string; subject?: string; body?: string }): FakeMessage {
    return this.add(o.mailbox, 'ooo', o.threadId, [
      { name: 'From', value: o.from },
      { name: 'To', value: o.mailbox },
      { name: 'Subject', value: o.subject ?? 'Automatic reply: Out of office' },
      { name: 'Auto-Submitted', value: 'auto-replied' },
    ], o.body ?? 'I am currently out of the office until Monday with limited access to email.');
  }

  /** A mailer-daemon DSN on the outbound thread. hard=true -> 5.1.1 permanent failure. */
  injectBounce(o: { mailbox: string; threadId: string; recipient: string; hard?: boolean }): FakeMessage {
    const hard = o.hard !== false;
    const dsn = hard
      ? `Address not found\nYour message wasn't delivered to ${o.recipient}.\n\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown`
      : `Delivery incomplete\nThere was a temporary problem delivering your message to ${o.recipient}. Gmail will retry.\n\nAction: delayed\nStatus: 4.4.1`;
    return this.add(o.mailbox, 'bounce', o.threadId, [
      { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
      { name: 'To', value: o.mailbox },
      { name: 'Subject', value: hard ? 'Delivery Status Notification (Failure)' : 'Delivery Status Notification (Delay)' },
    ], dsn);
  }

  private visible(mailbox: string): FakeMessage[] {
    return this.messages.filter(m => mailbox === '*' || m.mailbox === mailbox);
  }

  private find(id: string): FakeMessage {
    const m = this.messages.find(x => x.id === id);
    if (!m) {
      const err = new Error('Requested entity was not found.') as Error & { code: number };
      err.code = 404;
      throw err;
    }
    return m;
  }

  clientFor(mailbox: string) {
    const log = (method: string, params: unknown) => this.calls.push({ mailbox, method, params });
    const self = this;
    return {
      users: {
        async getProfile(params: unknown) {
          log('users.getProfile', params);
          return { data: { emailAddress: mailbox, messagesTotal: self.visible(mailbox).length, historyId: '1' } };
        },
        messages: {
          async list(params: { q?: string; maxResults?: number }) {
            log('users.messages.list', params);
            const q = parseQuery(params.q);
            let rows = self.visible(mailbox).filter(m => !m.labelIds.includes('TRASH'));
            if (q.mailerDaemon) rows = rows.filter(m => m.kind === 'bounce');
            else if (q.from) rows = rows.filter(m => header(m, 'From').toLowerCase().includes(q.from as string));
            if (q.inbox) rows = rows.filter(m => m.labelIds.includes('INBOX'));
            if (q.after) rows = rows.filter(m => m.internalDate >= q.after * 1000);
            rows = [...rows].sort((a, b) => b.internalDate - a.internalDate).slice(0, params.maxResults || 100);
            return { data: { messages: rows.map(m => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: rows.length } };
          },
          async get(params: { id: string; format?: string; metadataHeaders?: string[] }) {
            log('users.messages.get', params);
            const m = self.find(params.id);
            const payload = params.format === 'metadata'
              ? {
                  mimeType: m.payload.mimeType,
                  headers: params.metadataHeaders?.length
                    ? m.payload.headers.filter(h => params.metadataHeaders!.some(n => n.toLowerCase() === h.name.toLowerCase()))
                    : m.payload.headers,
                }
              : m.payload;
            return { data: { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds], internalDate: String(m.internalDate), payload } };
          },
          async send(params: { requestBody: { raw: string; threadId?: string } }) {
            log('users.messages.send', params);
            const raw = Buffer.from(params.requestBody.raw, 'base64url').toString('utf-8');
            const sep = raw.search(/\r?\n\r?\n/);
            const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
            const headers: Record<string, string> = {};
            for (const line of headerBlock.split(/\r?\n/)) {
              const i = line.indexOf(':');
              if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
            const id = `fake-sent-${randomUUID()}`;
            const threadId = params.requestBody.threadId || `fake-thread-${randomUUID()}`;
            self.sent.push({ mailbox, id, threadId, raw, headers, body: sep >= 0 ? raw.slice(sep).trim() : '' });
            return { data: { id, threadId, labelIds: ['SENT'] } };
          },
          async modify(params: { id: string; requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } }) {
            log('users.messages.modify', params);
            const m = self.find(params.id);
            m.labelIds = m.labelIds.filter(l => !(params.requestBody.removeLabelIds || []).includes(l));
            for (const l of params.requestBody.addLabelIds || []) if (!m.labelIds.includes(l)) m.labelIds.push(l);
            return { data: { id: m.id, labelIds: m.labelIds } };
          },
        },
        threads: {
          async get(params: { id: string }) {
            log('users.threads.get', params);
            const msgs = self.visible(mailbox).filter(m => m.threadId === params.id);
            if (!msgs.length) {
              const err = new Error('Requested entity was not found.') as Error & { code: number };
              err.code = 404;
              throw err;
            }
            return { data: { id: params.id, messages: msgs.map(m => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, payload: m.payload })) } };
          },
          async modify(params: { id: string; requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } }) {
            log('users.threads.modify', params);
            for (const m of self.visible(mailbox).filter(x => x.threadId === params.id)) {
              m.labelIds = m.labelIds.filter(l => !(params.requestBody.removeLabelIds || []).includes(l));
              for (const l of params.requestBody.addLabelIds || []) if (!m.labelIds.includes(l)) m.labelIds.push(l);
            }
            return { data: { id: params.id } };
          },
          async trash(params: { id: string }) {
            log('users.threads.trash', params);
            for (const m of self.visible(mailbox).filter(x => x.threadId === params.id)) {
              m.labelIds = [...m.labelIds.filter(l => l !== 'INBOX'), 'TRASH'];
            }
            return { data: { id: params.id } };
          },
        },
      },
    };
  }
}

export const fakeGmail = new FakeGmail();
