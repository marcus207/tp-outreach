import React, { useState, useMemo, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Upload, RefreshCw, Trash2, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, Linkedin, Mail, Phone, MapPin, X,
  CheckSquare, Square, ArrowUpDown, ArrowUp, ArrowDown,
  Filter, Tag, Building2, Globe, ShieldCheck, ShieldOff,
  UserPlus, Download, MoreHorizontal,
} from 'lucide-react';
import { contactsApi, apolloApi, campaignsApi, Contact, Campaign } from '../lib/api';

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
              {/* Drop zone */}
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
              {/* Paste fallback */}
              <textarea
                value={csv}
                onChange={(e) => { setCsv(e.target.value); setFileName(''); }}
                placeholder="…or paste CSV content here"
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
              {loading ? 'Importing…' : 'Import'}
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
              {loading ? 'Enrolling…' : 'Enroll'}
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

// ── Main page ───────────────────────────────────────────────────────────────

export default function Contacts() {
  const queryClient = useQueryClient();

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
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', search, tagFilter, sourceFilter, companyFilter, page, sort, dir],
    queryFn: () =>
      contactsApi.list({
        search: search || undefined,
        tag: tagFilter || undefined,
        source: sourceFilter || undefined,
        company: companyFilter || undefined,
        page,
        limit,
        sort,
        dir,
      }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  const { data: tags } = useQuery({
    queryKey: ['contact-tags'],
    queryFn: () => contactsApi.getTags().then((r) => r.data),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => contactsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setSelected((s) => { const n = new Set(s); return n; });
    },
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      await apolloApi.sync('incremental');
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['contacts'] });
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

  const contacts: Contact[] = data?.data || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  const allSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someSelected = contacts.some((c) => selected.has(c.id));

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

  // Active filter pills
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
            placeholder="Filter by company…"
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
              <p className="text-[#6B7E8F] text-xs mt-0.5">{total.toLocaleString()} contacts</p>
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
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A5A6D]" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by name, email, company, title…"
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
                <th className="py-3 px-3 text-left hidden lg:table-cell">
                  <span className="text-xs uppercase tracking-wide font-semibold text-[#6B7E8F]">Phone</span>
                </th>
                <th className="py-3 px-3 text-left">
                  <span className="text-xs uppercase tracking-wide font-semibold text-[#6B7E8F]">Tags</span>
                </th>
                <th className="py-3 px-3 text-right">
                  <span className="text-xs uppercase tracking-wide font-semibold text-[#6B7E8F]">Seqs</span>
                </th>
                <th className="py-3 px-3 w-8" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={10} className="py-16 text-center text-[#6B7E8F] text-sm">Loading…</td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-16 text-center">
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
                        <span className="text-[#8A9BAD] text-xs truncate block">{c.title || '—'}</span>
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
                          <span className="text-[#B0BEC5] text-sm truncate">{c.company || '—'}</span>
                        </div>
                      </td>

                      {/* Location */}
                      <td className="px-3 py-3 hidden xl:table-cell">
                        <div className="flex items-center gap-1 text-[#6B7E8F] text-xs">
                          {(c.city || c.country) && <MapPin size={11} className="flex-shrink-0" />}
                          <span className="truncate max-w-[110px]">
                            {[c.city, c.country].filter(Boolean).join(', ') || '—'}
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

                      {/* Phone */}
                      <td className="px-3 py-3 hidden lg:table-cell">
                        <span className="text-[#6B7E8F] text-xs">{c.phone || '—'}</span>
                      </td>

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

                      {/* Sequences */}
                      <td className="px-3 py-3 text-right">
                        <span className={`text-xs font-medium ${(c.active_sequences || 0) > 0 ? 'text-[#74DFF6]' : 'text-[#4A5A6D]'}`}>
                          {c.active_sequences || 0}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3">
                        <button
                          onClick={() => {
                            if (confirm(`Delete ${c.email}?`)) deleteMutation.mutate(c.id);
                          }}
                          className="text-[#4A5A6D] hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
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
    </div>
  );
}
