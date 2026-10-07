#!/usr/bin/env python3
"""
Director + company LinkedIn finder for the Refinancing Radar cards (rebuilt 7 Oct 2026).

Marcus: "link to the URL of the person, directors shouldn't be too hard if I can find it myself". The old
matcher ran ONE query per director and needed the company name in the top result: ~3/26 hit rate.

Method (public web search only; LinkedIn itself is never fetched, scraped or logged into):
  1. Per active director (CH officers, up to MAX_DIRECTORS): up to MAX_Q_PER_PERSON Brave queries, cached
     CACHE_DAYS days: "First Last" site:linkedin.com/in + company name; + parent/group name (or the
     director's best-known other directorship); + registered-office town and asset-class word; + middle-name
     variant (CH gives "SURNAME, First Middle"; people often go by the middle name) or an asset-class phrase.
     Names are searched as first + last without middle names.
  2. The group/company website (found by the deep dive) "team"/"about"/"people" pages are read (robots.txt
     respected) for links to linkedin.com/in and linkedin.com/company.
  3. Candidates (url, title, snippet, source) go to Claude with the facts: name variants, occupation and
     country of residence (CH), current company/group names, the director's other directorships (CH officer
     appointments, top 5 company names), location, asset class. Claude returns {url, confidence, reason}.
     "matched" = name match + an employer / group / other-directorship match in the title/snippet (or the
     company's own team page); "possible" = name + sector or location only. Checked mechanically after
     Claude (url must be a candidate, name must be in the profile title, "matched" needs an organisation
     token in the evidence or it drops to "possible").
  4. Same for the company/group LinkedIn page (linkedin.com/company).
"""
import html as H
import json
import re
import time
import unicodedata
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import asset_profile as ap

CACHE_DAYS = 90
MAX_Q_PER_PERSON = 4  # + 1 bare fallback when no candidate carries the name
MAX_DIRECTORS = 6
MAX_CANDIDATES = 8
TEAM_FETCHES = 7
WORKERS = 5
TEAM_PATHS = ["/team", "/our-team", "/about", "/about-us", "/people", "/who-we-are", "/leadership", "/meet-the-team"]
CLASS_TERMS = {"Hotels": ("hotel", "hospitality"), "Care": ("care", "healthcare"), "SEN": ("education", "school"),
               "Living": ("property", "real estate"), "Offices": ("property", "real estate"),
               "Logistics/Industrial": ("property", "real estate"), "Retail/Leisure": ("property", "real estate")}
SECTOR_RX = re.compile(r"propert|real estate|estates?\b|invest|asset manag|develop|hotel|hospitality|care\b|"
                       r"healthcare|nursing|living|residential|logistics|capital|fund|reit|portfolio|surveyor|"
                       r"construction|school|education|leisure|retail", re.I)
UK_RX = re.compile(r"united kingdom|\buk\b|england|scotland|wales|london|manchester|birmingham|leeds|liverpool|"
                   r"bristol|glasgow|edinburgh|cardiff|newcastle|sheffield|nottingham|leicester|belfast|"
                   r"greater \w+ area|\w+shire", re.I)
GENERIC = {"limited", "ltd", "group", "holdings", "holding", "property", "properties", "investments", "investment",
           "capital", "care", "hotel", "hotels", "living", "homes", "estates", "estate", "health", "healthcare",
           "services", "london", "management", "developments", "development", "real", "assets", "asset", "fund",
           "partners", "social", "trust", "company", "international", "global", "uk", "the", "and", "of", "bidco",
           "topco", "midco", "holdco", "propco", "opco", "investors", "residential", "commercial", "ventures"}
TITLES = re.compile(r"^(mr|mrs|ms|miss|dr|sir|lord|lady|dame|prof)\.?\s+", re.I)

