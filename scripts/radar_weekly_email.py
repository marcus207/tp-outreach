#!/usr/bin/env python3
"""
Weekly refinancing radar email for Marcus (Monday morning).

  1. Runs scripts/maturity_radar.py (imported) and re-selects the TOP 10 from its
     balanced shortlist: max 3 per asset class, DO NOT CONTACT entries skipped.
     Distress list shown separately (max 5), not for cold approach.
  2. Enriches the 10 with credit data via the existing integration in /root/tp_api_v2
     (creditsafe_browser.fetch_creditsafe_report). Uses a cached creditsafe_reports row
     if < 7 days old; otherwise fetches (rate limited ~10s/company inside the module) in
     a child process with a hard 4 minute total cap. Successful fetches are upserted into
     creditsafe_reports, matching the existing batch scanner's behaviour.
  3. Composes HTML + text email and sends via the Gmail API using the OAuth helpers in
     /root/tp_api_v2/gmail_send.py. There is deliberately NO SMTP/postfix fallback:
     postfix mail from go.tp.finance would fail authentication. Failure is logged.

NAMING RULE: output text never names the credit provider; it is "credit data".
DATA GUARD: targeting uses public Companies House data only (via the radar). Loan Intel
member tables and experian_* are never read.

Usage: python3 scripts/radar_weekly_email.py [--dry-run] [--to addr] [--no-credit]
"""
import argparse
import base64
import datetime as dt
import html
import json
import multiprocessing as mp
import os
import re
import signal
import sys
import time

import psycopg2
import psycopg2.extras

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "reports", "radar")
API_DIR = "/root/tp_api_v2"
DSN = "postgresql://tpca@localhost:5432/tpca_platform"  # password via ~/.pgpass
sys.path.insert(0, HERE)

SENDER = "marcus.emadi@go.tp.finance"
SENDER_NAME = "Refinancing Radar"
DEFAULT_TO = "marcus@tp.finance"
TOP_N, PER_CLASS, DISTRESS_MAX = 10, 3, 5
CREDIT_CAP_S = 240
CACHE_DAYS = 7
CH_LINK = "https://find-and-update.company-information.service.gov.uk/company/{}"

_PROVIDER = re.compile(r"credit\s*safe", re.I)


def scrub(s):
    """Never let the provider name reach any output text."""
    return _PROVIDER.sub("credit data", str(s)).replace("—", ", ").replace("–", "-")


def log(*a):
    print(scrub(" ".join(str(x) for x in a)), flush=True)


# --------------------------------------------------------------------------- selection
def select(radar):
    from maturity_radar import norm
    picked, per, stems, board_sets = [], {}, set(), []
    for c in radar["picked"]:  # already score-ordered and one per parent group
        if c.get("dnc"):
            continue
        toks = norm(c["name"]).split()
        stem = " ".join(toks[:2]) if len(toks) >= 2 and len(toks[0]) >= 3 else None
        if stem and stem in stems:  # sibling SPVs with a shared name stem: show one
            continue
        dirs = {d.split(" (appointed")[0] for d in c.get("directors") or []}
        if any(len(dirs & p) >= 2 for p in board_sets):  # same board = same sponsor group
            continue
        if per.get(c["cls"], 0) >= PER_CLASS:
            continue
        picked.append(c)
        if stem:
            stems.add(stem)
        board_sets.append(dirs)
        per[c["cls"]] = per.get(c["cls"], 0) + 1
        if len(picked) >= TOP_N:
            break
    return picked, radar["distress"][:DISTRESS_MAX]


# --------------------------------------------------------------------------- credit data
def _ddmmyyyy(s):
    if not s:
        return None
    if isinstance(s, (dt.date, dt.datetime)):
        return s if isinstance(s, dt.date) else s.date()
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$", str(s).strip())
    if m:
        d, mth, y = (int(x) for x in m.groups())
        y += 2000 if y < 100 else 0
        try:
            return dt.date(y, mth, d)
        except ValueError:
            return None
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _credit_worker(jobs, queue):
    """Child process: fetch sequentially, push each result. Own process group so the
    parent can kill the browser tree on timeout."""
    try:
        os.setpgrp()
    except Exception:
        pass
    sys.path.insert(0, API_DIR)
    try:
        from creditsafe_browser import fetch_creditsafe_report
    except Exception as e:
        queue.put(("__fatal__", {"error": f"import failed: {e}"}))
        return
    for cn, name in jobs:
        try:
            data = fetch_creditsafe_report(cn, name)
        except Exception as e:
            data = {"error": str(e)}
        queue.put((cn, json.loads(json.dumps(data, default=str))))
    queue.put(("__done__", {}))


