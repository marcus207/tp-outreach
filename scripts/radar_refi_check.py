#!/usr/bin/env python3
"""
Refinance check + institutional-owner exclusion for the Refinancing Radar (both sections).

Marcus, 7 Oct 2026:
  * "Research the SPV with other lenders for newer loans": a candidate is only shown when no likely
    refinance by a DIFFERENT lender is visible after its qualifying charge:
      a) OWN company: a newer charge from another lender (main band: maturity_radar via
         main_own_check(); sub-performing: radar_distress.evaluate_refinance()).
      b) GROUP: parents (current + ceased corporate PSCs, CH PSC API, 2 levels) and siblings
         (companies with the same corporate PSC in spv_companies.psc; companies sharing >= 2 active
         directors via CH officer appointments, first 3 directors, nominee-style directors with more
         than APPT_MAX_ITEMS appointments skipped). A group company's newer charge from a different
         lender EXCLUDES when it is a security-agent/trustee or portfolio-style charge, or its
         particulars name the same title or property; otherwise it is FLAGGED "possible group
         refinance" (kept, ranked down).
      c) SAME PROPERTY: title numbers + address from the qualifying charge particulars are searched in
         charges.property_description under ANY company. A newer charge with a different lender on the
         same title (or a strong address match: same full postcode + street/building words, house/unit numbers
         consistent) EXCLUDES ("asset refinanced/sold"); same title + same lender under another
         company is FLAGGED "possible restructure within group, same lender".
    "Newer" = after the qualifying charge, both sections (sub-performing since 7 Oct 2026; it was
    on/after 6 months before the 5-year anniversary). Only Companies House charges are visible: the HM Land Registry title
    register (GBP 3 per title) is the definitive check of charges currently on the property.
  * Institutional owners are IGNORED (hard exclusion, both sections): the company or any owner in its
    parent chain (current corporate / legal-person PSCs up to 4 levels, plus PSCs ceased in the last
    12 months) matches scripts/radar_excluded_owners.txt (PLC, REIT, sovereign wealth / state-backed),
    the company's own CH type is 'plc', or a PSC's stated legal form is a public limited company.

Public data only: charges / spv_companies / lender_classifications (via maturity_radar.q, allowlisted,
READ ONLY session) and the Companies House REST API (maturity_radar.CH, cached). Never reads Loan Intel
member tables or experian_*.
"""
import datetime as dt
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import maturity_radar as mr

HERE = os.path.dirname(os.path.abspath(__file__))
OWNERS_FILE = os.path.join(HERE, "radar_excluded_owners.txt")

REFI_CHECK_MAX = 60      # candidates refinance-checked per section (by current rank); the rest are dropped
OWNER_LEVELS = 4         # PSC levels walked for the institutional-owner test (2 missed L&G / B&M listed parents)
GROUP_PARENT_LEVELS = 2  # parent levels whose own charges count in the group refinance check
OWNER_CEASED_MONTHS = 12  # ceased PSCs within this many months still count as owners
GROUP_MAX = 40           # group companies whose charges are checked per candidate
APPT_DIRECTORS = 3       # directors whose appointments are read (sibling-by-board test)
APPT_MAX_ITEMS = 60      # directors with more appointments than this are skipped (nominee/professional)
SIBLING_ROWS_MAX = 200   # spv_companies rows read per same-PSC sibling search
WIDE_PARENT_MIN = 15     # a parent with this many SPVs in spv_companies = platform: sibling agent/portfolio charges flag only
WORKERS = 6

CLOSED = {"dissolved", "converted-closed", "closed", "removed"}
UK_REG = re.compile(r"^(\d{8}|(SC|NI|OC|SO|NC|R0|LP|SL|NL|GE|FC)\d{6})$")
UK_PLACE = re.compile(r"companies house|england|wales|scotland|united kingdom|\buk\b|great britain|"
                      r"northern ireland|companies act|registrar of companies for", re.I)
UK_SUFFIX = re.compile(r"\b(limited|ltd\.?|plc|llp|l\.?p\.?)\s*$", re.I)
PLC_FORM = re.compile(r"public limited|public company|\bplc\b", re.I)
TRUSTEE_LENDER = re.compile(r"security (agent|trustee)|as (agent|trustee)|trustees? for|on behalf of|"
                            r"for the secured parties|\bglas\b|trust corporation", re.I)
