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

    def _doc_get(self, url, accept):
        """Document API GET with key rotation / rate limiting. The content endpoint
        redirects to S3; requests drops the auth header on the cross-host redirect."""
        for attempt in range(6):
            k = self._key()
            try:
                r = self.s.get(url, auth=(k, ""), headers={"Accept": accept}, timeout=60)
            except requests.RequestException:
                time.sleep(2 + attempt)
                continue
            if r.status_code == 429:
                self.cool[k] = time.time() + 60
                continue
            if r.status_code in (401, 403) and "document-api" in r.url:
                self.cool[k] = time.time() + 3600
                continue
            if r.status_code >= 500:
                time.sleep(2 + attempt)
                continue
            self.fetched += 1
            return r if r.status_code == 200 else None
        return None

    def _doc_id(self, url):
        return re.sub(r"[^A-Za-z0-9_-]+", "_", url.rstrip("/").split("/document/")[-1].split("/")[0])

    def doc_meta(self, url):
        os.makedirs(DOC_CACHE_DIR, exist_ok=True)
        fn = os.path.join(DOC_CACHE_DIR, self._doc_id(url) + ".meta.json")
        if os.path.exists(fn):
            self.cached += 1
            return json.load(open(fn))
        r = self._doc_get(url, "application/json")
        if not r:
            return None
        data = r.json()
        json.dump(data, open(fn, "w"))
        return data

    def doc_content(self, url, mime):
        os.makedirs(DOC_CACHE_DIR, exist_ok=True)
        fn = os.path.join(DOC_CACHE_DIR, self._doc_id(url) + ".xhtml")
        if os.path.exists(fn) and os.path.getsize(fn):
            self.cached += 1
            return open(fn, "rb").read()
        r = self._doc_get(url, mime)
        if not r or "html" not in (r.headers.get("content-type") or "") and \
                "xml" not in (r.headers.get("content-type") or ""):
            return None
        open(fn, "wb").write(r.content)
        return r.content


# --------------------------------------------------------------------------- accounts (debt size)
# Estimated debt from the latest filed accounts: CH filing history (category=accounts) ->
# Document API metadata -> iXBRL (application/xhtml+xml) if available. PDF-only filings
# are recorded as such and never OCR'd. Documents are immutable, so cached indefinitely.
DOC_CACHE_DIR = os.path.join(OUT_DIR, "accounts_cache")
FILING_LINK = "https://find-and-update.company-information.service.gov.uk/company/{}/filing-history"
DEBT_MIN = 10_000_000
DEBT_BOOST = 15
ACCOUNTS_FORMS = {"AA", "AAMD"}
# Concept local names (namespace-agnostic: uk-core / FRS102 / older uk-gaap).
BANK_RX = re.compile(r"^(BankBorrowings(Overdrafts)?|BankLoans(Overdrafts)?|BankLoansAndOverdrafts|"
                     r"LoansFromBanks\w*|BankLoansSecured|SecuredBankLoans)$")
BORROW_RX = re.compile(r"^(Borrowings|TotalBorrowings|LoansBorrowings|SecuredDebts|"
                       r"InterestBearingLoansBorrowings)$")
CRED_AFTER_RX = re.compile(r"^(CreditorsDueAfterOneYear|CreditorsAmountsFallingDueAfterMoreThanOneYear|"
                           r"AmountsFallingDueAfterMoreThanOneYear|CreditorsDueAfterMoreThanOneYear)$")
CRED_WITHIN_RX = re.compile(r"^(CreditorsDueWithinOneYear|CreditorsAmountsFallingDueWithinOneYear|"
                            r"AmountsFallingDueWithinOneYear)$")
CUR_DIM, MAT_DIM, GRP_DIM = ("FinancialInstrumentCurrentNon-currentDimension",
                             "MaturitiesOrExpirationPeriodsDimension",
                             "ConsolidatedGroupCompanyDimension")
