#!/usr/bin/env python3
"""
Likely loan size for refinancing radar candidates.

Companies House never shows loan amounts, so the size band is INFERRED from public signals:
  * syndication: lender named as security agent/trustee, or several corporate lenders on one charge
  * lender category (scripts/radar_lenders_10m_plus.txt sections; clearing banks score nothing)
  * asset capacity from the asset profile (rooms, beds, units, sq ft), by class
  * VOA rateable value (when the asset profile matched the property)
  * portfolio: outstanding charges over several dates, sibling SPVs, several titles charged
  * accounts filing TYPE (group/full = medium; micro-entity = negative). Never the figures.
  * institutional / listed / sovereign-backed parent (PSC names)

Bands: "Likely £10m+", "Likely £5m-10m", "Possible", "Unlikely". Every threshold and weight lives in
scripts/radar_size_rules.json (marked as assumptions for Marcus to tune). Pure functions, no I/O
beyond reading the two config files once.

score_size(c) takes the radar company dict (maturity_radar.py) plus, when available, c["asset"]
(asset_profile.build_asset_profile) and c["asset_id"] (asset_profile.identify_by_ownership). Without
them the result is provisional (no capacity / rateable value signals).
"""
import json
import os
import re
from functools import lru_cache

HERE = os.path.dirname(os.path.abspath(__file__))
RULES_FILE = os.path.join(HERE, "radar_size_rules.json")
LENDERS_FILE = os.path.join(HERE, "radar_lenders_10m_plus.txt")

BAND_ORDER = ["likely_10m", "likely_5m", "possible", "unlikely"]
STRENGTH_RANK = {"strong": 4, "medium_strong": 3, "medium": 2, "weak": 1, "neutral": 0}
CORPORATE = re.compile(r"\b(limited|ltd|plc|llp|bank|ag|s\.?a|n\.?v|b\.?v|gmbh|inc|l\.?p|fund|trust|"
                       r"trustees?|corporation|company|capital|partners|assurance|insurance)\b\.?", re.I)


@lru_cache(maxsize=1)
def rules():
    return json.load(open(RULES_FILE))


@lru_cache(maxsize=1)
def lender_patterns():
    """[(category, compiled regex, raw, is_check)] from the sectioned lender file."""
    cats = {k for k in rules()["lender_categories"] if not k.startswith("_")}
    out, cat = [], None
    for line in open(LENDERS_FILE):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = re.match(r"^\[(\w+)\]$", s)
        if m:
            cat = m.group(1)
            if cat not in cats:
                raise ValueError(f"lender file section [{cat}] has no entry in radar_size_rules.json")
            continue
        if cat is None:
            continue
        parts = re.split(r"\s+#", line.rstrip("\n"), maxsplit=1)
        rx = parts[0].strip()
        out.append((cat, re.compile(rx, re.I), rx, len(parts) > 1 and "CHECK" in parts[1].upper()))
    return out


def lender_category(*names):
    """Strongest category matching any of the names, or None.
    Returns {cat, label, strength, pre_points, pattern, check, name}."""
    cfg = rules()["lender_categories"]
    best = None
    for cat, rx, raw, check in lender_patterns():
        hit = next((n for n in names if n and rx.search(n)), None)
        if not hit:
            continue
        c = cfg[cat]
        cand = {"cat": cat, "label": c["label"], "strength": c["strength"],
                "pre_points": c.get("pre_points", 0), "pattern": raw, "check": check, "name": hit}
        if best is None or STRENGTH_RANK[cand["strength"]] > STRENGTH_RANK[best["strength"]] or \
                (cand["strength"] == best["strength"] and best["check"] and not check):
            best = cand
    return best


# --------------------------------------------------------------------------- helpers
def _num(v):
    try:
        return float(str(v).replace(",", "").replace("£", "").strip())
    except (TypeError, ValueError):
        return None


def _short(name, n=40):
    name = re.sub(r"\s+", " ", name or "").strip()
    return name if len(name) <= n else name[:n - 3].rsplit(" ", 1)[0] + "..."


def _sig(key, label, strength, bands=("10m", "5m")):
    return {"key": key, "label": label, "strength": strength, "bands": list(bands)}


def _is_london(c):
    a = c.get("asset") or {}
    loc = a.get("location") or {}
    if loc.get("region") == "London" and loc.get("basis") == "property postcode":
        return True
    texts = [(c.get("asset_id") or {}).get("location"), (c.get("prop") or {}).get("address")]
    return any(t and re.search(r"\blondon\b", t, re.I) for t in texts)


