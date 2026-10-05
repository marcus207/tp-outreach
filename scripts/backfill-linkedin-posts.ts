/**
 * Backfill LinkedIn post content + poster HTML for all client subsector templates.
 *
 * Run:  npx tsx scripts/backfill-linkedin-posts.ts
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TENANT = 'tp';
const HERO_DIR = path.join(__dirname, '../data/hero');

function heroBase64(filename: string): string {
  const filePath = path.join(HERO_DIR, filename);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filename).slice(1) || 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
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

// ─── LinkedIn post + poster data per template ────────────────────────────────

interface LinkedInData {
  templateName: string;
  heroImage: string;
  linkedin: string;
  posterHeadline: string;
  posterSubline: string;
  cardTitles: [string, string, string, string];
  posterTheme: string;
}

const ALL_LINKEDIN_DATA: LinkedInData[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // HOSPITALITY (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — Hospitality — 1. Sector Overview',
    heroImage: 'hospitality_01.jpg',
    posterTheme: 'HOSPITALITY FINANCE',
    posterHeadline: 'Specialist Hospitality Debt Advisory',
    posterSubline: 'Pan-European hotel and hospitality finance — bridging, development, investment and refinancing',
    cardTitles: ['Development Finance', 'Investment & Portfolio Debt', 'Acquisition Finance', 'Stabilisation & Refinancing'],
    linkedin: `The European hospitality lending market has over 50 active participants. Banks, debt funds, insurance platforms, family offices, international lenders with dedicated hotel desks. Each with different appetite, different leverage limits, different pricing.

Most borrowers see terms from two or three of them. That is not a market view — it is a sample.

Turning Point Capital Advisory exists to change that. We advise on bridging, development finance, investment debt, and refinancing across hotels, serviced apartments, PBSA, senior living, holiday parks, and the wider hospitality sector. Pan-European coverage, specialist focus, competitive process on every deal.

The hospitality lending market is deep. The problem has never been a lack of capital — it has been a lack of visibility. When you only speak to lenders you already know, you are pricing in the dark. A structured competitive process across the full market produces materially better outcomes.

We have advised on over £2 billion of hospitality debt transactions. Every single one started with mapping the full lender landscape before approaching anyone.`,
  },
  {
    templateName: 'Clients — Hospitality — 2. Development Finance',
    heroImage: 'hospitality_02.jpg',
    posterTheme: 'HOSPITALITY DEVELOPMENT',
    posterHeadline: 'Hotel Development Finance Specialists',
    posterSubline: 'Ground-up construction, conversion, repositioning and pre-opening stabilisation debt',
    cardTitles: ['Ground-Up Construction', 'Conversion & Change of Use', 'Repositioning & Refurbishment', 'Pre-Opening & Stabilisation Debt'],
    linkedin: `Hotel development finance is the most complex corner of hospitality lending. Ground-up construction risk, pre-opening ramp-up, operator dependency, planning uncertainty, branded flag requirements. Most generalist brokers avoid it.

We do nothing else.

The lender pool for hotel development is surprisingly deep once you know where to look. Specialist hotel lenders, challenger banks with dedicated hospitality desks, debt funds comfortable with construction risk, and mezzanine providers who understand the gap between senior lending and sponsor equity.

The key is positioning. A hotel development proposal to a residential lender gets rejected. The same deal, repackaged for a specialist hospitality lender with the right IM structure and the right comparable evidence, gets a term sheet in two weeks.

We are currently advising on ground-up hotel schemes, office-to-hotel conversions, and branded repositioning projects across the UK and Europe. The market is constructive for experienced sponsors with strong operator relationships and realistic cost plans.

Development finance is not about finding a lender. It is about finding the right lender for your specific scheme.`,
  },
  {
    templateName: 'Clients — Hospitality — 3. Portfolio & Cross-Border',
    heroImage: 'hospitality_03.jpg',
    posterTheme: 'CROSS-BORDER HOSPITALITY',
    posterHeadline: 'Cross-Border Hotel Portfolio Advisory',
    posterSubline: 'Multi-jurisdiction debt structuring across 8+ European markets',
    cardTitles: ['Multi-Asset Portfolio Debt', 'Cross-Border Structuring', 'Acquisition Finance', 'Lender Introductions'],
    linkedin: `Cross-border hotel portfolio transactions are where generalist debt brokers run out of road. Different regulatory environments, different security packages, different lender appetites in each jurisdiction. A lender who is aggressive in Germany may have no appetite for Spain. A UK bank with a strong hotel book may not lend into France.

This is exactly where we operate.

Turning Point Capital advises on pan-European hospitality debt across the UK, Germany, France, Spain, Benelux, and the Nordics. We know which lenders can structure a single facility across multiple jurisdictions, which require bilateral arrangements, and where the pricing sits in each market.

Portfolio transactions add another layer. Cross-collateralisation, release mechanisms, currency risk, multi-PropCo structures. These are technical structuring questions that require a specialist adviser, not a generalist introduction.

We are currently active on several cross-border mandates. The appetite from international lenders for European hotel portfolios is strong, particularly for branded assets with diversified geographic exposure. Single-country concentration is the one thing that consistently narrows the lender pool.`,
  },
  {
    templateName: 'Clients — Hospitality — 4. Stabilisation & Refi',
    heroImage: 'hospitality_04.jpg',
    posterTheme: 'HOSPITALITY REFINANCING',
    posterHeadline: 'Hotel Stabilisation & Refinancing Specialists',
    posterSubline: 'Transitional assets, distressed refinancing and debt restructuring across Europe',
    cardTitles: ['Pre-Opening Stabilisation', 'Distressed Refinancing', 'Repositioning Finance', 'Debt Restructuring Advisory'],
    linkedin: `Stabilisation and refinancing is the most active part of the European hospitality debt market right now. Post-development ramp-ups, distressed situations where the incumbent lender is exiting, assets coming out of a period of underperformance, and covenant pressure requiring creative solutions.

The common thread is urgency. These deals do not wait.

What separates a successful stabilisation refinancing from a failed one is almost always speed of execution and lender selection. The borrower needs a lender who understands hospitality operating metrics, not just static property valuations. RevPAR trajectory matters more than a single-point valuation. Seasonal cash flow profiles need to be modelled properly. Brand pipeline and operator quality are real credit factors.

We know which lenders will engage with transitional hospitality assets and which will not. We know who can move quickly on a distressed refinancing and who will take six months to get through credit committee.

The market for stabilisation debt is constructive. Several lenders have dedicated teams for exactly these situations. The capital is there — the challenge is knowing where it sits.`,
  },
  {
    templateName: 'Clients — Hospitality — 5. Market Insight',
    heroImage: 'hospitality_05.jpg',
    posterTheme: 'HOSPITALITY MARKET UPDATE',
    posterHeadline: 'Hospitality Lending Market — Current Conditions',
    posterSubline: 'Real-time observations from our live mandates across the European hotel market',
    cardTitles: ['Bank Appetite Returning', 'Debt Funds Filling Gaps', 'Cross-Border Demand Rising', 'Development Lending Selective'],
    linkedin: `Here is what we are seeing across the European hospitality lending market right now.

Bank appetite is returning. Several mainstream lenders who stepped back from hospitality over the last two years are re-entering — particularly for stabilised assets with strong trading histories. Margins are compressing as competition returns.

Debt funds are filling the gaps that banks still will not touch. Stretched senior and whole loan solutions for transitional assets, development schemes, and more complex credit profiles. Execution speed is their advantage — term sheets in days rather than weeks.

Cross-border demand is rising. Pan-European hotel platforms are attracting competitive terms from international lenders who want multi-jurisdiction exposure in a single facility.

Development lending remains selective but available. Experienced sponsors with pre-lets or branded flag agreements are securing construction finance. Speculative development without an operator commitment is harder.

This is the market as we see it from our live mandates. Not from reports or conferences — from term sheets we are negotiating this month. Market conditions move quickly. What was competitive three months ago may not be today.`,
  },
  {
    templateName: 'Clients — Hospitality — 6. Partnership Call',
    heroImage: 'hospitality_06.jpg',
    posterTheme: 'HOSPITALITY ADVISORY',
    posterHeadline: 'Your Specialist Hospitality Finance Partner',
    posterSubline: 'Independent, pan-European advisory — built exclusively for hospitality operators and investors',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `The best advisory relationships in hospitality finance start before there is a live deal. Understanding a sponsor's pipeline, their preferred markets, their capital structure, and their growth strategy means we can move fast when the right opportunity appears.

That is how we work at Turning Point Capital. We invest time in understanding our clients' businesses before we are formally instructed. When a deal comes, we already know which lenders to approach, how to position the credit, and what terms are achievable.

Over the last six years we have advised on more than £2 billion of hospitality debt transactions across the UK and Europe. Hotels, serviced apartments, PBSA, senior living, holiday parks. Every major hospitality sub-sector, every part of the capital stack.

Our network of 50+ specialist lenders means we run competitive processes, not single-source enquiries. Our independence means we go where the best terms are, not where a panel arrangement directs us. Our track record speaks for itself — an 85%+ mandate success rate tells you we deliver.

Hospitality debt advisory is all we do. That focus is what makes the difference.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PBSA (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — PBSA — 1. Sector Overview',
    heroImage: 'pbsa_01.jpg',
    posterTheme: 'STUDENT ACCOMMODATION',
    posterHeadline: 'Specialist PBSA Debt Advisory',
    posterSubline: 'Purpose-built student accommodation finance across UK and European university cities',
    cardTitles: ['Development Finance', 'Investment & Portfolio Debt', 'Acquisition Finance', 'Forward Funding Structures'],
    linkedin: `PBSA is one of the most resilient asset classes in UK real estate. Structural undersupply of quality student beds, resilient demand driven by rising university enrolment, and strong rental growth that has consistently outperformed other residential sectors.

Lenders know this. That is why PBSA attracts some of the most competitive debt terms in commercial real estate — but only if you access the full market.

Turning Point Capital advises on the full spectrum of PBSA finance. Forward-funded development schemes, stabilised portfolio acquisitions, single-asset refinancings, and complex cross-collateralised portfolio facilities. We know which lenders understand nomination agreements, which are comfortable with direct-let risk, and which will finance in secondary university towns versus Russell Group cities only.

The PBSA lending landscape is deeper than most borrowers realise. Banks, insurance companies, pension funds, debt funds, and specialist PBSA lenders all participate — each with different appetite, different leverage limits, and different pricing structures.

We run competitive processes across all of them. That is the only way to know you have the best terms the market can offer.`,
  },
  {
    templateName: 'Clients — PBSA — 2. Development Finance',
    heroImage: 'pbsa_02.jpg',
    posterTheme: 'PBSA DEVELOPMENT',
    posterHeadline: 'PBSA Development Finance Specialists',
    posterSubline: 'Ground-up construction, conversion and forward-fund structures for student accommodation',
    cardTitles: ['Ground-Up Construction', 'Office-to-PBSA Conversion', 'Forward-Fund Development', 'Mezzanine & Equity Bridge'],
    linkedin: `PBSA development finance benefits from the strongest structural tailwind in UK real estate — a persistent and growing shortfall of quality student beds. Every year, more students enrol at UK universities. Every year, the gap between supply and demand widens.

Lenders understand this, which makes PBSA development one of the more constructive areas of the construction lending market. But the details matter. A 500-bed scheme near a Russell Group university with a nomination agreement will attract fundamentally different terms from a 200-bed direct-let scheme in a secondary town.

We advise on both. Ground-up PBSA construction, office-to-PBSA conversions, forward-fund structures alongside institutional commitments, and mezzanine to bridge the equity gap on higher-leverage schemes.

The key to securing the best development finance terms is positioning. PBSA lenders want to see pre-let or nomination commitments, a credible operator, realistic cost plans, and evidence of local supply-demand dynamics. We structure information memoranda that speak directly to what PBSA lenders need to see.

Construction finance for student accommodation is available and competitive. The market rewards well-prepared, well-positioned applications.`,
  },
  {
    templateName: 'Clients — PBSA — 3. Investment & Acquisition',
    heroImage: 'pbsa_03.jpg',
    posterTheme: 'PBSA INVESTMENT',
    posterHeadline: 'PBSA Investment & Acquisition Advisory',
    posterSubline: 'Portfolio debt, single-asset acquisition and nomination agreement financing',
    cardTitles: ['Portfolio Acquisition Debt', 'Single-Asset Acquisition', 'Nomination Agreement Finance', 'Club Deals & Syndications'],
    linkedin: `Institutional appetite for PBSA has never been stronger. Insurance companies, pension funds, and sovereign wealth vehicles are all increasing their allocation to student accommodation — and lenders are competing aggressively to finance these acquisitions.

For stabilised PBSA assets with strong occupancy and quality locations, margins are compressing to levels that rival the most defensive asset classes in commercial real estate. Sub-200bps pricing is achievable for the best schemes.

The financing landscape splits clearly by asset quality. A modern, purpose-built PBSA block near a Russell Group university with 97%+ occupancy will attract five or six competing term sheets. An older, converted property in a weaker location will attract one or two, at materially different pricing.

We advise on both ends of the spectrum. Portfolio acquisitions requiring single-facility financing across multiple university cities. Single-asset purchases where speed of execution is critical. Nomination agreement structures where lender comfort with the income profile is the key variable.

The PBSA investment lending market is deep and competitive. The difference between good terms and great terms comes down to how many lenders see the deal.`,
  },
  {
    templateName: 'Clients — PBSA — 4. Refinancing',
    heroImage: 'pbsa_04.jpg',
    posterTheme: 'PBSA REFINANCING',
    posterHeadline: 'PBSA Refinancing & Debt Optimisation',
    posterSubline: 'Capturing rental growth and lender competition in student accommodation refinancing',
    cardTitles: ['Maturity Refinancing', 'Equity Release', 'Lender Consolidation', 'Green Finance Overlay'],
    linkedin: `PBSA values have held firm through a period where other asset classes have corrected. Rental growth continues in most key markets. Occupancy rates remain above 95% across quality schemes. Lenders are recognising this resilience in their pricing.

For PBSA owners, that creates a clear refinancing opportunity. Assets financed two or three years ago were priced in a different market. Today, with more lenders competing for stabilised PBSA exposure, improved terms are available — often materially better than the existing facility.

We are advising several sponsors on PBSA refinancings right now. The common themes are equity release as values have grown, margin compression as lender competition has intensified, and green finance overlays for assets with strong EPC and BREEAM credentials.

The lender consolidation opportunity is also significant. Sponsors with multiple bilateral facilities across different PBSA assets can often consolidate into a single portfolio-level arrangement — simpler to manage, more efficient, and almost always on better terms.

PBSA refinancing is not just about replacing a maturing facility. It is about capturing the value that lender competition and rental growth have created.`,
  },
  {
    templateName: 'Clients — PBSA — 5. Market Insight',
    heroImage: 'pbsa_05.jpg',
    posterTheme: 'PBSA MARKET UPDATE',
    posterHeadline: 'PBSA Lending — What We Are Seeing Right Now',
    posterSubline: 'Current market conditions from our live student accommodation mandates',
    cardTitles: ['Bank Margins Compressing', 'Development Appetite Steady', 'Institutional Capital Growing', 'Regional Demand Strong'],
    linkedin: `Here is what we are seeing in the PBSA lending market from our live mandates.

Bank margins are compressing. Competition among mainstream lenders for stabilised PBSA is intensifying. Best-in-class assets near Russell Group universities are seeing margins that would have been unthinkable two years ago. PBSA is now firmly in the same pricing bracket as the most defensive CRE asset classes.

Development appetite remains steady. Lenders continue to support PBSA construction in supply-constrained university cities. Pre-let commitments and nomination agreements significantly strengthen terms. Speculative development in weaker locations is harder to finance.

Institutional capital is growing. Insurance companies and pension funds are increasingly lending directly into PBSA as a long-income asset class, providing fixed-rate alternatives to floating-rate bank debt. This is expanding the pool of available capital and creating genuine pricing tension.

Regional demand is strong. Tier 1 and Tier 2 university cities outside London are seeing increased lender interest as occupancy rates remain above 95%. The supply-demand fundamentals outside the capital are, in many cases, even more compelling than in London.

The PBSA lending market rewards borrowers who run competitive processes across the full lender landscape.`,
  },
  {
    templateName: 'Clients — PBSA — 6. Partnership Call',
    heroImage: 'pbsa_06.jpg',
    posterTheme: 'STUDENT ACCOMMODATION',
    posterHeadline: 'Your Specialist PBSA Finance Partner',
    posterSubline: 'Independent advisory for student accommodation developers and investors',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `PBSA finance is a specialist market within a specialist market. The lenders who are most competitive for student accommodation are not always the same lenders who lead in other living sectors. Nomination agreements, direct-let risk profiles, academic cycle cash flows, and university covenant strength all create a unique underwriting dynamic.

That is why PBSA borrowers benefit disproportionately from working with a specialist adviser. A generalist broker will approach the banks they know. A specialist will map the full PBSA lending landscape — banks, insurance companies, pension funds, debt funds, and dedicated student accommodation lenders — and run a competitive process across all of them.

Turning Point Capital has advised on over £2 billion of transactions across the hospitality and living sectors, including significant PBSA mandates. Our lender network includes every major PBSA lending participant in the UK and European markets.

We invest time in understanding our clients' portfolios and pipelines before deals go live. That means we can move quickly when the opportunity arrives. The best PBSA financing outcomes come from preparation, not improvisation.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LIVING (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — Living — 1. Sector Overview',
    heroImage: 'living_01.jpg',
    posterTheme: 'LIVING SECTOR FINANCE',
    posterHeadline: 'Specialist Living Sector Debt Advisory',
    posterSubline: 'BTR, co-living, senior living and affordable housing — specialist advisory across the full spectrum',
    cardTitles: ['Build-to-Rent Finance', 'Co-Living & HMO', 'Senior & Later Living', 'Affordable & Social Housing'],
    linkedin: `The living sector is the fastest-growing area of UK real estate finance. Build-to-rent, co-living, senior living, affordable housing. Each sub-sector has its own lender pool, its own underwriting logic, and its own structuring requirements.

A BTR lender is not necessarily a co-living lender. A senior living specialist will not price student accommodation risk the same way. Understanding which lenders operate in which sub-sector — and what they need to see — is the entire game.

Turning Point Capital advises across the full living sector spectrum. We know which lenders have dedicated BTR desks, which are comfortable with the co-living operating model, which understand senior living care quality metrics, and which will finance mixed-tenure affordable housing schemes.

The common thread is operational income. Living sector assets generate revenue through management and operations, not just property ownership. Lenders who understand this will offer materially different terms from those who treat it as a pure property play.

We have seen the living sector lending market evolve significantly over the last three years. More lenders, more competition, more sophisticated structuring. The opportunity for borrowers has never been better.`,
  },
  {
    templateName: 'Clients — Living — 2. Development Finance',
    heroImage: 'living_02.jpg',
    posterTheme: 'LIVING DEVELOPMENT',
    posterHeadline: 'Living Sector Development Finance Specialists',
    posterSubline: 'Construction finance for BTR, co-living, senior living and mixed-tenure schemes',
    cardTitles: ['BTR Development', 'Co-Living Schemes', 'Senior Living Development', 'Mixed-Tenure Development'],
    linkedin: `Development finance for living sector schemes requires a lender who understands the end product. A BTR development is not a build-to-sell scheme with a rental overlay. It has a fundamentally different cash flow profile, a different hold period, and a different exit strategy. The lender needs to underwrite accordingly.

The same applies to co-living, senior living, and mixed-tenure schemes. Each has its own construction risk profile, its own stabilisation timeline, and its own operating model that the lender must be comfortable with from day one.

We specialise in matching living sector developments with the right capital. Senior and stretched senior for urban multifamily BTR. Construction finance for purpose-built co-living with management agreements. Development debt for senior living communities with phased occupancy programmes. Mixed-tenure schemes combining private rental, affordable, and shared ownership.

The development lending market for living sector schemes is constructive. Lenders recognise the structural demand for rental housing across all sub-sectors. The deals that attract the best terms are the ones positioned to speak directly to what each lender needs to see — occupancy assumptions, operator quality, and a realistic stabilisation timeline.`,
  },
  {
    templateName: 'Clients — Living — 3. Investment & Acquisition',
    heroImage: 'living_03.jpg',
    posterTheme: 'LIVING INVESTMENT',
    posterHeadline: 'Living Sector Investment & Acquisition Advisory',
    posterSubline: 'Portfolio debt, platform finance and stabilised asset acquisition across the UK',
    cardTitles: ['BTR Portfolio Debt', 'Single-Asset Acquisition', 'Platform Finance', 'Forward-Fund Structures'],
    linkedin: `Institutional capital is flowing into the UK living sector at a pace that is reshaping the lending market. BTR, co-living, and senior living are all attracting significant allocations from pension funds, insurance companies, and sovereign wealth vehicles. That capital needs debt alongside it.

The result is intense competition among lenders for stabilised living sector assets. Banks, insurance company lending platforms, debt funds, and institutional investors are all competing — and borrowers who run a full market process are seeing the benefit.

We advise on portfolio-level financing across multiple living sector assets, single-asset acquisition debt where speed of execution matters, platform finance for operators assembling portfolios at scale, and forward-fund structures where debt needs to align with institutional investment commitments.

The living sector investment lending market is deep. The challenge is not finding a lender — it is finding the best structure and the best terms across the full range of available capital. A bank facility, an insurance company fixed-rate loan, and a debt fund flexible facility all solve different problems for different borrowers.

We map the full landscape and run competitive processes. That is the only way to know you have the optimal structure.`,
  },
  {
    templateName: 'Clients — Living — 4. Refinancing',
    heroImage: 'living_04.jpg',
    posterTheme: 'LIVING REFINANCING',
    posterHeadline: 'Living Sector Refinancing & Debt Optimisation',
    posterSubline: 'Capturing rental growth and lender competition in living sector refinancing',
    cardTitles: ['Maturity Refinancing', 'Equity Release', 'Covenant Optimisation', 'Green & Sustainability Loans'],
    linkedin: `Rental growth in the UK living sector has outperformed almost every other asset class over the last three years. BTR rents, co-living rents, and senior living fees have all risen significantly. Asset values have held firm or appreciated.

For living sector owners, that creates a clear refinancing opportunity. Facilities written two or three years ago were priced in a market with fewer lenders, less competition, and lower asset values. Today, the market is fundamentally more competitive.

We are advising several sponsors on living sector refinancings. The themes are consistent — equity release as values have grown, margin compression as lender competition has intensified, covenant optimisation to reflect current operating performance, and sustainability-linked margin reductions for assets with strong EPC credentials.

The portfolio consolidation opportunity is also significant. Sponsors with bilateral facilities across multiple living sector assets can often restructure into a single portfolio-level arrangement. The administrative efficiency alone is valuable — but the terms improvement is usually the real prize.

Living sector refinancing is about capturing value. The market has moved in borrowers' favour. The question is whether your existing debt reflects that.`,
  },
  {
    templateName: 'Clients — Living — 5. Market Insight',
    heroImage: 'living_05.jpg',
    posterTheme: 'LIVING MARKET UPDATE',
    posterHeadline: 'Living Sector Lending — What We Are Seeing Now',
    posterSubline: 'Real-time market observations from our active living sector mandates',
    cardTitles: ['BTR Margins Tightening', 'Senior Living Gaining Traction', 'Co-Living Acceptance Growing', 'Regional BTR Demand'],
    linkedin: `Here is what we are seeing across the UK living sector lending market from our active mandates.

BTR margins are tightening. Competition among lenders for stabilised build-to-rent is the most intense we have seen. Banks, insurance companies, and debt funds are all actively deploying. Best-in-class urban multifamily schemes are achieving margins that reflect the asset class's defensive characteristics.

Senior living is gaining real traction. Mainstream lenders are becoming comfortable with the operating model. Two years ago, senior living finance was largely the domain of specialist funds. Today, several banks have dedicated later living lending teams. That is a significant shift.

Co-living acceptance is growing. The market has moved from scepticism to structured engagement. Several mainstream lenders now have co-living policies and dedicated underwriting approaches. Trading data from early schemes is building the evidence base that lenders needed.

Regional BTR demand continues to expand. Manchester, Birmingham, Leeds, Edinburgh, and Bristol are all seeing strong lender interest. The supply-demand fundamentals in regional cities are compelling, and lenders are following the institutional capital into these markets.

The living sector lending market is deep and competitive. Borrowers who map the full landscape get better outcomes.`,
  },
  {
    templateName: 'Clients — Living — 6. Partnership Call',
    heroImage: 'living_06.jpg',
    posterTheme: 'LIVING SECTOR ADVISORY',
    posterHeadline: 'Your Specialist Living Sector Finance Partner',
    posterSubline: 'Independent advisory for BTR, co-living, senior living and affordable housing operators',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `The living sector is where the most interesting conversations in UK real estate finance are happening. BTR is maturing as an asset class. Co-living is proving its operating model. Senior living is attracting mainstream lender appetite for the first time. Affordable housing is evolving beyond housing association balance sheets.

Each of these sub-sectors has its own lending dynamics, its own specialist lenders, and its own structuring requirements. A one-size-fits-all approach to debt advisory does not work here.

Turning Point Capital advises across the full living sector. We have the lender relationships, the structuring experience, and the market knowledge to access the best terms available — whether that is a bank facility, an insurance company fixed-rate loan, or a debt fund flexible structure.

Over the last six years we have advised on more than £2 billion of transactions across hospitality and the living sector. Our network includes every significant living sector lender in the UK market. Our independence means we are not tied to any panel — we go where the best terms are for each specific deal.

We build relationships before deals go live. That preparation is what makes the difference when speed and precision matter.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // OFFICES (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — Offices — 1. Sector Overview',
    heroImage: 'office_01.jpg',
    posterTheme: 'OFFICE FINANCE',
    posterHeadline: 'Specialist Office Sector Debt Advisory',
    posterSubline: 'Prime city-centre, suburban, flex-space and repositioning finance across the UK and Europe',
    cardTitles: ['Development Finance', 'Investment & Portfolio Debt', 'Acquisition Finance', 'Repositioning & Capex'],
    linkedin: `The UK office market is bifurcating. Grade A ESG-compliant space is commanding record rents, attracting institutional capital, and securing competitive debt terms. Secondary stock is facing structural headwinds — harder to let, harder to finance, harder to sell.

For office developers and investors, this bifurcation creates both risk and opportunity. The risk is being on the wrong side of it. The opportunity is that the lending market for quality office assets is genuinely competitive.

Turning Point Capital advises on the full range of office sector finance. Prime city-centre development, major refurbishment and repositioning, portfolio investment debt, and suburban and flex-space schemes. We know which lenders have appetite for each segment and how to position the credit.

The office sector requires a more nuanced approach than most other asset classes. Lenders want to see ESG credentials, tenant quality, lease length, and a credible business plan. The days of financing office assets on valuation alone are gone.

We advise on transactions across the UK and Europe. The market rewards well-positioned deals with strong sustainability credentials and a clear tenant demand story.`,
  },
  {
    templateName: 'Clients — Offices — 2. Development Finance',
    heroImage: 'office_02.jpg',
    posterTheme: 'OFFICE DEVELOPMENT',
    posterHeadline: 'Office Development & Refurbishment Finance Specialists',
    posterSubline: 'Ground-up, major refurbishment, mixed-use and flex-space development',
    cardTitles: ['Ground-Up Office', 'Major Refurbishment', 'Mixed-Use Schemes', 'Flex & Serviced Office'],
    linkedin: `Office development finance is undergoing a fundamental shift. Sustainability requirements are reshaping what lenders will and will not finance. New-build Grade A space with strong BREEAM and EPC credentials attracts competitive terms. Speculative development of anything less is increasingly difficult to fund.

The bigger opportunity may be in refurbishment. Lenders are actively supporting capex-heavy repositioning plans that upgrade tired secondary stock to modern ESG-compliant workspace. The economics often work — the cost of refurbishment is significantly lower than new-build, while the achieved rents for quality refurbished space are approaching new-build levels.

We advise on both. Ground-up speculative and pre-let office development in supply-constrained markets. Major strip-out-and-refit schemes targeting Grade A specification. Mixed-use office-led developments combining workspace with retail, F&B, and residential. Flex and serviced office fit-out finance for the growing co-working sector.

The office development lending market is selective but active. Lenders want to see pre-let commitments or strong evidence of tenant demand, realistic cost plans, and ESG credentials that future-proof the asset. Deals that tick those boxes are attracting competitive terms from multiple lenders.`,
  },
  {
    templateName: 'Clients — Offices — 3. Investment & Acquisition',
    heroImage: 'office_03.jpg',
    posterTheme: 'OFFICE INVESTMENT',
    posterHeadline: 'Office Investment & Acquisition Advisory',
    posterSubline: 'Portfolio debt, value-add strategies, sale-leaseback and cross-border mandates',
    cardTitles: ['Prime Office Portfolios', 'Value-Add Acquisitions', 'Sale & Leaseback', 'Cross-Border Office'],
    linkedin: `Quality office assets with strong ESG credentials, long WAULT, and prime locations continue to attract competitive investment debt. The narrative that offices are uninvestable is wrong — it is just that the bar for what constitutes a financeable office asset has risen significantly.

Lenders are concentrating their office exposure in Grade A ESG-compliant buildings with strong tenant covenants. For assets that meet this standard, the debt market is competitive. Banks, insurance companies, and institutional lenders are all active.

The value-add opportunity is equally interesting from a financing perspective. Under-rented or under-managed offices where a repositioning business plan can deliver ESG upgrades, improved tenant mix, and rental growth are attracting lender interest — particularly where the exit valuation assumes Grade A specification.

We advise on prime office portfolio acquisitions, single-asset purchases, value-add strategies with capex overlays, sale-and-leaseback transactions, and cross-border pan-European office mandates. Each requires different lender selection and different positioning.

The office investment lending market is not dead. It has become more selective. Borrowers who present well-positioned, ESG-compliant office assets to the right lenders are securing strong terms.`,
  },
  {
    templateName: 'Clients — Offices — 4. Refinancing',
    heroImage: 'office_04.jpg',
    posterTheme: 'OFFICE REFINANCING',
    posterHeadline: 'Office Refinancing & Debt Optimisation',
    posterSubline: 'Green finance, covenant reset and equity release for office assets',
    cardTitles: ['Maturity Refinancing', 'Green Refinancing', 'Covenant Reset', 'Equity Release'],
    linkedin: `Office refinancing is one of the most important conversations in UK commercial real estate right now. Many facilities were written in a different market — different interest rate environment, different lender appetite, different ESG expectations. The question is whether your existing debt reflects where the market sits today.

For Grade A ESG-compliant offices, the refinancing market is genuinely competitive. Multiple lenders are deploying into quality office assets, and the terms available today often represent a significant improvement on facilities written even two years ago. Green loan frameworks are adding sustainability-linked margin reductions for assets with strong environmental credentials.

For offices that do not meet modern ESG standards, refinancing is harder but not impossible. The key is presenting a credible capex and upgrade plan alongside the refinancing request. Lenders will support a transition to higher specification if the business plan is realistic and funded.

We are advising several sponsors on office refinancings right now. Maturity replacements, equity release, covenant resets where valuations or leasing have improved, and portfolio consolidation from multiple bilateral facilities into single arrangements.

The market has moved. Whether your existing debt has moved with it is the question worth answering.`,
  },
  {
    templateName: 'Clients — Offices — 5. Market Insight',
    heroImage: 'office_05.jpg',
    posterTheme: 'OFFICE MARKET UPDATE',
    posterHeadline: 'Office Lending — What We Are Seeing Now',
    posterSubline: 'Current market conditions from our live office sector mandates',
    cardTitles: ['Flight to Quality', 'Regional Office Revival', 'Flex-Space Acceptance', 'Refurb Over Demolition'],
    linkedin: `Here is what we are seeing in the office lending market from our live mandates.

Flight to quality is accelerating. Lenders are concentrating appetite on Grade A ESG-compliant offices and pulling back from secondary stock. The gap between what is financeable and what is not has widened significantly. This is not a temporary cycle — it is a structural shift driven by occupier demand, regulatory requirements, and lender ESG policies.

Regional office demand is reviving. Strong occupier take-up in regional city centres — Manchester, Birmingham, Bristol, Leeds, Edinburgh — is translating into renewed lender appetite. Quality regional office assets are attracting competitive terms, particularly where supply is constrained.

Flex-space acceptance is growing. Mainstream lenders are becoming more comfortable with serviced office and co-working income as part of the tenant mix. Two years ago, flex-space income was treated as void. Today, several lenders will underwrite it at a discount to contracted rent rather than excluding it entirely.

Refurbishment is favoured over demolition. Sustainability requirements are driving a clear preference for capex-heavy refurbishment over new-build where the existing structure allows it. Lenders are actively supporting repositioning plans.

The office market is selective, not closed. Quality assets with the right credentials are attracting competitive debt.`,
  },
  {
    templateName: 'Clients — Offices — 6. Partnership Call',
    heroImage: 'office_06.jpg',
    posterTheme: 'OFFICE ADVISORY',
    posterHeadline: 'Your Specialist Office Sector Finance Partner',
    posterSubline: 'Independent advisory for office developers, investors and operators',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `The office sector rewards specialist advisory more than almost any other asset class right now. The market is nuanced. Lender appetite varies dramatically by sub-sector, specification, location, ESG credentials, and tenant quality. A deal that one lender will not look at is exactly the deal another lender is seeking.

Knowing which lender fits which office transaction is the value we bring. We track appetite, pricing, and policy changes across 50+ active lenders in real time. When a client comes to us with an office transaction, we already know which lenders to approach and how to position it.

Turning Point Capital has advised on over £2 billion of commercial real estate debt transactions across the UK and Europe. Our office sector experience covers prime city-centre development, major refurbishment, portfolio investment debt, flex-space, and cross-border mandates.

We invest in understanding our clients' portfolios and strategies before deals go live. That preparation means we move quickly and position deals effectively from day one. The office lending market is competitive for the right assets — the difference is knowing which assets, which lenders, and how to present the credit.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RETAIL (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — Retail — 1. Sector Overview',
    heroImage: 'retail_01.jpg',
    posterTheme: 'RETAIL FINANCE',
    posterHeadline: 'Specialist Retail Property Debt Advisory',
    posterSubline: 'Retail parks, high street, grocery-anchored and mixed-use financing',
    cardTitles: ['Retail Park Finance', 'High Street & Mixed-Use', 'Grocery & Convenience', 'Repositioning & Capex'],
    linkedin: `The retail lending market is more nuanced than the headlines suggest. The sector is not dead — it is bifurcated. Retail warehousing and trade parks are among the strongest performing asset classes in UK commercial real estate. Grocery-anchored retail is attracting long-income lender appetite at very competitive terms. Prime high street with defensive tenant mixes is recovering.

What is genuinely difficult to finance is secondary high street with structural vacancy and no clear repositioning plan. Everything else has a market.

Turning Point Capital advises across the full retail spectrum. Retail park acquisition and development finance, high street and mixed-use schemes, grocery and convenience retail long-income debt, and repositioning finance for assets undergoing transformation. We know which lenders have appetite for each sub-sector and how to position the deal.

The retail lending market requires precision. A retail park deal positioned to the right lenders will attract competitive terms. The same deal shown to lenders without retail appetite will be rejected. Sub-sector selection, tenant quality, and income profile are everything.

We run competitive processes across the full lender landscape. That is the only way to know you have the best terms available.`,
  },
  {
    templateName: 'Clients — Retail — 2. Development Finance',
    heroImage: 'retail_02.jpg',
    posterTheme: 'RETAIL DEVELOPMENT',
    posterHeadline: 'Retail Development & Conversion Finance Specialists',
    posterSubline: 'New retail parks, mixed-use schemes and change-of-use conversions',
    cardTitles: ['Retail Park Development', 'Mixed-Use Retail', 'Change of Use', 'Refurbishment & Extension'],
    linkedin: `Retail development finance is evolving as the sector adapts. New-build retail parks and trade parks in supply-constrained locations are attracting lender support — particularly with pre-let commitments from strong covenant tenants. Mixed-use schemes with retail ground floors and residential or workspace above are generating significant lender interest.

The biggest growth area is conversion. Retail assets being repurposed into logistics, residential, community uses, or mixed-use schemes. Lenders are actively supporting these transformations because the exit is often into a more financeable asset class.

We advise on all of these. New retail park development, mixed-use retail-led schemes, change-of-use conversions, and refurbishment projects that upgrade tired retail stock to attract better tenants and better terms.

The development lending market for retail requires careful positioning. Lenders want to see pre-let income, strong tenant covenants, evidence of consumer demand, and — for conversion schemes — a credible planning pathway and exit strategy.

Deals that meet these criteria are securing competitive terms. The retail development market is not closed — it is selective, and it rewards well-prepared applications from experienced sponsors.`,
  },
  {
    templateName: 'Clients — Retail — 3. Investment & Acquisition',
    heroImage: 'retail_03.jpg',
    posterTheme: 'RETAIL INVESTMENT',
    posterHeadline: 'Retail Investment & Acquisition Advisory',
    posterSubline: 'Portfolio debt, grocery-anchored income and value-add strategies',
    cardTitles: ['Retail Portfolio Debt', 'Single-Asset Acquisition', 'Grocery-Anchored', 'Value-Add Retail'],
    linkedin: `Well-let retail assets with defensive income profiles are attracting some of the most competitive debt terms in UK commercial real estate. Grocery-anchored retail with long WAULT and strong covenants is being priced as a long-income asset class — more comparable to logistics than to traditional retail.

Retail parks are the standout sub-sector. Trading performance has been strong, vacancy is low, and lenders are actively competing for quality retail warehouse exposure. Multi-let retail parks with diversified tenant mixes are particularly well-regarded.

The value-add opportunity is also attracting lender interest. Under-managed retail assets where active management, re-gearing, and tenant remixing can unlock rental growth and valuation uplift. Lenders will finance these strategies where the business plan is credible and the sponsor is experienced.

We advise on retail portfolio acquisitions, single-asset purchases, grocery-anchored long-income transactions, and value-add strategies with management-driven upside. Each requires different lender selection and different deal positioning.

The retail investment lending market is not uniformly difficult. It is segmented by sub-sector, tenant quality, and income profile. Borrowers who position their deals accurately to the right lenders are securing strong terms.`,
  },
  {
    templateName: 'Clients — Retail — 4. Refinancing',
    heroImage: 'retail_04.jpg',
    posterTheme: 'RETAIL REFINANCING',
    posterHeadline: 'Retail Refinancing & Debt Restructuring',
    posterSubline: 'Portfolio restructuring, green finance and covenant optimisation',
    cardTitles: ['Maturity Refinancing', 'Portfolio Restructuring', 'Debt-for-Equity Swap', 'Green Retail Finance'],
    linkedin: `Retail refinancing is one of the more complex areas of UK commercial property debt. Many existing facilities were written when the market was in a different place — different valuations, different covenant expectations, different lender appetite for the sector.

For quality retail assets — retail parks, grocery-anchored schemes, well-let high street with strong tenants — the refinancing market is constructive. Values have stabilised, trading has recovered, and lenders are competing for the right retail exposure. Improved terms are available.

For assets that have not recovered, the conversation is different but still productive. Portfolio restructuring, covenant renegotiation, and strategic repositioning plans that give lenders a pathway to improved asset quality. These are complex transactions that require careful structuring and the right lender relationships.

We are advising several sponsors on retail refinancings. The themes include maturity replacements at improved terms, portfolio consolidation from bilateral into single facilities, green finance overlays for assets with planned ESG upgrades, and debt-for-equity restructuring where valuations have moved.

Retail refinancing requires precision and specialist knowledge. The market rewards borrowers who understand which lenders have appetite and how to present the credit.`,
  },
  {
    templateName: 'Clients — Retail — 5. Market Insight',
    heroImage: 'retail_05.jpg',
    posterTheme: 'RETAIL MARKET UPDATE',
    posterHeadline: 'Retail Lending — What We Are Seeing Now',
    posterSubline: 'Current market conditions from our live retail sector mandates',
    cardTitles: ['Retail Parks in Demand', 'High Street Selectivity', 'Grocery Long-Income', 'Mixed-Use Opportunity'],
    linkedin: `Here is what we are seeing in the retail lending market from our live mandates.

Retail parks are in strong demand. Retail warehousing and trade parks are the standout retail sub-sector for lenders. Trading performance is strong, vacancy is low, and margins are compressing as competition intensifies. Quality retail park assets are attracting terms comparable to logistics.

High street selectivity continues. Lender appetite for high street retail remains cautious but is improving for prime pitches with defensive tenant mixes. The key variables are location quality, tenant covenant strength, and WAULT. Secondary high street with structural vacancy remains very difficult to finance.

Grocery long-income is highly competitive. Supermarket and convenience retail continues to attract very competitive terms as a defensive long-income asset class. Single-tenant and portfolio grocery deals are being priced at the tight end of the margin range.

Mixed-use conversion is gaining traction. Retail-to-residential, retail-to-logistics, and retail-to-mixed-use conversion schemes are attracting development lender interest — particularly in secondary locations where the current retail use is no longer viable.

The retail lending market is segmented, not uniformly challenging. Knowing which sub-sector you are in — and which lenders have appetite for it — determines everything.`,
  },
  {
    templateName: 'Clients — Retail — 6. Partnership Call',
    heroImage: 'retail_06.jpg',
    posterTheme: 'RETAIL ADVISORY',
    posterHeadline: 'Your Specialist Retail Property Finance Partner',
    posterSubline: 'Independent advisory for retail developers, investors and operators',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `Retail property finance is the sector where specialist advisory makes the most obvious difference. The market is nuanced and segmented. A retail park deal, a grocery acquisition, a high street repositioning, and a mixed-use conversion each require entirely different lender approaches.

Generalist brokers often avoid retail because they assume lender appetite is universally weak. It is not. Retail parks, grocery-anchored assets, and well-positioned convenience retail are all attracting competitive debt. The lender pool is smaller than logistics or living, but for the right assets, it is active and competitive.

Turning Point Capital has advised on over £2 billion of commercial real estate debt transactions. Our retail sector experience covers every sub-sector — parks, high street, grocery, convenience, mixed-use, and conversion schemes.

We track retail lender appetite in real time. We know which lenders are increasing their retail allocation, which are pulling back, which have specific sub-sector preferences, and where the pricing sits for each deal type.

Retail property is not one market. It is several. We know which market your deal sits in and which lenders to approach.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CARE (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — Care — 1. Sector Overview',
    heroImage: 'care_01.jpg',
    posterTheme: 'HEALTHCARE FINANCE',
    posterHeadline: 'Specialist Healthcare & Care Sector Advisory',
    posterSubline: 'Care homes, supported living and specialist healthcare facility finance',
    cardTitles: ['Care Home Finance', 'Supported Living', 'Healthcare Facilities', 'Portfolio & Platform'],
    linkedin: `Care sector finance sits at the intersection of property lending and operational business lending. A care home is not just a building — it is an operating business with regulatory requirements, staffing obligations, and fee income that depends on occupancy, quality ratings, and local authority commissioning.

Most property lenders do not understand this. They try to underwrite care homes using standard commercial property metrics and the deal falls apart. The lenders who work in this sector understand EBITDARM-based underwriting, CQC ratings, staffing ratios, and the difference between local authority-funded and self-funded fee income.

Turning Point Capital advises across the full care sector spectrum. Purpose-built care homes, supported living with local authority nominations, specialist healthcare facilities, and platform acquisitions where operational quality is the key credit factor.

We know which lenders are active in the care sector, what operational metrics they require, and how to position a care sector credit to get through committee. The lending market is supportive for quality operators with modern facilities and strong regulatory records.

Care sector debt advisory requires specialist knowledge. We have it.`,
  },
  {
    templateName: 'Clients — Care — 2. Development Finance',
    heroImage: 'care_02.jpg',
    posterTheme: 'CARE DEVELOPMENT',
    posterHeadline: 'Care Sector Development Finance Specialists',
    posterSubline: 'Purpose-built care homes, supported living and specialist healthcare facilities',
    cardTitles: ['Purpose-Built Care', 'Supported Living Development', 'Extension & Upgrade', 'Specialist Healthcare'],
    linkedin: `The UK needs more purpose-built care homes. The existing stock is ageing — too many facilities are converted residential properties that cannot meet modern regulatory standards. The demographic demand is clear and growing.

Lenders understand this structural need, which makes care sector development one of the more constructive areas of the specialist lending market. But the underwriting is complex. Lenders need to see a credible operator, a realistic stabilisation timeline, evidence of local demand, and a facility designed to modern CQC standards.

We advise on development finance for purpose-built care homes from 60 to 120+ beds, supported living units with pre-agreed local authority nomination arrangements, extensions and upgrades to existing facilities, and specialist healthcare developments for dementia care, mental health, and rehabilitation.

The development lending market for care is not the same as mainstream commercial property. The lenders are different. The metrics are different. The questions they ask are different. An information memorandum that works for a hotel development will not work for a care home.

We structure applications that speak directly to what care sector lenders need to see. That specialist positioning is what converts enquiries into term sheets.`,
  },
  {
    templateName: 'Clients — Care — 3. Investment & Acquisition',
    heroImage: 'care_03.jpg',
    posterTheme: 'CARE INVESTMENT',
    posterHeadline: 'Care Sector Investment & Acquisition Advisory',
    posterSubline: 'Portfolio debt, platform buyouts and single-asset acquisitions',
    cardTitles: ['Care Home Portfolios', 'Supported Living Portfolios', 'Single-Asset Acquisition', 'Platform Buyouts'],
    linkedin: `Care sector acquisitions require lenders who understand operational businesses, not just property assets. The value of a care home is driven by occupancy rates, fee income, CQC ratings, staffing models, and operator quality. Property fundamentals matter, but they are secondary to operational performance.

The lending market for care sector acquisitions is active. Multi-site portfolio transactions, single-asset purchases, supported living portfolios with long-income profiles, and platform buyouts where the operational management team is the key asset.

We advise on all of these. The financing structures vary significantly depending on whether the borrower is acquiring the property, the operating business, or both. Care sector leverage is typically based on EBITDARM rather than property valuation, which means the financial structuring needs to reflect the operational reality.

For supported living portfolios, the income profile is particularly attractive to lenders. Long-term nominations from local authorities, index-linked fee income, and low vacancy create a defensive credit profile that several lenders actively seek.

The care sector investment lending market rewards borrowers who present well-structured applications with strong operational data. We know what lenders need to see and how to present it.`,
  },
  {
    templateName: 'Clients — Care — 4. Refinancing',
    heroImage: 'care_04.jpg',
    posterTheme: 'CARE REFINANCING',
    posterHeadline: 'Care Sector Refinancing & Debt Optimisation',
    posterSubline: 'Capturing fee growth and improved CQC ratings in refinancing terms',
    cardTitles: ['Maturity Refinancing', 'Equity Release', 'Covenant Restructuring', 'Green Care Finance'],
    linkedin: `Care sector fee rates have risen significantly over the last two years — both local authority funded and private pay. For care operators with strong occupancy and good CQC ratings, that translates directly into improved EBITDARM and better debt service coverage.

The refinancing opportunity is clear. Facilities written two or three years ago were based on lower fee income, potentially weaker occupancy, and a more cautious lending market. Today, with fee rates higher and occupancy recovering across the sector, improved terms are available from multiple lenders.

We are advising several care operators on refinancings. The themes are consistent — maturity replacements at improved margins, equity release as operational performance has improved, covenant restructuring to reflect current rather than historic trading, and facility upsizing to fund expansion plans.

The care sector lending market has also evolved. More lenders are active in the space than three years ago. Several banks have established or expanded dedicated healthcare lending teams. This increased competition is benefiting borrowers who run a full market process.

Care sector refinancing is not just about replacing a maturing facility. It is about capturing the value that fee growth and operational improvement have created.`,
  },
  {
    templateName: 'Clients — Care — 5. Market Insight',
    heroImage: 'care_05.jpg',
    posterTheme: 'CARE MARKET UPDATE',
    posterHeadline: 'Care Sector Lending — Current Conditions',
    posterSubline: 'What we are seeing across our live healthcare mandates',
    cardTitles: ['Supported Living Growth', 'Care Home Selectivity', 'Operational Due Diligence', 'Fee Rate Inflation'],
    linkedin: `Here is what we are seeing in the care sector lending market from our active mandates.

Supported living is the fastest-growing sub-sector. Lender appetite for supported living is increasing significantly. Long-term local authority nominations, index-linked fee income, and low vacancy create a defensive income profile that multiple lenders actively want exposure to.

Care home lending is becoming more selective. Lenders are increasingly focused on modern, purpose-built facilities with strong CQC ratings. Older converted stock with lower ratings is harder to finance. The gap between what lenders will pay for quality and what they will accept for the rest has widened.

Operational due diligence matters more than ever. Lenders are placing greater emphasis on operator quality, staffing models, and regulatory compliance. A care home with an Outstanding CQC rating will attract fundamentally different terms from one with Requires Improvement, even if the property characteristics are identical.

Fee rate inflation is improving debt capacity. Rising fee rates are improving EBITDARM and debt service coverage ratios across the sector. This is creating refinancing opportunities for operators whose existing facilities were sized based on lower income assumptions.

The care sector lending market is active but operationally focused. Quality operators with modern facilities are well-served.`,
  },
  {
    templateName: 'Clients — Care — 6. Partnership Call',
    heroImage: 'care_06.jpg',
    posterTheme: 'HEALTHCARE ADVISORY',
    posterHeadline: 'Your Specialist Care Sector Finance Partner',
    posterSubline: 'Independent advisory for care operators, developers and investors',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `Care sector finance is one of the most specialised areas of UK real estate lending. The intersection of property, operations, regulation, and social care commissioning creates a unique underwriting environment that most generalist advisers cannot serve effectively.

We understand this space. The lenders who are active in care sector finance, the operational metrics they use to underwrite, the CQC and regulatory requirements they need to see, and the difference between care home, supported living, and specialist healthcare financing.

Turning Point Capital has advised on over £2 billion of transactions across hospitality and the broader living sector, including significant healthcare mandates. Our lender network includes every major care sector lending participant — specialist healthcare banks, challenger lenders with dedicated care teams, debt funds, and institutional capital.

We work with care operators, developers, and investors. Development finance for new facilities, acquisition debt for platform buildouts, refinancing for existing portfolios, and restructuring for operators navigating operational challenges.

The care sector lending market rewards specialist advisory. Borrowers who work with an adviser who speaks the language of healthcare finance get to the right lenders faster and secure better terms.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BTR (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — BTR — 1. Sector Overview',
    heroImage: 'btr_01.jpg',
    posterTheme: 'BUILD-TO-RENT FINANCE',
    posterHeadline: 'Specialist Build-to-Rent Debt Advisory',
    posterSubline: 'Urban multifamily, suburban single-family rental and platform finance',
    cardTitles: ['Multifamily Development', 'Single-Family Rental', 'Portfolio Investment Debt', 'Platform Finance'],
    linkedin: `BTR has gone from emerging asset class to institutional mainstream in five years. Record capital is flowing in from pension funds, insurance companies, and sovereign wealth vehicles. The lending market has followed — more lenders, more competition, more sophisticated structuring than at any point in the sector's history.

But BTR is not one market. Urban multifamily in city centres is a fundamentally different product — different tenant base, different operating model, different yield profile — from suburban single-family rental. Lender appetite splits accordingly. A lender who is aggressive on 300-unit urban towers may have no appetite for suburban housing estates.

Turning Point Capital advises across the full BTR spectrum. Urban multifamily development and investment finance, suburban single-family rental, portfolio-level debt for stabilised assets, and platform finance for operators assembling portfolios at scale.

We know which lenders have dedicated BTR desks, which are new to the sector and deploying aggressively, which will finance suburban formats, and where the pricing sits for each product type. The BTR lending landscape is broad and competitive. The difference between good terms and great terms comes down to how many lenders see the deal.`,
  },
  {
    templateName: 'Clients — BTR — 2. Development Finance',
    heroImage: 'btr_02.jpg',
    posterTheme: 'BTR DEVELOPMENT',
    posterHeadline: 'BTR Development Finance Specialists',
    posterSubline: 'Ground-up rental schemes — urban multifamily, suburban SFR and mixed-tenure',
    cardTitles: ['Urban Multifamily', 'Suburban BTR', 'Mixed-Tenure Development', 'Forward-Fund Structures'],
    linkedin: `BTR development finance is one of the most active areas of UK real estate lending. Lenders recognise the structural demand for quality rental housing and are deploying capital accordingly.

The development lending market splits by product type. Urban multifamily towers with 200+ units attract different lenders from suburban single-family rental estates. Mixed-tenure schemes combining BTR with affordable, shared ownership, and private sale require even more specialist structuring — multiple income streams, different tenures, different exit strategies within a single capital stack.

We advise on all of these. Senior and stretched senior for large-scale urban multifamily. Development finance for suburban BTR where the format is newer and lender education is still part of the process. Forward-fund structures where debt drawdown needs to align with institutional investment commitments. Mixed-tenure schemes where the capital stack reflects the complexity of the tenure mix.

The BTR development lending market is constructive for experienced sponsors with strong operator relationships and realistic cost plans. Lenders want to see evidence of local rental demand, a credible lease-up timeline, and an operating model that demonstrates long-term income stability.

Well-positioned BTR development applications are attracting competitive terms from multiple lenders.`,
  },
  {
    templateName: 'Clients — BTR — 3. Investment & Acquisition',
    heroImage: 'btr_03.jpg',
    posterTheme: 'BTR INVESTMENT',
    posterHeadline: 'BTR Investment & Acquisition Advisory',
    posterSubline: 'Portfolio debt, platform acquisitions and stabilised asset finance',
    cardTitles: ['Multifamily Portfolios', 'Single-Family Portfolios', 'Stabilised Acquisitions', 'Platform Acquisitions'],
    linkedin: `Stabilised BTR assets are commanding some of the most competitive debt terms in UK real estate. Banks, insurance companies, and institutional lenders are all actively deploying — and the competition is driving margins to levels that reflect BTR's status as a defensive, income-generating asset class.

The investment lending market is deep. Portfolio-level financing across multiple BTR assets, single-asset acquisition debt for stabilised schemes with proven occupancy, platform financing for operators assembling portfolios at scale, and forward-fund investment structures where debt needs to sit alongside institutional equity.

We advise on all of these. The optimal structure depends on the borrower's strategy — a bank revolving credit facility solves a different problem from an insurance company fixed-rate term loan. Both are available. The question is which structure best fits your capital requirements and hold period.

The BTR investment lending market rewards borrowers who run competitive processes. A single bank approach will produce a term sheet. A structured process across 8-10 lenders will produce materially better terms. We see this on every mandate.

BTR investment debt is not hard to find. The challenge is finding the optimal structure and the best pricing across the full range of available capital.`,
  },
  {
    templateName: 'Clients — BTR — 4. Refinancing',
    heroImage: 'btr_04.jpg',
    posterTheme: 'BTR REFINANCING',
    posterHeadline: 'BTR Refinancing & Debt Optimisation',
    posterSubline: 'Development exit, equity release and portfolio consolidation for BTR assets',
    cardTitles: ['Development Exit', 'Equity Release', 'Portfolio Consolidation', 'Green BTR Finance'],
    linkedin: `BTR rental growth has outperformed most other asset classes over the last three years. Urban multifamily rents, suburban rental yields, and portfolio-level NOI have all moved in borrowers' favour. The question is whether existing debt facilities reflect this.

In most cases, they do not. Facilities written during the development phase or at an earlier stage of portfolio assembly were priced in a less competitive market. Today, with more lenders actively targeting stabilised BTR exposure and margins at historic lows, the refinancing opportunity is significant.

We are advising several BTR sponsors on refinancings right now. Development exit — replacing construction facilities with long-term investment debt as schemes lease up. Equity release — refinancing at higher leverage once occupancy is proven to free capital for pipeline acquisitions. Portfolio consolidation — merging bilateral facilities into single portfolio-level arrangements. Green finance — accessing sustainability-linked margin reductions for new-build BTR with strong EPC credentials.

Each of these refinancing strategies requires a different lender approach. Development exit lenders and long-term investment debt lenders are often different institutions with different mandates.

BTR refinancing is about capturing value. The market has moved materially in borrowers' favour.`,
  },
  {
    templateName: 'Clients — BTR — 5. Market Insight',
    heroImage: 'btr_05.jpg',
    posterTheme: 'BTR MARKET UPDATE',
    posterHeadline: 'BTR Lending — What We Are Seeing Now',
    posterSubline: 'Current market conditions from our live build-to-rent mandates',
    cardTitles: ['Record Institutional Capital', 'Suburban BTR Emerging', 'Margins Compressing', 'Regional Demand Growing'],
    linkedin: `Here is what we are seeing in the BTR lending market from our active mandates.

Record institutional capital is flowing in. BTR is attracting more institutional investment than any other UK real estate sector. Pension funds, insurance companies, and sovereign wealth vehicles are all increasing allocations. Lending appetite is following directly — lenders want exposure to the asset class that institutional investors are backing.

Suburban BTR is emerging as accepted. Single-family rental was a niche product two years ago. Today, several mainstream lenders have dedicated suburban BTR policies and underwriting frameworks. The asset class is no longer experimental — it is institutional.

Margins are compressing to historic lows. Competition among lenders for stabilised BTR is intense. Best-in-class urban multifamily schemes are achieving margins that would have been unthinkable three years ago. This is not a temporary promotional rate — it reflects genuine structural competition.

Regional demand is growing rapidly. BTR lending appetite has expanded well beyond London. Manchester, Birmingham, Leeds, Edinburgh, and Bristol are all active markets with strong institutional presence. Regional BTR is no longer a secondary strategy — for many lenders, it is now a core allocation.

The BTR lending market is the most competitive in UK commercial real estate. Borrowers who run full market processes are capturing that competition.`,
  },
  {
    templateName: 'Clients — BTR — 6. Partnership Call',
    heroImage: 'btr_06.jpg',
    posterTheme: 'BTR ADVISORY',
    posterHeadline: 'Your Specialist BTR Finance Partner',
    posterSubline: 'Independent advisory for BTR developers, investors and platform operators',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `BTR is the UK real estate sector where speed and precision in debt advisory matter most. The market moves fast — institutional capital deploys quickly, development timelines are tight, and acquisition processes are competitive. Debt advisory that takes months rather than weeks costs clients money.

That is why we invest in understanding our clients' strategies and pipelines before deals go live. When a BTR opportunity comes — a development site, a stabilised acquisition, a portfolio refinancing — we already know which lenders to approach, how to position the credit, and what terms are achievable.

Turning Point Capital has advised on over £2 billion of transactions across the hospitality and living sectors. BTR is one of our most active areas. Urban multifamily, suburban single-family rental, platform finance, and portfolio debt — we cover the full spectrum.

Our lender network includes every significant BTR lending participant in the UK market. Banks, insurance companies, debt funds, and institutional investors. Our independence means we are not tied to any lender panel. Our competitive process means every client sees the best terms available.

BTR debt advisory is about more than finding a lender. It is about finding the right structure, the right pricing, and the right partner for your specific strategy.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGISTICS (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — Logistics — 1. Sector Overview',
    heroImage: 'logistics_01.jpg',
    posterTheme: 'LOGISTICS FINANCE',
    posterHeadline: 'Specialist Logistics & Industrial Debt Advisory',
    posterSubline: 'Big-box distribution, urban logistics, multi-let industrial and cold storage',
    cardTitles: ['Big-Box Distribution', 'Urban Logistics', 'Multi-Let Industrial', 'Specialist & Cold Storage'],
    linkedin: `Logistics is the most sought-after commercial real estate asset class among UK lenders. Margins are at historic lows for quality assets. Multiple lenders compete on every deal. The structural tailwinds — e-commerce growth, supply chain reshoring, last-mile demand — continue to drive both occupier demand and lender appetite.

But logistics is not one market. Big-box distribution centres, urban last-mile facilities, multi-let industrial estates, cold storage, and data centres each have different lender pools, different pricing, and different underwriting approaches.

Turning Point Capital advises across the full logistics spectrum. Big-box development and investment finance, urban logistics for last-mile operations, multi-let industrial portfolios, and specialist facilities including cold storage and temperature-controlled logistics.

The logistics lending market is deep and competitive. The challenge is not finding a lender — every lender wants logistics exposure. The challenge is finding the best terms across the full range of available capital, and structuring the facility optimally for the borrower's hold period and business plan.

We run competitive processes on every logistics mandate. That is how we ensure our clients capture the full benefit of the market's appetite for this asset class.`,
  },
  {
    templateName: 'Clients — Logistics — 2. Development Finance',
    heroImage: 'logistics_02.jpg',
    posterTheme: 'LOGISTICS DEVELOPMENT',
    posterHeadline: 'Logistics Development Finance Specialists',
    posterSubline: 'Speculative, pre-let and specialist warehouse development',
    cardTitles: ['Speculative Logistics', 'Pre-Let Development', 'Urban Infill', 'Cold Storage & Specialist'],
    linkedin: `Logistics development finance benefits from the strongest occupier demand in UK commercial real estate. In supply-constrained markets, speculative logistics development is being financed on terms that reflect the near-certainty of tenant demand. Pre-let schemes with strong covenant tenants and long lease commitments attract even more competitive structures.

The development lending market splits by format. Big-box distribution centres above 100,000 sq ft attract different lenders from mid-box urban logistics on constrained sites. Cold storage and temperature-controlled facilities require specialist lenders who understand the higher capex and the operational requirements.

We advise on all of these. Speculative big-box and mid-box development in supply-constrained locations. Pre-let build-to-suit schemes where the tenant covenant and lease length underpin the financing. Urban infill logistics on smaller sites with strong last-mile demand. Cold storage and specialist facilities where the lender needs to understand the operational model.

The logistics development lending market is well-supported. Lenders want construction exposure in the sector. The terms available reflect that enthusiasm — particularly for experienced sponsors in established logistics locations with strong planning positions and realistic cost plans.`,
  },
  {
    templateName: 'Clients — Logistics — 3. Investment & Acquisition',
    heroImage: 'logistics_03.jpg',
    posterTheme: 'LOGISTICS INVESTMENT',
    posterHeadline: 'Logistics Investment & Acquisition Advisory',
    posterSubline: 'Portfolio debt, single-asset acquisition and sale-leaseback structures',
    cardTitles: ['Logistics Portfolios', 'Single-Asset Acquisition', 'Sale & Leaseback', 'Cross-Border Logistics'],
    linkedin: `Logistics investment debt is the most competitive area of UK commercial real estate lending. Every major bank, insurance company, and institutional lender wants logistics exposure. The result is intense competition on every quality deal — and margins at levels that no other asset class can match.

The investment lending market covers the full spectrum. Multi-asset logistics portfolios financed through a single facility. Single-asset acquisitions where speed of execution is critical. Sale-and-leaseback transactions for logistics occupiers monetising their property assets. Cross-border pan-European mandates requiring multi-jurisdiction structuring.

We advise on all of these. The optimal structure depends on the borrower's strategy. A bank revolving facility, an insurance company fixed-rate loan, and a debt fund stretched senior structure each solve different problems. All are available for quality logistics assets.

The question is not whether you can finance a logistics acquisition — you almost certainly can. The question is whether you are accessing the best structure and pricing across the full range of lenders competing for your deal.

We run competitive processes on every logistics mandate because the gap between an average offer and the best offer is wider in logistics than in any other sector. That is what market competition creates.`,
  },
  {
    templateName: 'Clients — Logistics — 4. Refinancing',
    heroImage: 'logistics_04.jpg',
    posterTheme: 'LOGISTICS REFINANCING',
    posterHeadline: 'Logistics Refinancing & Equity Release',
    posterSubline: 'Capturing value appreciation and lender competition in refinancing terms',
    cardTitles: ['Maturity Refinancing', 'Equity Release', 'Green Logistics Finance', 'Portfolio Consolidation'],
    linkedin: `Logistics asset values have appreciated significantly over the last five years. Rental growth has been strong. Occupancy rates remain near 100% for quality assets in established locations. The lending market has become progressively more competitive.

For logistics owners, that creates one of the clearest refinancing opportunities in commercial real estate. Facilities written even two or three years ago were priced in a less competitive market. Today, with more lenders actively seeking logistics exposure and margins at historic lows, material improvements are available.

The equity release opportunity is particularly significant. Logistics assets that were financed at conservative leverage based on pre-appreciation values can often be refinanced at the same leverage ratio — releasing significant equity as the base value has grown.

We are advising several logistics sponsors on refinancings. Maturity replacements at improved margins, equity release to fund portfolio expansion, green finance overlays for assets with solar PV, EV charging, and strong energy credentials, and portfolio consolidation from bilateral into single-facility arrangements.

Logistics refinancing is about capturing the value that appreciation and lender competition have created. The market has moved substantially in borrowers' favour.`,
  },
  {
    templateName: 'Clients — Logistics — 5. Market Insight',
    heroImage: 'logistics_05.jpg',
    posterTheme: 'LOGISTICS MARKET UPDATE',
    posterHeadline: 'Logistics Lending — What We Are Seeing Now',
    posterSubline: 'Current market conditions from our live logistics mandates',
    cardTitles: ['Lender Competition Intense', 'Urban Logistics Premium', 'ESG Driving Appetite', 'Development Appetite Strong'],
    linkedin: `Here is what we are seeing in the logistics lending market from our active mandates.

Lender competition is intense. Logistics remains the most sought-after CRE asset class among UK lenders. Every deal attracts multiple competing term sheets. Margins continue to compress for quality assets in established locations.

Urban logistics commands a premium. Last-mile urban facilities on constrained sites are attracting the most competitive terms from lenders — reflecting both the supply constraint and the rental growth trajectory. Urban logistics margins are now tighter than big-box in many cases.

ESG is driving terms. New-build logistics with strong sustainability credentials — solar PV, EV charging, BREEAM Excellent, net-zero operational carbon — is attracting the most competitive financing. Green loan frameworks and sustainability-linked margins are now standard for quality schemes.

Development appetite is strong. Pre-let and speculative logistics development is well-supported by lenders. Speculative development in supply-constrained geographies is being financed with confidence because occupier demand data is so strong. Pre-let schemes with long lease commitments are attracting terms that approach investment-grade pricing.

The logistics lending market is the most borrower-friendly in UK commercial real estate. Running a competitive process across the full lender landscape is how you capture that.`,
  },
  {
    templateName: 'Clients — Logistics — 6. Partnership Call',
    heroImage: 'logistics_06.jpg',
    posterTheme: 'LOGISTICS ADVISORY',
    posterHeadline: 'Your Specialist Logistics Finance Partner',
    posterSubline: 'Independent advisory for logistics developers, investors and occupiers',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `In a market where every lender wants logistics exposure, the value of specialist advisory is in optimisation rather than access. Finding a lender is not the challenge. Finding the best structure, the best pricing, and the best covenant package across the full range of competing lenders — that is where advisory earns its fee.

We run structured competitive processes on every logistics mandate. Typically 8 to 12 lenders see the deal. The result is genuine pricing tension and significantly better terms than a bilateral approach would produce.

Turning Point Capital has advised on over £2 billion of commercial real estate debt transactions. Logistics is one of our most active sectors — big-box development, urban last-mile, multi-let industrial portfolios, cold storage, and cross-border European mandates.

We track logistics lender appetite in real time. We know which lenders are increasing their allocation, which are constrained, which have specific format preferences, and where the marginal pricing sits for each deal type.

The logistics lending market is the most competitive in UK commercial real estate. A competitive advisory process is how borrowers capture the full benefit of that competition.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SFH (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — SFH — 1. Sector Overview',
    heroImage: 'sfh_01.jpg',
    posterTheme: 'HOUSEBUILDER FINANCE',
    posterHeadline: 'Specialist Housebuilder Debt Advisory',
    posterSubline: 'Residential development, land acquisition, mixed-tenure and modular housing finance',
    cardTitles: ['Residential Development', 'Land Acquisition', 'Mixed-Tenure Schemes', 'Modular & MMC'],
    linkedin: `Housebuilder finance is the backbone of UK residential development. From small infill sites to large estate-scale schemes, the lending market serves every scale of developer — but the terms, the lenders, and the structures vary dramatically depending on track record, scheme size, and site characteristics.

A 10-unit scheme on a constrained urban site with complex planning conditions requires a fundamentally different lender from a 300-home estate on a clean greenfield plot with full planning consent. A first-time developer will see different terms from an established housebuilder with a proven sales track record.

Turning Point Capital advises across the full spectrum of housebuilder finance. Residential development loans from 5 to 500+ units, land acquisition and planning bridge facilities, mixed-tenure schemes combining private sale with affordable and shared ownership, and modular and modern methods of construction financing.

We know which lenders specialise in each segment, what track record they require, what leverage they will offer, and where the pricing sits. The housebuilder lending market is deep but segmented. A competitive process across the right lenders for your specific scheme produces materially better terms than approaching one or two banks.`,
  },
  {
    templateName: 'Clients — SFH — 2. Development Finance',
    heroImage: 'sfh_02.jpg',
    posterTheme: 'RESIDENTIAL DEVELOPMENT',
    posterHeadline: 'Residential Development Finance Specialists',
    posterSubline: 'Small-scale infill through to estate-scale housebuilding programmes',
    cardTitles: ['Small-Scale Residential', 'Estate-Scale Development', 'Land & Planning', 'Affordable Housing'],
    linkedin: `Residential development finance is the core product that housebuilders need to grow. Senior debt against consented sites, stretched senior for schemes requiring higher leverage, mezzanine to bridge the equity gap, and land facilities to secure sites before planning is granted.

The lending market is deep. Clearing banks, challenger banks, specialist development lenders, debt funds, and housing-focused finance companies all participate. Each has different appetite — minimum and maximum scheme sizes, geographic preferences, track record requirements, and product type preferences.

We advise on the full range. Small-scale schemes of 5 to 50 units on constrained urban sites. Estate-scale housebuilding programmes with phased drawdown aligned to build and sales programmes. Land acquisition and planning promotion finance for converting raw land to development-ready sites. Affordable housing development in partnership with housing associations and local authorities.

The development lending market for residential rewards well-prepared applications. Consented sites with realistic cost plans, credible sales evidence, and an experienced sponsor will attract competitive terms from multiple lenders. Planning risk is still the biggest differentiator in pricing — sites with full consent command significant margin advantages over those still in the planning process.`,
  },
  {
    templateName: 'Clients — SFH — 3. Investment & Acquisition',
    heroImage: 'sfh_03.jpg',
    posterTheme: 'SFH INVESTMENT',
    posterHeadline: 'Land Bank & Portfolio Finance for Housebuilders',
    posterSubline: 'Working capital, land options and build-to-rent crossover structures',
    cardTitles: ['Land Bank Finance', 'Build-to-Rent Crossover', 'Part-Exchange Facilities', 'Strategic Land'],
    linkedin: `Housebuilder finance goes beyond individual site development loans. Growing housebuilders need working capital facilities against their land bank, revolving credit to fund multiple sites simultaneously, strategic land financing for longer-term positions, and part-exchange facilities to support sales programmes.

The build-to-rent crossover is also creating new financing opportunities. Housebuilders selling bulk units into the BTR market can access forward-fund structures and bulk sale arrangements that change the financing dynamic entirely. Instead of traditional development finance with a sales-driven exit, the deal becomes a pre-sold construction contract with a different risk profile and different lender appetite.

We advise on all of these. Portfolio-level revolving development facilities that cover multiple sites. Land bank finance for consented and strategic land. Part-exchange working capital lines. Forward-fund and bulk sale structures for housebuilders selling into the institutional rental market.

The housebuilder lending market has evolved significantly. It is no longer just about site-by-site development loans. Lenders are offering more sophisticated products to growing developers — and borrowers who understand the full range of available structures can build more capital-efficient businesses.`,
  },
  {
    templateName: 'Clients — SFH — 4. Refinancing',
    heroImage: 'sfh_04.jpg',
    posterTheme: 'HOUSEBUILDER REFINANCING',
    posterHeadline: 'Housebuilder Facility Renewal & Optimisation',
    posterSubline: 'Upsizing, portfolio consolidation and covenant improvement for developers',
    cardTitles: ['Facility Renewal', 'Portfolio Restructuring', 'Covenant Optimisation', 'Growth Capital'],
    linkedin: `Housebuilder development facilities are typically renewed every two to three years. Each renewal is an opportunity — not just to replace a maturing facility, but to secure better terms that reflect the business's growth, track record, and current market conditions.

We see this on every renewal mandate. A housebuilder who secured their first development facility as a small operator with limited track record can often refinance into a materially improved facility once they have delivered several successful schemes. Larger site limits, higher leverage, more flexible drawdown, and lower margins.

The consolidation opportunity is also significant. Many housebuilders have accumulated multiple site-specific facilities with different lenders, different terms, and different reporting requirements. Consolidating into a single revolving development facility is more efficient, cheaper, and easier to manage.

We are advising several housebuilders on facility renewals and restructuring. The themes are consistent — demonstrating track record to unlock better terms, consolidating bilateral facilities into portfolio-level arrangements, optimising covenants to reflect current business performance, and securing additional capacity to support growth plans.

Facility renewal is not an administrative exercise. It is a strategic financing decision that directly affects the capital efficiency of the business.`,
  },
  {
    templateName: 'Clients — SFH — 5. Market Insight',
    heroImage: 'sfh_05.jpg',
    posterTheme: 'HOUSEBUILDER MARKET UPDATE',
    posterHeadline: 'Housebuilder Lending — Current Conditions',
    posterSubline: 'What we are seeing across our live residential development mandates',
    cardTitles: ['SME Housebuilder Support', 'Planning Risk Pricing', 'Modular Gaining Traction', 'Affordable Premium'],
    linkedin: `Here is what we are seeing in the housebuilder lending market from our active mandates.

SME housebuilder support is growing. Government policy is explicitly driving lender appetite for SME residential development. Several new entrants have launched dedicated programmes. Existing lenders are expanding their SME allocation. The result is more competition and better terms for developers building fewer than 100 units per year.

Planning risk pricing has become more sophisticated. The gap between consented sites and sites in planning has widened. Lenders are offering significantly better terms for sites with full planning consent — the margin differential can be 100-200bps. For developers, this makes the economics of acquiring consented sites versus promoting sites through planning materially different.

Modular and MMC is gaining traction. Mainstream lenders are starting to finance modern methods of construction. Previously the domain of specialist funds, modular housing is now attracting bank appetite — particularly from lenders with sustainability mandates and government housing commitments.

Affordable housing components improve terms. Schemes with affordable housing elements are attracting improved pricing from several lenders. The income certainty of registered provider purchasers reduces sales risk and gives lenders comfort — reflected directly in margin and leverage.

The housebuilder lending market is constructive and evolving. More options exist today than at any point in the last five years.`,
  },
  {
    templateName: 'Clients — SFH — 6. Partnership Call',
    heroImage: 'sfh_06.jpg',
    posterTheme: 'HOUSEBUILDER ADVISORY',
    posterHeadline: 'Your Specialist Housebuilder Finance Partner',
    posterSubline: 'Independent advisory for residential developers and housebuilders',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `Housebuilder finance is about more than individual site loans. It is about building a capital structure that supports the growth trajectory of the business. The right development facility, the right leverage, the right covenant package — these decisions compound over time and determine how fast and how efficiently a housebuilder can scale.

That is why the facility renewal and new site financing process deserves proper advisory, not a quick call to the existing bank. The existing bank will offer terms that suit their book. A competitive process across 8 to 12 lenders will reveal what the market actually offers.

Turning Point Capital has advised on over £2 billion of commercial real estate debt transactions. Our residential development experience covers the full range — small infill sites, estate-scale programmes, land bank facilities, mixed-tenure schemes, and modular housing.

We work with housebuilders at every stage. First facilities for developers stepping up from single-site builds. Renewal and upsizing for established operators. Portfolio consolidation for growing businesses with multiple bilateral arrangements.

The housebuilder lending market is deep and competitive. A structured advisory process is how developers access the best terms and the most capital-efficient structures.`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LEISURE (6 posts)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    templateName: 'Clients — Leisure — 1. Sector Overview',
    heroImage: 'leisure_01.jpg',
    posterTheme: 'LEISURE FINANCE',
    posterHeadline: 'Specialist Leisure & Entertainment Debt Advisory',
    posterSubline: 'Holiday parks, cinemas, gyms, experiential venues and F&B',
    cardTitles: ['Holiday Parks & Resorts', 'Cinemas & Entertainment', 'Gyms & Wellness', 'Experiential & F&B'],
    linkedin: `Leisure property finance requires a lender who understands operational income. A holiday park, a cinema complex, a gym portfolio, and an experiential dining venue are all classified as leisure — but they are fundamentally different businesses with different revenue models, different risk profiles, and different lender pools.

Holiday parks generate income from lodge sales, pitch fees, and on-site spending. Cinemas depend on admissions and ancillary revenue. Gyms run on membership economics. Experiential venues live on event-driven footfall. Each has its own underwriting requirements.

Turning Point Capital advises across the full leisure spectrum. Holiday parks and resorts, cinema and entertainment complexes, gym and wellness portfolios, experiential and competitive socialising venues, and food and beverage operations with property backing.

The leisure lending market has recovered strongly. Lenders who stepped back during the pandemic are re-engaging. Trading data from the recovery period has built the evidence base that lenders needed. Several sub-sectors — particularly holiday parks — are performing better than pre-pandemic levels.

Leisure finance is operational finance. The lenders who understand this are the ones worth speaking to. We know who they are.`,
  },
  {
    templateName: 'Clients — Leisure — 2. Development Finance',
    heroImage: 'leisure_02.jpg',
    posterTheme: 'LEISURE DEVELOPMENT',
    posterHeadline: 'Leisure Development & Expansion Finance Specialists',
    posterSubline: 'Holiday park expansion, new venue development and mixed-use leisure',
    cardTitles: ['Holiday Park Expansion', 'Leisure Centre Development', 'Venue Fit-Out', 'Mixed-Use Leisure'],
    linkedin: `Leisure development finance covers a wide range of project types, each with its own financing dynamics. Holiday park expansion — new lodges, pods, glamping units, and on-site facilities — is one of the strongest performing areas, with short payback periods and strong ROI that lenders readily support.

New leisure centre development — multi-operator schemes with cinema, gym, F&B, and entertainment anchors — requires lenders comfortable with the complexity of multiple operating businesses within a single property. Venue fit-out and refurbishment finance, where the operator needs capex to upgrade the offer and drive footfall. Mixed-use leisure-led schemes combining entertainment with retail, residential, and workspace.

We advise on all of these. The lender selection for each is different. Holiday park lenders understand lodge sales economics and pitch fee income. Leisure centre lenders evaluate multi-tenant operating income. Venue fit-out lenders assess payback periods and operator track records.

The leisure development lending market is active for experienced operators with strong trading histories. Lenders want to see proven demand, realistic revenue projections, and an operator who has delivered similar projects before. Deals that demonstrate all three are attracting competitive terms.`,
  },
  {
    templateName: 'Clients — Leisure — 3. Investment & Acquisition',
    heroImage: 'leisure_03.jpg',
    posterTheme: 'LEISURE INVESTMENT',
    posterHeadline: 'Leisure Investment & Acquisition Advisory',
    posterSubline: 'Holiday park portfolios, operator buyouts and single-asset acquisitions',
    cardTitles: ['Holiday Park Portfolios', 'Leisure Portfolio Debt', 'Single-Asset Acquisition', 'Operator Buyouts'],
    linkedin: `Leisure sector acquisitions combine property and operational business lending. The borrower is acquiring a trading business as much as a physical asset, and the financing needs to reflect that. Operational covenants, trading performance tests, and management quality assessments sit alongside standard property metrics.

Holiday parks are the standout sub-sector for acquisition finance. Strong cash generation, defensive leisure spending patterns, and proven post-pandemic recovery have made holiday parks one of the most attractive operating asset classes for lenders. Multi-site portfolios are attracting competitive terms from multiple participants.

Beyond holiday parks, we advise on cinema and entertainment portfolio acquisitions, gym portfolio debt, single-asset leisure acquisitions with proven trading histories, and management buyouts of leisure operating businesses where the team is the primary asset.

Each requires different lender selection. Holiday park lenders, cinema lenders, gym lenders, and experiential leisure lenders are often different institutions with different mandates and different underwriting frameworks.

The leisure investment lending market rewards borrowers who present well-structured applications with strong trading data and experienced management teams. Operational quality is the key credit differentiator.`,
  },
  {
    templateName: 'Clients — Leisure — 4. Refinancing',
    heroImage: 'leisure_04.jpg',
    posterTheme: 'LEISURE REFINANCING',
    posterHeadline: 'Leisure Refinancing & Covenant Reset',
    posterSubline: 'Capturing post-pandemic recovery in refinancing terms',
    cardTitles: ['Maturity Refinancing', 'Expansion Capital', 'Covenant Reset', 'Sale & Leaseback'],
    linkedin: `Leisure operators have recovered strongly from the pandemic. Many are now trading at or above pre-pandemic levels. Holiday parks in particular have seen record demand. The question is whether existing debt facilities reflect this recovery.

In most cases, they do not. Facilities written during or immediately after the pandemic were conservatively structured — lower leverage, wider margins, tighter covenants. Those terms reflected the uncertainty of the moment. The uncertainty has passed. The trading data now exists to support significantly improved terms.

We are advising several leisure operators on refinancings. Maturity replacements at improved margins reflecting current trading, covenant resets to align financial tests with post-recovery performance, expansion capital released through refinancing to fund new site acquisitions and development, and sale-and-leaseback advisory where operators want to monetise property to fund business growth.

The covenant reset opportunity is particularly significant. Many leisure operators had covenants set during the pandemic that no longer reflect the operational reality. Renegotiating these — or moving to a new lender with more appropriate covenant structures — can fundamentally change the financial flexibility available to the business.

Leisure refinancing is about capturing recovery. The market has moved. Existing debt should reflect that.`,
  },
  {
    templateName: 'Clients — Leisure — 5. Market Insight',
    heroImage: 'leisure_05.jpg',
    posterTheme: 'LEISURE MARKET UPDATE',
    posterHeadline: 'Leisure Lending — What We Are Seeing Now',
    posterSubline: 'Current market conditions from our live leisure sector mandates',
    cardTitles: ['Holiday Parks Dominant', 'Experiential Leisure Growing', 'Gym Market Stabilised', 'Operational Focus'],
    linkedin: `Here is what we are seeing in the leisure lending market from our active mandates.

Holiday parks are dominant. Holiday park operators are attracting the most competitive leisure debt terms. Record staycation demand, strong lodge sales, and rising pitch fees have made this sub-sector a favourite among lenders. Multiple banks and specialist lenders are actively competing for quality holiday park exposure.

Experiential leisure is gaining traction. Competitive socialising, immersive entertainment, and experiential dining venues are attracting growing lender interest. The early scepticism is fading as trading data accumulates and the sector demonstrates its resilience. Several mainstream lenders now have dedicated policies for experiential leisure.

Gyms have stabilised. Budget and premium gym operators have recovered strongly from pandemic disruption. Lender appetite is returning — several banks that paused gym lending two years ago are re-engaging. Membership economics and long lease income are the key underwriting factors.

Operational focus is intensifying. Across all leisure sub-sectors, lenders are placing greater emphasis on operator quality, management track record, and trading performance than on pure property fundamentals. The property secures the loan, but the operator determines whether it gets repaid.

The leisure lending market is recovering and diversifying. The opportunities are there for operators with strong trading data.`,
  },
  {
    templateName: 'Clients — Leisure — 6. Partnership Call',
    heroImage: 'leisure_06.jpg',
    posterTheme: 'LEISURE ADVISORY',
    posterHeadline: 'Your Specialist Leisure Sector Finance Partner',
    posterSubline: 'Independent advisory for leisure operators, developers and investors',
    cardTitles: ['No Obligation', 'Market Intelligence', 'Deal Origination', 'Long-Term Partnership'],
    linkedin: `Leisure finance is where hospitality expertise and operational business lending intersect. It is not a mainstream asset class — it requires advisers who understand operating businesses, seasonal cash flows, management quality, and the specific dynamics of each leisure sub-sector.

That is exactly our background. Turning Point Capital was built on hospitality and leisure finance. We understand the operating models, the lender requirements, and the structuring nuances that determine whether a leisure financing works or fails.

Our lender network spans every significant leisure lending participant — specialist hospitality banks, challenger lenders with leisure appetite, debt funds comfortable with operational risk, and institutional capital seeking long-income leisure exposure.

We have advised on over £2 billion of transactions across the hospitality and leisure sector. Holiday park portfolios, cinema groups, gym platforms, experiential venues, mixed-use leisure schemes, and single-asset acquisitions.

The leisure lending market has recovered. Lenders are re-engaging. Trading data from the recovery period has answered the questions they had during the pandemic. For operators with strong performance, the financing market is more competitive than it has been in years.`,
  },
];


// ─── Main execution ──────────────────────────────────────────────────────────

async function main() {
  console.log('Backfilling LinkedIn posts + poster HTML for client subsector templates...\n');

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const data of ALL_LINKEDIN_DATA) {
    // Look up the template by name
    const result = await pool.query(
      `SELECT id FROM templates WHERE name = $1 AND tenant = $2`,
      [data.templateName, TENANT]
    );

    if (result.rows.length === 0) {
      console.log(`  NOT FOUND: ${data.templateName}`);
      notFound++;
      continue;
    }

    const templateId = result.rows[0].id;

    // Build the poster HTML
    const imageBase64 = heroBase64(data.heroImage);
    const posterHtml = buildLinkedInPosterHtml(imageBase64);

    // Update the template
    const updateResult = await pool.query(
      `UPDATE templates
       SET linkedin_content = $1, linkedin_poster_html = $2
       WHERE id = $3`,
      [data.linkedin, posterHtml, templateId]
    );

    if (updateResult.rowCount && updateResult.rowCount > 0) {
      console.log(`  ✓ ${data.templateName}`);
      updated++;
    } else {
      console.log(`  SKIP: ${data.templateName}`);
      skipped++;
    }
  }

  console.log(`\nDone! Updated: ${updated}, Not found: ${notFound}, Skipped: ${skipped}`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
