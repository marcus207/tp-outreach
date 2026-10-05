import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  Megaphone, X, Check, Edit2, Send, Loader2, RefreshCw,
  Plus, Trash2, ChevronDown, ChevronRight, Mail, Clock,
  CheckCircle, FileText, Users, Download, Image as ImageIcon,
  Layers, Linkedin,
} from 'lucide-react';

const api = axios.create({ baseURL: '/outreach/api', withCredentials: true });

// ─── Media assets (hosted under /outreach/press-assets/) ───────────────────────
const MEDIA_ASSETS = [
  { label: 'Deal poster (1200x1500)', file: 'poster.png', icon: ImageIcon },
  { label: 'LinkedIn carousel (4-slide PDF)', file: 'SEN-carousel.pdf', icon: Layers },
  { label: 'LinkedIn write-up', file: 'linkedin-post.txt', icon: Linkedin },
  { label: 'Press release (text)', file: 'press-release.md', icon: FileText },
  { label: 'Warm follow-up emails (18)', file: 'warm-emails.md', icon: Mail },
];

// The SEN announcement article (drives the broadcast email preview)
const SEN_ARTICLE_ID = 'c624af9c-f5cb-4aac-bcd7-4da4a8ef14a2';

function EmailPreviewPanel() {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl p-4 mb-6">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 w-full text-left">
        <Mail size={16} className="text-[#74DFF6]" />
        <h3 className="text-white text-sm font-semibold">Announcement email preview</h3>
        <span className="text-[#6B7E8F] text-xs">exactly what recipients receive</span>
        {open ? <ChevronDown size={16} className="text-[#6B7E8F] ml-auto" /> : <ChevronRight size={16} className="text-[#6B7E8F] ml-auto" />}
      </button>
      {open && (
        <div className="mt-3 rounded-lg overflow-hidden border border-[#1A2A3D] bg-white">
          <iframe
            title="Announcement email preview"
            src={`/outreach/api/articles/${SEN_ARTICLE_ID}/preview-email`}
            className="w-full"
            style={{ height: 900, border: 0, background: '#fff' }}
          />
        </div>
      )}
    </div>
  );
}

