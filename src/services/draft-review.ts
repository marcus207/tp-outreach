import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';
import { safeEqual } from '../middleware/security';
import fs from 'fs';
import path from 'path';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000 });

export const TP_BASE = 'https://tp.finance';

// ---- Hero images — base64 data URIs, lazy-loaded and cached at first use ----
// Images live in data/hero/ at the project root.
const _heroCache: Record<string, string> = {};
export function heroDataUri(filename: string): string {
  if (_heroCache[filename]) return _heroCache[filename];
  const heroPath = path.join(__dirname, '../../data/hero', filename);
  try {
    const buf = fs.readFileSync(heroPath);
    const uri = `data:image/jpeg;base64,${buf.toString('base64')}`;
    _heroCache[filename] = uri;
    return uri;
  } catch { /* fallback */ }
  // Fallback: dark gradient so the server never crashes
  console.warn(`[HeroImage] Could not load ${filename} — using gradient fallback`);
  return 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
}

export const IMAGE_URLS: Record<string, string> = {
  hotel_exterior:       heroDataUri('hospitality_01.jpg'),
  hotel_lobby:          heroDataUri('hospitality_02.jpg'),
  serviced_apartments:  heroDataUri('hospitality_03.jpg'),
  hotel_development:    heroDataUri('hospitality_04.jpg'),
  leisure_resort:       heroDataUri('leisure_01.jpg'),
  student_accommodation:heroDataUri('pbsa_01.jpg'),
  senior_living:        heroDataUri('living_01.jpg'),
  advisory_meeting:     heroDataUri('advisory_01.jpg'),
  intro_week1:          heroDataUri('hospitality_05.jpg'),
  intro_week2:          heroDataUri('hospitality_06.jpg'),
  intro_week3:          heroDataUri('advisory_02.jpg'),
  intro_week4:          heroDataUri('hospitality_07.jpg'),
};

// ---- Theme definitions ----
// Each theme maps to a real TP service area. Stats use genuine market/firm data.
// No made-up statistics. All content should be grounded in what TP actually does.
export const THEMES = [
  {
    name: 'Hospitality Market Intelligence',
    slug: 'hospitality-market-intelligence',
    image: 'hotel_exterior',
    stats: [
      { value: '£2.8B+', label: 'UK HOTEL TRANSACTIONS (2025)' },
      { value: '850+', label: 'HOSPITALITY DEALS TRACKED' },
      { value: '12', label: 'SUB-SECTORS COVERED' },
    ],
    gridLinks: [
      { url: `${TP_BASE}/services/market-intelligence` },
      { url: `${TP_BASE}/services/debt-advisory` },
      { url: `${TP_BASE}/sectors/hotels` },
      { url: `${TP_BASE}/contact` },
    ],
    platformFeatures: `Turning Point Capital Advisory tracks hospitality real estate transactions across the UK and Europe. Our market intelligence covers:
- Hotel transaction data: sale prices, cap rates, price-per-key benchmarks across regional and branded hotels
- RevPAR trends, occupancy rates, and ADR movements across UK hotel markets
- Development pipeline monitoring: planning applications, construction starts, and completions for hotels, apart-hotels, and serviced apartments
- Lender appetite tracking: which lenders are active in hospitality, what terms they are offering, and where capital is flowing
- Sub-sector benchmarking across hotels, PBSA, senior living, co-living, holiday parks, pubs/bars, and restaurants
We use this intelligence to advise clients on timing, pricing, and lender selection for their hospitality debt requirements.`,
    seasonal: {
      spring: { angle: 'UK hotel transaction volumes are shifting — what the latest data means for your hospitality financing strategy', cta: 'Discuss your requirements' },
      summer: { angle: 'Peak season occupancy data is in — how to use current trading to strengthen your refinancing or acquisition case', cta: 'Book a call' },
      autumn: { angle: 'Year-end hospitality deal flow is accelerating — where the lender appetite is strongest right now', cta: 'Talk to our team' },
      winter: { angle: 'Q1 hospitality market outlook — which sub-sectors are attracting capital and what lenders want to see', cta: 'Request a briefing' },
    },
  },
  {
    name: 'Development Finance Advisory',
    slug: 'development-finance-advisory',
    image: 'hotel_development',
    stats: [
      { value: '50+', label: 'SPECIALIST LENDERS IN OUR NETWORK' },
      { value: '£500M+', label: 'DEVELOPMENT DEALS ADVISED' },
      { value: '85%+', label: 'SUCCESS RATE ON MANDATES' },
    ],
    gridLinks: [
      { url: `${TP_BASE}/services/development-finance` },
      { url: `${TP_BASE}/sectors/hotels` },
      { url: `${TP_BASE}/sectors/student-accommodation` },
      { url: `${TP_BASE}/contact` },
    ],
    platformFeatures: `Turning Point advises on development finance for hospitality real estate — hotels, apart-hotels, PBSA, co-living, senior living, and holiday parks. Our advisory covers:
- Senior debt structuring for ground-up hospitality development, typically 55-65% LTC
- Mezzanine and stretch senior structures to reduce equity requirements on larger schemes
- Pre-development and planning-stage bridging for site assembly and planning gain plays
- Operator-backed development facilities where brand affiliation strengthens the credit case
- Construction drawdown scheduling aligned to BCIS cost plans and QS certifications
- Interest capitalisation and rolled-up fee structures to match the zero-income development period
We work with developers, owner-operators, and institutional investors building new hospitality assets across the UK.`,
    seasonal: {
      spring: { angle: 'Development lenders are reopening appetite for hospitality schemes — what you need to get terms in the current market', cta: 'Discuss your project' },
      summer: { angle: 'Hotel and apart-hotel development is back on lender shortlists — how we structure facilities to get deals over the line', cta: 'Book a call' },
      autumn: { angle: 'Planning-stage hospitality sites need the right finance structure from day one — how we advise pre-development deals', cta: 'Talk to our team' },
      winter: { angle: 'New year, new development pipeline — the hospitality sectors where lenders are keenest to deploy capital', cta: 'Request a briefing' },
    },
  },
  {
    name: 'Refinancing Strategy',
    slug: 'refinancing-strategy',
    image: 'hotel_lobby',
    stats: [
      { value: '£1.2B+', label: 'HOSPITALITY REFINANCINGS ADVISED' },
      { value: '40+', label: 'LENDERS FOR INVESTMENT DEBT' },
      { value: '3-5 yr', label: 'TYPICAL TERM LENGTHS' },
    ],
    gridLinks: [
      { url: `${TP_BASE}/services/refinancing` },
      { url: `${TP_BASE}/services/investment-finance` },
      { url: `${TP_BASE}/sectors/hotels` },
      { url: `${TP_BASE}/contact` },
    ],
    platformFeatures: `Turning Point advises hotel and hospitality operators on refinancing strategies — whether stabilising a trading asset, extracting equity from a value-add play, or restructuring a legacy facility. Our advisory covers:
- Stabilised hotel investment debt at competitive margins with 3-5 year terms
- Post-refurbishment refinancing to lock in value uplift and reduce blended cost of capital
- Portfolio refinancing across multi-asset hospitality groups to improve covenant headroom
- Bridge-to-term strategies where short-term capital is needed to complete a business plan before permanent financing
- Covenant restructuring and lender negotiation for assets underperforming covenants
- Sale-and-leaseback advisory where off-balance-sheet structures suit the operator's strategy
We match the right lender to the asset profile — trading history, brand affiliation, lease structure, and market position all affect which lenders will offer the strongest terms.`,
    seasonal: {
      spring: { angle: 'Hotel refinancing windows are opening — how to position your asset for the best terms before summer trading', cta: 'Discuss your refinancing' },
      summer: { angle: 'Strong summer trading strengthens your refinancing hand — how we use live revenue data to negotiate better terms', cta: 'Book a call' },
      autumn: { angle: 'Year-end refinancings need a clear strategy — the lenders offering the best hospitality terms right now', cta: 'Talk to our team' },
      winter: { angle: 'Maturing hospitality facilities need early attention — how we structure refinancings 6-9 months ahead of expiry', cta: 'Request a briefing' },
    },
  },
  {
    name: 'Sector Expertise',
    slug: 'sector-expertise',
    image: 'serviced_apartments',
    stats: [
      { value: '12', label: 'HOSPITALITY SUB-SECTORS' },
      { value: '15+ yrs', label: 'SECTOR EXPERIENCE' },
      { value: 'UK & Europe', label: 'GEOGRAPHIC COVERAGE' },
    ],
    gridLinks: [
      { url: `${TP_BASE}/sectors/hotels` },
      { url: `${TP_BASE}/sectors/student-accommodation` },
      { url: `${TP_BASE}/sectors/senior-living` },
      { url: `${TP_BASE}/contact` },
    ],
    platformFeatures: `Turning Point Capital Advisory covers the full spectrum of hospitality real estate sub-sectors in the UK:
- Hotels: branded and independent, city centre and regional, limited-service to full-service
- Serviced Apartments and Apart-Hotels: the growing hybrid between hotel and residential
- Student Accommodation (PBSA): purpose-built and conversion schemes, direct-let and nomination agreements
- Co-Living: large-format shared living with hospitality-style amenity provision
- Senior Living and Care Homes: retirement villages, assisted living, nursing and dementia care
- Holiday Parks and Glamping: leisure-led accommodation with strong seasonal cash flows
- Pubs and Bars: wet-led and food-led, managed and tenanted estates
- Restaurants and Food Halls: single-site and multi-site operators
Each sub-sector has different underwriting drivers, different lender pools, and different structuring requirements. We know which lenders are active in each vertical and what they need to see.`,
    seasonal: {
      spring: { angle: 'Each hospitality sub-sector has its own lender pool — how we match the right capital to hotels, PBSA, senior living, and beyond', cta: 'Explore our sectors' },
      summer: { angle: 'Student accommodation, holiday parks, and hotels all peak at different times — how seasonal cash flows shape lender appetite', cta: 'Book a call' },
      autumn: { angle: 'From hotels to senior living to PBSA — the hospitality sub-sectors where lenders are most active heading into year-end', cta: 'Talk to our team' },
      winter: { angle: 'New year sector review — which hospitality verticals are attracting capital and where the opportunity gaps are', cta: 'Request a briefing' },
    },
  },
  {
    name: 'Cross-Border European Deals',
    slug: 'cross-border-european',
    image: 'leisure_resort',
    stats: [
      { value: '8', label: 'EUROPEAN MARKETS COVERED' },
      { value: '£350M+', label: 'CROSS-BORDER DEALS ADVISED' },
      { value: '30+', label: 'INTERNATIONAL LENDER RELATIONSHIPS' },
    ],
    gridLinks: [
      { url: `${TP_BASE}/services/cross-border` },
      { url: `${TP_BASE}/sectors/hotels` },
      { url: `${TP_BASE}/about` },
      { url: `${TP_BASE}/contact` },
    ],
    platformFeatures: `Turning Point advises on hospitality debt across European markets — not just the UK. Our cross-border capability covers:
- European hotel acquisitions: sourcing debt from both local-market lenders and pan-European platforms
- Multi-jurisdiction structuring: navigating local security requirements, tax wrappers, and intercreditor arrangements
- Currency hedging advisory for GBP-denominated sponsors acquiring EUR-denominated assets
- European PBSA and co-living: the continental student housing and co-living markets are growing rapidly, with dedicated lender pools
- Resort and leisure financing across Southern European markets where UK sponsors are active buyers
- Portfolio financing across multiple European jurisdictions with a single lender or club structure
We maintain relationships with lenders active in Spain, Portugal, France, Germany, Netherlands, Italy, Ireland, and the Nordics, alongside UK-based international desks.`,
    seasonal: {
      spring: { angle: 'European hospitality markets are reopening for UK sponsors — where the cross-border lending appetite sits right now', cta: 'Discuss your deal' },
      summer: { angle: 'Mediterranean resort season drives lender interest in Southern European hospitality — how to access cross-border capital', cta: 'Book a call' },
      autumn: { angle: 'European hotel portfolios are trading — how we structure cross-border debt for UK sponsors acquiring continental assets', cta: 'Talk to our team' },
      winter: { angle: 'European hospitality outlook for the year ahead — which markets and which lenders are worth talking to', cta: 'Request a briefing' },
    },
  },
  {
    name: 'Lender Relationships',
    slug: 'lender-relationships',
    image: 'advisory_meeting',
    stats: [
      { value: '50+', label: 'SPECIALIST LENDERS' },
      { value: '£2B+', label: 'TOTAL DEALS ADVISED' },
      { value: '100%', label: 'INDEPENDENT ADVISORY' },
    ],
    gridLinks: [
      { url: `${TP_BASE}/about` },
      { url: `${TP_BASE}/services/debt-advisory` },
      { url: `${TP_BASE}/track-record` },
      { url: `${TP_BASE}/contact` },
    ],
    platformFeatures: `Turning Point Capital Advisory maintains active relationships with 50+ specialist lenders across the UK and European hospitality debt market:
- UK clearing banks and challenger banks with dedicated hospitality desks
- Specialist hotel lenders and hospitality-focused debt funds
- Development finance lenders comfortable with hospitality construction risk
- Mezzanine and stretch senior providers for higher-leverage structures
- Insurance company and pension fund lenders for long-dated investment debt
- Family offices and private credit platforms active in the hospitality space
- International banks with UK hospitality appetite
Our independence means we are not tied to any lender panel. We run competitive processes across our network to find the best terms for each specific deal. We know which lenders are actively deploying, what their current appetite looks like, and what credit criteria they are applying this quarter.`,
    seasonal: {
      spring: { angle: 'Lender appetite shifts every quarter — we track which hospitality lenders are active and what terms they are offering right now', cta: 'See our lender network' },
      summer: { angle: 'Access to 50+ specialist lenders means you see the full market — not just whoever answers the phone first', cta: 'Book a call' },
      autumn: { angle: 'Year-end capital deployment targets drive lender behaviour — how we use our network to find the best terms before December', cta: 'Talk to our team' },
      winter: { angle: 'New year lender mandates are live — which hospitality lenders have fresh appetite and what they want to see', cta: 'Request a briefing' },
    },
  },
];