PORTFOLIO_DESC = re.compile(r"\bportfolio\b|\bthe properties\b|properties (listed|set out|specified|detailed|"
                            r"described|referred)|schedule[^.]{0,30}propert", re.I)
PC_RX = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.I)
ADDR_STOP = set("""road street lane avenue close drive house land property properties known freehold
leasehold commonhold registered title number numbers being situated situate lying unit units flat flats
floor part with side north south east west upper lower building buildings site premises the and that those
known being whole parts first second third ground legal mortgage charge over under land registry within
plus also including together formerly comprising more particularly described thereof which where""".split())
TITLE_OK = re.compile(r"^[A-Z]{1,3}\d{3,7}$")


def log(*a):
    print(*a, flush=True)


def _d(s):
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def mon(d):
    d = _d(d) if not isinstance(d, dt.date) else d
    return d.strftime("%b %Y") if d else "?"


def fdate(d):
    d = _d(d) if not isinstance(d, dt.date) else d
    return d.strftime("%-d %b %Y") if d else "?"


# --------------------------------------------------------------------------- institutional owners
_OWNER_RX = None


def owner_patterns():
    """[(section, compiled regex, source line)] from radar_excluded_owners.txt (read once)."""
    global _OWNER_RX
    if _OWNER_RX is None:
        out, sec = [], "other"
        for line in open(OWNERS_FILE):
            line = re.sub(r"\s+#.*$", "", line).strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^\[(.+)\]$", line)
            if m:
                sec = m.group(1).strip().lower()
                continue
            out.append((sec, re.compile(line, re.I), line))
        _OWNER_RX = out
    return _OWNER_RX


def owner_match(name):
    """(section, pattern) for the first owner pattern matching name, else None."""
    for sec, rx, src in owner_patterns():
        if name and rx.search(name):
            return sec, src
    return None


def _lite(s):
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\bltd\b\.?", "limited", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _uk_number(ident):
    reg = re.sub(r"\s", "", str(ident.get("registration_number") or "")).upper()
    if not reg:
        return None
    if reg.isdigit() and len(reg) < 8:
        reg = reg.zfill(8)
    place = " ".join(str(ident.get(k) or "") for k in ("place_registered", "country_registered",
                                                        "legal_authority"))
    if UK_REG.match(reg) and (UK_PLACE.search(place) or not place.strip()):
        return reg
    return None


def _search_uk(ch, name):
    """UK company number for an exact (light-normalised) name match via CH search; None otherwise."""
    if not name or not UK_SUFFIX.search(name):
        return None
    d = ch.get(f"/search/companies?q={quote(name)}&items_per_page=5") or {}
    want = _lite(name)
    for it in d.get("items") or []:
        if _lite(it.get("title")) == want:
            return it.get("company_number")
    return None


def _corp_items(ch, cn):
    d = ch.get(f"/company/{cn}/persons-with-significant-control?items_per_page=100") or {}
    return [x for x in d.get("items") or []
            if "corporate" in (x.get("kind") or "") or "legal-person" in (x.get("kind") or "")]


def build_chain(ch, c, run, levels=OWNER_LEVELS):
    """Ownership chain from the CH PSC API: level 1 = all corporate / legal-person PSCs (current and
    ceased), level 2+ = current PSCs (+ ceased within OWNER_CEASED_MONTHS) of UK-registered owners that
    are current or recently ceased. Pure CH (thread-safe with a threaded CH client)."""
    recent = mr.add_months(run, -OWNER_CEASED_MONTHS).isoformat()
    nodes, seen, recorded = [], {c["company_number"]}, set()
    frontier = [(c["company_number"], None)]
    for lvl in range(1, levels + 1):
        nxt = []
        for cn, via in frontier:
            for x in _corp_items(ch, cn):
                ceased = x.get("ceased_on")
                if lvl > 1 and ceased and ceased < recent:
                    continue
                ident = x.get("identification") or {}
                num = _uk_number(ident) or _search_uk(ch, x.get("name"))
                walk = not ceased or ceased >= recent
                if num and (num in seen or (not walk and num in recorded)):
                    continue
                node = {"name": x.get("name") or "", "cn": num, "level": lvl, "ceased_on": ceased,
                        "legal_form": ident.get("legal_form") or "", "via": via, "type": None}
                nodes.append(node)
                if num:
                    recorded.add(num)
                    if walk:
                        seen.add(num)
                        nxt.append((num, node["name"]))
        frontier = nxt[:6]
    for n in nodes:
        if n["cn"]:
            p = ch.get(f"/company/{n['cn']}") or {}
            n["type"] = p.get("type")
            n["status"] = p.get("company_status")
            n["name"] = n["name"] or p.get("company_name") or n["cn"]
    return nodes