def _save(conn, cn, data):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO creditsafe_reports (company_number, creditsafe_id, credit_score, credit_limit,
                ccj_count, ccj_total_value, payment_days, accounts_overdue, company_status,
                incorporation_date, latest_accounts_date, contract_limit, international_score,
                industry_dbt, risk_rating, credit_score_band, raw_report, fetched_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (company_number) DO UPDATE SET
                creditsafe_id=EXCLUDED.creditsafe_id, credit_score=EXCLUDED.credit_score,
                credit_limit=EXCLUDED.credit_limit, ccj_count=EXCLUDED.ccj_count,
                ccj_total_value=EXCLUDED.ccj_total_value, payment_days=EXCLUDED.payment_days,
                accounts_overdue=EXCLUDED.accounts_overdue, company_status=EXCLUDED.company_status,
                incorporation_date=EXCLUDED.incorporation_date,
                latest_accounts_date=EXCLUDED.latest_accounts_date,
                contract_limit=EXCLUDED.contract_limit, international_score=EXCLUDED.international_score,
                industry_dbt=EXCLUDED.industry_dbt, risk_rating=EXCLUDED.risk_rating,
                credit_score_band=EXCLUDED.credit_score_band, raw_report=EXCLUDED.raw_report,
                fetched_at=NOW()""",
            (cn, f"GB-0-{cn}", data.get("credit_score"), data.get("credit_limit"),
             data.get("ccj_count", 0), data.get("ccj_total_value"),
             data.get("payment_days_beyond_terms") or 0, data.get("accounts_overdue", False),
             (data.get("company_status") or None) and str(data["company_status"])[:100],
             _ddmmyyyy(data.get("incorporation_date")), _ddmmyyyy(data.get("last_accounts_date")),
             data.get("contract_limit"), data.get("international_score"), data.get("industry_dbt"),
             data.get("risk_rating"), data.get("credit_score_band"), json.dumps(data)))


def _norm_row(r, source):
    return {"source": source, "score": r.get("credit_score"),
            "band": r.get("credit_score_band") or r.get("risk_rating"),
            "limit": r.get("credit_limit"), "ccj_count": r.get("ccj_count"),
            "ccj_value": r.get("ccj_total_value"),
            "dbt": r.get("payment_days") if "payment_days" in r else r.get("payment_days_beyond_terms"),
            "industry_dbt": r.get("industry_dbt"), "status": r.get("company_status"),
            "inc": _ddmmyyyy(r.get("incorporation_date")),
            "intl": r.get("international_score"), "fetched": r.get("fetched_at")}


def enrich(companies, enabled=True):
    """Returns {company_number: credit dict or None} and a stats dict."""
    stats = {"cached": 0, "fetched": 0, "failed": 0, "skipped_cap": 0}
    out = {c["company_number"]: None for c in companies}
    conn = psycopg2.connect(DSN)
    conn.autocommit = True
    nums = list(out)
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""select company_number, credit_score, credit_score_band, risk_rating,
                              credit_limit, ccj_count, ccj_total_value, payment_days, industry_dbt,
                              company_status, incorporation_date, international_score, fetched_at
                       from creditsafe_reports
                       where company_number = any(%s) and fetched_at > now() - interval '%s days'""",
                    (nums, CACHE_DAYS))
        for r in cur.fetchall():
            out[r["company_number"]] = _norm_row(dict(r), "cached")
            stats["cached"] += 1
    todo = [(c["company_number"], c["name"]) for c in companies if out[c["company_number"]] is None]
    if not enabled or not todo:
        stats["skipped_cap"] = len(todo) if not enabled else 0
        conn.close()
        return out, stats

    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=_credit_worker, args=(todo, queue), daemon=True)
    deadline = time.time() + CREDIT_CAP_S
    proc.start()
    got = set()
    while time.time() < deadline and len(got) < len(todo):
        try:
            cn, data = queue.get(timeout=max(0.5, min(5, deadline - time.time())))
        except Exception:
            if not proc.is_alive():
                break
            continue
        if cn == "__done__":
            break
        if cn == "__fatal__":
            log("credit data: integration unavailable:", data.get("error"))
            break
        got.add(cn)
        if data.get("error") or data.get("credit_score") is None and not data.get("credit_limit"):
            stats["failed"] += 1
            log(f"credit data: {cn} unavailable ({data.get('error') or 'no score parsed'})")
            continue
        try:
            _save(conn, cn, data)
        except Exception as e:
            log(f"credit data: {cn} fetched but not cached ({e})")
        out[cn] = _norm_row(data, "fetched")
        stats["fetched"] += 1
        log(f"credit data: {cn} fetched (score {data.get('credit_score')})")
    if proc.is_alive():
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # child + its browser processes
        except Exception:
            proc.kill()
        proc.join(5)
    stats["skipped_cap"] = len(todo) - len(got)
    if stats["skipped_cap"]:
        log(f"credit data: 4 minute cap reached, {stats['skipped_cap']} not fetched")
    conn.close()
    return out, stats


