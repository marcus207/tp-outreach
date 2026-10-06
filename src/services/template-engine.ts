import sanitizeHtml from 'sanitize-html';
import { Contact, Template } from '../types';

interface MergeData {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  company?: string;
  title?: string;
  city?: string;
  country?: string;
  [key: string]: string | undefined;
}

export class TemplateEngine {
  private static readonly MERGE_FIELD_REGEX = /\{\{([^}]+)\}\}/g;

  /**
   * Extract all merge field names from a template string
   */
  extractMergeFields(content: string): string[] {
    const fields = new Set<string>();
    let match;
    const regex = new RegExp(TemplateEngine.MERGE_FIELD_REGEX.source, 'g');
    while ((match = regex.exec(content)) !== null) {
      fields.add(match[1].trim());
    }
    return Array.from(fields);
  }

  /**
   * Build merge data object from a Contact
   */
  buildMergeData(contact: Contact): MergeData {
    const firstName = contact.first_name || '';
    const lastName = contact.last_name || '';

    return {
      first_name: firstName,
      last_name: lastName,
      full_name: [firstName, lastName].filter(Boolean).join(' ') || contact.email,
      email: contact.email,
      company: contact.company || '',
      title: contact.title || '',
      city: contact.city || '',
      country: contact.country || '',
      ...Object.fromEntries(
        Object.entries(contact.custom_fields || {}).map(([k, v]) => [k, String(v)])
      ),
    };
  }

  /**
   * Render a template string with merge data.
   *
   * - `{{field}}` resolves from data; anything unknown/empty renders as ''.
   * - `{{field|default}}` renders `default` when the field is empty/missing.
   * - `{{unsubscribe_url}}` is left in place for gmail-client to resolve.
   * - `opts.html`: values (and defaults) are HTML-escaped, because contact
   *   fields are untrusted input. Subjects and text/plain stay unescaped.
   * - Empty greetings left by a missing name ("Hi ," / "Dear ,") become
   *   "Hi there,".
   */
  render(template: string, data: MergeData, opts: { html?: boolean } = {}): string {
    const rendered = (template || '').replace(TemplateEngine.MERGE_FIELD_REGEX, (match, inner: string) => {
      const pipe = inner.indexOf('|');
      const key = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      const fallback = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
      if (key === 'unsubscribe_url') return match;
      const raw = data[key];
      const value = raw === undefined || raw === null || String(raw).trim() === '' ? fallback : String(raw);
      return opts.html ? escapeHtml(value) : value;
    });
    return fixEmptyGreetings(rendered);
  }

  /**
   * Render both subject and body for an email send
   */
  renderTemplate(
    template: Template,
    contact: Contact
  ): { subject: string; bodyHtml: string; bodyText: string } {
    const data = this.buildMergeData(contact);

    const subject = this.render(template.subject, data).replace(/\s+/g, ' ').trim();
    const bodyHtml = this.render(template.body_html, data, { html: true });
    const bodyText = template.body_text
      ? this.render(template.body_text, data)
      : this.htmlToText(bodyHtml);

    return { subject, bodyHtml, bodyText };
  }

  /**
   * Sanitize HTML body to prevent XSS when previewing
   */
  sanitizeHtml(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        img: ['src', 'alt', 'width', 'height', 'style'],
        '*': ['style', 'class'],
        a: ['href', 'name', 'target', 'rel'],
      },
    });
  }

  /**
   * HTML to plain text for the text/plain part. Links keep their target as
   * "text (https://...)". Never emits anything tag-shaped, including markup
   * that was HTML-escaped in the source (e.g. a hostile contact name).
   */
  htmlToText(html: string): string {
    return htmlToPlainText(html);
  }

  /**
   * Validate that a template has all required merge fields populated
   */
  validateMergeFields(template: Template, contact: Contact): string[] {
    const data = this.buildMergeData(contact);
    const missing: string[] = [];

    for (const field of template.merge_fields) {
      if (!data[field] || data[field] === '') {
        missing.push(field);
      }
    }

    return missing;
  }

  /**
   * Preview a template with sample data or actual contact data
   */
  previewTemplate(
    template: Template,
    contact?: Contact
  ): { subject: string; bodyHtml: string; bodyText: string } {
    const sampleData: MergeData = {
      first_name: 'John',
      last_name: 'Smith',
      full_name: 'John Smith',
      email: 'john.smith@example.com',
      company: 'Acme Corp',
      title: 'CFO',
      city: 'New York',
      country: 'USA',
    };

    const data = contact ? this.buildMergeData(contact) : sampleData;

    const subject = this.render(template.subject, data);
    const bodyHtml = this.sanitizeHtml(this.render(template.body_html, data, { html: true }));
    const bodyText = template.body_text
      ? this.render(template.body_text, data)
      : this.htmlToText(bodyHtml);

    return { subject, bodyHtml, bodyText };
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "Hi ," / "Hey," / "Dear  ," (name merged as empty) -> "Hi there,". */
export function fixEmptyGreetings(text: string): string {
  return text.replace(/\b(Hi|Hey|Hello|Dear)(?:\s|&nbsp;)*,/g, '$1 there,');
}

const TAG_LIKE = /<\/?[a-z!][^>]*>/gi;

export function htmlToPlainText(html: string): string {
  const linkText = (_m: string, href: string, inner: string): string => {
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const target = href.trim();
    if (!target || target.startsWith('#')) return text;
    const bare = target.replace(/^mailto:/i, '');
    if (!text || text === target || text === bare || text.replace(/\/$/, '') === target.replace(/\/$/, '')) return target.startsWith('mailto:') ? bare : target;
    return `${text} (${bare})`;
  };
  const out = (html || '')
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<a\s[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, linkText)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<\/(div|tr|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<img[^>]*alt\s*=\s*["']([^"']+)["'][^>]*>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&middot;/gi, '·')
    .replace(/&pound;/gi, '£')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(TAG_LIKE, '');
  return out
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const templateEngine = new TemplateEngine();