def institutional_owner(c, nodes, run):
    """None, or (owner name, why) when the company is owned by / part of a PLC, REIT or sovereign /
    state-backed investor (company itself, or owner chain incl. PSCs ceased within 12 months)."""
    recent = mr.add_months(run, -OWNER_CEASED_MONTHS).isoformat()
    own = c.get("name") or ""
    hit = owner_match(own)
    if hit and hit[0] == "plc":
        return own, "company name contains PLC"
    if hit:
        return own, f"company name matches {hit[0]} list ({hit[1]})"
    if ((c.get("profile") or {}).get("type") or "") == "plc":
        return own, "company is a PLC (Companies House type plc)"
    for n in nodes:
        if n["ceased_on"] and n["ceased_on"] < recent:
            continue
        rel = ("parent" if n["level"] == 1 else f"level-{n['level']} owner via {n['via']}") + (
            f", ceased {fdate(n['ceased_on'])}" if n["ceased_on"] else "")
        h = owner_match(n["name"])
        if h:
            lbl = {"plc": "PLC", "reit": "REIT", "sovereign": "sovereign / state-backed"}.get(h[0], h[0])
            return n["name"], f"{lbl} owner ({rel})"
        if PLC_FORM.search(n["legal_form"] or ""):
            return n["name"], f"PLC owner, legal form '{n['legal_form']}' ({rel})"
        if (n.get("type") or "") == "plc":
            return n["name"], f"PLC owner, Companies House type plc ({rel})"
    return None


# --------------------------------------------------------------------------- group companies
def director_siblings(ch, cn):
    """{company_number: (name, shared directors)} for live companies sharing >= 2 active directors."""
    off = ch.get(f"/company/{cn}/officers?items_per_page=100") or {}
    act = [o for o in off.get("items") or [] if not o.get("resigned_on")
           and o.get("officer_role") in ("director", "llp-designated-member", "llp-member")]
    if len(act) < 2:
        return {}, 0
    cnt, names, used = Counter(), {}, 0
    for o in act[:APPT_DIRECTORS]:
        link = ((o.get("links") or {}).get("officer") or {}).get("appointments")
        if not link:
            continue
        d = ch.get(link + "?items_per_page=50") or {}
        if (d.get("total_results") or 0) > APPT_MAX_ITEMS:
            continue
        used += 1
        for a in d.get("items") or []:
            to = a.get("appointed_to") or {}
            k = to.get("company_number")
            if a.get("resigned_on") or not k or k == cn or (to.get("company_status") or "") in CLOSED:
                continue
            cnt[k] += 1
            names[k] = to.get("company_name") or k
    return {k: (names[k], n) for k, n in cnt.items() if n >= 2}, used


def psc_siblings(conn, cn, parent_names):
    """{company_number: (name, parent)} for companies whose spv_companies.psc names the same parent."""
    names = [n for n in dict.fromkeys(parent_names) if n and len(_lite(n)) >= 6]
    if not names:
        return {}
    rx = "|".join(re.escape(n) for n in names)
    rows = mr.q(conn, """select s.company_number, s.company_name, s.psc from public.spv_companies s
                         where s.psc ~* %s and s.company_number <> %s limit %s""",
                (rx, cn, SIBLING_ROWS_MAX))
    want = {_lite(n): n for n in names}
    out, per = {}, Counter()
    for r in rows:
        for seg in re.split(r"\s*\|\s*", r["psc"] or ""):
            k = _lite(re.sub(r"\(\s*\d.*?\)\s*$", "", seg))
            if k in want:
                out[r["company_number"]] = (r["company_name"] or r["company_number"], want[k])
                per[want[k]] += 1
                break
    # wide platform parent (fund / conglomerate with many SPVs): its other subsidiaries' security-agent
    # or portfolio charges are usually unrelated financings, so they only flag (unless same property)
    return {k: (nm, par, per[par] >= WIDE_PARENT_MIN) for k, (nm, par) in out.items()}