# maturity members -> (from, to) years, for non-overlapping summation of buckets
MATURITY = {"WithinOneYear": (0, 1), "AfterOneYear": (1, 99), "BetweenOneFiveYears": (1, 5),
            "BetweenOneTwoYears": (1, 2), "BetweenTwoFiveYears": (2, 5),
            "MoreThanFiveYears": (5, 99), "AfterTwoYears": (2, 99)}


def _local(s):
    return (s or "").split(":")[-1]


def _ix_value(el):
    """Numeric value of an ix:nonFraction honouring format, scale and sign."""
    if el.get("{http://www.w3.org/2001/XMLSchema-instance}nil") == "true":
        return None
    txt = "".join(el.itertext()).strip()
    fmt = _local(el.get("format")).lower()
    if "zero" in fmt or txt in ("", "-", "–", "—", "nil"):
        v = 0.0
    else:
        # comma-decimal formats (1.234,56): ixt numcommadecimal / numdotcomma / numspacecomma,
        # ixt-sec num-comma-decimal. NB ixt1 'numcommadot' is comma-thousands, dot-decimal.
        if fmt in ("numcommadecimal", "numdotcomma", "numspacecomma", "num-comma-decimal",
                   "numcomma"):
            txt = txt.replace(".", "").replace(" ", "").replace(",", ".")
        else:
            txt = txt.replace(",", "").replace(" ", "")
        txt = re.sub(r"[^0-9.]", "", txt)
        if not txt:
            return None
        try:
            v = float(txt)
        except ValueError:
            return None
    try:
        v *= 10 ** int(el.get("scale") or 0)
    except ValueError:
        pass
    return -v if el.get("sign") == "-" else v


