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
   * Render a template string with merge data
   */
  render(template: string, data: MergeData): string {
    return template.replace(TemplateEngine.MERGE_FIELD_REGEX, (_match, field: string) => {
      const key = field.trim();
      if (key === 'unsubscribe_url') return _match;
      const value = data[key];
      if (value === undefined || value === null || value === '') {
        return '';
      }
      return value;
    });
  }

  /**
   * Render both subject and body for an email send
   */
  renderTemplate(
    template: Template,
    contact: Contact
  ): { subject: string; bodyHtml: string; bodyText: string } {
    const data = this.buildMergeData(contact);

    const subject = this.render(template.subject, data);
    const bodyHtml = this.render(template.body_html, data);
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
   * Simple HTML to plain text conversion
   */
  htmlToText(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li>/gi, '- ')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<h[1-6][^>]*>/gi, '\n')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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
    const bodyHtml = this.sanitizeHtml(this.render(template.body_html, data));
    const bodyText = template.body_text
      ? this.render(template.body_text, data)
      : this.htmlToText(bodyHtml);

    return { subject, bodyHtml, bodyText };
  }
}

export const templateEngine = new TemplateEngine();
