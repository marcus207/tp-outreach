#!/usr/bin/env python3
"""
Asset deep dive for every Refinancing Radar card (main + sub-performing). Marcus, 7 Oct 2026: "do a deep
dive into each asset".

Per card, from public sources only, every fact with a source link, "not found" when absent (no planning
history, no flood risk: Marcus excluded those):
  * What it is: name, type, full address, size (rooms/keys/beds/units/sq ft), brand/flag/operator,
    built/opened/refurbished.
  * Ownership history: acquisition date, seller, reported price (press/news), previous owners (CH PSC
    history, previous names, news).
  * Operations: CQC rating + date (care, CQC bulk file), Ofsted (SEN), hotel star rating and review
    score/count where published, occupier/tenant (commercial).
  * Recent news (last 24 months): sales processes, refurbishments, operator changes, disputes, expansions.
  * Debt picture: the company's CH charge timeline (dates, lenders, outstanding/satisfied) and the
    newer different-lender group charges found by radar_refi_check.
  * Summary: 3-4 plain-English sentences written by Claude STRICTLY from the gathered facts.

Sources: the card's asset profile / ownership identification (asset_profile.py: CQC, GIAS, VOA, web),
Companies House REST API (maturity_radar.CH, cached), Brave Search API, public web pages (robots.txt
respected, LinkedIn and company-data aggregators never fetched), Claude via asset_profile._llm_json.
Web facts must carry a verbatim quote found in the cited page/snippet, otherwise they are dropped.
Caps per asset: DD_MAX_SEARCHES searches, DD_MAX_FETCHES page fetches. Whole result cached
DD_CACHE_DAYS days. Runs DD_WORKERS assets in parallel.
Never reads Loan Intel member tables or experian_*.
"""
import datetime as dt
import hashlib
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

import asset_profile as ap
import maturity_radar as mr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE_DIR = os.path.join(ROOT, "reports", "radar", "deep_dive_cache")
VERSION = "dd4"
DD_MAX_SEARCHES = 8
DD_MAX_FETCHES = 6
DD_CACHE_DAYS = 14
DD_WORKERS = 5
NEWS_MONTHS = 24
CH_SITE = "https://find-and-update.company-information.service.gov.uk/company/{}"

AGGREGATOR = re.compile(
    r"endole|opencorporates|companycheck|bizdb|pomanda|globaldatabase|dnb\.com|bloomberg\.com/profile|pitchbook|"
    r"craft\.co|zoominfo|rocketreach|find-and-update\.company-information|companieshouse|north-?data|"
    r"checkcompany|company-information|192\.com|ukdata|cbetta|companiesintheuk|bizstats|opengovuk|"
    r"linkedin|facebook|instagram|twitter|x\.com|youtube|tiktok|indeed|glassdoor|totaljobs|reed\.co", re.I)
KEYWORDS = re.compile(
    r"acqui|bought|purchas|sold|sale|disposal|£\s?\d|\bm\b|million|rooms?|keys|beds?|bedrooms?|units?|apartments?|"
    r"sq\.? ?ft|square feet|opened|built|construct|refurb|renovat|extension|operator|operated|managed by|brand|"
    r"franchise|rating|rated|star|review|CQC|Ofsted|tenant|let to|leased|occupier|occupied|planning|expan|"
    r"administration|dispute|appointed|investment", re.I)
CLASS_WORD = {"Hotels": "hotel", "Care": "care home", "SEN": "school", "Living": "apartments",
              "Offices": "offices", "Logistics/Industrial": "warehouse", "Retail/Leisure": "retail"}
OPS_QUERY = {"Hotels": "reviews rating", "Care": "CQC rating", "SEN": "Ofsted",
             "Offices": "tenant OR occupier OR let", "Logistics/Industrial": "tenant OR occupier OR let",
             "Retail/Leisure": "tenant OR occupier OR let", "Living": "operator apartments"}
NO_DASH = re.compile(r"\s*[—–]\s*|\s+--\s+")


def _clean(s):
    return NO_DASH.sub(", ", re.sub(r"\s+", " ", str(s or ""))).strip()


def _known(v):
    return v not in (None, "", ap.UNKNOWN, "null", "None") and not (isinstance(v, dict) and not v)


def _month_floor(d):
    return d.replace(day=1)


def _freshness(run):
    lo = _month_floor(mr.add_months(run, -NEWS_MONTHS))
    hi = _month_floor(mr.add_months(run, 1))
    return f"{lo.isoformat()}to{hi.isoformat()}"


def _mon(d):
    try:
        return dt.date.fromisoformat(str(d)[:10]).strftime("%b %Y")
    except ValueError:
        return str(d or "?")


def _src_url(prof, *prefixes):
    for s in prof.get("sources") or []:
        if any((s.get("name") or "").startswith(p) for p in prefixes) and s.get("url"):
            return s["url"]
    return None