# capacity type -> (rules key, metric words that make the figure comparable, short unit label)
def _cap_type(cls, metric):
    m = (metric or "").lower()
    if cls == "Hotels" or re.search(r"\b(keys|hotel rooms?)\b", m):
        return "hotel_rooms", r"room|key|suite|bedroom", "rooms"
    if cls == "Care":
        return "care_beds", r"bed", "beds"
    if cls == "SEN":
        return "sen_places", r"pupil|place", "places"
    if cls == "Living":
        if re.search(r"\bbed|studio|pbsa|student|co-?living", m):
            return "pbsa_beds", r"bed|studio|room", "beds"
        return "btr_units", r"unit|apartment|home|flat|propert", "units"
    if cls in ("Logistics/Industrial", "Offices", "Retail/Leisure"):
        return "sqft:" + cls, r"sq\.? ?ft|square f", "sq ft"
    return None, None, None


def _capacity_candidates(c):
    """[(value, metric, weight)] from the asset profile and ownership identification."""
    out = []
    a, ident, pi = c.get("asset") or {}, c.get("asset_id") or {}, c.get("prop") or {}
    cap = a.get("capacity") or {}
    v = _num(cap.get("value"))
    if v:
        src, metric = cap.get("source") or "", cap.get("metric") or ""
        if re.search(r"provider total|proprietor total|across \d+ ", metric):
            w = "provider_total"
        elif src.startswith(("CQC", "GIAS", "VOA", "EPC", "Non-dom", "Dom")) or "floor area" in metric:
            w = "confirmed"
        elif src.startswith("web") and not pi.get("generic", True):
            w = "confirmed"
        else:
            w = "likely"
        out.append((v, metric, w))
    icap = ident.get("capacity") or {}
    iv = _num(icap.get("value"))
    if iv and ident.get("confidence") in ("likely", "possible"):
        out.append((iv, icap.get("metric") or "", ident["confidence"]))
    return out


def _capacity_signal(c):
    R = rules()
    cls = c.get("cls")
    best = None
    for v, metric, w in _capacity_candidates(c):
        typ, words, unit = _cap_type(cls, metric)
        if not typ or (metric and not re.search(words, metric, re.I)):
            continue
        if typ.startswith("sqft:"):
            th = R["capacity"]["sqft"][typ.split(":", 1)[1]]
        else:
            th = R["capacity"][typ]
        london = typ == "hotel_rooms" and _is_london(c)
        t10 = th.get("10m_london", th["10m"]) if london else th["10m"]
        t5 = th.get("5m_london", th["5m"]) if london else th["5m"]
        strength = R["capacity_weight"][w]
        tag = {"confirmed": "", "provider_total": " (operator total)",
               "likely": " (likely ID)", "possible": " (possible ID)"}[w]
        label = f"{int(v):,} {unit}{tag}" + (" London" if london and v < th["10m"] and v >= t10 else "")
        if v >= t10:
            s = _sig("capacity", label, strength)
        elif v >= t5:
            s = _sig("capacity", label, strength, bands=("5m",))
        else:
            continue
        rank = (len(s["bands"]), STRENGTH_RANK[strength])
        if best is None or rank > best[0]:
            best = (rank, s)
    return best and best[1]


