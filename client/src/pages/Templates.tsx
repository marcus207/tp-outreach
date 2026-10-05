import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Edit2, Trash2, Eye, X, Code, Loader2,
  Linkedin, Mail, Copy, Check, GripVertical,
  Download, Image,
  Users, ChevronDown, ChevronUp, Filter,
} from 'lucide-react';
import html2canvas from 'html2canvas';
import { templatesApi, Template } from '../lib/api';

// ─── Shared poster thumbnail ───────────────────────────────────────────────────

function PosterThumbnail({ html, onClick }: { html: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="relative overflow-hidden bg-[#080F18] block w-full text-left"
      style={{ height: '185px' }} title="Click to preview"
    >
      <div style={{
        position: 'absolute', top: 0, left: 0, width: '600px',
        transformOrigin: 'top left', transform: 'scale(0.6)', pointerEvents: 'none',
      }}>
        <iframe
          srcDoc={html}
          style={{ width: '600px', height: '310px', border: 'none', display: 'block' }}
          sandbox="allow-same-origin"
          tabIndex={-1}
          title=""
        />
      </div>
      <div className="absolute inset-0 bg-black/0 hover:bg-black/30 transition-colors flex items-center justify-center">
        <div className="opacity-0 hover:opacity-100 transition-opacity bg-black/70 text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5">
          <Eye size={12} /> Preview
        </div>
      </div>
    </button>
  );
}

// ─── Template preview modal ───────────────────────────────────────────────────