LI_SYS = """You match UK company directors to their LinkedIn profiles using ONLY the supplied web search results
(title, snippet, url) and team-page excerpts. LinkedIn itself was not visited.
For each director pick at most ONE candidate url from THAT director's candidates, or none.
confidence:
  "matched"  = the profile's name matches the director (first name or a middle name or an obvious short form, plus
               surname) AND the title/snippet/excerpt names an employer, group or company that matches the company,
               its group/parent, a brand/operator of its asset, or one of the director's other directorships.
               A link found on the company's or group's own team page next to the director's name is "matched".
  "possible" = the name matches and the title/snippet only fits on sector (property, hotels, care, education...)
               or UK location; no employer match.
  "none"     = otherwise (different person, other country with no link, unrelated sector, ambiguous between several).
Never pick a profile whose name is a different person (different surname or clearly different first name).
reason: a short factual phrase copied from what the title/snippet says about the person (role, employer, location),
e.g. "Director at Union Living, Manchester" or "Property investor, London"; do not explain why it matches.
No speculation. No em dashes.
Also pick the company's LinkedIn page from company_candidates (linkedin.com/company/...) with the same
matched/possible/none scale: matched = the page name matches the company, its group/parent or its brand.
Return ONLY JSON: {"directors": [{"id": int, "url": str|null, "confidence": "matched"|"possible"|"none",
"reason": str, "basis": str}], "company": {"url": str|null, "confidence": "matched"|"possible"|"none", "reason": str}}
reason = what the profile says (shown to the reader); basis = why it matches (internal, short).
For the company, reason = the page name as shown, plus follower count or location if given."""


def _ascii(s):
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()


def _toks(s):
    return {t for t in re.findall(r"[a-z0-9]+", _ascii(s)) if len(t) >= 3}


def org_tokens(*names):
    out = set()
    for n in names:
        out |= {t for t in _toks(ap._clean_owner(n or "")) if len(t) >= 4 and t not in GENERIC}
    return out


def parse_name(raw):
    """'SMITH-JONES, John Michael (appointed ...)' -> dict(first, middles, last, full) or None (corporate)."""
    nm = raw.split(" (appointed")[0]
    if "," not in nm:
        return None
    sur, fore = [x.strip() for x in nm.split(",", 1)]
    fore = TITLES.sub("", fore)
    parts = [p for p in re.split(r"\s+", fore) if p and not re.match(r"^[A-Z]\.?$", p)]
    initials = [p[0] for p in re.split(r"\s+", fore) if p]
    if not parts or not sur:
        return None
    cap = lambda s: "-".join(w[:1].upper() + w[1:].lower() for w in s.split("-"))
    last = " ".join(cap(w) for w in sur.split())
    first = cap(parts[0])
    middles = [cap(p) for p in parts[1:]]
    # people often go by a middle name or one half of a hyphenated first name ("Al-Karim" -> "Karim")
    alts = [x for x in first.split("-") if len(x) >= 3 and x != first] + middles
    return {"first": first, "middles": middles, "alts": list(dict.fromkeys(alts)), "last": last,
            "full": f"{first} {last}", "initials": initials, "ch_name": nm}


def norm_li(url):
    u = re.sub(r"^https?://([a-z]{2,3}\.)?linkedin\.com", "https://www.linkedin.com", (url or "").split("?")[0])
    return u.rstrip("/") + "/"


def brave(q):
    b = ap.brave(q, count=10, ns="brave_li", ttl=CACHE_DAYS * ap.DAY)
    return b.get("results") or []


def _profile_name(title):
    t = re.sub(r"<[^>]+>", "", title or "")
    return re.split(r"\s[-|–—]\s", t)[0].strip()


def name_ok(p, title):
    who = _toks(_profile_name(title))
    sur = _toks(p["last"])
    firsts = {_ascii(p["first"])} | {_ascii(m) for m in p.get("alts") or p["middles"]}
    return bool(sur) and sur <= who and any(f in who or any(w.startswith(f[:3]) and len(f) >= 3 and w[:3] == f[:3]
                                                            for w in who) for f in firsts)


def officers(ch, c):
    """Active directors with CH metadata + top 5 other directorships."""
    off = ch.get(f"/company/{c['company_number']}/officers?items_per_page=100") or {}
    out = []
    for o in off.get("items") or []:
        if o.get("resigned_on") or o.get("officer_role") not in ("director", "llp-member", "llp-designated-member"):
            continue
        p = parse_name(o.get("name") or "")
        if not p:
            continue
        link = ((o.get("links") or {}).get("officer") or {}).get("appointments")
        others = []
        if link:
            d = ch.get(link + "?items_per_page=50") or {}
            items = sorted(d.get("items") or [], key=lambda a: (bool(a.get("resigned_on")),
                                                                  (a.get("appointed_to") or {}).get("company_status") != "active"))
            for a in items:
                to = a.get("appointed_to") or {}
                if to.get("company_number") != c["company_number"] and to.get("company_name"):
                    others.append(to["company_name"])
            others = list(dict.fromkeys(others))[:5]
        key = next((d for d in c.get("directors") or [] if d.split(" (appointed")[0] == o.get("name")), o.get("name"))
        out.append({**p, "key": key, "occupation": o.get("occupation"),
                    "country": o.get("country_of_residence"), "appointed": o.get("appointed_on"), "others": others})
    return out[:MAX_DIRECTORS]


