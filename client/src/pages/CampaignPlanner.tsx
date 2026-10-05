import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  ChevronDown,
  Users,
  Mail,
  Eye,
  Edit2,
  X,
  Save,
  Loader2,
  Image,
  Check,
  Settings2,
  Play,
  Pause,
  Activity,
  Zap,
  Clock,
  CheckCircle2,
  AlertCircle,
  Send,
} from 'lucide-react';
import {
  campaignPlannerApi,
  CampaignPlannerSettings,
  CampaignSector,
  CampaignScheduleEntry,
  EngineStatus,
  EngineLogEntry,
} from '../lib/api';

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-[#1A2A3D] text-[#6B7E8F]',
  approved: 'bg-[#0D9488]/15 text-[#0D9488]',
  sent: 'bg-green-900/20 text-green-400',
  skipped: 'bg-yellow-900/20 text-yellow-400',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_STYLES[status] || STATUS_STYLES.draft}`}>
      {status}
    </span>
  );
}

// ─── Frequency selector ───────────────────────────────────────────────────────

const FREQ_OPTIONS = [
  { label: 'Weekly', days: 7 },
  { label: 'Biweekly', days: 14 },
  { label: 'Monthly', days: 30 },
  { label: 'Every 6 weeks', days: 42 },
];

function SettingsPanel({
  settings,
  onUpdate,
  saving,
}: {
  settings: CampaignPlannerSettings;
  onUpdate: (data: Partial<CampaignPlannerSettings>) => void;
  saving: boolean;
}) {
  const [freq, setFreq] = useState(settings.frequency_days);
  const [startDate, setStartDate] = useState(settings.start_date);
  const [active, setActive] = useState(settings.is_active);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setFreq(settings.frequency_days);
    setStartDate(settings.start_date);
    setActive(settings.is_active);
    setDirty(false);
  }, [settings]);

  const handleSave = () => {
    onUpdate({ frequency_days: freq, start_date: startDate, is_active: active });
  };

  const matchingOption = FREQ_OPTIONS.find(o => o.days === freq);

  return (
    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Settings2 size={16} className="text-[#0D9488]" />
        <h2 className="text-[#E0E8EE] font-semibold">Campaign Settings</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
        <div>
          <label className="block text-[#6B7E8F] text-xs mb-1.5">Frequency</label>
          <select
            value={matchingOption ? freq : 'custom'}
            onChange={e => {
              const val = e.target.value;
              if (val !== 'custom') { setFreq(parseInt(val)); setDirty(true); }
            }}
            className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
          >
            {FREQ_OPTIONS.map(o => (
              <option key={o.days} value={o.days}>{o.label} ({o.days}d)</option>
            ))}
            {!matchingOption && <option value="custom">Custom ({freq}d)</option>}
          </select>
        </div>

        <div>
          <label className="block text-[#6B7E8F] text-xs mb-1.5">Custom Days</label>
          <input
            type="number"
            min={1}
            max={90}
            value={freq}
            onChange={e => { setFreq(parseInt(e.target.value) || 30); setDirty(true); }}
            className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
          />
        </div>

        <div>
          <label className="block text-[#6B7E8F] text-xs mb-1.5">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={e => { setStartDate(e.target.value); setDirty(true); }}
            className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => { setActive(!active); setDirty(true); }}
            className={`relative w-10 h-5 rounded-full transition-colors ${active ? 'bg-[#0D9488]' : 'bg-[#1A2A3D]'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${active ? 'translate-x-5' : ''}`} />
          </button>
          <span className="text-[#B0BEC5] text-sm">{active ? 'Active' : 'Paused'}</span>

          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="ml-auto flex items-center gap-1.5 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-40 text-white rounded px-3 py-2 text-sm transition-colors"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save
          </button>
        </div>
      </div>

      <p className="text-[#6B7E8F] text-xs mt-3">
        Changing frequency recalculates all send dates. Send #{`1`} goes out on {startDate}, then every {freq} days.
      </p>
    </div>
  );
}

// ─── Sector dropdown ──────────────────────────────────────────────────────────

function SectorDropdown({
  sectors,
  selected,
  onSelect,
}: {
  sectors: CampaignSector[];
  selected: string | null;
  onSelect: (s: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const current = sectors.find(s => s.sector === selected);
  const totalContacts = sectors.reduce((sum, s) => sum + s.contacts, 0);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-[#0D1B2A] border border-[#1A2A3D] hover:border-[#1993C5]/50 rounded-lg px-4 py-2.5 text-sm transition-colors min-w-[200px]"
      >
        <span className="text-[#E0E8EE] font-medium flex-1 text-left">
          {selected ? selected.toUpperCase() : 'All Sectors'}
        </span>
        <span className="text-[#6B7E8F] text-xs">
          {selected ? `${current?.contacts ?? 0} contacts` : `${totalContacts} contacts`}
        </span>
        <ChevronDown size={14} className={`text-[#6B7E8F] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
          <button
            onClick={() => { onSelect(null); setOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-[#1A2A3D] transition-colors ${
              !selected ? 'text-[#74DFF6] bg-[#1993C5]/10' : 'text-[#B0BEC5]'
            }`}
          >
            <Mail size={14} />
            <span className="flex-1 text-left font-medium">All Sectors</span>
            <span className="text-[#6B7E8F] text-xs">{totalContacts}</span>
          </button>

          <div className="h-px bg-[#1A2A3D]" />

          {sectors.map(s => (
            <button
              key={s.sector}
              onClick={() => { onSelect(s.sector); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-[#1A2A3D] transition-colors ${
                selected === s.sector ? 'text-[#74DFF6] bg-[#1993C5]/10' : 'text-[#B0BEC5]'
              }`}
            >
              <div className="w-2 h-2 rounded-full bg-[#0D9488]" />
              <span className="flex-1 text-left font-medium">{s.sector.toUpperCase()}</span>
              <span className="text-[#6B7E8F] text-xs">{s.contacts} contacts</span>
              <span className="text-[#6B7E8F] text-xs">{s.sends} sends</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Preview modal ────────────────────────────────────────────────────────────

function PreviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: preview, isLoading } = useQuery({
    queryKey: ['campaign-preview', id],
    queryFn: () => campaignPlannerApi.getPreview(id).then(r => r.data),
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-[#1A2A3D] flex items-center justify-between">
          <div>
            <h2 className="text-[#E0E8EE] font-semibold">Email Preview</h2>
            {preview && (
              <p className="text-[#6B7E8F] text-xs mt-0.5">{preview.sector.toUpperCase()} — {preview.subject_line}</p>
            )}
          </div>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-[#1993C5]" />
            </div>
          ) : preview?.preview_html ? (
            <div className="bg-[#f4f6f9] rounded-lg overflow-hidden">
              <iframe
                srcDoc={preview.preview_html}
                className="w-full border-0 rounded"
                style={{ height: '600px' }}
                title="Email Preview"
              />
            </div>
          ) : (
            <p className="text-[#6B7E8F] text-center py-16">No preview available</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Edit modal ───────────────────────────────────────────────────────────────

function EditModal({
  entry,
  heroImages,
  onClose,
  onSaved,
}: {
  entry: CampaignScheduleEntry;
  heroImages: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [heroImage, setHeroImage] = useState(entry.hero_image);
  const [subjectLine, setSubjectLine] = useState(entry.subject_line);
  const [bodyCopy, setBodyCopy] = useState(entry.body_copy);
  const [articleTitle, setArticleTitle] = useState(entry.article_title || '');
  const [articleSlug, setArticleSlug] = useState(entry.article_slug || '');
  const [articleExcerpt, setArticleExcerpt] = useState(entry.article_excerpt || '');
  const [status, setStatus] = useState(entry.status);
  const [saving, setSaving] = useState(false);

  // Filter hero images to current sector
  const sectorPrefix = entry.sector.toLowerCase() + '_';
  const sectorImages = heroImages.filter(img => img.startsWith(sectorPrefix));
  const otherImages = heroImages.filter(img => !img.startsWith(sectorPrefix));

  const handleSave = async () => {
    setSaving(true);
    try {
      await campaignPlannerApi.updateScheduleEntry(entry.id, {
        hero_image: heroImage,
        subject_line: subjectLine,
        body_copy: bodyCopy,
        article_title: articleTitle || null,
        article_slug: articleSlug || null,
        article_excerpt: articleExcerpt || null,
        status,
      } as any);
      onSaved();
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-3xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-[#1A2A3D] flex items-center justify-between">
          <div>
            <h2 className="text-[#E0E8EE] font-semibold">
              Edit Send #{entry.send_number} — {entry.sector.toUpperCase()}
            </h2>
            <p className="text-[#6B7E8F] text-xs mt-0.5">
              Scheduled: {entry.calculated_send_date}
            </p>
          </div>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Status */}
          <div className="flex items-center gap-3">
            <label className="text-[#6B7E8F] text-sm w-20">Status</label>
            <div className="flex gap-2">
              {['draft', 'approved', 'skipped'].map(s => (
                <button
                  key={s}
                  onClick={() => setStatus(s as any)}
                  className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                    status === s
                      ? 'border-[#0D9488] bg-[#0D9488]/15 text-[#0D9488]'
                      : 'border-[#1A2A3D] text-[#6B7E8F] hover:border-[#1993C5]/30'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Hero image */}
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1.5">
              <Image size={12} className="inline mr-1" /> Hero Image
            </label>
            <select
              value={heroImage}
              onChange={e => setHeroImage(e.target.value)}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
            >
              {sectorImages.length > 0 && (
                <optgroup label={`${entry.sector.toUpperCase()} Images`}>
                  {sectorImages.map(img => (
                    <option key={img} value={img}>{img}</option>
                  ))}
                </optgroup>
              )}
              {otherImages.length > 0 && (
                <optgroup label="Other Images">
                  {otherImages.map(img => (
                    <option key={img} value={img}>{img}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* Subject */}
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1.5">Subject Line</label>
            <input
              type="text"
              value={subjectLine}
              onChange={e => setSubjectLine(e.target.value)}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
            />
          </div>

          {/* Body */}
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1.5">Body Copy (HTML)</label>
            <textarea
              value={bodyCopy}
              onChange={e => setBodyCopy(e.target.value)}
              rows={10}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] font-mono resize-none"
            />
          </div>

          {/* Article */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[#6B7E8F] text-sm mb-1.5">Article Title</label>
              <input
                type="text"
                value={articleTitle}
                onChange={e => setArticleTitle(e.target.value)}
                className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
              />
            </div>
            <div>
              <label className="block text-[#6B7E8F] text-sm mb-1.5">Article Slug</label>
              <input
                type="text"
                value={articleSlug}
                onChange={e => setArticleSlug(e.target.value)}
                placeholder="e.g. btr-market-outlook-2026"
                className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]"
              />
            </div>
          </div>

          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1.5">Article Excerpt</label>
            <textarea
              value={articleExcerpt}
              onChange={e => setArticleExcerpt(e.target.value)}
              rows={3}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] resize-none"
            />
          </div>
        </div>

        <div className="p-4 border-t border-[#1A2A3D] flex gap-3 justify-end">
          <button onClick={onClose} className="border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm transition-colors"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedule card ────────────────────────────────────────────────────────────

function ScheduleCard({
  entry,
  onPreview,
  onEdit,
}: {
  entry: CampaignScheduleEntry;
  onPreview: () => void;
  onEdit: () => void;
}) {
  const sendDate = entry.calculated_send_date;
  const dateObj = sendDate ? new Date(sendDate + 'T00:00:00') : null;
  const month = dateObj ? dateObj.toLocaleString('en-GB', { month: 'short' }) : '';
  const day = dateObj ? dateObj.getDate() : '';

  return (
    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg overflow-hidden hover:border-[#1993C5]/30 transition-colors group">
      {/* Hero image thumbnail */}
      {entry.template_id ? (
        <div className="relative h-28 overflow-hidden bg-[#080F18] cursor-pointer" onClick={onPreview}>
          <img
            src={`/outreach/api/campaign-planner/template-hero/${entry.template_id}?v=${encodeURIComponent(entry.updated_at || '')}`}
            alt={entry.sector}
            className="w-full h-full object-cover"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0D1B2A] via-transparent to-transparent" />
          <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between">
            <span className="text-white text-xs font-bold drop-shadow-lg">
              Send #{entry.send_number}
            </span>
            <StatusBadge status={entry.status} />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#1A2A3D] bg-[#0A131E]">
          <div className="text-center min-w-[40px]">
            <div className="text-[#0D9488] text-[10px] font-bold uppercase leading-tight">{month}</div>
            <div className="text-[#E0E8EE] text-lg font-bold leading-tight">{day}</div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[#E0E8EE] text-sm font-medium truncate">Send #{entry.send_number}</div>
          </div>
          <StatusBadge status={entry.status} />
        </div>
      )}

      {/* Content */}
      <div className="p-4">
        {entry.template_name && (
          <div className="text-[#0D9488] text-xs font-medium mb-1.5 truncate">
            {entry.template_name.replace(/^(Clients|Introducers) — [^—]+ — /, '')}
          </div>
        )}
        <div className="text-[#B0BEC5] text-sm font-medium mb-1 truncate">
          {entry.template_subject || entry.subject_line || <span className="text-[#6B7E8F] italic">No subject</span>}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 px-4 py-2.5 border-t border-[#1A2A3D]">
        <button
          onClick={onPreview}
          className="flex items-center gap-1.5 text-xs text-[#6B7E8F] hover:text-[#74DFF6] transition-colors"
        >
          <Eye size={12} /> Preview
        </button>
        <button
          onClick={onEdit}
          className="flex items-center gap-1.5 text-xs text-[#6B7E8F] hover:text-[#B0BEC5] transition-colors"
        >
          <Edit2 size={12} /> Edit
        </button>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

// ─── Engine Panel ─────────────────────────────────────────────────────────────

function EnginePanel() {
  const queryClient = useQueryClient();
  const [showLog, setShowLog] = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ['engine-status'],
    queryFn: () => campaignPlannerApi.getEngineStatus().then(r => r.data),
    refetchInterval: 10000,
  });

  const { data: log } = useQuery({
    queryKey: ['engine-log'],
    queryFn: () => campaignPlannerApi.getEngineLog(30).then(r => r.data),
    enabled: showLog,
    refetchInterval: showLog ? 10000 : false,
  });

  const runMutation = useMutation({
    mutationFn: () => campaignPlannerApi.runEngine(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engine-status'] });
      queryClient.invalidateQueries({ queryKey: ['engine-log'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-schedule'] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => campaignPlannerApi.approveAll(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engine-status'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-schedule'] });
    },
  });

  if (isLoading || !status) return null;

  const isActive = status.last_result !== null || status.running;

  return (
    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-[#0D9488]" />
          <h2 className="text-[#E0E8EE] font-semibold">Send Engine</h2>
          {status.running && (
            <span className="flex items-center gap-1.5 text-xs bg-[#0D9488]/15 text-[#0D9488] px-2 py-0.5 rounded">
              <Loader2 size={10} className="animate-spin" /> Running
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status.draft > 0 && (
            <button
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending}
              className="flex items-center gap-1.5 text-xs bg-[#1A2A3D] hover:bg-[#243447] text-[#B0BEC5] px-3 py-1.5 rounded transition-colors"
            >
              <CheckCircle2 size={12} />
              Approve All ({status.draft})
            </button>
          )}
          <button
            onClick={() => setShowLog(!showLog)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors ${
              showLog ? 'bg-[#1993C5]/15 text-[#1993C5]' : 'bg-[#1A2A3D] hover:bg-[#243447] text-[#B0BEC5]'
            }`}
          >
            <Clock size={12} />
            Log
          </button>
          <button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending || status.running}
            className="flex items-center gap-1.5 text-sm bg-[#0D9488] hover:bg-[#0B8278] disabled:opacity-40 text-white px-4 py-1.5 rounded transition-colors"
          >
            {runMutation.isPending || status.running ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            Run Now
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-3">
        <div className="bg-[#0A131E] rounded px-3 py-2">
          <div className="text-[#6B7E8F] text-[10px] uppercase tracking-wide">Approved</div>
          <div className="text-lg font-bold text-green-400">{status.approved}</div>
        </div>
        <div className="bg-[#0A131E] rounded px-3 py-2">
          <div className="text-[#6B7E8F] text-[10px] uppercase tracking-wide">Sent</div>
          <div className="text-lg font-bold text-[#74DFF6]">{status.sent}</div>
        </div>
        <div className="bg-[#0A131E] rounded px-3 py-2">
          <div className="text-[#6B7E8F] text-[10px] uppercase tracking-wide">Drafts</div>
          <div className="text-lg font-bold text-[#6B7E8F]">{status.draft}</div>
        </div>
        <div className="bg-[#0A131E] rounded px-3 py-2">
          <div className="text-[#6B7E8F] text-[10px] uppercase tracking-wide">Sent Today</div>
          <div className="text-lg font-bold text-[#E0E8EE]">{status.sends_today}</div>
        </div>
        <div className="bg-[#0A131E] rounded px-3 py-2">
          <div className="text-[#6B7E8F] text-[10px] uppercase tracking-wide">Total Sent</div>
          <div className="text-lg font-bold text-[#E0E8EE]">{status.sends_total}</div>
        </div>
        <div className="bg-[#0A131E] rounded px-3 py-2">
          <div className="text-[#6B7E8F] text-[10px] uppercase tracking-wide">Next Due</div>
          <div className="text-sm font-bold text-[#E0E8EE] mt-0.5">{status.next_due || '—'}</div>
        </div>
      </div>

      {/* Last run info */}
      {status.last_run_at && status.last_result && (
        <div className="text-xs text-[#6B7E8F]">
          Last run: {new Date(status.last_run_at).toLocaleString()} —{' '}
          {status.last_result.ran ? (
            <span>
              {status.last_result.contacts_queued} queued, {status.last_result.contacts_skipped} skipped
              {status.last_result.errors.length > 0 && (
                <span className="text-red-400"> , {status.last_result.errors.length} errors</span>
              )}
            </span>
          ) : (
            <span className="text-[#6B7E8F]">{status.last_result.reason}</span>
          )}
        </div>
      )}

      {/* Activity log */}
      {showLog && log && (
        <div className="mt-4 border-t border-[#1A2A3D] pt-4">
          <h3 className="text-[#E0E8EE] text-sm font-semibold mb-3">Recent Activity</h3>
          {log.length === 0 ? (
            <p className="text-[#6B7E8F] text-sm">No sends yet</p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {log.map((entry: EngineLogEntry, i: number) => (
                <div key={i} className="flex items-center gap-3 text-xs py-1.5 px-2 rounded bg-[#0A131E]">
                  {entry.email_status === 'sent' ? (
                    <CheckCircle2 size={12} className="text-green-400 shrink-0" />
                  ) : entry.email_status === 'failed' || entry.campaign_status === 'failed' ? (
                    <AlertCircle size={12} className="text-red-400 shrink-0" />
                  ) : (
                    <Send size={12} className="text-[#6B7E8F] shrink-0" />
                  )}
                  <span className="text-[#0D9488] font-medium w-24 shrink-0 truncate">{entry.sector}</span>
                  <span className="text-[#6B7E8F]">#{entry.send_number}</span>
                  <span className="text-[#B0BEC5] flex-1 truncate">
                    {entry.first_name} {entry.last_name} ({entry.email})
                  </span>
                  <span className="text-[#6B7E8F] shrink-0">
                    {entry.email_sent_at ? new Date(entry.email_sent_at).toLocaleDateString() : entry.created_at ? new Date(entry.created_at).toLocaleDateString() : ''}
                  </span>
                  {entry.error_message && (
                    <span className="text-red-400 truncate max-w-[120px]" title={entry.error_message}>{entry.error_message}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CampaignPlanner() {
  const queryClient = useQueryClient();
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editEntry, setEditEntry] = useState<CampaignScheduleEntry | null>(null);

  // Queries
  const { data: settings } = useQuery({
    queryKey: ['campaign-settings'],
    queryFn: () => campaignPlannerApi.getSettings().then(r => r.data),
  });

  const { data: sectors } = useQuery({
    queryKey: ['campaign-sectors'],
    queryFn: () => campaignPlannerApi.getSectors().then(r => r.data),
  });

  const { data: schedule, isLoading: scheduleLoading } = useQuery({
    queryKey: ['campaign-schedule', selectedSector],
    queryFn: () => campaignPlannerApi.getSchedule(selectedSector || undefined).then(r => r.data),
  });

  const { data: heroImages } = useQuery({
    queryKey: ['hero-images'],
    queryFn: () => campaignPlannerApi.getHeroImages().then(r => r.data),
  });

  // Settings mutation
  const settingsMutation = useMutation({
    mutationFn: (data: Partial<CampaignPlannerSettings>) => campaignPlannerApi.updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign-settings'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-schedule'] });
    },
  });

  // Group schedule by sector
  const groupedBySector: Record<string, CampaignScheduleEntry[]> = {};
  if (schedule) {
    for (const entry of schedule) {
      if (!groupedBySector[entry.sector]) groupedBySector[entry.sector] = [];
      groupedBySector[entry.sector].push(entry);
    }
  }

  const sectorKeys = Object.keys(groupedBySector).sort();
  const totalSends = schedule?.length ?? 0;
  const approvedSends = schedule?.filter(s => s.status === 'approved').length ?? 0;
  const draftSends = schedule?.filter(s => s.status === 'draft').length ?? 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[#E0E8EE] text-2xl font-bold">Planner</h1>
          <p className="text-[#6B7E8F] text-sm mt-1">
            12-month sector outreach schedule
          </p>
        </div>
        <div className="flex items-center gap-3">
          {sectors && (
            <SectorDropdown
              sectors={sectors}
              selected={selectedSector}
              onSelect={setSelectedSector}
            />
          )}
        </div>
      </div>

      {/* Settings */}
      {settings && (
        <SettingsPanel
          settings={settings}
          onUpdate={(data) => settingsMutation.mutate(data)}
          saving={settingsMutation.isPending}
        />
      )}

      {/* Engine controls */}
      <EnginePanel />

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-4">
          <div className="text-[#6B7E8F] text-xs mb-1">Total Sends</div>
          <div className="text-xl font-bold text-[#74DFF6]">{totalSends}</div>
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-4">
          <div className="text-[#6B7E8F] text-xs mb-1">Sectors</div>
          <div className="text-xl font-bold text-[#0D9488]">{sectorKeys.length}</div>
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-4">
          <div className="text-[#6B7E8F] text-xs mb-1">Approved</div>
          <div className="text-xl font-bold text-green-400">{approvedSends}</div>
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-4">
          <div className="text-[#6B7E8F] text-xs mb-1">Drafts</div>
          <div className="text-xl font-bold text-[#6B7E8F]">{draftSends}</div>
        </div>
      </div>

      {/* Schedule grid */}
      {scheduleLoading ? (
        <div className="text-[#6B7E8F] text-center py-16">
          <Loader2 size={24} className="animate-spin mx-auto mb-2" />
          Loading schedule...
        </div>
      ) : sectorKeys.length === 0 ? (
        <div className="text-center py-16">
          <Calendar size={40} className="mx-auto text-[#1A2A3D] mb-4" />
          <p className="text-[#6B7E8F]">No schedule entries found</p>
        </div>
      ) : (
        <div className="space-y-8">
          {sectorKeys.map(sector => {
            const entries = groupedBySector[sector];
            const sectorInfo = sectors?.find(s => s.sector === sector);

            return (
              <div key={sector}>
                {/* Sector header — only show when viewing "All" */}
                {!selectedSector && (
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#0D9488]" />
                    <h3 className="text-[#E0E8EE] font-semibold text-lg">{sector.toUpperCase()}</h3>
                    <div className="flex items-center gap-1.5 text-[#6B7E8F] text-xs">
                      <Users size={12} />
                      {sectorInfo?.contacts ?? 0} contacts
                    </div>
                    <div className="flex-1 h-px bg-[#1A2A3D]" />
                  </div>
                )}

                {/* 12-send grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {entries.map(entry => (
                    <ScheduleCard
                      key={entry.id}
                      entry={entry}
                      onPreview={() => setPreviewId(entry.id)}
                      onEdit={() => setEditEntry(entry)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {previewId && (
        <PreviewModal id={previewId} onClose={() => setPreviewId(null)} />
      )}
      {editEntry && heroImages && (
        <EditModal
          entry={editEntry}
          heroImages={heroImages}
          onClose={() => setEditEntry(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['campaign-schedule'] });
          }}
        />
      )}
    </div>
  );
}
