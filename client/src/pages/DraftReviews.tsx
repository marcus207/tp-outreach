import React, { useState, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileEdit, Mail, Linkedin, CheckCircle, XCircle, Clock, Send,
  ChevronRight, RefreshCw, Eye, EyeOff, BarChart2, AlertTriangle,
  CalendarDays, MessageSquare, Loader2, Download, Image,
} from 'lucide-react';
import api from '../lib/api';

interface DraftReview {
  id: string;
  theme: string;
  season: string;
  week_start: string;
  round: number;
  email_subject: string;
  email_html: string;
  linkedin_content: string | null;
  linkedin_poster_html: string | null;
  image_url: string | null;
  status: string;
  approved_at: string | null;
  sent_at: string | null;
  emails_sent: number;
  feedback_1: string | null;
  feedback_2: string | null;
  created_at: string;
  stats?: {
    emails_sent: number;
    opens: number;
    open_rate: number;
    clicks: number;
    bounces: number;
  };
}

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
  drafting:          { bg: 'bg-yellow-50', text: 'text-yellow-700', icon: <Clock size={12} />, label: 'Generating…' },
  awaiting_approval: { bg: 'bg-blue-50',   text: 'text-blue-700',   icon: <Clock size={12} />, label: 'Awaiting Approval' },
  approved:          { bg: 'bg-green-50',  text: 'text-green-700',  icon: <CheckCircle size={12} />, label: 'Approved' },
  sent:              { bg: 'bg-indigo-50', text: 'text-indigo-700', icon: <Send size={12} />, label: 'Sent' },
  skipped:           { bg: 'bg-gray-100',  text: 'text-gray-500',   icon: <XCircle size={12} />, label: 'Skipped' },
  superseded:        { bg: 'bg-gray-100',  text: 'text-gray-400',   icon: <ChevronRight size={12} />, label: 'Superseded' },
};

