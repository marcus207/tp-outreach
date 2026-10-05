/**
 * Rewrite all 48 introducer email bodies with substantive, specialism-specific content.
 * 50% introducer fee is the lead hook in every email.
 *
 * Run: npx tsx scripts/update-introducer-emails.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function buildEmailHtml(bodyParagraphs: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 16px;">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#0f1a2e;padding:16px 28px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">TP</span><span style="color:#9ca3af;font-size:12px;margin-left:8px;font-family:Arial,sans-serif;">Turning Point Capital</span></td>
</tr></table>
</td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#4db8a4,#74DFF6);font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 24px;font-family:Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:15px;color:#0f1a2e;line-height:1.7;">Hey {{first_name}},</p>
${bodyParagraphs}
<p style="margin:0;"><a href="https://tp.finance/introducers" style="color:#0D9488;font-size:14px;font-weight:600;text-decoration:none;">https://tp.finance/introducers</a></p>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:20px 28px;font-family:Arial,sans-serif;">
<p style="margin:0;font-size:14px;font-weight:700;color:#0f1a2e;">Marcus Emadi</p>
<p style="margin:2px 0 0;font-size:13px;color:#4db8a4;font-weight:600;">Managing Director</p>
<p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Turning Point Capital Advisory</p>
<p style="margin:4px 0 0;font-size:12px;"><a href="mailto:marcus@tp.finance" style="color:#9ca3af;text-decoration:none;">marcus@tp.finance</a> · <a href="https://tp.finance" style="color:#9ca3af;text-decoration:none;">tp.finance</a></p>
</td></tr>
<tr><td style="background:#f8f9fb;padding:12px 28px;border-top:1px solid #e5e7eb;text-align:center;">
<p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Turning Point Capital Advisory Ltd · London · <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>
</td></tr>
</table>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">${text}</p>`;
}

interface IntroducerContent {
  emails: Array<{ angle: string; paragraphs: string[] }>;
}

const CONTENT: Record<string, IntroducerContent> = {
  Accountant: {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. For accountancy firms with property-active clients, that is a significant revenue line from a single introduction.',
          'We are a specialist debt advisory firm arranging commercial property finance across the UK and Europe. Hotels, residential, logistics, offices, care homes, student accommodation. Our advisory fee is typically 1% of the facility, so on a GBP 10m deal your share could be up to GBP 50k.',
          'Your clients already trust you with their financial affairs. When they need debt finance for a property transaction, introducing a specialist adviser adds value to the relationship and earns you a fee. No cost to your client, no disruption to your retainer.',
          'If any of your clients own or develop commercial property, a quick call would be useful.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'Accountants often spot the need for debt finance before the client does. Tax planning ahead of a disposal, structuring a new SPV for an acquisition, reviewing interest costs across multiple facilities. These are all moments where introducing a debt adviser earns you up to 50% of our advisory fee.',
          'The deals we see from accountant introductions include acquisitions where the client needs senior debt, refinancings where they want to benchmark their existing lender, development finance for ground-up schemes, and equity release from assets that have grown in value.',
          'We work across every major commercial property sector. The deal size sweet spot is GBP 2m to GBP 50m, but we have arranged larger. If it involves property debt, we can help, and you earn a fee for the introduction.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'The numbers are straightforward. Up to 50% of our advisory fee on the first transaction you refer. 25% on every subsequent deal. Paid within 14 days of completion.',
          'Our advisory fee is typically 1% of the facility, spread over 12 months. So on a GBP 10m deal, the advisory fee is GBP 100k, and your introducer share would be up to GBP 50k. On a GBP 25m deal, up to GBP 125k.',
          'There is no cost to your client beyond what they would pay going direct. Our fee covers the competitive lender process, term negotiation, and full management through to drawdown. Your client gets a better outcome and you earn a meaningful fee for making the introduction.',
          'We document everything in a simple introducer agreement. Clear terms, transparent calculations. You have seen plenty of these.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Here is what a 50% introducer fee looks like in practice.',
          'A tax adviser introduced a client refinancing a GBP 12m hotel portfolio. We secured a 125bps margin improvement, saving the client over GBP 150k in annual interest. The introducer fee was over GBP 50k.',
          'An audit partner introduced a client acquiring a care home group. Three facilities, GBP 18m total. We sourced a specialist healthcare lender with better leverage and covenants than the two banks the client had approached directly. The introducer fee was over GBP 80k.',
          'A corporate accountant introduced a developer needing GBP 8m construction finance. We arranged stretched senior that reduced the equity requirement by GBP 1.5m. The introducer fee was over GBP 35k.',
          'One introduction, one fee. These are real numbers from real deals.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You introduce your client by email or phone. We take it from there. You stay informed, your relationship stays intact, and when the deal completes you receive up to 50% of our advisory fee within 14 days.',
          'We meet the client, assess the deal, prepare a lender-ready information pack, run a competitive process, negotiate terms, and manage the transaction through to completion.',
          'The process is designed to make you look good. You brought them a specialist, they got a better deal, it cost them nothing extra, and you earned a fee for the introduction.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Final note on this. Up to 50% introducer fee on the first deal, 25% on every deal after that. Paid on completion, no upfront commitment.',
          'If any of your clients borrow against commercial property, or are likely to in the next 12 months, one short conversation is all it takes. Our best accountant partnerships generate multiple referrals a year and the fee income has become a real revenue line.',
          'Happy to share references from other accounting firms we work with. 15 minutes is all we need.',
        ],
      },
    ],
  },

  Lawyer: {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. For law firms with property clients, that means a single introduction on a GBP 15m transaction could generate over GBP 75k in referral income.',
          'We are a specialist debt advisory firm arranging commercial property finance across the UK and Europe. Hotels, residential, logistics, offices, care, student accommodation. We run competitive lender processes and handle the full financing from instruction to drawdown.',
          'You are already in the room when the financing conversation happens. You are doing the due diligence, reviewing the facility agreement, advising on the structure. Introducing a debt adviser is a natural extension of that relationship, and it pays well.',
          'If your clients borrow against property, a quick call would be useful.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'The deals law firms introduce tend to arrive at natural inflection points. A client acquiring a property and needing finance quickly. A refinancing where the existing facility is maturing. A development project needing construction finance before works start. A restructuring where the incumbent lender is exiting.',
          'Each of these is a moment where introducing us earns you up to 50% of our advisory fee, adds value to your client, and in most cases generates additional legal work for your firm. New facility agreements, security documentation, corporate structuring.',
          'If your client is accepting terms from a single lender without a competitive process, they are leaving money on the table. And you are leaving introducer fees on the table.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'Up to 50% of our advisory fee on the first deal. 25% on every subsequent referral. Paid within 14 days of completion.',
          'Our advisory fee is typically 1% of the facility amount. On a GBP 15m deal, your share would be up to GBP 75k on the first transaction. On a GBP 30m deal, up to GBP 150k.',
          'This does not conflict with your retainer. We handle the debt placement, you handle the legal work. In fact, the introduction usually generates additional legal fees. The financing creates documentation requirements that flow back to your firm.',
          'Clean introducer agreement. You have drafted hundreds of these, so you will find ours straightforward.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Some real numbers from law firm introductions.',
          'A property partner introduced a client buying a GBP 22m logistics portfolio. We found a lender offering 20bps lower margin and a 5-year term versus the client\'s bank. The introducer fee was over GBP 100k.',
          'A restructuring partner introduced a hospitality client facing a covenant breach. We placed the debt with a new lender within 4 weeks, avoiding enforcement. The introducer fee was over GBP 60k.',
          'A real estate associate introduced a developer needing GBP 8m construction finance after being turned down by two lenders. We sourced a specialist development lender. The introducer fee was over GBP 35k.',
          'One introduction per deal. The fees speak for themselves.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You send an email introducing your client. One line on the transaction is enough. We take it from there.',
          'We meet the client, assess the deal, run a competitive process, negotiate terms, and coordinate with the legal team through to drawdown. You stay informed, your relationship stays intact, and you receive up to 50% of our fee on completion.',
          'The introduction generates legal work, not competition. New facility agreements, security packages, corporate structuring. The debt advisory creates fees for your firm on top of the introducer payment.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Up to 50% on the first deal. 25% on every deal after that. Plus the additional legal work the financing generates.',
          'Several law firms refer to us regularly. The fee income is meaningful, the process is clean, and the client outcome is consistently better than going direct to a single lender.',
          'Worth 15 minutes to see if there is a fit.',
        ],
      },
    ],
  },

  Surveyor: {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. Surveyors are some of our strongest referral sources because you see financeable transactions before most other advisers.',
          'You are valuing assets, doing condition surveys, monitoring developments, and appraising acquisitions. You know the deal is happening before financing has been arranged. That is exactly the right moment to make an introduction that earns you a significant fee.',
          'We are a specialist debt advisory firm arranging commercial property finance across the UK and Europe. On a GBP 10m deal, your introducer share could be up to GBP 50k. No cost to your client, no conflict with your existing instruction.',
          'If your clients buy, build, or refinance commercial property, a quick conversation is worth having.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'The deals that come through surveyor introductions have a natural timing advantage. You are doing the valuation for an acquisition, so you know the deal is live. You are monitoring a development and know the borrower needs a new facility. You are conducting a red book valuation for a refinancing.',
          'Each of these is a moment where a single introduction earns you up to 50% of our advisory fee. And the introduction tends to generate additional surveying work, because lenders need valuations, development monitors, and condition surveys.',
          'You earn the introducer fee, you earn the surveying fees, and your client gets a better financing outcome. Everyone wins.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'Up to 50% on the first deal. 25% on every subsequent referral. Paid within 14 days of completion.',
          'Our advisory fee is typically 1% of the facility. On a GBP 10m transaction, your share would be up to GBP 50k. On a GBP 20m deal, up to GBP 100k.',
          'On top of the introducer fee, the financing usually generates surveying instructions. Lenders need red book valuations, development monitors need appointing, condition surveys get commissioned. Introducing a debt adviser brings work back to your practice.',
          'Simple introducer agreement, transparent fee calculations, payment within 14 days of deal completion.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Here is what a 50% introducer fee looks like from recent surveyor referrals.',
          'A building surveyor introduced a client converting a tired office building to residential. We arranged GBP 8.5m of stretched senior from a specialist development lender, GBP 2.5m more than the client\'s local bank had offered. The introducer fee was over GBP 40k, plus the surveyor was appointed as development monitor.',
          'A valuation surveyor introduced a care home operator refinancing three sites. We sourced a specialist healthcare lender offering a 50bps margin reduction. The introducer fee was over GBP 30k.',
          'A development monitor introduced a housebuilder needing a revolving facility across three sites. We arranged the facility from a single lender. The introducer fee was over GBP 45k, and the surveyor retained the monitoring instruction on all three schemes.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You introduce your client by email or phone. A brief note on the property and the financing need is helpful. We take it from there.',
          'We assess the deal, run a competitive lender process, and manage the transaction through to drawdown. You stay informed, your relationship stays intact, and you receive up to 50% of our advisory fee within 14 days of completion.',
          'For surveyors, the introduction often leads to additional instructions. Lender valuations, monitoring appointments, condition surveys. The financing creates surveying work on top of the introducer fee.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Up to 50% on the first deal. 25% on every deal after. Plus the surveying instructions that the financing generates.',
          'Several surveying practices refer to us regularly. The deals fit naturally with the work you already do and the fee income is meaningful.',
          'Worth a 15-minute call to see if there is a fit with your current client base.',
        ],
      },
    ],
  },

  Agent: {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. For property agents, that means a single introduction on a GBP 20m acquisition could generate over GBP 100k in referral income, on top of your agency fee.',
          'We are a specialist debt advisory firm arranging commercial property finance across the UK and Europe. Hotels, residential, logistics, offices, care homes, student accommodation. We handle the financing from instruction through to drawdown.',
          'You sit at the centre of most transactions. You know who is buying, who is selling, and who needs finance. Introducing a debt adviser at the right moment protects your agency fee by ensuring the deal completes, and earns you a substantial referral payment.',
          'If your clients borrow to acquire or develop commercial property, this is worth a conversation.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'The most natural introduction from agents is during an acquisition. You have negotiated the price and the client now needs financing. Introducing us at that moment earns you up to 50% of our advisory fee and increases the likelihood of the deal completing, which protects your agency fee.',
          'We also see introductions where an agent is advising on a disposal and the buyer needs financing to make it happen. Introducing us to the buyer accelerates the sale.',
          'Refinancings, development finance, and equity release also come through agent referrals. If a client has not reviewed their debt in three years, there is almost certainly a better deal available, and a GBP 50k+ introducer fee waiting.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'Up to 50% of our advisory fee on the first referral. 25% on every subsequent deal. Paid within 14 days of completion.',
          'Our fee is typically 1% of the facility, spread over 12 months. On a GBP 20m acquisition, the advisory fee is GBP 200k and your introducer share would be up to GBP 100k on the first deal. On a GBP 10m refinancing, up to GBP 50k.',
          'This sits alongside your agency fee, not instead of it. Your client gets a better financing outcome, you earn your agency commission plus an introducer fee, and the deal completes faster because the finance is handled by a specialist.',
          'Simple introducer agreement, transparent terms.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Real numbers from recent agent introductions.',
          'An investment agent introduced a buyer acquiring a GBP 30m logistics portfolio. We secured a facility 30bps tighter than the single bank the buyer had approached, saving over GBP 400k in interest. The introducer fee was over GBP 140k.',
          'A hotel agent introduced a hospitality group refinancing three hotels. The existing lender was pulling back. We found a specialist lender with better leverage and a longer term. The introducer fee was over GBP 70k.',
          'A development agent introduced a housebuilder buying a residential site. We arranged land bridge plus development loan. The introducer fee was over GBP 40k.',
          'One introduction, one fee. These are real deals from the last 12 months.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You introduce us to your client during the transaction. Email or phone call. We take it from there.',
          'We assess the financing need, run a competitive process, negotiate terms, and manage through to completion. You receive up to 50% of our advisory fee within 14 days.',
          'The main benefit for agents is deal certainty. If the buyer has proper financing, the deal completes and you earn your agency fee. If they do not, the deal falls over. Introducing a debt adviser early protects your commission and earns you a substantial referral payment on top.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Up to 50% on the first deal. 25% on every deal after. On top of your agency commission.',
          'Several agencies refer to us regularly. The referral income is a genuine revenue line, and it protects your core agency fee by ensuring the financing is handled properly.',
          'Worth 15 minutes to see if there is a fit.',
        ],
      },
    ],
  },

  Advisory: {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. For corporate advisory firms, that means a single introduction on a property-backed transaction could generate GBP 50k to GBP 150k in referral income.',
          'We are a specialist debt advisory firm focused on commercial real estate finance across the UK and Europe. Hotels, residential, logistics, offices, care, student accommodation. We run competitive lender processes and manage the full financing through to completion.',
          'You are advising on the transaction. We handle the debt. The two roles are complementary, and the introduction earns you a significant fee without any conflict with your existing retainer.',
          'If your clients have property-backed transactions in the pipeline, a quick call would be useful.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'The deals that come through advisory firms tend to be at the more structured end. Platform acquisitions, portfolio transactions, restructurings where existing debt needs replacing. These are larger tickets, which means larger introducer fees. Up to 50% of our advisory fee on every first referral.',
          'We also see introductions where the advisory firm is handling a corporate transaction and the property assets need refinancing as part of the deal. Separating operating businesses from property, or refinancing to fund a buyout.',
          'The common thread is complexity. These are not high street bank deals. They need a specialist who knows the lender market for their specific asset class. And that specialist advisory generates a fee that you share in.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'Up to 50% on the first deal. 25% on every subsequent referral. Paid within 14 days of completion.',
          'Our advisory fee is typically 1% of the facility. On a GBP 25m deal, your share would be up to GBP 125k. On a GBP 40m deal, up to GBP 200k. These are real numbers from transactions we have completed.',
          'This does not conflict with your own advisory fee. We handle the debt placement. You advise on the transaction strategy, structure, and negotiation. In most cases the introduction also creates additional advisory work as the financing drives decisions on corporate structure and capital allocation.',
          'Clean documentation, transparent calculations.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Recent numbers from advisory firm introductions.',
          'A corporate finance firm introduced a client acquiring a hotel platform with GBP 40m of property assets. We arranged a portfolio facility across 5 hotels. The introducer fee was over GBP 180k.',
          'A restructuring adviser introduced a property company with GBP 15m of maturing debt and a lender wanting to exit. We placed the debt with a new lender within 6 weeks. The introducer fee was over GBP 65k.',
          'A strategy consultancy introduced a family office deploying GBP 30m into UK logistics. We arranged acquisition facilities for three assets and a revolving credit line. The introducer fee was over GBP 130k.',
          'Up to 50% on the first deal. These are the kind of numbers that make referral partnerships worth building.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You make the introduction. We meet the client, assess the deal, and run a competitive lender process. You stay informed throughout and your relationship stays intact.',
          'Your firm earns up to 50% of our advisory fee on completion. No upfront commitment, no risk, no conflict with your existing retainer.',
          'For advisory firms, the value is simple. The debt piece gets handled by a specialist, you do not need to build that expertise in-house, and you earn a substantial fee for the introduction.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Up to 50% on the first deal. 25% on every deal after. On a GBP 25m transaction that is up to GBP 125k for a single introduction.',
          'Several advisory firms refer to us as standard practice. The fee income is meaningful and the process takes no time away from your core advisory work.',
          'Happy to discuss over a 15-minute call whenever works.',
        ],
      },
    ],
  },

  Wealth: {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. For wealth managers with clients who invest in property, that is a significant additional revenue stream from a single introduction.',
          'We are a specialist debt advisory firm arranging commercial property finance across the UK and Europe. Hotels, residential, logistics, offices, care homes, student accommodation. On a GBP 15m acquisition, your introducer share could be up to GBP 75k.',
          'Your clients use leverage to improve returns and deploy across more opportunities. When they need debt finance, introducing a specialist adviser gets them better terms and earns you a meaningful fee. No cost to your client, no disruption to your AUM relationship.',
          'If your clients own or invest in commercial property, this is worth a conversation.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'HNW and family office clients tend to use debt as a capital efficiency tool. They have the equity to buy outright, but leverage improves the return profile and allows deployment across more opportunities. Every time they borrow, there is an introducer fee available to you.',
          'The deals we see from wealth manager introductions include portfolio acquisitions, development projects, equity release from existing assets, and refinancings where the client wants to benchmark against the wider market.',
          'The structures are often more sophisticated than a standard commercial mortgage. JV financing, multi-asset facilities, cross-border lending. That is where a specialist adviser earns their fee, and where your introducer share, up to 50%, is most significant.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'Up to 50% on the first deal. 25% on every subsequent referral. Paid within 14 days of completion.',
          'Our fee is typically 1% of the facility, spread over 12 months. On a GBP 15m acquisition, your share would be up to GBP 75k. On a GBP 30m portfolio refinancing, up to GBP 150k.',
          'This is separate from your AUM or advisory fees. The debt advisory is a distinct instruction. Your client gets a better financing outcome, you deepen the relationship, and you earn a fee that sits outside your usual fee structure.',
          'Simple documentation, transparent terms. Happy to walk through a specific scenario if you have a client transaction in mind.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Real numbers from wealth management introductions.',
          'A family office adviser introduced a client building a UK logistics portfolio. GBP 25m across four assets. We arranged a portfolio facility with a single lender. The introducer fee was over GBP 110k.',
          'A private banker introduced an HNW client acquiring a boutique hotel. We ran a competitive process and secured 90bps tighter than the client\'s existing bank. The introducer fee was over GBP 45k.',
          'A multi-family office introduced a client group refinancing GBP 40m of residential investment debt. We consolidated the facilities and reduced the overall cost by over GBP 200k per year. The introducer fee was over GBP 180k.',
          'Up to 50% on the first deal. One introduction, one fee.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You introduce your client by email or phone. We meet them, assess the opportunity, run a competitive process, and manage the financing through to drawdown.',
          'You stay informed throughout. Your AUM relationship stays intact. And you receive up to 50% of our advisory fee within 14 days of completion.',
          'For wealth managers, the introduction enhances your service offering without building new capability. Your client gets institutional-quality debt advisory, you deepen the relationship, and you earn a substantial referral fee.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Up to 50% on the first deal. 25% on every deal after. On top of your existing fees.',
          'We work with several wealth management firms on a regular basis. The deals are a natural fit with clients who invest in property, and the introducer income has become a meaningful revenue line.',
          'Happy to discuss over a short call whenever suits.',
        ],
      },
    ],
  },

  Construction: {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. For construction firms, there is an even bigger benefit. If your client has proper financing in place, your contract is secure and your invoices get paid.',
          'We are a specialist debt advisory firm arranging development finance and commercial property debt across the UK and Europe. You see the development pipeline before anyone else. You know which projects are about to start and which developers are still arranging funding.',
          'Introducing us when a client needs development finance earns you a significant referral fee, up to GBP 50k+ on a GBP 10m scheme, and protects your commercial position by ensuring the funding is in place.',
          'If you build for developers who borrow, this is worth a conversation.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'The deals from construction firm introductions are almost always development finance. Ground-up residential, hotel conversions, office refurbishments, care home developments. Your clients are building these projects and the developer needs funding.',
          'We also see situations where the contractor is exposed because the developer is struggling with their existing financing. Introducing a debt adviser who can source alternative funding can protect your position and keep the project moving.',
          'If you are tendering on a scheme and the developer mentions they are still arranging finance, that is the right moment. You earn up to 50% of our advisory fee and you protect your contract.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'Up to 50% on the first deal. 25% on every subsequent referral. Paid within 14 days of completion.',
          'Our fee is typically 1% of the facility. On a GBP 10m development loan, your share would be up to GBP 50k. On a GBP 20m scheme, up to GBP 100k.',
          'But the real value for a construction firm goes beyond the referral fee. If the developer has proper financing, you get paid. If they do not, you are exposed. Introducing a debt adviser who can deliver the funding protects your commercial position and earns you a significant fee on top.',
          'Simple introducer agreement, transparent calculations.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Real numbers from construction firm introductions.',
          'A main contractor introduced a developer building 60 residential units. The developer had been let down by their original lender. We sourced alternative development finance within 3 weeks. The build programme stayed on track, the contractor kept the contract, and the introducer fee was over GBP 40k.',
          'A fit-out contractor introduced a hotel developer converting an office building. GBP 14m development cost. We sourced a specialist hospitality lender. The introducer fee was over GBP 60k.',
          'A groundworks contractor introduced a housebuilder needing finance across three sites. We arranged a revolving facility from a single lender. The introducer fee was over GBP 45k.',
          'Up to 50% on the first deal, plus the security of knowing the project is funded.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You introduce us to the developer. Email, phone call, or a meeting on site. We assess the scheme, run a competitive lender process, and deliver the financing.',
          'You receive up to 50% of our advisory fee within 14 days of completion. And more importantly, you have confidence that the project is properly funded, which means your contract is secure.',
          'We understand construction timelines. If you are about to start on site and the developer\'s financing is not confirmed, you are taking risk. Bringing us in early protects everyone.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Up to 50% on the first deal. 25% on every deal after. Plus the peace of mind that your client\'s project is properly financed.',
          'If you build for developers who borrow, the referral fee is a bonus on top of the commercial protection. Several construction firms refer to us regularly for exactly this reason.',
          'Worth a 15-minute call to see if there is a fit with your current project pipeline.',
        ],
      },
    ],
  },

  'Planning / Architect': {
    emails: [
      {
        angle: 'Partnership Intro',
        paragraphs: [
          'We pay up to 50% of our advisory fee to introducer partners on the first referred deal. Architects and planning consultants see development schemes earlier than almost anyone. You are designing projects and securing consents for clients who will need finance to build. That is the right moment to make an introduction.',
          'We are a specialist debt advisory firm arranging development finance and commercial property debt across the UK and Europe. On a GBP 12m development loan, your introducer share could be up to GBP 60k.',
          'The introduction adds value to your client relationship and generates significant fee income. No cost to your client, no conflict with your design or planning instruction.',
          'If your clients develop commercial property, a quick conversation is worth having.',
        ],
      },
      {
        angle: 'Deal Types',
        paragraphs: [
          'The natural introduction point for architects and planners is when a scheme gets consent. The client has invested in design and planning, and now needs development finance to build. That transition from design to construction is where introducing us earns you up to 50% of our advisory fee.',
          'We also see introductions earlier. Land acquisition finance before planning is granted. Pre-development bridge loans to fund the application period. These are specialist facilities where having an adviser who knows the market makes a real difference to the outcome.',
          'If your client is designing a scheme and mentions they are still working out the financing, that is the conversation. One introduction could be worth GBP 50k or more.',
        ],
      },
      {
        angle: 'Fee Structure',
        paragraphs: [
          'Up to 50% on the first deal. 25% on every subsequent referral. Paid within 14 days of completion.',
          'Our fee is typically 1% of the facility. On a GBP 12m development loan, your share would be up to GBP 60k. On a GBP 20m scheme, up to GBP 100k.',
          'For architects and planners, the introduction also deepens the client relationship. You are not just designing the scheme, you are helping the client find the right financing to build it. That makes your practice harder to replace and earns you a meaningful fee.',
          'Clean introducer agreement, transparent calculations, payment within 14 days.',
        ],
      },
      {
        angle: 'Market Activity',
        paragraphs: [
          'Real numbers from architect and planning consultant introductions.',
          'An architect introduced a developer designing a 90-unit BTR scheme. Planning was granted and the client needed GBP 18m development finance. We secured stretched senior that reduced the equity requirement by GBP 3m. The introducer fee was over GBP 80k.',
          'A planning consultant introduced a client with consent for a hotel conversion. GBP 10m development cost. We sourced a specialist hotel lender. The introducer fee was over GBP 45k.',
          'An architect introduced a care home developer designing an 80-bed facility. We arranged development finance before construction drawings were complete. The introducer fee was over GBP 35k.',
          'Up to 50% on the first deal. One introduction at the right moment.',
        ],
      },
      {
        angle: 'How a Deal Works',
        paragraphs: [
          'You introduce us to your client when financing becomes relevant. Usually around planning consent, sometimes earlier for land finance. We take it from there.',
          'We assess the scheme, run a competitive lender process, and manage the financing through to drawdown. You receive up to 50% of our advisory fee within 14 days of completion.',
          'The introduction is a natural extension of your role. You helped design the scheme and secure consent. Introducing the right debt adviser helps your client build it, and earns you a significant fee for making the connection.',
        ],
      },
      {
        angle: "Let's Connect",
        paragraphs: [
          'Up to 50% on the first deal. 25% on every deal after. The timing works naturally with the work you already do.',
          'You are already advising on the scheme. Introducing a debt adviser at the right moment adds value to your client and generates meaningful referral income for your practice.',
          'Happy to discuss over a 15-minute call.',
        ],
      },
    ],
  },
};

async function main() {
  let updated = 0;
  let notFound = 0;

  for (const [specialism, content] of Object.entries(CONTENT)) {
    for (const email of content.emails) {
      const templateName = `Introducers - ${specialism} - ${email.angle}`;
      const bodyHtml = email.paragraphs.map(text => p(text)).join('\n');
      const html = buildEmailHtml(bodyHtml);

      const result = await pool.query(
        `UPDATE templates SET body_html = $1 WHERE name = $2 AND tenant = 'tp'`,
        [html, templateName]
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`Updated: ${templateName}`);
        updated++;
      } else {
        console.log(`NOT FOUND: ${templateName}`);
        notFound++;
      }
    }
  }

  console.log(`\nDone. Updated ${updated}, not found ${notFound}.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