# --------------------------------------------------------------------------- LinkedIn (Brave)
# Public web search only via the Brave Search API: LinkedIn itself is never scraped or logged
# into. Matches are "likely", never "confirmed". Results cached; queries throttled and capped.
LI_CACHE_DIR = os.path.join(OUT_DIR, "linkedin_cache")
LI_MAX_QUERIES = 40
LI_DIRECTORS = 3
BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
PROPERTY_TERM = re.compile(r"propert|real estate|estates?\b|investment|asset manage|develop|"
                           r"hotel|hospitality|care|living|residential|logistics|capital|"
                           r"fund|REIT|portfolio|director|founder|partner|chief|CEO|CFO", re.I)
GENERIC_TOKENS = {"investments", "investment", "properties", "property", "estates", "estate",
                  "capital", "management", "services", "partners", "international", "global",
                  "living", "care", "healthcare", "hotel", "hotels", "residential", "developments",
                  "london", "britain", "british", "england", "operating", "opco", "topco", "bidco",
                  "midco", "holdco", "investors", "real", "assets", "asset", "fund", "group"}


def _brave_key():
    try:
        for line in open(os.path.join(ROOT, ".env")):
            m = re.match(r"\s*BRAVE_API_KEY\s*=\s*['\"]?([^'\"\s#]+)", line)
            if m:
                return m.group(1)
    except OSError:
        pass
    return os.environ.get("BRAVE_API_KEY") or None


class Brave:
    def __init__(self):
        self.key = _brave_key()
        self.queries = self.cached = self.capped = 0
        self.last = 0.0
        os.makedirs(LI_CACHE_DIR, exist_ok=True)

    def top(self, q):
        """Top web result {title, description, url} or None. Cached indefinitely."""
        import hashlib
        import requests
        fn = os.path.join(LI_CACHE_DIR, hashlib.sha1(q.encode()).hexdigest() + ".json")
        if os.path.exists(fn):
            self.cached += 1
            return json.load(open(fn)).get("top")
        if not self.key:
            return None
        if self.queries >= LI_MAX_QUERIES:
            self.capped += 1
            return None
        for attempt in range(3):
            wait = 1.1 - (time.time() - self.last)  # free tier: 1 query/second
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = requests.get(BRAVE_URL, params={"q": q, "count": 3, "country": "GB",
                                                    "search_lang": "en"},
                                 headers={"Accept": "application/json",
                                          "X-Subscription-Token": self.key}, timeout=15)
            except Exception:
                continue
            if r.status_code == 429:
                time.sleep(2 + attempt * 2)
                continue
            self.queries += 1
            if r.status_code != 200:
                return None
            res = ((r.json().get("web") or {}).get("results") or [])
            top = ({k: res[0].get(k) for k in ("title", "description", "url")} if res else None)
            json.dump({"q": q, "top": top, "at": dt.datetime.now().isoformat()}, open(fn, "w"))
            return top
        return None


def _clean_co(name):
    return re.sub(r"\s*\b(limited|ltd\.?|plc|llp|l\.?p\.?)\s*$", "", (name or "").strip(),
                  flags=re.I).strip(" ,.")


def _tokens(*names):
    from maturity_radar import norm
    out = set()
    for n in names:
        out |= {t for t in norm(n).split() if len(t) >= 4 and t not in GENERIC_TOKENS}
    return out


def _person(d):
    """'SMITH, John Michael (appointed 2021-03-01)' -> ('John Smith', 'smith') or None."""
    nm = d.split(" (appointed")[0]
    if "," not in nm:
        return None  # corporate director
    sur, fore = [x.strip() for x in nm.split(",", 1)]
    first = re.sub(r"^(mr|mrs|ms|miss|dr|sir|lord|lady)\.?\s+", "", fore, flags=re.I).split()
    if not first or not sur:
        return None
    return f"{first[0].title()} {sur.title()}", sur.lower()


