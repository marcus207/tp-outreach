#!/usr/bin/env python3
"""
Weekly Email Deliverability Checker
Sends a test email from each TP outreach account, checks SPF/DKIM/DMARC,
scans major blacklists, and emails a report to marcus@tp.finance.
Runs every Monday at 8:00 AM UTC via cron.
"""
import datetime
import json
import logging
import os
import smtplib
import socket
import subprocess
import sys

import dns.resolver
import psycopg2

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

def _db_url():
    import os
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    for line in open("/root/tp-outreach/.env"):
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("DATABASE_URL not set")


DB_URL = _db_url()
DOMAIN = "tp.finance"
REPORT_TO = "marcus@tp.finance"
SERVER_IP = "72.61.207.90"

BLACKLISTS = [
    "zen.spamhaus.org",
    "bl.spamcop.net",
    "b.barracudacentral.org",
    "dnsbl.sorbs.net",
    "spam.dnsbl.sorbs.net",
    "dul.dnsbl.sorbs.net",
    "dnsbl-1.uceprotect.net",
    "psbl.surriel.com",
    "all.s5h.net",
    "rbl.interserver.net",
]


def check_spf():
    try:
        answers = dns.resolver.resolve(DOMAIN, 'TXT')
        for rdata in answers:
            txt = rdata.to_text().strip('"')
            if txt.startswith('v=spf1'):
                has_hard_fail = txt.endswith('-all')
                has_google = '_spf.google.com' in txt
                score = 10
                issues = []
                if not has_hard_fail:
                    score -= 3
                    issues.append("Using ~all (soft fail) instead of -all (hard fail)")
                if not has_google:
                    score -= 5
                    issues.append("Google SPF not included")
                return {'record': txt, 'score': score, 'issues': issues, 'status': 'PASS' if score >= 8 else 'WARN' if score >= 5 else 'FAIL'}
        return {'record': None, 'score': 0, 'issues': ['No SPF record found'], 'status': 'FAIL'}
    except Exception as e:
        return {'record': None, 'score': 0, 'issues': [str(e)], 'status': 'FAIL'}


def check_dkim():
    selectors = ['google', 'default', 'selector1', 'mail']
    for sel in selectors:
        try:
            answers = dns.resolver.resolve(f'{sel}._domainkey.{DOMAIN}', 'TXT')
            for rdata in answers:
                txt = rdata.to_text().strip('"')
                if 'v=DKIM1' in txt or 'p=' in txt:
                    has_key = 'p=' in txt and len(txt) > 50
                    return {
                        'selector': sel,
                        'record': txt[:80] + '...',
                        'score': 10 if has_key else 5,
                        'issues': [] if has_key else ['DKIM key appears empty or short'],
                        'status': 'PASS' if has_key else 'WARN'
                    }
        except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
            continue
        except Exception:
            continue
    return {'selector': None, 'record': None, 'score': 0, 'issues': ['No DKIM record found'], 'status': 'FAIL'}


def check_dmarc():
    try:
        answers = dns.resolver.resolve(f'_dmarc.{DOMAIN}', 'TXT')
        for rdata in answers:
            txt = rdata.to_text().strip('"')
            if 'v=DMARC1' in txt:
                score = 10
                issues = []
                if 'p=none' in txt:
                    score -= 4
                    issues.append("Policy is 'none', not enforcing. Use 'quarantine' or 'reject'")
                elif 'p=quarantine' in txt:
                    score -= 1
                    issues.append("Policy is 'quarantine'. Consider upgrading to 'reject' later")
                if 'rua=' not in txt:
                    score -= 2
                    issues.append("No aggregate reporting address (rua)")
                return {'record': txt, 'score': score, 'issues': issues, 'status': 'PASS' if score >= 8 else 'WARN' if score >= 5 else 'FAIL'}
        return {'record': None, 'score': 0, 'issues': ['No DMARC record found'], 'status': 'FAIL'}
    except Exception as e:
        return {'record': None, 'score': 0, 'issues': [str(e)], 'status': 'FAIL'}


