#!/usr/bin/env python3
"""
DISTRESSED section of the Refinancing Radar (Turning Point Capital Advisory).

Distressed sponsors with property debt are opportunities (rescue refinance, or a sale of the asset
to fund clients via the desk). The approach is to the insolvency practitioner / receiver once one is
appointed, never to the directors.

Universe: same base filters as the radar (outstanding charges, institution/trustee lenders, minus
BTL/residential lenders, minus housebuilder counterparties, minus finance borrowers, target asset
classes, size score from radar_size.py) but a WIDER charge age window: 24-72 months (configurable),
because distress isn't tied to the 5-year point.

Signals (each with a date and a source link):
  FORMAL   Companies House company_status administration / liquidation / receivership /
           voluntary-arrangement / insolvency-proceedings; CH insolvency cases with practitioners;
           The Gazette notices (administrator / liquidator appointments, winding-up petitions and
           orders, notices of intended dividends); compulsory strike-off (CH GAZ1 filing).
  RECEIVER CH receiver cases (receiver-manager / LPA / administrative receiver) and RM01 filings;
           receiver names from CH, firm from the receiver's own Gazette notices where found.
  SOFT     accounts / confirmation statement overdue; CCJs or a very low score from credit data
           (cache only here); >= 2 director resignations in 6 months; a bridging/rescue-lender charge
           in the last 12 months on top of an older senior charge; auditor resignation filings.
Tiers: "In insolvency (approach the IP)", "Receiver appointed", "Early warning".

Sources and how they are reached (public only):
  * charges / spv_companies / lender_classifications via maturity_radar.q (allowlist + READ ONLY)
  * CH REST API via maturity_radar.CH (same keys, 6-day cache), incl. /advanced-search/companies
    for every company currently in a distress status (cheap, universe-wide intersection)
  * The Gazette public notice feed (JSON), selected corporate insolvency notice codes, month by
    month, 1 request/second, cached (past months kept, current month refreshed daily)
  * credit data: creditsafe_reports cache rows only (never fetched from here; the email script
    does capped live fetches for the shortlisted cards). Output says "credit data", never the provider.
Never reads Loan Intel member tables (loan_book, loan_data) or experian_*.

Usage (standalone check): python3 scripts/radar_distress.py [--date YYYY-MM-DD] [--min-months 24]
                                                            [--max-months 72] [--no-gazette]
"""
import argparse
import calendar
import datetime as dt
import hashlib
import json
import os
import re
import sys
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

import psycopg2
import psycopg2.extras
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import maturity_radar as mr  # noqa: E402
from radar_size import band_rank, lender_category, score_size  # noqa: E402

ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "reports", "radar")
GAZ_CACHE = os.path.join(OUT_DIR, "gazette_cache")
DSN = mr.DSN

# --------------------------------------------------------------------------- configuration
MIN_MONTHS, MAX_MONTHS = 24, 72          # charge age window (months) for the distress universe
GAZETTE_LOOKBACK_MONTHS = 12             # Gazette notices considered
SOFT_POOL = 400                          # top classified universe companies (size proxy) profile-checked
RESCUE_MONTHS = 12                       # bridging/rescue charge registered within this many months
RESIGN_DAYS, RESIGN_MIN = 183, 2         # >= 2 director resignations in the last 6 months
CREDIT_LOW_SCORE = 20                    # credit data score at or below = "very low"
CREDIT_SIGNAL_DAYS = 90                  # cached credit rows younger than this count as a signal
STALE_CASE_MONTHS = 36                   # insolvency appointments older than this rank lower
EXCLUDE_UNLIKELY = True                  # same as the main radar: Unlikely size band not listed
CH_WORKERS = 6

CH_SITE = "https://find-and-update.company-information.service.gov.uk"
CH_LINK = CH_SITE + "/company/{}"
GAZ_BASE = "https://www.thegazette.co.uk"
GAZ_UA = "TPCA-Radar/1.0 (+https://www.tp.finance; weekly research, low volume)"

# Gazette corporate insolvency notice codes. Members' voluntary liquidation codes (2431-2435) are
# solvent wind-ups and deliberately left out.
GAZ_CODES = {
    2410: ("administration", "Appointment of administrators"),
    2411: ("administration", "Administration order"),
    2421: ("receiver", "Appointment of administrative receivers"),
    2443: ("liquidation", "Appointment of liquidators (creditors' voluntary)"),
    2450: ("petition", "Winding-up petition"),
    2452: ("liquidation", "Winding-up order"),
    2454: ("liquidation", "Appointment of liquidators (compulsory)"),
    2406: ("dividend", "Notice of intended dividends"),
    2461: ("dismissed", "Dismissal of winding-up petition"),
}
APPOINTMENT_CODES = {2410, 2411, 2421, 2443, 2452, 2454}

FORMAL_STATUS = {"administration", "liquidation", "voluntary-arrangement", "insolvency-proceedings"}
RECEIVER_STATUS = {"receivership"}
STATUS_LABEL = {"administration": "In administration", "liquidation": "In liquidation",
                "voluntary-arrangement": "Company voluntary arrangement",
                "insolvency-proceedings": "Insolvency proceedings", "receivership": "Receiver action"}
RECEIVER_CASES = re.compile(r"receiv", re.I)
SOLVENT_CASES = {"members-voluntary-liquidation"}
CASE_LABEL = {"in-administration": "Administration", "administration-order": "Administration",
              "creditors-voluntary-liquidation": "Creditors' voluntary liquidation",
              "compulsory-liquidation": "Compulsory liquidation",
              "corporate-voluntary-arrangement": "Company voluntary arrangement",
              "receiver-manager": "Receiver/manager", "administrative-receiver": "Administrative receiver",
              "receivership": "Receivership", "moratorium": "Moratorium"}
ROLE_LABEL = {"receiver-manager": "Receiver/manager", "receiver": "Receiver",
              "administrative-receiver": "Administrative receiver", "practitioner": "Practitioner",
              "proposed-liquidator": "Proposed liquidator", "provisional-liquidator": "Provisional liquidator",
              "final-liquidator": "Liquidator", "appointed-liquidator": "Liquidator",
              "administrator": "Administrator", "supervisor": "Supervisor (CVA)"}

# Status searches (advanced search, universe-wide). Liquidation is too big to pull whole (100k+),
# so it is pulled by SIC code (each < 10k results), covering property / target-class SICs.
ADV_FULL = ["administration", "receivership", "voluntary-arrangement", "insolvency-proceedings"]
LIQ_SICS = ["68100", "68201", "68209", "68310", "68320", "55100", "55201", "55202", "55209", "55300",
            "55900", "87100", "87200", "87300", "87900", "85200", "85310", "85590", "52101", "52102",
            "52103", "52109", "41100", "41201", "41202", "64209", "70100", "56101", "56302", "93110",
            "93130"]