def group_companies(conn, c, nodes, dir_sibs, since):
    """{company_number: (name, relation)} ordered parents, board siblings, same-PSC siblings; capped."""
    grp = {}
    rel_parents = [n for n in nodes if (not n["ceased_on"] or n["ceased_on"] >= since)
                   and n["level"] <= GROUP_PARENT_LEVELS]
    for n in rel_parents:
        if n["cn"] and n["cn"] != c["company_number"]:
            grp.setdefault(n["cn"], (n["name"], "parent" if n["level"] == 1 else f"owner of {n['via']}", False))
    for k, (nm, shared) in sorted(dir_sibs.items(), key=lambda kv: -kv[1][1]):
        grp.setdefault(k, (nm, f"shares {shared} directors", False))
    l1 = [n["name"] for n in rel_parents if n["level"] == 1]
    for k, (nm, par, wide) in psc_siblings(conn, c["company_number"], l1).items():
        grp.setdefault(k, (nm, f"sibling, same parent {par}" + (" (multi-SPV platform)" if wide else ""), wide))
    grp.pop(c["company_number"], None)
    return dict(list(grp.items())[:GROUP_MAX])


# --------------------------------------------------------------------------- property keys
NUM_RX = re.compile(r"\b(\d{1,4})[a-z]?(?:\s*(?:-|to|and|&)\s*(\d{1,4})[a-z]?)?\b", re.I)


UNIT_ID = re.compile(r"\b(?:unit|units|block|plot|building|flat|suite)\s+([a-z]\d{0,3}[a-z]?|\d+[a-z]?)\b", re.I)


def _house_nums(text):
    out = set()
    for a, b in NUM_RX.findall(text or ""):
        a = int(a)
        b = int(b) if b else a
        if b < a or b - a > 200:
            b = a
        out |= set(range(a, b + 1))
    return out


def _addr_parts(segment_text):
    """(distinctive words, house/unit numbers) from the address text before a postcode. The last
    comma segment (the town) is dropped when there is more than one segment."""
    # keep only this property's text: drop anything up to a previous postcode, title number or ';'
    segment_text = re.split(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b[A-Z]{2,3}\d{3,7}\b|;",
                            segment_text, flags=re.I)[-1]
    head = re.sub(r"^.*?\b(known as|situated? at|being|property at|land at|forming)\b", "", segment_text.lower(), count=1)
    head = re.split(r"\b(title|registered|and the (freehold|leasehold))\b", head)[0]
    segs = [x for x in re.split(r"[,;.]", head) if x.strip()]
    if len(segs) > 1:
        segs = segs[:-1]
    segs = segs[-3:]
    toks = {t for x in segs for t in re.findall(r"[a-z]{4,}", x) if t not in ADDR_STOP}
    text = " ".join(segs)
    ids = {f"#{n}" for n in _house_nums(text)} | {f"u{u.lower()}" for u in UNIT_ID.findall(text)}
    return toks, ids


def _addr_key(desc):
    """(postcode no-space upper, distinctive street/building words, house/unit numbers) for the first
    full postcode in desc, from the address text just before it."""
    if not desc:
        return None
    m = PC_RX.search(desc)
    if not m:
        return None
    pc = (m.group(1) + m.group(2)).upper()
    toks, nums = _addr_parts(desc[max(0, m.start() - 160):m.start()])
    return pc, frozenset(toks), frozenset(nums)


def _key_ok(key):
    """Usable address key: >= 2 distinctive words, or one building/street word of >= 5 letters."""
    return len(key[1]) >= 2 or any(len(t) >= 5 for t in key[1])


def addr_match(key, desc):
    """Strong address match: same full postcode AND the key's street/building words (2 if it has 2+) near that postcode
    in the other description AND house/unit numbers not contradicting."""
    if not key or not _key_ok(key) or not desc:
        return False
    for m in PC_RX.finditer(desc):
        if (m.group(1) + m.group(2)).upper() != key[0]:
            continue
        toks, nums = _addr_parts(desc[max(0, m.start() - 160):m.start()])
        if len(key[1] & toks) < min(2, len(key[1])):
            continue
        if bool(key[2]) != bool(nums) or (key[2] and not (key[2] & nums)):
            continue  # house/unit numbers contradict, or only one side has one
        return True
    return False


