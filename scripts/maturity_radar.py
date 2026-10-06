#!/usr/bin/env python3
"""
Maturity radar (MVP) for Turning Point Capital Advisory.

Weekly shortlist of 10-20 SPVs/sponsors whose property loans are likely in their
refinancing window, for Marcus to approve PERSONAL one-to-one outreach.
This script never sends anything and never writes to the database.

DATA GUARD (hard rule, do not relax):
  * Only PUBLIC Companies House data is used: public.charges, public.spv_companies,
    public.lender_classifications, plus free Companies House REST API GETs.
  * Loan Intel member tables (loan_book, loan_data, anything keyed by lender_id /
    member data) and experian_* tables must NEVER be read. `_guard_sql()` enforces
    this on every query, and the DB session is opened READ ONLY.
  * The tp outreach tables contacts / suppressed_emails are read (tenant='tp' only)
    purely to show an existing contact and DO NOT CONTACT flags.
  * Lenders are never targets: finance/lending borrowers are screened out.

Pipeline
  1. Outstanding charges created MIN_MONTHS-MAX_MONTHS (default 57-60) months before the run
     date, i.e. reaching the 5-year anniversary within the next 3 months
     -> institution/trustee lenders -> minus BTL/residential lenders
     -> minus housebuilder/land-seller counterparties
     -> lender must match the GBP 10m+ allowlist (scripts/radar_lenders_10m_plus.txt)
     -> minus finance-named / lender borrowers.
  2. Asset class from company name + (conservative) property-description keywords.
  3. Pre-score in SQL data; top N get CH company profile (SIC confirm/upgrade, status,
     accounts type, insolvency). Distressed companies listed separately, not targeted.
  4. Top ~50 get CH officers + PSC; pick top 20 balanced across classes (max 5 each).
  5. Match against tp outreach contacts; flag suppressed/unsubscribed/hold = DO NOT CONTACT.
  6. Write reports/radar/radar-YYYY-MM-DD.{md,csv} + lender-review-YYYY-MM-DD.csv.

Usage: python3 scripts/maturity_radar.py [--date YYYY-MM-DD] [--strict-lenders]
                                          [--profile-pool 200] [--deep 50] [--top 20]
"""
import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

import psycopg2
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "reports", "radar")
CACHE_DIR = os.path.join(OUT_DIR, "ch_cache")
ALLOWLIST_FILE = os.path.join(ROOT, "scripts", "radar_lenders_10m_plus.txt")
DSN = "postgresql://tpca@localhost:5432/tpca_platform"  # password via ~/.pgpass
CH_BASE = "https://api.company-information.service.gov.uk"
CH_KEYS_SOURCE = "/root/scanner.py"  # existing CH scanner holds the API key list
CACHE_TTL_DAYS = 6  # weekly reruns refresh; same-week reruns hit cache
CH_LINK = "https://find-and-update.company-information.service.gov.uk/company/{}"
# Charge age window (months since creation). Default 57-60: charges reaching their
# 5-year anniversary within the next 3 months, i.e. a typical 5-year facility nearing term.
MIN_MONTHS = 57
MAX_MONTHS = 60

# --------------------------------------------------------------------------- guards
ALLOWED_TABLES = {"charges", "spv_companies", "lender_classifications",
                  "contacts", "suppressed_emails"}
FORBIDDEN_SQL = re.compile(
    r"\b(loan_book|loan_data|lender_id|member\w*|experian\w*|insert|update|delete|"
    r"create|alter|drop|truncate|grant|copy)\b", re.I)


def _guard_sql(sql):
    """Refuse any query touching non-public / member data or attempting a write."""
    if FORBIDDEN_SQL.search(sql):
        raise RuntimeError("DATA GUARD: forbidden table/statement in SQL")
    for t in re.findall(r"\b(?:from|join)\s+(?:public\.)?([a-z_]+)", sql, re.I):
        if t.lower() not in ALLOWED_TABLES:
            raise RuntimeError(f"DATA GUARD: table '{t}' not on public allowlist")


def q(conn, sql, params=None):
    _guard_sql(sql)
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


# --------------------------------------------------------------------------- rules
# Residential / BTL / high-street mortgage lenders: never relevant at GBP 15-80m.
BTL_LENDERS = re.compile(
    r"mortgage works|paragon|precise|foundation home|fleet mort|landbay|kensington mort|"
    r"keystone|chl mort|vida home|kent reliance|one ?savings|\bosb\b|interbay|molo|"
    r"quantum mort|pepper|building society|\baccord\b|bm solutions|birmingham midshires|"
    r"godiva|zephyr|aldermore|together (money|commercial|personal)|blemain|harpmanor|"
    r"lendco|lendinvest btl|charter court|bluestone|\bmortgages?\b|habito|halifax|"
    r"post office|mpowered|west one loans|nationwide|\bnottingham bs\b|"
    r"\bstate of bank\b|capital trust bank|atom bank|allica|recognise|"
    r"\bsdka\b|lendinvest", re.I)