// ---- Content structure that Claude generates (JSON only) ----
export interface EmailContent {
  subject:          string;
  stats:            Array<{ value: string; label: string }>;
  intro:            string;
  body_p2:          string;
  body_p3:          string;
  grid:             Array<{ title: string; desc: string }>;
  callout_heading:  string;
  callout_points:   string[];  // exactly 3
  callout_cta:      string;
  cta_url?:         string;   // optional override for the main CTA button, defaults to TP_BASE
  poster_headline?: string;   // for LinkedIn poster image
  poster_subline?:  string;   // for LinkedIn poster image
}

// ---- HTML builder — consistent template, never AI-generated ----
export function buildEmailHtml(
  content:   EmailContent,
  _themeName: string,
  _imageUrl:  string,
  _gridLinks: Array<{ url: string }>,
): string {
  const ctaUrl = content.cta_url || TP_BASE;

  const body_p3_html = content.body_p3
    ? `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">${content.body_p3}</p>`
    : '';

  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 16px;">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#0f1a2e;padding:16px 28px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">TP</span><span style="color:#9ca3af;font-size:12px;margin-left:8px;font-family:Arial,sans-serif;">Turning Point Capital Advisory</span></td>
</tr></table>
</td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#4db8a4,#74DFF6);font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 24px;font-family:Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:15px;color:#0f1a2e;line-height:1.7;">Hey {{first_name}},</p>
<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">${content.intro}</p>
<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">${content.body_p2}</p>
${body_p3_html}
<p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.7;">${content.callout_cta}</p>
<p style="margin:0;"><a href="${ctaUrl}" style="color:#0D9488;font-size:14px;font-weight:600;text-decoration:none;">${ctaUrl}</a></p>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:20px 28px;font-family:Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:15px;color:#374151;">Kind regards,</p>
<img src="https://res.cloudinary.com/dfqfrd5l0/image/upload/v1779917807/tp-outreach/marcus-signature.gif" width="400" alt="Marcus Emadi - Director - Turning Point Capital Advisory" style="display:block;max-width:400px;width:100%;height:auto;" />
</td></tr>
<tr><td style="background:#f8f9fb;padding:12px 28px;border-top:1px solid #e5e7eb;text-align:center;">
<p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">${BRAND_NAME} Ltd · London · <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>
</td></tr>
</table>`;
}

// ---- LinkedIn poster HTML builder — 1200x628 image-dominant design ----
export function buildLinkedInPosterHtml(imageUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><style>* { margin:0; padding:0; box-sizing:border-box; }</style></head>
<body style="margin:0;padding:0;width:1200px;height:628px;overflow:hidden;background:#0A131E;">
<div style="width:1200px;height:628px;position:relative;">

  <!-- Full-bleed hero image -->
  <img src="${imageUrl}" width="1200" height="628" style="display:block;width:1200px;height:628px;object-fit:cover;" alt="" />

  <!-- Subtle bottom gradient for logo legibility -->
  <div style="position:absolute;bottom:0;left:0;width:1200px;height:140px;background:linear-gradient(0deg, rgba(10,19,30,0.75) 0%, rgba(10,19,30,0) 100%);"></div>

  <!-- TP brandmark -->
  <div style="position:absolute;bottom:18px;left:32px;display:flex;align-items:center;gap:8px;">
    <span style="font-family:'Poppins',Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">TP</span>
    <span style="font-family:'Poppins',Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;color:#74DFF6;letter-spacing:-0.5px;">.</span>
    <span style="font-family:'Poppins',Arial,Helvetica,sans-serif;font-size:13px;color:rgba(255,255,255,0.8);margin-left:2px;letter-spacing:0.5px;">tp.finance</span>
  </div>

  <!-- Accent bar -->
  <div style="position:absolute;bottom:0;left:0;width:1200px;height:3px;background:linear-gradient(90deg,#1993C5 0%,#74DFF6 100%);"></div>

</div>
</body>
</html>`;
}

// ---- 4 weekly intro email templates (static, pre-approved) ----
// Sent weekly to new contacts introducing Turning Point Capital Advisory.
// All use buildEmailHtml with the standard TP design.

const INTRO_GRID_LINKS_1 = [
  { url: `${TP_BASE}/services/debt-advisory` },
  { url: `${TP_BASE}/sectors/hotels` },
  { url: `${TP_BASE}/services/development-finance` },
  { url: `${TP_BASE}/contact` },
];

const INTRO_GRID_LINKS_2 = [
  { url: `${TP_BASE}/sectors/hotels` },
  { url: `${TP_BASE}/sectors/student-accommodation` },
  { url: `${TP_BASE}/sectors/senior-living` },
  { url: `${TP_BASE}/services/debt-advisory` },
];

const INTRO_GRID_LINKS_3 = [
  { url: `${TP_BASE}/services/debt-advisory` },
  { url: `${TP_BASE}/services/development-finance` },
  { url: `${TP_BASE}/services/refinancing` },
  { url: `${TP_BASE}/contact` },
];

const INTRO_GRID_LINKS_4 = [
  { url: `${TP_BASE}/track-record` },
  { url: `${TP_BASE}/about` },
  { url: `${TP_BASE}/services/debt-advisory` },
  { url: `${TP_BASE}/contact` },
];

