#!/usr/bin/env python3
"""Asset profile for the Turning Point Capital Advisory refinancing radar.

Answers two questions about a charged asset: WHAT IS IT and HOW BIG IS IT.
Public data only. Every capacity figure carries its source; anything not found
is returned as "unknown" (never estimated).

Interface
---------
    from asset_profile import build_asset_profile
    p = build_asset_profile(address, postcode, company_number, company_name,
                            asset_class)            # radar class: Care, Hotels,
                                                    # SEN, Living, Offices,
                                                    # Logistics/Industrial,
                                                    # Retail/Leisure
    Optional keywords: postcode_is_registered_office=False (postcode is the
    company's registered office, not the property: postcode matching is then
    skipped and lookups go by company number / name), use_web=True,
    use_llm=True.

Returns a compact dict:
    asset_type, asset_name, capacity {metric, value, source, source_url},
    brand, operator, star_rating, floor_area, epc, location, summary,
    sources [{name, url}], source_status {source: ok|not_found|needs_key|
    unavailable}, notes.

Sources
-------
  postcodes.io                         location, local authority, ward (no key)
  CQC HSCA Active Locations (monthly)  care homes: beds, rating, provider (no key;
                                       bulk ODS from cqc.org.uk; the CQC API now
                                       needs a subscription key, so it is not used)
  GIAS edubasealldata (daily)          schools: capacity, pupils, type (no key)
  VOA 2026 compiled rating list        description, rateable value, floor area
                                       (bulk zips ~250 MB, built into SQLite with
                                       --build-voa)
  EPC (get-energy-performance-data)    non-domestic EPC / DEC: rating, floor area
                                       (needs a free GOV.UK One Login bearer token
                                       in EPC_API_TOKEN)
  Brave Search + operator web pages    brand, operator, rooms/units/beds, stars
  Anthropic (claude-sonnet-4-6)        extraction with verbatim quotes (validated
                                       against source text) + 2-3 sentence summary

CLI
---
    python3 scripts/asset_profile.py --postcode "FY4 1HP" --address "Travelodge hotel, balmoral road, blackpool" \
        --company-number 11049590 --company-name "IMP INVESTMENTS RBS LIMITED" --asset-class Hotels
    python3 scripts/asset_profile.py --refresh-bulk      # CQC + GIAS bulk files
    python3 scripts/asset_profile.py --build-voa         # VOA list (~250 MB download)
    python3 scripts/asset_profile.py --status            # bulk index status
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.robotparser
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "reports" / "radar" / "asset_cache"
BULK = CACHE / "bulk"
HTTP_CACHE = CACHE / "http"
UA = ("TPCA-AssetProfile/1.0 (+https://www.tp.finance; research use; "
      "contact marcus@tp.finance)")
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
MODEL = "claude-sonnet-4-6"   # same id as src/services/digest.ts

DAY = 86400
TTL = {"postcodes": 90 * DAY, "brave": 14 * DAY, "page": 30 * DAY, "epc": 30 * DAY,
       "llm": 30 * DAY, "cqc_api": 30 * DAY, "robots": 7 * DAY}
BULK_TTL = {"cqc": 30 * DAY, "gias": 7 * DAY, "voa": 120 * DAY}
MIN_INTERVAL = {"api.search.brave.com": 1.1, "default": 1.0}

OK, NOT_FOUND, NEEDS_KEY, UNAVAILABLE = "ok", "not_found", "needs_key", "unavailable"
UNKNOWN = "unknown"
SQM_TO_SQFT = 10.7639

# ---------------------------------------------------------------- utilities

def _load_env() -> dict:
    env = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if v})
    return env


ENV = _load_env()


def _key(*names):
    for n in names:
        if ENV.get(n):
            return ENV[n]
    return None


_last_hit: dict = {}
_lock = threading.Lock()


def _throttle(url: str):
    host = urllib.parse.urlparse(url).netloc
    gap = MIN_INTERVAL.get(host, MIN_INTERVAL["default"])
    with _lock:
        wait = _last_hit.get(host, 0) + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_hit[host] = time.time()


def _cache_path(ns: str, key: str) -> Path:
    h = hashlib.sha1(key.encode()).hexdigest()
    return HTTP_CACHE / ns / h[:2] / f"{h}.json"


def _cache_get(ns: str, key: str, ttl: int):
    p = _cache_path(ns, key)
    if p.exists() and time.time() - p.stat().st_mtime < ttl:
        try:
            return json.loads(p.read_text())
        except Exception:
            return None
    return None


def _cache_put(ns: str, key: str, value):
    p = _cache_path(ns, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value))


def http_get(url, params=None, headers=None, ns="http", ttl=DAY, as_json=True, timeout=25):
    """GET with on-disk cache and per-host throttle. Returns (status_code, body).
    status_code 0 = network error. Caches 200 and 404 only."""
    full = url + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
    auth_tag = hashlib.sha1(json.dumps(headers or {}, sort_keys=True).encode()).hexdigest()[:8]
    ck = f"{full}|{auth_tag}|{as_json}"
    hit = _cache_get(ns, ck, ttl)
    if hit is not None:
        return hit["code"], hit["body"]
    _throttle(full)
    try:
        r = requests.get(full, headers={"User-Agent": UA, **(headers or {})}, timeout=timeout)
    except requests.RequestException:
        return 0, None
    body = None
    if r.status_code == 200:
        if as_json:
            try:
                body = r.json()
            except ValueError:
                return 0, None
        else:
            body = r.text
    if r.status_code in (200, 404):
        _cache_put(ns, ck, {"code": r.status_code, "body": body})
    return r.status_code, body


def norm_pc(pc: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", (pc or "").upper())


PC_RE = re.compile(r"\b([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})\b", re.I)


def find_postcode(text: str | None) -> str | None:
    m = PC_RE.search(text or "")
    return f"{m.group(1).upper()} {m.group(2).upper()}" if m else None


STOP = set("""limited ltd plc llp the and of at in on co company uk group holdings holding
investments investment property properties propco opco road rd street st lane avenue ave
house the a care home homes hotel hotels living ltd. healthcare services""".split())


def tokens(s: str | None, keep_generic=False) -> set:
    toks = set(re.findall(r"[a-z0-9]+", (s or "").lower()))
    toks = {t for t in toks if len(t) > 1}
    return toks if keep_generic else toks - STOP


def sim(a: str | None, b: str | None) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


def _num(v):
    try:
        f = float(str(v).replace(",", ""))
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return None


def _src(name, url):
    return {"name": name, "url": url}

# ---------------------------------------------------------------- ODS reader

_T = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
_X = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"


def iter_ods_rows(path: Path, sheet: str):
    """Stream rows of one sheet of an .ods file (content.xml can be ~450 MB)."""
    with zipfile.ZipFile(path) as z, z.open("content.xml") as f:
        current = None
        for ev, el in ET.iterparse(f, events=("start", "end")):
            if ev == "start" and el.tag == f"{{{_T}}}table":
                current = el.get(f"{{{_T}}}name")
            elif ev == "end" and el.tag == f"{{{_T}}}table-row":
                if current == sheet:
                    row = []
                    for c in el:
                        if not c.tag.endswith("table-cell"):
                            continue
                        rep = int(c.get(f"{{{_T}}}number-columns-repeated", "1"))
                        val = " ".join("".join(p.itertext()) for p in c.findall(f"{{{_X}}}p"))
                        row.extend([val] * min(rep, 100))
                    yield row
                el.clear()
            elif ev == "end" and el.tag == f"{{{_T}}}table":
                if current == sheet:
                    return
                el.clear()

# ---------------------------------------------------------------- bulk indexes

def _db(name: str) -> sqlite3.Connection | None:
    p = BULK / f"{name}.sqlite"
    if not p.exists():
        return None
    con = sqlite3.connect(str(p))
    con.row_factory = sqlite3.Row
    return con


def _meta(con, key):
    try:
        r = con.execute("select v from meta where k=?", (key,)).fetchone()
        return r[0] if r else None
    except sqlite3.Error:
        return None


def _db_age(name: str) -> float | None:
    p = BULK / f"{name}.sqlite"
    return time.time() - p.stat().st_mtime if p.exists() else None


CQC_DATA_PAGE = "https://www.cqc.org.uk/about-us/transparency/using-cqc-data"


def refresh_cqc(force=False, log=print) -> str:
    age = _db_age("cqc")
    if age is not None and age < BULK_TTL["cqc"] and not force:
        return "fresh"
    r = requests.get(CQC_DATA_PAGE, headers={"User-Agent": BROWSER_UA}, timeout=30)
    m = re.search(r'href="([^"]+HSCA_Active_Locations\.ods)"', r.text)
    if not m:
        return "link_not_found"
    url = urllib.parse.urljoin(CQC_DATA_PAGE, m.group(1))
    dl = BULK / "cqc_hsca_active_locations.ods"
    BULK.mkdir(parents=True, exist_ok=True)
    log(f"CQC: downloading {url}")
    with requests.get(url, headers={"User-Agent": BROWSER_UA}, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(dl, "wb") as fh:
            for chunk in resp.iter_content(1 << 20):
                fh.write(chunk)
    tmp = BULK / "cqc.sqlite.tmp"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(str(tmp))
    cols = ["location_id", "name", "care_home", "beds", "sector", "category", "rating",
            "rating_date", "street", "line2", "city", "county", "postcode", "pc", "uprn",
            "lat", "lon", "brand", "provider_ch", "provider_id", "provider_name", "web",
            "dormant", "start_date"]
    con.execute(f"create table loc ({', '.join(cols)})")
    con.execute("create table meta (k primary key, v)")
    hdr = None
    want = {"location_id": "Location ID", "name": "Location Name", "care_home": "Care home?",
            "beds": "Care homes beds", "sector": "Location Type/Sector",
            "category": "Location Primary Inspection Category",
            "rating": "Location Latest Overall Rating", "rating_date": "Publication Date",
            "street": "Location Street Address", "line2": "Location Address Line 2",
            "city": "Location City", "county": "Location County",
            "postcode": "Location Postal Code", "uprn": "Location UPRN ID",
            "lat": "Location Latitude", "lon": "Location Longitude", "brand": "Brand Name",
            "provider_ch": "Provider Companies House Number", "provider_id": "Provider ID",
            "provider_name": "Provider Name", "web": "Location Web Address",
            "dormant": "Dormant (Y/N)", "start_date": "Location HSCA start date"}
    batch = []
    for row in iter_ods_rows(dl, "HSCA_Active_Locations"):
        if hdr is None:
            if "Location ID" in row:
                hdr = {h: i for i, h in enumerate(row)}
            continue
        g = lambda k: (row[hdr[want[k]]] if hdr.get(want[k], 999) < len(row) else "").strip()
        if not g("location_id"):
            continue
        rec = {k: g(k) for k in want}
        rec["pc"] = norm_pc(rec["postcode"])
        rec["provider_ch"] = rec["provider_ch"].upper().zfill(8) if rec["provider_ch"] else ""
        batch.append([rec.get(c, "") for c in cols])
    con.executemany(f"insert into loc values ({','.join('?' * len(cols))})", batch)
    con.execute("create index i_pc on loc(pc)")
    con.execute("create index i_ch on loc(provider_ch)")
    as_at = re.search(r"/(\d{2}_\w+_\d{4})_HSCA", url)
    con.executemany("insert into meta values (?,?)",
                    [("source_url", url), ("as_at", as_at.group(1).replace("_", " ") if as_at else ""),
                     ("rows", str(len(batch))), ("built", datetime.now(timezone.utc).isoformat())])
    con.commit()
    con.close()
    tmp.replace(BULK / "cqc.sqlite")
    dl.unlink(missing_ok=True)
    log(f"CQC: indexed {len(batch)} locations")
    return "rebuilt"


GIAS = "https://get-information-schools.service.gov.uk"


def refresh_gias(force=False, log=print) -> str:
    age = _db_age("gias")
    if age is not None and age < BULK_TTL["gias"] and not force:
        return "fresh"
    s = requests.Session()
    s.headers["User-Agent"] = BROWSER_UA
    page = s.get(f"{GIAS}/Downloads", timeout=30).text
    tok = re.search(r'action="/Downloads/Collate".*?__RequestVerificationToken" type="hidden" value="([^"]+)"', page, re.S)
    gen = re.search(r'name="Downloads\[0\]\.FileGeneratedDate" type="hidden" value="([^"]+)"', page)
    fdate = {k: re.search(rf'name="FilterDate\.{k}" type="hidden" value="(\d+)"', page) for k in ("Day", "Month", "Year")}
    if not tok:
        return "form_not_found"
    data = {"__RequestVerificationToken": tok.group(1), "Skip": "", "SearchType": "Latest",
            "Downloads[0].Tag": "all.edubase.data", "Downloads[0].Selected": "true",
            "Downloads[0].FileGeneratedDate": gen.group(1) if gen else ""}
    for k, m in fdate.items():
        data[f"FilterDate.{k}"] = m.group(1) if m else ""
    r = s.post(f"{GIAS}/Downloads/Collate", data=data, timeout=60, allow_redirects=False)
    loc = r.headers.get("location")
    if not loc:
        return "collate_failed"
    for _ in range(30):
        g = s.get(urllib.parse.urljoin(GIAS, loc), timeout=30).text
        if "Download/Extract" in g:
            break
        time.sleep(3)
    else:
        return "generation_timeout"
    t2 = re.search(r'action="/Downloads/Download/Extract".*?__RequestVerificationToken" type="hidden" value="([^"]+)"', g, re.S)
    fid = re.search(r'name="id" type="hidden" value="([^"]+)"', g)
    path = re.search(r'name="path" type="hidden" value="([^"]+)"', g)
    log("GIAS: downloading edubasealldata")
    z = s.post(f"{GIAS}/Downloads/Download/Extract", timeout=300,
               data={"__RequestVerificationToken": t2.group(1), "id": fid.group(1),
                     "path": path.group(1), "returnSource": "Downloads"})
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    name = [n for n in zf.namelist() if n.lower().endswith(".csv")][0]
    text = io.TextIOWrapper(zf.open(name), encoding="cp1252", errors="replace")
    tmp = BULK / "gias.sqlite.tmp"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(str(tmp))
    cols = {"urn": "URN", "name": "EstablishmentName", "type": "TypeOfEstablishment (name)",
            "type_group": "EstablishmentTypeGroup (name)", "status": "EstablishmentStatus (name)",
            "phase": "PhaseOfEducation (name)", "low_age": "StatutoryLowAge",
            "high_age": "StatutoryHighAge", "capacity": "SchoolCapacity",
            "pupils": "NumberOfPupils", "street": "Street", "locality": "Locality",
            "town": "Town", "postcode": "Postcode", "website": "SchoolWebsite",
            "props_name": "PropsName", "trusts": "Trusts (name)", "ch_number": "CHNumber",
            "inspectorate": "InspectorateName (name)", "last_insp": "DateOfLastInspectionVisit",
            "boarders": "Boarders (name)", "sen1": "SEN1 (name)", "open_date": "OpenDate",
            "uprn": "UPRN"}
    con.execute(f"create table est ({', '.join(cols)}, pc)")
    con.execute("create table meta (k primary key, v)")
    rows = []
    for rec in csv.DictReader(text):
        v = [rec.get(c, "").strip() for c in cols.values()]
        v.append(norm_pc(rec.get("Postcode")))
        rows.append(v)
    con.executemany(f"insert into est values ({','.join('?' * (len(cols) + 1))})", rows)
    con.execute("create index i_pc on est(pc)")
    con.execute("create index i_ch on est(ch_number)")
    con.executemany("insert into meta values (?,?)", [("file", name), ("rows", str(len(rows))),
                    ("built", datetime.now(timezone.utc).isoformat())])
    con.commit()
    con.close()
    tmp.replace(BULK / "gias.sqlite")
    log(f"GIAS: indexed {len(rows)} establishments ({name})")
    return "rebuilt"


VOA_INDEX = "https://voaratinglists.blob.core.windows.net/html/rlidata.htm"


def voa_links() -> dict:
    html = requests.get(VOA_INDEX, timeout=30).text
    out = {}
    for kind in ("listentries", "summaryvaluations"):
        m = re.search(rf'href="([^"]+uk-englandwales-ndr-2026-{kind}-compiled-epoch-\d+-baseline-csv\.zip)"', html)
        if m:
            out[kind] = m.group(1)
    return out


def build_voa(download=True, log=print) -> str:
    """Download (after a size check) the VOA 2026 compiled list baseline and index it."""
    d = BULK / "voa"
    d.mkdir(parents=True, exist_ok=True)
    links = voa_links()
    if len(links) < 2:
        return "links_not_found"
    paths = {}
    for kind, url in links.items():
        p = d / url.rsplit("/", 1)[1]
        size = int(requests.head(url, timeout=30).headers.get("content-length", 0))
        log(f"VOA {kind}: {url} ({size / 1e6:.0f} MB)")
        if not p.exists() or p.stat().st_size != size:
            if not download:
                return "zips_missing"
            if size > 600e6:
                return f"too_large ({size / 1e6:.0f} MB): download manually to {d}"
            with requests.get(url, stream=True, timeout=300) as r:
                r.raise_for_status()
                with open(p, "wb") as fh:
                    for chunk in r.iter_content(1 << 20):
                        fh.write(chunk)
        paths[kind] = p
    tmp = BULK / "voa.sqlite.tmp"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(str(tmp))
    con.execute("create table le (uarn, ba_ref, desc_code, descr, address, firm, postcode, pc, rv, scat, eff_date)")
    con.execute("create table smv (uarn, postcode, pc, descr, total_area, unit, rv, scat, firm, address)")
    con.execute("create table meta (k primary key, v)")
    n = 0
    with zipfile.ZipFile(paths["listentries"]) as z:
        name = [x for x in z.namelist() if x.endswith("baseline-csv.csv")][0]
        batch = []
        for line in io.TextIOWrapper(z.open(name), encoding="latin-1"):
            f = line.rstrip("\r\n").split("*")
            if len(f) < 22:
                continue
            batch.append((f[6], f[3], f[4], f[5], f[7], f[8], f[14], norm_pc(f[14]), _num(f[17]), f[21], f[15]))
            if len(batch) >= 50000:
                con.executemany("insert into le values (?,?,?,?,?,?,?,?,?,?,?)", batch)
                n += len(batch)
                batch = []
        con.executemany("insert into le values (?,?,?,?,?,?,?,?,?,?,?)", batch)
        n += len(batch)
    m = 0
    with zipfile.ZipFile(paths["summaryvaluations"]) as z:
        name = z.namelist()[0]
        batch = []
        for line in io.TextIOWrapper(z.open(name), encoding="latin-1"):
            if not line.startswith("01*"):
                continue
            f = line.rstrip("\r\n").split("*")
            if len(f) < 29:
                continue
            addr = ", ".join(x for x in f[5:13] if x)
            batch.append((f[2], f[13], norm_pc(f[13]), f[15], _num(f[16]), f[27], _num(f[19]), f[26], f[4], addr))
            if len(batch) >= 50000:
                con.executemany("insert into smv values (?,?,?,?,?,?,?,?,?,?)", batch)
                m += len(batch)
                batch = []
        con.executemany("insert into smv values (?,?,?,?,?,?,?,?,?,?)", batch)
        m += len(batch)
    con.execute("create index i_le_pc on le(pc)")
    con.execute("create index i_smv_uarn on smv(uarn)")
    con.execute("create index i_smv_pc on smv(pc)")
    con.executemany("insert into meta values (?,?)", [("listentries", links["listentries"]),
                    ("summaryvaluations", links["summaryvaluations"]), ("le_rows", str(n)),
                    ("smv_rows", str(m)), ("built", datetime.now(timezone.utc).isoformat())])
    con.commit()
    con.close()
    tmp.replace(BULK / "voa.sqlite")
    log(f"VOA: indexed {n} list entries, {m} summary valuations")
    return "rebuilt"


def _ensure_bulk(name: str):
    """Auto-refresh small bulk files (CQC ~24 MB, GIAS ~15 MB) when stale. Never raises."""
    try:
        if name == "cqc":
            refresh_cqc(log=lambda *a: None)
        elif name == "gias":
            refresh_gias(log=lambda *a: None)
    except Exception:
        pass

# ---------------------------------------------------------------- sources

def src_postcodes(postcode: str | None) -> dict:
    if not postcode:
        return {"status": NOT_FOUND, "note": "no postcode"}
    code, body = http_get(f"https://api.postcodes.io/postcodes/{urllib.parse.quote(postcode)}",
                          ns="postcodes", ttl=TTL["postcodes"])
    if code == 404:
        # terminated postcodes still resolve here
        code, body = http_get(f"https://api.postcodes.io/terminated_postcodes/{urllib.parse.quote(postcode)}",
                              ns="postcodes", ttl=TTL["postcodes"])
        if code == 200 and body:
            r = body["result"]
            return {"status": OK, "postcode": r.get("postcode"), "lat": r.get("latitude"),
                    "lon": r.get("longitude"), "terminated": True}
        return {"status": NOT_FOUND}
    if code != 200 or not body:
        return {"status": UNAVAILABLE}
    r = body["result"]
    return {"status": OK, "postcode": r["postcode"], "lat": r.get("latitude"), "lon": r.get("longitude"),
            "country": r.get("country"), "region": r.get("region"),
            "local_authority": r.get("admin_district"), "la_code": (r.get("codes") or {}).get("admin_district"),
            "ward": r.get("admin_ward"), "url": f"https://api.postcodes.io/postcodes/{norm_pc(postcode)}"}


def _cqc_row(r) -> dict:
    return {"name": r["name"], "location_id": r["location_id"],
            "address": ", ".join(x for x in (r["street"], r["line2"], r["city"], r["postcode"]) if x),
            "care_home": r["care_home"] == "Y", "beds": _num(r["beds"]) or 0,
            "category": r["category"], "rating": r["rating"] or "Not rated",
            "rating_published": r["rating_date"], "provider": r["provider_name"],
            "provider_ch": r["provider_ch"], "brand": (r["brand"] or "").replace("BRAND ", "") if r["brand"] not in ("-", "") else None,
            "web": r["web"], "url": f"https://www.cqc.org.uk/location/{r['location_id']}"}


def src_cqc(address, postcode, company_number, company_name, use_postcode=True) -> dict:
    _ensure_bulk("cqc")
    con = _db("cqc")
    if con is None:
        return {"status": UNAVAILABLE, "note": "CQC index not built (run --refresh-bulk)"}
    as_at = _meta(con, "as_at")
    out = {"status": NOT_FOUND, "as_at": as_at, "source_file": _meta(con, "source_url")}
    best = None
    if use_postcode and postcode:
        rows = con.execute("select * from loc where pc=? and dormant!='Y'", (norm_pc(postcode),)).fetchall()
        rows = [r for r in rows if r["category"] not in ("Dentists", "GP Practices")] or rows
        scored = sorted(((sim(r["name"] + " " + r["street"], address or "") * 2
                          + sim(r["name"], company_name) + (r["provider_ch"] == company_number.zfill(8)) * 3
                          + (r["care_home"] == "Y"), r) for r in rows), key=lambda x: -x[0])
        if scored and (len(scored) == 1 or scored[0][0] >= 1):
            best = _cqc_row(scored[0][1])
            best["match"] = "postcode" + (" + name/address" if scored[0][0] >= 1.5 else "")
        out["candidates_at_postcode"] = len(rows)
    port = con.execute("select * from loc where provider_ch=? and dormant!='Y'",
                       ((company_number or "").zfill(8),)).fetchall() if company_number else []
    if not port and company_name:
        cn = re.sub(r"\b(limited|ltd)\.?$", "", company_name.strip().lower()).strip()
        port = [r for r in con.execute("select * from loc where lower(provider_name) like ? and dormant!='Y'",
                                       (cn + "%",)).fetchall()
                if re.sub(r"\b(limited|ltd)\.?$", "", r["provider_name"].strip().lower()).strip() == cn]
    if port:
        homes = [_cqc_row(r) for r in port]
        out["provider_portfolio"] = {"locations": len(homes),
                                     "care_homes": sum(h["care_home"] for h in homes),
                                     "total_beds": sum(h["beds"] for h in homes),
                                     "homes": [{k: h[k] for k in ("name", "beds", "rating", "address", "url")}
                                               for h in sorted(homes, key=lambda h: -h["beds"])[:15]]}
        if best is None and len(homes) == 1:
            best = homes[0]
            best["match"] = "provider company number"
    if best:
        out.update({"status": OK, "location": best})
    elif port:
        out["status"] = OK
    return out


def src_gias(address, postcode, company_number, company_name, use_postcode=True) -> dict:
    _ensure_bulk("gias")
    con = _db("gias")
    if con is None:
        return {"status": UNAVAILABLE, "note": "GIAS index not built (run --refresh-bulk)"}
    out = {"status": NOT_FOUND, "file": _meta(con, "file")}

    def fmt(r):
        return {"name": r["name"], "urn": r["urn"], "type": r["type"], "phase": r["phase"],
                "status": r["status"], "ages": f"{r['low_age']}-{r['high_age']}",
                "capacity": _num(r["capacity"]), "pupils": _num(r["pupils"]),
                "address": ", ".join(x for x in (r["street"], r["locality"], r["town"], r["postcode"]) if x),
                "proprietor": r["props_name"] or r["trusts"] or None, "inspectorate": r["inspectorate"] or None,
                "last_inspection": r["last_insp"] or None, "website": r["website"] or None,
                "url": f"https://get-information-schools.service.gov.uk/Establishments/Establishment/Details/{r['urn']}"}
    best = None
    if use_postcode and postcode:
        rows = con.execute("select * from est where pc=?", (norm_pc(postcode),)).fetchall()
        def score(r):
            return (sim(r["name"] + " " + r["street"], address or "") * 2 + sim(r["props_name"], company_name) * 2
                    + ("special" in (r["type"] + r["phase"] + r["sen1"]).lower())
                    + (r["status"].startswith("Open")) * 2 + (r["ch_number"].zfill(8) == (company_number or "").zfill(8)) * 3)
        rows = sorted(rows, key=score, reverse=True)
        if rows and score(rows[0]) >= 2:
            best = fmt(rows[0])
        out["candidates_at_postcode"] = len(rows)
    owned = []
    if company_number:
        owned = con.execute("select * from est where ch_number in (?,?) and status like 'Open%'",
                            (company_number, company_number.lstrip("0"))).fetchall()
    if not owned and company_name and len(tokens(company_name)) >= 1:
        cands = con.execute("select * from est where status like 'Open%' and props_name like ?",
                            (f"%{sorted(tokens(company_name), key=len)[-1]}%",)).fetchall()
        owned = [r for r in cands if sim(r["props_name"], company_name) >= 0.8]
    if owned:
        sch = [fmt(r) for r in owned]
        out["proprietor_portfolio"] = {"schools": len(sch),
                                       "total_capacity": sum(s["capacity"] or 0 for s in sch),
                                       "list": [{k: s[k] for k in ("name", "type", "capacity", "pupils", "url")} for s in sch[:15]]}
        if best is None and len(sch) == 1:
            best = sch[0]
    if best:
        out.update({"status": OK, "establishment": best})
    elif owned:
        out["status"] = OK
    return out


def src_voa(address, postcode, use_postcode=True, asset_name=None) -> dict:
    con = _db("voa")
    if con is None:
        zips = list((BULK / "voa").glob("*.zip")) if (BULK / "voa").exists() else []
        return {"status": UNAVAILABLE,
                "note": ("VOA index not built; run --build-voa" + (" (zips already downloaded)" if zips else
                         " (downloads ~250 MB from voaratinglists.blob.core.windows.net)"))}
    if not (use_postcode and postcode):
        return {"status": NOT_FOUND, "note": "needs the property postcode"}
    rows = con.execute("select * from le where pc=?", (norm_pc(postcode),)).fetchall()
    if not rows:
        return {"status": NOT_FOUND, "candidates_at_postcode": 0}
    target = " ".join(x for x in (asset_name, address) if x)
    t_nums = set(re.findall(r"\b\d+[a-z]?\b", target.lower()))
    # distinctive tokens: asset name + first address component (building name), not street/town
    t_dist = tokens(asset_name) | tokens((address or "").split(",")[0])
    t_dist = {t for t in t_dist if not t.isdigit()}

    def score(r):
        a = r["address"].lower()
        nums = set(re.findall(r"\b\d+[a-z]?\b", a))
        if t_nums and nums and not (t_nums & nums):
            return -1.0                      # house numbers conflict
        sc = 0.0
        if t_nums & nums:
            sc += 1.0
        if t_dist & tokens(a):
            sc += 1.0
        return sc
    scored = sorted(((score(r), r) for r in rows), key=lambda x: (-x[0], -(x[1]["rv"] or 0)))
    s, r = scored[0]
    out = {"status": NOT_FOUND, "candidates_at_postcode": len(rows),
           "at_postcode": [{"description": x["descr"], "address": x["address"], "rv": x["rv"]}
                           for _, x in sorted(scored, key=lambda y: -(y[1]["rv"] or 0))[:6]]}
    # a lone assessment at the postcode is accepted only when there is no address to contradict it
    if not (s >= 1.0 or (len(rows) == 1 and s >= 0)):
        out["note"] = "no assessment at the postcode matches the address/name; not choosing one"
        return out
    m = con.execute("select * from smv where uarn=?", (r["uarn"],)).fetchone()
    out.update({"status": OK, "match": "building name/number" if s >= 1.0 else "single assessment at postcode, no conflicting number",
                "description": r["descr"], "address": r["address"], "occupier_field": r["firm"] or None,
                "rateable_value": r["rv"], "uarn": r["uarn"],
                "url": f"https://www.tax.service.gov.uk/business-rates-find/valuations/start/{r['uarn']}"})
    if m and m["total_area"]:
        out.update({"floor_area_m2": m["total_area"], "area_basis": m["unit"],
                    "floor_area_sqft": round(m["total_area"] * SQM_TO_SQFT)})
    return out


EPC_API = "https://api.get-energy-performance-data.communities.gov.uk"


def _walk(d, pred, path=""):
    if isinstance(d, dict):
        for k, v in d.items():
            yield from _walk(v, pred, f"{path}.{k}")
            if pred(k, v):
                yield k, v
    elif isinstance(d, list):
        for x in d:
            yield from _walk(x, pred, path)


def src_epc(address, postcode) -> dict:
    token = _key("EPC_API_TOKEN", "EPC_API_KEY", "EPC_BEARER_TOKEN", "OPENDATACOMMUNITIES")
    link = "https://find-energy-certificate.service.gov.uk/find-a-non-domestic-certificate/search-by-postcode?postcode=" + urllib.parse.quote_plus(postcode or "")
    if not token:
        return {"status": NEEDS_KEY, "search_link": link,
                "note": "Set EPC_API_TOKEN (bearer token from get-energy-performance-data.communities.gov.uk My account)"}
    if not postcode:
        return {"status": NOT_FOUND, "note": "no postcode"}
    hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    found = []
    for kind in ("non-domestic", "display"):
        code, body = http_get(f"{EPC_API}/api/{kind}/search", {"postcode": postcode}, hdr, ns="epc", ttl=TTL["epc"])
        if code in (401, 403):
            return {"status": NEEDS_KEY, "note": f"EPC token rejected (HTTP {code})", "search_link": link}
        if code == 200 and body:
            for c in (body.get("data") or []):
                c["_kind"] = kind
                found.append(c)
    if not found:
        return {"status": NOT_FOUND, "search_link": link}

    def addr(c):
        return " ".join(str(c.get(k) or "") for k in ("addressLine1", "addressLine2", "addressLine3", "addressLine4", "postTown"))
    found.sort(key=lambda c: (-sim(addr(c), address or ""), c.get("_kind") != "non-domestic",
                              str(c.get("registrationDate") or "")), reverse=False)
    top_sim = sim(addr(found[0]), address or "")
    if len({addr(c) for c in found}) > 1 and top_sim < 0.5:
        return {"status": NOT_FOUND, "note": "certificates at postcode but none match the address",
                "at_postcode": [{"address": addr(c).strip(), "band": c.get("currentEnergyEfficiencyBand")} for c in found[:6]],
                "search_link": link}
    same = [c for c in found if addr(c) == addr(found[0])]
    same.sort(key=lambda c: str(c.get("registrationDate") or ""), reverse=True)
    out = {"status": OK, "certificates": []}
    for c in same[:3]:
        cert = {"type": "EPC" if c["_kind"] == "non-domestic" else "DEC",
                "certificate": c.get("certificateNumber"), "band": c.get("currentEnergyEfficiencyBand"),
                "registered": str(c.get("registrationDate") or "")[:10], "address": addr(c).strip(),
                "url": f"https://find-energy-certificate.service.gov.uk/energy-certificate/{c.get('certificateNumber')}"}
        code, full = http_get(f"{EPC_API}/api/certificate", {"certificate_number": c.get("certificateNumber")},
                              hdr, ns="epc", ttl=TTL["epc"])
        if code == 200 and full:
            data = full.get("data", full)
            fa = next((v for k, v in _walk(data, lambda k, v: re.search(r"floor_area", k, re.I) and _num(v))), None)
            ar = next((v for k, v in _walk(data, lambda k, v: re.fullmatch(r"(asset_rating|energy_rating_current|asset-rating)", k, re.I))), None)
            pt = next((v for k, v in _walk(data, lambda k, v: re.search(r"property_type|building_type|main_benchmark", k, re.I) and isinstance(v, str))), None)
            cert.update({"floor_area_m2": _num(fa), "asset_rating": ar, "property_type": pt})
            if _num(fa):
                cert["floor_area_sqft"] = round(_num(fa) * SQM_TO_SQFT)
        out["certificates"].append(cert)
    return out


def brave(query: str, count=8) -> dict:
    key = _key("BRAVE_API_KEY")
    if not key:
        return {"status": NEEDS_KEY, "results": []}
    code, body = http_get("https://api.search.brave.com/res/v1/web/search",
                          {"q": query, "count": count, "country": "gb", "extra_snippets": 1},
                          {"X-Subscription-Token": key, "Accept": "application/json"},
                          ns="brave", ttl=TTL["brave"])
    if code != 200 or not body:
        return {"status": UNAVAILABLE, "results": [], "http": code}
    res = [{"title": r.get("title"), "url": r.get("url"),
            "snippet": re.sub(r"<[^>]+>", "", " ".join([r.get("description") or ""] + (r.get("extra_snippets") or [])))}
           for r in (body.get("web") or {}).get("results", [])]
    return {"status": OK if res else NOT_FOUND, "results": res}


_robots: dict = {}
SKIP_FETCH = re.compile(r"(facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok|find-and-update\.company-information|"
                        r"companieshouse|endole|opencorporates|companycheck|bizdb|pomanda|\.pdf$)", re.I)


def _allowed(url: str) -> bool:
    p = urllib.parse.urlparse(url)
    base = f"{p.scheme}://{p.netloc}"
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        code, txt = http_get(base + "/robots.txt", ns="robots", ttl=TTL["robots"], as_json=False, timeout=10)
        rp.parse((txt or "").splitlines() if code == 200 else [])
        _robots[base] = rp
    return _robots[base].can_fetch("TPCA-AssetProfile", url)


def fetch_page_text(url: str, limit=60000) -> str | None:
    if SKIP_FETCH.search(url) or not _allowed(url):
        return None
    code, html = http_get(url, ns="page", ttl=TTL["page"], as_json=False, timeout=20,
                          headers={"Accept": "text/html"})
    if code != 200 or not html:
        return None
    html = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html[:800000])
    txt = re.sub(r"<[^>]+>", " ", html)
    txt = re.sub(r"&nbsp;|&#160;", " ", txt)
    txt = re.sub(r"&amp;", "&", txt)
    return re.sub(r"\s+", " ", txt).strip()[:limit]


CAP_WORDS = r"(?:bed(?:room)?s?|rooms?|keys|suites|apartments?|units?|homes|studios|flats|places|pupils|beds?paces|sq\.? ?ft|square feet|sq\.? ?m)"
NUM_NEAR = re.compile(rf"[^.]{{0,120}}\b\d[\d,]*\s*(?:-|\s)?(?:en-?suite\s+|guest\s+|luxury\s+|bedroom\s+|student\s+)?{CAP_WORDS}\b[^.]{{0,120}}", re.I)
STAR_NEAR = re.compile(r"[^.]{0,100}\b(?:[1-5]|one|two|three|four|five)[ -]star\b[^.]{0,100}", re.I)


def _anchor_ok(text: str, postcode: str | None, anchor: str | None) -> bool:
    """A web page/snippet counts as being about the target asset only if it contains the
    property postcode or every distinctive token of the anchor name (e.g. 'welcombe')."""
    t = (text or "").upper()
    if postcode and norm_pc(postcode) in re.sub(r"[^A-Z0-9]", "", t):
        return True
    at = tokens(anchor)
    tt = tokens(text)
    return bool(at) and at <= tt


def anchor_name(address: str | None, *names) -> str | None:
    """Best name for the asset itself: a regulator/VOA name, else the first non-numeric
    part of the address (e.g. 'Caledon court')."""
    for n in names:
        if n and tokens(n):
            return n
    first = (address or "").split(",")[0].strip()
    if first and not re.match(r"^\d", first) and tokens(first) - {"unit", "land", "site", "plot", "part", "phase"}:
        return first
    return None


def web_evidence(address, postcode, company_name, asset_class, anchor=None, town=None) -> dict:
    kw = {"Hotels": "hotel rooms", "Care": "care home beds", "SEN": "school", "Living": "apartments beds",
          "Offices": "office sq ft", "Logistics/Industrial": "warehouse sq ft", "Retail/Leisure": "sq ft"}.get(asset_class, "")
    queries = []
    if anchor:
        queries.append(f"\"{anchor}\" {town or postcode or ''} {kw}".strip())
    if address:
        queries.append(f"{address} {postcode or ''}".strip())
    queries.append(f"\"{company_name}\" {kw}".strip())
    # with no property postcode or anchor, the only safe anchor is the company name itself
    match_anchor = anchor or (None if postcode else company_name)
    results, status = [], NOT_FOUND
    seen = set()
    for q in queries:
        b = brave(q)
        if b["status"] == NEEDS_KEY:
            return {"status": NEEDS_KEY, "results": [], "passages": []}
        if b["status"] == OK:
            status = OK
        for r in b["results"]:
            if r["url"] not in seen:
                seen.add(r["url"])
                r["query"] = q
                results.append(r)
    for r in results:
        r["on_target"] = _anchor_ok(f"{r['title']} {r['snippet']}", postcode, match_anchor)
    # fetch up to 4 pages, on-target snippets first (asset's own / operator / listing pages)
    passages = []
    ranked = sorted(results, key=lambda r: not r["on_target"])
    fetched = 0
    for r in ranked[:8]:
        if fetched >= 4:
            break
        txt = fetch_page_text(r["url"])
        if not txt:
            continue
        fetched += 1
        r["fetched"] = True
        if not (r["on_target"] or _anchor_ok(txt, postcode, match_anchor)):
            continue
        r["on_target"] = True
        for m in list(NUM_NEAR.finditer(txt))[:15] + list(STAR_NEAR.finditer(txt))[:3]:
            passages.append({"url": r["url"], "text": m.group(0).strip()})
        passages.append({"url": r["url"], "text": txt[:1500]})
    for r in results:
        if r["on_target"]:
            passages.append({"url": r["url"], "text": f"{r['title']}. {r['snippet']}"})
    return {"status": status, "results": results, "passages": passages, "anchor": match_anchor}

# ---------------------------------------------------------------- LLM

def _anthropic():
    key = _key("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        import anthropic
        return anthropic.Anthropic(api_key=key)
    except Exception:
        return None


def _llm_json(system: str, user: dict, max_tokens=900):
    ck = json.dumps([MODEL, system, user], sort_keys=True, default=str)
    hit = _cache_get("llm", ck, TTL["llm"])
    if hit is not None:
        return hit
    client = _anthropic()
    if client is None:
        return None
    try:
        msg = client.messages.create(model=MODEL, max_tokens=max_tokens, temperature=0, system=system,
                                     messages=[{"role": "user", "content": json.dumps(user, default=str)}])
        txt = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        m = re.search(r"\{.*\}", txt, re.S)
        out = json.loads(m.group(0)) if m else None
    except Exception:
        return None
    if out is not None:
        _cache_put("llm", ck, out)
    return out


EXTRACT_SYS = """You extract facts about ONE specific property asset from web passages.
Return ONLY a JSON object with keys: asset_name, asset_type, brand, operator, capacity, star_rating, opened.
Each key's value is either null or {"value": ..., "quote": "<verbatim text copied exactly from one passage>", "url": "<that passage's url>"}.
capacity value is {"number": <int>, "metric": "<rooms|beds|units|apartments|pupil places|sq ft>"}.
Rules: use only the passages; the quote must be copied character for character and must contain the value;
the fact must clearly be about the target asset at the given address/postcode, not a chain total, a sister property, or a group portfolio;
"opened" is the year the building or business opened or was built, never a regulator registration or inspection date;
if unsure, return null. asset_type is a short noun phrase such as "hotel", "care home", "purpose-built student accommodation".
Do not guess, infer or estimate."""


def _clean_quote(s):
    return re.sub(r"[\ue000-\uf8ff]", " ", s or "")


def _norm_txt(s):
    return re.sub(r"\s+", " ", (s or "").replace("’", "'")).strip().lower()


def validate_quotes(ext: dict, passages: list) -> dict:
    by_url = {}
    for p in passages:
        by_url.setdefault(p["url"], []).append(_norm_txt(p["text"]))
    good = {}
    for k, v in (ext or {}).items():
        if not isinstance(v, dict) or not v.get("quote") or not v.get("url"):
            continue
        q = _norm_txt(v["quote"])
        if len(q) < 4 or not any(q in t for t in by_url.get(v["url"], [])):
            continue
        if k == "capacity":
            c = v.get("value") or {}
            n = _num(c.get("number"))
            if not n or not re.search(rf"\b{re.escape(f'{n:,}')}\b|\b{n}\b", v["quote"]):
                continue
        good[k] = v
    return good


SUMMARY_SYS = """Write a 2-3 sentence factual description of what this property asset is, for a debt adviser.
Use ONLY the facts in the JSON. Lead with type and capacity in the form "<capacity> <brand/type>, <location>", e.g.
"142-key Hilton Garden Inn, opened 2019, Manchester city centre." Keep it to ONE sentence where facts are thin.
Never list what is unknown and never use the word "unknown"; simply leave missing facts out
(e.g. "Care home in Wolverhampton."). Do not speculate, do not add adjectives, do not
mention data sources, rateable values or the company's finances. The company_name is the borrower that granted the
charge; do not describe it as operator unless the operator field says so. British English. No em dashes or en dashes.
Return JSON {"summary": "..."}."""

# ---------------------------------------------------------------- main

CLASS_METRIC = {"Care": "registered beds", "SEN": "pupil places (capacity)", "Hotels": "rooms (keys)",
                "Offices": "floor area (sq ft)", "Logistics/Industrial": "floor area (sq ft)",
                "Retail/Leisure": "floor area (sq ft)"}


def _living_metric(text: str) -> str:
    t = (text or "").lower()
    if re.search(r"student|pbsa|\buniversity\b", t):
        return "beds (PBSA)"
    if re.search(r"co-?living", t):
        return "beds (co-living)"
    return "units (apartments)"


def build_asset_profile(address: str | None, postcode: str | None, company_number: str,
                        company_name: str, asset_class: str, *, postcode_is_registered_office: bool = False,
                        use_web: bool = True, use_llm: bool = True) -> dict:
    company_number = (company_number or "").strip().upper()
    postcode = postcode or find_postcode(address)
    use_pc = bool(postcode) and not postcode_is_registered_office
    status, sources, notes = {}, [], []
    prof = {"asset_class": asset_class, "company_number": company_number, "company_name": company_name,
            "address": address, "postcode": postcode,
            "postcode_is_registered_office": postcode_is_registered_office,
            "asset_type": UNKNOWN, "asset_name": UNKNOWN,
            "capacity": {"metric": CLASS_METRIC.get(asset_class, "capacity"), "value": UNKNOWN, "source": None, "source_url": None},
            "brand": UNKNOWN, "operator": UNKNOWN, "star_rating": UNKNOWN, "opened": UNKNOWN,
            "floor_area": None, "epc": None}

    def guard(name, fn, *a, **k):
        try:
            r = fn(*a, **k)
        except Exception as e:      # one failing source never breaks the profile
            r = {"status": UNAVAILABLE, "error": f"{type(e).__name__}: {e}"[:200]}
        status[name] = r.get("status", UNAVAILABLE)
        return r

    loc = guard("postcodes_io", src_postcodes, postcode)
    if loc.get("status") == OK:
        prof["location"] = {k: loc.get(k) for k in ("lat", "lon", "local_authority", "la_code", "ward", "region", "country")}
        prof["location"]["basis"] = "registered office postcode (not the property)" if postcode_is_registered_office else "property postcode"
        sources.append(_src("postcodes.io", loc.get("url")))
    country = loc.get("country") or ""
    england_wales = country in ("England", "Wales", "")
    facts = {"asset_class_from_radar": asset_class, "company_name": company_name, "address": address,
             "postcode": postcode if use_pc else None, "local_authority": loc.get("local_authority") if use_pc else None,
             "region": loc.get("region") if use_pc else None}

    def set_cap(value, metric, source, url):
        prof["capacity"] = {"metric": metric, "value": value, "source": source, "source_url": url}

    # --- care
    if asset_class == "Care" or (asset_class not in ("Hotels", "SEN") and re.search(r"care|nursing", company_name or "", re.I)):
        if country in ("Scotland", "Northern Ireland"):
            status["cqc"] = UNAVAILABLE
            notes.append(f"CQC covers England only; {country} care is regulated by the "
                         f"{'Care Inspectorate' if country == 'Scotland' else 'RQIA'}")
        else:
            c = guard("cqc", src_cqc, address, postcode, company_number, company_name, use_postcode=use_pc)
            l = c.get("location")
            if l:
                prof["asset_name"] = l["name"]
                prof["asset_type"] = ("care home (" + l["category"].lower() + ")") if l["care_home"] else l["category"].lower()
                prof["operator"] = l["provider"]
                if l.get("brand"):
                    prof["brand"] = l["brand"]
                if l["care_home"]:
                    set_cap(l["beds"], "registered beds", f"CQC HSCA Active Locations ({c.get('as_at')})", l["url"])
                prof["cqc"] = {k: l[k] for k in ("location_id", "rating", "rating_published", "address", "provider", "match")}
                sources.append(_src(f"CQC: {l['name']}", l["url"]))
                facts["cqc"] = {k: l[k] for k in ("name", "address", "category", "beds", "rating", "provider", "brand")}
            pf = c.get("provider_portfolio")
            if pf:
                prof["cqc_portfolio"] = {k: pf[k] for k in ("locations", "care_homes", "total_beds")}
                prof["cqc_portfolio"]["top"] = pf["homes"][:5]
                facts["cqc_provider_portfolio"] = prof["cqc_portfolio"]
                if not l and pf["care_homes"]:
                    prof["asset_type"] = "care home operator (portfolio)"
                    set_cap(pf["total_beds"], f"registered beds across {pf['care_homes']} care homes (provider total)",
                            f"CQC HSCA Active Locations ({c.get('as_at')})",
                            f"https://www.cqc.org.uk/search/all?query={urllib.parse.quote(company_name)}")
                    prof["operator"] = company_name
            if c.get("source_file"):
                sources.append(_src("CQC HSCA Active Locations file", c["source_file"]))

    # --- SEN / schools
    if asset_class == "SEN":
        g = guard("gias", src_gias, address, postcode, company_number, company_name, use_postcode=use_pc)
        e = g.get("establishment")
        if e:
            prof["asset_name"] = e["name"]
            prof["asset_type"] = e["type"].lower() + (f" ({e['phase'].lower()})" if e["phase"] and e["phase"] != "Not applicable" else "")
            prof["operator"] = e["proprietor"] or UNKNOWN
            if e["capacity"]:
                set_cap(e["capacity"], "pupil places (capacity)", f"GIAS ({g.get('file')})", e["url"])
            prof["gias"] = {k: e[k] for k in ("urn", "status", "ages", "pupils", "inspectorate", "last_inspection", "address")}
            sources.append(_src(f"GIAS: {e['name']}", e["url"]))
            facts["gias"] = e
        pf = g.get("proprietor_portfolio")
        if pf:
            prof["gias_portfolio"] = pf
            facts["gias_portfolio"] = pf
            if not e and pf["total_capacity"]:
                prof["asset_type"] = "school proprietor (portfolio)"
                set_cap(pf["total_capacity"], f"pupil places across {pf['schools']} schools (proprietor total)",
                        f"GIAS ({g.get('file')})", "https://get-information-schools.service.gov.uk/")

    # --- VOA + EPC (England & Wales)
    if england_wales:
        v = guard("voa", src_voa, address, postcode, use_postcode=use_pc,
                  asset_name=prof["asset_name"] if prof["asset_name"] != UNKNOWN else None)
        if v.get("status") == OK:
            prof["voa"] = {k: v.get(k) for k in ("description", "address", "rateable_value", "floor_area_m2",
                                                   "floor_area_sqft", "area_basis", "match")}
            sources.append(_src("VOA rating list 2026", v["url"]))
            facts["voa"] = prof["voa"]
            if v.get("floor_area_sqft"):
                prof["floor_area"] = {"sqft": v["floor_area_sqft"], "m2": v["floor_area_m2"],
                                      "basis": v.get("area_basis"), "source": "VOA 2026 rating list summary valuation",
                                      "source_url": v["url"]}
            if prof["asset_type"] == UNKNOWN and v.get("description"):
                prof["asset_type"] = re.sub(r"\s+and premises$", "", v["description"].lower())
        if use_pc:
            ep = guard("epc", src_epc, address, postcode)
            prof["epc"] = ep if ep.get("status") != OK else {"status": OK, "certificates": ep["certificates"]}
            if ep.get("status") == OK:
                c0 = ep["certificates"][0]
                facts["epc"] = c0
                sources.append(_src(f"{c0['type']} {c0['certificate']}", c0["url"]))
                if c0.get("floor_area_sqft") and not prof["floor_area"]:
                    prof["floor_area"] = {"sqft": c0["floor_area_sqft"], "m2": c0["floor_area_m2"], "basis": "EPC floor area",
                                          "source": f"{c0['type']} {c0['certificate']}", "source_url": c0["url"]}
        else:
            status["epc"] = NOT_FOUND
            prof["epc"] = {"status": NOT_FOUND, "note": "no property postcode"}
    else:
        status["voa"] = status["epc"] = UNAVAILABLE
        notes.append(f"VOA rating list and EPC register cover England and Wales only ({country})")

    if asset_class in ("Offices", "Logistics/Industrial", "Retail/Leisure") and prof["floor_area"]:
        fa = prof["floor_area"]
        set_cap(fa["sqft"], f"floor area (sq ft, {fa['basis']})", fa["source"], fa["source_url"])

    # --- web
    web = {"status": NOT_FOUND, "results": [], "passages": []}
    if use_web:
        voa_name = None
        if prof.get("voa"):
            first = prof["voa"]["address"].split(",")[0].strip()
            voa_name = first.title() if first and not re.match(r"^[\d/ -]+$", first) and tokens(first) else None
        anc = anchor_name(address if use_pc else None,
                          prof["asset_name"] if prof["asset_name"] != UNKNOWN else None, voa_name)
        web = guard("web_search", web_evidence, address if use_pc else None, postcode if use_pc else None,
                    company_name, asset_class, anc, loc.get("local_authority") if use_pc else None)
        prof["web_results"] = [{"title": r["title"], "url": r["url"], "snippet": (r["snippet"] or "")[:220],
                                "on_target": r.get("on_target")} for r in web.get("results", [])[:5]]
        if web.get("anchor"):
            prof["web_anchor"] = web["anchor"]
        if prof["asset_name"] == UNKNOWN and voa_name:
            prof["asset_name"] = voa_name   # from the VOA rating list address
    if asset_class == "Living":
        prof["capacity"]["metric"] = _living_metric(" ".join([company_name or "", address or ""] +
                                                             [r["title"] + " " + r["snippet"] for r in web.get("results", [])[:5]]))

    # --- LLM extraction from web passages (quotes validated against source text)
    ext = {}
    if use_llm and web.get("passages"):
        passages = web["passages"][:45]
        raw = _llm_json(EXTRACT_SYS, {"target": {"company_name": company_name, "address": address,
                                                 "postcode": postcode if use_pc else None, "asset_class": asset_class,
                                                 "wanted_capacity_metric": prof["capacity"]["metric"]},
                                      "passages": [{"url": p["url"], "text": p["text"][:1600]} for p in passages]})
        status["llm_extract"] = OK if raw is not None else UNAVAILABLE
        ext = validate_quotes(raw or {}, passages)
        dropped = sorted(set(k for k, v in (raw or {}).items() if v) - set(ext))
        if dropped:
            notes.append("web facts dropped (quote not verifiable in source): " + ", ".join(dropped))
    for k in ("asset_name", "asset_type", "brand", "operator", "star_rating", "opened"):
        if k in ext and prof.get(k) in (UNKNOWN, None):
            prof[k] = ext[k]["value"] if not isinstance(ext[k]["value"], dict) else json.dumps(ext[k]["value"])
            prof.setdefault("web_facts", {})[k] = {"value": prof[k], "quote": ext[k]["quote"], "url": ext[k]["url"]}
    if "capacity" in ext and prof["capacity"]["value"] == UNKNOWN:
        c = ext["capacity"]
        set_cap(_num(c["value"]["number"]), c["value"].get("metric") or prof["capacity"]["metric"],
                "web: \"" + re.sub(r"\s+", " ", _clean_quote(c["quote"]))[:160] + "\"", c["url"])
    for k, v in ext.items():
        sources.append(_src(f"web ({k})", v["url"]))
    facts["web_verified"] = {k: {"value": v["value"], "quote": v["quote"]} for k, v in ext.items()}
    if prof["floor_area"]:
        facts["floor_area"] = prof["floor_area"]
    facts["capacity"] = prof["capacity"]
    facts["asset_type"] = prof["asset_type"]
    facts["brand"], facts["operator"] = prof["brand"], prof["operator"]

    # --- summary
    prof["summary"] = UNKNOWN
    if use_llm:
        s = _llm_json(SUMMARY_SYS, facts, max_tokens=300)
        status["llm_summary"] = OK if s and s.get("summary") else UNAVAILABLE
        if s and s.get("summary"):
            prof["summary"] = re.sub(r"\s*[—–]\s*", ", ", s["summary"]).strip()

    seen, uniq = set(), []
    for s_ in sources:
        if s_["url"] and s_["url"] not in seen:
            seen.add(s_["url"])
            uniq.append(s_)
    prof["sources"] = uniq
    prof["source_status"] = status
    prof["notes"] = notes
    prof["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return prof


def bulk_status() -> dict:
    out = {}
    for n in ("cqc", "gias", "voa"):
        con = _db(n)
        if con is None:
            out[n] = "not built"
            continue
        out[n] = {r["k"]: r["v"] for r in con.execute("select k, v from meta")}
        out[n]["age_days"] = round(_db_age(n) / DAY, 1)
    out["epc_token"] = bool(_key("EPC_API_TOKEN", "EPC_API_KEY", "EPC_BEARER_TOKEN", "OPENDATACOMMUNITIES"))
    out["brave_key"] = bool(_key("BRAVE_API_KEY"))
    out["anthropic_key"] = bool(_key("ANTHROPIC_API_KEY"))
    return out


def compact(p: dict) -> dict:
    keep = ["company_name", "asset_class", "address", "postcode", "asset_type", "asset_name", "capacity", "brand",
            "operator", "star_rating", "opened", "floor_area", "summary", "source_status", "notes"]
    out = {k: p.get(k) for k in keep}
    e = p.get("epc") or {}
    out["epc"] = (e.get("certificates") or [{}])[0] if e.get("status") == OK else e.get("status")
    for k in ("cqc", "cqc_portfolio", "gias", "voa", "web_facts"):
        if p.get(k):
            out[k] = p[k]
    out["sources"] = [s["url"] for s in p.get("sources", [])]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--address")
    ap.add_argument("--postcode")
    ap.add_argument("--company-number", default="")
    ap.add_argument("--company-name", default="")
    ap.add_argument("--asset-class", default="")
    ap.add_argument("--registered-office", action="store_true", help="postcode is the registered office, not the property")
    ap.add_argument("--no-web", action="store_true")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--full", action="store_true", help="print the full dict")
    ap.add_argument("--refresh-bulk", action="store_true", help="refresh CQC + GIAS bulk files")
    ap.add_argument("--build-voa", action="store_true", help="download (~250 MB) and index the VOA 2026 list")
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if a.refresh_bulk:
        print("CQC:", refresh_cqc(force=True))
        print("GIAS:", refresh_gias(force=True))
    if a.build_voa:
        print("VOA:", build_voa())
    if a.status:
        print(json.dumps(bulk_status(), indent=2))
    if a.company_name or a.address or a.postcode:
        p = build_asset_profile(a.address, a.postcode, a.company_number, a.company_name, a.asset_class,
                                postcode_is_registered_office=a.registered_office,
                                use_web=not a.no_web, use_llm=not a.no_llm)
        print(json.dumps(p if a.full else compact(p), indent=2, default=str))


if __name__ == "__main__":
    main()