def property_keys(descs):
    titles, keys = [], []
    for d in descs:
        if not d or mr.GENERIC_DESC.match(d.strip()) or len(d.strip()) < 8:
            continue
        titles += [t for t in mr._titles(d) if TITLE_OK.match(t) and t not in titles]
        k = _addr_key(d)
        if k and _key_ok(k) and k not in keys:
            keys.append(k)
    return titles[:12], keys[:4]


# --------------------------------------------------------------------------- the check
def _different(lender, incumbents):
    import radar_distress as rd
    return not any(rd.same_lender(lender or "", n) for n in incumbents if n)


def own_check_main(c, items, w_start, w_end):
    """Main band (a): qualifying charge(s) still outstanding on the CH register, and no newer charge by a
    lender other than the qualifying lender(s). Sets anchor fields. Returns None or (kind, reason)."""
    import radar_distress as rd
    db_lenders = {n for r in c["charges"] for n in (r.get("lender"), r.get("lname")) if n}
    lo, hi = w_start.isoformat(), w_end.isoformat()
    anchor_db = c["dates"][0]
    c.update(anchor=anchor_db, anchor_lender=c["charges"][0]["lname"], qual_descs=[
        r.get("property_description") for r in c["charges"]], own_note="", own_checked=items is not None)
    if items is None:
        c["own_note"] = "CH charges register unavailable, database rows used"
        return None
    in_win = [i for i in items if lo <= (i.get("created_on") or "") <= hi]
    by_name = [i for i in in_win if any(rd.same_lender(p, n) for p in rd._persons(i) for n in db_lenders)]
    cand = by_name or [i for i in in_win if i.get("created_on") in set(c["dates"])]
    qual = [i for i in cand if i.get("status") in ("outstanding", "part-satisfied")]
    if cand and not qual:
        sat = max((i.get("satisfied_on") or "") for i in cand)
        return "own", f"qualifying charge now satisfied on the CH register{(' (' + fdate(sat) + ')') if sat else ''}"
    if not qual:
        c["own_note"] = "qualifying charge not matched on the CH register, database rows used"
        return None
    qual.sort(key=lambda i: i.get("created_on"))
    anchor = qual[0]
    inc = db_lenders | {p for i in qual for p in rd._persons(i)}
    db_hit = next((r for r in c["charges"] if r["date_created"] == anchor["created_on"]), None)
    c["anchor"] = anchor["created_on"]
    c["anchor_lender"] = (db_hit or {}).get("lname") or mr.norm_lender((rd._persons(anchor) or [c["anchor_lender"]])[0])
    c["qual_descs"] = [(i.get("particulars") or {}).get("description") for i in qual] + c["qual_descs"]
    c["incumbents"] = sorted(inc)
    qids = {(i.get("links") or {}).get("self") for i in qual}
    newer = []
    for i in items:
        dc = i.get("created_on") or ""
        if not dc or dc <= anchor["created_on"] or (i.get("links") or {}).get("self") in qids:
            continue
        ps = rd._persons(i)
        if not ps or not any(rd.same_lender(p, n) for p in ps for n in inc):
            newer.append((dc, mr.norm_lender(ps[0]) if ps else "(lender not stated)", i.get("status")))
    if newer:
        newer.sort()
        dc, ln, st = newer[0]
        more = f" (+{len(newer) - 1} more)" if len(newer) > 1 else ""
        return "own", f"newer charge from another lender: {ln} on {fdate(dc)} ({st}){more}"
    return None