# Bridging / rescue / short-term lenders: a charge from one of these in the last RESCUE_MONTHS on top
# of an older senior charge is a top-up / rescue signal. EDITABLE. Case-insensitive regex fragments.
RESCUE_LENDERS = re.compile(
    r"together (commercial|personal|money)|blemain|harpmanor|\bmt finance\b|market financial solutions|"
    r"\bmfs\b|masthaven|\bglenhawk\b|\bavamore\b|hope capital|\bmsp capital\b|castle trust|"
    r"\broma (finance|capital)\b|\bromaco\b|\blendinvest\b|\bkuflink\b|\bproplend\b|crowdproperty|"
    r"folk2folk|\bassetz\b|\bsomo\b|bridgeco|black (and|&) white bridging|spring finance|"
    r"\bfiduciam\b|\bsancus\b|\bmaslow\b|\btuscan capital\b|\bprecede\b|\bpluto\b|\bortus\b|"
    r"\balchemy\b|\bhilco\b|\bwellesley\b|\bpuma (property|capital)\b|\bdowning\b|\batelier\b|"
    r"\bcording\b|\bpaloma\b|\bblackfinch\b|ask partners|\bsecure trust\b|\bvaluemax\b|"
    r"\bzorin\b|\bfundingsecure\b|\blendy\b|\binvest (and|&) fund\b|\bsdka\b|\btab\b|"
    r"\bsilver ?arrow\b|\bbridging\b|short term finance|\bgsquare\b|\bmagnet capital\b|"
    r"\bfinancial ?(and|&)? ?general\b|\bascot lloyd\b|ashen capital", re.I)

TIER_KEYS = ["insolvency", "receiver", "early"]
TIER_LABEL = {"insolvency": "In insolvency (approach the IP)", "receiver": "Receiver appointed",
              "early": "Early warning"}
_PROVIDER = re.compile(r"credit\s*safe", re.I)


def log(*a):
    print(_PROVIDER.sub("credit data", " ".join(str(x) for x in a)), flush=True)


def _d(s):
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def fmt(d):
    d = _d(d) if not isinstance(d, dt.date) else d
    return d.strftime("%-d %b %Y") if d else "?"


def mon(d):
    d = _d(d) if not isinstance(d, dt.date) else d
    return d.strftime("%b %Y") if d else "?"


def months_since(d, run):
    d = _d(d)
    return mr.months_between(d, run) if d else None


def cn8(x):
    x = re.sub(r"\s", "", (x or "").upper())
    return x.zfill(8) if x.isdigit() else x


# --------------------------------------------------------------------------- Gazette
class Gazette:
    """Public notice feed client: JSON search, 1 req/s, cached. Never raises; tracks failures."""

    def __init__(self, run):
        self.run = run
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": GAZ_UA, "Accept": "application/json"})
        self.last = 0.0
        self.fetched = self.cached = self.failed = 0
        self.errors = Counter()
        os.makedirs(GAZ_CACHE, exist_ok=True)

    def _get(self, url, params, ttl_days, accept="application/json"):
        key = hashlib.sha1((url + json.dumps(params, sort_keys=True)).encode()).hexdigest()
        fn = os.path.join(GAZ_CACHE, key + ".json")
        if os.path.exists(fn) and (ttl_days is None or time.time() - os.path.getmtime(fn) < ttl_days * 86400):
            self.cached += 1
            return json.load(open(fn))
        for attempt in range(4):
            wait = 1.0 - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = self.s.get(url, params=params, timeout=40, headers={"Accept": accept})
            except requests.RequestException as e:
                self.errors[type(e).__name__] += 1
                time.sleep(2 + 2 * attempt)
                continue
            if r.status_code in (429, 503):
                self.errors[f"HTTP {r.status_code}"] += 1
                time.sleep(5 + 5 * attempt)
                continue
            if r.status_code != 200:
                self.errors[f"HTTP {r.status_code}"] += 1
                self.failed += 1
                return None
            try:
                data = r.json()
            except ValueError:
                self.errors["non-JSON"] += 1
                self.failed += 1
                return None
            self.fetched += 1
            json.dump(data, open(fn, "w"))
            return data
        self.failed += 1
        return None

    def month_notices(self, code, y, m):
        """All notices of one code published in one calendar month (paged, 100 per page)."""
        first = dt.date(y, m, 1)
        last = dt.date(y, m, calendar.monthrange(y, m)[1])
        current = last >= self.run - dt.timedelta(days=3)
        ttl = 1 if current else None  # closed months never change
        out, page = [], 1
        while True:
            d = self._get(GAZ_BASE + "/all-notices/notice/data.json",
                          {"noticetypes": code, "start-publish-date": first.isoformat(),
                           "end-publish-date": min(last, self.run).isoformat(),
                           "results-page-size": 100, "results-page": page}, ttl)
            if not d:
                break
            ents = d.get("entry") or []
            if isinstance(ents, dict):
                ents = [ents]
            out += ents
            total = int(d.get("f:total") or 0)
            if page * 100 >= total or not ents:
                break
            page += 1
        return out

    def notices(self, lookback_months):
        """Parsed notices for GAZ_CODES over the lookback, newest month first."""
        res = []
        for back in range(lookback_months + 1):
            y, m0 = divmod((self.run.year * 12 + self.run.month - 1) - back, 12)
            for code in GAZ_CODES:
                for e in self.month_notices(code, y, m0 + 1):
                    res.append(parse_entry(e, code))
        return [r for r in res if r]

    def notice_detail(self, nid):
        """Structured notice (JSON-LD): practitioner name/firm/address, appointment date, petitioner."""
        d = self._get(f"{GAZ_BASE}/notice/{nid}/data.jsonld", {}, None, accept="application/ld+json")
        if not d:
            return {}
        g = d.get("@graph") or []
        by_id = {x.get("@id"): x for x in g if isinstance(x, dict)}
        out = {"ips": [], "appointed": None, "petitioner": None, "petition_date": None, "hearing": None}
        for x in g:
            if not isinstance(x, dict):
                continue
            t = x.get("@type")
            t = " ".join(t) if isinstance(t, list) else str(t or "")
            if "foaf:Agent" in t and (x.get("hasIPnum") or x.get("foaf:name")):
                firm = by_id.get(x.get("hasOrganisationMember")) or {}
                adr = by_id.get(x.get("adr")) or {}
                def one(v):
                    return (v[0] if v else None) if isinstance(v, list) else v
                out["ips"].append({"name": one(x.get("foaf:name")) or " ".join(
                    filter(None, [one(x.get("firstName")), one(x.get("familyName"))])),
                    "firm": one(firm.get("name")), "address": one(adr.get("label")),
                    "ipnum": one(x.get("hasIPnum"))})
            for k, v in x.items():
                lk = k.split(":")[-1]
                if lk == "dateOfAppointment" and not out["appointed"]:
                    out["appointed"] = str(v)[:10]
                elif lk in ("dateOfPresentation", "petitionDate") and not out["petition_date"]:
                    out["petition_date"] = str(v)[:10]
                elif lk in ("dateOfHearing", "hearingDate") and not out["hearing"]:
                    out["hearing"] = str(v)[:10]
            if "Petitioner" in t or "petitioner" in (x.get("@id") or "").lower():
                nm = x.get("name") or x.get("foaf:name") or x.get("organisationName")
                if nm and not out["petitioner"]:
                    out["petitioner"] = nm
        return out

    def ip_firm(self, name):
        """Firm an IP/receiver used on their most recent Gazette notice (or None)."""
        def fl(n):
            t = re.sub(r"[^a-z ]", " ", (n or "").lower()).split()
            return (t[0], t[-1]) if t else None
        want = fl(name)
        d = self._get(GAZ_BASE + "/insolvency/notice/data.json",
                      {"text": f'"{name}"', "results-page-size": 10, "sort-by": "latest-date"}, 30)
        for e in ((d or {}).get("entry") or [])[:6]:
            nid = (e.get("id") or "").rstrip("/").split("/")[-1]
            if not nid.isdigit():
                continue
            for ip in self.notice_detail(nid).get("ips") or []:
                if ip.get("firm") and fl(ip.get("name")) == want:
                    return ip["firm"], f"{GAZ_BASE}/notice/{nid}"
        return None, None