def parse_ixbrl(raw, made_up=None):
    """Return {'date', 'bank', 'borrowings', 'cred_after', 'cred_within', 'inv_prop',
    'fixed', 'current', 'total_assets'} for the latest balance-sheet instant."""
    from lxml import etree
    root = etree.fromstring(raw, etree.XMLParser(recover=True, huge_tree=True))
    if root is None:
        return None
    ctx = {}
    for el in root.iter("{*}context"):
        inst = next((x.text for x in el.iter("{*}instant")), None)
        dims = {_local(m.get("dimension")): _local((m.text or "").strip())
                for m in el.iter("{*}explicitMember")}
        if any(True for _ in el.iter("{*}typedMember")):
            dims["_typed"] = "1"
        ctx[el.get("id")] = (inst and inst.strip(), dims)
    units = {el.get("id"): " ".join(x.text or "" for x in el.iter("{*}measure"))
             for el in root.iter("{*}unit")}
    facts = []  # (concept, instant, dims, value)
    for el in root.iter("{*}nonFraction"):
        c = ctx.get(el.get("contextRef"))
        unit = units.get(el.get("unitRef"), el.get("unitRef") or "")
        if not c or not c[0] or "GBP" not in unit.upper():
            continue
        v = _ix_value(el)
        if v is not None:
            facts.append((_local(el.get("name")), c[0], c[1], v))
    if not facts:
        return None
    insts = sorted({f[1] for f in facts})
    date = made_up if made_up in insts else insts[-1]
    at = [f for f in facts if f[1] == date]

    def total(rx):
        """Largest per-concept total at `date` across matching concepts (no double count)."""
        best = None
        for concept in {f[0] for f in at if rx.match(f[0])}:
            fs = [f for f in at if f[0] == concept]
            ok = []
            for f in fs:
                d = dict(f[2])
                if d.pop(GRP_DIM, "Group") not in ("Group", "ConsolidatedGroup"):
                    continue
                if set(d) - {CUR_DIM, MAT_DIM}:
                    continue
                ok.append((d, abs(f[3])))
            if not ok:
                continue
            plain = [v for d, v in ok if not d]
            if plain:
                val = max(plain)
            else:
                val = 0.0
                for cur in {d.get(CUR_DIM) for d, _ in ok}:
                    grp = [(d, v) for d, v in ok if d.get(CUR_DIM) == cur]
                    only = [v for d, v in grp if MAT_DIM not in d]
                    if only:
                        val += max(only)
                        continue
                    # non-overlapping maturity buckets, widest first
                    buckets = {}
                    for d, v in grp:
                        buckets[d[MAT_DIM]] = max(v, buckets.get(d[MAT_DIM], 0))
                    taken = []
                    for m in sorted(buckets, key=lambda m: -(MATURITY.get(m, (0, 0))[1]
                                                            - MATURITY.get(m, (0, 0))[0])):
                        if m not in MATURITY:
                            continue
                        a0, a1 = MATURITY[m]
                        if all(a1 <= b0 or a0 >= b1 for b0, b1 in taken):
                            taken.append((a0, a1))
                            val += buckets[m]
            best = val if best is None else max(best, val)
        return best

    def split(concept, which):
        """A concept's value in the current / non-current dimension member."""
        member = "CurrentFinancialInstruments" if which == "within" else "Non-currentFinancialInstruments"
        vals = [abs(f[3]) for f in at if f[0] == concept and f[2].get(CUR_DIM) == member
                and set(f[2]) <= {CUR_DIM, GRP_DIM} and f[2].get(GRP_DIM, "Group") == "Group"]
        return max(vals) if vals else None

    def creditors(which):
        """Creditors (generic concept split by dimension, or older explicit concepts),
        net of amounts owed to group undertakings where those are tagged."""
        rx = CRED_WITHIN_RX if which == "within" else CRED_AFTER_RX
        cands = [v for v in (split("Creditors", which), total(rx)) if v is not None]
        if not cands:
            return None
        grp = split("AmountsOwedToGroupUndertakings", which) or 0
        return max(max(cands) - grp, 0.0)

    inv = total(re.compile(r"^InvestmentProperty$"))
    fixed = total(re.compile(r"^(FixedAssets|NonCurrentAssets)$"))
    cur = total(re.compile(r"^CurrentAssets$"))
    tot = total(re.compile(r"^(TotalAssets|Assets)$"))
    if tot is None and fixed is not None and cur is not None:
        tot = fixed + cur
    subs = total(re.compile(r"^(InvestmentsFixedAssets|InvestmentsInGroupUndertakings|"
                            r"InvestmentsInSubsidiaries)$"))
    ppe = total(re.compile(r"^PropertyPlantEquipment$"))
    base = tot or ((fixed or subs or 0) + (cur or 0))
    holdco = bool(subs and base and subs >= 0.5 * base and not inv and (ppe or 0) < 0.25 * base)
    return {"holdco": holdco, "subs": subs, "date": date, "bank": total(BANK_RX), "borrowings": total(BORROW_RX),
            "cred_after": creditors("after"), "cred_within": creditors("within"),
            "inv_prop": inv, "fixed": fixed, "current": cur, "total_assets": tot}


def _gbp(v):
    return f"£{v / 1e6:.1f}m" if v >= 1e6 else f"£{v / 1e3:,.0f}k" if v >= 1e3 else f"£{v:,.0f}"


def _dlong(iso):
    try:
        return dt.date.fromisoformat(iso).strftime("%-d %b %Y")
    except (TypeError, ValueError):
        return iso or "?"


USE_ACCOUNTS_DEBT = False