def linkedin(companies):
    """Adds c['li_directors'] = {director string: url|None} and c['li_company'] = url|None.
    Returns stats."""
    br = Brave()
    st = {"dir_q": 0, "dir_hit": 0, "co_q": 0, "co_hit": 0, "enabled": bool(br.key)}
    for c in companies:
        parent = next((p for p in c.get("parents") or [] if p), None)
        org = _clean_co(parent or c["name"])
        toks = _tokens(c["name"], *(c.get("parents") or []))
        c["li_directors"] = {}
        for d in (c.get("directors") or [])[:LI_DIRECTORS]:
            p = _person(d)
            if not p:
                continue
            full, sur = p
            st["dir_q"] += 1
            top = br.top(f'"{full}" "{org}" site:linkedin.com/in')
            url = None
            if top and "linkedin.com/in/" in (top.get("url") or ""):
                text = re.sub(r"<[^>]+>", "", f"{top.get('title')} {top.get('description')}")
                low = text.lower()
                # the profile's own name (title before " - " / " | ") must carry the surname and
                # first name, so a relative or colleague mentioned in a snippet never matches
                who = re.split(r"\s[-|–]\s", re.sub(r"<[^>]+>", "", top.get("title") or ""))[0].lower()
                fn = full.split()[0].lower()
                if sur in who and fn in who and (any(t in low for t in toks)
                                                 or PROPERTY_TERM.search(text)):
                    url = top["url"]
            c["li_directors"][d] = url
            st["dir_hit"] += bool(url)
        st["co_q"] += 1
        top = br.top(f'"{org}" site:linkedin.com/company')
        url = None
        if top and "linkedin.com/company/" in (top.get("url") or ""):
            text = re.sub(r"<[^>]+>", "", f"{top.get('title')} {top.get('description')} {top.get('url')}")
            low = text.lower()
            if any(t in low for t in _tokens(org)):
                url = top["url"]
        c["li_company"] = url
        c["li_company_org"] = org
        st["co_hit"] += bool(url)
    st.update(queries=br.queries, cached=br.cached, capped=br.capped)
    return st


# --------------------------------------------------------------------------- Apollo (work email)
# people/match for the final candidates' active directors only. Work email only: the reveal
# flags for personal emails / phone numbers are never set. Results are display-only and are
# never written to tp contacts or any sequence.
APOLLO_URL = "https://api.apollo.io/api/v1/people/match"
APOLLO_CACHE_DIR = os.path.join(OUT_DIR, "apollo_cache")
APOLLO_MAX_CALLS = 30
APOLLO_CACHE_DAYS = 90
FREE_MAIL = re.compile(r"gmail|hotmail|outlook|yahoo|icloud|aol|btinternet|live\.|me\.com|"
                       r"googlemail|msn|sky\.com|virginmedia|talktalk|protonmail")


def _env_key(name):
    try:
        for line in open(os.path.join(ROOT, ".env")):
            m = re.match(r"\s*%s\s*=\s*['\"]?([^'\"\s#]+)" % name, line)
            if m:
                return m.group(1)
    except OSError:
        pass
    return os.environ.get(name) or None


def apollo(companies):
    """Adds c['apollo'] = {director string: {email, status, title} | None}. Returns stats."""
    import hashlib
    import requests
    key = _env_key("APOLLO_API_KEY")
    st = {"people": 0, "calls": 0, "cached": 0, "capped": 0, "matched": 0, "email": 0,
          "verified": 0, "errors": 0, "enabled": bool(key)}
    os.makedirs(APOLLO_CACHE_DIR, exist_ok=True)
    for c in companies:
        org = c.get("li_company_org") or _clean_co(
            next((p for p in c.get("parents") or [] if p), None) or c["name"])
        dom = next((x["email"].split("@")[-1].lower() for x in c.get("contacts") or []
                    if "@" in x["email"] and not FREE_MAIL.search(x["email"].split("@")[-1])
                    and x["how"] != "possible (first words of SPV)"), None)
        c["apollo"] = {}
        for d in (c.get("directors") or [])[:LI_DIRECTORS]:
            p = _person(d)
            if not p:
                continue
            full, _ = p
            first, last = full.split(" ", 1)
            st["people"] += 1
            ck = hashlib.sha1(f"{full.lower()}|{org.lower()}".encode()).hexdigest()
            fn = os.path.join(APOLLO_CACHE_DIR, ck + ".json")
            if os.path.exists(fn) and time.time() - os.path.getmtime(fn) < APOLLO_CACHE_DAYS * 86400:
                st["cached"] += 1
                res = json.load(open(fn)).get("result")
            elif not key:
                continue
            elif st["calls"] >= APOLLO_MAX_CALLS:
                st["capped"] += 1
                continue
            else:
                body = {"first_name": first, "last_name": last, "organization_name": org}
                if dom:
                    body["domain"] = dom
                li = (c.get("li_directors") or {}).get(d)
                if li:
                    body["linkedin_url"] = li
                try:
                    r = requests.post(APOLLO_URL, json=body, timeout=30,
                                      headers={"X-Api-Key": key, "Content-Type": "application/json",
                                               "Cache-Control": "no-cache"})
                    st["calls"] += 1
                    time.sleep(0.5)
                except Exception:
                    st["errors"] += 1
                    continue
                if r.status_code != 200:
                    st["errors"] += 1
                    log(f"apollo: HTTP {r.status_code} for a director of {c['company_number']}"
                        + (f" ({r.json().get('error_code')})" if r.headers.get("content-type", "")
                           .startswith("application/json") else ""))
                    if r.status_code in (401, 403):  # key lacks scope: stop, don't retry per person
                        key = None
                    continue
                pp = r.json().get("person") or {}
                res = ({"email": pp.get("email"), "status": pp.get("email_status"),
                        "title": pp.get("title"),
                        "org": (pp.get("organization") or {}).get("name")} if pp else None)
                json.dump({"query": body, "result": res, "at": dt.datetime.now().isoformat()},
                          open(fn, "w"))
            c["apollo"][d] = res
            if res:
                st["matched"] += 1
                if res.get("email") and "email_not_unlocked" not in res["email"]:
                    st["email"] += 1
                    st["verified"] += res.get("status") == "verified"
    return st