# number must be followed by a space / bracket / punctuation: feed content is truncated with an
# ellipsis, and a cut-off number ("146823...") must not be read as a different company
_CN_RX = re.compile(r"(?:Company|Registered)\s*(?:Number|No\.?)\s*:?\s*\(?\s*((?:SC|NI|OC|SO|NC|R0)?\d{5,8})(?=[\s),;.])", re.I)


def parse_entry(e, code):
    nid = (e.get("id") or "").rstrip("/").split("/")[-1]
    if not nid.isdigit():
        return None
    content = re.sub(r"<[^>]+>", " ", e.get("content") or "")
    m = _CN_RX.search(content)
    return {"id": nid, "code": code, "kind": GAZ_CODES[code][0], "label": GAZ_CODES[code][1],
            "published": (e.get("published") or "")[:10], "title": (e.get("title") or "").strip(),
            "cn": cn8(m.group(1)) if m else None,
            "url": f"{GAZ_BASE}/notice/{nid}"}


# --------------------------------------------------------------------------- CH helpers
def threaded_ch(ch):
    """Make the shared CH client safe to use from a small thread pool (key rotation under a lock)."""
    lock = threading.Lock()
    orig = ch._key

    def _key():
        with lock:
            return orig()
    ch._key = _key
    return ch


def prefetch(ch, paths, workers=CH_WORKERS):
    paths = list(dict.fromkeys(paths))
    if not paths:
        return
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(ch.get, paths))


def advanced_status_map(ch):
    """{company_number: (status, sic_codes)} for every company currently in a distress status
    (liquidation limited to LIQ_SICS). Cached via CH (6 days)."""
    out, stats = {}, Counter()
    paths = [f"/advanced-search/companies?company_status={s}&size=5000" for s in ADV_FULL]
    paths += [f"/advanced-search/companies?company_status=liquidation&sic_codes={s}&size=5000" for s in LIQ_SICS]
    prefetch(ch, paths, workers=4)
    for p in paths:
        d = ch.get(p) or {}
        items = d.get("items") or []
        st = re.search(r"company_status=([a-z-]+)", p).group(1)
        stats[st] += len(items)
        if (d.get("hits") or 0) > len(items):
            stats["truncated:" + p.split("?")[1]] += (d.get("hits") or 0) - len(items)
        for i in items:
            out[cn8(i.get("company_number"))] = (i.get("company_status") or st, i.get("sic_codes") or [])
        if not d:
            stats["empty or unavailable"] += 1
    return out, stats


# --------------------------------------------------------------------------- universe
def build_universe(conn, run, min_m, max_m):
    """Every company with an outstanding qualifying charge created min_m..max_m months ago, after
    the radar's base filters. Class from name/description (SIC added later where needed)."""
    w_start, w_end = mr.add_months(run, -max_m), mr.add_months(run, -min_m)
    rows = mr.q(conn, """
        select c.company_number, c.lender, c.date_created, c.property_description,
               lc.lender_type, lc.trading_name, s.company_name, s.psc, s.postcode
        from public.charges c
        left join public.lender_classifications lc on lc.lender = c.lender
        left join public.spv_companies s on s.company_number = c.company_number
        where c.status = 'outstanding' and not coalesce(c.excluded, false)
          and c.date_created ~ '^\\d{4}-\\d{2}-\\d{2}$'
          and c.date_created between %s and %s""", (w_start.isoformat(), w_end.isoformat()))
    funnel = [("Outstanding charges %d-%d months old" % (min_m, max_m), len(rows),
               len({r["company_number"] for r in rows}))]
    lender_names = {mr.norm(x["lender"]) for x in mr.q(conn, """
        select lender from public.lender_classifications
        where lender_type in ('institution','trustee') and coalesce(charge_count,0) >= 5""")}
    keep = []
    for r in rows:
        r["lname"] = mr.norm_lender(r["trading_name"] or r["lender"])
        r["company_name"] = r["company_name"] or ""
        if r["lender_type"] not in ("institution", "trustee"):
            continue
        if mr.BTL_LENDERS.search(r["lname"]) or mr.BTL_LENDERS.search(r["lender"] or ""):
            continue
        if mr.HOUSEBUILDERS.search(r["lender"] or ""):
            continue
        if not r["company_name"] or mr.FINANCE_BORROWER.search(r["company_name"]) \
                or mr.norm(r["company_name"]) in lender_names:
            continue
        keep.append(r)
    funnel.append(("After base filters (institution lenders, no BTL/housebuilder, no finance borrowers)",
                   len(keep), len({r["company_number"] for r in keep})))

    cos = {}
    for r in keep:
        cn = cn8(r["company_number"])
        c = cos.setdefault(cn, {"company_number": cn, "name": r["company_name"], "psc_db": r["psc"],
                                "postcode": r["postcode"], "charges": [], "cls_votes": Counter(),
                                "evidence": []})
        r["lcat"] = lender_category(r["lname"], r["lender"])
        c["charges"].append(r)
        cls = None
        for k in mr.CLASS_ORDER:
            if mr.NAME_RX[k].search(r["company_name"]):
                cls, ev = k, "name: " + mr.NAME_RX[k].search(r["company_name"]).group(0)
                break
        if not cls and r["property_description"]:
            for k in mr.CLASS_ORDER:
                if mr.DESC_RX[k].search(r["property_description"]):
                    cls, ev = k, "desc: " + mr.DESC_RX[k].search(r["property_description"]).group(0)
                    break
        if cls:
            c["cls_votes"][cls] += 1
            if ev not in c["evidence"]:
                c["evidence"].append(ev)
    for c in cos.values():
        c["cls"] = c["cls_votes"].most_common(1)[0][0] if c["cls_votes"] else None
        c["n"] = len(c["charges"])
        c["lenders"] = sorted({r["lname"] for r in c["charges"]})
        c["dates"] = sorted(r["date_created"] for r in c["charges"])
        c["trustee"] = any(r["lender_type"] == "trustee" or re.search(r"security (agent|trustee)",
                           r["lender"] or "", re.I) for r in c["charges"])
        c["corp_psc_db"] = bool(re.search(r"\b(limited|ltd|plc|llp|lp|s\.?a\.?r\.?l|b\.?v)\b",
                                          c["psc_db"] or "", re.I))
        c["lender_pre"] = max((r["lcat"]["pre_points"] for r in c["charges"] if r["lcat"]), default=0)
    funnel.append(("  of which classified by name/description", sum(1 for c in cos.values() if c["cls"]),
                   sum(1 for c in cos.values() if c["cls"])))
    return cos, funnel