def debt_from_accounts(ch, cn):
    """Estimate debt from the latest filed accounts. Never raises.
    Returns dict: status (ixbrl|pdf|none|error), debt (float|None), basis, made_up,
    inv_prop, total_assets, link, form."""
    out = {"status": "none", "debt": None, "basis": "", "made_up": None, "inv_prop": None,
           "total_assets": None, "link": FILING_LINK.format(cn), "accounts_type": None}
    try:
        fh = ch.get(f"/company/{cn}/filing-history?category=accounts&items_per_page=25") or {}
        items = [i for i in fh.get("items", []) if i.get("type") in ACCOUNTS_FORMS
                 and (i.get("links") or {}).get("document_metadata")]
        if not items:
            out["basis"] = "no accounts filing with a document on CH"
            return out
        it = max(items, key=lambda i: ((i.get("description_values") or {}).get("made_up_date") or "",
                                       i.get("date") or ""))
        out["made_up"] = (it.get("description_values") or {}).get("made_up_date")
        out["accounts_type"] = (it.get("description") or "").replace("accounts-with-accounts-type-", "")
        meta = ch.doc_meta(it["links"]["document_metadata"])
        if not meta:
            out.update(status="error", basis="document metadata unavailable")
            return out
        res = meta.get("resources") or {}
        if "application/xhtml+xml" not in res:
            out.update(status="pdf", basis="accounts PDF only, debt not extracted")
            return out
        raw = ch.doc_content(meta["links"]["document"], "application/xhtml+xml")
        if not raw:
            out.update(status="error", basis="iXBRL download failed")
            return out
        p = parse_ixbrl(raw, out["made_up"])
        if not p:
            out.update(status="error", basis="iXBRL had no tagged values")
            return out
        out["status"] = "ixbrl"
        out["made_up"] = p["date"]
        out["inv_prop"] = p["inv_prop"]
        out["total_assets"] = p["total_assets"]
        d = _dlong(p["date"])
        bank, borr = p["bank"], p["borrowings"]
        explicit = max([v for v in (bank, borr) if v], default=None)
        exp_lbl = "bank borrowings" if explicit and explicit == bank else "borrowings"
        ca, cw = p["cred_after"], p["cred_within"]
        big = [v for v in (explicit, ca, (ca or 0) + (cw or 0)) if v and v >= DEBT_MIN]
        if p["holdco"] and not big:
            # holding company: facility usually sits in the subsidiaries, so small entity-level
            # figures say nothing about group debt. Leave unknown (eligible), never exclude.
            out.update(status="holdco", basis=f"holding company accounts at {d} (investments in "
                       f"subsidiaries {_gbp(p['subs'])}), group debt not extracted")
            return out
        if explicit and explicit >= DEBT_MIN:
            out.update(debt=explicit, basis=f"{exp_lbl} at {d}")
        elif ca and ca >= DEBT_MIN:
            out.update(debt=ca, basis=f"creditors > 1 yr (excl. group) at {d}"
                       + (f" ({exp_lbl} tagged {_gbp(explicit)})" if explicit else ""))
        elif ca is not None and cw is not None and ca + cw >= DEBT_MIN:
            # facility may have been reclassified as due within one year near maturity
            out.update(debt=ca + cw, basis=f"total creditors excl. group (incl. < 1 yr) at {d}")
        elif explicit:
            out.update(debt=explicit, basis=f"{exp_lbl} at {d}")
        elif ca is not None:
            out.update(debt=ca, basis=f"creditors > 1 yr (excl. group) at {d}")
        elif cw is not None:
            out.update(debt=cw, basis=f"creditors < 1 yr only (excl. group) at {d}")
        else:
            out["basis"] = f"no borrowings or creditors tagged at {d}"
    except Exception as ex:  # never break the radar on an accounts problem
        out.update(status="error", basis=f"accounts lookup failed ({type(ex).__name__})")
    return out


# --------------------------------------------------------------------------- property charged
CHARGES_LINK = "https://find-and-update.company-information.service.gov.uk/company/{}/charges"
CH_SITE = "https://find-and-update.company-information.service.gov.uk"
GENERIC_DESC = re.compile(
    r"^\W*(not applicable|n\s*/?\s*a|none|nil|see (the )?(instrument|deed|charge|schedule)|"
    r"all (the )?(assets|property( and|,) undertaking|present and future)|"
    r"(the )?(charge|instrument|deed) (contains|includes)|no (specific )?(land|property))", re.I)