def director_bits(c, d):
    """Plain-text extras for one director line: LinkedIn + Apollo email/title."""
    bits = []
    li = (c.get("li_directors") or {}).get(d, "n/a")
    if li and li != "n/a":
        bits.append("LinkedIn (likely)")
    elif d in (c.get("li_directors") or {}):
        bits.append("LinkedIn not found")
    ap = (c.get("apollo") or {}).get(d)
    if ap:
        if ap.get("title"):
            bits.append(f"title: {ap['title']}")
        em = ap.get("email")
        if em and "email_not_unlocked" not in em:
            bits.append(f"{em} ({ap.get('status') or 'unknown'})" if ap.get("status") == "verified"
                        else f"{em} ({ap.get('status') or 'unknown'}; unverified, do not use)")
        else:
            bits.append("no work email")
    elif d in (c.get("apollo") or {}):
        bits.append("no Apollo match")
    return bits


# --------------------------------------------------------------------------- formatting
def e(s):
    return html.escape(scrub(s if s is not None else ""))


def money(v):
    if v is None or v == "":
        return "-"
    v = float(v)
    if v >= 1e6:
        return f"£{v / 1e6:.1f}m"
    if v >= 1e3:
        return f"£{v / 1e3:,.0f}k"
    return f"£{v:,.0f}"


def fmt_date(d):
    return d.strftime("%-d %b %Y") if d else "-"


def credit_lines(cr, inc_fallback=None):
    if not cr:
        return ["Credit data unavailable"]
    ccj = cr["ccj_count"] or 0
    dbt = cr["dbt"]
    if cr["source"] == "cached" and not dbt and cr.get("industry_dbt") is None:
        dbt = None  # stored 0 = not reported
    return [
        f"Score: {cr['score'] if cr['score'] is not None else '-'}"
        + (f" ({cr['band']})" if cr["band"] else ""),
        f"Credit limit: {money(cr['limit'])}",
        f"CCJs: {ccj}" + (f", value {money(cr['ccj_value'])}" if ccj and cr["ccj_value"] else ""),
        "Payment days (DBT): " + (str(dbt) if dbt is not None else "-")
        + (f" (industry {cr['industry_dbt']})" if cr.get("industry_dbt") is not None else ""),
        f"Status: {cr['status'] or '-'}",
        f"Incorporated: {fmt_date(cr['inc'] or inc_fallback)}",
        f"International score: {cr['intl'] or '-'}",
    ]