STREETISH = re.compile(r"\b(road|rd|street|st|lane|way|avenue|ave|drive|close|place|square|terrace|park|"
                       r"court|crescent|row|walk|hill|gardens|grove|quay|wharf|parade|estate)\b\.?$", re.I)
STREET_ANY = re.compile(r"\b(road|rd|street|st|lane|way|avenue|ave|drive|close|place|square|terrace|"
                        r"crescent|row|walk|hill|gardens|grove|quay|wharf|parade|path|side of)\b", re.I)
PROPERTY_WORDS = re.compile(r"\b(public house|pub|hotel|land|warehouse|care home|nursing home|unit|units|site|plot|"
                            r"premises|buildings?|house|flat|apartments?|property|properties|subjects|freehold|leasehold|"
                            r"industrial estate|business park|and)\b", re.I)
COUNTRYISH = re.compile(r"^(england|wales|scotland|uk|united kingdom|great britain|gb|northern ireland)$", re.I)


def _place(loc):
    """'Kensington Forum Hotel, 97 Cromwell Road, London SW7 4DN' -> 'London' (last segment that is not a
    street, number, postcode or country)."""
    segs = [ap.PC_RE.sub("", x).strip(" .") for x in (loc or "").split(",")]
    segs = [x for x in segs if x and not re.search(r"\d", x) and not STREET_ANY.search(x) and not COUNTRYISH.match(x)
            and not PROPERTY_WORDS.search(x) and not LEGAL_PREFIX.match(x) and len(x.split()) <= 3]
    return segs[-1] if segs else ""


def _town(c):
    a = c.get("asset") or {}
    loc = (a.get("location") or {})
    if loc and not a.get("postcode_is_registered_office") and loc.get("local_authority"):
        return loc["local_authority"]
    ident = c.get("asset_id") or {}
    if ident.get("location") and _place(ident["location"]):
        return _place(ident["location"])
    pi = c.get("prop") or {}
    rest = ",".join((pi.get("address") or "").split(",")[1:])  # first segment is the name / number
    if not pi.get("generic") and _place(rest):
        return _place(rest).title()
    ro = ((c.get("profile") or {}).get("registered_office_address") or {})
    return ro.get("locality") or ""


LEGAL_PREFIX = re.compile(
    r"^(all (and whole )?(of )?(the |that |those )?(subjects?|property|land|premises|interest)( known as| at| being| "
    r"lying| situated)?|(the )?(freehold|leasehold|f/h|l/h)( land| property| interest)?( and (buildings?|warehouse))?"
    r"( at| known as| being)?|land (and buildings? )?(at|on|to the \w+ of|known as|lying)|on the [\w\s]+? side of|"
    r"plot \w+( at| of)?|part of|units? [\d\w-]+( at| of)?|the property known as|known as)\s*", re.I)
JUNK_ADDR = re.compile(r"please see|see instrument|further details|not stated|n/a", re.I)


def address_anchor(c):
    """(search phrase, street, postcode) from the charge's property address, legal wording stripped."""
    pi = c.get("prop") or {}
    addr = "" if pi.get("generic") else (pi.get("address") or "")
    if not addr or JUNK_ADDR.search(addr):
        return None, None, None
    pc = ap.find_postcode(addr)
    segs = []
    for x in addr.split(","):
        x = x.strip()
        for _ in range(3):
            x = LEGAL_PREFIX.sub("", x).strip(" ,.;")
        x = re.sub(r"\b(t/no|title)\b.*$", "", x, flags=re.I).strip(" ,.;")
        if x:
            segs.append(x)
    street = None
    for x in segs:
        m = re.search(r"((?:[a-z']+\s+){1,2}(?:road|rd|street|lane|way|avenue|drive|close|place|square|terrace|"
                      r"crescent|row|walk|gardens|grove|quay|wharf|parade|path|industrial estate|business park))\b", x, re.I)
        if m and not re.match(r"^(the|and|of|at|side)\b", m.group(1), re.I):
            street = m.group(1).strip()
            break
    phrase = ", ".join(segs[:3])
    if pc and pc not in phrase:
        phrase += f" {pc}"
    return (phrase or None), street, pc


def _looks_like_name(x):
    return bool(x) and not re.match(r"^[\d\s/-]", x) and not STREET_ANY.search(x) and not JUNK_ADDR.search(x) \
        and not LEGAL_PREFIX.match(x) and len(ap.tokens(x)) >= 1 and len(x) <= 80


def asset_name(c):
    """(name, source url) for the asset itself, or (None, None)."""
    a = c.get("asset") or {}
    ident = c.get("asset_id") or {}
    pi = c.get("prop") or {}
    if _known(a.get("asset_name")):
        u = ((a.get("web_facts") or {}).get("asset_name") or {}).get("url") or _src_url(a, "CQC:", "GIAS:", "VOA")
        return a["asset_name"], u
    if ident.get("confidence") in ("likely", "possible") and ident.get("asset_name"):
        ev = [b["url"] for b in ident.get("evidence") or [] if b.get("url")]
        return ident["asset_name"], ev[0] if ev else None
    phrase, _, _ = address_anchor(c)
    first = (phrase or "").split(",")[0].strip()
    if _looks_like_name(first):
        return first.title() if first.isupper() or first.islower() else first, pi.get("deed_link") or pi.get("charges_link")
    return None, None