def check_blacklists():
    reversed_ip = '.'.join(reversed(SERVER_IP.split('.')))
    listed_on = []
    clean = []
    errored = []
    for bl in BLACKLISTS:
        try:
            answers = dns.resolver.resolve(f'{reversed_ip}.{bl}', 'A')
            codes = [r.to_text() for r in answers]
            # 127.255.255.x is NOT a listing — it's an error from the DNSBL
            # (e.g. Spamhaus refuses queries from public/open resolvers and
            # returns 127.255.255.254). Real listings are 127.0.0.2 - 127.0.0.11.
            real_listing = [c for c in codes if not c.startswith('127.255.255.')]
            if real_listing:
                listed_on.append(bl)
            else:
                # Query was refused/errored by the blocklist, not a listing.
                errored.append(bl)
                clean.append(bl)
        except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
            clean.append(bl)
        except Exception:
            clean.append(bl)
    if errored:
        log.warning(
            "Blocklist query errored (likely public-resolver refusal, not a listing): %s. "
            "These are counted as clean.", ', '.join(errored)
        )

    score = 10 - (len(listed_on) * 3)
    if score < 0:
        score = 0
    return {
        'listed_on': listed_on,
        'clean_count': len(clean),
        'total_checked': len(BLACKLISTS),
        'score': score,
        'status': 'PASS' if not listed_on else 'FAIL'
    }


def check_reverse_dns():
    try:
        result = dns.resolver.resolve(dns.reversename.from_address(SERVER_IP), 'PTR')
        ptr = str(result[0]).rstrip('.')
        return {'ptr': ptr, 'score': 10, 'issues': [], 'status': 'PASS'}
    except Exception as e:
        return {'ptr': None, 'score': 0, 'issues': [str(e)], 'status': 'FAIL'}


def get_send_stats():
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    # Last 7 days stats per account
    cur.execute("""
        SELECT from_email,
            COUNT(*) FILTER (WHERE status = 'sent') as sent,
            COUNT(*) FILTER (WHERE status = 'bounced') as bounced,
            COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM email_sends
        WHERE tenant = 'tp' AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY from_email
        ORDER BY sent DESC
    """)
    account_stats = []
    for row in cur.fetchall():
        total = row[1] + row[2] + row[3]
        bounce_rate = (row[2] / total * 100) if total > 0 else 0
        account_stats.append({
            'email': row[0],
            'sent': row[1],
            'bounced': row[2],
            'failed': row[3],
            'bounce_rate': round(bounce_rate, 1)
        })

    # Unsubscribes in last 7 days
    cur.execute("""
        SELECT COUNT(*) FROM email_events
        WHERE event_type = 'unsubscribe' AND created_at > NOW() - INTERVAL '7 days'
    """)
    unsub_count = cur.fetchone()[0]

    # Open rate
    cur.execute("""
        SELECT
            COUNT(DISTINCT es.id) as total_sent,
            COUNT(DISTINCT ee.email_send_id) as total_opened
        FROM email_sends es
        LEFT JOIN email_events ee ON ee.email_send_id = es.id AND ee.event_type = 'open'
        WHERE es.tenant = 'tp' AND es.status = 'sent' AND es.created_at > NOW() - INTERVAL '7 days'
    """)
    row = cur.fetchone()
    open_rate = (row[1] / row[0] * 100) if row[0] > 0 else 0

    conn.close()
    return {
        'accounts': account_stats,
        'unsubscribes_7d': unsub_count,
        'open_rate_7d': round(open_rate, 1),
        'total_sent_7d': sum(a['sent'] for a in account_stats),
    }