def group_title_check(conn, c, nodes, dir_sibs, since, incumbents, descs):
    """(b) group + (c) same property. Returns dict(status, kind, reason, flags, n_group, titles, addr)."""
    res = {"status": "clear", "kind": None, "reason": "", "flags": [], "titles": [], "addr": False,
           "group_charges": [], "since": since}  # group_charges: newer different-lender group charges (deep dive)
    grp = group_companies(conn, c, nodes, dir_sibs, since)
    res["n_group"] = len(grp)
    titles, keys = property_keys(descs)
    res["titles"], res["addr"] = titles, bool(keys)
    c["group_cos"] = [f"{nm} ({cn}; {rel})" for cn, (nm, rel, _) in grp.items()]

    # (c) same property, any company (not the candidate itself; its own charges are test a)
    if titles or keys:
        parts = []
        if titles:
            parts.append(r"\m(" + "|".join(titles) + r")\M")
        for k in keys:
            parts.append(r"\m" + k[0][:-3] + r"\s*" + k[0][-3:] + r"\M")
        rows = mr.q(conn, """select c.company_number, c.lender, c.date_created, c.property_description,
                                    s.company_name
                             from public.charges c
                             left join public.spv_companies s on s.company_number = c.company_number
                             where c.date_created ~ '^\\d{4}-\\d{2}-\\d{2}$' and c.date_created >= %s
                               and c.company_number <> %s and c.property_description ~* %s
                             order by c.date_created""",
                    (since, c["company_number"], "|".join(parts)))
        for r in rows:
            d = r["property_description"] or ""
            hit_t = [t for t in titles if re.search(r"\b" + t + r"\b", d, re.I)]
            hit_a = not hit_t and any(addr_match(k, d) for k in keys)
            if not (hit_t or hit_a):
                continue
            what = f"title {hit_t[0]}" if hit_t else "same address"
            who = f"{(r['company_name'] or r['company_number']).title()} ({r['company_number']})"
            ln = mr.norm_lender(r["lender"] or "(lender not stated)")
            if _different(r["lender"], incumbents):
                snip = re.sub(r"\s+", " ", d)[:110]
                res.update(status="excluded", kind="title",
                           reason=f"asset refinanced/sold: {what} charged to {ln} by {who} on {fdate(r['date_created'])}"
                                  + (f" ('{snip}...')" if hit_a else ""))
                return res
            if r["company_number"] in grp or hit_t:
                res["flags"].append(f"possible restructure within group, same lender: {what} charged to {ln} "
                                    f"by {who} on {fdate(r['date_created'])}")

    # (b) group companies' newer charges from a different lender
    if grp:
        rows = mr.q(conn, """select c.company_number, c.lender, c.date_created, c.property_description,
                                    c.status, lc.lender_type
                             from public.charges c
                             left join public.lender_classifications lc on lc.lender = c.lender
                             where c.company_number = any(%s) and c.date_created ~ '^\\d{4}-\\d{2}-\\d{2}$'
                               and c.date_created >= %s order by c.date_created""", (list(grp), since))
        for r in rows:
            if not _different(r["lender"], incumbents):
                continue
            d = r["property_description"] or ""
            nm, rel, wide = grp[r["company_number"]]
            ln = mr.norm_lender(r["lender"] or "(lender not stated)")
            who = f"{nm.title()} ({r['company_number']}; {rel})"
            hit_t = [t for t in titles if re.search(r"\b" + t + r"\b", d, re.I)]
            same_prop = hit_t or any(addr_match(k, d) for k in keys)
            res["group_charges"].append({"date": r["date_created"], "company": nm, "company_number": r["company_number"],
                                         "relation": rel, "lender": ln, "status": r.get("status")})
            n_titles = len([t for t in mr._titles(d) if TITLE_OK.match(t)]) if d else 0
            agent = r["lender_type"] == "trustee" or bool(TRUSTEE_LENDER.search(r["lender"] or ""))
            portfolio = n_titles >= 3 or bool(PORTFOLIO_DESC.search(d))
            if same_prop or ((agent or portfolio) and not wide):
                why = (f"same title {hit_t[0]}" if hit_t else "same property" if same_prop
                       else "security-agent charge" if agent else "portfolio-style charge")
                res.update(status="excluded", kind="group",
                           reason=f"group refinance: {who} charged to {ln} on {fdate(r['date_created'])} ({why})")
                return res
            res["flags"].append(f"possible group refinance: {who} charged to {ln} on {fdate(r['date_created'])}")
    if res["flags"]:
        res["status"] = "flag"
    return res