def pre_score(c):
    s = mr.TARGET_PRIORITY.get(c.get("cls"), 0) + min(c["n"], 10) * 3 + c["lender_pre"]
    return s + (6 if c["trustee"] else 0) + (10 if c["corp_psc_db"] else 0)


def all_outstanding(conn, nums):
    """All outstanding charges (any lender, any date) for the given companies."""
    out = defaultdict(list)
    for i in range(0, len(nums), 20000):
        for x in mr.q(conn, """
                select c.company_number, c.lender, c.date_created
                from public.charges c
                where c.status = 'outstanding' and not coalesce(c.excluded, false)
                  and c.company_number = any(%s)""", (nums[i:i + 20000],)):
            out[cn8(x["company_number"])].append(x)
    return out


def credit_cache(nums):
    """Cached credit data rows (never fetched here). Reads creditsafe_reports only."""
    sql = """select company_number, credit_score, credit_score_band, risk_rating, ccj_count,
                    ccj_total_value, fetched_at
             from creditsafe_reports
             where company_number = any(%s) and fetched_at > now() - interval '%s days'"""
    assert not re.search(r"loan_book|loan_data|experian", sql, re.I)
    conn = psycopg2.connect(DSN)
    conn.set_session(readonly=True, autocommit=True)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (list(nums), CREDIT_SIGNAL_DAYS))
            return {cn8(r["company_number"]): dict(r) for r in cur.fetchall()}
    finally:
        conn.close()


# --------------------------------------------------------------------------- signals
def _fl(n):
    """(first, last) name tokens: 'Benjamin John Wiles' and 'Benjamin Wiles' are the same person."""
    t = re.sub(r"[^a-z ]", " ", str(n or "").lower()).split()
    return (t[0], t[-1]) if t else None


def _role(role, case_type):
    """Practitioner role label; CH often says just 'practitioner', so fall back to the case type."""
    if role and role != "practitioner":
        return ROLE_LABEL.get(role, role.replace("-", " ").capitalize())
    t = case_type or ""
    if "administration" in t:
        return "Administrator"
    if "liquidation" in t:
        return "Liquidator"
    if "voluntary-arrangement" in t:
        return "Supervisor (CVA)"
    if RECEIVER_CASES.search(t):
        return "Receiver"
    return "Practitioner"


def _sig(kind, level, text, date, url, weight):
    return {"kind": kind, "level": level, "text": text, "date": date, "url": url, "weight": weight}