def card_fields(c, radar, allow_check):
    mo = radar["months_old"]
    dates = c["dates"]
    shown = ", ".join(f"{d} ({mo(d)} months old)" for d in dates[:6]) + (" ..." if len(dates) > 6 else "")
    lenders = "; ".join(l + (" (check)" if l in allow_check else "") for l in c["lenders"])
    parent = "; ".join(c.get("parents") or []) or "(no corporate PSC)"
    if c.get("psc_people"):
        parent += " | individuals: " + "; ".join(c["psc_people"])
    from maturity_radar import property_line, debt_line
    pi, di = c.get("prop"), c.get("debt")
    prop_link = pi and (pi.get("deed_link") or pi.get("charges_link"))
    debt_link = di and di.get("debt") is None and di.get("link")
    # directors: one line each with LinkedIn (likely) link and Apollo title / work email
    t_lines, h_lines = [], []
    for d in c.get("directors") or []:
        bits = director_bits(c, d)
        li = (c.get("li_directors") or {}).get(d)
        t_lines.append(d + "".join(f" · {b}" for b in bits) + (f" [{li}]" if li else ""))
        hb = []
        for b in bits:
            hb.append(f'<a href="{html.escape(li)}" style="color:#1f3a5f">LinkedIn</a> (likely)'
                      if b == "LinkedIn (likely)" else e(b))
        h_lines.append(e(d) + "".join(f" &middot; {x}" for x in hb))
    dir_text = "; ".join(t_lines) or "-"
    dir_html = "<br>".join(h_lines) or "-"
    co_li_text = (f"({c.get('li_company_org')}) (likely)" if c.get("li_company") else
                  "not found" if "li_company" in c else "not checked")
    contacts = "; ".join(f"{x['name'] or '(no name)'} <{x['email']}>" for x in c["contacts"][:3]) \
        or "No contact held"
    if len(c["contacts"]) > 3:
        contacts += f" (+{len(c['contacts']) - 3} more)"
    ev = ", ".join(c["evidence"][:4]) or "-"
    if c.get("sic_note"):
        ev += "; " + c["sic_note"]
    return [
        *asset_fields(c),
        ("Parent / PSC", parent),
        ("Asset class", f"{c['cls']} ({ev})"),
        ("Charges", f"{c['n']} in window, {c['n_total']} outstanding in total; {shown}"),
        ("Lender(s)", lenders),
        ("Property charged", property_line(pi, with_link=False), prop_link,
         "charge deed" if pi and pi.get("deed_link") else "charges"),
        ("Accounts", (c.get("acc_type") or "none filed") + (" (overdue)" if c.get("acc_overdue") else "")
         + (f", made up to {fmt_date(_ddmmyyyy(di['made_up']))}" if di and di.get("made_up") else "")),
        ("Directors", dir_text, None, None, dir_html),
        ("Company LinkedIn", co_li_text, c.get("li_company"), "LinkedIn"),
        ("Existing contact", contacts),
    ]