# Land-seller / option counterparties (housebuilders appearing as chargee).
HOUSEBUILDERS = re.compile(
    r"\bvistry\b|persimmon|barratt|david wilson|taylor wimpey|bellway|berkeley (homes|group)|"
    r"\bredrow\b|countryside (properties|partnerships|homes)|bloor homes|miller homes|"
    r"crest nicholson|linden (homes|ltd|limited)|avant homes|keepmoat|story homes|"
    r"lovell|bovis|st\.? (james|william|edward|george)( group)? (ltd|limited)|"
    r"gleeson|cala (homes|management)|hill partnerships|mccarthy (and|&) stone", re.I)

# Borrowers that are themselves lenders / finance vehicles.
FINANCE_BORROWER = re.compile(
    r"financ|mortgage|lending|\bloans?\b|capital markets|receivables|funding|trustee|"
    r"nominee|\bbank\b|\bcredit\b|securiti[sz]|leasing|bridging|\blend|issuer|"
    r"\bfinco\b|\bclo\b|\bcmbs\b|\bspv (no|number)", re.I)
FINANCE_SIC = re.compile(r"^(6419[12]|6492[129]|65\d{3}|661[129]\d)$")

TARGET_PRIORITY = {"Living": 30, "Hotels": 30, "Care": 30, "SEN": 30,
                   "Logistics/Industrial": 15, "Offices": 12, "Retail/Leisure": 12}
CLASS_ORDER = ["Hotels", "Care", "SEN", "Living",
               "Logistics/Industrial", "Offices", "Retail/Leisure"]

NAME_RX = {
    "Hotels": r"\bhotels?\b|\bhospitality\b|aparthotel|\bresorts?\b|serviced apartments?",
    "Care": r"care homes?|\bnursing\b|\bcare\b|healthcare|retirement|later living|"
            r"senior living|extra care|supported living|dementia|\bhospice",
    # SEN-specific signals only: mainstream independent schools, academies, colleges and
    # nurseries/childcare are deliberately NOT a target class.
    "SEN": r"special educational|special needs|\bsend\b|\bsen\b|\bsemh\b|autis(m|tic)|"
           r"specialist (school|education|provision|provider|learning)|"
           r"independent specialist|special school|residential special",
    "Living": r"\bstudents?\b|\bpbsa\b|build to rent|\bbtr\b|co-?living|\bliving\b|"
              r"\bresidential\b|\bapartments?\b|rental homes|homes for rent|single family",
    "Logistics/Industrial": r"logistics|warehous|distribution|\bindustrial\b|trade park|"
                            r"\bstorage\b|self.?store|\bdepots?\b",
    "Offices": r"\boffices?\b|workspace|business centre",
    "Retail/Leisure": r"\bretail\b|shopping|\bleisure\b|\bpubs?\b|\binns\b|\btaverns?\b|"
                      r"\bgolf\b|holiday park|\bmarina\b|\bcinemas?\b|\bgyms?\b|\bfitness\b|"
                      r"\brestaurants?\b|supermarket",
}
# Description keywords are deliberately conservative (addresses contain street names).
_STREET = r"(?!\s+(street|st|road|rd|lane|ln|hill|close|house|walk|terrace|green|place|yard|" \
          r"row|view|court|drive|way|square|cottages?|gardens|mews|avenue|parade)\b)"
DESC_RX = {
    "Hotels": r"\bhotel\b" + _STREET,
    "Care": r"care home|nursing home|residential care|care centre|care village|"
            r"retirement (village|living|apartments)|extra care|supported living",
    "SEN": r"special educational|special needs|\bsemh\b|autis(m|tic)|special school|"
           r"specialist (school|education|provision|provider)|independent specialist|"
           r"residential special",
    "Living": r"student accommodation|purpose built student|\bpbsa\b|build to rent|"
              r"co-?living|block of (\d+ )?(flats|apartments)|apartment block",
    "Logistics/Industrial": r"\bwarehouse\b|distribution (centre|center|warehouse|unit)|"
                            r"logistics|industrial (unit|estate|park|premises)|trade park",
    "Offices": r"office (building|block|premises|accommodation)|\boffices\b" + _STREET,
    "Retail/Leisure": r"retail park|shopping (centre|center|parade|park)|public house|"
                      r"\bsupermarket\b|leisure (centre|park)|holiday park|caravan park|"
                      r"golf (club|course)",
}
NAME_RX = {k: re.compile(v, re.I) for k, v in NAME_RX.items()}
DESC_RX = {k: re.compile(v, re.I) for k, v in DESC_RX.items()}