TITLE_KW = re.compile(r"title\s*(?:numbers?|nos?\.?|no\.?)?\s*:?", re.I)
TITLE_RX = re.compile(r"\b([A-Z]{1,3}\d{1,7})\b(?!\s?\d[A-Z]{2}\b)", re.I)
ADDR_PREFIX = re.compile(
    r"^\W*(by way of (a )?(first )?legal (mortgage|charge)( over| of)?\s*)?(all (that|those)|the)?\s*"
    r"((freehold|leasehold|commonhold)( and (freehold|leasehold))?\s*)?"
    r"(land|property|properties|premises|site|interest)?( and buildings?)?"
    r"\s*((known as|situated? at|at|being|comprising|lying (to the \w+ of|at))\s*)?", re.I)
ADDR_SUFFIX = re.compile(r"[,;\s]*(\(?\s*(as )?(the same is )?(registered|comprised)\b.*|with title.*|"
                         r"(under |being )?title\s*(numbers?|nos?)?\s*:?\s*[A-Z]{1,3}\d.*|and (all|any) (buildings|fixtures).*|"
                         r"\sand|\sbetween\s.*)$", re.I | re.S)


def get_ccod_titles(company_number):
    """Plug-in point for the staged HM Land Registry CCOD pipeline (/root/ccod_charge_pipeline.py).
    Should return [{'title': 'AB12345', 'address': '...', 'tenure': 'Freehold'}] for titles the
    company owns. Returns [] until an HMLR_API_KEY is supplied and the lookup is wired in."""
    if not os.environ.get("HMLR_API_KEY", "").strip():
        return []
    return []  # TODO: wire CCOD lookup (company number -> owned titles) once the key exists


def _titles(desc):
    m = TITLE_KW.search(desc)
    seg = desc[m.end():m.end() + 250] if m else desc
    found = [t.upper() for t in TITLE_RX.findall(seg)
             if m or (re.match(r"^[A-Z]{2,3}\d{3,7}$", t.upper()))]
    return list(dict.fromkeys(found))


def _clean_addr(desc):
    a = re.sub(r"\s+", " ", desc).strip()
    a = re.sub(r"^\(?\s*\d{1,2}[.)]\s+", "", a)  # leading "1." numbering
    m = re.search(r"\b(known as|situate[d]? (at|and known as))( and forming( part of)?)?\s+", a[:200], re.I)
    if m:
        a = a[m.end():]
    a = ADDR_SUFFIX.sub("", a)
    a = ADDR_PREFIX.sub("", a, count=1)
    a = a.strip(" ,.;:-")
    if len(a) > 160:
        a = a[:157].rsplit(" ", 1)[0] + "..."
    return a[:1].upper() + a[1:] if a else a


def charge_property(ch, c):
    """Address of the property secured by the qualifying (window) charges, from the CH
    charges API particulars. Never raises."""
    cn = c["company_number"]
    out = {"address": None, "titles": [], "more": 0, "generic": True, "flags": "",
           "deed_link": None, "charges_link": CHARGES_LINK.format(cn), "ro_postcode": None,
           "ccod": get_ccod_titles(cn), "n_charges": 0}
    try:
        out["ro_postcode"] = ((c.get("profile") or {}).get("registered_office_address") or {}) \
            .get("postal_code")
        items, start = [], 0
        while True:
            d = ch.get(f"/company/{cn}/charges?items_per_page=100&start_index={start}") or {}
            items += d.get("items") or []
            start += 100
            if start >= (d.get("total_count") or 0) or not d.get("items"):
                break
        dates = set(c["dates"])
        lenders = {norm(r["lender"]) for r in c["charges"]}
        qual = [i for i in items if i.get("created_on") in dates and i.get("status") == "outstanding"]
        by_lender = [i for i in qual if any(norm(p.get("name")) in lenders or
                                            any(l and l in norm(p.get("name")) for l in lenders)
                                            for p in i.get("persons_entitled") or [])]
        qual = by_lender or qual
        out["n_charges"] = len(qual)
        addrs, titles, flags = [], [], set()
        for i in qual:
            pt = i.get("particulars") or {}
            for k, lbl in (("contains_fixed_charge", "fixed"), ("contains_floating_charge", "floating"),
                           ("contains_negative_pledge", "negative pledge")):
                if pt.get(k):
                    flags.add(lbl)
            desc = (pt.get("description") or "").strip()
            if desc and not GENERIC_DESC.match(desc) and len(desc) >= 8:
                a = _clean_addr(desc)
                if a and a.lower() not in {x.lower() for x in addrs}:
                    addrs.append(a)
                titles += [t for t in _titles(desc) if t not in titles]
            for t in i.get("transactions") or []:
                f = (t.get("links") or {}).get("filing")
                if f and t.get("filing_type", "").startswith("create-charge") and not out["deed_link"]:
                    out["deed_link"] = f"{CH_SITE}{f}/document?format=pdf&download=0"
        order = ["fixed", "floating", "negative pledge"]
        out["flags"] = ", ".join(x for x in order if x in flags)
        if addrs:
            out.update(address=addrs[0], more=len(addrs) - 1, generic=False)
        out["titles"] = titles
    except Exception as ex:
        out["error"] = type(ex).__name__
    return out