def _group_name(c):
    return next((ap._clean_owner(p) for p in c.get("parents") or [] if p), "")


def person_queries(p, c, town):
    org = ap._clean_owner(c["name"])
    grp = _group_name(c)
    terms = CLASS_TERMS.get(c.get("cls"), ("property", "real estate"))
    qn = f'"{p["first"]} {p["last"]}"'
    # Brave often returns nothing for quoted name + company + site:, so the company query runs without site:
    qs = [f"{qn} {org} linkedin"]
    if grp and grp.lower() != org.lower():
        qs.append(f"{qn} {grp} site:linkedin.com/in")
    elif p["others"]:
        qs.append(f"{qn} {ap._clean_owner(p['others'][0])} site:linkedin.com/in")
    qs.append(f"{qn} {town} {terms[0]} site:linkedin.com/in".replace("  ", " "))
    if p.get("alts"):
        qs.append(f'"{p["alts"][0]} {p["last"]}" {grp or org} linkedin')
    else:
        qs.append(f"{qn} {terms[1]} linkedin")
    return list(dict.fromkeys(qs))[:MAX_Q_PER_PERSON]


def team_pages(sites, pages=()):
    """[(page url, [(li url, nearby text)])] from the company's own pages that search results pointed to (e.g.
    vitagroup.com/people/mark-stott/) and team/about pages of its websites (robots respected)."""
    out, fetched = [], 0
    urls = list(dict.fromkeys(list(pages)[:3] + [b.rstrip("/") + pth for b in sites[:2] for pth in [""] + TEAM_PATHS]))
    for url in urls:
        if fetched >= TEAM_FETCHES:
            return out
        if not ap._allowed(url):
            continue
        code, body = ap.http_get(url, ns="page", ttl=ap.TTL["page"], as_json=False, timeout=15,
                                 headers={"Accept": "text/html"})
        fetched += 1
        if code != 200 or not body:
            continue
        links = []
        for m in re.finditer(r'href="(https?://[a-z.]*linkedin\.com/(?:in|company)/[^"?#]+)', body, re.I):
            ctx = re.sub(r"<[^>]+>", " ", body[max(0, m.start() - 600):m.start()])
            ctx = re.sub(r"\s+", " ", H.unescape(ctx)).strip()[-220:]
            links.append((norm_li(m.group(1)), ctx))
        if links:
            out.append((url, links))
    return out