const SEASON_EMOJI: Record<string, string> = { spring: '🌱', summer: '☀️', autumn: '🍂', winter: '❄️' };

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.drafting;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${s.bg} ${s.text}`}>
      {s.icon}{s.label}
    </span>
  );
}

function StatPill({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2 text-center min-w-[72px]">
      <div className="text-base font-bold text-gray-800">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

export default function DraftReviews() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEmailPreview, setShowEmailPreview] = useState(true);
  const [showLinkedin, setShowLinkedin] = useState(true);
  const [linkedinCopied, setLinkedinCopied] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const qc = useQueryClient();

  const { data: drafts = [], isLoading } = useQuery<DraftReview[]>({
    queryKey: ['draft-reviews'],
    queryFn: () => api.get('/draft-reviews').then(r => r.data),
    refetchInterval: 30000,
  });

  const { data: selected } = useQuery<DraftReview>({
    queryKey: ['draft-reviews', selectedId],
    queryFn: () => api.get(`/draft-reviews/${selectedId}`).then(r => r.data),
    enabled: !!selectedId,
    refetchInterval: 15000,
  });

  const generateMutation = useMutation({
    mutationFn: () => api.post('/draft-reviews/generate'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['draft-reviews'] }),
  });

  const feedbackMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      api.post(`/draft-reviews/${id}/feedback`, { feedback: text }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['draft-reviews'] });
      setSelectedId(res.data.id);
      setFeedback('');
    },
  });

  const handleBulkGenerate = async () => {
    setBulkGenerating(true);
    await api.post('/draft-reviews/generate-bulk', { weeks: 13 });
    // Poll until count stabilises
    const pollInterval = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['draft-reviews'] });
    }, 8000);
    setTimeout(() => {
      clearInterval(pollInterval);
      setBulkGenerating(false);
      qc.invalidateQueries({ queryKey: ['draft-reviews'] });
    }, 130000); // 13 drafts × ~10s each
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.get(`/draft-reviews/${id}/approve?token=platform`),
    onError: () => {},
  });

  // For approve/skip from within the platform we redirect to the token URLs
  // (the token is in the full draft data — we need to fetch it)
  const handleApprove = async (draft: DraftReview) => {
    const full = await api.get(`/draft-reviews/${draft.id}`).then(r => r.data as DraftReview & { approval_token: string });
    window.open(`/outreach/api/draft-reviews/${draft.id}/approve?token=${full.approval_token}`, '_blank');
    setTimeout(() => qc.invalidateQueries({ queryKey: ['draft-reviews'] }), 2000);
  };

  const handleSkip = async (draft: DraftReview) => {
    const full = await api.get(`/draft-reviews/${draft.id}`).then(r => r.data as DraftReview & { skip_token: string });
    window.open(`/outreach/api/draft-reviews/${draft.id}/skip?token=${full.skip_token}`, '_blank');
    setTimeout(() => qc.invalidateQueries({ queryKey: ['draft-reviews'] }), 2000);
  };

  const copyLinkedin = (text: string) => {
    navigator.clipboard.writeText(text);
    setLinkedinCopied(true);
    setTimeout(() => setLinkedinCopied(false), 2000);
  };

  const [posterEditing, setPosterEditing] = useState(false);
  const [posterHeadline, setPosterHeadline] = useState('');
  const [posterSubline, setPosterSubline] = useState('');

  const posterMutation = useMutation({
    mutationFn: ({ id, headline, subline }: { id: string; headline: string; subline: string }) =>
      api.patch(`/draft-reviews/${id}/poster`, { headline, subline }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['draft-reviews'] });
      if (selectedId) qc.invalidateQueries({ queryKey: ['draft-reviews', selectedId] });
      setPosterEditing(false);
    },
  });

  const startPosterEdit = useCallback((draft: DraftReview & { email_content_json?: { poster_headline?: string; poster_subline?: string } }) => {
    const content = (draft as any).email_content_json;
    setPosterHeadline(content?.poster_headline || draft.theme);
    setPosterSubline(content?.poster_subline || '');
    setPosterEditing(true);
  }, []);

  const openPosterFullscreen = useCallback((draftId: string) => {
    window.open(`/outreach/api/draft-reviews/${draftId}/poster`, '_blank');
  }, []);

  // Group by week_start, show only latest round per week
  const byWeek: Record<string, DraftReview[]> = {};
  drafts.forEach(d => {
    if (!byWeek[d.week_start]) byWeek[d.week_start] = [];
    byWeek[d.week_start].push(d);
  });
  const weeks = Object.keys(byWeek).sort().reverse();

  return (
    <div className="flex h-full min-h-0">
      {/* Left panel — draft list */}
      <div className="w-80 min-w-[280px] border-r border-gray-200 flex flex-col bg-white overflow-hidden">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="font-semibold text-gray-900 text-sm">Outreach Drafts</h2>
              <p className="text-xs text-gray-500 mt-0.5">Bi-weekly · edit inline or by email · approve to send</p>
            </div>
            <button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending || bulkGenerating}
              title="Generate next draft"
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 disabled:opacity-50"
            >
              <RefreshCw size={15} className={generateMutation.isPending ? 'animate-spin' : ''} />
            </button>
          </div>
          <button
            onClick={handleBulkGenerate}
            disabled={bulkGenerating || generateMutation.isPending}
            className="w-full flex items-center justify-center gap-2 bg-[#0F2744] text-white text-xs py-2 rounded-lg disabled:opacity-60"
          >
            {bulkGenerating
              ? <><Loader2 size={12} className="animate-spin" /> Generating quarters… check back soon</>
              : <><CalendarDays size={12} /> Generate next 2 quarters (13 drafts)</>
            }
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading…</div>
        ) : drafts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <FileEdit size={32} className="text-gray-300 mb-3" />
            <p className="text-sm text-gray-500 mb-1">No drafts yet</p>
            <p className="text-xs text-gray-400 mb-4">Drafts generate automatically every other Monday at 8am UTC</p>
            <button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="text-xs bg-[#0F2744] text-white px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {generateMutation.isPending ? 'Generating…' : 'Generate First Draft'}
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {weeks.map(week => {
              const weekDrafts = byWeek[week].sort((a, b) => b.round - a.round);
              const latest = weekDrafts[0];
              const weekDate = new Date(week + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
              const olderRounds = weekDrafts.slice(1).filter(d => d.status !== 'superseded' || true);

              return (
                <div key={week} className="border-b border-gray-100">
                  {/* Latest round */}
                  <div
                    className={`p-3 cursor-pointer hover:bg-gray-50 transition-colors ${selectedId === latest.id ? 'bg-blue-50 border-r-2 border-blue-500' : ''}`}
                    onClick={() => setSelectedId(latest.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-xs font-medium text-gray-900 truncate">{latest.theme}</span>
                          <span className="text-xs">{SEASON_EMOJI[latest.season]}</span>
                        </div>
                        <div className="text-xs text-gray-500 mb-1.5">Week of {weekDate} · Round {latest.round}</div>
                        <StatusBadge status={latest.status} />
                      </div>
                      {latest.emails_sent > 0 && (
                        <div className="text-right flex-shrink-0">
                          <div className="text-xs font-medium text-gray-700">{latest.emails_sent}</div>
                          <div className="text-xs text-gray-400">sent</div>
                        </div>
                      )}
                    </div>

                    {/* Quick approve/skip for awaiting approval */}
                    {latest.status === 'awaiting_approval' && (
                      <div className="flex gap-2 mt-2" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => handleApprove(latest)}
                          className="flex-1 text-xs bg-[#0F2744] text-white py-1.5 rounded-md font-medium"
                        >
                          Approve & Send
                        </button>
                        <button
                          onClick={() => handleSkip(latest)}
                          className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-md"
                        >
                          Skip
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Previous rounds (collapsed) */}
                  {olderRounds.map(d => (
                    <div
                      key={d.id}
                      className={`pl-6 pr-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors border-t border-gray-50 ${selectedId === d.id ? 'bg-blue-50 border-r-2 border-blue-500' : ''}`}
                      onClick={() => setSelectedId(d.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">Round {d.round}</span>
                        <StatusBadge status={d.status} />
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right panel — draft detail */}
      <div className="flex-1 overflow-y-auto bg-gray-50">
        {!selectedId ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <FileEdit size={40} className="text-gray-300 mb-3" />
            <p className="text-gray-500 text-sm">Select a draft to preview</p>
          </div>
        ) : !selected ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>
        ) : (
          <div className="max-w-3xl mx-auto p-6 space-y-5">
            {/* Header */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="bg-[#0F2744] px-5 py-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-white/60 uppercase tracking-widest mb-1">
                      TP · Outreach Draft
                    </div>
                    <h1 className="text-xl font-semibold text-white">{selected.theme}</h1>
                    <div className="text-sm text-white/70 mt-1">
                      {SEASON_EMOJI[selected.season]} {selected.season.charAt(0).toUpperCase() + selected.season.slice(1)} &nbsp;·&nbsp;
                      Week of {new Date(selected.week_start + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} &nbsp;·&nbsp;
                      Round {selected.round} of 3
                    </div>
                  </div>
                  <StatusBadge status={selected.status} />
                </div>
              </div>

              {/* Actions */}
              {selected.status === 'awaiting_approval' && (
                <div className="px-5 py-3 bg-white border-b border-gray-100 flex items-center gap-3">
                  <button
                    onClick={() => handleApprove(selected)}
                    className="bg-[#0F2744] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[#1a3a5c]"
                  >
                    ✓ Approve &amp; Start Outreach
                  </button>
                  <button
                    onClick={() => handleSkip(selected)}
                    className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm"
                  >
                    Skip This Week
                  </button>
                  <span className="text-xs text-gray-400 ml-auto">
                    Reply to the email to request changes (up to round 3)
                  </span>
                </div>
              )}

              {/* Stats (for sent) */}
              {selected.status === 'sent' && selected.stats && (
                <div className="px-5 py-3 bg-white border-b border-gray-100 flex items-center gap-3 flex-wrap">
                  <BarChart2 size={14} className="text-gray-400" />
                  <StatPill label="Sent"   value={selected.stats.emails_sent} />
                  <StatPill label="Opens"  value={selected.stats.opens} sub={`${selected.stats.open_rate}%`} />
                  <StatPill label="Clicks" value={selected.stats.clicks} />
                  <StatPill label="Bounces" value={selected.stats.bounces} />
                  <div className="ml-auto flex items-center gap-1 text-xs text-gray-400">
                    <AlertTriangle size={12} />
                    Spam reports: coming soon (requires PostmasterTools setup)
                  </div>
                </div>
              )}
            </div>

            {/* Feedback rounds */}
            {(selected.feedback_1 || selected.feedback_2) && (
              <div className="space-y-2">
                {selected.feedback_1 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                    <div className="text-xs font-medium text-amber-700 mb-1">Round 1 feedback</div>
                    <div className="text-sm text-amber-900">{selected.feedback_1}</div>
                  </div>
                )}
                {selected.feedback_2 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                    <div className="text-xs font-medium text-amber-700 mb-1">Round 2 feedback</div>
                    <div className="text-sm text-amber-900">{selected.feedback_2}</div>
                  </div>
                )}
              </div>
            )}

            {/* Inline feedback */}
            {['awaiting_approval', 'drafting'].includes(selected.status) && selected.round < 3 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100">
                  <MessageSquare size={15} className="text-gray-500" />
                  <span className="text-sm font-medium text-gray-800">Request Changes</span>
                  <span className="text-xs text-gray-400 ml-auto">Round {selected.round} of 3 · {3 - selected.round} revision{3 - selected.round !== 1 ? 's' : ''} remaining</span>
                </div>
                <div className="p-4">
                  <textarea
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    placeholder={`e.g. "Make the subject line more direct, shorten the email body by 30%, and change the LinkedIn post to focus on the risk angle rather than opportunity"`}
                    className="w-full border border-gray-200 rounded-lg p-3 text-sm text-gray-800 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20 focus:border-[#0F2744]"
                    rows={3}
                  />
                  <button
                    onClick={() => feedbackMutation.mutate({ id: selected.id, text: feedback })}
                    disabled={!feedback.trim() || feedbackMutation.isPending}
                    className="mt-2 bg-[#0F2744] text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                  >
                    {feedbackMutation.isPending
                      ? <><Loader2 size={13} className="animate-spin" /> Applying changes…</>
                      : 'Apply Changes'
                    }
                  </button>
                  {feedbackMutation.isError && (
                    <p className="mt-2 text-sm text-red-600">
                      {(feedbackMutation.error as any)?.response?.data?.error || 'Edit failed — please try again'}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Email preview */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div
                className="flex items-center justify-between px-5 py-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50"
                onClick={() => setShowEmailPreview(v => !v)}
              >
                <div className="flex items-center gap-2">
                  <Mail size={15} className="text-gray-500" />
                  <span className="text-sm font-medium text-gray-800">Email Draft</span>
                  <span className="text-xs text-gray-500 truncate max-w-xs">— {selected.email_subject}</span>
                </div>
                {showEmailPreview ? <EyeOff size={14} className="text-gray-400" /> : <Eye size={14} className="text-gray-400" />}
              </div>
              {showEmailPreview && (
                <div className="p-4">
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                      <span className="text-xs text-gray-400">Subject: </span>
                      <span className="text-xs font-medium text-gray-700">{selected.email_subject}</span>
                    </div>
                    <div
                      className="p-2 overflow-x-auto"
                      dangerouslySetInnerHTML={{ __html: selected.email_html }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* LinkedIn post */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div
                className="flex items-center justify-between px-5 py-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50"
                onClick={() => setShowLinkedin(v => !v)}
              >
                <div className="flex items-center gap-2">
                  <Linkedin size={15} className="text-[#0A66C2]" />
                  <span className="text-sm font-medium text-gray-800">LinkedIn Post Draft</span>
                  <span className="text-xs text-gray-500">— generated by Opus, written as Marcus</span>
                </div>
                {showLinkedin ? <EyeOff size={14} className="text-gray-400" /> : <Eye size={14} className="text-gray-400" />}
              </div>
              {showLinkedin && selected.linkedin_content && (
                <div className="p-4">
                  <div className="bg-gray-50 rounded-lg p-4 relative">
                    <pre className="text-sm text-gray-800 whitespace-pre-wrap font-sans leading-relaxed">
                      {selected.linkedin_content}
                    </pre>
                    <button
                      onClick={() => copyLinkedin(selected.linkedin_content!)}
                      className="absolute top-3 right-3 text-xs bg-[#0A66C2] text-white px-3 py-1.5 rounded-md font-medium"
                    >
                      {linkedinCopied ? '✓ Copied' : 'Copy Post'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    Written in Marcus's voice by Claude Opus 4.6 — varied sentence structure, first person, no AI buzzwords.
                    Reply to the email to request changes.
                  </p>

                  {/* LinkedIn Poster Image */}
                  {selected.linkedin_poster_html && (
                    <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
                        <div className="flex items-center gap-2">
                          <Image size={14} className="text-gray-500" />
                          <span className="text-xs font-medium text-gray-700">LinkedIn Poster (1200×628)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => startPosterEdit(selected)}
                            className="flex items-center gap-1.5 text-xs bg-gray-200 text-gray-700 px-3 py-1.5 rounded-md font-medium hover:bg-gray-300"
                          >
                            <FileEdit size={12} />
                            Edit Text
                          </button>
                          <button
                            onClick={() => openPosterFullscreen(selected.id)}
                            className="flex items-center gap-1.5 text-xs bg-[#0f1a2e] text-white px-3 py-1.5 rounded-md font-medium hover:bg-[#1a2a42]"
                          >
                            <Download size={12} />
                            Open Full Size
                          </button>
                        </div>
                      </div>

                      {/* Inline poster text editor */}
                      {posterEditing && (
                        <div className="px-4 py-3 bg-yellow-50 border-b border-yellow-200 space-y-2">
                          <div>
                            <label className="text-xs font-medium text-gray-600 block mb-1">Headline</label>
                            <input
                              type="text"
                              value={posterHeadline}
                              onChange={e => setPosterHeadline(e.target.value)}
                              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                              placeholder="5-10 word headline"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-gray-600 block mb-1">Subline</label>
                            <input
                              type="text"
                              value={posterSubline}
                              onChange={e => setPosterSubline(e.target.value)}
                              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                              placeholder="One sentence expanding on the headline"
                            />
                          </div>
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              onClick={() => posterMutation.mutate({ id: selected.id, headline: posterHeadline, subline: posterSubline })}
                              disabled={posterMutation.isPending}
                              className="text-xs bg-teal-600 text-white px-4 py-1.5 rounded-md font-medium hover:bg-teal-700 disabled:opacity-50"
                            >
                              {posterMutation.isPending ? 'Updating…' : 'Update Poster'}
                            </button>
                            <button
                              onClick={() => setPosterEditing(false)}
                              className="text-xs text-gray-500 px-3 py-1.5 hover:text-gray-700"
                            >
                              Cancel
                            </button>
                            <span className="text-xs text-gray-400 ml-auto">Instant — no AI call needed</span>
                          </div>
                        </div>
                      )}

                      <div className="p-3 bg-gray-900">
                        <div style={{ width: '564px', height: '295px', overflow: 'hidden' }}>
                        <div
                          style={{ transform: 'scale(0.47)', transformOrigin: 'top left', width: '1200px', height: '628px' }}
                        >
                          <iframe
                            srcDoc={selected.linkedin_poster_html}
                            style={{ width: '1200px', height: '628px', border: 'none', pointerEvents: 'none' }}
                            title="LinkedIn Poster Preview"
                            sandbox="allow-same-origin"
                          />
                        </div>
                        </div>
                      </div>
                      <p className="text-xs text-gray-400 px-4 py-2 bg-gray-50">
                        Click "Open Full Size" to view at 1200×628, then right-click the page and "Save as" or screenshot. Upload to LinkedIn with the post text above.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
