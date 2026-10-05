import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Upload, RefreshCw, Trash2, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, Linkedin, Mail, Phone, MapPin, X,
  CheckSquare, Square, ArrowUpDown, ArrowUp, ArrowDown,
  Filter, Tag, Building2, Globe, ShieldCheck, ShieldOff,
  UserPlus, Download, MoreHorizontal, Users, Briefcase, Landmark,
  HelpCircle, Sparkles, Check, ChevronRight as ChevronRightIcon,
} from 'lucide-react';
import { contactsApi, apolloApi, campaignsApi, Contact, Campaign, ContactBreakdown, ContactSuggestion } from '../lib/api';

// ── Helpers ────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-violet-600', 'bg-blue-600', 'bg-teal-600', 'bg-emerald-600',
  'bg-amber-600', 'bg-rose-600', 'bg-indigo-600', 'bg-cyan-600',
];

function avatarColor(name: string) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initials(c: Contact) {
  const f = (c.first_name || '').trim();
  const l = (c.last_name || '').trim();
  if (f && l) return `${f[0]}${l[0]}`.toUpperCase();
  if (f) return f[0].toUpperCase();
  return c.email[0].toUpperCase();
}

function displayName(c: Contact) {
  const n = `${c.first_name || ''} ${c.last_name || ''}`.trim();
  return n || c.email;
}

type CategoryTab = 'all' | 'introducer' | 'client' | 'lender' | 'unclassified';

const CATEGORY_META: Record<CategoryTab, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  all:           { label: 'All Contacts', icon: <Users size={14} />,      color: 'text-[#B0BEC5]',    bg: 'bg-[#1A2A3D]' },
  introducer:    { label: 'Introducers',  icon: <Briefcase size={14} />,  color: 'text-violet-400',   bg: 'bg-violet-500/15' },
  client:        { label: 'Clients',      icon: <Building2 size={14} />,  color: 'text-emerald-400',  bg: 'bg-emerald-500/15' },
  lender:        { label: 'Lenders',      icon: <Landmark size={14} />,   color: 'text-amber-400',    bg: 'bg-amber-500/15' },
  unclassified:  { label: 'Unclassified', icon: <HelpCircle size={14} />, color: 'text-[#6B7E8F]',   bg: 'bg-[#1A2A3D]' },
};

// ── Import CSV modal ────────────────────────────────────────────────────────

function ImportModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<{ added: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv' && file.type !== 'text/plain') {
      alert('Please drop a CSV file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      setCsv(e.target?.result as string || '');
      setFileName(file.name);
    };
    reader.readAsText(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  }, []);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);

  const handleImport = async () => {
    if (!csv.trim()) return;
    setLoading(true);
    try {
      const res = await contactsApi.importCsv(csv);
      setResult(res.data);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contact-breakdown'] });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-2xl shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-[#1A2A3D]">
          <div>
            <h2 className="text-[#E0E8EE] font-semibold">Import Contacts from CSV</h2>
            <p className="text-[#6B7E8F] text-xs mt-0.5">
              Headers: email, first_name, last_name, company, title, phone, city, country, tags (semicolons)
            </p>
          </div>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3">
          {result ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-emerald-400"><CheckSquare size={14} /> {result.added} added</div>
              <div className="flex items-center gap-2 text-[#1993C5]"><ArrowUpDown size={14} /> {result.updated} updated</div>
              <div className="text-[#6B7E8F]">{result.skipped} skipped</div>
              {result.errors.slice(0, 5).map((e, i) => <div key={i} className="text-red-400">{e}</div>)}
            </div>
          ) : (
            <>
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg py-8 cursor-pointer transition-colors
                  ${dragging ? 'border-[#1993C5] bg-[#1993C5]/10' : 'border-[#1A2A3D] hover:border-[#1993C5]/50 hover:bg-[#1993C5]/5'}`}
              >
                <Upload size={22} className={dragging ? 'text-[#1993C5]' : 'text-[#4A5A6D]'} />
                {fileName ? (
                  <p className="text-sm text-emerald-400 font-medium">{fileName}</p>
                ) : (
                  <>
                    <p className="text-sm text-[#B0BEC5]">Drop CSV file here</p>
                    <p className="text-xs text-[#4A5A6D]">or click to browse</p>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }}
              />
              <textarea
                value={csv}
                onChange={(e) => { setCsv(e.target.value); setFileName(''); }}
                placeholder="...or paste CSV content here"
                rows={5}
                className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                           focus:outline-none focus:border-[#1993C5] font-mono resize-none"
              />
            </>
          )}
        </div>
        <div className="flex gap-3 p-4 border-t border-[#1A2A3D]">
          <button onClick={onClose} className="flex-1 border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm hover:bg-[#1A2A3D]">
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={handleImport}
              disabled={loading || !csv.trim()}
              className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm"
            >
              {loading ? 'Importing...' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Enroll modal ────────────────────────────────────────────────────────────

function EnrollModal({ contactIds, onClose }: { contactIds: string[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const { data: campaigns } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => campaignsApi.list().then((r) => r.data as Campaign[]),
  });

  const active = (campaigns || []).filter((c) => c.status === 'active');

  const handleEnroll = async () => {
    if (!selected) return;
    setLoading(true);
    try {
      await campaignsApi.enroll(selected, contactIds);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setDone(true);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-[#1A2A3D]">
          <h2 className="text-[#E0E8EE] font-semibold">Add to Campaign</h2>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]"><X size={16} /></button>
        </div>
        <div className="p-5">
          {done ? (
            <p className="text-emerald-400 text-sm">{contactIds.length} contact{contactIds.length !== 1 ? 's' : ''} enrolled.</p>
          ) : active.length === 0 ? (
            <p className="text-[#6B7E8F] text-sm">No active campaigns. Create and activate one first.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-[#6B7E8F] text-xs mb-3">Enrolling {contactIds.length} contact{contactIds.length !== 1 ? 's' : ''}</p>
              {active.map((c) => (
                <label key={c.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selected === c.id ? 'border-[#1993C5] bg-[#1993C5]/10' : 'border-[#1A2A3D] hover:border-[#1993C5]/50'
                }`}>
                  <input type="radio" className="hidden" value={c.id} checked={selected === c.id} onChange={() => setSelected(c.id)} />
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    selected === c.id ? 'border-[#1993C5]' : 'border-[#4A5A6D]'
                  }`}>
                    {selected === c.id && <div className="w-2 h-2 rounded-full bg-[#1993C5]" />}
                  </div>
                  <span className="text-[#B0BEC5] text-sm">{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-3 p-4 border-t border-[#1A2A3D]">
          <button onClick={onClose} className="flex-1 border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm hover:bg-[#1A2A3D]">
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && active.length > 0 && (
            <button
              onClick={handleEnroll}
              disabled={loading || !selected}
              className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm"
            >
              {loading ? 'Enrolling...' : 'Enroll'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Assign modal ────────────────────────────────────────────────────────────

function AssignModal({ contactIds, suggestion, onClose }: {
  contactIds: string[];
  suggestion?: { category: string; subsector: string } | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<'introducer' | 'developer' | 'lender'>(
    suggestion?.category === 'client' ? 'developer' : suggestion?.category === 'introducer' ? 'introducer' : 'developer'
  );
  const [subsector, setSubsector] = useState(suggestion?.subsector || '');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const INTRODUCER_SUBS = [
    { key: 'accountant', label: 'Accountant' }, { key: 'advisory', label: 'Advisory' },
    { key: 'agent', label: 'Agent' }, { key: 'construction', label: 'Construction' },
    { key: 'lawyer', label: 'Lawyer' }, { key: 'planning_architect', label: 'Planning / Architect' },
    { key: 'surveyor', label: 'Surveyor' }, { key: 'wealth', label: 'Wealth' },
  ];
  const CLIENT_SUBS = [
    { key: 'btr', label: 'BTR' }, { key: 'care', label: 'Care' },
    { key: 'hospitality', label: 'Hospitality' }, { key: 'leisure', label: 'Leisure' },
    { key: 'living', label: 'Living' }, { key: 'logistics', label: 'Logistics' },
    { key: 'office', label: 'Office' }, { key: 'pbsa', label: 'PBSA' },
    { key: 'retail', label: 'Retail' }, { key: 'sfh', label: 'SFH' },
  ];

  const subs = category === 'introducer' ? INTRODUCER_SUBS : category === 'developer' ? CLIENT_SUBS : [];

  const handleAssign = async () => {
    setLoading(true);
    try {
      await contactsApi.bulkAssign(contactIds, category, subsector || undefined);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contact-breakdown'] });
      setDone(true);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-[#1A2A3D]">
          <h2 className="text-[#E0E8EE] font-semibold">Assign Category</h2>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {done ? (
            <p className="text-emerald-400 text-sm">{contactIds.length} contact{contactIds.length !== 1 ? 's' : ''} assigned.</p>
          ) : (
            <>
              <p className="text-[#6B7E8F] text-xs">Assigning {contactIds.length} contact{contactIds.length !== 1 ? 's' : ''}</p>

              {/* Category selector */}
              <div>
                <label className="text-[#6B7E8F] text-xs font-medium uppercase tracking-wide block mb-2">Category</label>
                <div className="flex gap-2">
                  {([
                    { key: 'introducer' as const, label: 'Introducer', color: 'violet' },
                    { key: 'developer' as const, label: 'Client', color: 'emerald' },
                    { key: 'lender' as const, label: 'Lender', color: 'amber' },
                  ]).map(c => (
                    <button
                      key={c.key}
                      onClick={() => { setCategory(c.key); setSubsector(''); }}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        category === c.key
                          ? `border-${c.color}-500/50 bg-${c.color}-500/15 text-${c.color}-400`
                          : 'border-[#1A2A3D] text-[#6B7E8F] hover:border-[#1A2A3D] hover:bg-[#1A2A3D]'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Subsector selector */}
              {subs.length > 0 && (
                <div>
                  <label className="text-[#6B7E8F] text-xs font-medium uppercase tracking-wide block mb-2">Subsector</label>
                  <div className="flex flex-wrap gap-1.5">
                    {subs.map(s => (
                      <button
                        key={s.key}
                        onClick={() => setSubsector(subsector === s.key ? '' : s.key)}
                        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                          subsector === s.key
                            ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/40'
                            : 'bg-[#0A131E] text-[#6B7E8F] border border-[#1A2A3D] hover:text-[#B0BEC5]'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex gap-3 p-4 border-t border-[#1A2A3D]">
          <button onClick={onClose} className="flex-1 border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm hover:bg-[#1A2A3D]">
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              onClick={handleAssign}
              disabled={loading}
              className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm"
            >
              {loading ? 'Assigning...' : 'Assign'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Filter section ──────────────────────────────────────────────────────────

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-[#1A2A3D]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[#6B7E8F] hover:text-[#B0BEC5]"
      >
        {title}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

// ── Sort header ─────────────────────────────────────────────────────────────

function SortHeader({ label, col, sort, dir, onSort }: {
  label: string; col: string;
  sort: string; dir: string;
  onSort: (col: string) => void;
}) {
  const active = sort === col;
  return (
    <button
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 text-xs uppercase tracking-wide font-semibold transition-colors ${
        active ? 'text-[#74DFF6]' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'
      }`}
    >
      {label}
      {active ? (dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ArrowUpDown size={11} className="opacity-40" />}
    </button>
  );
}