# --------------------------------------------------------------------------- Companies House facts
def ch_facts(ch, c):
    import radar_distress as rd
    cn = c["company_number"]
    p = ch.get(f"/company/{cn}") or {}
    ps = ch.get(f"/company/{cn}/persons-with-significant-control?items_per_page=100") or {}
    items = rd.fetch_charges(ch, cn) or []
    pscs = [{"name": x.get("name"), "kind": (x.get("kind") or "").split("-person")[0],
             "notified_on": x.get("notified_on"), "ceased_on": x.get("ceased_on")} for x in ps.get("items") or []]
    charges = []
    for i in items:
        persons = [x.get("name") for x in i.get("persons_entitled") or [] if x.get("name")]
        charges.append({"created_on": i.get("created_on"), "status": i.get("status"),
                        "satisfied_on": i.get("satisfied_on"),
                        "lender": mr.norm_lender(persons[0]) if persons else "(lender not stated)",
                        "desc": ((i.get("particulars") or {}).get("description") or "")[:160]})
    charges.sort(key=lambda r: r["created_on"] or "", reverse=True)
    return {"company_name": p.get("company_name") or c["name"], "incorporated": p.get("date_of_creation"),
            "sic": p.get("sic_codes") or [], "previous_names": [
                {"name": x.get("name"), "from": x.get("effective_from"), "to": x.get("ceased_on")}
                for x in p.get("previous_company_names") or []],
            "pscs": pscs, "charges": charges}


def charge_timeline(charges, limit=8):
    """['Jul 2021: Mizrahi Tefahot Bank x4, outstanding', ...] grouped by month + lender + status."""
    groups = []
    for r in charges:
        st = "outstanding" if r["status"] in ("outstanding", "part-satisfied") else (
            f"satisfied {_mon(r['satisfied_on'])}" if r.get("satisfied_on") else (r["status"] or "?").replace("-", " "))
        key = (_mon(r["created_on"]), r["lender"], st)
        if groups and groups[-1][0] == key:
            groups[-1][1] += 1
        else:
            groups.append([key, 1])
    lines = [f"{k[0]}: {k[1]}" + (f" x{n}" if n > 1 else "") + f", {k[2]}" for k, n in groups]
    more = len(lines) - limit
    return lines[:limit] + ([f"(+{more} earlier entries)"] if more > 0 else [])


# --------------------------------------------------------------------------- CQC lookup by name
def cqc_by_name(name, town):
    """CQC rating for a named care home from the bulk file (exact-ish name, same town if given)."""
    try:
        ap._ensure_bulk("cqc")
        con = ap._db("cqc")
        if con is None or not name:
            return None
        rows = con.execute("select * from loc where lower(name) = ? and dormant!='Y'", (name.strip().lower(),)).fetchall()
        if town:
            rows = [r for r in rows if town.lower() in f"{r['city']} {r['county']} {r['street']}".lower()] or (
                rows if len(rows) == 1 else [])
        if len(rows) != 1:
            return None
        return ap._cqc_row(rows[0]) | {"as_at": ap._meta(con, "as_at")}
    except Exception:
        return None


# --------------------------------------------------------------------------- web research
DD_SYS = """You extract facts about ONE specific UK property asset (and the company that owns it) from web search
snippets and page passages, for a debt adviser's research note. Facts only, nothing inferred.
Return ONLY JSON with these keys; every fact is null or {"value": str, "quote": str, "url": str} where quote is copied
CHARACTER FOR CHARACTER from one supplied snippet/passage with that url and contains the value (keep quotes short,
the shortest exact excerpt that proves the fact, at most 30 words):
{"name": F, "type": F, "address": F, "size": F (rooms/keys/beds/units/apartments/sq ft of THIS asset),
 "brand_operator": F (hotel brand/flag, care or living operator, school proprietor), "built_opened_refurbished": F,
 "acquisition": F (when and by whom the current owner bought it, and the seller if stated),
 "price": F (reported price paid), "previous_owners": F,
 "rating": F (hotel star rating, review score with review count, CQC or Ofsted rating, exactly as published),
 "occupier": F (tenant / occupier for commercial property),
 "news": [{"date": "YYYY-MM", "headline": str, "quote": str, "url": str}]}
Rules: the fact must clearly be about the target asset at its location (or, for acquisition/price/previous owners, the
target company or its group buying/selling that asset); never use chain totals, sister properties, or a different
asset with a similar name. news = up to 4 items from the last 24 months about the asset, its owner company or group
(sales processes, refinancing, refurbishments, operator changes, disputes, expansions), each dated from the source.
Leave out planning applications, planning policy and flood risk entirely (not wanted).
If unsure, null. Do not guess, estimate or speculate. British English. No em dashes."""

