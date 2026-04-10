import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit2, Trash2, Eye, X, Code, Wand2, Loader2 } from 'lucide-react';
import { templatesApi, Template } from '../lib/api';

const MERGE_FIELD_HELP = [
  '{{first_name}}', '{{last_name}}', '{{full_name}}', '{{email}}',
  '{{company}}', '{{title}}', '{{city}}', '{{country}}',
];

function TemplateModal({
  template,
  onClose,
}: {
  template?: Template;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(template?.name || '');
  const [subject, setSubject] = useState(template?.subject || '');
  const [bodyHtml, setBodyHtml] = useState(template?.body_html || '');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; bodyHtml: string } | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !subject || !bodyHtml) return;
    setLoading(true);
    try {
      if (template) {
        await templatesApi.update(template.id, { name, subject, body_html: bodyHtml });
      } else {
        await templatesApi.create({ name, subject, body_html: bodyHtml });
      }
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!subject || !bodyHtml) return;
    try {
      if (template) {
        const res = await templatesApi.preview(template.id);
        setPreview(res.data);
      } else {
        // Preview with sample data inline
        const sampleData: Record<string, string> = {
          first_name: 'John', last_name: 'Smith', full_name: 'John Smith',
          email: 'john@example.com', company: 'Acme Corp', title: 'CFO',
          city: 'New York', country: 'USA',
        };
        const rendered = {
          subject: subject.replace(/\{\{(\w+)\}\}/g, (_, k) => sampleData[k] || ''),
          bodyHtml: bodyHtml.replace(/\{\{(\w+)\}\}/g, (_, k) => sampleData[k] || ''),
        };
        setPreview(rendered);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const insertMergeField = (field: string) => {
    setBodyHtml((prev) => prev + field);
  };

  const handleAiEdit = async () => {
    if (!aiPrompt.trim() || !template) return;
    setAiLoading(true);
    setAiError('');
    try {
      const res = await templatesApi.aiEdit(template.id, aiPrompt.trim());
      setBodyHtml(res.data.body_html);
      setAiPrompt('');
    } catch {
      setAiError('AI edit failed — try again.');
    } finally {
      setAiLoading(false);
    }
  };

  const AI_PROMPT_SUGGESTIONS = [
    'Change the hero image to hotel_london.jpg',
    'Change the hero image to hospitality.jpg',
    'Change the hero image to product_07_stabilisation_hotels.jpg',
    'Change the hero image to london_hotel.jpg (stock)',
    'Update the accent bar headline text',
    'Update the stats to show £2bn+ transactions',
    'Add a paragraph about cross-border European deals',
    'Change the season focus to summer — warmer tone, peak trading season',
    'Change the season focus to autumn — year-end refinancing angle',
    'Change the season focus to winter — new year planning, 2027 pipeline',
    'Shorten the email — remove the benefits section',
    'Make the tone more direct and punchy',
  ];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-3xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-[#1A2A3D] flex items-center justify-between">
          <h2 className="text-[#E0E8EE] font-semibold">
            {template ? 'Edit Template' : 'New Template'}
          </h2>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]">
            <X size={18} />
          </button>
        </div>

        {preview ? (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[#E0E8EE] font-medium">Preview</h3>
              <button onClick={() => setPreview(null)} className="text-[#1993C5] hover:text-[#74DFF6] text-sm">
                ← Back to edit
              </button>
            </div>
            <div className="bg-[#0A131E] border border-[#1A2A3D] rounded p-4 mb-4">
              <div className="text-[#6B7E8F] text-xs mb-1">Subject</div>
              <div className="text-[#B0BEC5]">{preview.subject}</div>
            </div>
            <div className="bg-white rounded p-4 text-sm text-gray-800 prose max-w-none"
              dangerouslySetInnerHTML={{ __html: preview.bodyHtml }} />
          </div>
        ) : (
          <form onSubmit={handleSave} className="flex-1 overflow-y-auto">
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[#6B7E8F] text-sm mb-1">Template Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Initial Outreach"
                    className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                               focus:outline-none focus:border-[#1993C5]"
                  />
                </div>
                <div>
                  <label className="block text-[#6B7E8F] text-sm mb-1">Subject Line</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="e.g. Quick question, {{first_name}}"
                    className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                               focus:outline-none focus:border-[#1993C5]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[#6B7E8F] text-sm">HTML Body</label>
                  <div className="flex flex-wrap gap-1">
                    {MERGE_FIELD_HELP.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => insertMergeField(f)}
                        className="text-xs bg-[#1993C5]/15 text-[#74DFF6] px-1.5 py-0.5 rounded hover:bg-[#1993C5]/30 transition-colors"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  value={bodyHtml}
                  onChange={(e) => setBodyHtml(e.target.value)}
                  placeholder="<p>Hi {{first_name}},</p>..."
                  rows={12}
                  className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                             focus:outline-none focus:border-[#1993C5] font-mono resize-none"
                />
              </div>
            </div>

            {template && (
              <div className="px-5 pb-4 border-t border-[#1A2A3D] pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Wand2 size={13} className="text-[#0D9488]" />
                  <span className="text-[#E0E8EE] text-sm font-medium">AI Edit</span>
                  <span className="text-[#6B7E8F] text-xs ml-1">— describe the change you want</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {AI_PROMPT_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setAiPrompt(s)}
                      className="text-xs bg-[#0D9488]/10 text-[#0D9488] border border-[#0D9488]/20 px-2 py-0.5 rounded hover:bg-[#0D9488]/20 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="e.g. Change the hero image to hotel_london.jpg and update the headline to focus on refinancing"
                    rows={2}
                    className="flex-1 bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#0D9488] resize-none"
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAiEdit(); }}
                  />
                  <button
                    type="button"
                    onClick={handleAiEdit}
                    disabled={aiLoading || !aiPrompt.trim()}
                    className="flex items-center gap-1.5 bg-[#0D9488] hover:bg-[#0B7A6D] disabled:opacity-50 text-white rounded px-4 py-2 text-sm transition-colors self-start"
                  >
                    {aiLoading ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                    {aiLoading ? 'Editing...' : 'Apply'}
                  </button>
                </div>
                {aiError && <p className="text-red-400 text-xs mt-1">{aiError}</p>}
                {aiLoading && <p className="text-[#0D9488] text-xs mt-1">Claude is updating your template — usually takes 5–10 seconds…</p>}
              </div>
            )}

            <div className="p-4 border-t border-[#1A2A3D] flex gap-3">
              <button
                type="button"
                onClick={handlePreview}
                disabled={!subject || !bodyHtml}
                className="flex items-center gap-2 border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5] rounded px-4 py-2 text-sm transition-colors disabled:opacity-40"
              >
                <Eye size={14} /> Preview
              </button>
              <div className="flex-1" />
              <button type="button" onClick={onClose} className="border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !name || !subject || !bodyHtml}
                className="bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm"
              >
                {loading ? 'Saving...' : template ? 'Update Template' : 'Create Template'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function Templates() {
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editTemplate, setEditTemplate] = useState<Template | undefined>();

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list().then((r) => r.data),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => templatesApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] }),
  });

  const handleEdit = (t: Template) => {
    setEditTemplate(t);
    setShowModal(true);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[#E0E8EE] text-2xl font-bold">Templates</h1>
          <p className="text-[#6B7E8F] text-sm mt-1">Email templates with merge fields</p>
        </div>
        <button
          onClick={() => { setEditTemplate(undefined); setShowModal(true); }}
          className="flex items-center gap-2 bg-[#1993C5] hover:bg-[#1578A2] text-white rounded-lg px-4 py-2.5 transition-colors"
        >
          <Plus size={16} /> New Template
        </button>
      </div>

      {isLoading ? (
        <div className="text-[#6B7E8F] text-center py-16">Loading templates...</div>
      ) : !templates || templates.length === 0 ? (
        <div className="text-center py-16">
          <Code size={40} className="mx-auto text-[#1A2A3D] mb-4" />
          <p className="text-[#6B7E8F]">No templates yet</p>
          <button onClick={() => setShowModal(true)} className="mt-4 text-[#1993C5] hover:text-[#74DFF6] text-sm">
            Create your first template
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t: Template) => (
            <div key={t.id} className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-4 hover:border-[#1993C5]/40 transition-colors">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-[#E0E8EE] font-medium truncate">{t.name}</h3>
                  <div className="text-[#6B7E8F] text-xs mt-0.5 truncate">{t.subject}</div>
                </div>
                <span className={`text-xs px-1.5 py-0.5 rounded ml-2 ${
                  t.is_active ? 'bg-green-900/20 text-green-400' : 'bg-[#1A2A3D] text-[#6B7E8F]'
                }`}>
                  {t.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>

              {t.merge_fields.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {t.merge_fields.slice(0, 4).map((f) => (
                    <span key={f} className="text-xs bg-[#1993C5]/10 text-[#74DFF6] px-1.5 py-0.5 rounded">
                      {`{{${f}}}`}
                    </span>
                  ))}
                  {t.merge_fields.length > 4 && (
                    <span className="text-xs text-[#6B7E8F]">+{t.merge_fields.length - 4} more</span>
                  )}
                </div>
              )}

              <div className="text-[#6B7E8F] text-xs line-clamp-2 mb-3">
                {t.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 100)}
              </div>

              <div className="flex gap-2 pt-3 border-t border-[#1A2A3D]">
                <button
                  onClick={() => handleEdit(t)}
                  className="flex items-center gap-1.5 text-xs text-[#6B7E8F] hover:text-[#B0BEC5] transition-colors"
                >
                  <Edit2 size={11} /> Edit
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id);
                  }}
                  className="flex items-center gap-1.5 text-xs text-[#6B7E8F] hover:text-red-400 transition-colors"
                >
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <TemplateModal
          template={editTemplate}
          onClose={() => { setShowModal(false); setEditTemplate(undefined); }}
        />
      )}
    </div>
  );
}