const INTRO_EMAILS: Array<{
  week: number;
  subject: string;
  linkedin: string;
  content: EmailContent;
  image: string;
  gridLinks: Array<{ url: string }>;
}> = [
  {
    week: 1,
    subject: 'Hospitality debt advisory — what Turning Point covers',
    image: IMAGE_URLS.intro_week1,
    gridLinks: INTRO_GRID_LINKS_1,
    linkedin: `Most hospitality operators and developers I speak to approach debt the same way: call two or three lenders they already know, take the first term sheet that comes back, and hope the terms are competitive.

That works until it doesn't. The hospitality lending market is deep but fragmented — specialist hotel lenders, challenger banks, debt funds, insurance company platforms, family offices. No single broker or bank relationship covers the full picture.

Turning Point Capital Advisory exists to fix that. We advise on bridging, development finance, investment debt, and refinancing across hotels, serviced apartments, PBSA, senior living, holiday parks, and the wider hospitality sector. Access to 50+ specialist lenders means we run competitive processes, not single-source enquiries.

What does your current approach to hospitality debt look like?`,
    content: {
      subject: 'Hospitality debt advisory — what Turning Point covers',
      stats: [
        { value: '50+', label: 'SPECIALIST LENDERS IN OUR NETWORK' },
        { value: '£2B+', label: 'HOSPITALITY DEALS ADVISED' },
        { value: '12', label: 'HOSPITALITY SUB-SECTORS COVERED' },
      ],
      intro: 'I\'m reaching out because you operate in the UK hospitality sector and I think our advisory practice would be relevant. Turning Point Capital Advisory is a specialist debt advisory firm focused exclusively on hospitality real estate — hotels, serviced apartments, PBSA, senior living, holiday parks, pubs, and restaurants.',
      body_p2: 'We advise on the full debt spectrum: bridging finance for acquisitions, development finance for new-build hospitality schemes, investment debt for stabilised trading assets, and refinancing strategies for maturing facilities. Our network of 50+ specialist lenders means we run competitive processes across the market rather than relying on single-source enquiries.',
      body_p3: 'This is the first in a short series of emails introducing what we cover. Over the next few weeks I\'ll walk you through our sector expertise, lender relationships, and deal track record.',
      grid: [
        { title: 'Hospitality Debt Advisory', desc: 'Specialist advisory across bridging, development, investment, and refinancing for hospitality assets.' },
        { title: 'Hotel & Leisure Focus', desc: 'Deep expertise in hotels, apart-hotels, serviced apartments, and the wider leisure sector.' },
        { title: 'Development Finance', desc: 'Ground-up hospitality development advisory — hotels, PBSA, co-living, and senior living schemes.' },
        { title: 'Talk To Us', desc: 'No obligation conversation about your current or upcoming hospitality debt requirements.' },
      ],
      callout_heading: 'WHY CLIENTS WORK WITH TURNING POINT',
      callout_points: [
        '<strong style="color:#ffffff;">Hospitality-only focus</strong> — We do not advise on offices, logistics, or residential. Every deal we work on is in the hospitality and leisure sector, which means deeper lender relationships and better market intelligence.',
        '<strong style="color:#ffffff;">50+ specialist lender relationships</strong> — From clearing banks to specialist hotel lenders to debt funds and insurance company platforms. We know who is lending, on what terms, and what they need to see.',
        '<strong style="color:#ffffff;">Competitive process, not introductions</strong> — We run structured processes across multiple lenders to ensure our clients see the best terms available in the market, not just the first offer.',
      ],
      callout_cta: 'Visit tp.finance',
      cta_url: TP_BASE,
    },
  },
  {
    week: 2,
    subject: 'Hotels, PBSA, senior living — the sectors we cover',
    image: IMAGE_URLS.intro_week2,
    gridLinks: INTRO_GRID_LINKS_2,
    linkedin: `The hospitality sector is not one market. It is twelve.

Hotels alone split into branded and independent, limited-service and full-service, city centre and regional. Each has different underwriting drivers, different lender pools, and different structuring requirements.

Then there is PBSA — purpose-built student accommodation — where the lending market has its own specialists and its own logic around nomination agreements, direct-let risk, and academic cycle cash flows.

Senior living is another vertical entirely. Retirement villages, assisted living, nursing care. Different operators, different regulators, different lenders.

We cover all of them. Hotels, serviced apartments, PBSA, co-living, senior living, holiday parks, pubs, restaurants. Each with dedicated lender relationships and sector-specific structuring knowledge.

Which sub-sector are you most active in?`,
    content: {
      subject: 'Hotels, PBSA, senior living — the sectors we cover',
      stats: [
        { value: '12', label: 'HOSPITALITY SUB-SECTORS' },
        { value: '15+ yrs', label: 'SECTOR EXPERIENCE' },
        { value: 'UK & Europe', label: 'GEOGRAPHIC COVERAGE' },
      ],
      intro: 'I wanted to follow up and give you a clearer picture of the hospitality sub-sectors we cover — because each one has its own lender pool, its own underwriting logic, and its own structuring requirements.',
      body_p2: 'We advise across hotels (branded and independent, city and regional), serviced apartments and apart-hotels, purpose-built student accommodation (PBSA), co-living, senior living and care homes, holiday parks and glamping, pubs and bars, and restaurants and food halls. Each vertical has specialist lenders who understand the operating model, the revenue drivers, and the risk profile.',
      body_p3: 'The difference between a general broker and a specialist advisor is knowing which lender fits which sub-sector. We track lender appetite across every vertical and know what terms are achievable for each asset type.',
      grid: [
        { title: 'Hotels & Leisure', desc: 'Branded and independent hotels, serviced apartments, apart-hotels, and resort properties.' },
        { title: 'Student Accommodation', desc: 'PBSA development and investment — direct-let, nomination agreements, and university partnerships.' },
        { title: 'Senior Living & Care', desc: 'Retirement villages, assisted living, nursing homes, and dementia care facilities.' },
        { title: 'Full Service Overview', desc: 'Complete overview of Turning Point\'s debt advisory services across the hospitality sector.' },
      ],
      callout_heading: 'SECTOR DEPTH MATTERS',
      callout_points: [
        '<strong style="color:#ffffff;">Each sub-sector has its own lenders</strong> — A hotel lender is not necessarily a PBSA lender. A senior living specialist will not price holiday park risk the same way. We know who lends where.',
        '<strong style="color:#ffffff;">Underwriting varies by vertical</strong> — RevPAR-based valuations for hotels, rental yield for PBSA, care quality ratings for senior living. We structure information memoranda that speak each lender\'s language.',
        '<strong style="color:#ffffff;">UK and European coverage</strong> — We advise on cross-border hospitality deals across 8 European markets alongside our core UK practice.',
      ],
      callout_cta: 'Explore Our Sectors',
      cta_url: `${TP_BASE}/sectors/hotels`,
    },
  },
  {
    week: 3,
    subject: 'Access to 50+ specialist hospitality lenders',
    image: IMAGE_URLS.intro_week3,
    gridLinks: INTRO_GRID_LINKS_3,
    linkedin: `The biggest mistake I see in hospitality financing is going to one or two lenders and assuming those terms represent the market.

They don't. The UK hospitality lending market has 50+ active participants — clearing banks, challenger banks, specialist hotel lenders, debt funds, insurance companies, pension funds, family offices, and international banks with UK hospitality desks.

Each lender has different appetite at different times. Some are deploying aggressively into hotels right now. Others have pulled back. Some will do 70% LTV on a stabilised asset. Others cap at 55%. Some will fund a ground-up development. Others only refinance.

The only way to see the full picture is to run a competitive process across the market. That is what we do. Every time.

When did you last benchmark your hospitality debt terms against the full market?`,
    content: {
      subject: 'Access to 50+ specialist hospitality lenders',
      stats: [
        { value: '50+', label: 'SPECIALIST LENDERS' },
        { value: '£2B+', label: 'TOTAL DEALS ADVISED' },
        { value: '100%', label: 'INDEPENDENT ADVISORY' },
      ],
      intro: 'The third thing I wanted to cover is how we source debt for our clients — and why running a competitive process across our lender network produces materially better outcomes than going direct to one or two banks.',
      body_p2: 'We maintain active relationships with 50+ specialist lenders: UK clearing banks and challengers, specialist hotel lenders, hospitality-focused debt funds, mezzanine providers, insurance company and pension fund platforms, family offices, and international banks with UK hospitality appetite. Our independence means we are not tied to any panel — we go where the best terms are for each specific deal.',
      body_p3: 'Lender appetite shifts every quarter. What was competitive six months ago may not be today. We track which lenders are actively deploying, what their current criteria look like, and where the pricing is tightest for each asset type.',
      grid: [
        { title: 'Debt Advisory Process', desc: 'Structured competitive process across multiple lenders to find the best terms for your specific deal.' },
        { title: 'Development Finance', desc: 'Senior, stretch senior, and mezzanine structures for ground-up hospitality development schemes.' },
        { title: 'Refinancing & Investment', desc: 'Stabilised investment debt, bridge-to-term, and portfolio refinancing for trading hospitality assets.' },
        { title: 'Get In Touch', desc: 'No obligation conversation about your current hospitality debt requirements or upcoming deals.' },
      ],
      callout_heading: 'WHAT OUR LENDER NETWORK GIVES YOU',
      callout_points: [
        '<strong style="color:#ffffff;">Full market visibility</strong> — See terms from across the hospitality lending market, not just the lenders you already know. 50+ active relationships mean competitive tension on every deal.',
        '<strong style="color:#ffffff;">Current appetite intelligence</strong> — We track which lenders are actively deploying into hospitality, what sub-sectors they favour, and what terms they are offering this quarter.',
        '<strong style="color:#ffffff;">Independent advisory</strong> — We are not tied to any lender panel or referral arrangement. Our advice is driven entirely by what produces the best outcome for the client.',
      ],
      callout_cta: 'Talk To Our Team',
      cta_url: `${TP_BASE}/contact`,
    },
  },
  {
    week: 4,
    subject: 'Our hospitality deal track record — what we have delivered',
    image: IMAGE_URLS.intro_week4,
    gridLinks: INTRO_GRID_LINKS_4,
    linkedin: `If you have been following this series, you have seen what Turning Point covers: hospitality sector expertise, lender relationships, and the competitive process we run for every deal.

This is the final email. Here is the question: do you have a hospitality financing requirement — current or upcoming — that would benefit from a specialist running a competitive process across 50+ lenders?

It does not matter if the deal is early-stage. We advise on pre-planning bridging, development finance, stabilised investment debt, and refinancing. Hotels, PBSA, senior living, holiday parks, serviced apartments — across all the hospitality sub-sectors.

A 20-minute call is enough to understand the deal and give you an honest view of what the market will offer. No obligation, no hard sell.

Reply to this email or book a call at tp.finance.`,
    content: {
      subject: 'Our hospitality deal track record — what we have delivered',
      stats: [
        { value: '£2B+', label: 'DEALS ADVISED TO DATE' },
        { value: '85%+', label: 'MANDATE SUCCESS RATE' },
        { value: '50+', label: 'LENDER RELATIONSHIPS' },
      ],
      intro: 'Over the past three weeks I\'ve introduced Turning Point\'s hospitality advisory practice — our sector expertise, the 12 sub-sectors we cover, and the 50+ specialist lenders in our network.',
      body_p2: 'The proof is in the deals. We have advised on over £2 billion of hospitality debt transactions across the UK and Europe — hotel acquisitions, ground-up developments, portfolio refinancings, and bridge-to-term structures. Our mandate success rate exceeds 85%, which means when we take on a deal, we deliver.',
      body_p3: 'If you have a hospitality financing requirement — current or upcoming — a 20-minute call is enough for us to understand the deal and give you an honest view of what the market will offer. No obligation, no hard sell.',
      grid: [
        { title: 'Track Record', desc: 'Over £2B of hospitality deals advised — hotels, PBSA, senior living, holiday parks, and more.' },
        { title: 'About Turning Point', desc: 'Who we are, how we work, and why we focus exclusively on hospitality real estate debt.' },
        { title: 'Our Services', desc: 'Bridging, development finance, investment debt, and refinancing across every hospitality sub-sector.' },
        { title: 'Book A Call', desc: '20 minutes to understand your deal and give you an honest market view. No obligation.' },
      ],
      callout_heading: 'WHAT A CALL WITH US COVERS',
      callout_points: [
        '<strong style="color:#ffffff;">Deal assessment</strong> — We will review your hospitality asset or development scheme and give you an honest view of what the lending market will offer in terms, leverage, and pricing.',
        '<strong style="color:#ffffff;">Lender shortlist</strong> — Based on the asset type, location, and deal structure, we will tell you which lenders are most likely to compete and what they will need to see.',
        '<strong style="color:#ffffff;">No obligation</strong> — A 20-minute conversation costs nothing. If there is a fit, we will discuss next steps. If not, you will still walk away with useful market intelligence.',
      ],
      callout_cta: 'Book A Call',
      cta_url: `${TP_BASE}/contact`,
    },
  },
];

