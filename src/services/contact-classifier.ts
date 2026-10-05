/**
 * Contact Classifier (Deep Research Edition)
 *
 * For each new contact:
 * 1. Fetches multiple pages from their company website (homepage, about, services, team)
 * 2. Runs a Brave web search for additional context
 * 3. Sends all research to Claude Opus with extended thinking for thorough analysis
 * 4. Routes into: introducer | lender | developer | unknown
 *
 * Uses ~30s per contact for research + classification.
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { query } from '../db/connection';

const TENANT = process.env.TENANT || 'tp';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';

export type ContactType = 'introducer' | 'lender' | 'developer' | 'unknown';

export interface ClassificationResult {
  contactType: ContactType;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  companyDescription: string;
  suggestedListName: string;
}

// Map contact type → list name in the platform
const LIST_MAP: Record<ContactType, string> = {
  introducer: 'Introducers',
  lender:     'Lenders',
  developer:  'Clients',   // developers/investors go into Clients for outreach
  unknown:    'Clients',
};

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchPage(url: string, timeoutMs = 10000): Promise<string> {
  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: HTTP_HEADERS,
      maxContentLength: 500_000,
    });
    return stripHtml(response.data || '');
  } catch {
    return '';
  }
}

// ─── Website deep scrape ───────────────────────────────────────────────────────

/**
 * Deep website research — fetches multiple pages from a domain to build
 * a comprehensive picture of what the company does.
 */
async function fetchWebsiteText(domain: string): Promise<string> {
  if (!domain) return '';

  // Find the working base URL
  const bases = [
    `https://www.${domain}`,
    `https://${domain}`,
    `http://www.${domain}`,
    `http://${domain}`,
  ];

  let baseUrl = '';
  let homepageText = '';
  for (const url of bases) {
    const text = await fetchPage(url);
    if (text.length > 100) {
      baseUrl = url;
      homepageText = text.substring(0, 4000);
      break;
    }
  }

  if (!baseUrl) return '';

  // Fetch subpages in parallel — about, services, team, what-we-do, sectors
  const subpages = [
    '/about', '/about-us', '/about-us/', '/who-we-are',
    '/services', '/what-we-do', '/our-services',
    '/sectors', '/expertise', '/practice-areas',
    '/team', '/our-team', '/people',
    '/contact', '/contact-us',
  ];

  const subpageResults = await Promise.allSettled(
    subpages.map(path => fetchPage(`${baseUrl}${path}`, 8000))
  );

  // Collect all non-empty subpage content
  const extraContent: string[] = [];
  let totalChars = homepageText.length;
  const MAX_TOTAL = 12000; // generous budget for Opus

  for (const result of subpageResults) {
    if (result.status === 'fulfilled' && result.value.length > 200) {
      const chunk = result.value.substring(0, 2000);
      if (totalChars + chunk.length < MAX_TOTAL) {
        extraContent.push(chunk);
        totalChars += chunk.length;
      }
    }
  }

  const sections = [`=== HOMEPAGE ===\n${homepageText}`];
  if (extraContent.length > 0) {
    sections.push(`=== SUBPAGES ===\n${extraContent.join('\n---\n')}`);
  }

  return sections.join('\n\n');
}

// ─── Brave Search ──────────────────────────────────────────────────────────────

interface BraveSearchResult {
  title: string;
  description: string;
  url: string;
}

/**
 * Search Brave for context about a company/domain.
 * Returns formatted search results as text for the classifier.
 */
async function braveSearch(searchQuery: string): Promise<string> {
  if (!BRAVE_API_KEY) return '';

  try {
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: {
        q: searchQuery,
        count: 8,
        search_lang: 'en',
        country: 'GB',
      },
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      timeout: 10000,
    });

    const results: BraveSearchResult[] = (response.data?.web?.results || []).slice(0, 8);
    if (results.length === 0) return '';

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
      .join('\n\n');
  } catch (err) {
    console.log(`[Classifier] Brave search failed: ${(err as Error).message}`);
    return '';
  }
}

/**
 * Run multiple Brave searches to build a rich research dossier on a contact.
 */
async function researchContact(domain: string, companyName: string, email: string): Promise<string> {
  const searches: { label: string; query: string }[] = [];

  // Primary search: company name + domain
  if (companyName && companyName !== 'Unknown') {
    searches.push({
      label: 'Company search',
      query: `"${companyName}" ${domain} UK`,
    });
  } else {
    searches.push({
      label: 'Domain search',
      query: `${domain} company UK`,
    });
  }

  // Secondary search: domain + property/finance context
  searches.push({
    label: 'Property finance context',
    query: `${domain} property finance real estate UK`,
  });

  // Run searches in parallel
  const searchResults = await Promise.allSettled(
    searches.map(s => braveSearch(s.query))
  );

  const sections: string[] = [];
  for (let i = 0; i < searches.length; i++) {
    const result = searchResults[i];
    if (result.status === 'fulfilled' && result.value.length > 50) {
      sections.push(`=== BRAVE SEARCH: ${searches[i].label} ===\n${result.value}`);
    }
  }

  return sections.join('\n\n');
}

