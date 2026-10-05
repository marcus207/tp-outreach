import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  FileText, Edit2, X, Check, Mail,
  XCircle, Clock, Globe, Loader2, Filter, RefreshCw, Radio,
  ChevronDown, Eye, Layout, Calendar,
} from 'lucide-react';

// ─── API ──────────────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: '/outreach/api',
  withCredentials: true,
});

const fetchArticles = (status?: string, sector?: string) =>
  api.get('/articles', { params: { status: status || undefined, sector: sector || undefined } });

const fetchArticle = (id: string) => api.get(`/articles/${id}`);

const updateArticle = (id: string, data: any) => api.put(`/articles/${id}`, data);

const publishArticle = (id: string) => api.post(`/articles/${id}/publish`);

const broadcastArticle = (id: string, subsectors: string[], contactType?: string) =>
  api.post(`/articles/${id}/broadcast`, { subsectors, contact_type: contactType });
const broadcastTestEmail = (id: string, email: string) =>
  api.post(`/articles/${id}/broadcast-test`, { email });
const scheduleSequence = (articleIds: string[], startDate: string, subsectors: string[], broadcastDelayHours?: number) =>
  api.post('/articles/schedule-sequence', { article_ids: articleIds, start_date: startDate, subsectors, broadcast_delay_hours: broadcastDelayHours });
const clearSchedule = (id: string) =>
  api.post(`/articles/${id}/clear-schedule`);

const deleteArticle = (id: string) => api.delete(`/articles/${id}`);

// ─── Constants ────────────────────────────────────────────────────────────────

interface Article {
  id: string;
  title: string;
  excerpt: string;
  content: string;
  sector: string;
  author: string;
  status: 'draft' | 'approved' | 'published' | 'rejected';
  source_url?: string;
  published_at?: string;
  broadcasted_at?: string;
  broadcast_count?: number;
  broadcast_total_contacts?: number;
  broadcasts?: { id: string; subsectors: string[]; total_contacts: number; total_sent: number; actual_sent: number; actual_failed: number; status: string; sent_at: string }[];
  scheduled_publish_at?: string;
  scheduled_broadcast_at?: string;
  broadcast_subsectors?: string[];
  sequence_order?: number;
  created_at: string;
  updated_at?: string;
  live_url?: string;
}

const INTRODUCER_SUBSECTORS = [
  { key: 'accountant', label: 'Accountant' },
  { key: 'advisory', label: 'Advisory' },
  { key: 'agent', label: 'Agent' },
  { key: 'construction', label: 'Construction' },
  { key: 'lawyer', label: 'Lawyer' },
  { key: 'planning_architect', label: 'Planning / Architect' },
  { key: 'surveyor', label: 'Surveyor' },
  { key: 'wealth', label: 'Wealth' },
];

const CLIENT_SUBSECTORS = [
  { key: 'btr', label: 'BTR' },
  { key: 'care', label: 'Care' },
  { key: 'hospitality', label: 'Hospitality' },
  { key: 'leisure', label: 'Leisure' },
  { key: 'living', label: 'Living' },
  { key: 'logistics', label: 'Logistics' },
  { key: 'office', label: 'Offices' },
  { key: 'pbsa', label: 'PBSA' },
  { key: 'retail', label: 'Retail' },
  { key: 'sfh', label: 'SFH' },
];

const SECTORS = [
  { value: 'general', label: 'General' },
  { value: 'office', label: 'Office' },
  { value: 'living', label: 'Living' },
  { value: 'hospitality', label: 'Hospitality' },
  { value: 'digital-infrastructure', label: 'Digital Infrastructure' },
  { value: 'esg', label: 'ESG' },
  { value: 'capital_markets', label: 'Capital Markets' },
  { value: 'industrial', label: 'Industrial' },
  { value: 'retail', label: 'Retail' },
];

const AUTHORS = ['Marcus Emadi', 'Loredana Emadi'];

const STATUS_CONFIG: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  draft:       { bg: 'bg-amber-900/30',  text: 'text-amber-400',  dot: 'bg-amber-400',  label: 'Draft' },
  approved:    { bg: 'bg-blue-900/30',   text: 'text-blue-400',   dot: 'bg-blue-400',   label: 'Approved' },
  published:   { bg: 'bg-green-900/30',  text: 'text-green-400',  dot: 'bg-green-400',  label: 'Published' },
  rejected:    { bg: 'bg-red-900/30',    text: 'text-red-400',    dot: 'bg-red-400',    label: 'Rejected' },
  broadcasted: { bg: 'bg-purple-900/30', text: 'text-purple-400', dot: 'bg-purple-400', label: 'Broadcasted' },
};

const STATUS_FILTERS = ['all', 'draft', 'approved', 'published', 'rejected', 'broadcasted'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function SectorBadge({ sector }: { sector: string }) {
  const label = SECTORS.find(s => s.value === sector)?.label || sector;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#1993C5]/20 text-[#74DFF6]">
      {label}
    </span>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl px-4 py-3 flex items-center gap-3 min-w-[140px]">
      <div className="text-[#74DFF6]">{icon}</div>
      <div>
        <div className="text-white text-lg font-bold leading-tight">{value}</div>
        <div className="text-[#6B7E8F] text-xs">{label}</div>
      </div>
    </div>
  );
}