def sic_class(sic):
    if re.match(r"^551", sic) or sic == "55900":
        return "Hotels"
    if sic in ("87100", "87200", "87300", "87900"):
        return "Care"
    # SIC 85 (education) no longer maps to a class: it cannot tell SEN from mainstream.
    if sic.startswith("521"):
        return "Logistics/Industrial"
    if sic in ("55300",) or sic.startswith("563") or sic.startswith("931"):
        return "Retail/Leisure"
    return None


ACCOUNTS_SCORE = {"full": 15, "group": 15, "medium": 12, "audit-exemption-subsidiary": 12,
                  "small": 3, "total-exemption-full": 3, "total-exemption-small": 3,
                  "unaudited-abridged": 3, "micro-entity": -15, "dormant": -25}
DISTRESS_STATUS = {"liquidation", "administration", "receivership", "insolvency-proceedings",
                   "voluntary-arrangement"}
CLOSED_STATUS = {"dissolved", "converted-closed", "closed", "removed"}

STOP = r"\b(limited|ltd|plc|llp|lp|uk|group|holdings?|the|and|co|company|propco|opco|" \
       r"no|number|\d+)\b"


def norm(s):
    s = re.sub(r"\(.*?\)", " ", (s or "").lower())
    s = re.sub(r"[^a-z0-9 ]", " ", s.replace("&", " and "))
    s = re.sub(STOP, " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_lender(name):
    s = re.sub(r"\s+", " ", (name or "").strip())
    s = re.sub(r"[\s,(]*\(?\b(as|the)\b.*security (agent|trustee).*$", "", s, flags=re.I)
    s = re.sub(r"\s*\(.*?\)\s*", " ", s)
    s = re.sub(r"\b(plc|limited|ltd|llp|ag|s\.?a\.?)\.?$", "", s.strip(), flags=re.I)
    return s.strip(" ,.") or name


def months_between(d1, d2):
    return (d2.year - d1.year) * 12 + d2.month - d1.month - (1 if d2.day < d1.day else 0)


def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    m += 1
    import calendar
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


# --------------------------------------------------------------------------- allowlist
def load_allowlist(strict):
    pats = []
    for line in open(ALLOWLIST_FILE):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = re.split(r"\s+#", line.rstrip("\n"), maxsplit=1)
        rx = parts[0].strip()
        check = len(parts) > 1 and "CHECK" in parts[1].upper()
        if strict and check:
            continue
        pats.append((re.compile(rx, re.I), rx, check))
    return pats


def allow_match(pats, *names):
    """Return (pattern, is_check) of the first allowlist hit, preferring confirmed lines."""
    hit = None
    for rx, raw, check in pats:
        if any(n and rx.search(n) for n in names):
            if not check:
                return raw, False
            hit = hit or (raw, True)
    return hit


# --------------------------------------------------------------------------- CH API
class CH:
    def __init__(self):
        src = open(CH_KEYS_SOURCE).read()
        block = re.search(r"API_KEYS\s*=\s*\[(.*?)\]", src, re.S).group(1)
        self.keys = re.findall(r"[\"']([0-9a-f]{8}-[0-9a-f-]{27})[\"']", block)
        if not self.keys:
            raise RuntimeError("no CH keys found")  # never print keys
        self.hits = {k: [] for k in self.keys}
        self.cool = {k: 0.0 for k in self.keys}
        self.i = 0
        self.fetched = 0
        self.cached = 0
        self.s = requests.Session()
        os.makedirs(CACHE_DIR, exist_ok=True)

    def _key(self):
        while True:
            now = time.time()
            for _ in range(len(self.keys)):
                k = self.keys[self.i % len(self.keys)]
                self.i += 1
                self.hits[k] = [t for t in self.hits[k] if now - t < 300]
                if self.cool[k] <= now and len(self.hits[k]) < 550:  # limit 600/5min
                    self.hits[k].append(now)
                    return k
            time.sleep(1)

    def get(self, path):
        fn = os.path.join(CACHE_DIR, re.sub(r"[^A-Za-z0-9]+", "_", path.strip("/")) + ".json")
        if os.path.exists(fn) and time.time() - os.path.getmtime(fn) < CACHE_TTL_DAYS * 86400:
            self.cached += 1
            return json.load(open(fn)).get("data")
        for attempt in range(6):
            k = self._key()
            try:
                r = self.s.get(CH_BASE + path, auth=(k, ""), timeout=30)
            except requests.RequestException:
                time.sleep(2 + attempt)
                continue
            if r.status_code == 429:
                self.cool[k] = time.time() + 60
                continue
            if r.status_code in (401, 403):
                self.cool[k] = time.time() + 3600
                continue
            if r.status_code >= 500:
                time.sleep(2 + attempt)
                continue
            data = r.json() if r.status_code == 200 else None
            self.fetched += 1
            json.dump({"status": r.status_code, "data": data}, open(fn, "w"))
            return data
        return None


# --------------------------------------------------------------------------- main
def main(argv=None):
    """CLI entry. Also importable: returns a dict with the shortlist and distress list."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="run date YYYY-MM-DD (default today)")
    ap.add_argument("--strict-lenders", action="store_true",
                    help="ignore allowlist lines marked '# CHECK'")
    ap.add_argument("--profile-pool", type=int, default=200)
    ap.add_argument("--deep", type=int, default=50)
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--per-class", type=int, default=5)
    ap.add_argument("--min-months", type=int, default=MIN_MONTHS,
                    help="youngest charge age in months (default %(default)s)")
    ap.add_argument("--max-months", type=int, default=MAX_MONTHS,
                    help="oldest charge age in months (default %(default)s)")
    a = ap.parse_args(argv)
    t0 = time.time()
    run = dt.date.fromisoformat(a.date) if a.date else dt.date.today()
    w_start, w_end = add_months(run, -a.max_months), add_months(run, -a.min_months)
    os.makedirs(OUT_DIR, exist_ok=True)
    stages = []

    conn = psycopg2.connect(DSN)
    conn.set_session(readonly=True, autocommit=True)  # READ ONLY session

    rows = q(conn, """
        select c.company_number, c.lender, c.date_created, c.property_description,
               lc.lender_type, lc.trading_name, s.company_name, s.psc, s.postcode
        from public.charges c
        left join public.lender_classifications lc on lc.lender = c.lender
        left join public.spv_companies s on s.company_number = c.company_number
        where c.status = 'outstanding' and not coalesce(c.excluded, false)
          and c.date_created ~ '^\\d{4}-\\d{2}-\\d{2}$'
          and c.date_created between %s and %s""", (w_start.isoformat(), w_end.isoformat()))

    def stage(label, rs):
        stages.append((label, len(rs), len({r["company_number"] for r in rs})))
        return rs

    for r in rows:
        r["lname"] = norm_lender(r["trading_name"] or r["lender"])
        r["company_name"] = r["company_name"] or ""
    stage(f"Outstanding charges created {a.min_months}-{a.max_months}m ago", rows)
    rows = stage("Lender type institution/trustee",
                 [r for r in rows if r["lender_type"] in ("institution", "trustee")])
    rows = stage("Minus BTL / residential lenders",
                 [r for r in rows if not BTL_LENDERS.search(r["lname"])
                  and not BTL_LENDERS.search(r["lender"] or "")])
    rows = stage("Minus housebuilder / land-seller chargees",
                 [r for r in rows if not HOUSEBUILDERS.search(r["lender"] or "")])
    pre_allow = rows

    # borrower-is-a-lender screen: names that appear as institutional chargees elsewhere
    lender_names = {norm(x["lender"]) for x in q(conn, """
        select lender from public.lender_classifications
        where lender_type in ('institution','trustee') and coalesce(charge_count,0) >= 5""")}

    def borrower_ok(r):
        return (r["company_name"] and not FINANCE_BORROWER.search(r["company_name"])
                and norm(r["company_name"]) not in lender_names)

    def classify_charge(r):
        for k in CLASS_ORDER:
            if NAME_RX[k].search(r["company_name"]):
                return k, "name"
        for k in CLASS_ORDER:
            if r["property_description"] and DESC_RX[k].search(r["property_description"]):
                return k, "desc"
        return None, None

    # ---- lender review helper (target-class borrowers, before allowlist) ----
    pats = load_allowlist(a.strict_lenders)
    all_pats = load_allowlist(False)
    lrev = defaultdict(lambda: {"charges": 0, "cos": set(), "raw": Counter(), "types": set()})
    for r in pre_allow:
        if not borrower_ok(r):
            continue
        cls, _ = classify_charge(r)
        if not cls:
            continue
        d = lrev[r["lname"]]
        d["charges"] += 1
        d["cos"].add(r["company_number"])
        d["raw"][r["lender"]] += 1
        d["types"].add(r["lender_type"])
    rev_path = os.path.join(OUT_DIR, f"lender-review-{run}.csv")
    with open(rev_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rank", "lender_normalised", "charges_in_window_target_classes",
                    "companies", "lender_type", "allowlist_match", "allowlist_pattern",
                    "example_raw_names", "add_to_allowlist (tick)"])
        top = sorted(lrev.items(), key=lambda kv: -kv[1]["charges"])[:100]
        for i, (ln, d) in enumerate(top, 1):
            hit = allow_match(all_pats, ln, *d["raw"].keys())
            w.writerow([i, ln, d["charges"], len(d["cos"]), "/".join(sorted(d["types"])),
                        "no" if not hit else ("yes-CHECK" if hit[1] else "yes"),
                        hit[0] if hit else "",
                        " | ".join(n for n, _ in d["raw"].most_common(3)), ""])

    for r in rows:
        r["allow"] = allow_match(pats, r["lname"], r["lender"])
    rows = stage("Lender on GBP 10m+ allowlist" + (" (strict, no CHECK)" if a.strict_lenders
                                                    else " (incl. CHECK entries)"),
                 [r for r in rows if r["allow"]])
    rows = stage("Minus finance-named / lender borrowers", [r for r in rows if borrower_ok(r)])

    # ---- company aggregation ----
    cos = {}
    for r in rows:
        c = cos.setdefault(r["company_number"], {
            "company_number": r["company_number"], "name": r["company_name"], "psc_db": r["psc"],
            "postcode": r["postcode"], "charges": [], "cls_votes": Counter(), "evidence": []})
        c["charges"].append(r)
        cls, src = classify_charge(r)
        if cls:
            c["cls_votes"][cls] += 1
            ev = f"{src}: " + (NAME_RX[cls].search(r["company_name"]).group(0) if src == "name"
                               else DESC_RX[cls].search(r["property_description"]).group(0))
            if ev not in c["evidence"]:
                c["evidence"].append(ev)

    # newer institutional charges (possible refinance already done) + total outstanding
    nums = list(cos)
    later = Counter()
    total_out = Counter()
    if nums:
        for x in q(conn, """
            select c.company_number, c.date_created, c.lender, lc.lender_type
            from public.charges c left join public.lender_classifications lc on lc.lender=c.lender
            where c.status='outstanding' and not coalesce(c.excluded,false)
              and c.company_number = any(%s)""", (nums,)):
            total_out[x["company_number"]] += 1
            if (x["lender_type"] in ("institution", "trustee") and x["date_created"]
                    and x["date_created"] > w_end.isoformat()):
                later[x["company_number"]] += 1

    for c in cos.values():
        c["cls"] = c["cls_votes"].most_common(1)[0][0] if c["cls_votes"] else None
        c["n"] = len(c["charges"])
        c["n_total"] = total_out[c["company_number"]]
        c["later"] = later[c["company_number"]]
        c["lenders"] = sorted({r["lname"] for r in c["charges"]})
        c["lender_check"] = all(r["allow"][1] for r in c["charges"])
        c["dates"] = sorted(r["date_created"] for r in c["charges"])
        c["corp_psc_db"] = bool(re.search(r"\b(limited|ltd|plc|llp|lp|s\.?a\.?r\.?l|b\.?v)\b",
                                          c["psc_db"] or "", re.I))
        c["trustee"] = any(r["lender_type"] == "trustee" or
                           re.search(r"security (agent|trustee)", r["lender"] or "", re.I)
                           for r in c["charges"])
        s = TARGET_PRIORITY.get(c["cls"], 0)
        s += min(c["n"], 10) * 3
        s += 8 if not c["lender_check"] else 2
        s += 6 if c["trustee"] else 0
        s += 10 if c["corp_psc_db"] else 0
        s -= 10 if c["later"] else 0
        c["pre"] = s
    stages.append(("Companies classified into a target asset class (name/desc)",
                   sum(1 for c in cos.values() if c["cls"]),
                   sum(1 for c in cos.values() if c["cls"])))

    # ---- CH profile for the pre-score pool ----
    ch = CH()
    pool = sorted(cos.values(), key=lambda c: -c["pre"])[:a.profile_pool]
    distress, alive = [], []
    for c in pool:
        p = ch.get(f"/company/{c['company_number']}") or {}
        c["profile"] = p
        status = p.get("company_status") or "unknown"
        c["status"] = status
        c["sic"] = p.get("sic_codes") or []
        c["acc_type"] = ((p.get("accounts") or {}).get("last_accounts") or {}).get("type")
        c["acc_overdue"] = bool((p.get("accounts") or {}).get("overdue"))
        c["insolv"] = bool(p.get("has_insolvency_history"))
        if p.get("company_name"):
            c["name"] = p["company_name"]
        if status in CLOSED_STATUS:
            continue
        if status in DISTRESS_STATUS or c["insolv"] or status != "active":
            distress.append(c)
            continue
        if any(FINANCE_SIC.match(s) for s in c["sic"]):
            continue
        # SIC confirm / upgrade
        sic_cls = next((sic_class(s) for s in c["sic"] if sic_class(s)), None)
        c["sic_note"] = ""
        if sic_cls and sic_cls == c["cls"]:
            c["sic_note"] = "SIC confirms"
        elif sic_cls and not c["cls"]:
            c["cls"] = sic_cls
            c["sic_note"] = "class from SIC"
        elif sic_cls and c["cls"] and sic_cls != c["cls"]:
            c["sic_note"] = f"SIC suggests {sic_cls}"
        elif any(s.startswith("68") for s in c["sic"]):
            c["sic_note"] = "SIC 68 property"
        s = c["pre"] - (TARGET_PRIORITY.get(c["cls_votes"].most_common(1)[0][0], 0)
                        if c["cls_votes"] else 0) + TARGET_PRIORITY.get(c["cls"], 0)
        s += ACCOUNTS_SCORE.get(c["acc_type"], 0)
        s += 5 if c["sic_note"] == "SIC confirms" else 0
        s -= 10 if c["acc_overdue"] else 0
        c["score"] = s
        alive.append(c)
    stages.append(("Profile-checked pool (top by pre-score)", len(pool), len(pool)))
    stages.append(("Active, no insolvency history, non-finance SIC", len(alive), len(alive)))

    # ---- deep fetch: officers + PSC ----
    deep = sorted([c for c in alive if c["cls"]], key=lambda c: -c["score"])[:a.deep]
    for c in deep:
        off = ch.get(f"/company/{c['company_number']}/officers?items_per_page=100") or {}
        c["directors"] = [
            f"{o.get('name')} (appointed {o.get('appointed_on', '?')})"
            for o in off.get("items", [])
            if o.get("officer_role") in ("director", "corporate-director", "llp-member",
                                         "llp-designated-member") and not o.get("resigned_on")]
        ps = ch.get(f"/company/{c['company_number']}/persons-with-significant-control"
                    "?items_per_page=100") or {}
        live = [x for x in ps.get("items", []) if not x.get("ceased_on")]
        c["parents"] = [x.get("name") for x in live if "corporate" in (x.get("kind") or "")
                        or "legal-person" in (x.get("kind") or "")]
        c["psc_people"] = [x.get("name") for x in live if "individual" in (x.get("kind") or "")]
        c["bank_owned"] = any(FINANCE_BORROWER.search(p or "") for p in c["parents"])
        if c["bank_owned"]:
            c["score"] -= 20  # bank/fund-vehicle shareholder: PFI/PPP or lender-owned SPV
        if c["parents"] and not c["corp_psc_db"]:
            c["score"] += 10
        elif not c["parents"] and c["corp_psc_db"]:
            c["score"] -= 5  # DB said corporate, CH now says not
    stages.append(("Deep-checked (officers + PSC)", len(deep), len(deep)))

    # ---- balanced pick ----
    picked, per, seen_grp = [], Counter(), {}
    for c in sorted(deep, key=lambda c: -c["score"]):
        keys = {norm(x) for x in [c["name"]] + (c.get("parents") or [])}
        hit = next((seen_grp[k] for k in keys if k in seen_grp), None)
        if hit:  # one SPV per parent group (incl. parent/child pairs); note siblings
            hit.setdefault("siblings", []).append(f"{c['name']} ({c['company_number']})")
            continue
        if per[c["cls"]] >= a.per_class:
            continue
        for k in keys:
            seen_grp[k] = c
        picked.append(c)
        per[c["cls"]] += 1
        if len(picked) >= a.top:
            break
    stages.append(("Shortlist (balanced, max %d per class, 1 per parent group)" % a.per_class, len(picked),
                   len(picked)))

    # ---- contact matching (tp tenant only) ----
    contacts = q(conn, """select email, first_name, last_name, title, company, company_domain,
                                 tags from public.contacts where tenant = 'tp'""")
    supp = q(conn, """select lower(email) email, lower(domain) domain, reason
                      from public.suppressed_emails where tenant = 'tp'""")
    supp_email = {s["email"]: s["reason"] for s in supp}
    supp_domain = {s["domain"]: s["reason"] for s in supp
                   if s["domain"] and re.search(r"domain", s["reason"] or "", re.I)}
    FREE = re.compile(r"gmail|hotmail|outlook|yahoo|icloud|aol|btinternet|live\.|me\.com|"
                      r"googlemail|msn|sky\.com|virginmedia|talktalk|protonmail")
    by_name, by_dom, by_first2 = defaultdict(list), defaultdict(list), defaultdict(list)
    for ct in contacts:
        nk = norm(ct["company"])
        if len(nk) > 3:
            by_name[nk].append(ct)
            toks = nk.split()
            if len(toks) >= 2 and len(toks[0]) >= 4:
                by_first2[" ".join(toks[:2])].append(ct)
        dom = (ct["company_domain"] or (ct["email"] or "").split("@")[-1]).lower()
        dom = re.sub(r"^www\.", "", dom)
        if dom and not FREE.search(dom):
            stem = dom.split(".")[0]
            if len(stem) >= 5:
                by_dom[stem].append(ct)

    def match(c):
        out = {}
        keys = [(c["name"], "SPV")] + [(p, "parent") for p in c.get("parents", [])]
        for nm, kind in keys:
            nk = norm(nm)
            if len(nk) <= 3:
                continue
            for ct in by_name.get(nk, []):
                out.setdefault(ct["email"].lower(), (ct, f"company name = {kind}"))
            for ct in by_dom.get(nk.replace(" ", ""), []):
                out.setdefault(ct["email"].lower(), (ct, f"email domain = {kind}"))
            toks = nk.split()
            if len(toks) >= 2 and len(toks[0]) >= 4:
                for ct in by_first2.get(" ".join(toks[:2]), []):
                    out.setdefault(ct["email"].lower(), (ct, f"possible (first words of {kind})"))
        res = []
        for em, (ct, how) in list(out.items())[:6]:
            flags = []
            if em in supp_email:
                flags.append(f"suppressed: {supp_email[em]}")
            d = em.split("@")[-1]
            if d in supp_domain:
                flags.append(f"domain suppressed: {supp_domain[d]}")
            for t in ct["tags"] or []:
                if t.lower() in ("unsubscribed", "hold"):
                    flags.append(f"tag: {t}")
            res.append({"name": f"{ct['first_name'] or ''} {ct['last_name'] or ''}".strip(),
                        "email": ct["email"], "title": ct["title"] or "", "how": how,
                        "flags": flags})
        return res

    for c in picked:
        c["contacts"] = match(c)
        c["dnc"] = any(x["flags"] for x in c["contacts"])

    # ---- outputs ----
    def mo(d):
        return months_between(dt.date.fromisoformat(d), run)

    def ym(m):
        y, r = divmod(m, 12)
        return f"{y} year{'s' if y != 1 else ''}" + (f" {r} month{'s' if r != 1 else ''}" if r else "")

    def why(c):
        first = c["dates"][0]  # earliest charge = first to reach 5 years
        m1 = mo(first)
        to5 = add_months(dt.date.fromisoformat(first), 60)
        left = 60 - m1
        when = (f"reaches 5 years in ~{left} month{'s' if left != 1 else ''} ({to5:%b %Y})"
                if left >= 1 else f"reaches 5 years this month ({to5:%b %Y})")
        lender = c["lenders"][0] + (" +" if len(c["lenders"]) > 1 else "")
        n = c["n"]
        bits = [f"{lender} charge registered {ym(m1)} ago, {when}, still outstanding"
                + (f" ({n} charges in window)" if n > 1 else "")]
        if c["later"]:
            bits.append("NB newer institutional charge exists (may already be refinanced)")
        return "; ".join(bits)

    md_path = os.path.join(OUT_DIR, f"radar-{run}.md")
    csv_path = os.path.join(OUT_DIR, f"radar-{run}.csv")
    L = [f"# Maturity radar, {run}", "",
         f"Window: outstanding charges created {w_start} to {w_end} "
         f"({a.min_months}-{a.max_months} months old, still outstanding). "
         "Source: public Companies House data only. For Marcus to approve personal one-to-one "
         "outreach; nothing is sent automatically.", "",
         "Lender allowlist: `scripts/radar_lenders_10m_plus.txt`"
         + (" (strict: CHECK lines ignored)" if a.strict_lenders else
            " (CHECK lines active; flagged 'lender unverified')")
         + f". Lender review helper: `reports/radar/lender-review-{run}.csv`.", "",
         "## Filter funnel", "", "| Stage | Charges/rows | Companies |", "|---|---:|---:|"]
    L += [f"| {s} | {n:,} | {k:,} |" for s, n, k in stages]
    L += ["", f"## Shortlist ({len(picked)})", ""]
    for i, c in enumerate(picked, 1):
        L += [f"### {i}. {c['name']} ({c['company_number']})"
              + ("  **DO NOT CONTACT**" if c["dnc"] else ""), "",
              f"- CH: {CH_LINK.format(c['company_number'])}",
              f"- Parent / PSC: {'; '.join(c.get('parents') or []) or '(no corporate PSC)'}"
              + (f" | individuals: {'; '.join(c['psc_people'])}" if c.get("psc_people") else ""),
              f"- Asset class: **{c['cls']}** (evidence: {', '.join(c['evidence'][:4]) or '-'}"
              f"{'; ' + c['sic_note'] if c.get('sic_note') else ''}; SIC {', '.join(c['sic'])})",
              f"- Window charges: {c['n']} (outstanding total {c['n_total']}); dates "
              + ", ".join(f"{d} ({mo(d)}m)" for d in c["dates"][:6])
              + (" ..." if c["n"] > 6 else ""),
              *([f"- Sibling SPVs under same parent (also in window): {'; '.join(c['siblings'])}"]
                if c.get("siblings") else []),
              f"- Lender(s): {'; '.join(c['lenders'])}"
              + (" (lender unverified: allowlist CHECK)" if c["lender_check"] else ""),
              f"- Property: {(c['charges'][0]['property_description'] or '-')[:220]}"
              f" | postcode {c['postcode'] or '-'}",
              f"- Accounts: {c['acc_type'] or 'none filed'}"
              + (" (OVERDUE)" if c["acc_overdue"] else ""),
              f"- Directors: {'; '.join(c.get('directors') or []) or '-'}",
              "- Existing contact: " + ("; ".join(
                  f"{x['name']} <{x['email']}> [{x['how']}]"
                  + (f" FLAGS: {', '.join(x['flags'])}" if x["flags"] else "")
                  for x in c["contacts"]) or "none"),
              f"- Score: {c['score']}",
              f"- Why now: {why(c)}", ""]
    L += ["## Distress (not targeted; noted only)", ""]
    for c in distress:
        L.append(f"- {c['name']} ({c['company_number']}): status {c['status']}"
                 f"{', insolvency history' if c['insolv'] else ''}; {c['n']} window charge(s) "
                 f"with {'; '.join(c['lenders'][:3])}")
    if not distress:
        L.append("- none in profile pool")
    L += ["", f"_Generated {dt.datetime.now():%Y-%m-%d %H:%M} in {time.time() - t0:.0f}s; "
              f"CH API fetched {ch.fetched}, cache hits {ch.cached}. Contains personal data "
              "(directors' names): internal only._"]
    open(md_path, "w").write("\n".join(L) + "\n")

    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rank", "company_number", "company_name", "ch_link", "asset_class",
                    "class_evidence", "sic_codes", "window_charges", "total_outstanding",
                    "first_charge", "last_charge", "months_old_first", "lenders",
                    "lender_unverified", "postcode", "property_description", "accounts_type",
                    "parents", "directors", "contacts", "do_not_contact", "score", "why_now"])
        for i, c in enumerate(picked, 1):
            w.writerow([i, c["company_number"], c["name"], CH_LINK.format(c["company_number"]),
                        c["cls"], "; ".join(c["evidence"]) + ("; " + c["sic_note"]
                                                              if c.get("sic_note") else ""),
                        " ".join(c["sic"]), c["n"], c["n_total"], c["dates"][0], c["dates"][-1],
                        mo(c["dates"][0]), "; ".join(c["lenders"]), c["lender_check"],
                        c["postcode"] or "", (c["charges"][0]["property_description"] or "")[:300],
                        c["acc_type"] or "", "; ".join(c.get("parents") or []),
                        "; ".join(c.get("directors") or []),
                        "; ".join(f"{x['name']} <{x['email']}>" + (" [" + ", ".join(x["flags"])
                                                                  + "]" if x["flags"] else "")
                                  for x in c["contacts"]),
                        "DO NOT CONTACT" if c["dnc"] else "", c["score"], why(c)])

    print(f"Run date {run}; window {w_start}..{w_end}; {time.time() - t0:.0f}s; "
          f"CH fetched {ch.fetched} cached {ch.cached}")
    for s, n, k in stages:
        print(f"  {s:<62} {n:>8,} {k:>8,}")
    print(f"Distress noted: {len(distress)}")
    print(f"Wrote {md_path}\n      {csv_path}\n      {rev_path}")
    conn.close()
    return {"run": run, "window": (w_start, w_end), "picked": picked, "distress": distress,
            "stages": stages, "why": why, "months_old": mo, "md_path": md_path,
            "csv_path": csv_path}


if __name__ == "__main__":
    main()
    sys.exit(0)