def company_signals(ch, gz, c, run, notices, adv, credit_rows, outstanding):
    """Fills c['signals'], c['appointees'], c['tier'], c['dscore']. Uses cached CH fetches."""
    cn = c["company_number"]
    p = c.get("profile") or {}
    sigs, appointees = [], []
    status = p.get("company_status") or (adv.get(cn) or ("unknown",))[0]
    c["status"] = status
    insolv_link = f"{CH_LINK.format(cn)}/insolvency"
    fh_link = f"{CH_LINK.format(cn)}/filing-history"

    # ---- CH insolvency cases ----
    cases = ((ch.get(f"/company/{cn}/insolvency") or {}).get("cases") or []) \
        if (p.get("has_insolvency_history") or status in FORMAL_STATUS | RECEIVER_STATUS) else []
    charge_items = None
    live_formal = live_recv = solvent_only = False
    kinds = set()
    for case in cases:
        typ = case.get("type") or ""
        kinds.add(typ)
        prs = [x for x in case.get("practitioners") or [] if not x.get("ceased_to_act_on")]
        dates = {x.get("type"): x.get("date") for x in case.get("dates") or []}
        if typ in SOLVENT_CASES:
            continue
        ended = any(k in dates for k in ("dissolved-on", "case-end-on", "concluded-winding-up-on",
                                         "administration-ended-on", "voluntary-arrangement-ended-on"))
        is_recv = bool(RECEIVER_CASES.search(typ))
        case_start = next((v for k, v in dates.items() if "start" in k or "commenced" in k or "resolution" in k
                           or "order" in k or "petition" in k), None)
        appointed = min((x.get("appointed_on") for x in prs if x.get("appointed_on")), default=None) or case_start
        if not prs and ended:
            continue
        chargee = None
        if is_recv and (case.get("links") or {}).get("charge"):
            if charge_items is None:
                charge_items = (ch.get(f"/company/{cn}/charges?items_per_page=100&start_index=0") or {}).get("items") or []
            cid = case["links"]["charge"].rstrip("/").split("/")[-1]
            hit = next((i for i in charge_items if (i.get("links") or {}).get("self", "").endswith(cid)), None)
            if hit:
                chargee = "; ".join(x.get("name") or "" for x in hit.get("persons_entitled") or []) or None
                c.setdefault("recv_charge_date", hit.get("created_on"))
        label = CASE_LABEL.get(typ, typ.replace("-", " ").capitalize())
        txt = f"{label} (CH case {case.get('number', '?')})" + (f", on {chargee} charge" if chargee else "") \
            + (f", {len(prs)} practitioner(s)" if prs else ", no practitioner listed")
        if is_recv:
            live_recv |= bool(prs) and not ended
            sigs.append(_sig("ch_case", "receiver", txt, appointed, insolv_link, 85))
        else:
            live_formal |= not ended
            sigs.append(_sig("ch_case", "formal", txt, appointed, insolv_link, 90 if not ended else 40))
        for x in prs:
            a = x.get("address") or {}
            appointees.append({
                "name": x.get("name"), "role": _role(x.get("role"), typ),
                "appointed_on": x.get("appointed_on") or case_start, "receiver": is_recv, "chargee": chargee,
                "address": ", ".join(filter(None, [a.get("address_line_1"), a.get("address_line_2"),
                                                   a.get("locality"), a.get("postal_code")])),
                "firm": None, "firm_src": None, "source": insolv_link})
    if cases and kinds and kinds <= SOLVENT_CASES:
        solvent_only = True

    # ---- company status ----
    if status in FORMAL_STATUS and not solvent_only:
        sigs.append(_sig("status", "formal", f"Companies House status: {STATUS_LABEL[status]}", None,
                         CH_LINK.format(cn), 70))
    elif status in RECEIVER_STATUS:
        sigs.append(_sig("status", "receiver", "Companies House status: receiver action", None,
                         CH_LINK.format(cn), 70))
        live_recv = True
    detail = p.get("company_status_detail") or ""

    # ---- filing history: RM01/RM02, compulsory strike-off, auditor resignation ----
    fh = (ch.get(f"/company/{cn}/filing-history?items_per_page=100") or {}).get("items") or []
    rm02 = max((i.get("date") or "" for i in fh if i.get("type") == "RM02"), default="")
    for i in fh:
        t, desc, date = i.get("type") or "", i.get("description") or "", i.get("date")
        link = CH_SITE + (i.get("links") or {}).get("self", f"/company/{cn}/filing-history")
        if t == "RM01" or "appointment-of-receiver" in desc:
            if (date or "") > rm02 and months_since(date, run) is not None and months_since(date, run) <= 72:
                sigs.append(_sig("rm01", "receiver", "RM01 notice of appointment of receiver/manager filed",
                                 date, link, 80))
                live_recv = True
        elif t == "GAZ1" and "compulsory" in desc and months_since(date, run) is not None \
                and months_since(date, run) <= 12:
            sigs.append(_sig("strike_off", "formal_warning",
                             "First Gazette notice for compulsory strike-off (filings not made)", date, link, 50))
        elif (t.startswith("AUD") or "auditor" in desc) and months_since(date, run) is not None \
                and months_since(date, run) <= 18:
            sigs.append(_sig("auditor", "soft", "Auditor resignation filed", date, link, 15))
    if "proposal-to-strike-off" in detail and not any(s["kind"] == "strike_off" for s in sigs):
        sigs.append(_sig("strike_off", "formal_warning", "Active proposal to strike off (Companies House)",
                         None, CH_LINK.format(cn), 45))

    # ---- Gazette ----
    petitions, dismissed = [], []
    for n in notices.get(cn, []):
        det = gz.notice_detail(n["id"]) if (gz and n["code"] in APPOINTMENT_CODES | {2450}) else {}
        if n["kind"] == "dismissed":
            dismissed.append(n)
            sigs.append(_sig("gazette", "info", f"Gazette: {n['label']}", n["published"], n["url"], 0))
            continue
        if n["kind"] == "petition":
            txt = "Gazette: winding-up petition" + (f" by {det['petitioner']}" if det.get("petitioner") else "") \
                + (f", hearing {fmt(det['hearing'])}" if det.get("hearing") else "")
            petitions.append(n)
            sigs.append(_sig("gazette", "formal_warning", txt, det.get("petition_date") or n["published"],
                             n["url"], 60))
            continue
        lvl = "receiver" if n["kind"] == "receiver" else "formal"
        appointed = det.get("appointed") or n["published"]
        sigs.append(_sig("gazette", lvl if n["kind"] != "dividend" else "formal",
                         f"Gazette: {n['label']}", appointed if n["code"] in APPOINTMENT_CODES else n["published"],
                         n["url"], 75 if n["code"] in APPOINTMENT_CODES else 35))
        if n["code"] in APPOINTMENT_CODES:
            live_formal |= lvl == "formal"
            live_recv |= lvl == "receiver"
        for ip in det.get("ips") or []:
            # attach the firm to a CH practitioner of the same name, else add as appointee
            hit = next((a for a in appointees if _fl(a["name"]) == _fl(ip["name"])), None)
            if hit:
                hit["firm"] = hit["firm"] or ip.get("firm")
                hit["firm_src"] = hit["firm_src"] or n["url"]
            elif n["code"] in APPOINTMENT_CODES:
                appointees.append({"name": ip["name"], "role": {"administration": "Administrator",
                                                                "liquidation": "Liquidator",
                                                                "receiver": "Administrative receiver"}[n["kind"]],
                                   "appointed_on": appointed, "receiver": n["kind"] == "receiver",
                                   "chargee": None, "address": ip.get("address"), "firm": ip.get("firm"),
                                   "firm_src": n["url"], "source": n["url"]})
    if petitions and dismissed and max(x["published"] for x in dismissed) >= max(x["published"] for x in petitions):
        for s in sigs:
            if s["kind"] == "gazette" and s["text"].startswith("Gazette: winding-up petition"):
                s["text"] += " (later dismissed)"
                s["weight"] = 10
                s["level"] = "soft"

    # ---- soft: accounts / confirmation statement overdue ----
    acc = p.get("accounts") or {}
    due = acc.get("next_due") or (acc.get("next_accounts") or {}).get("due_on")
    if acc.get("overdue") and due:
        mo = max(months_since(due, run) or 0, 0)
        late = f"{mo} month{'s' if mo != 1 else ''} late" if mo else "under a month late"
        sigs.append(_sig("accounts_overdue", "soft", f"Accounts overdue, {late} (due {fmt(due)})",
                         due, fh_link, 20 + min(mo, 12) * 2))
        c["acc_overdue_months"] = mo
    cs = p.get("confirmation_statement") or {}
    if cs.get("overdue") and cs.get("next_due"):
        sigs.append(_sig("cs_overdue", "soft", f"Confirmation statement overdue (due {fmt(cs['next_due'])})",
                         cs["next_due"], fh_link, 10))

    # ---- soft: credit data (cache only) ----
    cr = credit_rows.get(cn)
    if cr:
        bits = []
        if cr.get("credit_score") is not None and cr["credit_score"] <= CREDIT_LOW_SCORE:
            bits.append(f"very low credit score {cr['credit_score']}"
                        + (f" ({cr.get('credit_score_band') or cr.get('risk_rating')})"
                           if cr.get("credit_score_band") or cr.get("risk_rating") else ""))
        if (cr.get("ccj_count") or 0) > 0:
            bits.append(f"{cr['ccj_count']} CCJ(s)" + (f" totalling £{float(cr['ccj_total_value']):,.0f}"
                                                        if cr.get("ccj_total_value") else ""))
        if bits:
            fa = cr.get("fetched_at")
            sigs.append(_sig("credit", "soft", "Credit data: " + ", ".join(bits),
                             fa.date().isoformat() if hasattr(fa, "date") else None, None, 20))

    # ---- soft: director resignations in the last 6 months ----
    offs = (ch.get(f"/company/{cn}/officers?items_per_page=100") or {}).get("items") or []
    cutoff = run - dt.timedelta(days=RESIGN_DAYS)
    res = sorted(o.get("resigned_on") for o in offs if o.get("officer_role") in (
        "director", "corporate-director", "llp-member", "llp-designated-member")
        and _d(o.get("resigned_on")) and _d(o.get("resigned_on")) >= cutoff)
    if len(res) >= RESIGN_MIN:
        sigs.append(_sig("resignations", "soft", f"{len(res)} director resignations since {fmt(cutoff)}"
                         f" (latest {fmt(res[-1])})", res[-1], f"{CH_LINK.format(cn)}/officers", 10 + 3 * len(res)))
    c["directors"] = [f"{o.get('name')} (appointed {o.get('appointed_on', '?')})" for o in offs
                      if o.get("officer_role") in ("director", "corporate-director", "llp-member",
                                                   "llp-designated-member") and not o.get("resigned_on")]

    # ---- soft: rescue / bridging charge on top of an older senior charge ----
    rec_cut = mr.add_months(run, -RESCUE_MONTHS).isoformat()
    senior = {mr.norm(r["lname"]) for r in c["charges"]}
    for x in outstanding.get(cn, []):
        dc = x.get("date_created") or ""
        if dc >= rec_cut and re.match(r"^\d{4}-\d{2}-\d{2}$", dc) and RESCUE_LENDERS.search(x.get("lender") or "") \
                and mr.norm(mr.norm_lender(x["lender"])) not in senior:
            sigs.append(_sig("rescue_charge", "soft",
                             f"New charge to {mr.norm_lender(x['lender'])} (bridging/specialist) on top of "
                             f"{c['lenders'][0]} charge from {mon(c['dates'][0])}", dc,
                             f"{CH_LINK.format(cn)}/charges", 25))
            break

    # ---- tier ----
    levels = {s["level"] for s in sigs}
    if solvent_only and not (levels - {"info", "soft"}) and status == "liquidation":
        sigs = [s for s in sigs if s["level"] == "soft"]  # members' (solvent) liquidation: not distress
        levels = {s["level"] for s in sigs}
    if live_formal or (status in FORMAL_STATUS and not solvent_only):
        tier = "insolvency"
    elif live_recv or "receiver" in levels:
        tier = "receiver"
    elif levels - {"info"}:
        tier = "early"
    else:
        tier = None
    # firms for receivers / IPs not on a Gazette notice: the firm on their own latest Gazette notice
    c["signals"] = sorted([s for s in sigs if s["level"] != "info" or tier], key=lambda s: -s["weight"])
    c["appointees"] = appointees
    c["tier"] = tier
    latest = max((_d(a.get("appointed_on")) for a in appointees if _d(a.get("appointed_on"))), default=None)
    c["latest_appointment"] = latest
    score = sum(s["weight"] for s in sigs)
    if latest and mr.months_between(latest, run) > STALE_CASE_MONTHS:
        score -= 60  # old case: assets probably already realised
    c["dscore"] = score
    return c


