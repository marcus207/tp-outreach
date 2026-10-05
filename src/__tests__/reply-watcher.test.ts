/**
 * Tests for ReplyWatcher pure helpers: quote stripping, left-company detection
 * and DSN (bounce) classification.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection', () => ({ query: vi.fn(), TENANT: 'tp', BRAND_EMAIL: 'marcus@tp.finance' }));
vi.mock('../services/gmail-client', () => ({ gmailClient: {} }));
vi.mock('../services/sequence-engine', () => ({ sequenceEngine: { cancelEnrollment: vi.fn() } }));

import { stripQuotedText, isLeftCompanyText, classifyDsn } from '../services/reply-watcher';

describe('stripQuotedText', () => {
  it('drops > lines', () => {
    expect(stripQuotedText('Sounds good.\n> John has left the company')).toBe('Sounds good.');
  });

  it('cuts at Gmail "On ... wrote:" even when the address wraps', () => {
    const body = 'Happy to talk.\n\nOn Mon, 5 Oct 2026 at 09:00, Marcus <marcus@tp.finance>\nwrote:\nHi John, since you have left...';
    expect(stripQuotedText(body)).toBe('Happy to talk.');
  });

  it('cuts at collapsed HTML "On ... wrote:"', () => {
    expect(stripQuotedText('Call me Tuesday. On Mon, 5 Oct 2026 Marcus <m@tp.finance> wrote: no longer with')).toBe('Call me Tuesday.');
  });

  it('cuts at Outlook headers and Original Message', () => {
    expect(stripQuotedText('Yes please.\n\nFrom: Marcus\nSent: Monday\nTo: x\nhas left')).toBe('Yes please.');
    expect(stripQuotedText('Yes.\n-----Original Message-----\nhas left')).toBe('Yes.');
  });
});

describe('left company detection on stripped body', () => {
  it('ignores phrases in the quoted original', () => {
    const body = 'Thanks Marcus, worth a chat.\nOn Mon, Marcus <m@tp.finance> wrote:\n> since Jane has left the firm';
    expect(isLeftCompanyText(stripQuotedText(body))).toBe(false);
  });

  it('detects a short left-company notice', () => {
    expect(isLeftCompanyText('Jane is no longer with the company. Please contact info@x.com')).toBe(true);
  });
});

describe('classifyDsn', () => {
  it('hard on Action: failed / Status 5.x.x', () => {
    expect(classifyDsn('Reporting-MTA: dns; x\nAction: failed\nStatus: 5.1.1')).toBe('hard');
    expect(classifyDsn('Final-Recipient: rfc822; a@b.com\nStatus: 5.7.1')).toBe('hard');
  });

  it('hard on SMTP 550 code', () => {
    expect(classifyDsn("Address not found\nThe response was: 550 5.1.1 The email account that you tried to reach does not exist.")).toBe('hard');
    expect(classifyDsn('Remote server returned 554 rejected')).toBe('hard');
  });

  it('soft on Action: delayed / 4.x.x / retry wording', () => {
    expect(classifyDsn('Action: delayed\nStatus: 4.4.7')).toBe('soft');
    expect(classifyDsn('Delivery incomplete. 421 4.7.0 Try again later. Gmail will retry for 46 more hours.')).toBe('soft');
    expect(classifyDsn('Message delayed')).toBe('soft');
  });

  it('defaults to soft when nothing is recognisable', () => {
    expect(classifyDsn('Some notice from the mail system')).toBe('soft');
  });
});