def save_to_db(spf, dkim, dmarc, blacklist, rdns, stats, overall_score):
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO deliverability_checks (
            overall_score, spf_score, spf_status, spf_record, spf_issues,
            dkim_score, dkim_status, dkim_selector, dkim_issues,
            dmarc_score, dmarc_status, dmarc_record, dmarc_issues,
            blacklist_score, blacklist_status, blacklist_listed, blacklist_clean, blacklist_total,
            rdns_score, rdns_status, rdns_ptr,
            total_sent_7d, open_rate_7d, unsubscribes_7d, account_stats
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """, [
        overall_score, spf['score'], spf['status'], spf.get('record'), json.dumps(spf.get('issues', [])),
        dkim['score'], dkim['status'], dkim.get('selector'), json.dumps(dkim.get('issues', [])),
        dmarc['score'], dmarc['status'], dmarc.get('record'), json.dumps(dmarc.get('issues', [])),
        blacklist['score'], blacklist['status'], json.dumps(blacklist.get('listed_on', [])), blacklist.get('clean_count', 0), blacklist.get('total_checked', 0),
        rdns['score'], rdns['status'], rdns.get('ptr'),
        stats.get('total_sent_7d', 0), stats.get('open_rate_7d', 0), stats.get('unsubscribes_7d', 0), json.dumps(stats.get('accounts', [])),
    ])
    conn.commit()
    conn.close()
    log.info("Results saved to deliverability_checks table")


def build_report():
    log.info("Running deliverability checks...")

    spf = check_spf()
    dkim = check_dkim()
    dmarc = check_dmarc()
    blacklist = check_blacklists()
    rdns = check_reverse_dns()
    stats = get_send_stats()

    overall_score = round((spf['score'] + dkim['score'] + dmarc['score'] + blacklist['score'] + rdns['score']) / 5, 1)

    save_to_db(spf, dkim, dmarc, blacklist, rdns, stats, overall_score)

    status_icon = {
        'PASS': '&#9989;',
        'WARN': '&#9888;&#65039;',
        'FAIL': '&#10060;',
    }

    date_str = datetime.datetime.now().strftime('%d %B %Y')

    account_rows = ''
    for a in stats['accounts']:
        bounce_color = '#dc2626' if a['bounce_rate'] > 2 else '#f59e0b' if a['bounce_rate'] > 0.5 else '#10b981'
        account_rows += f"""
        <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;">{a['email']}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;text-align:center;">{a['sent']:,}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;text-align:center;">{a['bounced']}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:{bounce_color};font-size:13px;text-align:center;font-weight:bold;">{a['bounce_rate']}%</td>
        </tr>"""

    issue_rows = ''
    for check_name, check in [('SPF', spf), ('DKIM', dkim), ('DMARC', dmarc), ('Blacklists', blacklist), ('Reverse DNS', rdns)]:
        issues = check.get('issues', [])
        if check_name == 'Blacklists' and check.get('listed_on'):
            issues = [f"Listed on: {', '.join(check['listed_on'])}"]
        for issue in issues:
            issue_rows += f"""
            <tr>
                <td style="padding:6px 12px;border-bottom:1px solid #1a2332;color:#f59e0b;font-size:13px;">{check_name}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;">{issue}</td>
            </tr>"""

    if not issue_rows:
        issue_rows = '<tr><td colspan="2" style="padding:12px;color:#10b981;font-size:13px;">No issues detected.</td></tr>'

    score_color = '#10b981' if overall_score >= 8 else '#f59e0b' if overall_score >= 5 else '#dc2626'

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#080E18;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:640px;margin:0 auto;background:#0d1520;border:1px solid #1a2332;">

    <div style="padding:32px 40px;border-bottom:1px solid #1a2332;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;">TP.Finance Email Deliverability Report</h1>
        <p style="margin:8px 0 0;color:#6B7E8F;font-size:13px;">Week ending {date_str}</p>
    </div>

    <div style="padding:24px 40px;text-align:center;border-bottom:1px solid #1a2332;">
        <p style="margin:0;color:#6B7E8F;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Overall Score</p>
        <p style="margin:8px 0 0;color:{score_color};font-size:48px;font-weight:bold;">{overall_score}/10</p>
    </div>

    <div style="padding:24px 40px;border-bottom:1px solid #1a2332;">
        <h2 style="margin:0 0 16px;color:#ffffff;font-size:15px;">Authentication Checks</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr style="background:#111b2a;">
                <td style="padding:8px 12px;color:#6B7E8F;font-size:11px;text-transform:uppercase;">Check</td>
                <td style="padding:8px 12px;color:#6B7E8F;font-size:11px;text-transform:uppercase;text-align:center;">Score</td>
                <td style="padding:8px 12px;color:#6B7E8F;font-size:11px;text-transform:uppercase;text-align:center;">Status</td>
            </tr>
            <tr><td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;">SPF</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;text-align:center;">{spf['score']}/10</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;font-size:13px;text-align:center;">{status_icon[spf['status']]}</td></tr>
            <tr><td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;">DKIM</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;text-align:center;">{dkim['score']}/10</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;font-size:13px;text-align:center;">{status_icon[dkim['status']]}</td></tr>
            <tr><td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;">DMARC</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;text-align:center;">{dmarc['score']}/10</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;font-size:13px;text-align:center;">{status_icon[dmarc['status']]}</td></tr>
            <tr><td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;">Blacklists ({blacklist['clean_count']}/{blacklist['total_checked']} clean)</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;text-align:center;">{blacklist['score']}/10</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;font-size:13px;text-align:center;">{status_icon[blacklist['status']]}</td></tr>
            <tr><td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;">Reverse DNS</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;color:#e0e0e0;font-size:13px;text-align:center;">{rdns['score']}/10</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1a2332;font-size:13px;text-align:center;">{status_icon[rdns['status']]}</td></tr>
        </table>
    </div>

    <div style="padding:24px 40px;border-bottom:1px solid #1a2332;">
        <h2 style="margin:0 0 16px;color:#ffffff;font-size:15px;">7-Day Send Performance</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr style="background:#111b2a;">
                <td style="padding:8px 12px;color:#6B7E8F;font-size:11px;text-transform:uppercase;">Account</td>
                <td style="padding:8px 12px;color:#6B7E8F;font-size:11px;text-transform:uppercase;text-align:center;">Sent</td>
                <td style="padding:8px 12px;color:#6B7E8F;font-size:11px;text-transform:uppercase;text-align:center;">Bounced</td>
                <td style="padding:8px 12px;color:#6B7E8F;font-size:11px;text-transform:uppercase;text-align:center;">Bounce Rate</td>
            </tr>
            {account_rows}
        </table>
        <div style="margin-top:16px;padding:12px;background:#111b2a;border-radius:6px;">
            <span style="color:#6B7E8F;font-size:12px;">Total sent: <strong style="color:#e0e0e0;">{stats['total_sent_7d']:,}</strong></span>
            <span style="color:#6B7E8F;font-size:12px;margin-left:24px;">Open rate: <strong style="color:#e0e0e0;">{stats['open_rate_7d']}%</strong></span>
            <span style="color:#6B7E8F;font-size:12px;margin-left:24px;">Unsubscribes: <strong style="color:#e0e0e0;">{stats['unsubscribes_7d']}</strong></span>
        </div>
    </div>

    <div style="padding:24px 40px;">
        <h2 style="margin:0 0 12px;color:#ffffff;font-size:15px;">Issues</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            {issue_rows}
        </table>
    </div>

    <div style="padding:16px 40px;border-top:1px solid #1a2332;">
        <p style="margin:0;color:#3A4550;font-size:10px;">Automated deliverability report from TP.Finance Outreach Engine</p>
    </div>

</div>
</body></html>"""

    return html, overall_score


def send_report(html, score):
    """Send the report via the TP outreach Gmail API."""
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    # Get marcus@tp.finance account
    cur.execute(
        "SELECT id FROM email_accounts WHERE email = 'marcus@tp.finance' AND tenant = 'tp' AND is_active = true"
    )
    row = cur.fetchone()
    if not row:
        log.error("marcus@tp.finance account not found")
        conn.close()
        return False

    account_id = row[0]
    import uuid
    tracking_id = str(uuid.uuid4()).replace('-', '')

    # Get or create marcus contact for contact_id FK
    cur.execute("SELECT id FROM contacts WHERE email = 'marcus@tp.finance' AND tenant = 'tp' LIMIT 1")
    contact_row = cur.fetchone()
    contact_id = contact_row[0] if contact_row else None

    if not contact_id:
        cur.execute("""
            INSERT INTO contacts (email, first_name, last_name, tenant, source, contact_type)
            VALUES ('marcus@tp.finance', 'Marcus', 'Emadi', 'tp', 'internal', 'introducer')
            RETURNING id
        """)
        contact_id = cur.fetchone()[0]

    cur.execute("""
        INSERT INTO email_sends (to_email, from_email, subject, body_html, tracking_id, email_account_id, contact_id, status, tenant, send_type)
        VALUES (%s, %s, %s, %s, %s, %s, %s, 'queued', 'tp', 'internal')
        RETURNING id
    """, [
        REPORT_TO,
        'marcus@tp.finance',
        f'Email Deliverability Report - {score}/10 - {datetime.datetime.now().strftime("%d %b %Y")}',
        html,
        tracking_id,
        account_id,
        contact_id,
    ])
    send_id = cur.fetchone()[0]
    conn.commit()
    conn.close()

    log.info(f"Report queued as email_send {send_id}")
    return True


def main():
    html, score = build_report()
    log.info(f"Deliverability score: {score}/10")

    if '--dry-run' in sys.argv:
        with open('/tmp/deliverability_report.html', 'w') as f:
            f.write(html)
        log.info("Dry run - report saved to /tmp/deliverability_report.html")
        return

    if '--no-email' in sys.argv:
        log.info("Check complete (no email sent)")
        return

    send_report(html, score)
    log.info("Report sent to marcus@tp.finance")


if __name__ == '__main__':
    main()