def angle(c, run):
    """One factual line from the signals only."""
    first_ch = min(c.get("charges") or [{}], key=lambda r: r.get("date_created") or "9")
    lender = first_ch.get("lname") or (c["lenders"][0] if c.get("lenders") else "lender")
    first = mon(c["dates"][0]) if c.get("dates") else "?"
    ap = sorted([a for a in c.get("appointees") or [] if a.get("appointed_on")],
                key=lambda a: a["appointed_on"], reverse=True)
    if c["tier"] == "insolvency":
        st = c.get("status")
        a = next((x for x in ap if not x["receiver"]), None)
        n_same = sum(1 for x in ap if a and x["role"] == a["role"] and x.get("appointed_on") == a.get("appointed_on"))
        role = (a["role"] + ("s" if n_same > 1 else "")) if a else STATUS_LABEL.get(st, "Insolvency process")
        when = f" appointed {mon(a['appointed_on'])}" if a else ""
        firm = f" ({a['firm']})" if a and a.get("firm") else ""
        if st == "voluntary-arrangement" or (a and "CVA" in a["role"]):
            return (f"CVA in place{when}{firm}; {lender} charge {first} still outstanding; possible rescue "
                    "refinance, approach via the supervisor")
        return (f"{role}{when}{firm}; {lender} charge {first} still outstanding; likely asset sale, "
                "fund-client buyer angle")
    if c["tier"] == "receiver":
        a = next((x for x in ap if x["receiver"]), None)
        by = f" by {a['chargee']}" if a and a.get("chargee") else ""
        when = f" {mon(a['appointed_on'])}" if a else ""
        rm = next((s for s in c["signals"] if s["kind"] == "rm01"), None)
        if not a and rm:
            when = f" (RM01 filed {mon(rm['date'])})"
        return (f"Receiver appointed{when}{by}; {lender} charge {first} outstanding; receiver sale likely, "
                "fund-client buyer angle")
    top = c["signals"][0] if c.get("signals") else None
    if not top:
        return ""
    k = top["kind"]
    if k == "gazette" and "petition" in top["text"] and "dismissed" not in top["text"]:
        return f"Winding-up petition {mon(top['date'])}; {lender} charge {first}; possible rescue refinance before the hearing"
    if k == "strike_off":
        return f"Compulsory strike-off proposed {mon(top['date']) if top['date'] else ''}".rstrip() + \
               f" (filings missed); {lender} charge {first}; possible rescue refinance"
    if k == "accounts_overdue":
        mo = c.get("acc_overdue_months", 0)
        late = f"{mo} month{'s' if mo != 1 else ''} overdue" if mo else "just overdue"
        return f"Accounts {late}, {lender} charge {first[-4:]}; possible rescue refinance"
    if k == "rescue_charge":
        return f"{top['text']}; possible refinance of both"
    if k == "credit":
        return f"{top['text']}; {lender} charge {first}; possible rescue refinance"
    if k == "resignations":
        return f"{top['text']}; {lender} charge {first}; no formal appointment yet"
    return f"{top['text']}; {lender} charge {first}"


