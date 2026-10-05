/**
 * Generate all client + introducer email sequences and templates
 * for the TP.Finance outreach portal.
 *
 * Run:  npx tsx scripts/generate-sequences.ts
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TENANT = 'tp';

// ─── Hero image helpers ──────────────────────────────────────────────────────
const HERO_DIR = path.join(__dirname, '../data/hero');

function heroBase64(filename: string): string {
  const filePath = path.join(HERO_DIR, filename);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filename).slice(1) || 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

// ─── Sector definitions ──────────────────────────────────────────────────────

interface SectorDef {
  key: string;           // filesystem key (e.g. 'pbsa')
  label: string;         // display name (e.g. 'PBSA')
  headerLabel: string;   // header top-right label
  overlayLabel: string;  // dark overlay label
  sectorPageUrl: string; // CTA link
  // 6 email angles
  emails: EmailAngle[];
}

interface EmailAngle {
  templateName: string;
  subject: string;
  heroImage: string;     // filename in data/hero/
  overlayLabel: string;
  bodyIntro: string;     // 1-2 paragraphs after "Hey {{first_name}},"
  cards: Array<{ title: string; desc: string }>;  // exactly 4
  closingLine: string;   // paragraph before CTA button
  ctaText: string;
  ctaUrl: string;
  linkedin?: string;     // LinkedIn post text (populated by backfill script)
}

function buildLinkedInPosterHtml(imageUrl: string): string {
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

// ─── Client sectors ──────────────────────────────────────────────────────────

const CLIENT_SECTORS: SectorDef[] = [
  {
    key: 'hospitality',
    label: 'Hospitality',
    headerLabel: 'Hospitality Finance',
    overlayLabel: 'Pan-European Hospitality & Hotel Finance',
    sectorPageUrl: 'https://tp.finance/sectors/hospitality',
    emails: [
      {
        templateName: 'Clients — Hospitality — 1. Sector Overview',
        subject: 'Hospitality debt advisory — pan-European',
        heroImage: 'hospitality_01.jpg',
        overlayLabel: 'Pan-European Hospitality &amp; Hotel Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to reach out as we are seeing strong deal flow across the European hotel and hospitality market and thought it would be worth connecting to explore whether we can work together.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I run <strong>Turning Point Capital Advisory</strong>, a specialist debt advisory firm focused on hospitality finance across the UK and Europe — covering the full capital stack from development through to stabilised investment debt, across multiple jurisdictions simultaneously.</p>`,
        cards: [
          { title: 'Development Finance', desc: 'Ground-up construction, conversions and repositioning across the UK and Europe' },
          { title: 'Investment &amp; Portfolio Debt', desc: 'Term debt for stabilised assets and multi-asset portfolios across jurisdictions' },
          { title: 'Acquisition Finance', desc: 'Senior and whole loan structures for hotel acquisitions — branded flags and independents' },
          { title: 'Stabilisation &amp; Refinancing', desc: 'Refinancing distressed or transitional assets where conventional lenders step back' },
        ],
        closingLine: 'We are active across the UK, Germany, France, Spain, Benelux and the Nordics. Would you be open to a short call to discuss the current market and where we might collaborate?',
        ctaText: 'View Our Hospitality Sector Page →',
        ctaUrl: 'https://tp.finance/sectors/hospitality',
      },
      {
        templateName: 'Clients — Hospitality — 2. Development Finance',
        subject: 'Hotel development finance — ground-up to conversion',
        heroImage: 'hospitality_02.jpg',
        overlayLabel: 'Hotel Development Finance — Ground-Up &amp; Conversion',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Hotel development finance is one of the most complex areas of hospitality debt — and one where a specialist adviser makes the biggest difference. Whether you are building from the ground up, converting an existing asset, or repositioning a tired property, we know the lender market inside out.</p>`,
        cards: [
          { title: 'Ground-Up Construction', desc: 'Senior, stretched senior and mezzanine for new-build hotel schemes across the UK and Europe' },
          { title: 'Conversion &amp; Change of Use', desc: 'Office-to-hotel, residential-to-aparthotel and mixed-use conversions with complex planning profiles' },
          { title: 'Repositioning &amp; Refurbishment', desc: 'Capex-heavy refurb facilities alongside term debt — branded flag upgrades and independent repositioning' },
          { title: 'Pre-Opening &amp; Stabilisation Debt', desc: 'Bridge facilities through the ramp-up period into long-term investment finance once stabilised' },
        ],
        closingLine: 'We currently have live mandates across several development schemes and would love to understand your appetite. Are you free for a 15-minute call?',
        ctaText: 'View Our Hospitality Sector Page →',
        ctaUrl: 'https://tp.finance/sectors/hospitality',
      },
      {
        templateName: 'Clients — Hospitality — 3. Portfolio & Cross-Border',
        subject: 'Hotel portfolio debt — cross-border investment finance',
        heroImage: 'hospitality_03.jpg',
        overlayLabel: 'Hotel Portfolio &amp; Cross-Border Investment Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Cross-border hotel portfolio transactions are where a pan-European specialist adviser earns their fee. Navigating different lender appetites, regulatory environments and structuring requirements across jurisdictions simultaneously requires deep market knowledge — and that is exactly where we operate.</p>`,
        cards: [
          { title: 'Multi-Asset Portfolio Debt', desc: 'Single facility across multiple hotels — UK, Germany, France, Spain, Benelux and Nordics' },
          { title: 'Cross-Border Structuring', desc: 'PropCo structures, foreign currency risk, cross-collateralisation and multi-jurisdiction security packages' },
          { title: 'Acquisition Finance', desc: 'Senior and whole loan facilities for single-asset and portfolio acquisitions, including branded and independent hotels' },
          { title: 'Lender Introductions', desc: 'Access to a broad panel — banks, debt funds, insurance lenders and alternative credit with genuine hospitality appetite' },
        ],
        closingLine: 'We are currently active across several cross-border mandates and would be glad to share what we are seeing in the market. Are you free for a 15-minute call?',
        ctaText: 'View Our Hospitality Sector Page →',
        ctaUrl: 'https://tp.finance/sectors/hospitality',
      },
      {
        templateName: 'Clients — Hospitality — 4. Stabilisation & Refi',
        subject: 'Hotel stabilisation & refinancing — transitional assets',
        heroImage: 'hospitality_04.jpg',
        overlayLabel: 'Hotel Stabilisation, Restructuring &amp; Refinancing',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Stabilisation and refinancing is one of the most active parts of the hospitality debt market right now. Whether it is a post-development ramp-up, a distressed refinancing, or an asset coming out of a period of underperformance — we know which lenders will look at it and how to position it.</p>`,
        cards: [
          { title: 'Pre-Opening Stabilisation', desc: 'Bridge facilities through ramp-up periods into long-term investment debt once trading performance is established' },
          { title: 'Distressed Refinancing', desc: 'Refinancing assets where the incumbent lender is exiting or covenant pressure requires a new solution — fast execution' },
          { title: 'Repositioning Finance', desc: 'Debt alongside a major refurbishment or brand change — bridging through the disruption period into stabilised value' },
          { title: 'Debt Restructuring Advisory', desc: 'Advising borrowers navigating covenant breaches, maturity extensions and loan-on-loan structures' },
        ],
        closingLine: 'We are seeing a number of refinancing situations in the market right now and would be glad to share what we are working on. Would you be free for a quick call?',
        ctaText: 'View Our Hospitality Sector Page →',
        ctaUrl: 'https://tp.finance/sectors/hospitality',
      },
      {
        templateName: 'Clients — Hospitality — 5. Market Insight',
        subject: 'What lenders are doing in hospitality right now',
        heroImage: 'hospitality_05.jpg',
        overlayLabel: 'Hospitality Lending Market — Current Conditions',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to share some observations on what we are seeing across the European hospitality lending market. Appetite is shifting — some lenders are pulling back from certain geographies, while others are aggressively expanding their hotel books.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">As a specialist adviser active across multiple jurisdictions, we have real-time visibility on where pricing, leverage and appetite sit today.</p>`,
        cards: [
          { title: 'Bank Appetite Returning', desc: 'Several mainstream lenders are re-entering the hospitality space after two years on the sidelines — particularly for stabilised assets' },
          { title: 'Debt Funds Filling Gaps', desc: 'Alternative lenders are providing stretched senior and whole loan solutions where banks cannot reach — faster execution, higher leverage' },
          { title: 'Cross-Border Demand Rising', desc: 'Pan-European platforms are actively seeking multi-jurisdiction mandates — portfolio deals are attracting competitive terms' },
          { title: 'Development Lending Selective', desc: 'Construction finance for hotels remains selective but available for experienced sponsors with pre-lets or branded flag agreements' },
        ],
        closingLine: 'Happy to share more detailed market colour on a call — it may be useful context for any transactions you have in the pipeline. Are you free for 15 minutes?',
        ctaText: 'View Our Hospitality Sector Page →',
        ctaUrl: 'https://tp.finance/sectors/hospitality',
      },
      {
        templateName: 'Clients — Hospitality — 6. Partnership Call',
        subject: 'Quick catch-up — hospitality finance pipeline',
        heroImage: 'hospitality_06.jpg',
        overlayLabel: 'Let\u2019s Connect — Hospitality Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I have reached out a few times now and appreciate you may be busy — I just wanted to drop a final note in case the timing is better.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">We are continuing to see strong activity across the hospitality debt market and would welcome the chance to discuss how we might work together on future transactions. Even if nothing is imminent, understanding your pipeline helps us flag relevant opportunities as they come up.</p>`,
        cards: [
          { title: 'No Obligation', desc: 'A 15-minute call to understand your pipeline and share what we are seeing — no commitment required' },
          { title: 'Market Intelligence', desc: 'We can share real-time lender appetite, pricing benchmarks and recent comparable transactions across your target markets' },
          { title: 'Deal Origination', desc: 'We occasionally see off-market opportunities from our lender and sponsor network that may be relevant to your strategy' },
          { title: 'Long-Term Partnership', desc: 'Our best client relationships started with a single conversation — we are in this for the long run' },
        ],
        closingLine: 'Would you be open to a brief call this week or next? I am flexible on timing.',
        ctaText: 'View Our Hospitality Sector Page →',
        ctaUrl: 'https://tp.finance/sectors/hospitality',
      },
    ],
  },
  {
    key: 'pbsa',
    label: 'PBSA',
    headerLabel: 'Student Accommodation Finance',
    overlayLabel: 'Purpose-Built Student Accommodation Finance',
    sectorPageUrl: 'https://tp.finance/sectors/pbsa',
    emails: [
      {
        templateName: 'Clients — PBSA — 1. Sector Overview',
        subject: 'PBSA debt advisory — UK & European student accommodation',
        heroImage: 'pbsa_01.jpg',
        overlayLabel: 'Purpose-Built Student Accommodation Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to reach out as we are actively advising on student accommodation transactions across the UK and Europe and thought it would be worth connecting.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I run <strong>Turning Point Capital Advisory</strong>, a specialist debt advisory firm with deep experience in PBSA finance — from forward-funded development schemes through to stabilised portfolio acquisitions and refinancings.</p>`,
        cards: [
          { title: 'Development Finance', desc: 'Ground-up PBSA schemes — senior, stretched senior and mezzanine across UK university towns and European cities' },
          { title: 'Investment &amp; Portfolio Debt', desc: 'Term debt for stabilised PBSA blocks and multi-asset portfolios with long-term institutional backing' },
          { title: 'Acquisition Finance', desc: 'Senior and whole loan facilities for single-asset and portfolio acquisitions — direct-let and nomination agreements' },
          { title: 'Forward Funding Structures', desc: 'Financing alongside forward-fund commitments from institutional investors — aligning debt drawdown with development milestones' },
        ],
        closingLine: 'PBSA remains one of the most resilient asset classes in UK real estate. Would you be open to a short call to discuss the current market?',
        ctaText: 'Learn More About Our PBSA Advisory →',
        ctaUrl: 'https://tp.finance/sectors/pbsa',
      },
      {
        templateName: 'Clients — PBSA — 2. Development Finance',
        subject: 'PBSA development finance — ground-up student schemes',
        heroImage: 'pbsa_02.jpg',
        overlayLabel: 'PBSA Development Finance — Ground-Up &amp; Conversion',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Student accommodation development continues to attract lender appetite given the structural undersupply of quality beds across key university cities. We are advising on several live PBSA development mandates and the financing market is constructive.</p>`,
        cards: [
          { title: 'Ground-Up Construction', desc: 'Senior and stretched senior facilities for new-build PBSA — 200 to 1,000+ bed schemes across Russell Group and European university cities' },
          { title: 'Office-to-PBSA Conversion', desc: 'Change-of-use schemes converting commercial assets into modern student living — often with planning advantages and faster timelines' },
          { title: 'Forward-Fund Development', desc: 'Debt alongside institutional forward-fund commitments — structured drawdown aligned with construction milestones and pre-let agreements' },
          { title: 'Mezzanine &amp; Equity Bridge', desc: 'Subordinated debt to fill the gap between senior lending and sponsor equity — particularly for higher-leverage development schemes' },
        ],
        closingLine: 'If you have any PBSA development schemes in the pipeline, I would welcome the chance to discuss how we can help with the financing. Are you free for a 15-minute call?',
        ctaText: 'Learn More About Our PBSA Advisory →',
        ctaUrl: 'https://tp.finance/sectors/pbsa',
      },
      {
        templateName: 'Clients — PBSA — 3. Investment & Acquisition',
        subject: 'PBSA investment debt — portfolio & acquisition finance',
        heroImage: 'pbsa_03.jpg',
        overlayLabel: 'PBSA Investment &amp; Acquisition Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Institutional appetite for PBSA portfolios remains strong, and lenders are competing aggressively on stabilised student accommodation debt. Whether you are acquiring a single asset or building a portfolio, we know exactly where the best terms sit today.</p>`,
        cards: [
          { title: 'Portfolio Acquisition Debt', desc: 'Financing multi-asset PBSA portfolios across university cities — single facility, competitive margins' },
          { title: 'Single-Asset Acquisition', desc: 'Senior debt for stabilised PBSA blocks with strong occupancy and rental track records near key universities' },
          { title: 'Nomination Agreement Finance', desc: 'Debt structured around university nomination agreements — providing lenders with income security and borrowers with leverage' },
          { title: 'Club Deals &amp; Syndications', desc: 'Arranging club facilities and syndicated debt for larger PBSA transactions requiring multiple lending partners' },
        ],
        closingLine: 'If you are looking at any PBSA acquisitions, I would be happy to share current market pricing and lender appetite. Shall we arrange a quick call?',
        ctaText: 'Learn More About Our PBSA Advisory →',
        ctaUrl: 'https://tp.finance/sectors/pbsa',
      },
      {
        templateName: 'Clients — PBSA — 4. Refinancing',
        subject: 'PBSA refinancing — optimising your student accommodation debt',
        heroImage: 'pbsa_04.jpg',
        overlayLabel: 'PBSA Refinancing &amp; Debt Optimisation',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">With PBSA values holding firm and rental growth continuing in most key markets, now is an excellent time to review existing debt arrangements. We are advising several sponsors on refinancings that are unlocking significant equity release and improved terms.</p>`,
        cards: [
          { title: 'Maturity Refinancing', desc: 'Replacing maturing facilities with longer-term investment debt — often at improved margins as the asset seasons' },
          { title: 'Equity Release', desc: 'Refinancing at higher leverage once occupancy is proven — releasing equity for redeployment into new acquisitions or developments' },
          { title: 'Lender Consolidation', desc: 'Consolidating multiple bilateral facilities into a single portfolio-level arrangement — simpler, more efficient, better terms' },
          { title: 'Green Finance Overlay', desc: 'Accessing sustainability-linked margins and green loan frameworks for PBSA assets with strong EPC and BREEAM credentials' },
        ],
        closingLine: 'If you have any PBSA assets approaching maturity or where you would like to review terms, we would be glad to benchmark what is available. Free for a quick chat?',
        ctaText: 'Learn More About Our PBSA Advisory →',
        ctaUrl: 'https://tp.finance/sectors/pbsa',
      },
      {
        templateName: 'Clients — PBSA — 5. Market Insight',
        subject: 'PBSA lending market — what we are seeing right now',
        heroImage: 'pbsa_05.jpg',
        overlayLabel: 'PBSA Lending Market — Current Conditions',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to share some observations from the PBSA lending market. Student accommodation continues to be one of the most favoured asset classes among lenders — structural undersupply, resilient demand and strong rental growth make it a defensive play.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Here is what we are seeing across our live mandates:</p>`,
        cards: [
          { title: 'Bank Margins Compressing', desc: 'Competition among mainstream lenders is driving margins down for stabilised PBSA — best-in-class assets are seeing sub-200bps pricing' },
          { title: 'Development Appetite Steady', desc: 'Lenders remain supportive of PBSA development in supply-constrained university cities — pre-let commitments strengthen terms significantly' },
          { title: 'Institutional Capital Growing', desc: 'Insurance companies and pension funds are increasingly lending into PBSA as a long-income asset class — providing fixed-rate alternatives' },
          { title: 'Regional Demand Strong', desc: 'Tier 1 and Tier 2 university cities outside London are seeing increased lender interest as occupancy rates remain above 95%' },
        ],
        closingLine: 'Happy to share more detailed market colour on a call — it may be useful context for your current or upcoming transactions. Are you free for 15 minutes?',
        ctaText: 'Learn More About Our PBSA Advisory →',
        ctaUrl: 'https://tp.finance/sectors/pbsa',
      },
      {
        templateName: 'Clients — PBSA — 6. Partnership Call',
        subject: 'Quick catch-up — student accommodation finance',
        heroImage: 'pbsa_06.jpg',
        overlayLabel: 'Let\u2019s Connect — PBSA Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I have reached out a few times and appreciate you may be busy — just wanted to drop a final note in case the timing is better now.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">PBSA remains one of our most active sectors and we would welcome the chance to discuss how we might work together. Even if nothing is imminent, understanding your pipeline helps us flag relevant opportunities.</p>`,
        cards: [
          { title: 'No Obligation', desc: 'A 15-minute call to understand your pipeline and share what we are seeing — no commitment required' },
          { title: 'Market Intelligence', desc: 'Real-time lender appetite, pricing benchmarks and comparable transactions across your target university cities' },
          { title: 'Deal Origination', desc: 'We occasionally see off-market PBSA opportunities from our lender and sponsor network that may be relevant' },
          { title: 'Long-Term Partnership', desc: 'Our best client relationships started with a single conversation — we are in this for the long run' },
        ],
        closingLine: 'Would you be open to a brief call this week or next? I am flexible on timing.',
        ctaText: 'Learn More About Our PBSA Advisory →',
        ctaUrl: 'https://tp.finance/sectors/pbsa',
      },
    ],
  },
  {
    key: 'living',
    label: 'Living',
    headerLabel: 'Living Sector Finance',
    overlayLabel: 'Residential &amp; Living Sector Finance',
    sectorPageUrl: 'https://tp.finance/sectors/living',
    emails: [
      {
        templateName: 'Clients — Living — 1. Sector Overview',
        subject: 'Living sector debt advisory — BTR, co-living & residential',
        heroImage: 'living_01.jpg',
        overlayLabel: 'Residential &amp; Living Sector Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">The living sector is one of the fastest-growing areas of real estate finance — and one where specialist advisory makes a material difference. From build-to-rent through to co-living, senior living and affordable housing, we are seeing significant lender appetite.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I run <strong>Turning Point Capital Advisory</strong>, a specialist debt advisory firm with deep experience across the full spectrum of living sector finance.</p>`,
        cards: [
          { title: 'Build-to-Rent Finance', desc: 'Development and investment debt for BTR schemes — single-family, multi-family and suburban rental across the UK' },
          { title: 'Co-Living &amp; HMO', desc: 'Financing co-living developments and large-scale HMO portfolios — an emerging asset class with growing institutional backing' },
          { title: 'Senior &amp; Later Living', desc: 'Debt for retirement villages, assisted living and integrated care communities — an undersupplied market with strong demographics' },
          { title: 'Affordable &amp; Social Housing', desc: 'Working with housing associations and private developers on financing for affordable and mixed-tenure schemes' },
        ],
        closingLine: 'Would you be open to a short call to discuss the current living sector lending market and where we might add value?',
        ctaText: 'Learn More About Our Living Sector Advisory →',
        ctaUrl: 'https://tp.finance/sectors/living',
      },
      {
        templateName: 'Clients — Living — 2. Development Finance',
        subject: 'Living sector development finance — BTR & co-living schemes',
        heroImage: 'living_02.jpg',
        overlayLabel: 'Living Sector Development Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Development finance for living sector schemes requires a lender who understands the operational model — not just the bricks and mortar. We specialise in finding the right capital structure for build-to-rent, co-living and senior living developments.</p>`,
        cards: [
          { title: 'BTR Development', desc: 'Senior and stretched senior facilities for multi-family and single-family rental developments across the UK' },
          { title: 'Co-Living Schemes', desc: 'Financing purpose-built co-living developments — a newer asset class where lender education and positioning are critical' },
          { title: 'Senior Living Development', desc: 'Construction finance for retirement villages, extra-care and assisted living schemes with phased sales or rental income' },
          { title: 'Mixed-Tenure Development', desc: 'Debt structures for schemes combining private sale, affordable, shared ownership and rental — complex capital stacks simplified' },
        ],
        closingLine: 'If you have any living sector developments in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
        ctaText: 'Learn More About Our Living Sector Advisory →',
        ctaUrl: 'https://tp.finance/sectors/living',
      },
      {
        templateName: 'Clients — Living — 3. Investment & Acquisition',
        subject: 'Living sector investment debt — portfolio & acquisition',
        heroImage: 'living_03.jpg',
        overlayLabel: 'Living Sector Investment &amp; Acquisition Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Institutional capital is flowing into the UK living sector at pace, and lenders are competing to finance stabilised portfolios. Whether you are acquiring single assets or building a platform, we know where the best terms are today.</p>`,
        cards: [
          { title: 'BTR Portfolio Debt', desc: 'Financing multi-asset BTR portfolios — single facility across geographies, competitive margins for stabilised income' },
          { title: 'Single-Asset Acquisition', desc: 'Senior debt for stabilised residential rental assets with proven occupancy and rental track records' },
          { title: 'Platform Finance', desc: 'Debt facilities for living sector platforms — revolving credit, warehouse lines and portfolio-level term debt' },
          { title: 'Forward-Fund Structures', desc: 'Financing alongside institutional forward-fund commitments with drawdown aligned to construction milestones' },
        ],
        closingLine: 'If you are looking at any living sector acquisitions, I would be happy to share current pricing and appetite. Shall we arrange a quick call?',
        ctaText: 'Learn More About Our Living Sector Advisory →',
        ctaUrl: 'https://tp.finance/sectors/living',
      },
      {
        templateName: 'Clients — Living — 4. Refinancing',
        subject: 'Living sector refinancing — optimising your residential debt',
        heroImage: 'living_04.jpg',
        overlayLabel: 'Living Sector Refinancing &amp; Debt Optimisation',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">With rental growth outperforming most other asset classes, living sector assets are attracting increasingly competitive refinancing terms. We are advising several sponsors on refinancings that are delivering material improvements on existing facilities.</p>`,
        cards: [
          { title: 'Maturity Refinancing', desc: 'Replacing short-term development or bridge facilities with longer-term investment debt as assets stabilise' },
          { title: 'Equity Release', desc: 'Refinancing at higher leverage once occupancy is proven — releasing capital for redeployment into new acquisitions' },
          { title: 'Covenant Optimisation', desc: 'Renegotiating covenants and testing arrangements to better reflect the operational reality of living sector assets' },
          { title: 'Green &amp; Sustainability Loans', desc: 'Accessing sustainability-linked margin reductions for assets with strong EPC ratings and ESG credentials' },
        ],
        closingLine: 'If you have any living sector assets approaching maturity or where you would like to benchmark terms, we would be glad to help. Free for a quick chat?',
        ctaText: 'Learn More About Our Living Sector Advisory →',
        ctaUrl: 'https://tp.finance/sectors/living',
      },
      {
        templateName: 'Clients — Living — 5. Market Insight',
        subject: 'Living sector lending — what we are seeing right now',
        heroImage: 'living_05.jpg',
        overlayLabel: 'Living Sector Lending Market — Current Conditions',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to share some observations from the living sector lending market. Residential rental continues to be one of the most favoured asset classes — strong demographic tailwinds, rental growth and institutional demand are driving competitive lending conditions.</p>`,
        cards: [
          { title: 'BTR Margins Tightening', desc: 'Competition among lenders for stabilised BTR assets is compressing margins — best-in-class schemes are achieving very attractive terms' },
          { title: 'Senior Living Gaining Traction', desc: 'Lenders are becoming more comfortable with the senior living operating model — appetite is broadening beyond specialist funds' },
          { title: 'Co-Living Acceptance Growing', desc: 'Several mainstream lenders now have dedicated co-living desks — a significant shift from two years ago when appetite was limited' },
          { title: 'Regional BTR Demand', desc: 'Lender appetite is expanding beyond London into regional cities — Manchester, Birmingham, Leeds and Edinburgh are all seeing strong interest' },
        ],
        closingLine: 'Happy to share more detail on a call — it may be useful context for any transactions you have in the pipeline. Are you free for 15 minutes?',
        ctaText: 'Learn More About Our Living Sector Advisory →',
        ctaUrl: 'https://tp.finance/sectors/living',
      },
      {
        templateName: 'Clients — Living — 6. Partnership Call',
        subject: 'Quick catch-up — living sector finance pipeline',
        heroImage: 'living_06.jpg',
        overlayLabel: 'Let\u2019s Connect — Living Sector Finance',
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I have reached out a few times and appreciate you may be busy — just wanted to drop a final note in case the timing is better now.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">The living sector remains one of our most active areas and we would welcome the chance to connect. Even if nothing is imminent, understanding your pipeline helps us flag relevant opportunities as they arise.</p>`,
        cards: [
          { title: 'No Obligation', desc: 'A 15-minute call to understand your pipeline and share what we are seeing — no commitment required' },
          { title: 'Market Intelligence', desc: 'Real-time lender appetite, pricing benchmarks and comparable transactions across your target markets' },
          { title: 'Deal Origination', desc: 'We occasionally see off-market living sector opportunities from our network that may be relevant to your strategy' },
          { title: 'Long-Term Partnership', desc: 'Our best client relationships started with a single conversation — we are in this for the long run' },
        ],
        closingLine: 'Would you be open to a brief call this week or next? I am flexible on timing.',
        ctaText: 'Learn More About Our Living Sector Advisory →',
        ctaUrl: 'https://tp.finance/sectors/living',
      },
    ],
  },
];

// I'll continue with the remaining sectors using a factory function
// since they follow the same 6-email pattern

function makeClientSector(opts: {
  key: string; label: string; headerLabel: string; overlayLabel: string;
  sectorPageUrl: string; sectorDesc: string; sectorSpecialism: string;
  cards1: Array<{title:string;desc:string}>;
  cards2: Array<{title:string;desc:string}>;
  cards3: Array<{title:string;desc:string}>;
  cards4: Array<{title:string;desc:string}>;
  cards5: Array<{title:string;desc:string}>;
  devIntro: string; invIntro: string; refiIntro: string; marketIntro: string;
  devClose: string; invClose: string; refiClose: string; marketClose: string;
  subj1: string; subj2: string; subj3: string; subj4: string; subj5: string;
}): SectorDef {
  return {
    key: opts.key, label: opts.label, headerLabel: opts.headerLabel,
    overlayLabel: opts.overlayLabel, sectorPageUrl: opts.sectorPageUrl,
    emails: [
      {
        templateName: `Clients — ${opts.label} — 1. Sector Overview`,
        subject: opts.subj1,
        heroImage: `${opts.key}_01.jpg`,
        overlayLabel: opts.overlayLabel,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to reach out as we are actively advising on ${opts.sectorDesc} transactions and thought it would be worth connecting.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I run <strong>Turning Point Capital Advisory</strong>, a specialist debt advisory firm with ${opts.sectorSpecialism}.</p>`,
        cards: opts.cards1,
        closingLine: `Would you be open to a short call to discuss the current ${opts.label.toLowerCase()} lending market and where we might add value?`,
        ctaText: `Learn More About Our ${opts.label} Advisory →`,
        ctaUrl: opts.sectorPageUrl,
      },
      {
        templateName: `Clients — ${opts.label} — 2. Development Finance`,
        subject: opts.subj2,
        heroImage: `${opts.key}_02.jpg`,
        overlayLabel: `${opts.label} Development Finance`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">${opts.devIntro}</p>`,
        cards: opts.cards2,
        closingLine: opts.devClose,
        ctaText: `Learn More About Our ${opts.label} Advisory →`,
        ctaUrl: opts.sectorPageUrl,
      },
      {
        templateName: `Clients — ${opts.label} — 3. Investment & Acquisition`,
        subject: opts.subj3,
        heroImage: `${opts.key}_03.jpg`,
        overlayLabel: `${opts.label} Investment &amp; Acquisition Finance`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">${opts.invIntro}</p>`,
        cards: opts.cards3,
        closingLine: opts.invClose,
        ctaText: `Learn More About Our ${opts.label} Advisory →`,
        ctaUrl: opts.sectorPageUrl,
      },
      {
        templateName: `Clients — ${opts.label} — 4. Refinancing`,
        subject: opts.subj4,
        heroImage: `${opts.key}_04.jpg`,
        overlayLabel: `${opts.label} Refinancing &amp; Debt Optimisation`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">${opts.refiIntro}</p>`,
        cards: opts.cards4,
        closingLine: opts.refiClose,
        ctaText: `Learn More About Our ${opts.label} Advisory →`,
        ctaUrl: opts.sectorPageUrl,
      },
      {
        templateName: `Clients — ${opts.label} — 5. Market Insight`,
        subject: opts.subj5,
        heroImage: `${opts.key}_05.jpg`,
        overlayLabel: `${opts.label} Lending Market — Current Conditions`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">${opts.marketIntro}</p>`,
        cards: opts.cards5,
        closingLine: `Happy to share more detail on a call — it may be useful context for any ${opts.label.toLowerCase()} transactions you have in the pipeline. Are you free for 15 minutes?`,
        ctaText: `Learn More About Our ${opts.label} Advisory →`,
        ctaUrl: opts.sectorPageUrl,
      },
      {
        templateName: `Clients — ${opts.label} — 6. Partnership Call`,
        subject: `Quick catch-up — ${opts.label.toLowerCase()} finance pipeline`,
        heroImage: `${opts.key}_06.jpg`,
        overlayLabel: `Let\u2019s Connect — ${opts.label} Finance`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I have reached out a few times and appreciate you may be busy — just wanted to drop a final note in case the timing is better now.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">The ${opts.label.toLowerCase()} sector remains one of our most active areas and we would welcome the chance to connect. Even if nothing is imminent, understanding your pipeline helps us flag relevant opportunities as they arise.</p>`,
        cards: [
          { title: 'No Obligation', desc: 'A 15-minute call to understand your pipeline and share what we are seeing — no commitment required' },
          { title: 'Market Intelligence', desc: `Real-time lender appetite, pricing benchmarks and comparable transactions across the ${opts.label.toLowerCase()} market` },
          { title: 'Deal Origination', desc: `We occasionally see off-market ${opts.label.toLowerCase()} opportunities from our network that may be relevant to your strategy` },
          { title: 'Long-Term Partnership', desc: 'Our best client relationships started with a single conversation — we are in this for the long run' },
        ],
        closingLine: 'Would you be open to a brief call this week or next? I am flexible on timing.',
        ctaText: `Learn More About Our ${opts.label} Advisory →`,
        ctaUrl: opts.sectorPageUrl,
      },
    ],
  };
}

// Remaining client sectors
const REMAINING_CLIENT_SECTORS: SectorDef[] = [
  makeClientSector({
    key: 'office', label: 'Offices', headerLabel: 'Office Sector Finance',
    overlayLabel: 'Office &amp; Workspace Finance',
    sectorPageUrl: 'https://tp.finance/sectors/offices',
    sectorDesc: 'office and workspace',
    sectorSpecialism: 'deep experience in office sector finance — from prime city-centre assets through to suburban and flex-space schemes',
    subj1: 'Office sector debt advisory — UK & European workspace',
    subj2: 'Office development finance — new-build & refurbishment',
    subj3: 'Office investment debt — acquisition & portfolio finance',
    subj4: 'Office refinancing — optimising your workspace debt',
    subj5: 'Office lending market — what we are seeing right now',
    cards1: [
      { title: 'Development Finance', desc: 'Ground-up office development and major refurbishment schemes — CAT A through to fully fitted speculative builds' },
      { title: 'Investment &amp; Portfolio Debt', desc: 'Term debt for stabilised office assets and multi-asset portfolios — prime, core-plus and value-add strategies' },
      { title: 'Acquisition Finance', desc: 'Senior and whole loan structures for single-asset and portfolio office acquisitions across the UK and Europe' },
      { title: 'Repositioning &amp; Capex', desc: 'Financing major refurbishments, ESG upgrades and change-of-use conversions for ageing office stock' },
    ],
    cards2: [
      { title: 'Ground-Up Office', desc: 'Senior and stretched senior for speculative and pre-let office developments in supply-constrained markets' },
      { title: 'Major Refurbishment', desc: 'Capex-heavy financing for strip-out and refit schemes — upgrading tired stock to Grade A ESG-compliant workspace' },
      { title: 'Mixed-Use Schemes', desc: 'Office-led mixed-use developments combining workspace, retail, F&B and residential — complex capital stacks simplified' },
      { title: 'Flex &amp; Serviced Office', desc: 'Development and fit-out finance for serviced office and co-working schemes — a growing but specialist lending niche' },
    ],
    cards3: [
      { title: 'Prime Office Portfolios', desc: 'Financing multi-asset office portfolios across city centres — single facility, competitive margins for quality income' },
      { title: 'Value-Add Acquisitions', desc: 'Debt for under-rented or under-managed office assets where a repositioning business plan can unlock value' },
      { title: 'Sale &amp; Leaseback', desc: 'Financing corporate sale-and-leaseback transactions where the occupier is selling and leasing back the asset' },
      { title: 'Cross-Border Office', desc: 'Pan-European office mandates across multiple jurisdictions — navigating different lender appetites and structuring requirements' },
    ],
    cards4: [
      { title: 'Maturity Refinancing', desc: 'Replacing maturing facilities with longer-term debt — often at improved terms as leasing risk reduces' },
      { title: 'Green Refinancing', desc: 'Accessing sustainability-linked margins and green loan frameworks for offices with strong EPC and BREEAM ratings' },
      { title: 'Covenant Reset', desc: 'Renegotiating LTV and DSCR covenants where valuations have moved or leasing has improved since the original facility' },
      { title: 'Equity Release', desc: 'Refinancing at higher leverage once occupancy is proven — freeing capital for new acquisitions or capex programmes' },
    ],
    cards5: [
      { title: 'Flight to Quality', desc: 'Lenders are concentrating appetite on Grade A ESG-compliant offices — secondary stock is becoming harder to finance' },
      { title: 'Regional Office Revival', desc: 'Strong occupier demand in regional city centres is translating into renewed lender appetite outside London' },
      { title: 'Flex-Space Acceptance', desc: 'Mainstream lenders are becoming more comfortable with flex and serviced office income as part of the tenant mix' },
      { title: 'Refurb Over Demolition', desc: 'Sustainability requirements are driving a shift towards refurbishment — lenders are supporting capex-heavy repositioning plans' },
    ],
    devIntro: 'Office development finance is evolving rapidly as ESG requirements reshape the market. Whether you are building new Grade A space or undertaking a major refurbishment, we know which lenders have appetite and how to position the deal.',
    invIntro: 'Quality office assets with strong ESG credentials continue to attract competitive debt terms. Whether you are acquiring a single building or assembling a portfolio, we can access the best pricing in the market today.',
    refiIntro: 'With the office market bifurcating between prime and secondary, now is an important time to review existing debt arrangements. We are advising several sponsors on refinancings that are delivering improved terms for well-positioned assets.',
    marketIntro: 'I wanted to share some observations from the office lending market. The story is one of bifurcation — lenders are competing for Grade A ESG-compliant assets while pulling back from secondary stock.',
    devClose: 'If you have any office development or refurbishment schemes in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
    invClose: 'If you are looking at any office acquisitions, I would be happy to share current market pricing and lender appetite. Shall we arrange a quick call?',
    refiClose: 'If you have any office assets approaching maturity or where you would like to benchmark terms, we would be glad to help. Free for a quick chat?',
    marketClose: 'Happy to share more detail on a call — it may be useful context for any office transactions you have in the pipeline. Are you free for 15 minutes?',
  }),
  makeClientSector({
    key: 'retail', label: 'Retail', headerLabel: 'Retail Sector Finance',
    overlayLabel: 'Retail &amp; High Street Finance',
    sectorPageUrl: 'https://tp.finance/sectors/retail',
    sectorDesc: 'retail and high street property',
    sectorSpecialism: 'experience across the full retail spectrum — from prime high street and retail parks through to out-of-town and mixed-use schemes',
    subj1: 'Retail property debt advisory — UK & European',
    subj2: 'Retail development finance — parks, high street & mixed-use',
    subj3: 'Retail investment debt — acquisition & portfolio finance',
    subj4: 'Retail refinancing — repositioning existing debt',
    subj5: 'Retail lending market — what we are seeing right now',
    cards1: [
      { title: 'Retail Park Finance', desc: 'Debt for retail warehouse parks, trade counters and bulky goods retail — strong lender appetite for convenience-led formats' },
      { title: 'High Street &amp; Mixed-Use', desc: 'Financing prime high street assets and mixed-use schemes combining retail with residential, office or leisure' },
      { title: 'Grocery &amp; Convenience', desc: 'Long-income debt for supermarket and convenience retail — single-tenant and portfolio arrangements' },
      { title: 'Repositioning &amp; Capex', desc: 'Financing the transformation of underperforming retail assets — change of use, subdivision and tenant remixing' },
    ],
    cards2: [
      { title: 'Retail Park Development', desc: 'Senior debt for new retail park and trade park schemes — pre-let and speculative in supply-constrained locations' },
      { title: 'Mixed-Use Retail', desc: 'Development finance for retail-led mixed-use schemes — ground-floor retail with upper-floor residential or workspace' },
      { title: 'Change of Use', desc: 'Financing conversion of retail assets to alternative uses — residential, logistics or community — where the current use is no longer viable' },
      { title: 'Refurbishment &amp; Extension', desc: 'Capex facilities for upgrading existing retail assets — improving tenant mix, ESG credentials and rental tone' },
    ],
    cards3: [
      { title: 'Retail Portfolio Debt', desc: 'Financing multi-asset retail portfolios — single facility across retail parks, high street and convenience formats' },
      { title: 'Single-Asset Acquisition', desc: 'Senior debt for well-let retail assets with defensive income profiles — long WAULT, strong covenants' },
      { title: 'Grocery-Anchored', desc: 'Long-income financing for supermarket-anchored retail — attractive to institutional lenders seeking defensive yield' },
      { title: 'Value-Add Retail', desc: 'Debt for under-managed retail assets where active management, re-gearing and tenant remixing can unlock value' },
    ],
    cards4: [
      { title: 'Maturity Refinancing', desc: 'Replacing maturing facilities — demonstrating improved occupancy and rental performance to secure better terms' },
      { title: 'Portfolio Restructuring', desc: 'Consolidating multiple bilateral facilities into a single portfolio-level arrangement with improved terms' },
      { title: 'Debt-for-Equity Swap', desc: 'Advising on balance sheet restructuring where retail asset values have moved and equity cushion needs rebuilding' },
      { title: 'Green Retail Finance', desc: 'Accessing sustainability-linked margins for retail assets with strong energy performance and ESG upgrades planned' },
    ],
    cards5: [
      { title: 'Retail Parks in Demand', desc: 'Retail warehousing and trade parks are the strongest performing retail sub-sector — lenders are competing on terms' },
      { title: 'High Street Selectivity', desc: 'Lender appetite for high street retail remains cautious but is improving for prime pitches with defensive tenant mixes' },
      { title: 'Grocery Long-Income', desc: 'Supermarket and convenience retail continues to attract very competitive terms as a long-income defensive asset class' },
      { title: 'Mixed-Use Opportunity', desc: 'Retail-to-residential and retail-to-mixed-use conversion schemes are attracting development lender interest in secondary locations' },
    ],
    devIntro: 'Retail development finance is evolving as the sector adapts to changing consumer behaviour. From new retail parks to mixed-use conversions, we are advising on financing structures that reflect the modern retail landscape.',
    invIntro: 'Well-let retail assets with defensive income profiles are attracting competitive debt terms. Whether you are acquiring a grocery-anchored asset or a retail park portfolio, we know where the best financing sits.',
    refiIntro: 'With retail values stabilising and selective recovery underway, now is a good time to review existing debt. We are advising several sponsors on refinancings that are delivering improved terms for well-positioned retail assets.',
    marketIntro: 'I wanted to share some observations from the retail lending market. The picture is nuanced — some sub-sectors are attracting strong competition while others remain challenging.',
    devClose: 'If you have any retail development or conversion schemes in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
    invClose: 'If you are looking at any retail acquisitions, I would be happy to share current pricing and lender appetite. Shall we arrange a quick call?',
    refiClose: 'If you have any retail assets approaching maturity or where you would like to benchmark terms, we would be glad to help. Free for a quick chat?',
    marketClose: 'Happy to share more detail on a call — it may be useful context for any retail transactions you have in the pipeline. Are you free for 15 minutes?',
  }),
  makeClientSector({
    key: 'care', label: 'Care', headerLabel: 'Healthcare Finance',
    overlayLabel: 'Healthcare &amp; Care Sector Finance',
    sectorPageUrl: 'https://tp.finance/sectors/care',
    sectorDesc: 'healthcare and care sector',
    sectorSpecialism: 'deep experience across care home, supported living and healthcare facility finance',
    subj1: 'Healthcare debt advisory — care homes & supported living',
    subj2: 'Care sector development finance — new-build facilities',
    subj3: 'Care sector investment debt — acquisition & portfolio',
    subj4: 'Care sector refinancing — optimising your healthcare debt',
    subj5: 'Care sector lending — what we are seeing right now',
    cards1: [
      { title: 'Care Home Finance', desc: 'Debt for purpose-built care homes — development, acquisition and refinancing across the UK' },
      { title: 'Supported Living', desc: 'Financing supported living schemes with long-term local authority nominations — a growing and resilient asset class' },
      { title: 'Healthcare Facilities', desc: 'Debt for medical centres, clinics and specialist healthcare properties — often with NHS or long-lease income' },
      { title: 'Portfolio &amp; Platform', desc: 'Financing care home groups and platform acquisitions — portfolio-level debt with operational covenants understood' },
    ],
    cards2: [
      { title: 'Purpose-Built Care', desc: 'Senior debt for new-build care homes — 60 to 120+ bed facilities designed to modern CQC standards' },
      { title: 'Supported Living Development', desc: 'Financing development of supported living units with pre-agreed nomination arrangements from local authorities' },
      { title: 'Extension &amp; Upgrade', desc: 'Capex facilities for extending existing care homes or upgrading to meet modern regulatory requirements' },
      { title: 'Specialist Healthcare', desc: 'Development finance for specialist facilities — dementia care, mental health, rehabilitation and children\u2019s homes' },
    ],
    cards3: [
      { title: 'Care Home Portfolios', desc: 'Financing multi-site care home acquisitions — single facility with operational performance covenants' },
      { title: 'Supported Living Portfolios', desc: 'Debt for portfolios of supported living units — long-income profiles with local authority-backed nominations' },
      { title: 'Single-Asset Acquisition', desc: 'Senior debt for individual care homes with strong CQC ratings, occupancy and fee levels' },
      { title: 'Platform Buyouts', desc: 'Financing management buyouts and platform acquisitions of care home operating groups' },
    ],
    cards4: [
      { title: 'Maturity Refinancing', desc: 'Replacing maturing facilities with longer-term debt — demonstrating improved occupancy, CQC ratings and fee growth' },
      { title: 'Equity Release', desc: 'Refinancing at higher leverage as operational performance improves — freeing capital for expansion' },
      { title: 'Covenant Restructuring', desc: 'Renegotiating operational and financial covenants where the business has evolved since the original facility' },
      { title: 'Green Care Finance', desc: 'Accessing sustainability-linked terms for care facilities with strong energy performance and environmental plans' },
    ],
    cards5: [
      { title: 'Supported Living Growth', desc: 'Lender appetite for supported living is increasing significantly — long-income, local authority-backed income is highly attractive' },
      { title: 'Care Home Selectivity', desc: 'Lenders are focused on modern, purpose-built facilities with strong CQC ratings — older converted stock is harder to finance' },
      { title: 'Operational Due Diligence', desc: 'Lenders are placing greater emphasis on operator quality, staffing models and regulatory compliance in their underwriting' },
      { title: 'Fee Rate Inflation', desc: 'Rising fee rates are improving debt service coverage — creating opportunities to refinance at improved terms' },
    ],
    devIntro: 'Care sector development finance requires a lender who understands the regulatory environment and operational model. We specialise in finding capital for purpose-built care homes, supported living and specialist healthcare facilities.',
    invIntro: 'Well-run care home and supported living portfolios are attracting competitive debt terms. Whether you are acquiring a single facility or building a platform, we know where the best financing sits today.',
    refiIntro: 'With fee rates rising and occupancy recovering, care sector assets are in a stronger position to secure improved debt terms. We are advising several operators on refinancings that are delivering better pricing and covenants.',
    marketIntro: 'I wanted to share some observations from the care sector lending market. Appetite is growing but lenders are increasingly focused on operational quality and modern, purpose-built stock.',
    devClose: 'If you have any care sector developments in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
    invClose: 'If you are looking at any care sector acquisitions, I would be happy to share current pricing and lender appetite. Shall we arrange a quick call?',
    refiClose: 'If you have any care assets approaching maturity or where you would like to benchmark terms, we would be glad to help. Free for a quick chat?',
    marketClose: 'Happy to share more detail on a call — it may be useful context for any care sector transactions you have in the pipeline. Are you free for 15 minutes?',
  }),
  makeClientSector({
    key: 'btr', label: 'BTR', headerLabel: 'Build-to-Rent Finance',
    overlayLabel: 'Build-to-Rent &amp; Multifamily Finance',
    sectorPageUrl: 'https://tp.finance/sectors/btr',
    sectorDesc: 'build-to-rent and multifamily',
    sectorSpecialism: 'deep experience in BTR finance — from single-family rental through to large-scale multifamily and suburban BTR platforms',
    subj1: 'BTR debt advisory — multifamily & single-family rental',
    subj2: 'BTR development finance — ground-up rental schemes',
    subj3: 'BTR investment debt — portfolio & acquisition finance',
    subj4: 'BTR refinancing — optimising your rental portfolio debt',
    subj5: 'BTR lending market — what we are seeing right now',
    cards1: [
      { title: 'Multifamily Development', desc: 'Senior and mezzanine for large-scale urban BTR schemes — 200+ unit developments across UK cities' },
      { title: 'Single-Family Rental', desc: 'Financing suburban single-family rental portfolios and developments — an emerging institutional asset class' },
      { title: 'Portfolio Investment Debt', desc: 'Term facilities for stabilised BTR portfolios — competitive margins for proven occupancy and rental income' },
      { title: 'Platform Finance', desc: 'Revolving credit and warehouse facilities for BTR platforms assembling portfolios at scale' },
    ],
    cards2: [
      { title: 'Urban Multifamily', desc: 'Senior and stretched senior facilities for purpose-built rental apartment schemes in major UK and European cities' },
      { title: 'Suburban BTR', desc: 'Development finance for single-family and townhouse rental schemes — a newer format attracting growing lender interest' },
      { title: 'Mixed-Tenure Development', desc: 'Financing schemes combining BTR with affordable, shared ownership and private sale — complex capital stacks simplified' },
      { title: 'Forward-Fund Structures', desc: 'Debt alongside institutional forward-fund commitments — drawdown aligned with construction milestones' },
    ],
    cards3: [
      { title: 'Multifamily Portfolios', desc: 'Single-facility financing across multiple BTR assets — competitive margins for institutional-quality income streams' },
      { title: 'Single-Family Portfolios', desc: 'Debt for assembled single-family rental portfolios — housing estate scale with long-term rental income' },
      { title: 'Stabilised Acquisitions', desc: 'Senior debt for stabilised BTR assets with proven occupancy and rental track records — banks competing on terms' },
      { title: 'Platform Acquisitions', desc: 'Financing the acquisition of BTR operating platforms — combining asset debt with corporate facilities' },
    ],
    cards4: [
      { title: 'Development Exit', desc: 'Replacing construction facilities with longer-term investment debt as BTR schemes lease up and stabilise' },
      { title: 'Equity Release', desc: 'Refinancing at higher leverage once occupancy is proven — releasing capital for pipeline acquisitions and new developments' },
      { title: 'Portfolio Consolidation', desc: 'Merging multiple bilateral facilities into a single portfolio-level arrangement — simpler structure, better terms' },
      { title: 'Green BTR Finance', desc: 'Sustainability-linked margins for BTR assets with strong EPC ratings — new-build BTR is well-positioned for green finance' },
    ],
    cards5: [
      { title: 'Record Institutional Capital', desc: 'BTR is attracting more institutional capital than any other UK real estate sector — lending appetite is following suit' },
      { title: 'Suburban BTR Emerging', desc: 'Lenders are increasingly comfortable with single-family rental as an asset class — appetite is broadening rapidly' },
      { title: 'Margins Compressing', desc: 'Competition among lenders for stabilised BTR assets is driving margins to historic lows — best-in-class schemes are seeing very attractive terms' },
      { title: 'Regional Demand Growing', desc: 'BTR lending appetite is expanding well beyond London — Manchester, Birmingham, Leeds, Edinburgh and Bristol are all active markets' },
    ],
    devIntro: 'BTR development finance is one of the most active areas of UK real estate lending. Whether you are building urban multifamily or suburban single-family rental, we know which lenders have appetite and how to structure the deal.',
    invIntro: 'Stabilised BTR assets are commanding some of the most competitive debt terms in UK real estate. Whether you are acquiring a single scheme or building a portfolio, we can access the best pricing available.',
    refiIntro: 'With BTR rental growth outperforming most other sectors, now is an excellent time to review existing debt arrangements. We are advising several sponsors on refinancings that are delivering material improvements.',
    marketIntro: 'I wanted to share some observations from the BTR lending market. Build-to-rent continues to be one of the most favoured asset classes — record institutional capital is flowing into the sector.',
    devClose: 'If you have any BTR developments in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
    invClose: 'If you are looking at any BTR acquisitions, I would be happy to share current pricing and lender appetite. Shall we arrange a quick call?',
    refiClose: 'If you have any BTR assets approaching maturity or where you would like to benchmark terms, we would be glad to help. Free for a quick chat?',
    marketClose: 'Happy to share more detail on a call — it may be useful context for any BTR transactions you have in the pipeline. Are you free for 15 minutes?',
  }),
  makeClientSector({
    key: 'logistics', label: 'Logistics', headerLabel: 'Logistics Finance',
    overlayLabel: 'Logistics &amp; Industrial Finance',
    sectorPageUrl: 'https://tp.finance/sectors/logistics',
    sectorDesc: 'logistics and industrial property',
    sectorSpecialism: 'experience across the logistics spectrum — from last-mile urban logistics through to big-box distribution and cold storage facilities',
    subj1: 'Logistics debt advisory — industrial & distribution',
    subj2: 'Logistics development finance — warehousing & distribution',
    subj3: 'Logistics investment debt — portfolio & acquisition',
    subj4: 'Logistics refinancing — optimising your industrial debt',
    subj5: 'Logistics lending market — what we are seeing right now',
    cards1: [
      { title: 'Big-Box Distribution', desc: 'Debt for large-scale distribution warehouses and fulfilment centres — development, acquisition and refinancing' },
      { title: 'Urban Logistics', desc: 'Financing last-mile logistics and urban distribution centres — a high-demand, supply-constrained asset class' },
      { title: 'Multi-Let Industrial', desc: 'Portfolio and single-asset debt for multi-let industrial estates — strong reversionary potential and resilient income' },
      { title: 'Specialist &amp; Cold Storage', desc: 'Financing purpose-built cold storage, data centres and specialist logistics facilities with operator-specific requirements' },
    ],
    cards2: [
      { title: 'Speculative Logistics', desc: 'Senior debt for speculative big-box and mid-box logistics development in supply-constrained markets' },
      { title: 'Pre-Let Development', desc: 'Development finance for build-to-suit logistics — pre-let to strong covenants with long lease commitments' },
      { title: 'Urban Infill', desc: 'Financing urban logistics development on constrained sites — smaller units with strong last-mile demand' },
      { title: 'Cold Storage &amp; Specialist', desc: 'Development finance for temperature-controlled and specialist logistics facilities — higher capex, specialist lender appetite' },
    ],
    cards3: [
      { title: 'Logistics Portfolios', desc: 'Single-facility financing across multi-asset logistics portfolios — competitive margins for quality income' },
      { title: 'Single-Asset Acquisition', desc: 'Senior debt for stabilised logistics assets with long WAULT and strong tenant covenants' },
      { title: 'Sale &amp; Leaseback', desc: 'Financing corporate sale-and-leaseback transactions for logistics occupiers selling and leasing back their facilities' },
      { title: 'Cross-Border Logistics', desc: 'Pan-European logistics mandates across multiple jurisdictions — single-facility or bilateral structures' },
    ],
    cards4: [
      { title: 'Maturity Refinancing', desc: 'Replacing maturing facilities with longer-term debt — capturing rental growth and improved occupancy in refinancing terms' },
      { title: 'Equity Release', desc: 'Refinancing at higher leverage to release capital for portfolio expansion — logistics valuations have appreciated significantly' },
      { title: 'Green Logistics Finance', desc: 'Sustainability-linked margins for logistics assets with solar PV, EV charging and strong energy performance credentials' },
      { title: 'Portfolio Consolidation', desc: 'Merging bilateral facilities into a single portfolio-level arrangement — simpler structure, improved covenant package' },
    ],
    cards5: [
      { title: 'Lender Competition Intense', desc: 'Logistics remains the most sought-after UK CRE asset class among lenders — margins are at historic lows for quality assets' },
      { title: 'Urban Logistics Premium', desc: 'Last-mile urban logistics is commanding a significant pricing premium from lenders — reflecting supply constraints and rental growth' },
      { title: 'ESG Driving Appetite', desc: 'New-build logistics with strong sustainability credentials is attracting the most competitive terms — green loan frameworks are standard' },
      { title: 'Development Appetite Strong', desc: 'Pre-let and speculative logistics development is well-supported by lenders — particularly in supply-constrained geographies' },
    ],
    devIntro: 'Logistics development finance benefits from strong occupier demand and growing lender appetite. Whether you are building speculative, pre-let or specialist facilities, we know where the best financing terms are today.',
    invIntro: 'Logistics assets are commanding the most competitive debt terms in UK commercial real estate. Whether you are acquiring a single warehouse or assembling a portfolio, we can access the best pricing available.',
    refiIntro: 'With logistics values having appreciated significantly and rental growth continuing, now is an excellent time to review existing debt. We are advising sponsors on refinancings that are releasing significant equity.',
    marketIntro: 'I wanted to share some observations from the logistics lending market. The sector continues to attract more lender appetite than any other commercial real estate asset class.',
    devClose: 'If you have any logistics developments in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
    invClose: 'If you are looking at any logistics acquisitions, I would be happy to share current pricing. Shall we arrange a quick call?',
    refiClose: 'If you have any logistics assets approaching maturity or where you would like to benchmark terms, we would be glad to help. Free for a quick chat?',
    marketClose: 'Happy to share more detail on a call — it may be useful context for any logistics transactions you have in the pipeline. Are you free for 15 minutes?',
  }),
  makeClientSector({
    key: 'sfh', label: 'SFH', headerLabel: 'Single-Family Housing Finance',
    overlayLabel: 'Single-Family Housing &amp; Housebuilder Finance',
    sectorPageUrl: 'https://tp.finance/sectors/sfh',
    sectorDesc: 'single-family housing and housebuilder',
    sectorSpecialism: 'experience in housebuilder finance — from small-scale residential developments through to large estate-scale schemes and land acquisition',
    subj1: 'Housebuilder debt advisory — residential development',
    subj2: 'Residential development finance — houses & estates',
    subj3: 'SFH investment debt — portfolio & land bank finance',
    subj4: 'Housebuilder refinancing — optimising your development facilities',
    subj5: 'Housebuilder lending — what we are seeing right now',
    cards1: [
      { title: 'Residential Development', desc: 'Senior and stretched senior for private housebuilding — from 10-unit infill sites through to 500+ home estate schemes' },
      { title: 'Land Acquisition', desc: 'Financing land purchases and options — bridging through planning to development-ready status' },
      { title: 'Mixed-Tenure Schemes', desc: 'Debt for developments combining private sale, affordable, shared ownership and rental — complex structures simplified' },
      { title: 'Modular &amp; MMC', desc: 'Financing modern methods of construction — factory-built housing, modular homes and off-site manufacturing' },
    ],
    cards2: [
      { title: 'Small-Scale Residential', desc: 'Senior debt for 5 to 50 unit residential schemes — often on constrained sites with bespoke planning profiles' },
      { title: 'Estate-Scale Development', desc: 'Financing large-scale housebuilding programmes — phased drawdown aligned with build and sales programmes' },
      { title: 'Land &amp; Planning', desc: 'Bridge facilities for land acquisition and planning promotion — converting raw land to development-ready sites' },
      { title: 'Affordable Housing', desc: 'Development finance for affordable and social housing — working with housing associations and local authorities' },
    ],
    cards3: [
      { title: 'Land Bank Finance', desc: 'Revolving credit and term facilities for housebuilders with established land banks — working capital against consented sites' },
      { title: 'Build-to-Rent Crossover', desc: 'Financing housebuilders selling into the BTR market — forward-fund and bulk sale structures' },
      { title: 'Part-Exchange Facilities', desc: 'Working capital facilities to support housebuilder part-exchange programmes — bridging until the existing home sells' },
      { title: 'Strategic Land', desc: 'Longer-term financing for strategic land positions — options and promotion agreements through to planning consent' },
    ],
    cards4: [
      { title: 'Facility Renewal', desc: 'Renewing and upsizing existing development facilities as the business grows — demonstrating track record to access better terms' },
      { title: 'Portfolio Restructuring', desc: 'Consolidating multiple site-specific facilities into a single revolving development facility — more efficient, lower cost' },
      { title: 'Covenant Optimisation', desc: 'Renegotiating financial covenants and security requirements as the business matures and builds credit history' },
      { title: 'Growth Capital', desc: 'Securing additional debt capacity to support expansion — larger facilities, higher site limits, more flexible drawdown' },
    ],
    cards5: [
      { title: 'SME Housebuilder Support', desc: 'Government policy is driving lender appetite for SME housebuilder lending — several new entrants have launched dedicated programmes' },
      { title: 'Planning Risk Pricing', desc: 'Lenders are becoming more sophisticated in pricing planning risk — consented sites command significant margin advantages' },
      { title: 'Modular Gaining Traction', desc: 'Mainstream lenders are starting to finance modular and MMC schemes — previously the preserve of specialist funds' },
      { title: 'Affordable Premium', desc: 'Schemes with affordable housing components are attracting improved terms — reflecting the income certainty of RP purchasers' },
    ],
    devIntro: 'Residential development finance is the core of what housebuilders need to grow. Whether you are building 10 homes or 500, we know which lenders have appetite for your type of scheme and how to structure the deal.',
    invIntro: 'As the SFH market evolves, so does the financing landscape. From land bank facilities to build-to-rent crossover structures, we are seeing new opportunities for housebuilders to optimise their capital structure.',
    refiIntro: 'If your development facilities are approaching renewal, now is a good time to benchmark terms. We are helping several housebuilders secure improved facilities that reflect their growing track records.',
    marketIntro: 'I wanted to share some observations from the housebuilder lending market. Appetite is constructive — particularly for experienced developers with consented land in supply-constrained areas.',
    devClose: 'If you have any residential development schemes in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
    invClose: 'If you are looking at land acquisitions or portfolio financing, I would be happy to share what is available. Shall we arrange a quick call?',
    refiClose: 'If your development facilities are coming up for renewal, we would be glad to benchmark terms. Free for a quick chat?',
    marketClose: 'Happy to share more detail on a call — it may be useful context for your development pipeline. Are you free for 15 minutes?',
  }),
  makeClientSector({
    key: 'leisure', label: 'Leisure', headerLabel: 'Leisure Sector Finance',
    overlayLabel: 'Leisure &amp; Entertainment Finance',
    sectorPageUrl: 'https://tp.finance/sectors/leisure',
    sectorDesc: 'leisure and entertainment property',
    sectorSpecialism: 'experience across leisure sector finance — from cinemas and gyms through to holiday parks, theme parks and experiential venues',
    subj1: 'Leisure sector debt advisory — UK & European',
    subj2: 'Leisure development finance — new venues & parks',
    subj3: 'Leisure investment debt — acquisition & portfolio',
    subj4: 'Leisure refinancing — optimising your venue debt',
    subj5: 'Leisure lending market — what we are seeing right now',
    cards1: [
      { title: 'Holiday Parks &amp; Resorts', desc: 'Debt for holiday park acquisitions, expansions and refinancings — one of the strongest performing leisure sub-sectors' },
      { title: 'Cinemas &amp; Entertainment', desc: 'Financing cinema complexes, bowling, climbing and experiential leisure venues — operational income understood' },
      { title: 'Gyms &amp; Wellness', desc: 'Debt for gym and wellness facility portfolios — both budget and premium formats with long lease income' },
      { title: 'Experiential &amp; F&amp;B', desc: 'Financing experiential dining, competitive socialising and mixed leisure formats — a growing but specialist niche' },
    ],
    cards2: [
      { title: 'Holiday Park Expansion', desc: 'Development finance for new lodges, pods and glamping units — strong ROI and short payback periods' },
      { title: 'Leisure Centre Development', desc: 'Senior debt for new leisure complexes — multi-operator schemes with cinema, gym, F&B and entertainment anchors' },
      { title: 'Venue Fit-Out', desc: 'Capex facilities for fit-out and refurbishment of leisure venues — upgrading the offer to drive footfall and spend' },
      { title: 'Mixed-Use Leisure', desc: 'Development finance for leisure-led mixed-use schemes — combining entertainment with retail, residential and workspace' },
    ],
    cards3: [
      { title: 'Holiday Park Portfolios', desc: 'Portfolio debt for multi-site holiday park operators — strong cash generation and defensive income in uncertain markets' },
      { title: 'Leisure Portfolio Debt', desc: 'Single-facility financing across cinema, gym and entertainment portfolios — operational covenants understood' },
      { title: 'Single-Asset Acquisition', desc: 'Senior debt for stabilised leisure assets with proven trading history and long operator leases' },
      { title: 'Operator Buyouts', desc: 'Financing management buyouts and platform acquisitions of leisure operating businesses' },
    ],
    cards4: [
      { title: 'Maturity Refinancing', desc: 'Replacing maturing facilities — demonstrating post-pandemic trading recovery to secure improved terms' },
      { title: 'Expansion Capital', desc: 'Refinancing to release equity for expansion — funding new site acquisitions and development within the existing portfolio' },
      { title: 'Covenant Reset', desc: 'Renegotiating covenants set during the pandemic period — many leisure operators have significantly outperformed those assumptions' },
      { title: 'Sale &amp; Leaseback', desc: 'Advising on property sale-and-leaseback to fund operator business growth while retaining operational control' },
    ],
    cards5: [
      { title: 'Holiday Parks Dominant', desc: 'Holiday parks remain the strongest performing leisure sub-sector — lenders are actively competing for quality operators' },
      { title: 'Experiential Leisure Growing', desc: 'Competitive socialising and experiential venues are attracting growing lender interest as trading data builds' },
      { title: 'Gym Market Stabilised', desc: 'Budget and premium gym operators have recovered strongly — lenders are re-engaging after pandemic caution' },
      { title: 'Operational Focus', desc: 'Lenders are placing greater emphasis on operator quality and management track record than pure property fundamentals' },
    ],
    devIntro: 'Leisure development finance requires a lender who understands operational income and the specific dynamics of each sub-sector. Whether you are expanding a holiday park or building a new entertainment complex, we can find the right capital.',
    invIntro: 'Well-operated leisure assets with proven trading histories are attracting competitive debt terms. Whether you are acquiring a holiday park or a leisure portfolio, we know where the best financing sits today.',
    refiIntro: 'Leisure operators have recovered strongly and many are now in a position to secure significantly improved debt terms. We are advising several operators on refinancings that reflect their current trading performance.',
    marketIntro: 'I wanted to share some observations from the leisure lending market. The sector has recovered strongly from the pandemic and lender appetite is returning — particularly for operators with strong trading data.',
    devClose: 'If you have any leisure development or expansion projects in the pipeline, I would welcome the chance to discuss financing options. Free for a 15-minute call?',
    invClose: 'If you are looking at any leisure acquisitions, I would be happy to share current pricing and lender appetite. Shall we arrange a quick call?',
    refiClose: 'If you have any leisure assets where you would like to benchmark terms, we would be glad to help. Free for a quick chat?',
    marketClose: 'Happy to share more detail on a call — it may be useful context for any leisure transactions you have in the pipeline. Are you free for 15 minutes?',
  }),
];

const ALL_CLIENT_SECTORS = [...CLIENT_SECTORS, ...REMAINING_CLIENT_SECTORS];

// ─── Introducer definitions ──────────────────────────────────────────────────

interface IntroducerDef {
  key: string;        // filesystem key
  label: string;      // display name
  specialism: string; // their field
  headerLabel: string;
  sectorPageUrl: string;
  emailAngles: Array<{
    templateName: string;
    subject: string;
    heroImage: string;
    overlayLabel: string;
    bodyIntro: string;
    cards: Array<{ title: string; desc: string }>;
    closingLine: string;
  }>;
}

function makeIntroducer(opts: {
  key: string; label: string; specialism: string;
  clientDesc: string;   // "your legal clients", "your surveying clients"
  firmDesc: string;     // "law firms", "surveying practices"
  dealDesc: string;     // what kind of deals they refer
}): IntroducerDef {
  return {
    key: opts.key,
    label: opts.label,
    specialism: opts.specialism,
    headerLabel: `Referral Partnership — ${opts.label}`,
    sectorPageUrl: 'https://tp.finance/introducers',
    emailAngles: [
      {
        templateName: `Introducers — ${opts.label} — 1. Partnership Intro`,
        subject: `Referral partnership — debt advisory for ${opts.clientDesc}`,
        heroImage: `${opts.key}_01.jpg`,
        overlayLabel: `Referral Partnership — ${opts.label} Sector`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to reach out as we work closely with ${opts.firmDesc} who introduce their clients to us for commercial real estate debt advisory — and I thought it would be worth connecting.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I run <strong>Turning Point Capital Advisory</strong>, a specialist debt advisory firm. We arrange debt finance for commercial property transactions across the UK and Europe — and we pay generous introducer fees to our referral partners.</p>`,
        cards: [
          { title: 'Up to 50% Fee Split', desc: `We share up to 50% of our advisory fee with introducer partners on the first transaction — one of the most competitive splits in the market` },
          { title: 'No Cost to Your Client', desc: 'Our fee is spread over 12 months — your client gets the same loan on day one as going direct, with full advisory value' },
          { title: 'You Stay in Control', desc: `We work alongside you and your client — you maintain your relationship, we handle the debt advisory and lender process` },
          { title: 'Pan-European Reach', desc: 'We advise on transactions across the UK, Germany, France, Spain, Benelux and Nordics — wherever your clients operate' },
        ],
        closingLine: `Would you be open to a short call to discuss how a referral partnership might work between us? Many of our best relationships are with ${opts.firmDesc} like yours.`,
      },
      {
        templateName: `Introducers — ${opts.label} — 2. Deal Types`,
        subject: `What kind of deals ${opts.clientDesc} bring us`,
        heroImage: `${opts.key}_02.jpg`,
        overlayLabel: `Deal Types — ${opts.label} Referrals`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to give you a clearer picture of the types of transactions ${opts.clientDesc} typically introduce to us. In short — any commercial property deal that needs debt finance is something we can help with.</p>`,
        cards: [
          { title: 'Development Finance', desc: `${opts.clientDesc} often need construction finance for ground-up projects — hotels, residential, offices, logistics and more` },
          { title: 'Acquisition Finance', desc: 'Clients acquiring commercial property need senior or whole loan facilities — we source the best terms across our lender panel' },
          { title: 'Refinancing', desc: 'Clients with maturing debt or who want to release equity — we benchmark the market and secure improved terms' },
          { title: 'Structured &amp; Complex', desc: 'Multi-jurisdictional, JV structures, mezzanine layers — the more complex the deal, the more value we add' },
        ],
        closingLine: `Even if your clients are not looking at debt finance right now, understanding their pipeline helps us flag relevant opportunities. Would you be free for a 15-minute call?`,
      },
      {
        templateName: `Introducers — ${opts.label} — 3. Fee Structure`,
        subject: `How the referral fee works — up to 50% of our advisory fee`,
        heroImage: `${opts.key}_03.jpg`,
        overlayLabel: `Introducer Fee Structure — How It Works`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to be transparent about how our introducer fee structure works. We believe in rewarding the professionals who trust us with their client relationships — and our fee splits reflect that.</p>`,
        cards: [
          { title: 'Up to 50% on First Deal', desc: 'We pay up to 50% of our advisory fee on the first transaction you introduce — paid on completion of the financing' },
          { title: '25% on Subsequent Deals', desc: 'For ongoing introductions from the same referral partner, we pay 25% — building a long-term revenue stream for you' },
          { title: 'Paid on Completion', desc: 'Our fee is contingent on completing the financing — no upfront costs, no risk. When we get paid, you get paid' },
          { title: 'Fully Documented', desc: 'We provide a simple introducer agreement — clear terms, transparent fee calculations, no surprises' },
        ],
        closingLine: 'Happy to walk through the numbers on a specific scenario if you have a client transaction in mind. Shall we arrange a quick call?',
      },
      {
        templateName: `Introducers — ${opts.label} — 4. Market Activity`,
        subject: `What we are seeing from introducer referrals right now`,
        heroImage: `${opts.key}_04.jpg`,
        overlayLabel: `Market Activity — Introducer Referrals`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to share some examples of the type of work coming through from our introducer network. The breadth of referrals we receive shows how widely debt advisory can add value to your client relationships.</p>`,
        cards: [
          { title: 'Hotel Acquisition — £12m', desc: 'Introduced by a law firm acting for the buyer — we arranged senior debt and mezzanine in 6 weeks, closing alongside the legal completion' },
          { title: 'Office Refurb — £8m', desc: 'Introduced by an accountant advising on the business plan — we secured stretched senior to fund both acquisition and capex' },
          { title: 'Residential Portfolio — £25m', desc: 'Introduced by a wealth manager on behalf of a family office — portfolio-level facility across 15 assets' },
          { title: 'Care Home Development — £15m', desc: 'Introduced by a surveyor conducting the initial appraisal — we arranged development finance from a specialist healthcare lender' },
        ],
        closingLine: `These are real examples from our introducer partnerships. If any of your clients have similar situations, we would be glad to help. Free for a quick call?`,
      },
      {
        templateName: `Introducers — ${opts.label} — 5. How a Deal Works`,
        subject: `How a referred deal works — from intro to completion`,
        heroImage: `${opts.key}_05.jpg`,
        overlayLabel: `The Referral Process — Start to Finish`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I wanted to walk you through how a typical introduced deal works from start to finish. Our process is designed to be straightforward for you and seamless for your client.</p>`,
        cards: [
          { title: '1. Introduction', desc: 'You introduce your client to us — a simple email or phone call. We take it from there and keep you informed throughout' },
          { title: '2. Assessment', desc: 'We meet your client, understand the deal, and provide an honest assessment of what is achievable — including indicative terms' },
          { title: '3. Execution', desc: 'We approach our lender panel, negotiate terms, manage the process and coordinate with your client\u2019s other advisors' },
          { title: '4. Completion &amp; Fee', desc: 'On completion of the financing, we invoice our fee and pay your introducer share — typically within 14 days' },
        ],
        closingLine: 'The process is designed to enhance your client relationship, not complicate it. Would you be open to a quick call to discuss a potential introduction?',
      },
      {
        templateName: `Introducers — ${opts.label} — 6. Let's Connect`,
        subject: `Quick catch-up — referral partnership`,
        heroImage: `${opts.key}_06.jpg`,
        overlayLabel: `Let\u2019s Connect — Referral Partnership`,
        bodyIntro: `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">I have reached out a few times and appreciate you may be busy — just wanted to drop a final note in case the timing is better now.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">We are continuing to build our introducer network and would welcome ${opts.firmDesc} like yours as referral partners. Even a brief conversation would help us understand whether there is a fit.</p>`,
        cards: [
          { title: 'No Obligation', desc: 'A 15-minute call to explore whether a referral partnership makes sense — no commitment, no pressure' },
          { title: 'Revenue Opportunity', desc: `Up to 50% fee split on the first deal — a meaningful revenue stream for ${opts.firmDesc} with property-active clients` },
          { title: 'Enhanced Client Service', desc: 'Offering your clients access to specialist debt advisory adds value to your existing relationship' },
          { title: 'Long-Term Partnership', desc: 'Our best introducer relationships generate multiple referrals per year — we invest in the partnership' },
        ],
        closingLine: 'Would you be open to a brief call this week or next? I am flexible on timing.',
      },
    ],
  };
}

const INTRODUCER_SPECIALISMS: IntroducerDef[] = [
  makeIntroducer({ key: 'accountant', label: 'Accountant', specialism: 'Accountancy', clientDesc: 'your accounting clients', firmDesc: 'accountancy firms', dealDesc: 'property transactions requiring debt finance' }),
  makeIntroducer({ key: 'lawyer', label: 'Lawyer', specialism: 'Legal', clientDesc: 'your legal clients', firmDesc: 'law firms', dealDesc: 'property transactions they are acting on' }),
  makeIntroducer({ key: 'surveyor', label: 'Surveyor', specialism: 'Surveying', clientDesc: 'your surveying clients', firmDesc: 'surveying practices', dealDesc: 'property transactions they are advising on' }),
  makeIntroducer({ key: 'agent', label: 'Agent', specialism: 'Property Agency', clientDesc: 'your agency clients', firmDesc: 'property agencies', dealDesc: 'acquisition and disposal transactions' }),
  makeIntroducer({ key: 'advisory', label: 'Advisory', specialism: 'Advisory', clientDesc: 'your advisory clients', firmDesc: 'advisory firms', dealDesc: 'corporate and property transactions' }),
  makeIntroducer({ key: 'wealth', label: 'Wealth', specialism: 'Wealth Management', clientDesc: 'your wealth management clients', firmDesc: 'wealth managers', dealDesc: 'property investment transactions for HNW and family office clients' }),
  makeIntroducer({ key: 'construction', label: 'Construction', specialism: 'Construction', clientDesc: 'your construction clients', firmDesc: 'construction firms', dealDesc: 'development projects requiring finance' }),
  makeIntroducer({ key: 'planning_architect', label: 'Planning / Architect', specialism: 'Planning & Architecture', clientDesc: 'your planning and architecture clients', firmDesc: 'planning and architecture practices', dealDesc: 'development projects moving from design into construction finance' }),
];

// ─── HTML template builder ───────────────────────────────────────────────────

function buildEmailHtml(opts: {
  headerLabel: string;
  heroImageBase64: string;
  heroAlt: string;
  overlayLabel: string;
  bodyIntro: string;
  cards: Array<{ title: string; desc: string }>;
  closingLine: string;
  ctaText: string;
  ctaUrl: string;
  sectorPageUrl: string;
  sectorPageLabel: string;
}): string {
  const cardRows: string[] = [];
  for (let i = 0; i < opts.cards.length; i += 2) {
    const left = opts.cards[i];
    const right = opts.cards[i + 1];
    let row = '<tr>';
    row += `<td style="padding:0 6px ${i < opts.cards.length - 2 ? '12px' : '0'} 0;vertical-align:top;width:50%;"><table width="100%"><tr><td style="background:#f0fdfb;border-left:4px solid #0D9488;border-radius:0 8px 8px 0;padding:14px 16px;"><p style="margin:0 0 5px;font-weight:700;color:#0A131E;font-size:13px;">${left.title}</p><p style="margin:0;font-size:12px;color:#3d5166;line-height:1.7;">${left.desc}</p></td></tr></table></td>`;
    if (right) {
      row += `<td style="padding:0 0 ${i < opts.cards.length - 2 ? '12px' : '0'} 6px;vertical-align:top;width:50%;"><table width="100%"><tr><td style="background:#f0fdfb;border-left:4px solid #0D9488;border-radius:0 8px 8px 0;padding:14px 16px;"><p style="margin:0 0 5px;font-weight:700;color:#0A131E;font-size:13px;">${right.title}</p><p style="margin:0;font-size:12px;color:#3d5166;line-height:1.7;">${right.desc}</p></td></tr></table></td>`;
    }
    row += '</tr>';
    cardRows.push(row);
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f2f5;">
<tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
<tr><td style="background-color:#0A131E;padding:22px 36px;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><span style="font-weight:700;font-size:20px;color:#74DFF6;letter-spacing:-0.5px;">TP</span><span style="font-weight:500;font-size:13px;color:#ffffff;margin-left:8px;opacity:0.85;">Turning Point Capital</span></td><td align="right"><span style="font-size:11px;color:rgba(255,255,255,0.45);letter-spacing:1px;text-transform:uppercase;">${opts.headerLabel}</span></td></tr></table></td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#0D9488 0%,#74DFF6 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:0;"><img src="${opts.heroImageBase64}" width="600" alt="${opts.heroAlt}" style="display:block;width:100%;max-width:600px;height:220px;object-fit:cover;border:none;" /></td></tr>
<tr><td style="background:#0A131E;padding:10px 36px;"><span style="font-size:11px;color:#0D9488;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${opts.overlayLabel}</span></td></tr>
<tr><td style="background:#f8f9fb;border-bottom:1px solid #eaecef;padding:20px 36px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="text-align:center;width:33%;border-right:1px solid #dde1e7;padding-right:12px;"><p style="margin:0;font-size:22px;font-weight:700;color:#0D9488;">&pound;1.5bn+</p><p style="margin:4px 0 0;font-size:11px;color:#6b7e8f;text-transform:uppercase;letter-spacing:0.5px;">Transactions Advised</p></td>
    <td style="text-align:center;width:33%;border-right:1px solid #dde1e7;padding:0 12px;"><p style="margin:0;font-size:22px;font-weight:700;color:#0D9488;">6 Years</p><p style="margin:4px 0 0;font-size:11px;color:#6b7e8f;text-transform:uppercase;letter-spacing:0.5px;">Established</p></td>
    <td style="text-align:center;width:33%;padding-left:12px;"><p style="margin:0;font-size:22px;font-weight:700;color:#0D9488;">~10 Deals</p><p style="margin:4px 0 0;font-size:11px;color:#6b7e8f;text-transform:uppercase;letter-spacing:0.5px;">Completed Per Year</p></td>
  </tr></table>
</td></tr>
<tr><td style="padding:32px 36px 8px 36px;">
  <p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#1a2332;">Hey {{first_name}},</p>
  ${opts.bodyIntro}
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 24px;">
    ${cardRows.join('\n    ')}
  </table>
</td></tr>
<tr><td style="padding:0 36px 32px 36px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0A131E;border-radius:10px;overflow:hidden;">
    <tr><td style="padding:20px 24px 8px 24px;"><p style="margin:0;font-size:13px;font-weight:700;color:#74DFF6;letter-spacing:1px;text-transform:uppercase;">Benefits of working with a boutique advisory firm</p></td></tr>
    <tr><td style="padding:12px 24px;"><table width="100%"><tr><td style="vertical-align:top;width:28px;"><div style="width:20px;height:20px;background:#0D9488;border-radius:50%;text-align:center;line-height:20px;"><span style="font-size:11px;font-weight:700;color:#fff;">1</span></div></td><td style="padding-left:12px;vertical-align:top;"><p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#fff;">Up to 50% introducer fee on your first deal</p><p style="margin:0;font-size:12px;color:rgba(255,255,255,0.6);line-height:1.7;">We heavily incentivise referral partners — up to 50% of our advisory fee on the first transaction, one of the most competitive splits in the market.</p></td></tr></table></td></tr>
    <tr><td style="padding:0 24px;"><div style="height:1px;background:rgba(255,255,255,0.08);"></div></td></tr>
    <tr><td style="padding:12px 24px 20px 24px;"><table width="100%"><tr><td style="vertical-align:top;width:28px;"><div style="width:20px;height:20px;background:#0D9488;border-radius:50%;text-align:center;line-height:20px;"><span style="font-size:11px;font-weight:700;color:#fff;">2</span></div></td><td style="padding-left:12px;vertical-align:top;"><p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#fff;">Same day-one loan as going direct — no extra cost</p><p style="margin:0;font-size:12px;color:rgba(255,255,255,0.6);line-height:1.7;">Our advisory fee can be spread over 12 months — the borrower gets the same loan on day one as going direct, with full advisory value at no upfront premium.</p></td></tr></table></td></tr>
  </table>
  <p style="margin:24px 0 28px;font-size:15px;color:#1a2332;line-height:1.75;">${opts.closingLine}</p>
  <table cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:6px;background:#0D9488;"><a href="${opts.ctaUrl}" style="display:inline-block;padding:12px 28px;font-size:13px;font-weight:700;color:#fff;text-decoration:none;letter-spacing:0.3px;">${opts.ctaText}</a></td></tr></table>
</td></tr>
<tr><td style="padding:0 36px;"><table width="100%"><tr><td style="height:1px;background:rgba(10,19,30,0.08);font-size:0;">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:24px 36px 32px 36px;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:16px;border-right:3px solid #0D9488;vertical-align:top;"><p style="margin:0;font-size:14px;font-weight:700;color:#0A131E;">Marcus Emadi</p><p style="margin:4px 0 0;font-size:12px;color:#0D9488;font-weight:600;">Managing Director</p><p style="margin:2px 0 0;font-size:12px;color:#5a6e84;">Turning Point Capital Advisory</p></td><td style="padding-left:16px;vertical-align:top;"><p style="margin:0;font-size:12px;color:#5a6e84;line-height:1.8;"><a href="mailto:marcus@tp.finance" style="color:#0D9488;text-decoration:none;">marcus@tp.finance</a><br/><a href="https://tp.finance" style="color:#0D9488;text-decoration:none;">tp.finance</a><br/><a href="${opts.sectorPageUrl}" style="color:#5a6e84;text-decoration:none;">${opts.sectorPageLabel}</a></p></td></tr></table></td></tr>
<tr><td style="background:#f8f9fb;border-top:1px solid #eaecef;padding:16px 36px;text-align:center;"><p style="margin:0;font-size:11px;color:#737f8c;line-height:1.6;">Turning Point Capital Advisory Ltd &nbsp;&middot;&nbsp; London<br/><a href="{{unsubscribe_url}}" style="color:#737f8c;text-decoration:underline;">Unsubscribe</a></p></td></tr>
</table></td></tr></table>
</body></html>`;
}

// ─── Main execution ──────────────────────────────────────────────────────────

async function main() {
  console.log('Generating sequences and templates for TP outreach...\n');

  let templatesCreated = 0;
  let sequencesCreated = 0;

  // ── Client sequences ──────────────────────────────────────────────────
  for (const sector of ALL_CLIENT_SECTORS) {
    console.log(`Creating client sequence: ${sector.label}...`);

    // Create sequence
    const seqResult = await pool.query(
      `INSERT INTO sequences (name, description, status, type, send_window_start, send_window_end, skip_weekends, stop_on_reply, tenant)
       VALUES ($1, $2, 'draft', 'drip', '09:00', '17:00', true, true, $3)
       RETURNING id`,
      [`Clients — ${sector.label}`, `6-email monthly sequence for ${sector.label} sector clients`, TENANT]
    );
    const sequenceId = seqResult.rows[0].id;
    sequencesCreated++;

    for (let i = 0; i < sector.emails.length; i++) {
      const email = sector.emails[i];
      const heroB64 = heroBase64(email.heroImage);

      const html = buildEmailHtml({
        headerLabel: sector.headerLabel,
        heroImageBase64: heroB64,
        heroAlt: `${sector.label} Finance`,
        overlayLabel: email.overlayLabel,
        bodyIntro: email.bodyIntro,
        cards: email.cards,
        closingLine: email.closingLine,
        ctaText: email.ctaText,
        ctaUrl: email.ctaUrl,
        sectorPageUrl: sector.sectorPageUrl,
        sectorPageLabel: `${sector.label} Sector Page`,
      });

      // Create template (include linkedin_content if present)
      const tplResult = await pool.query(
        `INSERT INTO templates (name, subject, body_html, body_text, merge_fields, linkedin_content, tenant)
         VALUES ($1, $2, $3, '', $4, $5, $6)
         RETURNING id`,
        [email.templateName, email.subject, html, ['first_name', 'company', 'sector'], email.linkedin || null, TENANT]
      );
      const templateId = tplResult.rows[0].id;
      templatesCreated++;

      // Create sequence step (30-day delay between emails, 0 for first)
      await pool.query(
        `INSERT INTO sequence_steps (sequence_id, step_number, template_id, delay_days, delay_hours)
         VALUES ($1, $2, $3, $4, 0)`,
        [sequenceId, i + 1, templateId, i === 0 ? 0 : 30]
      );
    }
  }

  // ── Introducer sequences ──────────────────────────────────────────────
  for (const intro of INTRODUCER_SPECIALISMS) {
    console.log(`Creating introducer sequence: ${intro.label}...`);

    const seqResult = await pool.query(
      `INSERT INTO sequences (name, description, status, type, send_window_start, send_window_end, skip_weekends, stop_on_reply, tenant)
       VALUES ($1, $2, 'draft', 'drip', '09:00', '17:00', true, true, $3)
       RETURNING id`,
      [`Introducers — ${intro.label}`, `6-email monthly sequence for ${intro.label} introducer partners`, TENANT]
    );
    const sequenceId = seqResult.rows[0].id;
    sequencesCreated++;

    for (let i = 0; i < intro.emailAngles.length; i++) {
      const angle = intro.emailAngles[i];
      const heroB64 = heroBase64(angle.heroImage);

      const html = buildEmailHtml({
        headerLabel: intro.headerLabel,
        heroImageBase64: heroB64,
        heroAlt: `${intro.label} Referral Partnership`,
        overlayLabel: angle.overlayLabel,
        bodyIntro: angle.bodyIntro,
        cards: angle.cards,
        closingLine: angle.closingLine,
        ctaText: 'Learn More About Our Introducer Programme →',
        ctaUrl: intro.sectorPageUrl,
        sectorPageUrl: intro.sectorPageUrl,
        sectorPageLabel: 'Introducer Programme',
      });

      const tplResult = await pool.query(
        `INSERT INTO templates (name, subject, body_html, body_text, merge_fields, tenant)
         VALUES ($1, $2, $3, '', $4, $5)
         RETURNING id`,
        [angle.templateName, angle.subject, html, ['first_name', 'company'], TENANT]
      );
      const templateId = tplResult.rows[0].id;
      templatesCreated++;

      await pool.query(
        `INSERT INTO sequence_steps (sequence_id, step_number, template_id, delay_days, delay_hours)
         VALUES ($1, $2, $3, $4, 0)`,
        [sequenceId, i + 1, templateId, i === 0 ? 0 : 30]
      );
    }
  }

  console.log(`\nDone! Created ${sequencesCreated} sequences and ${templatesCreated} templates.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