function truncate(str: string, max: number) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function formatDate(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Broadcast Modal ──────────────────────────────────────────────────────────

function BroadcastModal({
  article,
  onClose,
}: {
  article: Article;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllIntroducers = () => {
    setSelected(prev => {
      const next = new Set(prev);
      INTRODUCER_SUBSECTORS.forEach(s => next.add(s.key));
      return next;
    });
  };

  const selectAllClients = () => {
    setSelected(prev => {
      const next = new Set(prev);
      CLIENT_SUBSECTORS.forEach(s => next.add(s.key));
      return next;
    });
  };

  const deselectAll = () => setSelected(new Set());

  const handleSend = async () => {
    if (selected.size === 0) return;
    setSending(true);
    setResult(null);
    try {
      const subsectors = Array.from(selected);
      const res = await broadcastArticle(article.id, subsectors);
      setResult({ success: true, message: res.data?.message || `Broadcast queued to ${subsectors.length} subsector(s)` });
    } catch (err: any) {
      setResult({ success: false, message: err.response?.data?.error || 'Broadcast failed' });
    } finally {
      setSending(false);
    }
  };

  const introducerSelected = INTRODUCER_SUBSECTORS.filter(s => selected.has(s.key)).length;
  const clientSelected = CLIENT_SUBSECTORS.filter(s => selected.has(s.key)).length;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4">
      <div className="bg-[#0A131E] border border-[#1A2A3D] rounded-xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1A2A3D]">
          <div>
            <h3 className="text-white font-semibold text-sm">Broadcast Article</h3>
            <p className="text-[#6B7E8F] text-xs mt-0.5">{truncate(article.title, 60)}</p>
          </div>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Introducers */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[#B0BEC5] text-sm font-medium">
                Introducers <span className="text-[#6B7E8F]">({introducerSelected}/{INTRODUCER_SUBSECTORS.length})</span>
              </span>
              <button
                onClick={selectAllIntroducers}
                className="text-[#74DFF6] text-xs hover:underline"
              >
                Select All Introducers
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {INTRODUCER_SUBSECTORS.map(sub => (
                <label
                  key={sub.key}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm
                    ${selected.has(sub.key)
                      ? 'bg-[#1993C5]/15 border-[#1993C5]/40 text-[#74DFF6]'
                      : 'bg-[#111D2E] border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5]/30'
                    }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(sub.key)}
                    onChange={() => toggle(sub.key)}
                    className="sr-only"
                  />
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0
                    ${selected.has(sub.key) ? 'bg-[#1993C5] border-[#1993C5]' : 'border-[#1A2A3D]'}`}>
                    {selected.has(sub.key) && <Check size={10} className="text-white" />}
                  </span>
                  {sub.label}
                </label>
              ))}
            </div>
          </div>

          {/* Clients */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[#B0BEC5] text-sm font-medium">
                Clients <span className="text-[#6B7E8F]">({clientSelected}/{CLIENT_SUBSECTORS.length})</span>
              </span>
              <button
                onClick={selectAllClients}
                className="text-[#74DFF6] text-xs hover:underline"
              >
                Select All Clients
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {CLIENT_SUBSECTORS.map(sub => (
                <label
                  key={sub.key}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm
                    ${selected.has(sub.key)
                      ? 'bg-[#1993C5]/15 border-[#1993C5]/40 text-[#74DFF6]'
                      : 'bg-[#111D2E] border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5]/30'
                    }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(sub.key)}
                    onChange={() => toggle(sub.key)}
                    className="sr-only"
                  />
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0
                    ${selected.has(sub.key) ? 'bg-[#1993C5] border-[#1993C5]' : 'border-[#1A2A3D]'}`}>
                    {selected.has(sub.key) && <Check size={10} className="text-white" />}
                  </span>
                  {sub.label}
                </label>
              ))}
            </div>
          </div>

          {/* Summary */}
          <div className="flex items-center justify-between text-xs text-[#6B7E8F] pt-1">
            <span>{selected.size} subsector(s) selected</span>
            {selected.size > 0 && (
              <button onClick={deselectAll} className="text-red-400 hover:underline">
                Clear all
              </button>
            )}
          </div>

          {/* Send Test */}
          <div className="flex items-center gap-2 pt-1">
            <input
              id="test-email"
              type="email"
              placeholder="Test email address"
              defaultValue="support@loan-intel.com"
              className="flex-1 bg-[#111D2E] border border-[#1A2A3D] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] placeholder-[#4A5A6A]"
            />
            <button
              onClick={async () => {
                const input = document.getElementById('test-email') as HTMLInputElement;
                const testEmail = input?.value?.trim();
                if (!testEmail) return;
                setSending(true);
                try {
                  await broadcastTestEmail(article.id, testEmail);
                  setResult({ success: true, message: `Test email queued to ${testEmail}` });
                } catch (err: any) {
                  setResult({ success: false, message: err.response?.data?.error || 'Test send failed' });
                } finally {
                  setSending(false);
                }
              }}
              disabled={sending}
              className="bg-[#111D2E] border border-[#1A2A3D] hover:border-[#1993C5]/50 text-[#B0BEC5] hover:text-white rounded-lg px-4 py-2 text-sm transition-colors whitespace-nowrap"
            >
              Send Test
            </button>
          </div>

          {/* Result */}
          {result && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              result.success
                ? 'bg-green-900/30 text-green-400 border border-green-800/40'
                : 'bg-red-900/30 text-red-400 border border-red-800/40'
            }`}>
              {result.message}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[#1A2A3D] flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#6B7E8F] rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || selected.size === 0}
            className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-40 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            {sending ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Radio size={14} />
                Send Broadcast
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Website Preview (direct render matching tp.finance exactly) ─────────────

const sectorImagePools: Record<string, string[]> = {
  living: [
    "/images/sectors/photo-1545324418-cc1a3fa10c00.jpg",
    "/images/sectors/photo-1460317442991-0ec209397118.jpg",
    "/images/sectors/photo-1574362848149-11496d93a7c7.jpg",
    "/images/sectors/photo-1560448204-e02f11c3d0e2.jpg",
    "/images/sectors/photo-1558036117-15d82a90b9b1.jpg",
    "/images/sectors/photo-1568605114967-8130f3a36994.jpg",
    "/images/sectors/photo-1600585154340-be6161a56a0c.jpg",
    "/images/sectors/photo-1600047509807-ba8f99d2cdde.jpg",
    "/images/sectors/photo-1605276374104-dee2a0ed3cd6.jpg",
    "/images/sectors/photo-1600566753190-17f0baa2a6c3.jpg",
  ],
  hospitality: [
    "/images/sectors/photo-1542314831-068cd1dbfeeb.jpg",
    "/images/sectors/photo-1551882547-ff40c63fe5fa.jpg",
    "/images/sectors/photo-1578683010236-d716f9a3f461.jpg",
    "/images/sectors/photo-1445019980597-93fa8acb246c.jpg",
    "/images/sectors/photo-1618773928121-c32242e63f39.jpg",
    "/images/sectors/photo-1564501049412-61c2a3083791.jpg",
    "/images/sectors/photo-1596436889106-be35e843f974.jpg",
    "/images/sectors/photo-1571003123894-1f0594d2b5d9.jpg",
    "/images/sectors/photo-1582719478250-c89cae4dc85b.jpg",
    "/images/sectors/photo-1455587734955-081b22074882.jpg",
  ],
  office: [
    "/images/sectors/photo-1486406146926-c627a92ad1ab.jpg",
    "/images/sectors/photo-1497366216548-37526070297c.jpg",
    "/images/sectors/photo-1497366811353-6870744d04b2.jpg",
    "/images/sectors/photo-1577412647305-991150c7d163.jpg",
    "/images/sectors/photo-1560179707-f14e90ef3623.jpg",
    "/images/sectors/photo-1568992687947-868a62a9f521.jpg",
    "/images/sectors/photo-1497215842964-222b430dc094.jpg",
    "/images/sectors/photo-1462826303086-329426d1aef5.jpg",
    "/images/sectors/photo-1524758631624-e2822e304c36.jpg",
    "/images/sectors/photo-1556761175-4b46a572b786.jpg",
  ],
  industrial: [
    "/images/sectors/photo-1586528116311-ad8dd3c8310d.jpg",
    "/images/sectors/photo-1553413077-190dd305871c.jpg",
    "/images/sectors/photo-1565891741441-64926e441838.jpg",
    "/images/sectors/photo-1587293852726-70cdb56c2866.jpg",
    "/images/sectors/photo-1749244768351-2726dc23d26c.jpg",
    "/images/sectors/photo-1504307651254-35680f356dfd.jpg",
    "/images/sectors/photo-1611273426858-450d8e3c9fce.jpg",
    "/images/sectors/photo-1578575437130-527eed3abbec.jpg",
    "/images/sectors/photo-1590069261209-f8e9b8642343.jpg",
    "/images/sectors/photo-1715026323282-073e1a65576a.jpg",
  ],
  retail: [
    "/images/sectors/photo-1753699298393-0543088110d1.jpg",
    "/images/sectors/photo-1441984904996-e0b6ba687e04.jpg",
    "/images/sectors/photo-1567449303183-ae0d6ed1498e.jpg",
    "/images/sectors/photo-1758448500866-ed2d4187e32e.jpg",
    "/images/sectors/photo-1534452203293-494d7ddbf7e0.jpg",
    "/images/sectors/photo-1472851294608-062f824d29cc.jpg",
    "/images/sectors/photo-1604719312566-8912e9227c6a.jpg",
    "/images/sectors/photo-1555529669-e69e7aa0ba9a.jpg",
    "/images/sectors/photo-1556742049-0cfed4f6a45d.jpg",
    "/images/sectors/photo-1690451831264-c6b30f17aaac.jpg",
  ],
  data_centres: [
    "/images/sectors/photo-1558494949-ef010cbdcc31.jpg",
    "/images/sectors/photo-1573164713988-8665fc963095.jpg",
    "/images/sectors/photo-1544197150-b99a580bb7a8.jpg",
    "/images/sectors/photo-1484557052118-f32bd25b45b5.jpg",
    "/images/sectors/photo-1551288049-bebda4e38f71.jpg",
    "/images/sectors/photo-1639322537228-f710d846310a.jpg",
    "/images/sectors/photo-1550751827-4bd374c3f58b.jpg",
    "/images/sectors/photo-1560732488-6b0df240254a.jpg",
    "/images/sectors/photo-1518770660439-4636190af475.jpg",
    "/images/sectors/photo-1597733336794-12d05021d510.jpg",
  ],
  "digital-infrastructure": [
    "/images/sectors/photo-1558494949-ef010cbdcc31.jpg",
    "/images/sectors/photo-1573164713988-8665fc963095.jpg",
    "/images/sectors/photo-1544197150-b99a580bb7a8.jpg",
    "/images/sectors/photo-1639322537228-f710d846310a.jpg",
    "/images/sectors/photo-1550751827-4bd374c3f58b.jpg",
    "/images/sectors/photo-1484557052118-f32bd25b45b5.jpg",
    "/images/sectors/photo-1518770660439-4636190af475.jpg",
    "/images/sectors/photo-1597733336794-12d05021d510.jpg",
  ],
  esg: [
    "/images/sectors/photo-1473341304170-971dccb5ac1e.jpg",
    "/images/sectors/photo-1509391366360-2e959784a276.jpg",
    "/images/sectors/photo-1713647266530-8a4c01b14033.jpg",
    "/images/sectors/photo-1532601224476-15c79f2f7a51.jpg",
    "/images/sectors/photo-1569163139394-de4e5f43e5ca.jpg",
    "/images/sectors/photo-1559302504-64aae6ca6b6d.jpg",
    "/images/sectors/photo-1548337138-e87d889cc369.jpg",
    "/images/sectors/photo-1497440001374-f26997328c1b.jpg",
    "/images/sectors/photo-1467533003447-e295ff1b0435.jpg",
    "/images/sectors/photo-1595437193398-f24279553f4f.jpg",
  ],
  capital_markets: [
    "/images/sectors/photo-1611974789855-9c2a0a7236a3.jpg",
    "/images/sectors/photo-1590283603385-17ffb3a7f29f.jpg",
    "/images/sectors/photo-1454165804606-c3d57bc86b40.jpg",
    "/images/sectors/photo-1460925895917-afdab827c52f.jpg",
    "/images/sectors/photo-1444653614773-995cb1ef9efa.jpg",
    "/images/sectors/photo-1579532537598-459ecdaf39cc.jpg",
    "/images/sectors/photo-1526304640581-d334cdbbf45e.jpg",
    "/images/sectors/photo-1507679799987-c73779587ccf.jpg",
    "/images/sectors/photo-1549421263-5ec394a5ad4c.jpg",
    "/images/sectors/photo-1486406146926-c627a92ad1ab.jpg",
  ],
  general: [
    "/images/sectors/photo-1486406146926-c627a92ad1ab.jpg",
    "/images/sectors/photo-1444653614773-995cb1ef9efa.jpg",
    "/images/sectors/photo-1513635269975-59663e0ac1ad.jpg",
    "/images/sectors/photo-1480449649358-ee14c6ee0b17.jpg",
    "/images/sectors/photo-1560179707-f14e90ef3623.jpg",
    "/images/sectors/photo-1449824913935-59a10b8d2000.jpg",
    "/images/sectors/photo-1526304640581-d334cdbbf45e.jpg",
    "/images/sectors/photo-1579532537598-459ecdaf39cc.jpg",
    "/images/sectors/photo-1568992687947-868a62a9f521.jpg",
    "/images/sectors/photo-1577412647305-991150c7d163.jpg",
    "/images/sectors/photo-1462826303086-329426d1aef5.jpg",
    "/images/sectors/photo-1554469384-e58fac16e23a.jpg",
  ],
};

const websiteSectorLabels: Record<string, string> = {
  living: "Living & Residential",
  hospitality: "Hospitality",
  office: "Office",
  industrial: "Industrial & Logistics",
  retail: "Retail",
  data_centres: "Data Centres",
  esg: "ESG & Sustainability",
  capital_markets: "Capital Markets",
  "digital-infrastructure": "Digital Infrastructure",
  general: "General",
};

const websiteAuthorInfo: Record<string, { title: string; bio: string; email: string }> = {
  "Marcus Emadi": { title: "Director", bio: "Marcus leads Turning Point Capital Advisory, specialising in sponsor-led and lender-led debt advisory.", email: "marcus@tp.finance" },
  "Loredana Emadi": { title: "Head of Research", bio: "Loredana oversees research and analysis across all sectors at Turning Point Capital Advisory.", email: "loredana@tp.finance" },
  "Charlotte Wilson": { title: "Associate Director", bio: "Charlotte supports deal execution and client management across the advisory team.", email: "charlotte@tp.finance" },
};

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getArticleImage(sector: string, slug: string): string {
  const pool = sectorImagePools[sector] || sectorImagePools.general;
  return pool[hashString(slug) % pool.length];
}

function getArticleSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n### $1\n\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function formatDateShort(dateStr: string) {
  try { return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return dateStr; }
}

function formatDateLong(dateStr: string) {
  try { return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
  catch { return dateStr; }
}

function WebsiteCardPreview({ article }: { article: Article }) {
  const slug = getArticleSlug(article.title);
  const heroImage = getArticleImage(article.sector || 'general', slug);
  const sectorLabel = websiteSectorLabels[article.sector] || article.sector || 'General';
  const date = formatDateShort(article.created_at);

  return (
    <div className="space-y-8" style={{ background: '#0A131E', padding: '24px' }}>
      <p className="text-xs font-medium uppercase tracking-widest" style={{ color: '#6B7E8F' }}>Featured Card</p>

      {/* FEATURED CARD */}
      <div className="relative rounded-xl overflow-hidden">
        <div className="relative" style={{ height: '300px', backgroundImage: `url(${heroImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0.4), transparent)' }} />
          <div className="absolute top-4 right-4 rounded px-3 py-1.5 flex items-baseline gap-0.5" style={{ background: 'rgba(10,19,30,0.6)', backdropFilter: 'blur(8px)' }}>
            <span className="font-bold text-lg leading-none" style={{ color: '#74DFF6' }}>TP</span>
            <span className="font-bold text-lg leading-none" style={{ color: '#74DFF6' }}>.</span>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-bold uppercase px-3 py-1 rounded-full" style={{ background: '#74DFF6', color: '#fff' }}>{sectorLabel}</span>
            <span className="text-sm" style={{ color: '#B0BEC5' }}>{date}</span>
          </div>
          <h2 className="text-xl md:text-2xl font-bold mb-2" style={{ color: '#fff' }}>{article.title}</h2>
          <p className="text-sm line-clamp-2" style={{ color: '#B0BEC5' }}>{article.excerpt}</p>
          {article.author && <p className="text-xs mt-3" style={{ color: '#6b7280' }}>By {article.author}</p>}
        </div>
      </div>

      <p className="text-xs font-medium uppercase tracking-widest" style={{ color: '#6B7E8F' }}>Grid Card</p>

      {/* GRID CARD */}
      <div style={{ maxWidth: '360px' }}>
        <div className="rounded-xl overflow-hidden" style={{ background: '#111D2E', border: '1px solid #1A2A3D' }}>
          <div className="relative" style={{ height: '180px', backgroundImage: `url(${heroImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, #111D2E, transparent, transparent)' }} />
            <div className="absolute top-3 left-3">
              <span className="text-xs font-bold uppercase px-2 py-1 rounded-full" style={{ background: 'rgba(116,223,246,0.9)', color: '#fff' }}>{sectorLabel}</span>
            </div>
            <div className="absolute top-3 right-3 rounded px-2 py-1 flex items-baseline gap-0.5" style={{ background: 'rgba(10,19,30,0.6)', backdropFilter: 'blur(8px)' }}>
              <span className="font-bold text-sm leading-none" style={{ color: '#74DFF6' }}>TP</span>
              <span className="font-bold text-sm leading-none" style={{ color: '#74DFF6' }}>.</span>
            </div>
          </div>
          <div className="p-5">
            <p className="text-xs mb-2" style={{ color: '#6b7280' }}>{date}</p>
            <h3 className="font-semibold text-lg mb-2 line-clamp-2" style={{ color: '#fff' }}>{article.title}</h3>
            <p className="text-sm line-clamp-2 mb-3" style={{ color: '#B0BEC5' }}>{article.excerpt}</p>
            <div className="flex items-center justify-between">
              {article.author && <p className="text-xs" style={{ color: '#6b7280' }}>By {article.author}</p>}
              <span className="text-sm font-medium" style={{ color: '#74DFF6' }}>Read more →</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WebsiteArticlePreview({ article }: { article: Article }) {
  const slug = getArticleSlug(article.title);
  const sector = article.sector || 'general';
  const heroImage = getArticleImage(sector, slug);
  const sectorLabel = websiteSectorLabels[sector] || sector;
  const author = article.author || 'Turning Point Capital';
  const aInfo = websiteAuthorInfo[author];
  const date = formatDateLong(article.created_at);
  const cleanContent = article.content ? stripHtmlToText(article.content) : '';
  const paragraphs = cleanContent.split('\n\n').filter((p: string) => p.trim());

  return (
    <div style={{ background: '#0A131E' }}>
      {/* HERO */}
      <div className="relative w-full" style={{ height: '500px', backgroundImage: `url(${heroImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, #0A131E, rgba(10,19,30,0.6), transparent)' }} />
        <div className="absolute top-6 right-12 rounded-lg px-4 py-2 flex items-baseline gap-1" style={{ background: 'rgba(10,19,30,0.6)', backdropFilter: 'blur(8px)' }}>
          <span className="font-bold text-2xl leading-none" style={{ color: '#74DFF6' }}>TP</span>
          <span className="font-bold text-2xl leading-none" style={{ color: '#74DFF6' }}>.</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 pb-12 pt-8">
          <div className="max-w-4xl mx-auto px-4">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-xs font-bold uppercase px-3 py-1 rounded-full" style={{ background: '#74DFF6', color: '#fff' }}>{sectorLabel}</span>
              <span className="text-sm" style={{ color: '#B0BEC5' }}>{date}</span>
            </div>
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold leading-tight" style={{ color: '#fff' }}>{article.title}</h1>
            {author && (
              <p className="mt-4 text-sm" style={{ color: '#B0BEC5' }}>
                By <span className="font-medium" style={{ color: '#fff' }}>{author}</span>
                {aInfo && <span style={{ color: '#6b7280' }}> — {aInfo.title}</span>}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* CONTENT */}
      <div className="max-w-4xl mx-auto px-4 py-12">
        {article.excerpt && (
          <p className="text-lg leading-relaxed mb-8 pl-6 italic" style={{ color: '#B0BEC5', borderLeft: '4px solid #74DFF6' }}>{article.excerpt}</p>
        )}
        <div>
          {paragraphs.map((p: string, i: number) => {
            const trimmed = p.trim();
            if (trimmed.startsWith('### ')) {
              return <h2 key={i} className="text-2xl font-bold mt-10 mb-4" style={{ color: '#fff' }}>{trimmed.replace('### ', '')}</h2>;
            }
            if (trimmed.startsWith('- ')) {
              const items = trimmed.split('\n').filter((line: string) => line.startsWith('- '));
              return (
                <ul key={i} className="list-disc list-inside leading-relaxed mb-6 space-y-2 ml-4" style={{ color: '#d1d5db' }}>
                  {items.map((item: string, j: number) => <li key={j}>{item.replace('- ', '')}</li>)}
                </ul>
              );
            }
            return <p key={i} className="leading-relaxed mb-6" style={{ color: '#d1d5db' }}>{trimmed}</p>;
          })}
        </div>

        {aInfo && (
          <div className="mt-12 p-6 rounded-xl" style={{ background: '#111D2E', border: '1px solid #1A2A3D' }}>
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg flex-shrink-0" style={{ background: '#74DFF6', color: '#fff' }}>{author.charAt(0)}</div>
              <div>
                <p className="font-semibold text-lg" style={{ color: '#fff' }}>{author}</p>
                <p className="text-sm mb-2" style={{ color: '#74DFF6' }}>{aInfo.title}</p>
                <p className="text-sm leading-relaxed mb-3" style={{ color: '#9ca3af' }}>{aInfo.bio}</p>
                <div className="flex items-center gap-4">
                  <span className="text-sm" style={{ color: '#74DFF6' }}>{aInfo.email}</span>
                  <span className="text-sm" style={{ color: '#74DFF6' }}>View full bio</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-8">
          <span className="text-sm" style={{ color: '#74DFF6' }}>← Back to all insights</span>
        </div>
      </div>
    </div>
  );
}

// ─── Article Detail Modal ─────────────────────────────────────────────────────

function ArticleDetailModal({
  articleId,
  onClose,
  onRefresh,
}: {
  articleId: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [viewTab, setViewTab] = useState<'article' | 'email' | 'thumbnail' | 'website'>('thumbnail');
  const [emailPreviewHtml, setEmailPreviewHtml] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editExcerpt, setEditExcerpt] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editSector, setEditSector] = useState('');
  const [editAuthor, setEditAuthor] = useState('');

  const loadArticle = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchArticle(articleId);
      const a = res.data;
      setArticle(a);
      setEditTitle(a.title || '');
      setEditExcerpt(a.excerpt || '');
      setEditContent(a.content || '');
      setEditSector(a.sector || 'general');
      setEditAuthor(a.author || AUTHORS[0]);
    } catch (err) {
      console.error('Failed to load article:', err);
    } finally {
      setLoading(false);
    }
  }, [articleId]);

  useEffect(() => {
    loadArticle();
  }, [loadArticle]);

  const loadEmailPreview = useCallback(async () => {
    setLoadingPreview(true);
    try {
      const res = await api.get(`/articles/${articleId}/preview-email`, { responseType: 'text' });
      setEmailPreviewHtml(typeof res.data === 'string' ? res.data : '');
    } catch {
      setEmailPreviewHtml('<p style="color:red;padding:20px;">Failed to load preview</p>');
    } finally {
      setLoadingPreview(false);
    }
  }, [articleId]);

  useEffect(() => {
    if (viewTab === 'email' && !emailPreviewHtml) loadEmailPreview();
  }, [viewTab, emailPreviewHtml, loadEmailPreview]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateArticle(articleId, {
        title: editTitle,
        excerpt: editExcerpt,
        content: editContent,
        sector: editSector,
        author: editAuthor,
      });
      await loadArticle();
      setEditing(false);
      onRefresh();
    } catch (err) {
      console.error('Failed to save article:', err);
    } finally {
      setSaving(false);
    }
  };

  const [publishResult, setPublishResult] = useState<{ published_at: string; live_verified: boolean; live_url: string; slug: string } | null>(null);

  const handlePublish = async () => {
    if (!confirm('Publish this article to the website? It will appear on www.tp.finance/insights.')) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await publishArticle(articleId);
      setPublishResult(res.data);
      await loadArticle();
      onRefresh();
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'Failed to publish article';
      alert(msg);
      console.error('Failed to publish article:', err);
    } finally {
      setPublishing(false);
    }
  };

  const handleReject = async () => {
    if (!confirm('Reject this article? It will be marked as rejected.')) return;
    setRejecting(true);
    try {
      await updateArticle(articleId, { status: 'rejected' });
      await loadArticle();
      onRefresh();
    } catch (err) {
      console.error('Failed to reject article:', err);
    } finally {
      setRejecting(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
        <div className="bg-[#0A131E] border border-[#1A2A3D] rounded-xl p-8">
          <Loader2 size={24} className="animate-spin text-[#74DFF6]" />
        </div>
      </div>
    );
  }

  if (!article) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
        <div className="bg-[#0A131E] border border-[#1A2A3D] rounded-xl p-8 text-center">
          <p className="text-red-400 text-sm">Failed to load article</p>
          <button onClick={onClose} className="mt-3 text-[#74DFF6] text-sm hover:underline">Close</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/80 flex items-start justify-center z-50 p-4 pt-6 overflow-y-auto">
        <div className={`relative w-full bg-[#0A131E] rounded-xl overflow-hidden shadow-2xl mb-6 border border-[#1A2A3D] transition-all ${viewTab === 'website' || viewTab === 'thumbnail' ? 'max-w-4xl' : 'max-w-3xl'}`}>
          {/* Header */}
          <div className="flex items-start justify-between px-6 py-4 border-b border-[#1A2A3D]">
            <div className="flex-1 min-w-0 mr-4">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <StatusBadge status={article.status} />
                <SectorBadge sector={article.sector} />
                {article.broadcasts && article.broadcasts.length > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-900/30 text-purple-400">
                    <Radio size={9} />
                    Emailed
                  </span>
                )}
              </div>
              {editing ? (
                <input
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  className="w-full mt-2 bg-[#111D2E] border border-[#1A2A3D] text-white rounded px-3 py-2 text-base font-semibold focus:outline-none focus:border-[#1993C5]"
                />
              ) : (
                <h2 className="text-white font-semibold text-base mt-1 leading-snug">{article.title}</h2>
              )}
              <div className="flex items-center gap-3 mt-1.5 text-xs text-[#6B7E8F]">
                <span>by {article.author}</span>
                <span>{formatDate(article.created_at)}</span>
                {article.source_url && (
                  <a href={article.source_url} target="_blank" rel="noopener noreferrer" className="text-[#74DFF6] hover:underline">
                    Source
                  </a>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {!editing && (
                <button
                  onClick={() => setEditing(true)}
                  className="text-[#6B7E8F] hover:text-[#74DFF6] p-1.5 rounded transition-colors"
                  title="Edit"
                >
                  <Edit2 size={16} />
                </button>
              )}
              <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5] p-1.5">
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Publish confirmation banner */}
          {publishResult && (
            <div className={`mx-6 mt-3 p-3 rounded-lg border text-sm ${publishResult.live_verified ? 'bg-green-900/20 border-green-800/40' : 'bg-amber-900/20 border-amber-800/40'}`}>
              <div className="flex items-center gap-2">
                {publishResult.live_verified ? (
                  <Check size={16} className="text-green-400 flex-shrink-0" />
                ) : (
                  <Clock size={16} className="text-amber-400 flex-shrink-0" />
                )}
                <div>
                  <p className={publishResult.live_verified ? 'text-green-400 font-medium' : 'text-amber-400 font-medium'}>
                    {publishResult.live_verified ? 'Published and verified live' : 'Published — awaiting verification'}
                  </p>
                  <p className="text-[#6B7E8F] text-xs mt-0.5">
                    {new Date(publishResult.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} at {new Date(publishResult.published_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                {publishResult.live_verified && (
                  <a
                    href={publishResult.live_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[#74DFF6] text-xs hover:underline flex-shrink-0"
                  >
                    View live →
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Published info (for already-published articles) */}
          {!publishResult && article.status === 'published' && article.published_at && (
            <div className="mx-6 mt-3 p-3 rounded-lg border bg-green-900/10 border-green-800/30 text-sm">
              <div className="flex items-center gap-2">
                <Globe size={16} className="text-green-400 flex-shrink-0" />
                <div>
                  <p className="text-green-400 font-medium">Published on website</p>
                  <p className="text-[#6B7E8F] text-xs mt-0.5">
                    {new Date(article.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} at {new Date(article.published_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <a
                  href={`https://tp.finance/insights/${article.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto text-[#74DFF6] text-xs hover:underline flex-shrink-0"
                >
                  View live →
                </a>
              </div>
            </div>
          )}

          {/* Broadcast info */}
          {article.broadcasts && article.broadcasts.length > 0 && (
            <div className="mx-6 mt-3 p-3 rounded-lg border bg-purple-900/10 border-purple-800/30 text-sm">
              <div className="flex items-center gap-2">
                <Radio size={16} className="text-purple-400 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-purple-400 font-medium">Broadcast sent</p>
                  {article.broadcasts.map((b, i) => {
                    const sent = Number(b.actual_sent) || 0;
                    const failed = Number(b.actual_failed) || 0;
                    const total = b.total_contacts;
                    const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
                    const done = sent + failed >= total;
                    return (
                      <div key={i} className="mt-1">
                        <p className="text-[#6B7E8F] text-xs">
                          {new Date(b.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} at {new Date(b.sent_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="text-white text-xs mt-0.5">
                          {sent.toLocaleString()} / {total.toLocaleString()} sent ({pct}%){failed > 0 && <span className="text-red-400 ml-1">· {failed.toLocaleString()} failed</span>}
                          {done
                            ? <span className="text-green-400 ml-1">· Complete</span>
                            : <span className="text-amber-400 ml-1">· Sending</span>}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* View tabs */}
          {!editing && (
            <div className="flex border-b border-[#1A2A3D] overflow-x-auto">
              {([
                { key: 'thumbnail' as const, icon: <Layout size={14} />, label: 'Website Card' },
                { key: 'website' as const, icon: <Eye size={14} />, label: 'Full Article' },
                { key: 'email' as const, icon: <Mail size={14} />, label: 'Broadcast Email' },
                { key: 'article' as const, icon: <FileText size={14} />, label: 'Raw Content' },
              ]).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setViewTab(tab.key)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${viewTab === tab.key ? 'border-[#74DFF6] text-[#74DFF6]' : 'border-transparent text-[#6B7E8F] hover:text-[#B0BEC5]'}`}
                >
                  {tab.icon} {tab.label}
                </button>
              ))}
            </div>
          )}

          {/* Body */}
          <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
            {editing ? (
              <>
                <div>
                  <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Excerpt</label>
                  <textarea
                    value={editExcerpt}
                    onChange={e => setEditExcerpt(e.target.value)}
                    rows={3}
                    className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] resize-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Sector</label>
                    <select
                      value={editSector}
                      onChange={e => setEditSector(e.target.value)}
                      className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
                    >
                      {SECTORS.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Author</label>
                    <select
                      value={editAuthor}
                      onChange={e => setEditAuthor(e.target.value)}
                      className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
                    >
                      {AUTHORS.map(a => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Content (HTML)</label>
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    rows={16}
                    className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#1993C5] resize-y"
                  />
                </div>
              </>
            ) : viewTab === 'email' ? (
              <>
                {loadingPreview ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 size={24} className="animate-spin text-[#74DFF6]" />
                    <span className="ml-3 text-[#6B7E8F] text-sm">Rendering broadcast email...</span>
                  </div>
                ) : emailPreviewHtml ? (
                  <div className="bg-[#080E18] rounded-lg overflow-hidden border border-[#1A2A3D]">
                    <div className="px-3 py-2 bg-[#111D2E] border-b border-[#1A2A3D] flex items-center justify-between">
                      <span className="text-[#6B7E8F] text-xs">This is how the broadcast email will appear in inboxes</span>
                      <button
                        onClick={() => { setEmailPreviewHtml(null); loadEmailPreview(); }}
                        className="text-[#74DFF6] text-xs hover:underline"
                      >Refresh</button>
                    </div>
                    <iframe
                      srcDoc={emailPreviewHtml}
                      style={{ width: '100%', height: '700px', border: 'none', background: '#080E18' }}
                      title="Email Preview"
                    />
                  </div>
                ) : null}
              </>
            ) : viewTab === 'thumbnail' ? (
              <WebsiteCardPreview article={article} />
            ) : viewTab === 'website' ? (
              <WebsiteArticlePreview article={article} />
            ) : (
              <>
                {article.excerpt && (
                  <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-lg px-4 py-3">
                    <p className="text-[#B0BEC5] text-sm italic leading-relaxed">{article.excerpt}</p>
                  </div>
                )}
                <div
                  className="prose prose-invert prose-sm max-w-none
                    prose-headings:text-white prose-p:text-[#B0BEC5] prose-a:text-[#74DFF6]
                    prose-strong:text-white prose-li:text-[#B0BEC5]
                    [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm
                    [&_p]:leading-relaxed [&_ul]:pl-4 [&_ol]:pl-4"
                  dangerouslySetInnerHTML={{ __html: article.content }}
                />
              </>
            )}
          </div>

          {/* Footer actions */}
          <div className="px-6 py-4 border-t border-[#1A2A3D] flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditTitle(article.title);
                    setEditExcerpt(article.excerpt);
                    setEditContent(article.content);
                    setEditSector(article.sector);
                    setEditAuthor(article.author);
                  }}
                  className="border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#6B7E8F] rounded-lg px-4 py-2 text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </>
            ) : (
              <>
                {article.status !== 'published' && article.status !== 'rejected' && (
                  <button
                    onClick={handlePublish}
                    disabled={publishing}
                    className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5"
                  >
                    {publishing ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
                    {publishing ? 'Publishing...' : 'Publish to Website'}
                  </button>
                )}

                <button
                  onClick={() => setShowBroadcast(true)}
                  className="bg-[#1993C5] hover:bg-[#1578A2] text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5"
                >
                  <Radio size={14} />
                  Broadcast Email
                </button>

                {article.status !== 'rejected' && (
                  <button
                    onClick={handleReject}
                    disabled={rejecting}
                    className="bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-800/40 rounded-lg px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5"
                  >
                    {rejecting ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                    Reject
                  </button>
                )}

                <div className="flex-1" />

                <button
                  onClick={onClose}
                  className="border border-[#1A2A3D] text-[#6B7E8F] hover:text-[#B0BEC5] hover:border-[#6B7E8F] rounded-lg px-4 py-2 text-sm transition-colors"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {showBroadcast && (
        <BroadcastModal
          article={article}
          onClose={() => setShowBroadcast(false)}
        />
      )}
    </>
  );
}

// ─── Article Card ─────────────────────────────────────────────────────────────

function ArticleCard({ article, onClick }: { article: Article; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl p-4 text-left hover:border-[#1993C5]/40 transition-colors group w-full"
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <StatusBadge status={article.status} />
        <SectorBadge sector={article.sector} />
        {article.broadcast_count != null && Number(article.broadcast_count) > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-900/30 text-purple-400">
            <Radio size={9} />
            Emailed
          </span>
        )}
      </div>
      <h3 className="text-white font-semibold text-sm leading-snug mb-1.5 group-hover:text-[#74DFF6] transition-colors line-clamp-2">
        {article.title}
      </h3>
      <p className="text-[#6B7E8F] text-xs leading-relaxed mb-3 line-clamp-3">
        {article.excerpt || truncate(article.content?.replace(/<[^>]*>/g, '') || '', 120)}
      </p>
      <div className="flex items-center justify-between text-xs text-[#6B7E8F]">
        <span>{article.author}</span>
        <span>{formatDate(article.created_at)}</span>
      </div>
    </button>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Articles() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sectorFilter, setSectorFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSectorDropdown, setShowSectorDropdown] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduleStartDate, setScheduleStartDate] = useState('');
  const [scheduleSubsectors, setScheduleSubsectors] = useState<Set<string>>(new Set());
  const [scheduleBroadcastDelay, setScheduleBroadcastDelay] = useState(2);
  const [scheduleSelected, setScheduleSelected] = useState<Set<string>>(new Set());
  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<{ success: boolean; message: string } | null>(null);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const status = (statusFilter === 'all' || statusFilter === 'broadcasted') ? undefined : statusFilter;
      const sector = sectorFilter || undefined;
      const res = await fetchArticles(status, sector);
      setArticles(Array.isArray(res.data) ? res.data : res.data?.articles || []);
    } catch (err) {
      console.error('Failed to load articles:', err);
      setArticles([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, sectorFilter]);

  useEffect(() => {
    loadArticles();
  }, [loadArticles]);

  // Stats
  const stats = {
    total: articles.length,
    draft: articles.filter(a => a.status === 'draft').length,
    published: articles.filter(a => a.status === 'published').length,
    broadcasted: articles.filter(a => (a.broadcast_count || 0) > 0).length,
  };

  const displayed = statusFilter === 'broadcasted'
    ? articles.filter(a => (a.broadcast_count || 0) > 0)
    : articles;

  return (
    <div className="min-h-screen bg-[#0A131E] p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="text-white text-xl font-bold">Article Drafts</h1>
            <p className="text-[#6B7E8F] text-sm mt-0.5">Research &rarr; TPCA Pipeline</p>
          </div>
          <button
            onClick={loadArticles}
            disabled={loading}
            className="flex items-center gap-1.5 text-[#74DFF6] hover:text-white text-sm transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap gap-3 mb-6">
        <StatCard label="Total Drafts" value={stats.total} icon={<FileText size={18} />} />
        <StatCard label="Pending Review" value={stats.draft} icon={<Clock size={18} />} />
        <StatCard label="Published" value={stats.published} icon={<Globe size={18} />} />
        <StatCard label="Broadcasted" value={stats.broadcasted} icon={<Radio size={18} />} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Status pills */}
        <div className="flex items-center gap-1.5">
          <Filter size={14} className="text-[#6B7E8F] mr-1" />
          {STATUS_FILTERS.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors
                ${statusFilter === s
                  ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/40'
                  : 'bg-[#111D2E] text-[#6B7E8F] border border-[#1A2A3D] hover:border-[#1993C5]/30 hover:text-[#B0BEC5]'
                }`}
            >
              {s === 'all' ? 'All' : STATUS_CONFIG[s]?.label || s}
            </button>
          ))}
        </div>

        {/* Sector dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowSectorDropdown(!showSectorDropdown)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border
              ${sectorFilter
                ? 'bg-[#1993C5]/20 text-[#74DFF6] border-[#1993C5]/40'
                : 'bg-[#111D2E] text-[#6B7E8F] border-[#1A2A3D] hover:border-[#1993C5]/30'
              }`}
          >
            {sectorFilter ? SECTORS.find(s => s.value === sectorFilter)?.label || sectorFilter : 'Sector'}
            <ChevronDown size={12} />
          </button>
          {showSectorDropdown && (
            <div className="absolute top-full left-0 mt-1 bg-[#111D2E] border border-[#1A2A3D] rounded-lg shadow-xl z-20 py-1 min-w-[160px]">
              <button
                onClick={() => { setSectorFilter(''); setShowSectorDropdown(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#1A2A3D] transition-colors
                  ${!sectorFilter ? 'text-[#74DFF6]' : 'text-[#B0BEC5]'}`}
              >
                All Sectors
              </button>
              {SECTORS.map(s => (
                <button
                  key={s.value}
                  onClick={() => { setSectorFilter(s.value); setShowSectorDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#1A2A3D] transition-colors
                    ${sectorFilter === s.value ? 'text-[#74DFF6]' : 'text-[#B0BEC5]'}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Schedule Sequence Panel */}
      <div className="mb-6">
        <button
          onClick={() => setShowScheduler(!showScheduler)}
          className="flex items-center gap-2 text-sm text-[#74DFF6] hover:text-white transition-colors mb-3"
        >
          <Calendar size={14} />
          {showScheduler ? 'Hide Scheduler' : 'Schedule 7-Day Sequence'}
          <ChevronDown size={12} className={`transition-transform ${showScheduler ? 'rotate-180' : ''}`} />
        </button>

        {showScheduler && (
          <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-semibold text-sm">Schedule Publishing & Broadcast Sequence</h3>
              <span className="text-[#6B7E8F] text-xs">{scheduleSelected.size} article(s) selected</span>
            </div>

            {/* Settings row */}
            <div className="flex flex-wrap gap-4 items-end">
              <div>
                <label className="text-[#6B7E8F] text-xs block mb-1">Start Date</label>
                <input
                  type="date"
                  value={scheduleStartDate}
                  onChange={e => setScheduleStartDate(e.target.value)}
                  className="bg-[#0A131E] border border-[#1A2A3D] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
                />
              </div>
              <div>
                <label className="text-[#6B7E8F] text-xs block mb-1">Broadcast Delay (hours after publish)</label>
                <input
                  type="number"
                  value={scheduleBroadcastDelay}
                  onChange={e => setScheduleBroadcastDelay(Number(e.target.value))}
                  min={0}
                  max={168}
                  className="bg-[#0A131E] border border-[#1A2A3D] text-white rounded-lg px-3 py-2 text-sm w-20 focus:outline-none focus:border-[#1993C5]"
                />
              </div>
            </div>

            {/* Subsector selection */}
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[#6B7E8F] text-xs">Broadcast to:</span>
                <button onClick={() => { const s = new Set(scheduleSubsectors); INTRODUCER_SUBSECTORS.forEach(x => s.add(x.key)); CLIENT_SUBSECTORS.forEach(x => s.add(x.key)); setScheduleSubsectors(s); }} className="text-[#74DFF6] text-xs hover:underline">All</button>
                <button onClick={() => { const s = new Set(scheduleSubsectors); INTRODUCER_SUBSECTORS.forEach(x => s.add(x.key)); setScheduleSubsectors(s); }} className="text-[#74DFF6] text-xs hover:underline">All Introducers</button>
                <button onClick={() => { const s = new Set(scheduleSubsectors); CLIENT_SUBSECTORS.forEach(x => s.add(x.key)); setScheduleSubsectors(s); }} className="text-[#74DFF6] text-xs hover:underline">All Clients</button>
                {scheduleSubsectors.size > 0 && <button onClick={() => setScheduleSubsectors(new Set())} className="text-red-400 text-xs hover:underline">Clear</button>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[...INTRODUCER_SUBSECTORS, ...CLIENT_SUBSECTORS].map(sub => (
                  <button
                    key={sub.key}
                    onClick={() => { const s = new Set(scheduleSubsectors); s.has(sub.key) ? s.delete(sub.key) : s.add(sub.key); setScheduleSubsectors(s); }}
                    className={`px-2 py-1 rounded text-xs transition-colors ${scheduleSubsectors.has(sub.key) ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/40' : 'bg-[#0A131E] text-[#6B7E8F] border border-[#1A2A3D] hover:border-[#1993C5]/30'}`}
                  >
                    {sub.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Article selection */}
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[#6B7E8F] text-xs">Select articles (drag order = publish order):</span>
                <button
                  onClick={() => {
                    const drafts = articles.filter(a => a.status === 'draft').map(a => a.id);
                    setScheduleSelected(new Set(drafts));
                  }}
                  className="text-[#74DFF6] text-xs hover:underline"
                >
                  Select all drafts
                </button>
              </div>
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {articles.filter(a => a.status === 'draft').map((a, idx) => (
                  <label
                    key={a.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm ${scheduleSelected.has(a.id) ? 'bg-[#1993C5]/10 border-[#1993C5]/30 text-white' : 'bg-[#0A131E] border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5]/20'}`}
                  >
                    <input
                      type="checkbox"
                      checked={scheduleSelected.has(a.id)}
                      onChange={() => { const s = new Set(scheduleSelected); s.has(a.id) ? s.delete(a.id) : s.add(a.id); setScheduleSelected(s); }}
                      className="sr-only"
                    />
                    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${scheduleSelected.has(a.id) ? 'bg-[#1993C5] border-[#1993C5]' : 'border-[#1A2A3D]'}`}>
                      {scheduleSelected.has(a.id) && <Check size={10} className="text-white" />}
                    </span>
                    <span className="flex-1 truncate">{a.title}</span>
                    {scheduleSelected.has(a.id) && scheduleStartDate && (
                      <span className="text-[#6B7E8F] text-xs flex-shrink-0">
                        {new Date(new Date(scheduleStartDate).getTime() + Array.from(scheduleSelected).indexOf(a.id) * 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                    {a.scheduled_publish_at && (
                      <span className="text-amber-400 text-xs flex-shrink-0">
                        Scheduled: {new Date(a.scheduled_publish_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>

            {/* Schedule button */}
            <div className="flex items-center gap-3">
              <button
                onClick={async () => {
                  if (scheduleSelected.size === 0 || !scheduleStartDate || scheduleSubsectors.size === 0) return;
                  setScheduling(true);
                  setScheduleResult(null);
                  try {
                    const ids = Array.from(scheduleSelected);
                    const res = await scheduleSequence(ids, scheduleStartDate, Array.from(scheduleSubsectors), scheduleBroadcastDelay);
                    setScheduleResult({ success: true, message: `Scheduled ${res.data.scheduled.length} articles starting ${scheduleStartDate}` });
                    loadArticles();
                  } catch (err: any) {
                    setScheduleResult({ success: false, message: err.response?.data?.error || 'Failed to schedule' });
                  } finally {
                    setScheduling(false);
                  }
                }}
                disabled={scheduling || scheduleSelected.size === 0 || !scheduleStartDate || scheduleSubsectors.size === 0}
                className="bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-40 text-white rounded-lg px-5 py-2.5 text-sm font-medium transition-colors flex items-center gap-2"
              >
                {scheduling ? <Loader2 size={14} className="animate-spin" /> : <Calendar size={14} />}
                {scheduling ? 'Scheduling...' : `Schedule ${scheduleSelected.size} Article${scheduleSelected.size !== 1 ? 's' : ''}`}
              </button>
              {scheduleResult && (
                <span className={`text-sm ${scheduleResult.success ? 'text-green-400' : 'text-red-400'}`}>
                  {scheduleResult.message}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Article grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={28} className="animate-spin text-[#74DFF6]" />
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-20">
          <FileText size={40} className="text-[#1A2A3D] mx-auto mb-3" />
          <p className="text-[#6B7E8F] text-sm">No articles found</p>
          <p className="text-[#4A5568] text-xs mt-1">
            {statusFilter !== 'all' || sectorFilter
              ? 'Try adjusting your filters'
              : 'Articles from the research pipeline will appear here'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {displayed.map(article => (
            <ArticleCard
              key={article.id}
              article={article}
              onClick={() => setSelectedId(article.id)}
            />
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selectedId && (
        <ArticleDetailModal
          articleId={selectedId}
          onClose={() => setSelectedId(null)}
          onRefresh={loadArticles}
        />
      )}

      {/* Click-away for sector dropdown */}
      {showSectorDropdown && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setShowSectorDropdown(false)}
        />
      )}
    </div>
  );
}