# --------------------------------------------------------------------------- main build
def build(run=None, min_m=MIN_MONTHS, max_m=MAX_MONTHS, use_gazette=True, exclude=(), extra=(),
          ch=None, limit=None):
    """Distress candidates, ranked. Returns dict with 'candidates' (all with a tier, ranked),
    'counts', 'funnel', 'sources' (status per source), 'secs'.
    exclude: company numbers already shown in the main list (never repeated here).
    extra: radar company dicts (e.g. maturity_radar's own distress list) to merge in."""
    t0 = time.time()
    run = run or dt.date.today()
    sources = {}
    conn = psycopg2.connect(DSN)
    conn.set_session(readonly=True, autocommit=True)
    uni, funnel = build_universe(conn, run, min_m, max_m)
    log(f"distress universe: {len(uni):,} companies after base filters "
        f"({funnel[-1][2]:,} classified) in {time.time() - t0:.0f}s")

    ch = threaded_ch(ch or mr.CH())
    # 1. companies currently in a distress status (CH advanced search), intersected with the universe
    try:
        adv, adv_stats = advanced_status_map(ch)
        sources["Companies House advanced search"] = (
            "ok: " + ", ".join(f"{k} {v:,}" for k, v in adv_stats.items() if not k.startswith("truncated"))
            + ("; truncated " + ", ".join(k for k in adv_stats if k.startswith("truncated"))
               if any(k.startswith("truncated") for k in adv_stats) else ""))
    except Exception as ex:
        adv = {}
        sources["Companies House advanced search"] = f"FAILED ({type(ex).__name__})"
    pool = {cn for cn in adv if cn in uni}

    # 2. Gazette notices (corporate insolvency codes), intersected with the universe
    gz = Gazette(run) if use_gazette else None
    notices = defaultdict(list)
    if gz:
        tg = time.time()
        allnot = gz.notices(GAZETTE_LOOKBACK_MONTHS)
        name_idx = defaultdict(list)
        for cn, c in uni.items():
            name_idx[mr.norm(c["name"])].append(cn)
        for n in allnot:
            cn = n["cn"] if n["cn"] in uni else None
            if not cn and not n["cn"]:
                hits = name_idx.get(mr.norm(n["title"])) or []
                cn = hits[0] if len(hits) == 1 else None
            if cn:
                notices[cn].append(n)
        sources["The Gazette"] = (f"ok: {len(allnot):,} notices over {GAZETTE_LOOKBACK_MONTHS} months, "
                                  f"{len(notices)} universe companies matched; requests {gz.fetched}, "
                                  f"cached {gz.cached}, failed {gz.failed}"
                                  + (f" ({dict(gz.errors)})" if gz.errors else "")
                                  + f"; {time.time() - tg:.0f}s")
        if gz.failed and not allnot:
            sources["The Gazette"] = "FAILED: " + sources["The Gazette"]
        pool |= set(notices)
    else:
        sources["The Gazette"] = "skipped (--no-gazette)"

    # 3. soft pool: rescue top-ups (SQL), cached credit data, top classified universe by size proxy
    outstanding = all_outstanding(conn, list(uni))
    rec_cut = mr.add_months(run, -RESCUE_MONTHS).isoformat()
    rescue = {cn for cn, xs in outstanding.items() if cn in uni and any(
        (x.get("date_created") or "") >= rec_cut and RESCUE_LENDERS.search(x.get("lender") or "")
        and mr.norm(mr.norm_lender(x["lender"])) not in {mr.norm(r["lname"]) for r in uni[cn]["charges"]}
        for x in xs)}
    try:
        credit_rows = credit_cache(list(uni))
        weak = {cn for cn, r in credit_rows.items() if (r.get("credit_score") is not None and
                r["credit_score"] <= CREDIT_LOW_SCORE) or (r.get("ccj_count") or 0) > 0}
        sources["credit data (cache only)"] = f"ok: {len(credit_rows)} cached rows in universe, {len(weak)} weak"
    except Exception as ex:
        credit_rows, weak = {}, set()
        sources["credit data (cache only)"] = f"FAILED ({type(ex).__name__})"
    classified = sorted((c for c in uni.values() if c["cls"]), key=lambda c: -pre_score(c))
    top_soft = {c["company_number"] for c in classified[:SOFT_POOL]}
    for x in extra or []:
        if cn8(x.get("company_number")) in uni:
            pool.add(cn8(x["company_number"]))
    pool |= rescue | weak | top_soft
    pool -= {cn8(x) for x in exclude}
    conn.close()
    log(f"distress pool: {len(pool)} (status search {len({c for c in adv if c in uni})}, gazette "
        f"{len(notices)}, rescue charge {len(rescue)}, weak credit {len(weak)}, top by size proxy {len(top_soft)})")

    # 4. CH profiles for the pool
    prefetch(ch, [f"/company/{cn}" for cn in pool])
    cands = []
    for cn in pool:
        c = uni[cn]
        p = ch.get(f"/company/{cn}") or {}
        c["profile"] = p
        st = p.get("company_status") or (adv.get(cn) or ("unknown",))[0]
        if st in mr.CLOSED_STATUS:
            continue
        c["sic"] = p.get("sic_codes") or (adv.get(cn) or (None, []))[1]
        if any(mr.FINANCE_SIC.match(s) for s in c["sic"]):
            continue
        if p.get("company_name"):
            c["name"] = p["company_name"]
        sic_cls = next((mr.sic_class(s) for s in c["sic"] if mr.sic_class(s)), None)
        c["sic_note"] = ""
        if not c["cls"] and sic_cls:
            c["cls"], c["sic_note"] = sic_cls, "class from SIC"
        elif sic_cls and sic_cls == c["cls"]:
            c["sic_note"] = "SIC confirms"
        if not c["cls"]:
            continue
        c["acc_type"] = ((p.get("accounts") or {}).get("last_accounts") or {}).get("type")
        c["acc_overdue"] = bool((p.get("accounts") or {}).get("overdue"))
        quick = (st in FORMAL_STATUS | RECEIVER_STATUS or p.get("has_insolvency_history") or cn in notices
                 or c["acc_overdue"] or (p.get("confirmation_statement") or {}).get("overdue")
                 or "strike-off" in (p.get("company_status_detail") or "") or cn in rescue or cn in weak
                 or cn in top_soft)
        if quick:
            cands.append(c)
    log(f"distress: {len(cands)} pool companies classified and open; fetching officers/filings/insolvency")

    # 5. deep fetch + signals
    paths = []
    for c in cands:
        cn = c["company_number"]
        paths += [f"/company/{cn}/officers?items_per_page=100", f"/company/{cn}/filing-history?items_per_page=100"]
        if c["profile"].get("has_insolvency_history") or c["profile"].get("company_status") in FORMAL_STATUS | RECEIVER_STATUS:
            paths.append(f"/company/{cn}/insolvency")
    prefetch(ch, paths)
    out = []
    for c in cands:
        company_signals(ch, gz, c, run, notices, adv, credit_rows, outstanding)
        if c["tier"]:
            c["n_total"] = len(outstanding.get(c["company_number"], []))
            c["out_dates"] = sorted({x["date_created"] for x in outstanding.get(c["company_number"], [])
                                     if x.get("date_created")})
            out.append(c)
    log(f"distress: {len(out)} with signals; fetching PSC + charge particulars for size")

    # 6. PSC + charge particulars (size signals), provisional size, rank
    prefetch(ch, [f"/company/{c['company_number']}/persons-with-significant-control?items_per_page=100"
                  for c in out] + [f"/company/{c['company_number']}/charges?items_per_page=100&start_index=0"
                                   for c in out])
    for c in out:
        ps = ch.get(f"/company/{c['company_number']}/persons-with-significant-control?items_per_page=100") or {}
        live = [x for x in ps.get("items", []) if not x.get("ceased_on")]
        c["parents"] = [x.get("name") for x in live if "corporate" in (x.get("kind") or "")
                        or "legal-person" in (x.get("kind") or "")]
        c["psc_people"] = [x.get("name") for x in live if "individual" in (x.get("kind") or "")]
        c["prop"] = mr.charge_property(ch, c)
        c["size"] = score_size(c)
        c["contacts"] = []
        c["evidence"] = c.get("evidence") or []
    counts = Counter(c["tier"] for c in out)
    out.sort(key=lambda c: (TIER_KEYS.index(c["tier"]), band_rank(c["size"]), -c["dscore"]))
    return {"run": run, "candidates": out, "counts": dict(counts), "funnel": funnel, "sources": sources,
            "gazette": gz, "ch": ch, "secs": round(time.time() - t0), "window": (min_m, max_m),
            "size_counts": dict(Counter(c["size"]["band"] for c in out))}