def check_line(rc):
    """'Refinance check' card value."""
    if not rc:
        return "not checked"
    n = rc.get("n_group", 0)
    grp = f"{n} group compan{'y' if n == 1 else 'ies'}"
    if rc.get("titles"):
        tsearch = "title search " + ", ".join(rc["titles"][:3]) + (" ..." if len(rc["titles"]) > 3 else "")
    elif rc.get("addr"):
        tsearch = "address search"
    else:
        tsearch = "no title or address on the charge to search"
    scope = f"own charges, {grp}, {tsearch}"
    if rc.get("own_note"):
        scope += f"; {rc['own_note']}"
    if rc["status"] == "flag":
        extra = f" (+{len(rc['flags']) - 1} more)" if len(rc["flags"]) > 1 else ""
        return f"flag: {rc['flags'][0]}{extra}. Checked {scope}"
    if rc["status"] == "excluded":
        return f"excluded: {rc['reason']}"
    return f"clear ({scope})"


def screen(ch, conn, cands, run, mode, own=None, since_fn=None, cap=REFI_CHECK_MAX, label=""):
    """Institutional-owner exclusion, then refinance check (own via `own(c)`, group, title) over cands in
    rank order until `cap` candidates have been refinance-checked. Returns (kept, stats).
    since_fn(c) -> ISO date from which a different-lender charge counts as a refinance."""
    import radar_distress as rd
    t0 = time.time()
    ch = rd.threaded_ch(ch)
    st = {"owner": [], "own": [], "group": [], "title": [], "flag": [], "clear": [], "unchecked": 0,
          "checked": 0, "excluded_list": []}
    kept, i = [], 0
    batch = max(cap, 20)
    while i < len(cands) and st["checked"] < cap:
        chunk = cands[i:i + batch]
        i += len(chunk)
        with ThreadPoolExecutor(WORKERS) as ex:
            chains = list(ex.map(lambda c: build_chain(ch, c, run), chunk))
        for c, nodes in zip(chunk, chains):
            c["owner_chain"] = nodes
            hit = institutional_owner(c, nodes, run)
            if hit:
                c["owner_excluded"] = hit
                st["owner"].append(c)
                st["excluded_list"].append(("owner", c, f"{hit[0]}: {hit[1]}"))
        live = [c for c in chunk if not c.get("owner_excluded")]
        live = live[:max(cap - st["checked"], 0)]
        with ThreadPoolExecutor(WORKERS) as ex:
            sibs = list(ex.map(lambda c: director_siblings(ch, c["company_number"]), live))
        for c, (dsib, used) in zip(live, sibs):
            st["checked"] += 1
            rc = None
            o = own(c) if own else None
            if o:
                rc = {"status": "excluded", "kind": "own", "reason": o[1], "flags": [], "n_group": 0,
                      "titles": [], "addr": False}
            else:
                since = since_fn(c)
                incumbents = c.get("incumbents") or sorted(
                    {n for r in c["charges"] for n in (r.get("lender"), r.get("lname")) if n})
                rc = group_title_check(conn, c, c["owner_chain"], dsib, since, incumbents,
                                       [d for d in (c.get("qual_descs") or
                                                    [r.get("property_description") for r in c["charges"]]) if d])
                rc["own_note"] = c.get("own_note") or ""
                rc["dir_used"] = used
            c["refi_check"] = rc
            c["refi_line"] = check_line(rc)
            if rc["status"] == "excluded":
                st[rc["kind"]].append(c)
                st["excluded_list"].append((rc["kind"], c, rc["reason"]))
            else:
                st["flag" if rc["status"] == "flag" else "clear"].append(c)
                kept.append(c)
    st["unchecked"] = len(cands) - i + sum(1 for c in cands[:i] if not c.get("owner_excluded")
                                           and "refi_check" not in c)
    st["secs"] = round(time.time() - t0)
    log(f"{label} refinance check: owner-excluded {len(st['owner'])}, checked {st['checked']} (cap {cap}); "
        f"excluded own {len(st['own'])}, group {len(st['group'])}, title {len(st['title'])}; flagged "
        f"{len(st['flag'])}, clear {len(st['clear'])}; not checked (beyond cap) {st['unchecked']}; {st['secs']}s")
    for kind, c, why in st["excluded_list"]:
        log(f"  {label} excluded [{kind}] {c['name'][:50]} ({c['company_number']}): {why}")
    for c in st["flag"]:
        log(f"  {label} flagged {c['name'][:50]} ({c['company_number']}): {c['refi_check']['flags'][0]}")
    return kept, st