def build(radar, top, distress, credit, wc):
    why = radar["why"]
    subject = f"Refinancing radar: {len(top)} for w/c {fmt_date(wc)}"
    intro = (f"{len(top)} sponsors whose facilities are likely in their refinancing window. "
             "Reply with the numbers you'd like approached and I'll draft a personal note for each.")
    method = ("Method: public Companies House charges reaching their 5-year anniversary in the "
              "next 3 months, still outstanding, with lenders on our £10m+ allowlist; target asset "
              "classes only (schools: SEN-specific only); maturity is inferred from charge age, "
              "not known. '(check)' marks a lender on the allowlist pending "
              "verification. Debt is estimated from tagged values in the latest filed "
              "accounts on Companies House (bank borrowings preferred, else creditors due after one "
              "year, labelled); candidates whose accounts show under £10m are excluded, and PDF-only "
              "accounts are shown as not available. Property charged is taken from the charge "
              "particulars; where the charge is an all-assets debenture the property is not stated. "
              "LinkedIn links come from public web search "
              "and are marked likely, not confirmed. Director work emails are from Apollo: only "
              "'verified' emails are usable; nothing here is added to contacts or sequences. "
              "Credit data cached up to 7 days. Directors' names are personal data: "
              "internal use only.")
    td = 'style="padding:3px 10px 3px 0;vertical-align:top;color:#555;white-space:nowrap;font-size:13px"'
    tv = 'style="padding:3px 0;vertical-align:top;font-size:13px"'
    H = ['<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f2">',
         '<div style="max-width:720px;margin:0 auto;padding:20px;font-family:Georgia,serif;color:#1a1a1a">',
         f'<h1 style="font-size:22px;font-weight:normal;margin:0 0 6px">Refinancing radar, w/c {e(fmt_date(wc))}</h1>',
         f'<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;margin:0 0 18px">{e(intro)}</p>']
    T = [subject, "", intro, ""]
    for i, c in enumerate(top, 1):
        cn = c["company_number"]
        allow_check = {r["lname"] for r in c["charges"] if r["allow"] and r["allow"][1]}
        fields = card_fields(c, radar, allow_check)
        H.append('<div style="background:#fff;border:1px solid #ddd;padding:14px 16px;margin:0 0 14px;'
                 'font-family:Arial,sans-serif">')
        H.append(f'<div style="font-family:Georgia,serif;font-size:17px;margin:0 0 2px">'
                 f'{i}. {e(c["name"])}</div>')
        H.append(f'<div style="font-size:12px;color:#555;margin:0 0 10px">{e(cn)} &middot; '
                 f'<a href="{CH_LINK.format(cn)}" style="color:#1f3a5f">Companies House</a></div>')
        H.append(f'<table style="border-collapse:collapse;width:100%">')
        for k, v, *lk in fields:
            if len(lk) >= 3 and lk[2]:  # pre-built, already-escaped HTML
                H.append(f"<tr><td {td}>{e(k)}</td><td {tv}>{lk[2]}</td></tr>")
                continue
            link = f' <a href="{html.escape(lk[0])}" style="color:#1f3a5f">[{e(lk[1])}]</a>' \
                if lk and lk[0] else ""
            H.append(f"<tr><td {td}>{e(k)}</td><td {tv}>{e(v)}{link}</td></tr>")
        cl = credit_lines(credit.get(cn), _ddmmyyyy((c.get("profile") or {}).get("date_of_creation")))
        H.append(f"<tr><td {td}>Credit data</td><td {tv}>{'<br>'.join(e(x) for x in cl)}</td></tr>")
        H.append(f'<tr><td {td}><b>Why now</b></td><td {tv}><b>{e(why(c))}</b></td></tr>')
        H.append("</table></div>")
        T += [f"{i}. {c['name']} ({cn})", f"   {CH_LINK.format(cn)}"]
        T += [f"   {k}: {v}" + (f" [{lk[0]}]" if lk and lk[0] else "") for k, v, *lk in fields]
        T += ["   Credit data: " + " | ".join(cl), f"   Why now: {why(c)}", ""]
    H.append('<h2 style="font-size:16px;font-weight:normal;margin:22px 0 6px">'
             'Distress / not for cold approach</h2>')
    H.append('<ul style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;margin:0 0 18px;padding-left:18px">')
    T.append("Distress / not for cold approach")
    for c in distress:
        line = (f"{c['name']} ({c['company_number']}): status {c['status']}"
                f"{', insolvency history' if c.get('insolv') else ''}; {c['n']} window charge(s) "
                f"with {'; '.join(c['lenders'][:3])}")
        H.append(f"<li>{e(line)}</li>")
        T.append(f" - {line}")
    if not distress:
        H.append("<li>None this week</li>")
        T.append(" - None this week")
    H.append(f'<p style="font-family:Arial,sans-serif;font-size:11px;color:#666;line-height:1.5;'
             f'border-top:1px solid #ccc;padding-top:10px">{e(method)}</p></div></body></html>')
    T += ["", method]
    return scrub(subject), scrub("\n".join(H)), scrub("\n".join(T))


# --------------------------------------------------------------------------- send
def send(to, subject, html_body, text_body):
    """Gmail API only, no SMTP fallback. Returns the Gmail message id."""
    sys.path.insert(0, API_DIR)
    import gmail_send as gs
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GoogleRequest
    from googleapiclient.discovery import build as gbuild

    cid, csec = gs._load_oauth_client()
    rt = gs._get_refresh_token(SENDER)
    if not (cid and csec and rt):
        raise RuntimeError("missing OAuth client or refresh token for sender")
    # scopes=None: refresh with the scopes originally granted (gmail.modify covers send)
    creds = Credentials(token=None, refresh_token=rt, token_uri="https://oauth2.googleapis.com/token",
                        client_id=cid, client_secret=csec)
    creds.refresh(GoogleRequest())
    msg = gs._build_message(SENDER, SENDER_NAME, to, subject, html_body, text_body)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    svc = gbuild("gmail", "v1", credentials=creds, cache_discovery=False)
    res = svc.users().messages().send(userId="me", body={"raw": raw}).execute()
    return res.get("id")


# --------------------------------------------------------------------------- asset profile
_PC = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b", re.I)


def asset_profiles(top):
    """What each charged asset is and how big (beds / rooms / units / sq ft), via
    scripts/asset_profile.py. Never raises; a failed profile shows as unknown."""
    st = {"ok": 0, "errors": 0}
    try:
        from asset_profile import build_asset_profile
    except Exception as ex:
        log(f"asset profile unavailable: {type(ex).__name__}")
        st["errors"] = len(top)
        return st
    for c in top:
        pi = c.get("prop") or {}
        addr = None if pi.get("generic") else pi.get("address")
        m = _PC.search(addr or "")
        pc, ro = (m.group(1).upper(), False) if m else (pi.get("ro_postcode") or c.get("postcode"), True)
        try:
            c["asset"] = build_asset_profile(addr, pc, c["company_number"], c.get("name") or "",
                                             c.get("cls") or "", postcode_is_registered_office=ro)
            cap = (c["asset"].get("capacity") or {})
            if cap.get("value") not in (None, "unknown"):
                st["ok"] += 1
        except Exception as ex:
            c["asset"] = None
            st["errors"] += 1
            log(f"asset profile failed for {c['company_number']}: {type(ex).__name__}")
    return st