SUMMARY_SYS = """Write a 3-4 sentence plain-English summary of this property asset and its owner for a debt adviser,
using ONLY the facts given (each fact was verified against a source). Cover what the asset is and its size, who owns
and operates it and since when, anything notable in recent news, and the debt picture (lenders and dates of charges).
Do not speculate, do not add adjectives or opinions, do not mention facts that are "not found", do not mention data
sources by name, planning or flood risk. Never say a loan is due or in default. British English. No em dashes or en dashes.
Return JSON {"summary": "..."}."""


def _norm(s):
    return re.sub(r"\s+", " ", ap._clean_quote(s or "").replace("’", "'").replace("&amp;", "&")).strip().lower()


def _queries(c, name, town, company, group):
    """Up to DD_MAX_SEARCHES (query, fresh) pairs: asset (name / address), then the company and its group."""
    word = CLASS_WORD.get(c.get("cls"), "property")
    phrase, street, pc = address_anchor(c)
    ops = OPS_QUERY.get(c.get("cls"), "")
    grp = group if group and group.lower() != company.lower() else ""
    qs = []
    if name:
        qn = f'"{name}"'
        if len(name.split()) == 1:  # one-word names ("Trafalgar") need the property type to be specific
            ptype = next((m.group(0) for m in [PROPERTY_WORDS.search(phrase or "")] if m), None)
            qn += f" {ptype if ptype and ptype.lower() not in ('and', 'land') else word}"
        qs += [(f"{qn} {town}".strip(), False)]
        qs += [(phrase[:120], False)] if phrase and phrase.lower() != name.lower() else [(f"{qn} {word}", False)]
        qs += [(f"{qn} acquired OR sold OR acquisition OR purchase", False),
               (f"{qn} {ops}".strip(), False),
               (f"{qn} news", True)]
    else:  # asset not named: search the charged address, then the company itself more widely
        if phrase:
            qs.append((phrase[:120], False))
        if street:
            qs.append((f'"{street}" {town} {word}'.strip(), False))
        qs.append((f'"{company}" {word} {town}'.strip(), False))
        if not phrase:
            qs.append((f'"{company}" property OR site OR building', False))
    qs += [(f'"{company}"', False), (f'"{company}" {word} acquisition OR acquires OR sold', False)]
    qs += [(f'"{grp}" {word} news', True)] if grp else [(f'"{company}" news', True)]
    if grp:
        qs.append((f'"{grp}" {word} {town}'.strip(), False))
    seen, out = set(), []
    for q, fresh in qs:
        if q not in seen:
            seen.add(q)
            out.append((q, fresh))
    return out[:DD_MAX_SEARCHES]


def web_research(c, name, town, company, group, run):
    fresh = _freshness(run)
    results, seen, nq = [], set(), 0
    for q, is_fresh in _queries(c, name, town, company, group):
        b = ap.brave(q, count=10, freshness=fresh if is_fresh else None, ns="brave_dd", ttl=DD_CACHE_DAYS * ap.DAY)
        nq += 1
        for r in b.get("results") or []:
            if r.get("url") and r["url"] not in seen and not AGGREGATOR.search(r["url"]):
                seen.add(r["url"])
                results.append({**r, "query": q})
    pc = ap.find_postcode((c.get("prop") or {}).get("address") or "")
    tgt = [ap.tokens(x) for x in (name, company, group) if x and ap.tokens(x)]
    for r in results:
        txt = f"{r['title']} {r['snippet']}"
        tt = ap.tokens(txt)
        r["on_target"] = bool(pc and ap.norm_pc(pc) in re.sub(r"[^A-Z0-9]", "", txt.upper())) or any(
            t <= tt for t in tgt)
    ranked = sorted(results, key=lambda r: (not r["on_target"], not KEYWORDS.search(r["snippet"] or "")))
    passages, fetched = [], 0
    for r in ranked:
        if fetched >= DD_MAX_FETCHES:
            break
        if not r["on_target"]:
            continue
        txt = ap.fetch_page_text(r["url"])
        if not txt:
            continue
        fetched += 1
        r["fetched"] = True
        sents = re.split(r"(?<=[.!?])\s+", txt)
        keep = []
        for s_ in sents:
            if 25 <= len(s_) <= 450 and KEYWORDS.search(s_) and (not tgt or any(len(t & ap.tokens(s_)) for t in tgt)
                                                                 or re.search(r"\d", s_)):
                keep.append(s_)
            if len(keep) >= 18:
                break
        passages.append({"url": r["url"], "text": txt[:900]})
        passages += [{"url": r["url"], "text": s_} for s_ in keep]
    return results, passages, nq, fetched