// ─── Classification prompt ─────────────────────────────────────────────────────

const CLASSIFICATION_PROMPT = `You are a senior analyst at a UK property finance brokerage. Your job is to classify email contacts into the correct category and subsector based on deep research about their company.

CONTACT TO CLASSIFY:
- Email: {EMAIL}
- Domain: {DOMAIN}
- Company name (if known): {COMPANY_NAME}

RESEARCH GATHERED:

{WEBSITE_CONTENT}

{SEARCH_RESULTS}

---

STEP 1 — Classify into exactly one category:

1. **introducer** — A professional who introduces property deals or clients to finance companies.
   Includes: solicitors, conveyancers, law firms, accountants, tax advisors, financial advisors/planners,
   architects, planning consultants, project managers, quantity surveyors, estate agents, commercial agents,
   mortgage brokers, IFAs, insurance brokers, wealth managers, M&A advisors, corporate finance advisors,
   any professional services firm that operates in or adjacent to the property/finance/construction sector.
   When in doubt between introducer and unknown, lean towards introducer — most people emailing a
   property finance broker are professional contacts.

2. **lender** — Directly provides finance for property transactions.
   Includes: banks, challenger banks, building societies, private credit funds, bridging lenders,
   development finance providers, mezzanine providers, family offices that lend, alternative finance
   providers, peer-to-peer lenders, debt funds, asset managers with lending arms (e.g. Swiss Life AM),
   REIT debt arms, specialist property lenders.

3. **developer** — Develops, invests in, or acquires property as a principal.
   Includes: residential/commercial property developers, housebuilders, land promoters, property investors,
   SPVs/holding companies buying property, real estate equity funds, renovation/conversion specialists,
   build-to-rent operators, housing associations with development arms.

4. **unknown** — ONLY use this if: (a) the company is clearly unrelated to property/finance (e.g. a restaurant,
   tech startup with no property connection, retail brand), OR (b) there is genuinely zero information available
   after all research — not even enough for a reasonable guess.

STEP 2 — Assign a subsector. Pick the BEST-FIT subsector from the lists below.

If contactType is "introducer", pick one of:
- accountant — accountants, tax advisors, audit firms
- advisory — financial advisors, IFAs, corporate finance, M&A advisors, consultants
- agent — estate agents, commercial agents, property agents, letting agents
- construction — contractors, builders, construction consultants, cost managers
- lawyer — solicitors, conveyancers, law firms, barristers
- planning_architect — architects, planning consultants, urban designers, town planners
- surveyor — quantity surveyors, building surveyors, valuers, RICS professionals
- wealth — wealth managers, family offices (non-lending), private banks (advisory), insurance brokers

If contactType is "developer", pick one of:
- btr — build-to-rent, multifamily, PRS operators
- care — care homes, assisted living, healthcare property
- hospitality — hotels, serviced apartments, leisure/hospitality property
- leisure — leisure parks, cinemas, gyms, sports/entertainment venues
- living — general residential developers, mixed-use with residential focus
- logistics — warehousing, industrial, distribution, last-mile logistics
- office — office developers, commercial office investors
- pbsa — purpose-built student accommodation
- retail — retail parks, shopping centres, high street retail property
- sfh — single-family housing, housebuilders, land promoters, estate developers

If contactType is "lender" or "unknown", set subsector to null.

IMPORTANT GUIDANCE:
- Prefer a classification over "unknown". If there's ANY signal suggesting a property/finance connection, classify it.
- Consider the email address itself — the local part (before @) sometimes hints at the person's role.
- Consider LinkedIn profile snippets or third-party descriptions in the search results.
- For ambiguous companies (e.g. "consulting" firms), consider the context: they emailed a property finance broker, so they likely have a property connection.
- For subsector: pick the closest match. If a company spans multiple sectors, pick the PRIMARY one based on the research.

Respond with a JSON object only — no markdown fences, no explanation outside the JSON:
{
  "contactType": "introducer" | "lender" | "developer" | "unknown",
  "subsector": "accountant" | "advisory" | ... | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": "2-3 sentences explaining WHY this classification, citing specific evidence from the research",
  "companyDescription": "one sentence describing what the company does"
}`;

// ─── DB helpers ────────────────────────────────────────────────────────────────