def dedupe_groups(cands):
    """Collapse sibling SPVs in the same process (same name stem, same board, or same appointees):
    keeps the first (best-ranked); later ones listed as related."""
    kept, stems, boards, ips = [], {}, [], {}
    for c in cands:
        toks = mr.norm(c["name"]).split()
        stem = " ".join(toks[:2]) if len(toks) >= 2 and len(toks[0]) >= 3 else None
        dirs = {d.split(" (appointed")[0] for d in c.get("directors") or []}
        ipk = frozenset(mr.norm(a["name"]) for a in c.get("appointees") or [] if a.get("name"))
        host = (stems.get(stem) if stem else None) or (ips.get(ipk) if ipk else None) \
            or next((k for k, b in boards if len(dirs & b) >= 2), None)
        if host:
            host.setdefault("related", []).append(f"{c['name']} ({c['company_number']})")
            continue
        kept.append(c)
        if stem:
            stems[stem] = c
        if ipk:
            ips[ipk] = c
        boards.append((c, dirs))
    return kept


def select(res, n=10):
    """Up to n for the email: tier, then size band (Unlikely excluded if EXCLUDE_UNLIKELY), sibling
    groups collapsed. Adds firms for appointees without one (their own latest Gazette notice) and the
    angle line."""
    ok = [c for c in res["candidates"] if not (EXCLUDE_UNLIKELY and c["size"]["band"] == "unlikely")]
    picked = dedupe_groups(ok)[:n]
    gz = res.get("gazette")
    for c in picked:
        for a in c.get("appointees") or []:
            if gz and not a.get("firm") and a.get("name"):
                a["firm"], a["firm_src"] = gz.ip_firm(a["name"])
        c["angle"] = angle(c, res["run"])
    return picked


def appointee_line(c):
    ap = c.get("appointees") or []
    if not ap:
        return "None appointed"
    seen, parts = set(), []
    for a in sorted(ap, key=lambda a: a.get("appointed_on") or "", reverse=True):
        k = mr.norm(a["name"])
        if k in seen:
            continue
        seen.add(k)
        s = f"{a['name']} ({a['role']}" + (f", appointed {fmt(a['appointed_on'])}" if a.get("appointed_on") else "") + ")"
        if a.get("firm"):
            s += f", {a['firm']}" + (" (firm per their Gazette notice)" if a.get("firm_src") and
                                     a.get("firm_src") != a.get("source") else "")
        elif a.get("address"):
            s += f", {a['address']} (firm not stated)"
        if a.get("chargee"):
            s += f"; appointed under the {a['chargee']} charge"
        parts.append(s)
        if len(parts) >= 3:
            break
    return "; ".join(parts)


# --------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--min-months", type=int, default=MIN_MONTHS)
    ap.add_argument("--max-months", type=int, default=MAX_MONTHS)
    ap.add_argument("--no-gazette", action="store_true")
    a = ap.parse_args(argv)
    run = dt.date.fromisoformat(a.date) if a.date else dt.date.today()
    res = build(run, a.min_months, a.max_months, use_gazette=not a.no_gazette)
    for s, v in res["sources"].items():
        log(f"source {s}: {v}")
    log("tiers:", res["counts"], "sizes:", res["size_counts"], f"{res['secs']}s")
    for c in select(res):
        log(f"  [{TIER_LABEL[c['tier']]}] {c['name']} ({c['company_number']}) {c['cls']} "
            f"{c['size']['label']} | {appointee_line(c)} | {c['angle']}")


if __name__ == "__main__":
    main()