def _validate(raw, results, passages, run, target=()):
    texts = {}
    for r in results:
        texts.setdefault(r["url"], []).append(_norm(f"{r['title']}. {r['snippet']}"))
        texts[r["url"]].append(_norm(r["snippet"]))
    for p in passages:
        texts.setdefault(p["url"], []).append(_norm(p["text"]))

    def ok(f):
        if not isinstance(f, dict) or not f.get("value") or not f.get("quote") or not f.get("url"):
            return False
        q = _norm(f["quote"])
        return len(q) >= 8 and any(q in t for t in texts.get(f["url"], []))
    chunks = {}
    for r in results:
        chunks.setdefault(r["url"], []).append(f"{r['title']}. {r['snippet']}")
    for p in passages:
        chunks.setdefault(p["url"], []).append(p["text"])

    def on_target(f):
        """Ownership / price facts: the text around the quote must name the asset, its street or the
        company / group (a town-wide price list or a sister property never counts)."""
        if not target:
            return True
        q = _norm(f["quote"])
        for ch_ in chunks.get(f["url"], []):
            if q in _norm(ch_) and any(t <= ap.tokens(ch_ + " " + f["quote"]) for t in target):
                return True
        return False
    out = {}
    for k in ("name", "type", "address", "size", "brand_operator", "built_opened_refurbished", "acquisition",
              "price", "previous_owners", "rating", "occupier"):
        f = (raw or {}).get(k)
        if ok(f) and (k not in ("acquisition", "price", "previous_owners", "size") or on_target(f)):
            out[k] = {"value": _clean(f["value"]), "quote": _clean(f["quote"])[:220], "url": f["url"]}
    lo = mr.add_months(run, -NEWS_MONTHS).isoformat()[:7]
    page_date = {r["url"]: (r.get("date") or "")[:7] for r in results}
    news = []
    for n in (raw or {}).get("news") or []:
        if not isinstance(n, dict) or not ok({"value": n.get("headline"), **n}):
            continue
        if re.search(r"planning|flood|submit\w* (revised |new )?plans|demolition plans|plans? (to demolish|"
                     r"(was |were )?(approved|refused|rejected|blocked))", n.get("headline") or "", re.I):
            continue  # Marcus: no planning history, no flood risk
        d = (n.get("date") or "")[:7]
        pd_ = page_date.get(n["url"]) or ""
        if not re.match(r"^\d{4}-\d{2}$", d) and re.match(r"^\d{4}-\d{2}$", pd_):
            d = pd_
        if not re.match(r"^\d{4}-\d{2}$", d) or d < lo or (pd_ and pd_ < lo):
            continue  # undated, or older than 24 months
        news.append({"date": d, "headline": _clean(n["headline"])[:160], "url": n["url"]})
    news.sort(key=lambda n: n["date"], reverse=True)
    out["news"] = news[:4]
    return out


# --------------------------------------------------------------------------- assemble
def _fact(label, text, url=None):
    return {"label": label, "text": _clean(text) if text else "not found", "url": url if text else None}