def property_line(pi, with_link=True):
    """'Property charged' card value."""
    if not pi:
        return "not checked"
    link = pi.get("deed_link") or pi.get("charges_link")
    if not pi["generic"]:
        s = pi["address"] + (f" (+{pi['more']} more)" if pi["more"] else "")
        if pi["titles"]:
            s += f" (title {', '.join(pi['titles'][:4])}" + (" ..." if len(pi["titles"]) > 4 else "") + ")"
    else:
        s = "Not stated on charge (all-assets/debenture)"
        if pi.get("ccod"):
            s += "; owned titles (HMLR CCOD): " + "; ".join(
                f"{t.get('address')} ({t.get('title')})" for t in pi["ccod"][:3])
        elif pi.get("ro_postcode"):
            s += f"; registered office postcode {pi['ro_postcode']} (not the property)"
        if pi["titles"]:
            s += f" (title {', '.join(pi['titles'][:4])})"
    if pi.get("flags"):
        s += f" [{pi['flags']}]"
    return s + (f" {link}" if with_link and link else "")


def debt_line(info, with_link=True):
    """One-line summary, e.g. '~£23.4m bank borrowings at 31 Dec 2024'."""
    if not info:
        return "not checked"
    extra = []
    if info.get("inv_prop"):
        extra.append(f"investment property {_gbp(info['inv_prop'])}")
    if info.get("total_assets"):
        extra.append(f"total assets {_gbp(info['total_assets'])}")
    tail = f" ({', '.join(extra)})" if extra else ""
    if info.get("debt") is not None:
        return f"~{_gbp(info['debt'])} {info['basis']}{tail}"
    why = {"pdf": "PDF accounts", "none": "no accounts filed",
           "holdco": "holding company accounts, debt sits in subsidiaries"}.get(info.get("status"),
                                                                   info.get("basis") or "error")
    return f"not available ({why})" + (f" {info['link']}" if with_link else "")


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

    # ---- estimated debt from latest filed accounts (deep set only) ----
    # Off by default (Marcus, Oct 2026: filed accounts aren't reliable enough to filter on).
    acc_stats = Counter()
    for c in deep:
        c["debt"] = (debt_from_accounts(ch, c["company_number"]) if USE_ACCOUNTS_DEBT
                     else {"debt": None, "status": "off", "basis": None, "made_up": None, "link": None,
                        "inv_prop": None, "total_assets": None})
        d = c["debt"]["debt"]
        acc_stats[c["debt"]["status"]] += 1
        c["debt_known10"] = d is not None and d >= DEBT_MIN
        if d is not None:
            acc_stats["with_figure"] += 1
        if c["debt_known10"]:
            c["score"] += DEBT_BOOST
    under = [c for c in deep if c["debt"]["debt"] is not None and not c["debt_known10"]]
    deep = [c for c in deep if c["debt"]["debt"] is None or c["debt_known10"]]
    acc_stats["excluded_under_10m"] = len(under)
    stages.append((f"Debt from accounts: figure for {acc_stats['with_figure']}, "
                   f"PDF only {acc_stats['pdf']}; excluded: under £10m", len(under), len(under)))
    stages.append(("Remaining after debt screen", len(deep), len(deep)))

    # order: by score, but within each class known >= GBP 10m ranks above unknown
    # (each class keeps the global slots it occupies; members re-sorted inside them)
    deep.sort(key=lambda c: -c["score"])
    slots = defaultdict(list)
    for i, c in enumerate(deep):
        slots[c["cls"]].append(i)
    ordered = [None] * len(deep)
    for cls, idx in slots.items():
        members = sorted((deep[i] for i in idx), key=lambda c: (not c["debt_known10"], -c["score"]))
        for i, c in zip(idx, members):
            ordered[i] = c
    deep = ordered

    # ---- balanced pick ----
    picked, per, seen_grp = [], Counter(), {}
    for c in deep:
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
        c["prop"] = charge_property(ch, c)
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
              f"- Property charged: {property_line(c.get('prop'))}",
              *([f"- Debt (from accounts): {debt_line(c.get('debt'))}"
                 + (f" | accounts made up to {c['debt']['made_up']}" if (c.get('debt') or {}).get('made_up') else "")]
                if USE_ACCOUNTS_DEBT else []),
              f"- Directors: {'; '.join(c.get('directors') or []) or '-'}",
              "- Existing contact: " + ("; ".join(
                  f"{x['name']} <{x['email']}> [{x['how']}]"
                  + (f" FLAGS: {', '.join(x['flags'])}" if x["flags"] else "")
                  for x in c["contacts"]) or "none"),
              f"- Score: {c['score']}",
              f"- Why now: {why(c)}", ""]
    L += [f"## Excluded: debt under £10m from accounts ({len(under)})", ""]
    L += [f"- {c['name']} ({c['company_number']}), {c['cls']}: {debt_line(c['debt'])}" for c in under] \
        or ["- none"]
    L += ["", "## Distress (not targeted; noted only)", ""]
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
                    "parents", "directors", "contacts", "do_not_contact", "score", "why_now",
                    "debt_estimate_gbp", "debt_basis", "accounts_made_up", "investment_property_gbp",
                    "total_assets_gbp", "accounts_source", "accounts_filing_link",
                    "property_charged", "title_numbers", "charge_flags", "charge_deed_link"])
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
                        "DO NOT CONTACT" if c["dnc"] else "", c["score"], why(c)]
                       + [round(v) if isinstance(v, float) else (v or "") for v in (
                           c["debt"]["debt"], c["debt"]["basis"], c["debt"]["made_up"],
                           c["debt"]["inv_prop"], c["debt"]["total_assets"], c["debt"]["status"],
                           c["debt"]["link"])]
                       + [property_line(c["prop"], with_link=False), " ".join(c["prop"]["titles"]),
                          c["prop"]["flags"], c["prop"]["deed_link"] or c["prop"]["charges_link"]])

    print(f"Run date {run}; window {w_start}..{w_end}; {time.time() - t0:.0f}s; "
          f"CH fetched {ch.fetched} cached {ch.cached}")
    for s, n, k in stages:
        print(f"  {s:<62} {n:>8,} {k:>8,}")
    print(f"Distress noted: {len(distress)}")
    print(f"Debt from accounts (deep-checked {len(deep) + len(under)}): "
          f"figure {acc_stats['with_figure']}, PDF only {acc_stats['pdf']}, none filed "
          f"{acc_stats['none']}, error {acc_stats['error']}; excluded: under £10m {len(under)}")
    print(f"Wrote {md_path}\n      {csv_path}\n      {rev_path}")
    conn.close()
    return {"run": run, "window": (w_start, w_end), "picked": picked, "distress": distress,
            "stages": stages, "why": why, "months_old": mo, "md_path": md_path,
            "csv_path": csv_path, "debt_excluded": under, "acc_stats": dict(acc_stats)}


if __name__ == "__main__":
    main()
    sys.exit(0)