// ── Suggestion chip ─────────────────────────────────────────────────────────

function SuggestionChip({ suggestion, onAccept }: {
  suggestion: ContactSuggestion;
  onAccept: () => void;
}) {
  const catLabel = suggestion.category === 'introducer' ? 'Introducer' : 'Client';
  const subLabel = suggestion.subsector || '';
  const confColor = suggestion.confidence === 'high' ? 'text-emerald-400' : suggestion.confidence === 'medium' ? 'text-amber-400' : 'text-[#6B7E8F]';

  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-xs ${confColor}`}>
        {catLabel}{subLabel ? ` / ${subLabel}` : ''}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onAccept(); }}
        title="Accept suggestion"
        className="p-0.5 rounded hover:bg-emerald-500/20 text-emerald-400/60 hover:text-emerald-400 transition-colors"
      >
        <Check size={12} />
      </button>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function Contacts() {
  const queryClient = useQueryClient();

  // Category / subsector
  const [activeTab, setActiveTab] = useState<CategoryTab>('all');
  const [activeSubsector, setActiveSubsector] = useState<string>('');

  // Filters
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');

  // Sort
  const [sort, setSort] = useState('created_at');
  const [dir, setDir] = useState('desc');

  // Pagination
  const [page, setPage] = useState(1);
  const limit = 50;

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Modals
  const [showImport, setShowImport] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lookingUpNames, setLookingUpNames] = useState(false);
  const [lookupResult, setLookupResult] = useState<{ processed: number; updated: number } | null>(null);

  // Suggestions for unclassified contacts
  const [suggestions, setSuggestions] = useState<Record<string, ContactSuggestion | null>>({});

  // Reset pagination when filters change
  useEffect(() => { setPage(1); }, [activeTab, activeSubsector, search, tagFilter, sourceFilter, companyFilter]);

  // Breakdown query
  const { data: breakdown } = useQuery({
    queryKey: ['contact-breakdown'],
    queryFn: () => contactsApi.breakdown().then(r => r.data),
    staleTime: 30000,
  });

  // Build list params
  const listParams = useMemo(() => {
    const params: Record<string, string | number | undefined> = {
      page, limit, sort, dir,
      search: search || undefined,
      tag: tagFilter || undefined,
      source: sourceFilter || undefined,
      company: companyFilter || undefined,
    };
    if (activeTab !== 'all') params.category = activeTab;
    if (activeSubsector) params.subsector = activeSubsector;
    return params;
  }, [activeTab, activeSubsector, search, tagFilter, sourceFilter, companyFilter, page, sort, dir]);

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', listParams],
    queryFn: () => contactsApi.list(listParams as any).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  const { data: tags } = useQuery({
    queryKey: ['contact-tags'],
    queryFn: () => contactsApi.getTags().then((r) => r.data),
  });

  // Fetch suggestions when viewing unclassified contacts
  const contacts: Contact[] = data?.data || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  useEffect(() => {
    if (activeTab !== 'unclassified' || contacts.length === 0) return;
    const ids = contacts.map(c => c.id);
    contactsApi.suggest(ids).then(r => setSuggestions(r.data)).catch(() => {});
  }, [activeTab, contacts.map(c => c.id).join(',')]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => contactsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contact-breakdown'] });
    },
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      await apolloApi.sync('incremental');
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['contacts'] });
        queryClient.invalidateQueries({ queryKey: ['contact-breakdown'] });
        setSyncing(false);
      }, 3000);
    } catch {
      setSyncing(false);
    }
  };

  const handleSort = (col: string) => {
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(col); setDir('asc'); }
    setPage(1);
  };

  const allSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id));

  const toggleAll = () => {
    if (allSelected) {
      setSelected((s) => { const n = new Set(s); contacts.forEach((c) => n.delete(c.id)); return n; });
    } else {
      setSelected((s) => { const n = new Set(s); contacts.forEach((c) => n.add(c.id)); return n; });
    }
  };

  const toggleOne = (id: string) => {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const activeFilters = [
    tagFilter && { key: 'tag', label: `Tag: ${tagFilter}`, clear: () => setTagFilter('') },
    sourceFilter && { key: 'source', label: `Source: ${sourceFilter}`, clear: () => setSourceFilter('') },
    companyFilter && { key: 'company', label: `Company: ${companyFilter}`, clear: () => setCompanyFilter('') },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  const selectedIds = [...selected];
  const selectedCount = selectedIds.length;

  const deleteSelected = () => {
    if (!confirm(`Delete ${selectedCount} contact${selectedCount !== 1 ? 's' : ''}?`)) return;
    selectedIds.forEach((id) => deleteMutation.mutate(id));
    setSelected(new Set());
  };

  const handleBulkNameLookup = async () => {
    setLookingUpNames(true);
    setLookupResult(null);
    try {
      const res = await contactsApi.bulkLookupNames();
      setLookupResult(res.data);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setTimeout(() => setLookupResult(null), 8000);
    } catch (err) {
      console.error(err);
    } finally {
      setLookingUpNames(false);
    }
  };

  const handleAcceptSuggestion = async (contactId: string, suggestion: ContactSuggestion) => {
    const contactType = suggestion.category === 'introducer' ? 'introducer' : 'developer';
    try {
      await contactsApi.bulkAssign([contactId], contactType, suggestion.subsector || undefined);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contact-breakdown'] });
      setSuggestions(prev => { const next = { ...prev }; delete next[contactId]; return next; });
    } catch (err) {
      console.error(err);
    }
  };

  // Subsector chips for current category
  const currentSubsectors = useMemo(() => {
    if (!breakdown) return [];
    if (activeTab === 'introducer') return breakdown.introducers.subsectors;
    if (activeTab === 'client') return breakdown.clients.subsectors;
    return [];
  }, [breakdown, activeTab]);

  const unsectoredCount = useMemo(() => {
    if (!breakdown) return 0;
    if (activeTab === 'introducer') return breakdown.introducers.unsectored;
    if (activeTab === 'client') return breakdown.clients.unsectored;
    return 0;
  }, [breakdown, activeTab]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Left filter panel ── */}
      <aside className="w-56 flex-shrink-0 bg-[#080F18] border-r border-[#1A2A3D] overflow-y-auto">
        <div className="px-4 py-4 border-b border-[#1A2A3D]">
          <div className="flex items-center gap-2 text-[#B0BEC5] text-sm font-semibold">
            <Filter size={13} />
            Filters
          </div>
        </div>

        <FilterSection title="Source">
          <div className="space-y-1">
            {['', 'apollo', 'csv', 'manual'].map((s) => (
              <button
                key={s}
                onClick={() => { setSourceFilter(s); setPage(1); }}
                className={`w-full text-left text-xs px-2 py-1.5 rounded transition-colors ${
                  sourceFilter === s
                    ? 'bg-[#1993C5]/20 text-[#74DFF6]'
                    : 'text-[#6B7E8F] hover:text-[#B0BEC5] hover:bg-[#1A2A3D]'
                }`}
              >
                {s === '' ? 'All sources' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </FilterSection>

        <FilterSection title="Tags">
          <div className="space-y-1">
            <button
              onClick={() => { setTagFilter(''); setPage(1); }}
              className={`w-full text-left text-xs px-2 py-1.5 rounded transition-colors ${
                !tagFilter ? 'bg-[#1993C5]/20 text-[#74DFF6]' : 'text-[#6B7E8F] hover:text-[#B0BEC5] hover:bg-[#1A2A3D]'
              }`}
            >
              All tags
            </button>
            {(tags || []).map((tag: string) => (
              <button
                key={tag}
                onClick={() => { setTagFilter(tag); setPage(1); }}
                className={`w-full text-left text-xs px-2 py-1.5 rounded truncate transition-colors ${
                  tagFilter === tag
                    ? 'bg-[#1993C5]/20 text-[#74DFF6]'
                    : 'text-[#6B7E8F] hover:text-[#B0BEC5] hover:bg-[#1A2A3D]'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </FilterSection>

        <FilterSection title="Company">
          <input
            type="text"
            value={companyFilter}
            onChange={(e) => { setCompanyFilter(e.target.value); setPage(1); }}
            placeholder="Filter by company..."
            className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded px-2 py-1.5 text-xs
                       focus:outline-none focus:border-[#1993C5] placeholder-[#4A5A6D]"
          />
        </FilterSection>
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex-shrink-0 px-6 pt-5 pb-3 border-b border-[#1A2A3D] bg-[#0A131E]">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-[#E0E8EE] text-xl font-bold">People</h1>
              <p className="text-[#6B7E8F] text-xs mt-0.5">{(breakdown?.total || total).toLocaleString()} contacts</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSync}
                disabled={syncing}
                className="flex items-center gap-1.5 border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5] hover:text-[#74DFF6] rounded-lg px-3 py-1.5 text-xs transition-colors"
              >
                <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                Sync Apollo
              </button>
              <button
                onClick={() => setShowImport(true)}
                className="flex items-center gap-1.5 border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5] hover:text-[#74DFF6] rounded-lg px-3 py-1.5 text-xs transition-colors"
              >
                <Upload size={12} />
                Import CSV
              </button>
              <button
                onClick={handleBulkNameLookup}
                disabled={lookingUpNames}
                className="flex items-center gap-1.5 border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#5DCAA5] hover:text-[#5DCAA5] rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
              >
                <Mail size={12} className={lookingUpNames ? 'animate-pulse' : ''} />
                {lookingUpNames ? 'Scanning Gmail...' : 'Lookup Names'}
              </button>
            </div>
          </div>

          {/* Lookup result banner */}
          {lookupResult && (
            <div className="mb-3 flex items-center gap-2 bg-[#5DCAA5]/10 border border-[#5DCAA5]/30 rounded-lg px-3 py-2 text-xs">
              <Mail size={12} className="text-[#5DCAA5]" />
              <span className="text-[#5DCAA5]">
                Scanned {lookupResult.processed} contacts — updated {lookupResult.updated} names from Gmail
              </span>
              <button onClick={() => setLookupResult(null)} className="ml-auto text-[#5DCAA5]/60 hover:text-[#5DCAA5]"><X size={12} /></button>
            </div>
          )}

          {/* ── Category tabs ── */}
          <div className="flex gap-1.5 mb-3">
            {(Object.keys(CATEGORY_META) as CategoryTab[]).map(tab => {
              const meta = CATEGORY_META[tab];
              const count = !breakdown ? '...' :
                tab === 'all' ? breakdown.total.toLocaleString() :
                tab === 'introducer' ? breakdown.introducers.total.toLocaleString() :
                tab === 'client' ? breakdown.clients.total.toLocaleString() :
                tab === 'lender' ? breakdown.lenders.total.toLocaleString() :
                breakdown.unclassified.total.toLocaleString();
              const isActive = activeTab === tab;

              return (
                <button
                  key={tab}
                  onClick={() => { setActiveTab(tab); setActiveSubsector(''); setSelected(new Set()); }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                    isActive
                      ? `${meta.bg} ${meta.color} border border-current/20`
                      : 'text-[#6B7E8F] hover:text-[#B0BEC5] hover:bg-[#1A2A3D] border border-transparent'
                  }`}
                >
                  {meta.icon}
                  <span>{meta.label}</span>
                  <span className={`ml-1 tabular-nums ${isActive ? 'opacity-80' : 'opacity-50'}`}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* ── Subsector chips ── */}
          {currentSubsectors.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              <button
                onClick={() => setActiveSubsector('')}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  !activeSubsector
                    ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/30'
                    : 'bg-[#0A131E] text-[#6B7E8F] border border-[#1A2A3D] hover:text-[#B0BEC5]'
                }`}
              >
                All
              </button>
              {currentSubsectors.map(sub => (
                <button
                  key={sub.key}
                  onClick={() => setActiveSubsector(activeSubsector === sub.key ? '' : sub.key)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    activeSubsector === sub.key
                      ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/30'
                      : 'bg-[#0A131E] text-[#6B7E8F] border border-[#1A2A3D] hover:text-[#B0BEC5]'
                  }`}
                >
                  {sub.label} <span className="opacity-50 ml-0.5">{sub.count}</span>
                </button>
              ))}
              {unsectoredCount > 0 && (
                <span className="px-2.5 py-1 text-xs text-[#4A5A6D]">
                  + {unsectoredCount.toLocaleString()} unsectored
                </span>
              )}
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A5A6D]" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by name, email, company, title..."
              className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded-lg pl-8 pr-3 py-2 text-sm
                         focus:outline-none focus:border-[#1993C5] placeholder-[#4A5A6D]"
            />
          </div>

          {/* Active filter pills */}
          {activeFilters.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {activeFilters.map((f) => (
                <span key={f.key} className="flex items-center gap-1 bg-[#1993C5]/15 text-[#74DFF6] text-xs px-2 py-1 rounded-full">
                  {f.label}
                  <button onClick={f.clear} className="hover:text-white"><X size={10} /></button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Bulk action bar */}
        {selectedCount > 0 && (
          <div className="flex-shrink-0 flex items-center gap-3 px-6 py-2.5 bg-[#1993C5]/10 border-b border-[#1993C5]/30">
            <span className="text-[#74DFF6] text-sm font-medium">{selectedCount} selected</span>
            <div className="h-4 w-px bg-[#1993C5]/30" />
            <button
              onClick={() => setShowAssign(true)}
              className="flex items-center gap-1.5 text-xs text-[#B0BEC5] hover:text-violet-400 transition-colors"
            >
              <Sparkles size={13} />
              Assign Category
            </button>
            <button
              onClick={() => setShowEnroll(true)}
              className="flex items-center gap-1.5 text-xs text-[#B0BEC5] hover:text-[#74DFF6] transition-colors"
            >
              <UserPlus size={13} />
              Add to Campaign
            </button>
            <button
              onClick={deleteSelected}
              className="flex items-center gap-1.5 text-xs text-[#B0BEC5] hover:text-red-400 transition-colors ml-auto"
            >
              <Trash2 size={13} />
              Delete
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-[#6B7E8F] hover:text-[#B0BEC5]"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-[#080F18]">
              <tr className="border-b border-[#1A2A3D]">
                <th className="py-3 pl-5 pr-2 w-8">
                  <button onClick={toggleAll} className="text-[#4A5A6D] hover:text-[#1993C5] transition-colors">
                    {allSelected ? <CheckSquare size={15} className="text-[#1993C5]" /> : <Square size={15} />}
                  </button>
                </th>
                <th className="py-3 px-3 text-left">
                  <SortHeader label="Name" col="first_name" sort={sort} dir={dir} onSort={handleSort} />
                </th>
                <th className="py-3 px-3 text-left">
                  <SortHeader label="Title" col="title" sort={sort} dir={dir} onSort={handleSort} />
                </th>
                <th className="py-3 px-3 text-left">
                  <SortHeader label="Company" col="company" sort={sort} dir={dir} onSort={handleSort} />
                </th>
                <th className="py-3 px-3 text-left hidden xl:table-cell">
                  <SortHeader label="Location" col="city" sort={sort} dir={dir} onSort={handleSort} />
                </th>
                <th className="py-3 px-3 text-left">
                  <SortHeader label="Email" col="email" sort={sort} dir={dir} onSort={handleSort} />
                </th>
                {/* Category column — shown for All / Unclassified tabs */}
                {(activeTab === 'all' || activeTab === 'unclassified') && (
                  <th className="py-3 px-3 text-left">
                    <span className="text-xs uppercase tracking-wide font-semibold text-[#6B7E8F]">
                      {activeTab === 'unclassified' ? 'Suggestion' : 'Category'}
                    </span>
                  </th>
                )}
                <th className="py-3 px-3 text-left">
                  <span className="text-xs uppercase tracking-wide font-semibold text-[#6B7E8F]">Tags</span>
                </th>
                <th className="py-3 px-3 w-8" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={12} className="py-16 text-center text-[#6B7E8F] text-sm">Loading...</td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-16 text-center">
                    <div className="text-[#6B7E8F] text-sm">No contacts found</div>
                    {search || activeFilters.length > 0 ? (
                      <button
                        onClick={() => { setSearch(''); setTagFilter(''); setSourceFilter(''); setCompanyFilter(''); }}
                        className="mt-2 text-xs text-[#1993C5] hover:text-[#74DFF6]"
                      >
                        Clear filters
                      </button>
                    ) : (
                      <p className="mt-1 text-xs text-[#4A5A6D]">Sync from Apollo or import a CSV to get started</p>
                    )}
                  </td>
                </tr>
              ) : (
                contacts.map((c) => {
                  const isSelected = selected.has(c.id);
                  const name = displayName(c);
                  const color = avatarColor(name);
                  const suggestion = suggestions[c.id];

                  // Category badge for All view
                  const catBadge = c.contact_type === 'introducer'
                    ? { label: 'Introducer', cls: 'text-violet-400 bg-violet-500/10' }
                    : c.contact_type === 'developer'
                    ? { label: 'Client', cls: 'text-emerald-400 bg-emerald-500/10' }
                    : c.contact_type === 'lender'
                    ? { label: 'Lender', cls: 'text-amber-400 bg-amber-500/10' }
                    : null;

                  return (
                    <tr
                      key={c.id}
                      className={`border-b border-[#1A2A3D]/40 transition-colors ${
                        isSelected ? 'bg-[#1993C5]/5' : 'hover:bg-[#1A2A3D]/30'
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="pl-5 pr-2 py-3">
                        <button onClick={() => toggleOne(c.id)} className="text-[#4A5A6D] hover:text-[#1993C5] transition-colors">
                          {isSelected ? <CheckSquare size={15} className="text-[#1993C5]" /> : <Square size={15} />}
                        </button>
                      </td>

                      {/* Name */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5 min-w-[160px]">
                          <div className={`w-7 h-7 rounded-full ${color} flex items-center justify-center text-white text-xs font-semibold flex-shrink-0`}>
                            {initials(c)}
                          </div>
                          <div>
                            <div className="text-[#E0E8EE] text-sm font-medium leading-tight">{name}</div>
                            {c.linkedin_url && (
                              <a
                                href={c.linkedin_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#0A66C2] hover:text-[#1E86D4] inline-flex items-center gap-0.5 text-xs mt-0.5"
                              >
                                <Linkedin size={10} />
                              </a>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Title */}
                      <td className="px-3 py-3 max-w-[140px]">
                        <span className="text-[#8A9BAD] text-xs truncate block">{c.title || '\u2014'}</span>
                      </td>

                      {/* Company */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5 min-w-[120px]">
                          {c.company_domain ? (
                            <img
                              src={`https://www.google.com/s2/favicons?domain=${c.company_domain}&sz=16`}
                              alt=""
                              className="w-4 h-4 rounded flex-shrink-0"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          ) : (
                            <Building2 size={12} className="text-[#4A5A6D] flex-shrink-0" />
                          )}
                          <span className="text-[#B0BEC5] text-sm truncate">{c.company || '\u2014'}</span>
                        </div>
                      </td>

                      {/* Location */}
                      <td className="px-3 py-3 hidden xl:table-cell">
                        <div className="flex items-center gap-1 text-[#6B7E8F] text-xs">
                          {(c.city || c.country) && <MapPin size={11} className="flex-shrink-0" />}
                          <span className="truncate max-w-[110px]">
                            {[c.city, c.country].filter(Boolean).join(', ') || '\u2014'}
                          </span>
                        </div>
                      </td>

                      {/* Email */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5">
                          {c.email_verified ? (
                            <span title="Verified"><ShieldCheck size={12} className="text-emerald-400 flex-shrink-0" /></span>
                          ) : (
                            <span title="Unverified"><ShieldOff size={12} className="text-[#4A5A6D] flex-shrink-0" /></span>
                          )}
                          <span className="text-[#6B7E8F] text-xs truncate max-w-[160px]">{c.email}</span>
                        </div>
                      </td>

                      {/* Category / Suggestion column */}
                      {(activeTab === 'all' || activeTab === 'unclassified') && (
                        <td className="px-3 py-3">
                          {activeTab === 'unclassified' && suggestion ? (
                            <SuggestionChip
                              suggestion={suggestion}
                              onAccept={() => handleAcceptSuggestion(c.id, suggestion)}
                            />
                          ) : activeTab === 'all' && catBadge ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${catBadge.cls}`}>
                              {catBadge.label}
                              {c.subsector && (
                                <span className="opacity-60 ml-1">/ {c.subsector.replace('_', ' ')}</span>
                              )}
                            </span>
                          ) : activeTab === 'all' ? (
                            <span className="text-xs text-[#4A5A6D]">\u2014</span>
                          ) : (
                            <span className="text-xs text-[#4A5A6D] italic">No match</span>
                          )}
                        </td>
                      )}

                      {/* Tags */}
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1 max-w-[140px]">
                          {(c.tags || []).slice(0, 2).map((tag) => (
                            <button
                              key={tag}
                              onClick={() => { setTagFilter(tag); setPage(1); }}
                              className="text-xs bg-[#1A2A3D] hover:bg-[#1993C5]/20 text-[#74DFF6] px-1.5 py-0.5 rounded transition-colors"
                            >
                              {tag}
                            </button>
                          ))}
                          {(c.tags || []).length > 2 && (
                            <span className="text-xs text-[#4A5A6D]">+{c.tags.length - 2}</span>
                          )}
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3">
                        <button
                          onClick={() => {
                            if (confirm(`Delete ${c.email}?`)) deleteMutation.mutate(c.id);
                          }}
                          title="Delete contact"
                          className="text-[#4A5A6D] hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-t border-[#1A2A3D] bg-[#080F18]">
            <span className="text-[#6B7E8F] text-xs">
              {((page - 1) * limit + 1).toLocaleString()}–{Math.min(page * limit, total).toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded text-[#6B7E8F] hover:text-[#B0BEC5] disabled:opacity-30 hover:bg-[#1A2A3D] transition-colors"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="text-[#6B7E8F] text-xs px-2">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded text-[#6B7E8F] hover:text-[#B0BEC5] disabled:opacity-30 hover:bg-[#1A2A3D] transition-colors"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
      {showEnroll && <EnrollModal contactIds={selectedIds} onClose={() => { setShowEnroll(false); setSelected(new Set()); }} />}
      {showAssign && <AssignModal contactIds={selectedIds} onClose={() => { setShowAssign(false); setSelected(new Set()); }} />}
    </div>
  );
}
