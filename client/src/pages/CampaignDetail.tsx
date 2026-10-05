import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Plus, Trash2, Edit2, Play, Pause, Users, Clock, Mail, CheckCircle,
} from 'lucide-react';
import { campaignsApi, templatesApi, contactsApi, CampaignStep, Campaign } from '../lib/api';

function StepEditor({
  step,
  templates,
  onSave,
  onCancel,
}: {
  step?: Partial<CampaignStep>;
  templates: Array<{ id: string; name: string; subject: string }>;
  onSave: (data: Partial<CampaignStep>) => void;
  onCancel: () => void;
}) {
  const [templateId, setTemplateId] = useState(step?.template_id || '');
  const [delayDays, setDelayDays] = useState(step?.delay_days ?? 0);
  const [delayHours, setDelayHours] = useState(step?.delay_hours ?? 0);
  const [useVariant, setUseVariant] = useState(!!step?.variant_template_id);
  const [variantTemplateId, setVariantTemplateId] = useState(step?.variant_template_id || '');
  const [variantSplit, setVariantSplit] = useState(step?.variant_split ?? 50);

  return (
    <div className="bg-[#0A131E] border border-[#1993C5]/30 rounded-lg p-4 space-y-3">
      <div>
        <label className="block text-[#6B7E8F] text-xs mb-1">Template</label>
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                     focus:outline-none focus:border-[#1993C5]"
        >
          <option value="">Select template...</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name} — {t.subject.substring(0, 50)}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-[#6B7E8F] text-xs mb-1">Delay Days</label>
          <input
            type="number"
            min={0}
            value={delayDays}
            onChange={(e) => setDelayDays(parseInt(e.target.value) || 0)}
            className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                       focus:outline-none focus:border-[#1993C5]"
          />
        </div>
        <div className="flex-1">
          <label className="block text-[#6B7E8F] text-xs mb-1">Delay Hours</label>
          <input
            type="number"
            min={0}
            max={23}
            value={delayHours}
            onChange={(e) => setDelayHours(parseInt(e.target.value) || 0)}
            className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                       focus:outline-none focus:border-[#1993C5]"
          />
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 text-[#6B7E8F] text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={useVariant}
            onChange={(e) => setUseVariant(e.target.checked)}
            className="accent-[#1993C5]"
          />
          A/B Test with variant template
        </label>
      </div>

      {useVariant && (
        <div className="space-y-2 pl-4 border-l border-[#1A2A3D]">
          <div>
            <label className="block text-[#6B7E8F] text-xs mb-1">Variant B Template</label>
            <select
              value={variantTemplateId}
              onChange={(e) => setVariantTemplateId(e.target.value)}
              className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                         focus:outline-none focus:border-[#1993C5]"
            >
              <option value="">Select variant...</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[#6B7E8F] text-xs mb-1">Variant B Split % ({variantSplit}%)</label>
            <input
              type="range"
              min={10}
              max={90}
              value={variantSplit}
              onChange={(e) => setVariantSplit(parseInt(e.target.value))}
              className="w-full accent-[#1993C5]"
            />
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} className="flex-1 border border-[#1A2A3D] text-[#6B7E8F] rounded px-3 py-1.5 text-sm hover:border-[#B0BEC5] transition-colors">
          Cancel
        </button>
        <button
          onClick={() => onSave({
            template_id: templateId || undefined,
            delay_days: delayDays,
            delay_hours: delayHours,
            variant_template_id: useVariant ? variantTemplateId || undefined : undefined,
            variant_split: useVariant ? variantSplit : undefined,
          })}
          className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] text-white rounded px-3 py-1.5 text-sm transition-colors"
        >
          Save Step
        </button>
      </div>
    </div>
  );
}

function EnrollModal({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const { data: contacts } = useQuery({
    queryKey: ['contacts', search],
    queryFn: () => contactsApi.list({ search, limit: 50 }).then((r) => r.data),
  });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const handleEnroll = async () => {
    if (selected.size === 0) return;
    setLoading(true);
    try {
      await campaignsApi.enroll(campaignId, Array.from(selected));
      queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-lg flex flex-col max-h-[80vh]">
        <div className="p-5 border-b border-[#1A2A3D]">
          <h2 className="text-[#E0E8EE] font-semibold">Enroll Contacts</h2>
          <p className="text-[#6B7E8F] text-sm mt-1">{selected.size} selected</p>
        </div>

        <div className="p-4 border-b border-[#1A2A3D]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contacts..."
            className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                       focus:outline-none focus:border-[#1993C5]"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {(contacts?.data || []).map((c) => (
            <label key={c.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#1A2A3D]/30 cursor-pointer border-b border-[#1A2A3D]/30">
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className="accent-[#1993C5]"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[#B0BEC5] text-sm truncate">
                  {c.first_name} {c.last_name} — {c.email}
                </div>
                <div className="text-[#6B7E8F] text-xs">{c.company} {c.title ? `· ${c.title}` : ''}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="p-4 border-t border-[#1A2A3D] flex gap-3">
          <button onClick={onClose} className="flex-1 border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={handleEnroll}
            disabled={loading || selected.size === 0}
            className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm"
          >
            {loading ? 'Enrolling...' : `Enroll ${selected.size} Contact${selected.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [addingStep, setAddingStep] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => campaignsApi.get(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list().then((r) => r.data.templates),
  });

  const statusMutation = useMutation({
    mutationFn: (status: string) => campaignsApi.setStatus(id!, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
  });

  const addStepMutation = useMutation({
    mutationFn: (data: Partial<CampaignStep>) => campaignsApi.addStep(id!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
      setAddingStep(false);
    },
  });

  const updateStepMutation = useMutation({
    mutationFn: ({ stepId, data }: { stepId: string; data: Partial<CampaignStep> }) =>
      campaignsApi.updateStep(id!, stepId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
      setEditingStep(null);
    },
  });

  const deleteStepMutation = useMutation({
    mutationFn: (stepId: string) => campaignsApi.deleteStep(id!, stepId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
  });

  if (isLoading) {
    return <div className="p-6 text-[#6B7E8F]">Loading campaign...</div>;
  }

  if (!campaign) {
    return <div className="p-6 text-[#6B7E8F]">Campaign not found</div>;
  }

  const enrollmentStats = campaign.enrollment_stats || [];
  const activeCount = enrollmentStats.find((s: { status: string }) => s.status === 'active')?.count || 0;
  const completedCount = enrollmentStats.find((s: { status: string }) => s.status === 'completed')?.count || 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => navigate('/campaigns')}
          className="flex items-center gap-1.5 text-[#6B7E8F] hover:text-[#B0BEC5] text-sm mb-4 transition-colors"
        >
          <ArrowLeft size={14} /> All Campaigns
        </button>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-[#E0E8EE] text-2xl font-bold">{campaign.name}</h1>
            {campaign.description && (
              <p className="text-[#6B7E8F] text-sm mt-1">{campaign.description}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setShowEnroll(true)}
              disabled={campaign.status !== 'active'}
              className="flex items-center gap-2 bg-[#1A2A3D] hover:bg-[#1993C5]/20 disabled:opacity-40 text-[#B0BEC5] hover:text-[#74DFF6] rounded-lg px-3 py-2 text-sm transition-colors"
            >
              <Users size={14} /> Enroll Contacts
            </button>

            {campaign.status === 'draft' && (
              <button
                onClick={() => statusMutation.mutate('active')}
                className="flex items-center gap-2 bg-green-900/30 hover:bg-green-900/50 text-green-400 rounded-lg px-3 py-2 text-sm transition-colors"
              >
                <Play size={14} /> Activate
              </button>
            )}
            {campaign.status === 'active' && (
              <button
                onClick={() => statusMutation.mutate('paused')}
                className="flex items-center gap-2 bg-amber-900/30 hover:bg-amber-900/50 text-amber-400 rounded-lg px-3 py-2 text-sm transition-colors"
              >
                <Pause size={14} /> Pause
              </button>
            )}
            {campaign.status === 'paused' && (
              <button
                onClick={() => statusMutation.mutate('active')}
                className="flex items-center gap-2 bg-green-900/30 hover:bg-green-900/50 text-green-400 rounded-lg px-3 py-2 text-sm transition-colors"
              >
                <Play size={14} /> Resume
              </button>
            )}
          </div>
        </div>

        {/* Stats bar */}
        <div className="flex gap-4 mt-4">
          <div className="flex items-center gap-1.5 text-sm">
            <Users size={13} className="text-[#6B7E8F]" />
            <span className="text-[#B0BEC5]">{activeCount}</span>
            <span className="text-[#6B7E8F]">active</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <CheckCircle size={13} className="text-[#6B7E8F]" />
            <span className="text-[#B0BEC5]">{completedCount}</span>
            <span className="text-[#6B7E8F]">completed</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <Clock size={13} className="text-[#6B7E8F]" />
            <span className="text-[#6B7E8F]">{campaign.send_window_start} – {campaign.send_window_end}</span>
            {campaign.skip_weekends && <span className="text-[#6B7E8F]">· weekdays only</span>}
          </div>
        </div>
      </div>

      {/* Steps Timeline */}
      <div className="mb-6">
        <h2 className="text-[#E0E8EE] font-semibold mb-4">Sequence Steps</h2>

        {campaign.steps.length === 0 && !addingStep ? (
          <div className="text-center py-10 border border-dashed border-[#1A2A3D] rounded-lg">
            <Mail size={32} className="mx-auto text-[#1A2A3D] mb-3" />
            <p className="text-[#6B7E8F] text-sm">No steps yet — add your first email step</p>
          </div>
        ) : (
          <div className="space-y-3">
            {campaign.steps.map((step, idx) => (
              <div key={step.id} className="flex gap-4">
                {/* Step number indicator */}
                <div className="flex flex-col items-center">
                  <div className="w-8 h-8 rounded-full bg-[#1A2A3D] border border-[#1993C5]/30 flex items-center justify-center text-[#74DFF6] text-sm font-medium">
                    {step.step_number}
                  </div>
                  {idx < campaign.steps.length - 1 && (
                    <div className="w-px h-full bg-[#1A2A3D] mt-1" />
                  )}
                </div>

                <div className="flex-1 pb-4">
                  {editingStep === step.id ? (
                    <StepEditor
                      step={step}
                      templates={templates || []}
                      onSave={(data) => updateStepMutation.mutate({ stepId: step.id, data })}
                      onCancel={() => setEditingStep(null)}
                    />
                  ) : (
                    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-4 flex items-start justify-between hover:border-[#1993C5]/30 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[#B0BEC5] font-medium text-sm">
                            {step.template_name || 'No template'}
                          </span>
                          {step.variant_template_name && (
                            <span className="text-xs bg-[#1993C5]/20 text-[#74DFF6] px-1.5 py-0.5 rounded">A/B</span>
                          )}
                        </div>
                        {step.template_subject && (
                          <div className="text-[#6B7E8F] text-xs mt-0.5 truncate">
                            {step.template_subject}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 text-[#6B7E8F] text-xs mt-1.5">
                          <Clock size={11} />
                          {step.step_number === 1 ? 'Immediately' : `After ${step.delay_days}d ${step.delay_hours}h`}
                        </div>
                      </div>
                      <div className="flex gap-1 ml-3">
                        <button
                          onClick={() => setEditingStep(step.id)}
                          className="p-1.5 text-[#6B7E8F] hover:text-[#B0BEC5] rounded hover:bg-[#1A2A3D] transition-colors"
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm('Delete this step?')) deleteStepMutation.mutate(step.id);
                          }}
                          className="p-1.5 text-[#6B7E8F] hover:text-red-400 rounded hover:bg-[#1A2A3D] transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {addingStep && (
              <div className="flex gap-4">
                <div className="w-8 flex justify-center pt-1">
                  <div className="w-8 h-8 rounded-full bg-[#1A2A3D] border border-[#1993C5]/50 flex items-center justify-center text-[#74DFF6] text-sm">
                    {campaign.steps.length + 1}
                  </div>
                </div>
                <div className="flex-1">
                  <StepEditor
                    templates={templates || []}
                    onSave={(data) => addStepMutation.mutate(data)}
                    onCancel={() => setAddingStep(false)}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {!addingStep && (
          <button
            onClick={() => setAddingStep(true)}
            className="mt-4 flex items-center gap-2 text-[#1993C5] hover:text-[#74DFF6] text-sm transition-colors"
          >
            <Plus size={14} /> Add Step
          </button>
        )}
      </div>

      {showEnroll && id && (
        <EnrollModal campaignId={id} onClose={() => setShowEnroll(false)} />
      )}
    </div>
  );
}