# --------------------------------------------------------------------------- scoring
def size_signals(c):
    """List of signal dicts {key, label, strength, bands}."""
    R = rules()
    sigs = []
    charges = c.get("charges") or []
    pi = c.get("prop") or {}

    # 1. syndication / club
    syn = R["syndication"]
    agent_rx = re.compile(syn["agent_regex"], re.I)
    raw_names = [r.get("lender") or "" for r in charges] + \
                [p for ps in pi.get("persons") or [] for p in ps]
    agents = [n for n in dict.fromkeys(raw_names) if agent_rx.search(n)]
    if agents:
        # a clearing bank / challenger acting as its own security trustee is common in bilateral
        # deals with hedging, so it is not proof of a club: weaker signal (rules: neutral_agent_strength)
        lead = [n for n in agents if (lender_category(n) or {}).get("strength") != "neutral"]
        if lead:
            sigs.append(_sig("syndication", "security agent/trustee", syn["strength"]))
        else:
            sigs.append(_sig("syndication", "bank as security trustee", syn["neutral_agent_strength"]))
    elif pi.get("more_than_four"):
        sigs.append(_sig("syndication", "more than four lenders on one charge", syn["strength"]))
    else:
        most = 0
        for ps in pi.get("persons") or []:
            firms = {(re.sub(r"[^a-z0-9 ]", " ", p.lower()).split() or [""])[0]
                     for p in ps if CORPORATE.search(p or "")}
            most = max(most, len(firms))
        if most >= syn["min_corporate_persons_on_one_charge"]:
            sigs.append(_sig("syndication", f"club: {most} lenders on one charge", syn["strength"]))

    # 2. lender category (strongest across window-charge lenders and persons entitled)
    cat = lender_category(*{n for r in charges for n in (r.get("lname"), r.get("lender"))},
                          *[p for ps in pi.get("persons") or [] for p in ps])
    c["lender_cat"] = cat
    syndicated = any(x["key"] == "syndication" for x in sigs)
    if cat and cat["strength"] != "neutral" and not (syndicated and cat["cat"] == "agent_firm"):
        sigs.append(_sig("lender", f"{cat['label']} ({_short(cat['name'], 30)})", cat["strength"]))

    # 3. capacity
    cs = _capacity_signal(c)
    if cs:
        sigs.append(cs)

    # 4. rateable value
    rv_cfg = R["rateable_value"]
    rv = _num(((c.get("asset") or {}).get("voa") or {}).get("rateable_value"))
    if rv and c.get("cls") in rv_cfg["classes"]:
        lbl = f"RV £{rv / 1000:,.0f}k"
        if rv >= rv_cfg["10m"]:
            sigs.append(_sig("rateable_value", lbl, rv_cfg["strength"]))
        elif rv >= rv_cfg["5m"]:
            sigs.append(_sig("rateable_value", lbl, rv_cfg["strength"], bands=("5m",)))

    # 5. portfolio (one signal, first reason found)
    pf = R["portfolio"]
    n_titles = len(pi.get("titles") or []) + (pi.get("more") or 0)
    if (c.get("n_total") or 0) >= pf["min_outstanding_charges"] and \
            len(c.get("out_dates") or []) >= pf["min_distinct_charge_dates"]:
        sigs.append(_sig("portfolio", f"{c['n_total']} outstanding charges", pf["strength"]))
    elif pf.get("sibling_spvs") and c.get("siblings"):
        sigs.append(_sig("portfolio", f"{len(c['siblings'])} sibling SPV(s) in window", pf["strength"]))
    elif n_titles >= pf["min_titles_or_properties"]:
        sigs.append(_sig("portfolio", f"{n_titles} titles/properties charged", pf["strength"]))

    # 6. accounts filing type (never the figures)
    acc = c.get("acc_type")
    st = R["accounts"].get(acc) if acc and not acc.startswith("_") else None
    if st:
        sigs.append(_sig("accounts", f"{acc} accounts", st))

    # 7. institutional / listed / sovereign parent
    pc = R["parent"]
    for p in c.get("parents") or []:
        if any(re.search(rx, p or "", re.I) for rx in pc["patterns"]):
            sigs.append(_sig("parent", f"parent {_short(p, 35)}", pc["strength"]))
            break
    return sigs


def _points(strength):
    P = rules()["points"]
    return P.get(strength, 0)


def _band_ok(sigs, band, bcfg):
    use = [s for s in sigs if band in s["bands"]]
    score = sum(_points(s["strength"]) for s in use)
    strong = sum(s["strength"] == "strong" for s in use)
    medium = sum(s["strength"] in ("medium", "medium_strong") for s in use)
    ok = score >= bcfg["min_score"] and (strong >= bcfg["min_strong"] or medium >= bcfg["min_medium"])
    return ok, score


def score_size(c):
    """Size verdict for one candidate. Never raises."""
    R = rules()
    try:
        sigs = size_signals(c)
    except Exception as ex:  # never break the radar on a scoring problem
        sigs = []
        c["size_error"] = type(ex).__name__
    ok10, s10 = _band_ok(sigs, "10m", R["bands"]["likely_10m"])
    ok5, s5 = _band_ok(sigs, "5m", R["bands"]["likely_5m"])
    positive = [s for s in sigs if _points(s["strength"]) > 0]
    micro = any(s["strength"].startswith("negative") for s in sigs)
    has_strong = any(s["strength"] == "strong" for s in sigs)
    if micro:
        cap = R.get("micro_entity_max_band", "possible")
        band = cap if has_strong and cap in ("possible",) else "unlikely"
    elif ok10:
        band = "likely_10m"
    elif ok5:
        band = "likely_5m"
    elif positive:
        band = "possible"
    else:
        band = "unlikely"
    order = {"strong": 0, "medium_strong": 1, "medium": 2, "weak": 3}
    shown = sorted(sigs, key=lambda s: order.get(s["strength"], 4))
    return {"band": band, "label": R["bands"][band]["label"], "card": R["bands"][band]["card"],
            "score10": s10, "score5": s5, "signals": sigs,
            "reasons": "; ".join(s["label"] for s in shown),
            "provisional": not (c.get("asset") or c.get("asset_id"))}


def band_rank(size):
    return BAND_ORDER.index((size or {}).get("band", "unlikely"))


def size_line(size):
    """'Likely £10m+ (security agent/trustee; 287 rooms; group accounts)'."""
    if not size:
        return "not assessed"
    r = size.get("reasons")
    return size["card"] + (f" ({r})" if r else " (no size signals)")