def asset_fields(c):
    """Compact asset block: only lines we actually know. A missing asset is one line."""
    a = c.get("asset") or {}
    pi = c.get("prop") or {}
    cap = a.get("capacity") or {}
    known_cap = cap.get("value") not in (None, "unknown")
    names = [x for x in (a.get("brand"), a.get("operator")) if x and x != "unknown"]
    names = list(dict.fromkeys(names))
    if not known_cap and not names and pi.get("generic"):
        return [("The asset", "Not identified yet: the charge is a general debenture with no "
                              "property address (Land Registry ownership data will fill this in)")]
    out = []
    if a.get("summary") and (known_cap or names or not pi.get("generic")):
        out.append(("The asset", a["summary"]))
    if known_cap:
        out.append(("Capacity", f"{cap.get('value')} {cap.get('metric') or ''}".strip()
                    + (f" (source: {cap['source']})" if cap.get("source") else "")))
    if names:
        star = a.get("star_rating")
        star = None if not star or str(star).lower() == "unknown" else star
        star = f"{star}-star" if star and str(star).isdigit() else star
        out.append(("Brand / operator", " / ".join(names) + (f", {star}" if star else "")))
    fa = a.get("floor_area")
    if isinstance(fa, dict) and fa.get("sqft"):
        out.append(("Floor area", f"{fa['sqft']:,} sq ft"))
    epc = a.get("epc")
    epc = (epc.get("rating") if isinstance(epc, dict) else epc)
    if epc and epc != "unknown":
        out.append(("EPC", str(epc)))
    return out


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--to", default=DEFAULT_TO)
    ap.add_argument("--no-credit", action="store_true", help="skip live credit fetches (cache only)")
    a = ap.parse_args()
    t0 = time.time()
    log(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] radar weekly email start")

    import maturity_radar
    radar = maturity_radar.main([])
    top, distress = select(radar)
    log(f"selected {len(top)} (distress shown {len(distress)})")
    ast = radar.get("acc_stats", {})
    log(f"debt from accounts: figure {ast.get('with_figure', 0)}, PDF only {ast.get('pdf', 0)}, "
        f"excluded: under £10m {len(radar.get('debt_excluded', []))}")
    log("property charged in top %d: address %d, not stated %d" % (
        len(top), sum(1 for c in top if not c["prop"]["generic"]),
        sum(1 for c in top if c["prop"]["generic"])))

    li = linkedin(top)
    log(f"linkedin (search, likely only): directors {li['dir_hit']}/{li['dir_q']}, companies "
        f"{li['co_hit']}/{li['co_q']}; queries {li['queries']}, cached {li['cached']}, "
        f"capped {li['capped']}" + ("" if li["enabled"] else " (no search key)"))
    ap = apollo(top)
    log(f"apollo work email: people {ap['people']}, credits used (match calls) {ap['calls']}, "
        f"cached {ap['cached']}, capped {ap['capped']}, matched {ap['matched']}, with email "
        f"{ap['email']}, verified {ap['verified']}, errors {ap['errors']}"
        + ("" if ap["enabled"] else " (no API key)"))

    prof = asset_profiles(top)
    log(f"asset profiles: {prof['ok']}/{len(top)} with capacity, errors {prof['errors']}")

    credit, st = enrich(top, enabled=not a.no_credit)
    log(f"credit data: cached {st['cached']}, fetched {st['fetched']}, failed {st['failed']}, "
        f"not reached (cap) {st['skipped_cap']}")

    run = radar["run"]
    wc = run - dt.timedelta(days=run.weekday())
    subject, html_body, text_body = build(radar, top, distress, credit, wc)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"email-{run}.html")
    open(path, "w").write(html_body)
    log(f"wrote {path}")

    if a.dry_run:
        log("dry run: not sent")
        return 0
    try:
        mid = send(a.to, subject, html_body, text_body)
    except Exception as ex:
        log(f"SEND FAILED via Gmail API ({type(ex).__name__}: {ex}); no fallback used")
        return 1
    log(f"sent '{subject}' from {SENDER} to {a.to}; Gmail message id {mid}; {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