// ---- DB interface ----
interface DraftReview {
  id: string;
  tenant: string;
  theme: string;
  season: string;
  week_start: string;
  round: number;
  email_subject: string;
  email_html: string;
  email_content_json: EmailContent | null;
  linkedin_content: string | null;
  linkedin_poster_html: string | null;
  image_url: string | null;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  from_account_id: string | null;
  approval_token: string;
  skip_token: string;
  status: string;
  feedback_1: string | null;
  feedback_2: string | null;
  approved_at: string | null;
  sent_at: string | null;
  emails_sent: number;
  reply_processed_at: string | null;
  created_at: string;
}

function getSeason(): 'spring' | 'summer' | 'autumn' | 'winter' {
  const month = new Date().getMonth() + 1;
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function getMondayOfWeek(date: Date): string {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

class DraftReviewService {
  async isOutreachWeek(): Promise<boolean> {
    const week = getISOWeek(new Date());
    if (week % 2 === 0) return true;
    const recent = await query<{ created_at: string }>(
      `SELECT created_at FROM template_draft_reviews
       WHERE tenant = $1 AND created_at > NOW() - INTERVAL '10 days'
       ORDER BY created_at DESC LIMIT 1`,
      [TENANT]
    );
    return recent.rows.length === 0;
  }

  getThemeForWeek(date?: Date): typeof THEMES[0] {
    const week = getISOWeek(date || new Date());
    const idx = Math.floor(week / 2) % THEMES.length;
    return THEMES[idx];
  }

  getUpcomingOutreachWeeks(count: number): Date[] {
    const weeks: Date[] = [];
    const now = new Date();
    const monday = new Date(now);
    const day = monday.getDay() || 7;
    monday.setDate(monday.getDate() - (day - 1));
    monday.setUTCHours(0, 0, 0, 0);
    let candidate = new Date(monday);
    while (weeks.length < count) {
      const week = getISOWeek(candidate);
      if (week % 2 === 0) weeks.push(new Date(candidate));
      candidate = new Date(candidate);
      candidate.setDate(candidate.getDate() + 7);
    }
    return weeks;
  }

  // Returns the 4 intro email templates as static content objects
  getIntroEmailTemplates(): typeof INTRO_EMAILS {
    return INTRO_EMAILS;
  }

  async generateDraft(targetDate?: Date): Promise<DraftReview> {
    const date = targetDate || new Date();
    const theme = this.getThemeForWeek(date);
    const season = getSeason();
    const angle = theme.seasonal[season];
    const weekStart = getMondayOfWeek(date);
    const imageUrl = IMAGE_URLS[theme.image] || IMAGE_URLS.city_london;

    console.log(`[DraftReview] Generating draft — theme: ${theme.name}, season: ${season}, week: ${weekStart}`);

    const existing = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews
       WHERE tenant = $1 AND week_start = $2 AND status NOT IN ('skipped', 'superseded')
       ORDER BY round DESC LIMIT 1`,
      [TENANT, weekStart]
    );
    if (existing.rows[0] && existing.rows[0].status !== 'drafting') {
      console.log(`[DraftReview] Draft already exists for week ${weekStart} — skipping generation`);
      return existing.rows[0];
    }

    // ---- Ask Claude for structured JSON content only ----
    // Stats are now fixed per theme (real platform numbers) — Claude only generates copy.
    const contentPrompt = `Generate the content for a bi-weekly email for Turning Point Capital Advisory (${TP_BASE}) — a UK hospitality debt advisory firm. The email goes to hospitality operators, developers, and investors.

THEME: ${theme.name}
SEASON: ${season}
ANGLE: ${angle.angle}
CTA: ${angle.cta}

ABOUT THIS SERVICE AREA:
${theme.platformFeatures}

IMPORTANT RULES:
- Only reference services and capabilities described above. Do NOT invent statistics, deal volumes, or market data not included above.
- Turning Point Capital Advisory is a specialist debt advisory firm focused exclusively on hospitality real estate.
- We advise on bridging, development finance, investment debt, and refinancing across hotels, PBSA, senior living, holiday parks, serviced apartments, co-living, pubs, and restaurants.
- We maintain relationships with 50+ specialist lenders and run competitive processes for every deal.
- We are NOT a lender. We are an independent advisory firm. We do not provide financial advice — we source and structure debt.
- Do NOT make up specific deal values, interest rates, or LTV figures unless they appear in the service description above.
- You CAN reference: 50+ specialist lenders, £2B+ deals advised, 12 hospitality sub-sectors, 85%+ mandate success rate, 15+ years sector experience, 8 European markets.

Tone: direct, confident, informed — you're explaining why this specific service area matters to someone financing hospitality assets. Not salesy. No buzzwords. Concrete, specific benefits based on the real service description above.

Return JSON only (no markdown fences):
{
  "subject": "specific subject line — max 60 chars, references the theme angle",
  "intro": "First paragraph after Hey {{first_name}}, — 3-4 sentences explaining what this service covers and why it matters to someone in hospitality",
  "body_p2": "Second paragraph — 3-4 sentences going deeper into the specific capabilities, referencing real services from the description above",
  "body_p3": "Third paragraph — 2-3 sentences, a direct ask or invitation to discuss their requirements",
  "grid": [
    {"title": "Short service title", "desc": "One sentence about this real Turning Point capability"},
    {"title": "Short service title", "desc": "One sentence about this real Turning Point capability"},
    {"title": "Short service title", "desc": "One sentence about this real Turning Point capability"},
    {"title": "Short service title", "desc": "One sentence about this real Turning Point capability"}
  ],
  "callout_heading": "What you get with ${theme.name.toLowerCase()}",
  "callout_points": [
    "First specific, real benefit — reference an actual capability from the service description",
    "Second specific, real benefit",
    "Third specific, real benefit"
  ],
  "callout_cta": "${angle.cta}",
  "poster_headline": "A punchy 5-10 word headline for a LinkedIn poster image about this service — not a question, a statement",
  "poster_subline": "One sentence (max 15 words) expanding on the headline"
}`;

    const contentMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: contentPrompt }],
    });

    let emailContent: EmailContent;
    let posterHeadline = theme.name;
    let posterSubline = angle.angle;
    try {
      const raw = (contentMsg.content[0] as { text: string }).text.trim()
        .replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');
      const parsed = JSON.parse(raw);
      // Always use the theme's real stats — never AI-generated stats
      emailContent = { ...parsed, stats: theme.stats };
      posterHeadline = parsed.poster_headline || theme.name;
      posterSubline = parsed.poster_subline || angle.angle;
    } catch {
      emailContent = {
        subject: `${theme.name} — ${season.charAt(0).toUpperCase() + season.slice(1)}`,
        stats: theme.stats,
        intro: `I wanted to reach out about something we specialise in at Turning Point Capital Advisory — ${theme.name.toLowerCase()}.`,
        body_p2: `Turning Point is a specialist debt advisory firm focused exclusively on hospitality real estate. We advise on bridging, development finance, investment debt, and refinancing across hotels, PBSA, senior living, holiday parks, and the wider hospitality sector.`,
        body_p3: `Would you be open to a short call to discuss how we could help? I can walk you through exactly how we work.`,
        grid: [
          { title: 'Hospitality Debt Advisory', desc: 'Specialist advisory across the full hospitality debt spectrum — bridging to investment.' },
          { title: '50+ Lender Network', desc: 'Active relationships with specialist hotel lenders, debt funds, banks, and insurance platforms.' },
          { title: 'Sector Expertise', desc: 'Hotels, PBSA, senior living, holiday parks, serviced apartments, and more.' },
          { title: 'Competitive Process', desc: 'Structured process across multiple lenders to find the best terms for every deal.' },
        ],
        callout_heading: `What you get with ${theme.name.toLowerCase()}`,
        callout_points: [
          'Access to 50+ specialist hospitality lenders — competitive processes on every deal',
          'Deep sector expertise across 12 hospitality sub-sectors with dedicated lender relationships',
          'Independent advisory — not tied to any lender panel, always acting in the client\'s interest',
        ],
        callout_cta: angle.cta,
      };
    }

    const emailSubject = emailContent.subject || `${theme.name} — ${season.charAt(0).toUpperCase() + season.slice(1)}`;
    const emailHtml = buildEmailHtml(emailContent, theme.name, imageUrl, theme.gridLinks);

    // ---- LinkedIn post ----
    const linkedinPrompt = `Write a LinkedIn post for Marcus Emadi — Managing Director at Turning Point Capital Advisory (${TP_BASE}), a specialist hospitality debt advisory firm.

THEME: ${theme.name}
ANGLE: ${angle.angle}

ABOUT THIS SERVICE:
${theme.platformFeatures}

Write this as Marcus, in first person. He runs a hospitality-focused debt advisory practice because he saw that operators and developers in the sector were consistently underserved by generalist brokers. He is direct, practical, and opinionated about how hospitality financing works in the UK.

STRICT RULES:
- First person throughout ("I", "we" when referring to Turning Point Capital Advisory)
- 150–220 words
- No bullet points or lists — all prose
- Vary sentence length deliberately: mix very short punchy sentences with longer analytical ones
- Talk about what the advisory service ACTUALLY DOES based on the description above — do NOT invent market statistics or deal figures
- You CAN reference: 50+ specialist lenders, 12 hospitality sub-sectors, £2B+ deals advised, 85%+ mandate success rate
- One genuine opinion about why hospitality operators and developers need specialist debt advice
- End with a question for the reader or a direct invitation to get in touch
- Sound like an advisor who knows his market deeply, not a content marketer
- DO NOT use any of these words or phrases: leverage, delve, navigate, underscore, realm, tapestry, game-changer, transformative, innovative, cutting-edge, it's worth noting, in today's landscape, in conclusion, overall, seamlessly, robust
- No invisible characters, no special Unicode — plain text only

Return ONLY the LinkedIn post text. No preamble, no explanation.`;

    const linkedinMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: linkedinPrompt }],
    });

    const linkedinContent = (linkedinMsg.content[0] as { text: string }).text.trim();

    // ---- LinkedIn poster image HTML ----
    const posterHtml = buildLinkedInPosterHtml(imageUrl);

    const result = await query<DraftReview>(
      `INSERT INTO template_draft_reviews
         (tenant, theme, season, week_start, round, email_subject, email_html, email_content_json,
          linkedin_content, linkedin_poster_html, image_url, status)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, 'awaiting_approval')
       RETURNING *`,
      [TENANT, theme.name, season, weekStart, emailSubject, emailHtml,
       JSON.stringify(emailContent), linkedinContent, posterHtml, imageUrl]
    );

    console.log(`[DraftReview] Draft created: ${result.rows[0].id}`);
    return result.rows[0];
  }

  async sendDraftEmail(draftId: string): Promise<void> {
    const draftResult = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    const draft = draftResult.rows[0];
    if (!draft) throw new Error(`Draft ${draftId} not found`);

    const baseUrl = process.env.TRACKING_DOMAIN || 'https://tp.finance/outreach';
    const approveUrl = `${baseUrl}/api/draft-reviews/${draft.id}/approve?token=${draft.approval_token}`;
    const skipUrl    = `${baseUrl}/api/draft-reviews/${draft.id}/skip?token=${draft.skip_token}`;
    const viewUrl    = `${baseUrl}/#/drafts`;

    const weekFormatted = new Date(draft.week_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;margin:0;padding:24px">
<div style="max-width:680px;margin:0 auto">

  <!-- Header -->
  <div style="background:#0F2744;border-radius:10px 10px 0 0;padding:24px 28px;color:#fff">
    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:0.6;margin-bottom:6px">TP Outreach · Draft Review</div>
    <h1 style="margin:0;font-size:20px;font-weight:600">${draft.theme}</h1>
    <p style="margin:6px 0 0;opacity:0.7;font-size:14px">Week of ${weekFormatted} &mdash; Round ${draft.round} &mdash; ${draft.season.charAt(0).toUpperCase() + draft.season.slice(1)}</p>
  </div>

  <!-- Action buttons -->
  <div style="background:#fff;border:1px solid #dde3eb;border-top:none;padding:20px 28px;text-align:center">
    <a href="${approveUrl}"
       style="display:inline-block;background:#0F2744;color:#fff;padding:12px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;margin-right:12px">
      ✓ Approve &amp; Start Outreach
    </a>
    <a href="${skipUrl}"
       style="display:inline-block;background:#f3f4f6;color:#374151;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px">
      Skip this week
    </a>
    <p style="margin:10px 0 0;font-size:12px;color:#9ca3af">
      Reply to this email with edits (up to ${3 - draft.round + 1} more round${3 - draft.round + 1 !== 1 ? 's' : ''}) &nbsp;·&nbsp;
      <a href="${viewUrl}" style="color:#6b7280">View in platform</a>
    </p>
  </div>

  <!-- Email preview -->
  <div style="background:#fff;border:1px solid #dde3eb;border-top:none;padding:20px 28px;margin-top:0">
    <p style="margin:0 0 12px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px">Email Draft Preview</p>
    <div style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
      <div style="background:#f8fafc;padding:10px 16px;border-bottom:1px solid #e5e7eb">
        <span style="font-size:11px;color:#9ca3af">Subject: </span>
        <span style="font-size:13px;color:#111;font-weight:500">${draft.email_subject}</span>
      </div>
      <div style="padding:16px">
        ${draft.email_html}
      </div>
    </div>
  </div>

  <!-- LinkedIn preview -->
  <div style="background:#fff;border:1px solid #dde3eb;border-top:none;padding:20px 28px">
    <p style="margin:0 0 12px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px">LinkedIn Post Draft</p>
    <div style="border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;background:#f8fafc">
      <div style="font-size:14px;color:#1a1a2e;line-height:1.7;white-space:pre-wrap">${draft.linkedin_content || ''}</div>
    </div>
    <p style="margin:8px 0 0;font-size:12px;color:#9ca3af">Reply to this email with edits (up to ${3 - draft.round + 1} more round${3 - draft.round + 1 !== 1 ? 's' : ''}). You can edit the email, the LinkedIn post, or both.</p>
  </div>

  <!-- Footer approve again -->
  <div style="background:#fff;border:1px solid #dde3eb;border-radius:0 0 10px 10px;padding:20px 28px;text-align:center;border-top:none">
    <a href="${approveUrl}"
       style="display:inline-block;background:#0F2744;color:#fff;padding:12px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;margin-right:12px">
      ✓ Approve &amp; Start Outreach
    </a>
    <a href="${skipUrl}"
       style="display:inline-block;background:#f3f4f6;color:#374151;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px">
      Skip this week
    </a>
  </div>

</div>
</body>
</html>`;

    const accountResult = await query<{ id: string; email: string; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, oauth_tokens FROM email_accounts
       WHERE tenant = $1 AND is_active = true AND oauth_tokens != '{}'::jsonb
       ORDER BY sends_today ASC LIMIT 1`,
      [TENANT]
    );

    if (!accountResult.rows[0]) {
      throw new Error('No connected email account found — connect a Gmail account in Settings first');
    }

    const account = accountResult.rows[0];
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const toEmail = process.env.DASHBOARD_EMAIL || BRAND_EMAIL;

    const emailLines = [
      `To: ${toEmail}`,
      `From: TP Outreach <${account.email}>`,
      `Subject: [Draft Review] ${draft.theme} — Week of ${weekFormatted} (Round ${draft.round})`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html,
    ].join('\n');

    const sendResult = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(emailLines).toString('base64url') },
    });

    await query(
      `UPDATE template_draft_reviews
       SET gmail_thread_id = $1, gmail_message_id = $2, from_account_id = $3, status = 'awaiting_approval'
       WHERE id = $4`,
      [sendResult.data.threadId, sendResult.data.id, account.id, draftId]
    );

    console.log(`[DraftReview] Draft email sent to ${toEmail} — thread: ${sendResult.data.threadId}`);
  }

  async checkForReplies(): Promise<void> {
    const draftsResult = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews
       WHERE tenant = $1
         AND status = 'awaiting_approval'
         AND gmail_thread_id IS NOT NULL
         AND reply_processed_at IS NULL
         AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC`,
      [TENANT]
    );

    for (const draft of draftsResult.rows) {
      try {
        await this._processDraftReply(draft);
      } catch (err) {
        console.error(`[DraftReview] Error processing replies for draft ${draft.id}:`, (err as Error).message);
      }
    }
  }

  private async _processDraftReply(draft: DraftReview): Promise<void> {
    const accountResult = await query<{ id: string; email: string; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, oauth_tokens FROM email_accounts WHERE id = $1`,
      [draft.from_account_id]
    );
    const account = accountResult.rows[0];
    if (!account) return;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const threadResult = await gmail.users.threads.get({
      userId: 'me',
      id: draft.gmail_thread_id!,
      format: 'full',
    });

    const messages = threadResult.data.messages || [];
    if (messages.length <= 1) return;

    const toEmail = process.env.DASHBOARD_EMAIL || BRAND_EMAIL;

    const replies = messages.slice(1).filter(msg => {
      const from = msg.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value || '';
      return from.toLowerCase().includes(toEmail.split('@')[1]) ||
             from.toLowerCase().includes(toEmail.split('@')[0]);
    });

    if (replies.length === 0) return;

    const latestReply = replies[replies.length - 1];
    const replyText = this._extractMessageText(latestReply);
    if (!replyText || replyText.trim().length < 3) return;

    console.log(`[DraftReview] Reply received for draft ${draft.id}: "${replyText.substring(0, 100)}"`);

    await query(
      `UPDATE template_draft_reviews SET reply_processed_at = NOW() WHERE id = $1`,
      [draft.id]
    );

    if (draft.round >= 3) {
      console.log(`[DraftReview] Draft ${draft.id} already at round 3 — no more revisions`);
      const confirmLines = [
        `To: ${toEmail}`,
        `From: TP Outreach <${account.email}>`,
        `Subject: Re: [Draft Review] ${draft.theme} — this is the final draft`,
        `In-Reply-To: ${latestReply.id}`,
        `References: ${draft.gmail_thread_id}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        `This is the final draft (round 3). Click Approve in the original email to send, or Skip to cancel this week's outreach.`,
      ].join('\n');
      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: Buffer.from(confirmLines).toString('base64url'), threadId: draft.gmail_thread_id! },
      });
      return;
    }

    const newRound = draft.round + 1;
    const feedbackField = draft.round === 1 ? 'feedback_1' : 'feedback_2';

    await query(
      `UPDATE template_draft_reviews SET ${feedbackField} = $1 WHERE id = $2`,
      [replyText, draft.id]
    );

    // Revise the structured content JSON (not raw HTML) — much cleaner output
    const theme = THEMES.find(t => t.name === draft.theme) || THEMES[0];
    const currentContent = draft.email_content_json;

    const revisionPrompt = `You are revising the content for a bi-weekly email for Turning Point Capital Advisory (${TP_BASE}).

THEME: ${draft.theme}
SEASON: ${draft.season}

CURRENT EMAIL SUBJECT: ${draft.email_subject}

CURRENT EMAIL CONTENT:
${JSON.stringify(currentContent || {}, null, 2)}

CURRENT LINKEDIN POST:
${draft.linkedin_content || ''}

FEEDBACK FROM MARCUS:
${replyText}

Apply the requested changes. If the feedback mentions the email content, revise the relevant JSON fields. If it mentions the LinkedIn post, revise that. If general, apply to both.

For LinkedIn: maintain natural, human voice — varied sentence length, first person (Marcus Emadi, Managing Director at Turning Point Capital Advisory), specific references to real services and hospitality expertise, no AI buzzwords.

Return JSON only (no markdown fences):
{
  "subject": "revised or unchanged subject",
  "content": {
    "subject": "...",
    "stats": [...],
    "intro": "...",
    "body_p2": "...",
    "body_p3": "...",
    "grid": [...],
    "callout_heading": "...",
    "callout_points": [...],
    "callout_cta": "..."
  },
  "linkedin": "revised or unchanged LinkedIn post"
}`;

    const revisionMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: revisionPrompt }],
    });

    let newSubject = draft.email_subject;
    let newContent: EmailContent = currentContent || {
      subject: draft.email_subject,
      stats: [{ value: '50+', label: 'specialist lenders' }, { value: '£2B+', label: 'deals advised' }, { value: '12', label: 'hospitality sub-sectors' }],
      intro: '', body_p2: '', body_p3: '',
      grid: [{ title: '', desc: '' }, { title: '', desc: '' }, { title: '', desc: '' }, { title: '', desc: '' }],
      callout_heading: '', callout_points: ['', '', ''], callout_cta: '',
    };
    let newLinkedin = draft.linkedin_content || '';

    try {
      const raw = (revisionMsg.content[0] as { text: string }).text.trim()
        .replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');
      const parsed = JSON.parse(raw);
      newSubject  = parsed.subject  || newSubject;
      newContent  = parsed.content  || newContent;
      newLinkedin = parsed.linkedin || newLinkedin;
    } catch (err) {
      console.error('[DraftReview] Failed to parse revision JSON:', err);
    }

    // Always keep the real theme stats in the digest reply flow too
    if (theme.stats) newContent.stats = theme.stats;
    const newHtml = buildEmailHtml(newContent, draft.theme, draft.image_url || IMAGE_URLS.city_london, theme.gridLinks);
    const replyPosterHtml = buildLinkedInPosterHtml(draft.image_url || IMAGE_URLS.city_london);

    const newDraftResult = await query<DraftReview>(
      `INSERT INTO template_draft_reviews
         (tenant, theme, season, week_start, round, email_subject, email_html, email_content_json,
          linkedin_content, linkedin_poster_html, image_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'awaiting_approval')
       RETURNING *`,
      [TENANT, draft.theme, draft.season, draft.week_start,
       newRound, newSubject, newHtml, JSON.stringify(newContent), newLinkedin, replyPosterHtml, draft.image_url]
    );
    const newDraft = newDraftResult.rows[0];

    await query(
      `UPDATE template_draft_reviews SET status = 'superseded' WHERE id = $1`,
      [draft.id]
    );

    const weekFormatted = new Date(draft.week_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    const baseUrl = process.env.TRACKING_DOMAIN || 'https://tp.finance/outreach';
    const approveUrl = `${baseUrl}/api/draft-reviews/${newDraft.id}/approve?token=${newDraft.approval_token}`;
    const skipUrl    = `${baseUrl}/api/draft-reviews/${newDraft.id}/skip?token=${newDraft.skip_token}`;

    const replyHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;margin:0;padding:24px">
<div style="max-width:680px;margin:0 auto">
  <div style="background:#0F2744;border-radius:10px 10px 0 0;padding:20px 28px;color:#fff">
    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:0.6;margin-bottom:4px">Revised Draft · Round ${newRound} of 3</div>
    <h2 style="margin:0;font-size:18px;font-weight:600">${draft.theme} — Week of ${weekFormatted}</h2>
  </div>
  <div style="background:#fff;border:1px solid #dde3eb;border-top:none;padding:20px 28px;text-align:center">
    <a href="${approveUrl}" style="display:inline-block;background:#0F2744;color:#fff;padding:12px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;margin-right:12px">✓ Approve &amp; Send</a>
    <a href="${skipUrl}" style="display:inline-block;background:#f3f4f6;color:#374151;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px">Skip</a>
    ${newRound < 3 ? `<p style="margin:8px 0 0;font-size:12px;color:#9ca3af">Reply again for a final revision (round 3)</p>` : `<p style="margin:8px 0 0;font-size:12px;color:#9ca3af">This is the final revision — approve or skip</p>`}
  </div>
  <div style="background:#fff;border:1px solid #dde3eb;border-top:none;padding:20px 28px">
    <p style="margin:0 0 10px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px">Revised Email</p>
    <div style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
      <div style="background:#f8fafc;padding:10px 16px;border-bottom:1px solid #e5e7eb">
        <span style="font-size:11px;color:#9ca3af">Subject: </span>
        <span style="font-size:13px;color:#111;font-weight:500">${newSubject}</span>
      </div>
      <div style="padding:16px">${newHtml}</div>
    </div>
  </div>
  <div style="background:#fff;border:1px solid #dde3eb;border-top:none;border-radius:0 0 10px 10px;padding:20px 28px">
    <p style="margin:0 0 10px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px">Revised LinkedIn Post</p>
    <div style="border:1px solid #e5e7eb;border-radius:6px;padding:16px;background:#f8fafc;font-size:14px;color:#1a1a2e;line-height:1.7;white-space:pre-wrap">${newLinkedin}</div>
  </div>
</div>
</body>
</html>`;

    const replyLines = [
      `To: ${toEmail}`,
      `From: TP Outreach <${account.email}>`,
      `Subject: Re: [Draft Review] ${draft.theme} — Round ${newRound} revised`,
      `In-Reply-To: ${latestReply.id}`,
      `References: ${draft.gmail_thread_id}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      replyHtml,
    ].join('\n');

    const sendResult = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(replyLines).toString('base64url'), threadId: draft.gmail_thread_id! },
    });

    await query(
      `UPDATE template_draft_reviews
       SET gmail_thread_id = $1, gmail_message_id = $2, from_account_id = $3
       WHERE id = $4`,
      [draft.gmail_thread_id, sendResult.data.id, account.id, newDraft.id]
    );

    console.log(`[DraftReview] Revised draft sent — round ${newRound}, id ${newDraft.id}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _extractMessageText(message: any): string {
    const payload = message.payload;
    if (!payload) return '';

    const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf-8');

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return decode(part.body.data);
        }
      }
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return decode(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
    }

    if (payload.body?.data) {
      const text = decode(payload.body.data);
      return payload.mimeType === 'text/html'
        ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : text;
    }

    return '';
  }

  async deleteDraft(draftId: string): Promise<void> {
    const result = await query<{ id: string }>(
      `SELECT id FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    if (!result.rows[0]) throw new Error('Draft not found');
    await query(`DELETE FROM template_draft_reviews WHERE id = $1`, [draftId]);
  }

  async updateDraft(draftId: string, emailSubject: string, emailHtml: string): Promise<DraftReview> {
    const result = await query<DraftReview>(
      `UPDATE template_draft_reviews
       SET email_subject = $1, email_html = $2
       WHERE id = $3 AND tenant = $4
       RETURNING *`,
      [emailSubject, emailHtml, draftId, TENANT]
    );
    if (!result.rows[0]) throw new Error('Draft not found');
    return result.rows[0];
  }

  async approveDraftDirect(draftId: string): Promise<DraftReview> {
    const result = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    const draft = result.rows[0];
    if (!draft) throw new Error('Draft not found');
    if (!['awaiting_approval', 'drafting'].includes(draft.status)) {
      throw new Error(`Draft is already ${draft.status}`);
    }
    const updated = await query<DraftReview>(
      `UPDATE template_draft_reviews SET status = 'approved', approved_at = NOW() WHERE id = $1 RETURNING *`,
      [draftId]
    );
    return updated.rows[0];
  }

  async skipDraftDirect(draftId: string): Promise<void> {
    const result = await query<DraftReview>(
      `SELECT id FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    if (!result.rows[0]) throw new Error('Draft not found');
    await query(
      `UPDATE template_draft_reviews SET status = 'skipped' WHERE id = $1`,
      [draftId]
    );
  }

  async approveDraft(draftId: string, token: string): Promise<DraftReview> {
    const result = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    const draft = result.rows[0];
    if (!draft) throw new Error('Draft not found');
    if (!safeEqual(token, String(draft.approval_token ?? ''))) throw new Error('Invalid approval token');
    if (!['awaiting_approval', 'drafting'].includes(draft.status)) {
      throw new Error(`Draft is already ${draft.status}`);
    }
    // Emailed approval links expire: refuse anything older than 72 hours
    if (Date.now() - new Date(draft.created_at).getTime() > 72 * 60 * 60 * 1000) {
      throw new Error('This approval link has expired (older than 72 hours). Approve from the platform instead.');
    }

    // Atomic transition: only one caller can move a pending draft to approved
    const updated = await query<DraftReview>(
      `UPDATE template_draft_reviews
       SET status = 'approved', approved_at = NOW()
       WHERE id = $1 AND tenant = $2 AND status IN ('awaiting_approval', 'drafting')
       RETURNING *`,
      [draftId, TENANT]
    );
    if (!updated.rows[0]) throw new Error('Draft is no longer awaiting approval');

    return updated.rows[0];
  }

  async skipDraft(draftId: string, token: string): Promise<void> {
    const result = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    const draft = result.rows[0];
    if (!draft) throw new Error('Draft not found');
    if (!safeEqual(token, String(draft.skip_token ?? ''))) throw new Error('Invalid skip token');
    if (!['awaiting_approval', 'drafting'].includes(draft.status)) {
      throw new Error(`Draft is already ${draft.status}`);
    }
    // Emailed skip links expire like approve links: refuse anything older than 72 hours
    if (Date.now() - new Date(draft.created_at).getTime() > 72 * 60 * 60 * 1000) {
      throw new Error('This skip link has expired (older than 72 hours). Skip from the platform instead.');
    }

    // Atomic transition: only skip a draft that is still pending
    const updated = await query<{ id: string }>(
      `UPDATE template_draft_reviews SET status = 'skipped'
       WHERE id = $1 AND tenant = $2 AND status IN ('awaiting_approval', 'drafting')
       RETURNING id`,
      [draftId, TENANT]
    );
    if (!updated.rows[0]) throw new Error(`Draft is already ${draft.status}`);
  }

  async executeDraftSend(draftId: string): Promise<number> {
    const result = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    const draft = result.rows[0];
    if (!draft) throw new Error('Draft not found');
    if (draft.status !== 'approved') throw new Error(`Draft status is ${draft.status}`);

    await query(
      `UPDATE template_draft_reviews SET status = 'sent' WHERE id = $1`,
      [draftId]
    );

    const templateResult = await query<{ id: string }>(
      `INSERT INTO templates (name, subject, body_html, is_active, tenant)
       VALUES ($1, $2, $3, true, $4)
       RETURNING id`,
      [
        `${draft.theme} — ${draft.season.charAt(0).toUpperCase() + draft.season.slice(1)} ${new Date(draft.week_start).getFullYear()} (R${draft.round})`,
        draft.email_subject,
        draft.email_html,
        TENANT,
      ]
    );
    const templateId = templateResult.rows[0].id;

    const contactsResult = await query<{
      id: string; email: string; first_name: string | null; last_name: string | null;
      company: string | null;
    }>(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.company
       FROM contacts c
       JOIN contact_list_members clm ON clm.contact_id = c.id
       JOIN contact_lists cl ON cl.id = clm.list_id
       WHERE cl.tenant = $1
         AND LOWER(cl.name) LIKE '%lender%'
         AND c.tenant = $1
         AND c.email_verified = true
         AND NOT ('unsubscribed' = ANY(c.tags))
         AND NOT EXISTS (
           SELECT 1 FROM email_sends es
           WHERE es.contact_id = c.id
             AND es.tenant = $1
             AND es.status IN ('sent', 'queued')
             AND es.created_at > NOW() - INTERVAL '10 days'
         )`,
      [TENANT]
    );

    console.log(`[DraftReview] Sending approved draft to ${contactsResult.rows.length} lender contacts`);

    let sent = 0;
    for (const contact of contactsResult.rows) {
      try {
        const { SequenceEngine } = await import('./sequence-engine');
        const engine = new SequenceEngine();

        const sequenceResult = await query<{ id: string }>(
          `INSERT INTO sequences
             (tenant, name, description, is_active, stop_on_reply, skip_weekends,
              send_window_start, send_window_end)
           VALUES ($1, $2, $3, true, true, true, '07:00', '18:00')
           RETURNING id`,
          [
            TENANT,
            `${draft.theme} — ${new Date(draft.week_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
            `Auto-created from draft review ${draft.id}`,
          ]
        );

        await query(
          `INSERT INTO sequence_steps (sequence_id, step_number, template_id, delay_days, delay_hours)
           VALUES ($1, 1, $2, 0, 0)`,
          [sequenceResult.rows[0].id, templateId]
        );

        await engine.enrollContact(sequenceResult.rows[0].id, contact.id);
        sent++;
      } catch (err) {
        console.error(`[DraftReview] Failed to enroll contact ${contact.id}:`, (err as Error).message);
      }
    }

    await query(
      `UPDATE template_draft_reviews SET emails_sent = $1, sent_at = NOW() WHERE id = $2`,
      [sent, draftId]
    );

    console.log(`[DraftReview] Draft send complete — ${sent} contacts enrolled`);

    // Auto-generate the next bi-weekly draft
    setImmediate(async () => {
      try {
        const sentWeekStart = new Date(draft.week_start + 'T00:00:00Z');
        const nextWeeks = this.getUpcomingOutreachWeeks(8);
        const nextTarget = nextWeeks.find(w => w > sentWeekStart);
        if (nextTarget) {
          const existing = await query<{ id: string }>(
            `SELECT id FROM template_draft_reviews
             WHERE tenant = $1 AND week_start = $2 AND status NOT IN ('skipped', 'superseded')
             LIMIT 1`,
            [TENANT, nextTarget.toISOString().slice(0, 10)]
          );
          if (!existing.rows[0]) {
            const nextDraft = await this.generateDraft(nextTarget);
            console.log(`[DraftReview] Auto-generated next draft: ${nextDraft.id} for week ${nextDraft.week_start}`);
          }
        }
      } catch (err) {
        console.error('[DraftReview] Auto-generate next draft failed:', (err as Error).message);
      }
    });

    return sent;
  }

  async list(limit = 50): Promise<DraftReview[]> {
    const result = await query<DraftReview>(
      `SELECT id, tenant, theme, season, week_start, round, email_subject,
              email_html, email_content_json, image_url, status, approved_at, sent_at, emails_sent,
              approval_token, skip_token, linkedin_content, linkedin_poster_html,
              feedback_1, feedback_2, created_at
       FROM template_draft_reviews
       WHERE tenant = $1
       ORDER BY week_start DESC, round DESC
       LIMIT $2`,
      [TENANT, limit]
    );
    return result.rows;
  }

  async get(draftId: string): Promise<DraftReview | null> {
    const result = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    return result.rows[0] || null;
  }

  async getStats(draftId: string): Promise<{
    emails_sent: number; opens: number; open_rate: number; clicks: number; bounces: number;
  }> {
    const statsResult = await query<{
      emails_sent: number; opens: number; clicks: number; bounces: number;
    }>(
      `SELECT
         dr.emails_sent,
         COUNT(DISTINCT CASE WHEN ee.event_type = 'open'   THEN ee.email_send_id END) AS opens,
         COUNT(DISTINCT CASE WHEN ee.event_type = 'click'  THEN ee.email_send_id END) AS clicks,
         COUNT(DISTINCT CASE WHEN ee.event_type = 'bounce' THEN ee.email_send_id END) AS bounces
       FROM template_draft_reviews dr
       LEFT JOIN templates t ON t.name LIKE dr.theme || ' — %' AND t.tenant = dr.tenant
       LEFT JOIN email_sends es ON es.template_id = t.id AND es.tenant = dr.tenant
       LEFT JOIN email_events ee ON ee.email_send_id = es.id
       WHERE dr.id = $1 AND dr.tenant = $2
       GROUP BY dr.emails_sent`,
      [draftId, TENANT]
    );
    const row = statsResult.rows[0] || { emails_sent: 0, opens: 0, clicks: 0, bounces: 0 };
    const emailsSent = Number(row.emails_sent) || 0;
    const opens = Number(row.opens) || 0;
    return {
      emails_sent: emailsSent,
      opens,
      open_rate: emailsSent > 0 ? Math.round((opens / emailsSent) * 100) : 0,
      clicks: Number(row.clicks) || 0,
      bounces: Number(row.bounces) || 0,
    };
  }

  async generateBulk(weeksAhead: number): Promise<{ generated: number; skipped: number; weeks: string[] }> {
    const targetWeeks = this.getUpcomingOutreachWeeks(weeksAhead);
    let generated = 0;
    let skipped = 0;
    const generatedWeeks: string[] = [];

    for (const weekDate of targetWeeks) {
      try {
        const weekStart = getMondayOfWeek(weekDate);
        const existing = await query<{ id: string; status: string }>(
          `SELECT id, status FROM template_draft_reviews
           WHERE tenant = $1 AND week_start = $2 AND status NOT IN ('skipped', 'superseded')
           ORDER BY round DESC LIMIT 1`,
          [TENANT, weekStart]
        );
        if (existing.rows[0] && existing.rows[0].status !== 'drafting') { skipped++; continue; }
        await this.generateDraft(weekDate);
        generated++;
        generatedWeeks.push(weekStart);
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[DraftReview] Bulk gen failed for week ${weekDate.toISOString().slice(0, 10)}:`, (err as Error).message);
      }
    }

    console.log(`[DraftReview] Bulk generation complete: ${generated} generated, ${skipped} skipped`);
    return { generated, skipped, weeks: generatedWeeks };
  }

  async applyFeedback(draftId: string, feedbackText: string): Promise<DraftReview> {
    const result = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    const draft = result.rows[0];
    if (!draft) throw new Error('Draft not found');
    if (!['awaiting_approval', 'drafting'].includes(draft.status)) throw new Error(`Cannot edit a draft with status: ${draft.status}`);
    if (draft.round >= 3) throw new Error('Maximum 3 rounds reached');

    const newRound = draft.round + 1;
    const feedbackField = draft.round === 1 ? 'feedback_1' : 'feedback_2';
    await query(`UPDATE template_draft_reviews SET ${feedbackField} = $1 WHERE id = $2`, [feedbackText, draftId]);

    const theme = THEMES.find(t => t.name === draft.theme) || THEMES[0];
    const currentContent = draft.email_content_json;

    const revisionPrompt = `You are revising the content for a bi-weekly email for Turning Point Capital Advisory (${TP_BASE}).

THEME: ${draft.theme}
SEASON: ${draft.season}

ABOUT THIS SERVICE:
${theme.platformFeatures}

CURRENT EMAIL SUBJECT: ${draft.email_subject}

CURRENT EMAIL CONTENT:
${JSON.stringify(currentContent || {}, null, 2)}

CURRENT LINKEDIN POST:
${draft.linkedin_content || ''}

FEEDBACK:
${feedbackText}

Apply the requested changes. If feedback mentions the email content, revise the relevant JSON fields. If it mentions LinkedIn, revise that. If general, apply to both.

IMPORTANT: Only reference real services and capabilities described above. Do NOT invent statistics or market data. Stats in the email are fixed and should not be changed.

For LinkedIn: natural human voice — varied sentence length, first person (Marcus Emadi, Managing Director at Turning Point Capital Advisory), specific references to real services and hospitality expertise, no AI buzzwords.

Return JSON only (no markdown fences):
{
  "subject": "revised or unchanged subject",
  "content": {
    "subject": "...",
    "intro": "...",
    "body_p2": "...",
    "body_p3": "...",
    "grid": [...],
    "callout_heading": "...",
    "callout_points": [...],
    "callout_cta": "...",
    "poster_headline": "revised or unchanged poster headline",
    "poster_subline": "revised or unchanged poster subline"
  },
  "linkedin": "revised or unchanged LinkedIn post"
}`;

    const revisionMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: revisionPrompt }],
    });

    let newSubject = draft.email_subject;
    let newContent: EmailContent = currentContent || {
      subject: draft.email_subject,
      stats: theme.stats,
      intro: '', body_p2: '', body_p3: '',
      grid: [{ title: '', desc: '' }, { title: '', desc: '' }, { title: '', desc: '' }, { title: '', desc: '' }],
      callout_heading: '', callout_points: ['', '', ''], callout_cta: '',
    };
    let newLinkedin = draft.linkedin_content || '';

    try {
      const raw = (revisionMsg.content[0] as { text: string }).text.trim()
        .replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');
      const parsed = JSON.parse(raw);
      newSubject  = parsed.subject  || newSubject;
      // Always keep the real theme stats
      newContent  = parsed.content ? { ...parsed.content, stats: theme.stats } : newContent;
      newLinkedin = parsed.linkedin || newLinkedin;
    } catch (err) {
      console.error('[DraftReview] Failed to parse revision JSON:', err);
    }

    const newHtml = buildEmailHtml(newContent, draft.theme, draft.image_url || IMAGE_URLS.city_london, theme.gridLinks);
    const newPosterHtml = buildLinkedInPosterHtml(draft.image_url || IMAGE_URLS.city_london);

    const newDraftResult = await query<DraftReview>(
      `INSERT INTO template_draft_reviews
         (tenant, theme, season, week_start, round, email_subject, email_html, email_content_json,
          linkedin_content, linkedin_poster_html, image_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'awaiting_approval')
       RETURNING *`,
      [TENANT, draft.theme, draft.season, draft.week_start,
       newRound, newSubject, newHtml, JSON.stringify(newContent), newLinkedin, newPosterHtml, draft.image_url]
    );

    await query(`UPDATE template_draft_reviews SET status = 'superseded' WHERE id = $1`, [draftId]);

    console.log(`[DraftReview] Platform feedback applied — new round ${newRound} for week ${draft.week_start}`);
    return newDraftResult.rows[0];
  }

  // ---- Direct poster edit — instant, no Claude API call ----
  async updatePoster(draftId: string, headline: string, subline: string): Promise<DraftReview> {
    const result = await query<DraftReview>(
      `SELECT * FROM template_draft_reviews WHERE id = $1 AND tenant = $2`,
      [draftId, TENANT]
    );
    const draft = result.rows[0];
    if (!draft) throw new Error('Draft not found');

    const posterHtml = buildLinkedInPosterHtml(draft.image_url || IMAGE_URLS.city_london);

    const contentJson = draft.email_content_json || {} as EmailContent;
    contentJson.poster_headline = headline;
    contentJson.poster_subline = subline;

    const updated = await query<DraftReview>(
      `UPDATE template_draft_reviews
       SET linkedin_poster_html = $1, email_content_json = $2
       WHERE id = $3
       RETURNING *`,
      [posterHtml, JSON.stringify(contentJson), draftId]
    );

    console.log(`[DraftReview] Poster updated directly for ${draft.theme}`);
    return updated.rows[0];
  }

  // ---- Seed the 4-week intro sequence into templates + sequences tables ----
  async seedIntroSequence(): Promise<{ created: boolean; sequenceId: string; templateIds: string[] }> {
    // Idempotent: check if sequence already exists
    const existing = await query<{ id: string }>(
      `SELECT id FROM sequences WHERE tenant = $1 AND name = 'TP Hospitality Advisory Series' LIMIT 1`,
      [TENANT]
    );
    if (existing.rows[0]) {
      console.log(`[SeedIntro] Intro sequence already exists: ${existing.rows[0].id}`);
      return { created: false, sequenceId: existing.rows[0].id, templateIds: [] };
    }

    console.log('[SeedIntro] Creating 4 intro email templates...');
    const templateIds: string[] = [];

    for (const intro of INTRO_EMAILS) {
      const html = buildEmailHtml(intro.content, `Intro Week ${intro.week}`, intro.image, intro.gridLinks);
      const result = await query<{ id: string }>(
        `INSERT INTO templates (name, subject, body_html, merge_fields, tenant)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          `TP Intro — Week ${intro.week}`,
          intro.content.subject,
          html,
          ['first_name', 'unsubscribe_url'],
          TENANT,
        ]
      );
      templateIds.push(result.rows[0].id);
      console.log(`[SeedIntro] Template week ${intro.week} created: ${result.rows[0].id}`);
    }

    console.log('[SeedIntro] Creating intro sequence...');
    const seqResult = await query<{ id: string }>(
      `INSERT INTO sequences
         (name, description, status, send_window_start, send_window_end, skip_weekends,
          daily_send_limit, stop_on_reply, tenant)
       VALUES ($1, $2, 'active', '08:00', '18:00', true, 50, true, $3) RETURNING id`,
      [
        'TP Hospitality Advisory Series',
        '4-week introduction to Turning Point Capital Advisory — sent to all new hospitality contacts.',
        TENANT,
      ]
    );
    const sequenceId = seqResult.rows[0].id;
    console.log(`[SeedIntro] Sequence created: ${sequenceId}`);

    // Step 1 sends immediately (delay_days=0), steps 2–4 each 7 days after the previous
    for (let i = 0; i < templateIds.length; i++) {
      await query(
        `INSERT INTO sequence_steps (sequence_id, step_number, template_id, delay_days, tenant)
         VALUES ($1, $2, $3, $4, $5)`,
        [sequenceId, i + 1, templateIds[i], i === 0 ? 0 : 7, TENANT]
      );
      console.log(`[SeedIntro] Step ${i + 1} created (delay_days=${i === 0 ? 0 : 7})`);
    }

    return { created: true, sequenceId, templateIds };
  }
}

export const draftReviewService = new DraftReviewService();