def assemble(c, chf, web, name, name_url):
    a = c.get("asset") or {}
    ident = c.get("asset_id") or {}
    pi = c.get("prop") or {}
    wf = a.get("web_facts") or {}
    cls = c.get("cls")
    secs = []

    # what it is
    what = [_fact("Name", name, name_url) if name else _fact("Name", (web.get("name") or {}).get("value"),
                                                             (web.get("name") or {}).get("url"))]
    if _known(a.get("asset_type")) and "operator (portfolio)" not in str(a.get("asset_type")):
        what.append(_fact("Type", a["asset_type"], (wf.get("asset_type") or {}).get("url")
                          or _src_url(a, "CQC:", "GIAS:", "VOA")))
    elif ident.get("confidence") in ("likely", "possible") and ident.get("asset_type"):
        what.append(_fact("Type", ident["asset_type"], next((b["url"] for b in ident.get("evidence") or []), None)))
    else:
        what.append(_fact("Type", (web.get("type") or {}).get("value"), (web.get("type") or {}).get("url")))
    if not pi.get("generic") and pi.get("address"):
        what.append(_fact("Address", pi["address"] + (f" (titles {', '.join(pi.get('titles') or [])})"
                                                       if pi.get("titles") else "") + " [from the charge]",
                          pi.get("deed_link") or pi.get("charges_link")))
    elif (a.get("cqc") or {}).get("address"):
        what.append(_fact("Address", a["cqc"]["address"], f"https://www.cqc.org.uk/location/{a['cqc']['location_id']}"))
    elif (a.get("gias") or {}).get("address"):
        what.append(_fact("Address", a["gias"]["address"], _src_url(a, "GIAS:")))
    else:
        what.append(_fact("Address", (web.get("address") or {}).get("value"), (web.get("address") or {}).get("url")))
    cap = a.get("capacity") or {}
    if _known(cap.get("value")) and "provider total" not in str(cap.get("metric")) and "proprietor total" not in str(cap.get("metric")):
        what.append(_fact("Size", f"{cap['value']:,} {cap.get('metric') or ''}".strip() if isinstance(cap["value"], int)
                          else f"{cap['value']} {cap.get('metric') or ''}", cap.get("source_url")))
    elif ident.get("capacity"):
        ic = ident["capacity"]
        what.append(_fact("Size", f"{ic['value']:,} {ic.get('metric') or ''}".strip(), ic.get("source_url")))
    elif web.get("size"):
        what.append(_fact("Size", web["size"]["value"], web["size"]["url"]))
    elif isinstance(a.get("floor_area"), dict) and a["floor_area"].get("sqft"):
        what.append(_fact("Size", f"{a['floor_area']['sqft']:,} sq ft ({a['floor_area'].get('basis') or 'floor area'})",
                          a["floor_area"].get("source_url")))
    elif _known(cap.get("value")):  # operator / proprietor portfolio total
        what.append(_fact("Size", f"{cap['value']:,} {cap.get('metric')}" if isinstance(cap["value"], int)
                          else f"{cap['value']} {cap.get('metric')}", cap.get("source_url")))
    else:
        what.append(_fact("Size", None))
    names = [x for x in (a.get("brand"), a.get("operator")) if _known(x)]
    if names:
        what.append(_fact("Brand / operator", " / ".join(dict.fromkeys(names)),
                          (wf.get("brand") or wf.get("operator") or {}).get("url") or _src_url(a, "CQC:", "GIAS:")))
    else:
        what.append(_fact("Brand / operator", (web.get("brand_operator") or {}).get("value"),
                          (web.get("brand_operator") or {}).get("url")))
    if _known(a.get("opened")):
        what.append(_fact("Built / opened / refurbished", f"opened {a['opened']}", (wf.get("opened") or {}).get("url")))
    else:
        what.append(_fact("Built / opened / refurbished", (web.get("built_opened_refurbished") or {}).get("value"),
                          (web.get("built_opened_refurbished") or {}).get("url")))
    secs.append(("What it is", what))

    # ownership history
    cn = c["company_number"]
    own = [_fact("Acquisition", (web.get("acquisition") or {}).get("value"), (web.get("acquisition") or {}).get("url")),
           _fact("Reported price", (web.get("price") or {}).get("value"), (web.get("price") or {}).get("url"))]
    prev = []
    for x in chf["pscs"]:
        if x.get("ceased_on"):
            prev.append(f"{x['name']} (PSC {x.get('notified_on') or '?'} to {x['ceased_on']})")
    cur = [f"{x['name']} (since {x.get('notified_on') or '?'})" for x in chf["pscs"] if not x.get("ceased_on")]
    own.append(_fact("Current owner (PSC)", "; ".join(cur[:3]) if cur else None,
                     CH_SITE.format(cn) + "/persons-with-significant-control"))
    if prev:
        own.append(_fact("Previous owners (PSC history)", "; ".join(prev[:4]),
                         CH_SITE.format(cn) + "/persons-with-significant-control"))
    elif web.get("previous_owners"):
        own.append(_fact("Previous owners", web["previous_owners"]["value"], web["previous_owners"]["url"]))
    else:
        own.append(_fact("Previous owners", None))
    hist = f"incorporated {chf['incorporated']}" if chf.get("incorporated") else ""
    if chf["previous_names"]:
        hist += "; previous names: " + "; ".join(f"{x['name']} (to {x.get('to') or '?'})" for x in chf["previous_names"][:3])
    own.append(_fact("Company history", hist or None, CH_SITE.format(cn)))
    secs.append(("Ownership history", own))

    # operations
    ops = []
    if cls == "Care":
        q = a.get("cqc") or {}
        if q.get("rating"):
            ops.append(_fact("CQC rating", f"{q['rating']}" + (f" (published {q['rating_published']})"
                                                              if q.get("rating_published") else ""),
                             f"https://www.cqc.org.uk/location/{q['location_id']}"))
        else:
            hit = cqc_by_name(name, _town(c)) if name else None
            if hit:
                ops.append(_fact("CQC rating", f"{hit['rating']}" + (f" (published {hit['rating_published']})"
                                                                    if hit.get("rating_published") else "")
                                 + f", {hit['name']}", hit["url"]))
            elif (a.get("cqc_portfolio") or {}).get("top"):
                tops = a["cqc_portfolio"]["top"][:3]
                ops.append(_fact("CQC ratings (provider's largest homes)",
                                 "; ".join(f"{h['name']}: {h['rating']}" for h in tops), tops[0].get("url")))
            else:
                ops.append(_fact("CQC rating", (web.get("rating") or {}).get("value"), (web.get("rating") or {}).get("url")))
    elif cls == "SEN":
        ops.append(_fact("Ofsted", (web.get("rating") or {}).get("value"), (web.get("rating") or {}).get("url")))
        g = a.get("gias") or {}
        if g.get("last_inspection"):
            ops.append(_fact("Last inspection (GIAS)", f"{g['last_inspection']}" + (f", {g['inspectorate']}"
                                                                                    if g.get("inspectorate") else ""),
                             _src_url(a, "GIAS:")))
    elif cls == "Hotels":
        star = a.get("star_rating")
        if _known(star):
            ops.append(_fact("Star rating", f"{star}-star" if str(star).isdigit() else star,
                             (wf.get("star_rating") or {}).get("url")))
        ops.append(_fact("Rating / reviews", (web.get("rating") or {}).get("value"), (web.get("rating") or {}).get("url")))
    else:
        ops.append(_fact("Occupier / tenant" if cls != "Living" else "Operator / occupier",
                         (web.get("occupier") or {}).get("value"), (web.get("occupier") or {}).get("url")))
    secs.append(("Operations", ops))

    # news
    secs.append(("Recent news (24 months)", [_fact(_mon(n["date"] + "-01"), n["headline"], n["url"])
                                              for n in web.get("news") or []] or [_fact("News", None)]))

    # debt picture
    tl = charge_timeline(chf["charges"])
    n_out = sum(1 for r in chf["charges"] if r["status"] in ("outstanding", "part-satisfied"))
    debt = [_fact("Charge timeline", (f"{len(chf['charges'])} charges registered, {n_out} outstanding: " + "; ".join(tl))
                  if tl else None, CH_SITE.format(cn) + "/charges")]
    rc = c.get("refi_check") or {}
    gch = rc.get("group_charges") or []
    if gch:
        txt = "; ".join(f"{_mon(g['date'])}: {g['lender']} to {g['company'].title()} ({g['company_number']}, "
                        f"{g['relation']})" for g in gch[:4]) + (f" (+{len(gch) - 4} more)" if len(gch) > 4 else "")
        debt.append(_fact("Group charges (newer, other lenders)", txt, CH_SITE.format(gch[0]["company_number"]) + "/charges"))
    elif rc:
        debt.append(_fact("Group charges (newer, other lenders)",
                          f"none found across {rc.get('n_group', 0)} group companies checked", None))
    secs.append(("Debt picture", debt))
    return secs