def find_for_card(c, ch):
    """Sets c['li_detail'] {director key: {url, confidence, reason}}, c['li_directors'] {key: url|None}
    (matched/possible only), c['li_company'], c['li_company_detail']. Returns per-card stats."""
    town = (((c.get("profile") or {}).get("registered_office_address") or {}).get("locality")
            or (c.get("deep") or {}).get("town") or "")
    dirs = officers(ch, c)
    org = ap._clean_owner(c["name"])
    grp = _group_name(c)
    a = c.get("asset") or {}
    brands = [x for x in (a.get("brand"), a.get("operator")) if x and x != ap.UNKNOWN]
    nq = 0
    payload_dirs = []
    org_t = org_tokens(org, grp, *brands)
    sites = list((c.get("deep") or {}).get("websites") or [])
    own_pages, co_hits, searched = [], [], []
    for p in dirs:
        rs = []
        for q in person_queries(p, c, town):
            nq += 1
            rs += brave(q)
        if not any("linkedin.com/in/" in (r.get("url") or "") and name_ok(p, r.get("title")) for r in rs):
            nq += 1  # nothing with the name yet: one bare fallback (5th query at most)
            rs += brave(f'"{p["first"]} {p["last"]}" site:linkedin.com/in')
        searched.append(rs)
        for r in rs:
            u = r.get("url") or ""
            m = re.match(r"^https?://([^/]+)", u)
            if not m:
                continue
            if "linkedin.com/company/" in u:
                co_hits.append(r)
            elif "linkedin.com" not in u and not re.search(r"company-information|companieshouse|endole|pomanda|"
                                                           r"companycheck|opencorporates|192\.com|bloomberg|zoominfo|"
                                                           r"rocketreach|facebook|instagram|twitter|x\.com", u):
                label = re.sub(r"^www\.", "", m.group(1).lower()).split(".")[0]
                if any(t in label for t in org_t) and _toks(p["last"]) <= _toks(f"{r.get('title')} {r.get('snippet')}"):
                    own_pages.append(u)  # the company's own page naming the director (team / people page)
                    base = re.match(r"^https?://[^/]+", u).group(0)
                    if base not in sites:
                        sites.append(base)
    team = team_pages(sites, own_pages)
    for i, p in enumerate(dirs):
        cands = {}
        for r in searched[i]:
            u = r.get("url") or ""
            pm = re.match(r"^https?://[a-z.]*linkedin\.com/posts/([a-z0-9-]+?)_", u)
            if pm:  # a post by the person: the profile slug is in the url
                u = f"https://www.linkedin.com/in/{pm.group(1)}/"
            if "linkedin.com/in/" not in u or not name_ok(p, r.get("title")):
                continue
            k = norm_li(u)
            x = cands.setdefault(k, {"url": k, "title": "", "snippet": "", "hits": 0, "source": "web search"})
            x["hits"] += 1
            t_, sn = re.sub(r"<[^>]+>", "", r.get("title") or ""), (r.get("snippet") or "")[:300]
            if t_ and t_ not in x["title"]:  # the same profile via uk./www. can carry different titles
                x["title"] = (x["title"] + " | " + t_).strip(" |")[:300]
            if sn and sn[:60] not in x["snippet"] and "cannot provide a description" not in sn:
                x["snippet"] = (x["snippet"] + " ... " + sn).strip(" .")[:600]
        for page, links in team:
            for u, ctx in links:
                if "/in/" in u and _toks(p["last"]) <= _toks(ctx + " " + u.replace("-", " ")):
                    cands[u] = {"url": u, "title": f"{p['full']} (link on {page})", "snippet": ctx,
                                "hits": 3, "source": f"company team page {page}"}
        ot = org_tokens(org, grp, *brands, *p["others"])
        ranked = sorted(cands.values(), key=lambda x: (-len(ot & _toks(x["title"] + " " + x["snippet"])), -x["hits"]))
        payload_dirs.append({"id": i, "ch_name": p["ch_name"], "search_name": p["full"],
                             "middle_names": p["middles"], "occupation": p["occupation"],
                             "country_of_residence": p["country"], "appointed": p["appointed"],
                             "other_directorships": p["others"],
                             "candidates": [{k: x[k] for k in ("url", "title", "snippet", "source")}
                                            for x in ranked[:MAX_CANDIDATES]]})
    # company page
    co_cands = {}
    co_q = list(dict.fromkeys([f'"{org}" site:linkedin.com/company'] +
                              ([f'"{grp}" site:linkedin.com/company'] if grp and grp.lower() != org.lower() else []) +
                              ([f'"{brands[0]}" site:linkedin.com/company'] if brands else [])))[:3]
    co_res = list(co_hits)
    for q in co_q:
        nq += 1
        co_res += brave(q)
    for r in co_res:
        u = r.get("url") or ""
        if "linkedin.com/company/" in u:
            k = norm_li(u)
            co_cands.setdefault(k, {"url": k, "title": re.sub(r"<[^>]+>", "", r.get("title") or ""),
                                    "snippet": (r.get("snippet") or "")[:300], "source": "web search"})
    for page, links in team:
        for u, ctx in links:
            if "/company/" in u:
                co_cands.setdefault(u, {"url": u, "title": f"(link on {page})", "snippet": ctx[-120:],
                                        "source": f"company website {page}"})
    facts = {"company": c["name"], "group_or_parent": [ap._clean_owner(x) for x in c.get("parents") or []],
             "asset_brand_or_operator": brands, "asset_class": c.get("cls"),
             "asset": (c.get("deep") or {}).get("name"), "registered_office_town": town,
             "directors": payload_dirs, "company_candidates": list(co_cands.values())[:8]}
    raw = ap._llm_json(LI_SYS, facts, max_tokens=1500) if (any(d["candidates"] for d in payload_dirs) or co_cands) else {}
    raw = raw or {}
    by_id = {d.get("id"): d for d in raw.get("directors") or [] if isinstance(d, dict)}
    c["li_detail"], c["li_directors"] = {}, {}
    st = {"directors": 0, "matched": 0, "possible": 0, "queries": nq}
    for i, p in enumerate(dirs):
        st["directors"] += 1
        d = by_id.get(i) or {}
        cand = {x["url"]: x for x in payload_dirs[i]["candidates"]}
        url = norm_li(d.get("url")) if d.get("url") else None
        conf = d.get("confidence") if d.get("confidence") in ("matched", "possible") else "none"
        res = {"url": None, "confidence": "none", "reason": ""}
        if url in cand and conf != "none":
            x = cand[url]
            ev = x["title"] + " " + x["snippet"]
            ot = org_tokens(org, grp, *brands, *p["others"])
            team_hit = x["source"].startswith("company team page")
            if conf == "matched" and not (team_hit or ot & _toks(ev)):
                conf = "possible"
            if conf == "possible" and not (SECTOR_RX.search(ev) or UK_RX.search(ev) or (town and town.lower() in ev.lower())):
                conf = "none"
            if conf != "none":
                res = {"url": url, "confidence": conf,
                       "reason": clean_reason(d.get("reason"))
                       or ("company team page" if team_hit else "")}
        res["n_candidates"] = len(cand)
        res["llm_said"] = d.get("confidence") or "none"
        c["li_detail"][p["key"]] = res
        c["li_directors"][p["key"]] = res["url"]
        st[res["confidence"]] = st.get(res["confidence"], 0) + 1
    # directors on the card that are not in the officer list (e.g. corporate) stay absent
    co = raw.get("company") or {}
    cu = norm_li(co.get("url")) if co.get("url") else None
    cconf = co.get("confidence") if co.get("confidence") in ("matched", "possible") else "none"
    if cu in co_cands and cconf != "none":
        x = co_cands[cu]
        if cconf == "matched" and not (org_tokens(org, grp, *brands) & _toks(x["title"] + " " + x["snippet"] + " "
                                                                             + cu.replace("-", " "))
                                       or x["source"].startswith("company website")):
            cconf = "possible"
        c["li_company"] = cu
        c["li_company_detail"] = {"url": cu, "confidence": cconf,
                                  "reason": clean_reason(co.get("reason"))}
    else:
        c["li_company"] = None
        c["li_company_detail"] = {"url": None, "confidence": "none", "reason": ""}
    c["li_company_org"] = grp or org
    st["co_found"] = int(bool(c["li_company"]))
    st["co_matched"] = int(c["li_company_detail"]["confidence"] == "matched")
    return st