function MediaAssetsPanel() {
  return (
    <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Download size={16} className="text-[#74DFF6]" />
        <h3 className="text-white text-sm font-semibold">Media Assets</h3>
        <span className="text-[#6B7E8F] text-xs">SEN £19m facility — download or copy for sharing</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {MEDIA_ASSETS.map(({ label, file, icon: Icon }) => (
          <a key={file} href={`/outreach/press-assets/${file}`} target="_blank" rel="noopener noreferrer" download
            className="flex items-center gap-2.5 bg-[#0A131E] border border-[#1A2A3D] hover:border-[#1993C5] rounded-lg px-3 py-2.5 transition-colors group">
            <Icon size={18} className="text-[#74DFF6] shrink-0" />
            <span className="text-[#B0BEC5] group-hover:text-white text-xs leading-tight">{label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PressContact {
  id: string;
  publication: string;
  publication_url: string;
  contact_name: string;
  contact_role: string;
  email: string;
  focus_notes: string;
  is_primary: boolean;
}

interface PressRelease {
  id: string;
  announcement_title: string;
  publication: string;
  headline: string;
  subheadline: string;
  dateline: string;
  body: string;
  spokesperson_name: string;
  spokesperson_title: string;
  spokesperson_quote: string;
  boilerplate: string;
  notes_to_editors: string;
  status: 'draft' | 'approved' | 'sent';
  sent_at: string | null;
  contact_name: string;
  contact_email: string;
  publication_url: string;
  focus_notes: string;
  created_at: string;
}

interface Announcement {
  announcement_title: string;
  release_count: number;
  sent_count: number;
  draft_count: number;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    draft: { bg: 'bg-amber-900/30', text: 'text-amber-400', label: 'Draft' },
    approved: { bg: 'bg-blue-900/30', text: 'text-blue-400', label: 'Approved' },
    sent: { bg: 'bg-green-900/30', text: 'text-green-400', label: 'Sent' },
  };
  const c = cfg[status] || cfg.draft;
  return <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>{c.label}</span>;
}

function formatDate(iso: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Generate Modal ───────────────────────────────────────────────────────────

function GenerateModal({
  contacts,
  onClose,
  onGenerated,
}: {
  contacts: PressContact[];
  onClose: () => void;
  onGenerated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selectedPubs, setSelectedPubs] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const publications = [...new Set(contacts.filter(c => c.is_primary).map(c => c.publication))];

  const togglePub = (pub: string) => {
    setSelectedPubs(prev => {
      const next = new Set(prev);
      if (next.has(pub)) next.delete(pub);
      else next.add(pub);
      return next;
    });
  };

  const selectAll = () => setSelectedPubs(new Set(publications));

  const handleGenerate = async () => {
    if (!title || !body || selectedPubs.size === 0) return;
    setGenerating(true);
    setResult(null);
    try {
      const res = await api.post('/press-releases/generate', {
        announcement_title: title,
        announcement_body: body,
        publications: Array.from(selectedPubs),
      });
      setResult(`Generated ${res.data.count} press releases`);
      onGenerated();
    } catch (err: any) {
      setResult(err.response?.data?.error || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0A131E] border border-[#1A2A3D] rounded-xl w-full max-w-2xl shadow-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1A2A3D]">
          <h3 className="text-white font-semibold">Generate Press Releases</h3>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Announcement Title</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Turning Point Capital Launches CRE Debt Advisory Service"
              className="w-full bg-[#111D2E] border border-[#1A2A3D] text-white rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
            />
          </div>

          <div>
            <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Announcement Body</label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={6}
              placeholder="Write the core announcement content. Each publication will get a uniquely angled version..."
              className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] resize-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[#6B7E8F] text-xs font-medium">Target Publications ({selectedPubs.size}/{publications.length})</label>
              <button onClick={selectAll} className="text-[#74DFF6] text-xs hover:underline">Select All</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {publications.map(pub => (
                <label
                  key={pub}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm
                    ${selectedPubs.has(pub)
                      ? 'bg-[#1993C5]/15 border-[#1993C5]/40 text-[#74DFF6]'
                      : 'bg-[#111D2E] border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5]/30'}`}
                >
                  <input type="checkbox" checked={selectedPubs.has(pub)} onChange={() => togglePub(pub)} className="sr-only" />
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0
                    ${selectedPubs.has(pub) ? 'bg-[#1993C5] border-[#1993C5]' : 'border-[#1A2A3D]'}`}>
                    {selectedPubs.has(pub) && <Check size={10} className="text-white" />}
                  </span>
                  <span className="truncate">{pub}</span>
                </label>
              ))}
            </div>
          </div>

          {result && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              result.includes('Generated')
                ? 'bg-green-900/30 text-green-400 border border-green-800/40'
                : 'bg-red-900/30 text-red-400 border border-red-800/40'
            }`}>{result}</div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[#1A2A3D] flex gap-3">
          <button onClick={onClose} className="flex-1 border border-[#1A2A3D] text-[#B0BEC5] rounded-lg px-4 py-2.5 text-sm">Cancel</button>
          <button
            onClick={handleGenerate}
            disabled={generating || !title || !body || selectedPubs.size === 0}
            className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-40 text-white rounded-lg px-4 py-2.5 text-sm font-medium flex items-center justify-center gap-2"
          >
            {generating ? <><Loader2 size={14} className="animate-spin" /> Generating...</> : <><Megaphone size={14} /> Generate Releases</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Press Release Detail Modal ───────────────────────────────────────────────

function DetailModal({
  releaseId,
  onClose,
  onRefresh,
}: {
  releaseId: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [pr, setPr] = useState<PressRelease | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const [editHeadline, setEditHeadline] = useState('');
  const [editSubheadline, setEditSubheadline] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editQuote, setEditQuote] = useState('');
  const [editSpokesperson, setEditSpokesperson] = useState('');
  const [editSpokespersonTitle, setEditSpokespersonTitle] = useState('');
  const [editNotes, setEditNotes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/press-releases/${releaseId}`);
      const d = res.data;
      setPr(d);
      setEditHeadline(d.headline || '');
      setEditSubheadline(d.subheadline || '');
      setEditBody(d.body || '');
      setEditQuote(d.spokesperson_quote || '');
      setEditSpokesperson(d.spokesperson_name || 'Marcus Emadi');
      setEditSpokespersonTitle(d.spokesperson_title || 'CEO, Turning Point Capital');
      setEditNotes(d.notes_to_editors || '');
    } catch {
      console.error('Failed to load press release');
    } finally {
      setLoading(false);
    }
  }, [releaseId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put(`/press-releases/${releaseId}`, {
        headline: editHeadline,
        subheadline: editSubheadline,
        body: editBody,
        spokesperson_quote: editQuote,
        spokesperson_name: editSpokesperson,
        spokesperson_title: editSpokespersonTitle,
        notes_to_editors: editNotes,
      });
      await load();
      setEditing(false);
      onRefresh();
    } catch {
      console.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleSend = async () => {
    if (!confirm(`Send this press release to ${pr?.contact_email}?`)) return;
    setSending(true);
    try {
      await api.post(`/press-releases/${releaseId}/send`);
      await load();
      onRefresh();
    } catch {
      console.error('Failed to send');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
        <div className="bg-[#0A131E] border border-[#1A2A3D] rounded-xl p-8">
          <Loader2 size={24} className="animate-spin text-[#74DFF6]" />
        </div>
      </div>
    );
  }

  if (!pr) return null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-start justify-center z-50 p-4 pt-6 overflow-y-auto">
      <div className="w-full max-w-3xl bg-[#0A131E] rounded-xl border border-[#1A2A3D] shadow-2xl mb-6">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-[#1A2A3D]">
          <div className="flex-1 min-w-0 mr-4">
            <div className="flex items-center gap-2 mb-1">
              <StatusBadge status={pr.status} />
              <span className="text-[#74DFF6] text-xs bg-[#1993C5]/20 px-2 py-0.5 rounded">{pr.publication}</span>
            </div>
            <h2 className="text-white font-semibold text-base mt-1">{pr.headline}</h2>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-[#6B7E8F]">
              <span>{pr.contact_name} — {pr.contact_email}</span>
              {pr.sent_at && <span>Sent {formatDate(pr.sent_at)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!editing && pr.status !== 'sent' && (
              <button onClick={() => setEditing(true)} className="text-[#6B7E8F] hover:text-[#74DFF6] p-1.5"><Edit2 size={16} /></button>
            )}
            <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5] p-1.5"><X size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {editing ? (
            <>
              <div>
                <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Headline</label>
                <input value={editHeadline} onChange={e => setEditHeadline(e.target.value)}
                  className="w-full bg-[#111D2E] border border-[#1A2A3D] text-white rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
              </div>
              <div>
                <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Subheadline</label>
                <input value={editSubheadline} onChange={e => setEditSubheadline(e.target.value)}
                  className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
              </div>
              <div>
                <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Body</label>
                <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={10}
                  className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] resize-y" />
              </div>
              <div>
                <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Spokesperson Quote</label>
                <textarea value={editQuote} onChange={e => setEditQuote(e.target.value)} rows={3}
                  className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Spokesperson</label>
                  <input value={editSpokesperson} onChange={e => setEditSpokesperson(e.target.value)}
                    className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
                </div>
                <div>
                  <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Title</label>
                  <input value={editSpokespersonTitle} onChange={e => setEditSpokespersonTitle(e.target.value)}
                    className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
                </div>
              </div>
              <div>
                <label className="block text-[#6B7E8F] text-xs font-medium mb-1">Notes to Editors</label>
                <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={3}
                  className="w-full bg-[#111D2E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] resize-none" />
              </div>
            </>
          ) : (
            !pr.headline ? (
            <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-lg p-5">
              {pr.subheadline && <p className="text-[#6B7E8F] text-xs mb-3">Subject: {pr.subheadline}</p>}
              <div className="text-[#B0BEC5] text-sm leading-relaxed whitespace-pre-wrap">{pr.body}</div>
            </div>
            ) : (
            <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-lg p-5 space-y-4">
              <p className="text-[#6B7E8F] text-xs uppercase tracking-widest font-bold">For Immediate Release</p>
              <h3 className="text-white text-lg font-bold">{pr.headline}</h3>
              {pr.subheadline && <p className="text-[#B0BEC5] text-sm italic">{pr.subheadline}</p>}
              <div className="text-[#B0BEC5] text-sm leading-relaxed whitespace-pre-wrap">
                {pr.dateline && <><strong>{pr.dateline}</strong> — </>}
                {pr.body}
              </div>
              {pr.spokesperson_quote && (
                <div className="border-l-2 border-[#1993C5] pl-4 my-4">
                  <p className="text-[#B0BEC5] text-sm italic leading-relaxed">{pr.spokesperson_quote}</p>
                  <p className="text-[#6B7E8F] text-xs mt-2">— {pr.spokesperson_name}, {pr.spokesperson_title}</p>
                </div>
              )}
              <p className="text-[#6B7E8F] text-xs text-center tracking-widest mt-4">— ENDS —</p>
              {pr.boilerplate && (
                <div className="border-t border-[#1A2A3D] pt-4 mt-4">
                  <p className="text-[#6B7E8F] text-xs font-bold uppercase mb-2">About Turning Point Capital</p>
                  <p className="text-[#6B7E8F] text-xs leading-relaxed">{pr.boilerplate}</p>
                </div>
              )}
            </div>
            )
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#1A2A3D] flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button onClick={() => setEditing(false)} className="border border-[#1A2A3D] text-[#B0BEC5] rounded-lg px-4 py-2 text-sm">Cancel</button>
              <button onClick={handleSave} disabled={saving}
                className="bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-1.5">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {pr.status !== 'sent' && (
                <button onClick={handleSend} disabled={sending}
                  className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-1.5">
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {sending ? 'Sending...' : `Send to ${pr.contact_email}`}
                </button>
              )}
              <div className="flex-1" />
              <button onClick={onClose} className="border border-[#1A2A3D] text-[#6B7E8F] rounded-lg px-4 py-2 text-sm">Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Contacts Panel ───────────────────────────────────────────────────────────

function ContactsPanel({ contacts, onRefresh }: { contacts: PressContact[]; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);

  const grouped = contacts.reduce((acc: Record<string, PressContact[]>, c) => {
    (acc[c.publication] = acc[c.publication] || []).push(c);
    return acc;
  }, {});

  return (
    <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl p-4 mb-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[#B0BEC5] text-sm font-medium w-full"
      >
        <Users size={14} className="text-[#74DFF6]" />
        Press Contacts ({contacts.length})
        {expanded ? <ChevronDown size={14} className="ml-auto" /> : <ChevronRight size={14} className="ml-auto" />}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">
          {Object.entries(grouped).map(([pub, pubContacts]) => (
            <div key={pub}>
              <p className="text-[#74DFF6] text-xs font-medium mb-1">{pub}</p>
              {pubContacts.map(c => (
                <div key={c.id} className="flex items-center gap-3 text-xs text-[#B0BEC5] py-1 pl-3">
                  <span className="text-[#6B7E8F] w-28 truncate">{c.contact_name}</span>
                  <span className="text-[#6B7E8F] w-24 truncate">{c.contact_role}</span>
                  <a href={`mailto:${c.email}`} className="text-[#74DFF6] hover:underline truncate">{c.email}</a>
                  {c.is_primary && <span className="text-[#1993C5] text-[10px] bg-[#1993C5]/20 px-1.5 py-0.5 rounded">Primary</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PressReleases() {
  const [tab, setTab] = useState<'releases' | 'announcements'>('announcements');
  const [releases, setReleases] = useState<PressRelease[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [contacts, setContacts] = useState<PressContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<string | null>(null);
  const [sendingAll, setSendingAll] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [relRes, annRes, conRes] = await Promise.all([
        api.get('/press-releases', { params: selectedAnnouncement ? { announcement: selectedAnnouncement } : {} }),
        api.get('/press-releases/announcements'),
        api.get('/press-releases/contacts'),
      ]);
      setReleases(relRes.data);
      setAnnouncements(annRes.data);
      setContacts(conRes.data);
    } catch (err) {
      console.error('Failed to load press releases:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedAnnouncement]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSendAll = async (title: string) => {
    const typed = window.prompt(
      `⚠️ This will EMAIL EVERY DRAFT in "${title}" to the live press contacts, from marcus@tp.finance.\n\n` +
      `This cannot be undone. To proceed, type SEND below:`
    );
    if (typed === null) return;            // cancelled
    if (typed.trim().toUpperCase() !== 'SEND') {
      alert('Not sent. You must type SEND exactly to confirm.');
      return;
    }
    setSendingAll(title);
    try {
      await api.post('/press-releases/send-all', { announcement_title: title });
      await loadData();
    } catch (err) {
      console.error('Failed to send all:', err);
    } finally {
      setSendingAll(null);
    }
  };

  const stats = {
    total: releases.length,
    draft: releases.filter(r => r.status === 'draft').length,
    sent: releases.filter(r => r.status === 'sent').length,
    publications: new Set(releases.map(r => r.publication)).size,
  };

  return (
    <div className="min-h-screen bg-[#0A131E] p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-white text-xl font-bold">Press Releases</h1>
          <p className="text-[#6B7E8F] text-sm mt-0.5">Generate &amp; send press releases to UK property/finance publications</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={loadData} disabled={loading}
            className="flex items-center gap-1.5 text-[#74DFF6] hover:text-white text-sm">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={() => setShowGenerate(true)}
            className="bg-[#1993C5] hover:bg-[#1578A2] text-white rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-1.5">
            <Plus size={14} /> New Announcement
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl px-4 py-3 flex items-center gap-3 min-w-[140px]">
          <FileText size={18} className="text-[#74DFF6]" />
          <div>
            <div className="text-white text-lg font-bold">{stats.total}</div>
            <div className="text-[#6B7E8F] text-xs">Total Releases</div>
          </div>
        </div>
        <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl px-4 py-3 flex items-center gap-3 min-w-[140px]">
          <Clock size={18} className="text-amber-400" />
          <div>
            <div className="text-white text-lg font-bold">{stats.draft}</div>
            <div className="text-[#6B7E8F] text-xs">Drafts</div>
          </div>
        </div>
        <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl px-4 py-3 flex items-center gap-3 min-w-[140px]">
          <CheckCircle size={18} className="text-green-400" />
          <div>
            <div className="text-white text-lg font-bold">{stats.sent}</div>
            <div className="text-[#6B7E8F] text-xs">Sent</div>
          </div>
        </div>
        <div className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl px-4 py-3 flex items-center gap-3 min-w-[140px]">
          <Megaphone size={18} className="text-[#74DFF6]" />
          <div>
            <div className="text-white text-lg font-bold">{stats.publications}</div>
            <div className="text-[#6B7E8F] text-xs">Publications</div>
          </div>
        </div>
      </div>

      {/* Media Assets */}
      <MediaAssetsPanel />

      {/* Announcement email preview */}
      <EmailPreviewPanel />

      {/* Press Contacts */}
      <ContactsPanel contacts={contacts} onRefresh={loadData} />

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6">
        <button
          onClick={() => { setTab('announcements'); setSelectedAnnouncement(null); }}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'announcements' ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/40' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'
          }`}
        >Announcements</button>
        <button
          onClick={() => setTab('releases')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'releases' ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/40' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'
          }`}
        >All Releases</button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={28} className="animate-spin text-[#74DFF6]" />
        </div>
      ) : tab === 'announcements' ? (
        announcements.length === 0 ? (
          <div className="text-center py-20">
            <Megaphone size={40} className="text-[#1A2A3D] mx-auto mb-3" />
            <p className="text-[#6B7E8F] text-sm">No announcements yet</p>
            <p className="text-[#4A5568] text-xs mt-1">Click "New Announcement" to generate press releases</p>
          </div>
        ) : (
          <div className="space-y-3">
            {announcements.map(ann => (
              <div key={ann.announcement_title} className="bg-[#111D2E] border border-[#1A2A3D] rounded-xl p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="text-white font-semibold text-sm">{ann.announcement_title}</h3>
                    <div className="flex items-center gap-4 mt-2 text-xs text-[#6B7E8F]">
                      <span>{ann.release_count} releases</span>
                      <span className="text-green-400">{ann.sent_count} sent</span>
                      <span className="text-amber-400">{ann.draft_count} drafts</span>
                      <span>{formatDate(ann.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setSelectedAnnouncement(ann.announcement_title); setTab('releases'); }}
                      className="text-[#74DFF6] text-xs hover:underline"
                    >View Releases</button>
                    {ann.draft_count > 0 && (
                      <button
                        onClick={() => handleSendAll(ann.announcement_title)}
                        disabled={sendingAll === ann.announcement_title}
                        className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-xs font-medium flex items-center gap-1"
                      >
                        {sendingAll === ann.announcement_title ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                        Send All
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        releases.length === 0 ? (
          <div className="text-center py-20">
            <FileText size={40} className="text-[#1A2A3D] mx-auto mb-3" />
            <p className="text-[#6B7E8F] text-sm">No press releases found</p>
          </div>
        ) : (
          <>
            {selectedAnnouncement && (
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[#6B7E8F] text-xs">Filtered:</span>
                <span className="text-[#74DFF6] text-xs bg-[#1993C5]/20 px-2 py-0.5 rounded">{selectedAnnouncement}</span>
                <button onClick={() => setSelectedAnnouncement(null)} className="text-[#6B7E8F] text-xs hover:text-red-400">Clear</button>
              </div>
            )}
            <div className="space-y-2">
              {releases.map(pr => (
                <button
                  key={pr.id}
                  onClick={() => setSelectedId(pr.id)}
                  className="w-full bg-[#111D2E] border border-[#1A2A3D] rounded-xl p-4 text-left hover:border-[#1993C5]/40 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <StatusBadge status={pr.status} />
                    <span className="text-[#74DFF6] text-xs bg-[#1993C5]/20 px-2 py-0.5 rounded">{pr.publication}</span>
                    {pr.contact_email && <span className="text-[#6B7E8F] text-xs ml-auto">{pr.contact_email}</span>}
                  </div>
                  <h3 className="text-white text-sm font-semibold leading-snug mb-1 line-clamp-1">{pr.headline}</h3>
                  <p className="text-[#6B7E8F] text-xs line-clamp-2">{pr.body?.substring(0, 150)}...</p>
                </button>
              ))}
            </div>
          </>
        )
      )}

      {/* Modals */}
      {selectedId && <DetailModal releaseId={selectedId} onClose={() => setSelectedId(null)} onRefresh={loadData} />}
      {showGenerate && <GenerateModal contacts={contacts} onClose={() => setShowGenerate(false)} onGenerated={loadData} />}
    </div>
  );
}