def _llm_retry(system, payload, max_tokens, tries=3):
    """asset_profile._llm_json (cached) with retries: it returns None on API errors (e.g. rate limits when
    several deep dives run at once)."""
    for i in range(tries):
        out = ap._llm_json(system, payload, max_tokens=max_tokens)
        if out is not None:
            return out
        time.sleep(3 + 4 * i)
    return None


def summarise(c, secs):
    facts = {"company": c["name"], "asset_class": c.get("cls"),
             "facts": {s: [{f["label"]: f["text"]} for f in items if f["text"] != "not found"] for s, items in secs}}
    s = _llm_retry(SUMMARY_SYS, facts, 400)
    return _clean((s or {}).get("summary")) or None


COVERAGE = ["Name", "Type", "Address", "Size", "Brand / operator", "Built / opened / refurbished", "Acquisition",
            "Reported price", "Previous owners", "Operations", "News"]


def coverage(dd):
    found = set()
    for sec, items in dd.get("sections") or []:
        for f in items:
            if f["text"] == "not found":
                continue
            lbl = f["label"]
            if sec == "Operations":
                found.add("Operations")
            elif sec.startswith("Recent news"):
                found.add("News")
            elif lbl.startswith("Previous owners"):
                found.add("Previous owners")
            elif lbl in COVERAGE:
                found.add(lbl)
    return [k for k in COVERAGE if k in found]


def deep_dive(c, ch, run):
    """Deep dive dict for one card (cached DD_CACHE_DAYS). Never raises."""
    t0 = time.time()
    name, name_url = asset_name(c)
    company = ap._clean_owner(c["name"])
    group = next((ap._clean_owner(p) for p in c.get("parents") or [] if p), "")
    town = _town(c)
    key = [VERSION, c["company_number"], name, town, c.get("cls"), (c.get("prop") or {}).get("address"),
           (c.get("refi_check") or {}).get("n_group"), run.isoformat()[:7]]
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{c['company_number']}-"
                        + hashlib.sha1(json.dumps(key, default=str).encode()).hexdigest()[:12] + ".json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < DD_CACHE_DAYS * 86400:
        try:
            dd = json.load(open(path))
            dd["cached"] = True
            return dd
        except ValueError:
            pass
    dd = {"name": name, "town": town, "searches": 0, "fetches": 0, "error": None}
    try:
        chf = ch_facts(ch, c)
        results, passages, nq, nf = web_research(c, name, town, company, group, run)
        dd.update(searches=nq, fetches=nf)
        payload = {"target": {"asset_name": name, "town": town, "asset_class": c.get("cls"), "company": chf["company_name"],
                              "group": group or None, "address": (c.get("prop") or {}).get("address")
                              if not (c.get("prop") or {}).get("generic") else None,
                              "today": run.isoformat()},
                   "search_results": [{"url": r["url"], "title": r["title"], "date": r.get("date"),
                                       "snippet": (r["snippet"] or "")[:600]} for r in results[:40]],
                   "page_passages": [{"url": p["url"], "text": p["text"][:600]} for p in passages[:70]]}
        raw = _llm_retry(DD_SYS, payload, 3500) if results else {}
        dd["llm"] = "ok" if raw is not None else "failed"
        _, street, _ = address_anchor(c)
        target = [t for t in (ap.tokens(name), ap.tokens(street), ap.tokens(company), ap.tokens(group)) if t]
        web = _validate(raw or {}, results, passages, run, target)
        dd["web_dropped"] = sorted(k for k, v in (raw or {}).items() if v and k != "news" and k not in web)
        dd["sections"] = assemble(c, chf, web, name, name_url)
        dd["summary"] = summarise(c, dd["sections"])
        dd["websites"] = websites(c, results)
    except Exception as ex:
        dd["error"] = f"{type(ex).__name__}: {ex}"[:200]
        dd.setdefault("sections", [])
        dd.setdefault("summary", None)
        dd.setdefault("websites", [])
    dd["secs"] = round(time.time() - t0, 1)
    if not dd["error"] and dd.get("llm") != "failed":
        json.dump(dd, open(path, "w"), default=str)
    return dd