def linkedin(cards, ch, workers=WORKERS):
    """Runs find_for_card over all cards in parallel. Returns aggregate stats."""
    import radar_distress as rd
    ch = rd.threaded_ch(ch)
    t0 = time.time()

    def one(c):
        try:
            return find_for_card(c, ch)
        except Exception as ex:
            c.setdefault("li_detail", {})
            c.setdefault("li_directors", {})
            c.setdefault("li_company", None)
            return {"error": f"{type(ex).__name__}: {ex}"[:160]}
    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, cards))
    agg = {"directors": 0, "matched": 0, "possible": 0, "none": 0, "queries": 0, "co_found": 0, "co_matched": 0,
           "companies": len(cards), "errors": [r["error"] for r in res if r.get("error")],
           "enabled": bool(ap._key("BRAVE_API_KEY")), "secs": round(time.time() - t0)}
    for r in res:
        for k in ("directors", "matched", "possible", "none", "queries", "co_found", "co_matched"):
            agg[k] += r.get(k, 0) or 0
    return agg


def clean_reason(r, limit=100):
    """What the profile says, without the matching rationale Claude sometimes appends."""
    r = re.sub(r"\s*[\u2014\u2013]\s*", ", ", (r or "").strip())
    r = re.sub(r"^(the )?(title|snippet|profile|page)( shows| says| reads| states)?:?\s*", "", r, flags=re.I).strip("'\" ")
    r = re.split(r"[;,.]?\s+(?:match(?:es|ing|ed)?|consistent with|which match\w*|confirm\w*|profile url|"
                 r"snippet|title shows|references? (?:the )?(?:company|group|parent))\b", r, flags=re.I)[0]
    r = r.strip(" ,;.")
    if len(r) > limit:
        r = r[:limit].rsplit(" ", 1)[0].rstrip(" ,;(") + "..."
    if r.count("(") > r.count(")"):
        r = r.rsplit("(", 1)[0].rstrip(" ,;")
    return r


def director_line(c, d):
    """(text, html) LinkedIn fragment for one director string on a card."""
    det = (c.get("li_detail") or {}).get(d)
    if det is None:
        return None, None
    if not det.get("url"):
        return "LinkedIn: not found", "LinkedIn: not found"
    why = f"{det['confidence']}" + (f": {det['reason']}" if det.get("reason") else "")
    return (f"LinkedIn: {det['url']} ({why})",
            f'LinkedIn: <a href="{H.escape(det["url"])}" style="color:#1f3a5f">{H.escape(det["url"])}</a> ({H.escape(why)})')