async function ensureListExists(listName: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM contact_lists WHERE name = $1 AND tenant = $2 LIMIT 1`,
    [listName, TENANT]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await query<{ id: string }>(
    `INSERT INTO contact_lists (name, tenant) VALUES ($1, $2) RETURNING id`,
    [listName, TENANT]
  );
  return created.rows[0].id;
}

async function addToList(contactId: string, listName: string): Promise<void> {
  const listId = await ensureListExists(listName);
  await query(
    `INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [listId, contactId]
  );
}

// ─── Classifier ────────────────────────────────────────────────────────────────

export class ContactClassifier {
  private client: Anthropic;
  private _running = false;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async classify(contactId: string): Promise<ClassificationResult | null> {
    const contact = await query<{
      id: string;
      email: string;
      company: string | null;
      company_domain: string | null;
      contact_type: string | null;
    }>(
      `SELECT id, email, company, company_domain, contact_type FROM contacts WHERE id = $1`,
      [contactId]
    );

    if (!contact.rows[0]) {
      console.warn(`[Classifier] Contact ${contactId} not found`);
      return null;
    }

    const c = contact.rows[0];

    // Skip if already classified
    if (c.contact_type) {
      console.log(`[Classifier] Contact ${c.email} already classified as ${c.contact_type}`);
      return null;
    }

    // Derive domain from contact_domain or email
    const domain = c.company_domain || c.email.split('@')[1] || '';

    // Skip obvious non-business domains
    const skipDomains = [
      'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
      'me.com', 'live.com', 'msn.com', 'protonmail.com', 'googlemail.com',
    ];
    if (skipDomains.includes(domain.toLowerCase())) {
      await this.saveResult(c.id, 'introducer', 'low', 'Personal email domain — defaulted to Introducers', '', 'Introducers');
      await addToList(c.id, 'Introducers');
      console.log(`[Classifier] ${c.email} → introducer (personal domain default) → Introducers`);
      return null;
    }

    const startTime = Date.now();
    console.log(`[Classifier] Deep-researching ${c.email} (domain: ${domain})...`);

    // Phase 1: Fetch website content (multi-page)
    const websiteContent = await fetchWebsiteText(domain);
    if (websiteContent) {
      console.log(`[Classifier]   Website: ${websiteContent.length} chars gathered`);
    } else {
      console.log(`[Classifier]   Website: unreachable for ${domain}`);
    }

    // Phase 2: Brave search research
    const searchResults = await researchContact(domain, c.company || '', c.email);
    if (searchResults) {
      console.log(`[Classifier]   Brave search: ${searchResults.length} chars of context`);
    }

    const researchTime = Date.now() - startTime;
    console.log(`[Classifier]   Research took ${(researchTime / 1000).toFixed(1)}s`);

    // Phase 3: Send to Haiku for classification + subsector
    const prompt = CLASSIFICATION_PROMPT
      .replace('{DOMAIN}', domain)
      .replace('{COMPANY_NAME}', c.company || 'Unknown')
      .replace('{EMAIL}', c.email)
      .replace('{WEBSITE_CONTENT}', websiteContent || '(website not accessible — rely on search results below)')
      .replace('{SEARCH_RESULTS}', searchResults || '(no search results available)');

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      // Extract the text block
      let text = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          text = block.text.trim();
          break;
        }
      }

      if (!text) {
        console.warn(`[Classifier] Haiku returned no text for ${c.email}`);
        return null;
      }

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn(`[Classifier] Haiku returned non-JSON for ${c.email}:`, text.substring(0, 200));
        return null;
      }

      const result = JSON.parse(jsonMatch[0]) as {
        contactType: ContactType;
        subsector: string | null;
        confidence: 'high' | 'medium' | 'low';
        reasoning: string;
        companyDescription: string;
      };

      const suggestedListName = LIST_MAP[result.contactType] || 'Clients';
      const totalTime = Date.now() - startTime;

      // Save classification + subsector to DB
      await this.saveResult(
        c.id,
        result.contactType,
        result.confidence,
        result.reasoning,
        result.companyDescription,
        suggestedListName,
        result.subsector || null
      );

      // Add to appropriate list
      await addToList(c.id, suggestedListName);

      console.log(`[Classifier] ${c.email} → ${result.contactType}/${result.subsector || 'none'} (${result.confidence}) → ${suggestedListName} [${(totalTime / 1000).toFixed(1)}s]`);
      console.log(`[Classifier]   Reason: ${result.reasoning}`);

      return { ...result, suggestedListName };
    } catch (err) {
      console.error(`[Classifier] Error classifying ${c.email}:`, (err as Error).message);
      return null;
    }
  }

  private async saveResult(
    contactId: string,
    contactType: ContactType,
    confidence: string,
    reasoning: string,
    companyDescription: string,
    suggestedList: string,
    subsector: string | null = null
  ): Promise<void> {
    await query(
      `UPDATE contacts
       SET contact_type         = $1,
           classification_data  = $2,
           classified_at        = NOW(),
           updated_at           = NOW(),
           subsector            = COALESCE($4, subsector)
       WHERE id = $3`,
      [
        contactType,
        JSON.stringify({ confidence, reasoning, companyDescription, suggestedList, subsector }),
        contactId,
        subsector,
      ]
    );
  }

  /** Classify all contacts that haven't been classified yet (backfill) */
  async classifyPending(limit = 50): Promise<void> {
    if (this._running) {
      console.log('[Classifier] Already running — skipping this cycle');
      return;
    }
    this._running = true;

    try {
      const pending = await query<{ id: string; email: string }>(
        `SELECT id, email FROM contacts
         WHERE contact_type IS NULL
           AND tenant = $1
           AND source != 'system'
         ORDER BY created_at DESC
         LIMIT $2`,
        [TENANT, limit]
      );

      if (pending.rows.length === 0) {
        return;
      }

      console.log(`[Classifier] Classifying ${pending.rows.length} pending contacts with Haiku...`);

      for (const contact of pending.rows) {
        try {
          await this.classify(contact.id);
          // 10s between contacts — avoids hammering Brave + Anthropic APIs
          await new Promise(r => setTimeout(r, 10000));
        } catch (err) {
          console.error(`[Classifier] Failed for ${contact.email}:`, (err as Error).message);
        }
      }
    } finally {
      this._running = false;
    }
  }

  async backfillSubsectors(limit = 50): Promise<void> {
    if (this._running) {
      console.log('[Subsector Backfill] Classifier is running — skipping');
      return;
    }
    this._running = true;

    try {
      const rows = await query<{
        id: string; email: string; contact_type: string;
        company: string | null; classification_data: string | null;
      }>(
        `SELECT id, email, contact_type, company, classification_data::text
         FROM contacts
         WHERE tenant = $1
           AND contact_type IN ('introducer', 'developer')
           AND subsector IS NULL
         ORDER BY classified_at DESC
         LIMIT $2`,
        [TENANT, limit]
      );

      if (rows.rows.length === 0) {
        console.log('[Subsector Backfill] No contacts need subsectors');
        return;
      }

      console.log(`[Subsector Backfill] Assigning subsectors to ${rows.rows.length} contacts...`);
      let updated = 0;

      for (const c of rows.rows) {
        try {
          let classData: { companyDescription?: string; reasoning?: string } = {};
          try { classData = JSON.parse(c.classification_data || '{}'); } catch {}

          const prompt = `Assign a subsector to this contact. They are already classified as "${c.contact_type}".

Company: ${c.company || 'Unknown'}
Email: ${c.email}
Description: ${classData.companyDescription || 'N/A'}
Classification reasoning: ${classData.reasoning || 'N/A'}

${c.contact_type === 'introducer' ? `Pick one introducer subsector:
- accountant — accountants, tax advisors, audit firms
- advisory — financial advisors, IFAs, corporate finance, M&A advisors, consultants
- agent — estate agents, commercial agents, property agents, letting agents
- construction — contractors, builders, construction consultants, cost managers
- lawyer — solicitors, conveyancers, law firms, barristers
- planning_architect — architects, planning consultants, urban designers, town planners
- surveyor — quantity surveyors, building surveyors, valuers, RICS professionals
- wealth — wealth managers, family offices, private banks, insurance brokers` :
`Pick one developer/client subsector:
- btr — build-to-rent, multifamily, PRS operators
- care — care homes, assisted living, healthcare property
- hospitality — hotels, serviced apartments, leisure/hospitality
- leisure — leisure parks, cinemas, gyms, sports/entertainment
- living — general residential developers, mixed-use residential
- logistics — warehousing, industrial, distribution
- office — office developers, commercial office investors
- pbsa — purpose-built student accommodation
- retail — retail parks, shopping centres, high street retail
- sfh — single-family housing, housebuilders, land promoters`}

Respond with ONLY the subsector keyword (e.g. "agent" or "btr"). Nothing else.`;

          const response = await this.client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 32,
            messages: [{ role: 'user', content: prompt }],
          });

          let subsector = '';
          for (const block of response.content) {
            if (block.type === 'text') {
              subsector = block.text.trim().toLowerCase().replace(/[^a-z_]/g, '');
              break;
            }
          }

          if (subsector) {
            await query(
              `UPDATE contacts SET subsector = $1, updated_at = NOW() WHERE id = $2`,
              [subsector, c.id]
            );
            updated++;
            console.log(`[Subsector Backfill] ${c.email} → ${c.contact_type}/${subsector}`);
          }

          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error(`[Subsector Backfill] Failed for ${c.email}: ${(err as Error).message}`);
        }
      }

      console.log(`[Subsector Backfill] Done — ${updated} subsectors assigned`);
    } finally {
      this._running = false;
    }
  }
}

export const contactClassifier = new ContactClassifier();
