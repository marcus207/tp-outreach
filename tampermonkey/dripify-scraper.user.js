// ==UserScript==
// @name         TP.Finance Dripify Monitor
// @namespace    https://tp.finance
// @version      1.2
// @description  Scrapes Dripify dashboard stats and POSTs to TP Outreach Engine
// @author       TP.Finance
// @match        https://app.dripify.io/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- Configuration ----
  // Update these to match your deployment
  const INGEST_URL = GM_getValue('tp_ingest_url', 'http://localhost:3100/api/dripify/ingest');
  const API_KEY = GM_getValue('tp_api_key', 'your_ingest_key_here');
  const SCRAPE_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes

  let lastScrapeTime = 0;

  // ---- Utility ----
  function log(msg) {
    console.log('[TP Dripify Scraper]', msg);
  }

  function parseNumber(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^0-9.]/g, '');
    return cleaned ? parseInt(cleaned, 10) : null;
  }

  function sendToIngest(data) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: INGEST_URL,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      data: JSON.stringify(data),
      onload: function (response) {
        if (response.status === 200) {
          log('Snapshot ingested successfully');
        } else {
          log('Ingest error: ' + response.status + ' ' + response.responseText);
        }
      },
      onerror: function (err) {
        log('Ingest request failed: ' + JSON.stringify(err));
      },
    });
  }

  // ---- Scraping Functions ----

  function scrapeSearchCredits() {
    // Try multiple selectors for search credits
    const selectors = [
      '[data-testid="search-credits"]',
      '.search-credits',
      '[class*="credits"]',
      '[class*="SearchCredits"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        return parseNumber(el.textContent);
      }
    }

    // Fallback: look for text containing "credits" near a number
    const allText = document.querySelectorAll('span, p, div');
    for (const el of allText) {
      const text = el.textContent || '';
      if (text.toLowerCase().includes('search credits') || text.toLowerCase().includes('credits left')) {
        const num = parseNumber(text);
        if (num !== null) return num;
      }
    }

    return null;
  }

  function scrapeDailyLimits() {
    const result = {
      daily_invites_used: null,
      daily_invites_limit: null,
      daily_messages_used: null,
      daily_messages_limit: null,
    };

    // Look for progress bars or limit indicators
    const progressBars = document.querySelectorAll('[class*="progress"], [class*="Progress"]');
    const limitTexts = document.querySelectorAll('[class*="limit"], [class*="Limit"], [class*="quota"]');

    // Parse "X / Y" patterns in text
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length > 0) continue; // leaf nodes only
      const text = (el.textContent || '').trim();

      // Match patterns like "45 / 100" or "45/100"
      const slashMatch = text.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (slashMatch) {
        const used = parseInt(slashMatch[1], 10);
        const limit = parseInt(slashMatch[2], 10);

        // Determine context from parent
        const parentText = (el.parentElement?.textContent || '').toLowerCase();
        if (parentText.includes('invite') || parentText.includes('connection')) {
          result.daily_invites_used = used;
          result.daily_invites_limit = limit;
        } else if (parentText.includes('message')) {
          result.daily_messages_used = used;
          result.daily_messages_limit = limit;
        }
      }
    }

    // Also try specific Dripify selectors
    const inviteEl = document.querySelector('[data-testid="daily-invites"]');
    if (inviteEl) {
      const text = inviteEl.textContent || '';
      const match = text.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) {
        result.daily_invites_used = parseInt(match[1], 10);
        result.daily_invites_limit = parseInt(match[2], 10);
      }
    }

    const msgEl = document.querySelector('[data-testid="daily-messages"]');
    if (msgEl) {
      const text = msgEl.textContent || '';
      const match = text.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) {
        result.daily_messages_used = parseInt(match[1], 10);
        result.daily_messages_limit = parseInt(match[2], 10);
      }
    }

    return result;
  }

  function scrapeCampaigns() {
    const campaigns = [];

    // Try to find campaign rows in a table or list
    const campaignRows = document.querySelectorAll(
      '[class*="campaign-row"], [class*="CampaignRow"], [data-testid*="campaign"]'
    );

    for (const row of campaignRows) {
      const nameEl = row.querySelector('[class*="name"], [class*="title"], h3, h4');
      const statusEl = row.querySelector('[class*="status"], [class*="badge"]');

      const campaign = {
        id: row.getAttribute('data-id') || row.getAttribute('id') || String(campaigns.length),
        name: nameEl ? (nameEl.textContent || '').trim() : 'Unknown',
        status: statusEl ? (statusEl.textContent || '').trim().toLowerCase() : 'unknown',
      };

      // Try to get stats
      const statEls = row.querySelectorAll('[class*="stat"], [class*="count"]');
      if (statEls.length >= 3) {
        campaign.leads_count = parseNumber(statEls[0].textContent);
        campaign.accepted = parseNumber(statEls[1].textContent);
        campaign.replied = parseNumber(statEls[2].textContent);
      }

      campaigns.push(campaign);
    }

    // Fallback: look for campaign table
    if (campaigns.length === 0) {
      const table = document.querySelector('table');
      if (table) {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach((row, idx) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            campaigns.push({
              id: String(idx),
              name: (cells[0].textContent || '').trim(),
              status: (cells[cells.length - 1].textContent || '').trim().toLowerCase(),
            });
          }
        });
      }
    }

    return campaigns;
  }

  function scrapeAll() {
    const now = Date.now();
    if (now - lastScrapeTime < 60000) {
      // Don't scrape more than once per minute
      return;
    }
    lastScrapeTime = now;

    log('Scraping Dripify dashboard...');

    const searchCredits = scrapeSearchCredits();
    const dailyLimits = scrapeDailyLimits();
    const campaigns = scrapeCampaigns();

    const payload = {
      url: window.location.href,
      search_credits: searchCredits,
      ...dailyLimits,
      campaigns: campaigns.length > 0 ? campaigns : null,
      scraped_at: new Date().toISOString(),
      user_agent: navigator.userAgent,
    };

    log('Scraped data: ' + JSON.stringify(payload));

    if (searchCredits !== null || dailyLimits.daily_invites_limit !== null) {
      sendToIngest(payload);
    } else {
      log('No useful data found — skipping ingest');
    }
  }

  // ---- Settings UI ----
  function createSettingsPanel() {
    const existing = document.getElementById('tp-scraper-settings');
    if (existing) {
      existing.remove();
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'tp-scraper-settings';
    panel.style.cssText = `
      position: fixed;
      bottom: 60px;
      right: 20px;
      background: #0D1B2A;
      border: 1px solid #1A2A3D;
      border-radius: 8px;
      padding: 16px;
      z-index: 99999;
      color: #B0BEC5;
      font-family: monospace;
      font-size: 12px;
      width: 300px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    `;

    panel.innerHTML = `
      <div style="font-weight:bold;color:#74DFF6;margin-bottom:12px">TP Outreach Settings</div>
      <label style="display:block;margin-bottom:6px">Ingest URL:</label>
      <input id="tp-ingest-url" type="text" value="${INGEST_URL}"
        style="width:100%;background:#0A131E;border:1px solid #1A2A3D;color:#B0BEC5;padding:6px;border-radius:4px;margin-bottom:10px;box-sizing:border-box" />
      <label style="display:block;margin-bottom:6px">API Key:</label>
      <input id="tp-api-key-input" type="password" value="${API_KEY}"
        style="width:100%;background:#0A131E;border:1px solid #1A2A3D;color:#B0BEC5;padding:6px;border-radius:4px;margin-bottom:10px;box-sizing:border-box" />
      <button id="tp-save-settings"
        style="background:#1993C5;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;width:100%;margin-bottom:8px">
        Save Settings
      </button>
      <button id="tp-scrape-now"
        style="background:#0D1B2A;border:1px solid #1993C5;color:#1993C5;padding:8px 16px;border-radius:4px;cursor:pointer;width:100%">
        Scrape Now
      </button>
    `;

    document.body.appendChild(panel);

    document.getElementById('tp-save-settings').addEventListener('click', () => {
      const url = document.getElementById('tp-ingest-url').value.trim();
      const key = document.getElementById('tp-api-key-input').value.trim();
      GM_setValue('tp_ingest_url', url);
      GM_setValue('tp_api_key', key);
      alert('Settings saved! Reload the page to apply.');
    });

    document.getElementById('tp-scrape-now').addEventListener('click', () => {
      lastScrapeTime = 0;
      scrapeAll();
    });
  }

  // ---- Floating Button ----
  function createFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'tp-scraper-btn';
    btn.textContent = 'TP';
    btn.title = 'TP.Finance Outreach Monitor';
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 40px;
      height: 40px;
      background: #1993C5;
      color: white;
      border: none;
      border-radius: 50%;
      font-weight: bold;
      font-size: 13px;
      cursor: pointer;
      z-index: 99999;
      box-shadow: 0 2px 10px rgba(25,147,197,0.5);
    `;

    btn.addEventListener('click', createSettingsPanel);
    document.body.appendChild(btn);
  }

  // ---- Navigation Detection ----
  // Dripify is a SPA — watch for route changes
  let lastUrl = location.href;

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('Navigation detected: ' + lastUrl);
      // Small delay for page to render
      setTimeout(scrapeAll, 2000);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ---- Initialize ----
  function init() {
    log('Initializing TP Dripify Scraper v1.2');
    createFloatingButton();

    // Initial scrape after page load
    setTimeout(scrapeAll, 3000);

    // Periodic scraping
    setInterval(scrapeAll, SCRAPE_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