def websites(c, results):
    """Up to 2 likely official websites (domain carries a distinctive token of the company, group, brand or
    operator name), used by radar_linkedin for team / about pages."""
    a = c.get("asset") or {}
    names = [c["name"], *(c.get("parents") or []), a.get("brand"), a.get("operator")]
    toks = set()
    for n in names:
        if _known(n):
            toks |= {t for t in ap.tokens(ap._clean_owner(n)) if len(t) >= 4 and t not in GENERIC_DOMAIN}
    pool = list(results) + [{"url": r.get("url")} for r in a.get("web_results") or []] + \
        [{"url": r.get("url")} for r in (c.get("asset_id") or {}).get("results") or []]
    out = []
    for r in pool:
        u = r.get("url") or ""
        m = re.match(r"^(https?://)([^/]+)", u)
        if not m or AGGREGATOR.search(u) or re.search(r"\.gov\.uk|wikipedia|news|insider|propertyweek|costar|"
                                                       r"booking\.com|tripadvisor|expedia|hotels\.com|carehome\.co\.uk|"
                                                       r"housingcare|bbc\.|rightmove|zoopla|gov\.", m.group(2), re.I):
            continue
        host = m.group(2).lower()
        label = re.sub(r"^www\.", "", host).split(".")[0]
        if any(t in label for t in toks):
            base = m.group(1) + m.group(2)
            if base not in out:
                out.append(base)
        if len(out) >= 2:
            break
    return out


GENERIC_DOMAIN = {"limited", "group", "holdings", "property", "properties", "investments", "investment", "capital",
                  "care", "hotel", "hotels", "living", "homes", "estates", "health", "healthcare", "services", "london",
                  "management", "developments", "real", "estate", "assets", "fund", "partners", "social", "trust"}


def run_all(cards, ch, run, workers=DD_WORKERS):
    """Adds c['deep'] to every card. Returns stats."""
    import radar_distress as rd
    ch = rd.threaded_ch(ch)
    t0 = time.time()
    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(lambda c: deep_dive(c, ch, run), cards))
    for c, dd in zip(cards, res):
        c["deep"] = dd
        dd["coverage"] = coverage(dd)
    return {"secs": round(time.time() - t0), "cached": sum(1 for d in res if d.get("cached")),
            "errors": [(c["company_number"], d["error"]) for c, d in zip(cards, res) if d.get("error")],
            "searches": sum(d.get("searches") or 0 for d in res if not d.get("cached")),
            "fetches": sum(d.get("fetches") or 0 for d in res if not d.get("cached"))}


def dd_rows(c):
    """[(label, text, link, link_label, prebuilt_html)] rows for the card's Deep dive block."""
    import html as H
    dd = c.get("deep") or {}
    if not dd.get("sections"):
        return [("Deep dive", "not available this week" + (f" ({dd['error']})" if dd.get("error") else ""))]
    rows = []
    if dd.get("summary"):
        rows.append(("Deep dive: summary", dd["summary"]))
    for sec, items in dd["sections"]:
        t_parts, h_parts = [], []
        for f in items:
            t_parts.append(f"{f['label']}: {f['text']}" + (f" [{f['url']}]" if f.get("url") else ""))
            h_parts.append(f"<b>{H.escape(f['label'])}:</b> {H.escape(f['text'])}"
                           + (f' <a href="{H.escape(f["url"])}" style="color:#1f3a5f">[source]</a>' if f.get("url") else ""))
        rows.append((f"Deep dive: {sec.lower()}", "; ".join(t_parts), None, None, "<br>".join(h_parts)))
    return rows