function TemplatePreviewModal({ template, onClose, openTab }: { template: Template; onClose: () => void; openTab?: 'email' | 'linkedin' | 'poster' }) {
  const [tab, setTab] = useState<'email' | 'linkedin' | 'poster'>(openTab ?? 'email');
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const posterRef = useRef<HTMLDivElement>(null);
  const sample: Record<string, string> = {
    first_name: 'James', last_name: 'Thornton', full_name: 'James Thornton',
    email: 'james@example.com', company: 'Thornton Hotels', title: 'MD', unsubscribe_url: '#',
  };
  const html    = template.body_html.replace(/\{\{(\w+)\}\}/g, (_, k) => sample[k] ?? `{{${k}}}`);
  const subject = template.subject.replace(  /\{\{(\w+)\}\}/g, (_, k) => sample[k] ?? `{{${k}}}`);

  const downloadPoster = useCallback(async () => {
    if (!posterRef.current) return;
    setDownloading(true);
    try {
      const iframe = posterRef.current.querySelector('iframe') as HTMLIFrameElement;
      if (!iframe?.contentDocument?.body) return;
      const canvas = await html2canvas(iframe.contentDocument.body, {
        width: 1200, height: 628, scale: 2, useCORS: true, backgroundColor: '#0A131E',
      });
      const link = document.createElement('a');
      link.download = `tp-outreach-${template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) { console.error('Poster download failed:', err); }
    finally { setDownloading(false); }
  }, [template]);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-start justify-center z-50 p-4 pt-6 overflow-y-auto">
      <div className="relative w-full max-w-[700px] bg-[#0A131E] rounded-xl overflow-hidden shadow-2xl mb-6 border border-[#1A2A3D]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1A2A3D]">
          <div>
            <div className="text-[#E0E8EE] font-semibold text-sm">{template.name}</div>
            <div className="text-[#6B7E8F] text-xs mt-0.5">Subject: {subject}</div>
          </div>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]"><X size={18} /></button>
        </div>

        <div className="flex border-b border-[#1A2A3D]">
          <button onClick={() => setTab('email')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === 'email' ? 'border-[#1993C5] text-[#74DFF6]' : 'border-transparent text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
            <Mail size={14} /> Email
          </button>
          {template.linkedin_content && (
            <button onClick={() => setTab('linkedin')}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === 'linkedin' ? 'border-[#0A66C2] text-[#0A66C2]' : 'border-transparent text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
              <Linkedin size={14} /> LinkedIn Post
            </button>
          )}
          {template.linkedin_poster_html && (
            <button onClick={() => setTab('poster')}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === 'poster' ? 'border-[#5DCAA5] text-[#5DCAA5]' : 'border-transparent text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
              <Image size={14} /> LinkedIn Poster
            </button>
          )}
        </div>

        {tab === 'email' && (
          <iframe srcDoc={html}
            style={{ width: '100%', border: 'none', height: '900px', display: 'block' }}
            sandbox="allow-same-origin" title={`Preview: ${template.name}`} />
        )}
        {tab === 'linkedin' && template.linkedin_content && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 text-[#0A66C2]">
                <Linkedin size={16} /> <span className="font-semibold text-sm">LinkedIn Post</span>
              </div>
              <button onClick={() => { navigator.clipboard.writeText(template.linkedin_content!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="flex items-center gap-1.5 text-xs bg-[#0A66C2] hover:bg-[#084f99] text-white px-3 py-1.5 rounded-md transition-colors">
                {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy Post</>}
              </button>
            </div>
            <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5">
              <pre className="text-sm text-[#B0BEC5] whitespace-pre-wrap font-sans leading-relaxed">{template.linkedin_content}</pre>
            </div>
            {template.linkedin_poster_html && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[#6B7E8F] text-xs flex items-center gap-1.5">
                    <Image size={12} className="text-[#5DCAA5]" /> Attach this poster to your LinkedIn post
                  </span>
                  <button onClick={() => setTab('poster')} className="text-xs text-[#5DCAA5] hover:text-[#5ec9b5]">
                    View full size &rarr;
                  </button>
                </div>
                <div className="border border-[#1A2A3D] rounded-lg overflow-hidden cursor-pointer" onClick={() => setTab('poster')}>
                  <iframe srcDoc={template.linkedin_poster_html}
                    style={{ width: '600px', height: '314px', border: 'none', display: 'block', pointerEvents: 'none' }}
                    sandbox="allow-same-origin" title="Poster preview" />
                </div>
              </div>
            )}
          </div>
        )}
        {tab === 'poster' && template.linkedin_poster_html && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[#6B7E8F] text-xs flex items-center gap-1.5">
                <Image size={12} className="text-[#5DCAA5]" /> 1200 x 628 · LinkedIn recommended size
              </span>
              <button onClick={downloadPoster} disabled={downloading}
                className="flex items-center gap-1.5 text-xs bg-[#5DCAA5] hover:bg-[#3da394] disabled:opacity-60 text-[#0f1a2e] font-semibold px-3 py-1.5 rounded-md transition-colors">
                {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {downloading ? 'Generating...' : 'Download PNG'}
              </button>
            </div>
            <div ref={posterRef} className="border border-[#1A2A3D] rounded-lg overflow-hidden">
              <iframe srcDoc={template.linkedin_poster_html}
                style={{ width: '600px', height: '314px', border: 'none', display: 'block' }}
                sandbox="allow-same-origin" title="LinkedIn Poster" />
            </div>
            <p className="text-[10px] text-[#3A4A5C] mt-2">Click "Download PNG" to save, then upload to LinkedIn with your post text.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Edit modal — visual + code editor ────────────────────────────────────────

const MERGE_FIELDS = ['{{first_name}}', '{{last_name}}', '{{full_name}}', '{{email}}', '{{company}}', '{{title}}', '{{city}}', '{{country}}'];

function EditModal({
  name: initName,
  subject: initSubject,
  bodyHtml: initHtml,
  linkedinContent: initLinkedin,
  posterHtml: initPoster,
  onClose,
  onSave,
}: {
  name: string;
  subject: string;
  bodyHtml: string;
  linkedinContent: string | null;
  posterHtml: string | null;
  onClose: () => void;
  onSave: (name: string, subject: string, html: string, linkedinContent?: string, posterHtml?: string) => Promise<void>;
}) {
  const [name,            setName]            = useState(initName);
  const [subject,         setSubject]         = useState(initSubject);
  const [bodyHtml,        setBodyHtml]        = useState(initHtml);
  const [linkedinContent, setLinkedinContent] = useState(initLinkedin || '');
  const [posterHtml,      setPosterHtml]      = useState(initPoster || '');
  const [saving,          setSaving]          = useState(false);
  const [editTab,         setEditTab]         = useState<'email' | 'linkedin' | 'poster'>('email');
  const [mode,            setMode]            = useState<'visual' | 'code'>('visual');
  const editorRef = useRef<HTMLIFrameElement>(null);

  const readVisualHtml = useCallback(() => {
    const doc = editorRef.current?.contentDocument;
    if (!doc?.documentElement) return null;
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }, []);

  const handleIframeLoad = useCallback(() => {
    const doc = editorRef.current?.contentDocument;
    if (doc) doc.designMode = 'on';
  }, []);

  const syncFromVisual = useCallback(() => {
    const html = readVisualHtml();
    if (html) setBodyHtml(html);
    return html;
  }, [readVisualHtml]);

  const switchToCode = () => {
    syncFromVisual();
    setMode('code');
  };

  const switchToVisual = () => {
    setMode('visual');
  };

  const handleSave = async () => {
    const html = mode === 'visual' ? (readVisualHtml() || bodyHtml) : bodyHtml;
    if (!name || !subject || !html) return;
    setSaving(true);
    try { await onSave(name, subject, html, linkedinContent || undefined, posterHtml || undefined); onClose(); }
    catch (err) { console.error(err); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-4xl flex flex-col" style={{ height: '92vh' }}>

        <div className="p-4 border-b border-[#1A2A3D] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-[#E0E8EE] font-semibold">Edit Template</h2>
            <div className="flex bg-[#0A131E] border border-[#1A2A3D] rounded-lg overflow-hidden">
              <button type="button" onClick={() => setEditTab('email')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${editTab === 'email' ? 'bg-[#1993C5] text-white' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
                <Mail size={12} /> Email
              </button>
              {initLinkedin != null && (
                <button type="button" onClick={() => setEditTab('linkedin')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${editTab === 'linkedin' ? 'bg-[#0A66C2] text-white' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
                  <Linkedin size={12} /> LinkedIn
                </button>
              )}
              {initPoster != null && (
                <button type="button" onClick={() => setEditTab('poster')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${editTab === 'poster' ? 'bg-[#5DCAA5] text-[#0A131E]' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
                  <Image size={12} /> Poster
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {editTab === 'email' && (
              <div className="flex bg-[#0A131E] border border-[#1A2A3D] rounded-lg overflow-hidden">
                <button type="button" onClick={mode === 'code' ? switchToVisual : undefined}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${mode === 'visual' ? 'bg-[#1993C5] text-white' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
                  Visual
                </button>
                <button type="button" onClick={mode === 'visual' ? switchToCode : undefined}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${mode === 'code' ? 'bg-[#1993C5] text-white' : 'text-[#6B7E8F] hover:text-[#B0BEC5]'}`}>
                  HTML
                </button>
              </div>
            )}
            <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]"><X size={18} /></button>
          </div>
        </div>

        <div className="p-4 border-b border-[#1A2A3D] shrink-0">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[#6B7E8F] text-xs mb-1">Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
            </div>
            <div>
              <label className="block text-[#6B7E8F] text-xs mb-1">Subject Line</label>
              <input type="text" value={subject} onChange={e => setSubject(e.target.value)}
                className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden relative">
          {editTab === 'poster' ? (
            <div className="h-full flex">
              <div className="w-1/2 flex flex-col border-r border-[#1A2A3D]">
                <div className="px-4 py-2 border-b border-[#1A2A3D] bg-[#0A131E] shrink-0 flex items-center gap-2">
                  <Code size={14} className="text-[#5DCAA5]" />
                  <span className="text-[#6B7E8F] text-xs">Poster HTML (1200 x 628)</span>
                </div>
                <div className="flex-1 overflow-hidden">
                  <textarea
                    value={posterHtml}
                    onChange={e => setPosterHtml(e.target.value)}
                    className="w-full h-full bg-[#0A131E] text-[#B0BEC5] px-4 py-3 text-xs focus:outline-none font-mono resize-none border-none leading-relaxed"
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="w-1/2 flex flex-col">
                <div className="px-4 py-2 border-b border-[#1A2A3D] bg-[#0A131E] shrink-0">
                  <span className="text-[#6B7E8F] text-xs">Live Preview</span>
                </div>
                <div className="flex-1 overflow-auto bg-[#080F18] flex items-start justify-center p-4">
                  <div style={{ width: '480px', transformOrigin: 'top center' }}>
                    <iframe
                      srcDoc={posterHtml}
                      style={{ width: '1200px', height: '628px', border: 'none', display: 'block', transform: 'scale(0.4)', transformOrigin: 'top left' }}
                      sandbox="allow-same-origin"
                      title="Poster preview"
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : editTab === 'linkedin' ? (
            <div className="h-full flex flex-col">
              <div className="px-4 py-2 border-b border-[#1A2A3D] bg-[#0A131E] shrink-0 flex items-center gap-2">
                <Linkedin size={14} className="text-[#0A66C2]" />
                <span className="text-[#6B7E8F] text-xs">Edit the LinkedIn post text below. This is plain text (no HTML).</span>
                <span className="ml-auto text-[#3A4A5C] text-[10px]">{linkedinContent.length} chars</span>
              </div>
              <div className="flex-1 overflow-hidden">
                <textarea
                  value={linkedinContent}
                  onChange={e => setLinkedinContent(e.target.value)}
                  className="w-full h-full bg-[#0A131E] text-[#B0BEC5] px-5 py-4 text-sm focus:outline-none resize-none border-none leading-relaxed"
                  placeholder="Write your LinkedIn post here..."
                  spellCheck
                />
              </div>
            </div>
          ) : mode === 'visual' ? (
            <div className="h-full flex flex-col">
              <div className="px-4 py-2 border-b border-[#1A2A3D] bg-[#0A131E] shrink-0">
                <span className="text-[#6B7E8F] text-xs">Click any text in the email below to edit it directly</span>
              </div>
              <div className="flex-1 overflow-auto bg-white">
                <iframe
                  ref={editorRef}
                  srcDoc={bodyHtml}
                  onLoad={handleIframeLoad}
                  style={{ width: '100%', height: '100%', border: 'none', display: 'block', minHeight: '600px' }}
                  title="Visual editor"
                />
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col">
              <div className="px-4 py-2 border-b border-[#1A2A3D] bg-[#0A131E] shrink-0 flex items-center justify-between">
                <span className="text-[#6B7E8F] text-xs">HTML source</span>
                <div className="flex flex-wrap gap-1">
                  {MERGE_FIELDS.map(f => (
                    <button key={f} type="button" onClick={() => setBodyHtml(p => p + f)}
                      className="text-[10px] bg-[#1993C5]/15 text-[#74DFF6] px-1.5 py-0.5 rounded hover:bg-[#1993C5]/30 transition-colors">{f}</button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-hidden">
                <textarea value={bodyHtml} onChange={e => setBodyHtml(e.target.value)}
                  className="w-full h-full bg-[#0A131E] text-[#B0BEC5] px-4 py-3 text-sm focus:outline-none font-mono resize-none border-none"
                  spellCheck={false} />
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-[#1A2A3D] flex gap-3 shrink-0">
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm">Cancel</button>
          <button type="button" onClick={handleSave} disabled={saving || !name || !subject}
            className="bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── New template modal ────────────────────────────────────────────────────────

function NewTemplateModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name,     setName]     = useState('');
  const [subject,  setSubject]  = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [saving,   setSaving]   = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !subject || !bodyHtml) return;
    setSaving(true);
    try {
      await templatesApi.create({ name, subject, body_html: bodyHtml });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    } catch (err) { console.error(err); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-3xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-[#1A2A3D] flex items-center justify-between">
          <h2 className="text-[#E0E8EE] font-semibold">New Template</h2>
          <button onClick={onClose} className="text-[#6B7E8F] hover:text-[#B0BEC5]"><X size={18} /></button>
        </div>
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[#6B7E8F] text-sm mb-1">Template Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Initial Outreach"
                  className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
              </div>
              <div>
                <label className="block text-[#6B7E8F] text-sm mb-1">Subject Line</label>
                <input type="text" value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Quick question, {{first_name}}"
                  className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5]" />
              </div>
            </div>
            <div>
              <label className="block text-[#6B7E8F] text-sm mb-1">HTML Body</label>
              <textarea value={bodyHtml} onChange={e => setBodyHtml(e.target.value)}
                placeholder="<p>Hi {{first_name}},</p>..." rows={14}
                className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1993C5] font-mono resize-none" />
            </div>
          </div>
          <div className="p-4 border-t border-[#1A2A3D] flex gap-3">
            <div className="flex-1" />
            <button type="button" onClick={onClose} className="border border-[#1A2A3D] text-[#B0BEC5] rounded px-4 py-2 text-sm">Cancel</button>
            <button type="submit" disabled={saving || !name || !subject || !bodyHtml}
              className="bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 text-sm">
              {saving ? 'Creating...' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Subsector mapping for contact counts ─────────────────────────────────────

const SEQUENCE_TO_SUBSECTOR: Record<string, { contactType: string; subsector: string }> = {
  'Introducers \u2014 Accountant': { contactType: 'introducer', subsector: 'accountant' },
  'Introducers \u2014 Advisory': { contactType: 'introducer', subsector: 'advisory' },
  'Introducers \u2014 Agent': { contactType: 'introducer', subsector: 'agent' },
  'Introducers \u2014 Construction': { contactType: 'introducer', subsector: 'construction' },
  'Introducers \u2014 Lawyer': { contactType: 'introducer', subsector: 'lawyer' },
  'Introducers \u2014 Planning / Architect': { contactType: 'introducer', subsector: 'planning_architect' },
  'Introducers \u2014 Surveyor': { contactType: 'introducer', subsector: 'surveyor' },
  'Introducers \u2014 Wealth': { contactType: 'introducer', subsector: 'wealth' },
  'Clients \u2014 BTR': { contactType: 'developer', subsector: 'btr' },
  'Clients \u2014 Care': { contactType: 'developer', subsector: 'care' },
  'Clients \u2014 Hospitality': { contactType: 'developer', subsector: 'hospitality' },
  'Clients \u2014 Leisure': { contactType: 'developer', subsector: 'leisure' },
  'Clients \u2014 Living': { contactType: 'developer', subsector: 'living' },
  'Clients \u2014 Logistics': { contactType: 'developer', subsector: 'logistics' },
  'Clients \u2014 Offices': { contactType: 'developer', subsector: 'office' },
  'Clients \u2014 PBSA': { contactType: 'developer', subsector: 'pbsa' },
  'Clients \u2014 Retail': { contactType: 'developer', subsector: 'retail' },
  'Clients \u2014 SFH': { contactType: 'developer', subsector: 'sfh' },
};

// ─── Sequence group component ─────────────────────────────────────────────────

interface SequenceGroup {
  sequenceId: string;
  sequenceName: string;
  templates: Template[];
}

function SequenceGroupCard({
  group,
  contactCount,
  stepStats,
  onPreview,
  onEdit,
  onDelete,
  renderHtml,
}: {
  group: SequenceGroup;
  contactCount: number;
  stepStats: Record<string, { awaiting: number; sent: number; opened: number; clicked: number; replied: number }>;
  onPreview: (t: Template, tab?: 'email' | 'linkedin' | 'poster') => void;
  onEdit: (t: Template) => void;
  onDelete: (t: Template) => void;
  renderHtml: (html: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const specialism = group.sequenceName.replace(/^(Clients|Introducers)\s*\u2014\s*/, '');

  return (
    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#0A131E]/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${group.sequenceName.startsWith('Clients') ? 'bg-[#1993C5]' : 'bg-[#5DCAA5]'}`} />
          <div className="text-left">
            <h3 className="text-[#E0E8EE] font-semibold text-sm">{specialism}</h3>
            <p className="text-[#6B7E8F] text-xs mt-0.5">
              {group.templates.length} steps
              {contactCount > 0 && <span className="text-amber-400 ml-2">{contactCount.toLocaleString()} contacts</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex -space-x-1">
            {group.templates.slice(0, 4).map((t, i) => (
              <div key={t.id} className="w-6 h-6 rounded bg-[#1A2A3D] border border-[#0D1B2A] flex items-center justify-center" style={{ zIndex: 4 - i }}>
                <span className="text-[9px] text-[#6B7E8F] font-medium">{i + 1}</span>
              </div>
            ))}
            {group.templates.length > 4 && (
              <div className="w-6 h-6 rounded bg-[#1A2A3D] border border-[#0D1B2A] flex items-center justify-center">
                <span className="text-[9px] text-[#6B7E8F]">+{group.templates.length - 4}</span>
              </div>
            )}
          </div>
          {expanded ? <ChevronUp size={16} className="text-[#6B7E8F]" /> : <ChevronDown size={16} className="text-[#6B7E8F]" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[#1A2A3D] px-5 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            {group.templates.sort((a, b) => (a.step_number ?? 99) - (b.step_number ?? 99)).map((t, index) => (
              <div key={t.id} className="bg-[#0A131E] border border-[#1A2A3D] rounded-lg overflow-hidden hover:border-[#1993C5]/40 transition-colors">
                <PosterThumbnail html={renderHtml(t.body_html)} onClick={() => onPreview(t)} />
                <div className="p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`text-xs font-semibold ${group.sequenceName.startsWith('Clients') ? 'text-[#1993C5]' : 'text-[#5DCAA5]'}`}>
                      Step {t.step_number ?? (index + 1)}
                    </span>
                    {t.delay_days != null && t.delay_days > 0 && (
                      <span className="text-[#3A4A5C] text-[10px] ml-auto">{t.delay_days}d gap</span>
                    )}
                  </div>
                  <h4 className="text-[#E0E8EE] font-medium text-xs truncate leading-tight">
                    {t.name.replace(/^(Clients|Introducers)\s*\u2014\s*\S+\s*\u2014\s*/, '')}
                  </h4>
                  <div className="text-[#6B7E8F] text-[10px] mt-0.5 truncate">{t.subject}</div>

                  {(() => {
                    const s = stepStats[t.id];
                    if (!s || (s.awaiting === 0 && s.sent === 0)) return null;
                    const openRate = s.sent > 0 ? Math.round((s.opened / s.sent) * 100) : 0;
                    return (
                      <div className="mt-2 space-y-1">
                        {s.awaiting > 0 && (
                          <div className="bg-amber-400/10 border border-amber-400/20 rounded px-2 py-1 text-center">
                            <span className="text-amber-400 text-[10px] font-semibold">{s.awaiting.toLocaleString()} contacts due</span>
                          </div>
                        )}
                        {s.sent > 0 && (
                          <div className="flex items-center justify-between text-[10px] px-1">
                            <span className="text-[#B0BEC5]">{s.sent.toLocaleString()} sent</span>
                            <span className="text-[#1993C5]">{openRate}% opened</span>
                            {s.replied > 0 && <span className="text-green-400">{s.replied} replied</span>}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="flex items-center gap-2 pt-2 mt-2 border-t border-[#1A2A3D]">
                    <button onClick={() => onPreview(t)}
                      className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-[#74DFF6] transition-colors">
                      <Eye size={9} /> Preview
                    </button>
                    <button onClick={() => onEdit(t)}
                      className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-[#B0BEC5] transition-colors">
                      <Edit2 size={9} /> Edit
                    </button>
                    <button onClick={() => onDelete(t)}
                      className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-red-400 transition-colors">
                      <Trash2 size={9} />
                    </button>
                    {t.linkedin_content && (
                      <button onClick={() => onPreview(t, 'linkedin')}
                        className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-[#0A66C2] transition-colors ml-auto">
                        <Linkedin size={9} />
                      </button>
                    )}
                    {t.linkedin_poster_html && (
                      <button onClick={() => onPreview(t, 'poster')}
                        className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-[#5DCAA5] transition-colors">
                        <Image size={9} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type CategoryFilter = 'all' | 'clients' | 'introducers' | 'other';

export default function Templates() {
  const queryClient = useQueryClient();

  const [showNew,          setShowNew]          = useState(false);
  const [editingTemplate,  setEditingTemplate]  = useState<Template | undefined>();
  const [previewTemplate,  setPreviewTemplate]  = useState<{ template: Template; openTab?: 'email' | 'linkedin' | 'poster' } | undefined>();
  const [categoryFilter,   setCategoryFilter]   = useState<CategoryFilter>('all');

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list().then(r => r.data as unknown as Template[]),
  });

  const subsectorCounts: Record<string, number> = {};
  const stepStats: Record<string, { awaiting: number; sent: number; opened: number; clicked: number; replied: number }> = {};

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => templatesApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] }),
  });

  const handleSaveTemplate = async (id: string, name: string, subject: string, html: string, linkedinContent?: string, posterHtml?: string) => {
    const data: Record<string, unknown> = { name, subject, body_html: html };
    if (linkedinContent !== undefined) data.linkedin_content = linkedinContent;
    if (posterHtml !== undefined) data.linkedin_poster_html = posterHtml;
    await templatesApi.update(id, data as any);
    queryClient.invalidateQueries({ queryKey: ['templates'] });
  };

  const renderHtml = (html: string) => {
    const s: Record<string, string> = { first_name: 'James', last_name: 'Thornton', full_name: 'James Thornton', email: 'james@example.com', company: 'Thornton Hotels', title: 'MD', unsubscribe_url: '#' };
    return html.replace(/\{\{(\w+)\}\}/g, (_, k) => s[k] ?? `{{${k}}}`);
  };

  const { sequenceGroups, unassigned, stats } = useMemo(() => {
    const groupMap = new Map<string, SequenceGroup>();
    const unassigned: Template[] = [];

    for (const t of templates) {
      if (t.sequence_id && t.sequence_name) {
        let group = groupMap.get(t.sequence_id);
        if (!group) {
          group = { sequenceId: t.sequence_id, sequenceName: t.sequence_name, templates: [] };
          groupMap.set(t.sequence_id, group);
        }
        group.templates.push(t);
      } else {
        unassigned.push(t);
      }
    }

    const allGroups = Array.from(groupMap.values()).sort((a, b) => a.sequenceName.localeCompare(b.sequenceName));
    const clientGroups = allGroups.filter(g => g.sequenceName.startsWith('Clients'));
    const introducerGroups = allGroups.filter(g => g.sequenceName.startsWith('Introducers'));
    const otherGroups = allGroups.filter(g => !g.sequenceName.startsWith('Clients') && !g.sequenceName.startsWith('Introducers'));

    const clientContacts = clientGroups.reduce((sum, g) => {
      const mapping = SEQUENCE_TO_SUBSECTOR[g.sequenceName];
      return sum + (mapping ? (subsectorCounts[`${mapping.contactType}:${mapping.subsector}`] || 0) : 0);
    }, 0);
    const introducerContacts = introducerGroups.reduce((sum, g) => {
      const mapping = SEQUENCE_TO_SUBSECTOR[g.sequenceName];
      return sum + (mapping ? (subsectorCounts[`${mapping.contactType}:${mapping.subsector}`] || 0) : 0);
    }, 0);

    return {
      sequenceGroups: { clients: clientGroups, introducers: introducerGroups, other: otherGroups },
      unassigned,
      stats: { clientContacts, introducerContacts, totalTemplates: templates.length },
    };
  }, [templates, subsectorCounts]);

  const filteredGroups = useMemo(() => {
    switch (categoryFilter) {
      case 'clients': return sequenceGroups.clients;
      case 'introducers': return sequenceGroups.introducers;
      case 'other': return [...sequenceGroups.other];
      default: return [...sequenceGroups.clients, ...sequenceGroups.introducers, ...sequenceGroups.other];
    }
  }, [categoryFilter, sequenceGroups]);

  const getContactCount = (group: SequenceGroup) => {
    const mapping = SEQUENCE_TO_SUBSECTOR[group.sequenceName];
    if (!mapping) return 0;
    return subsectorCounts[`${mapping.contactType}:${mapping.subsector}`] || 0;
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[#E0E8EE] text-2xl font-bold">Templates</h1>
          <p className="text-[#6B7E8F] text-sm mt-1">
            {stats.totalTemplates} templates across {sequenceGroups.clients.length + sequenceGroups.introducers.length + sequenceGroups.other.length} sequences
            {unassigned.length > 0 && <span className="ml-1">&middot; {unassigned.length} unassigned</span>}
          </p>
        </div>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 bg-[#1993C5] hover:bg-[#1578A2] text-white rounded-lg px-4 py-2.5 transition-colors text-sm">
          <Plus size={16} /> New Template
        </button>
      </div>

      {/* Category filter tabs */}
      <div className="flex items-center gap-2 mb-6">
        <Filter size={14} className="text-[#6B7E8F]" />
        {([
          { key: 'all' as CategoryFilter, label: 'All Sequences', count: sequenceGroups.clients.length + sequenceGroups.introducers.length + sequenceGroups.other.length },
          { key: 'clients' as CategoryFilter, label: 'Clients', count: sequenceGroups.clients.length, contacts: stats.clientContacts },
          { key: 'introducers' as CategoryFilter, label: 'Introducers', count: sequenceGroups.introducers.length, contacts: stats.introducerContacts },
          { key: 'other' as CategoryFilter, label: 'Other', count: sequenceGroups.other.length },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setCategoryFilter(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              categoryFilter === tab.key
                ? 'bg-[#1993C5] text-white'
                : 'bg-[#0D1B2A] border border-[#1A2A3D] text-[#6B7E8F] hover:text-[#B0BEC5] hover:border-[#1993C5]/30'
            }`}
          >
            {tab.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              categoryFilter === tab.key ? 'bg-white/20' : 'bg-[#1A2A3D]'
            }`}>
              {tab.count}
            </span>
            {'contacts' in tab && tab.contacts! > 0 && (
              <span className={`text-xs ${categoryFilter === tab.key ? 'text-amber-300' : 'text-amber-400/70'}`}>
                {tab.contacts!.toLocaleString()} contacts
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-[#6B7E8F] text-center py-16">Loading&hellip;</div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16">
          <Code size={40} className="mx-auto text-[#1A2A3D] mb-4" />
          <p className="text-[#6B7E8F]">No templates yet</p>
          <button onClick={() => setShowNew(true)} className="mt-4 text-[#1993C5] hover:text-[#74DFF6] text-sm">Create your first template</button>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredGroups.map(group => (
            <SequenceGroupCard
              key={group.sequenceId}
              group={group}
              contactCount={getContactCount(group)}
              stepStats={stepStats}
              onPreview={(t, tab) => setPreviewTemplate({ template: t, openTab: tab })}
              onEdit={(t) => setEditingTemplate(t)}
              onDelete={(t) => { if (confirm(`Delete "${t.name}"?`)) deleteTemplateMutation.mutate(t.id); }}
              renderHtml={renderHtml}
            />
          ))}

          {/* Unassigned templates */}
          {(categoryFilter === 'all' || categoryFilter === 'other') && unassigned.length > 0 && (
            <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-[#1A2A3D]">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-[#6B7E8F]" />
                  <div>
                    <h3 className="text-[#E0E8EE] font-semibold text-sm">Unassigned Templates</h3>
                    <p className="text-[#6B7E8F] text-xs mt-0.5">{unassigned.length} templates not linked to any sequence</p>
                  </div>
                </div>
              </div>
              <div className="px-5 py-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {unassigned.map(t => (
                    <div key={t.id} className="bg-[#0A131E] border border-[#1A2A3D] rounded-lg overflow-hidden hover:border-[#6B7E8F]/40 transition-colors">
                      <PosterThumbnail html={renderHtml(t.body_html)} onClick={() => setPreviewTemplate({ template: t })} />
                      <div className="p-3">
                        <h4 className="text-[#E0E8EE] font-medium text-xs truncate leading-tight">{t.name}</h4>
                        <div className="text-[#6B7E8F] text-[10px] mt-0.5 truncate">{t.subject}</div>
                        <div className="flex items-center gap-2 pt-2 mt-2 border-t border-[#1A2A3D]">
                          <button onClick={() => setPreviewTemplate({ template: t })}
                            className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-[#74DFF6] transition-colors">
                            <Eye size={9} /> Preview
                          </button>
                          <button onClick={() => setEditingTemplate(t)}
                            className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-[#B0BEC5] transition-colors">
                            <Edit2 size={9} /> Edit
                          </button>
                          <button onClick={() => { if (confirm(`Delete "${t.name}"?`)) deleteTemplateMutation.mutate(t.id); }}
                            className="flex items-center gap-1 text-[10px] text-[#6B7E8F] hover:text-red-400 transition-colors">
                            <Trash2 size={9} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}
      {showNew && <NewTemplateModal onClose={() => setShowNew(false)} />}

      {editingTemplate && (
        <EditModal
          name={editingTemplate.name}
          subject={editingTemplate.subject}
          bodyHtml={editingTemplate.body_html}
          linkedinContent={editingTemplate.linkedin_content}
          posterHtml={editingTemplate.linkedin_poster_html}
          onClose={() => setEditingTemplate(undefined)}
          onSave={(name, subject, html, linkedinContent, posterHtml) => handleSaveTemplate(editingTemplate.id, name, subject, html, linkedinContent, posterHtml)}
        />
      )}

      {previewTemplate && (
        <TemplatePreviewModal
          template={previewTemplate.template}
          openTab={previewTemplate.openTab}
          onClose={() => setPreviewTemplate(undefined)}
        />
      )}

    </div>
  );
}
