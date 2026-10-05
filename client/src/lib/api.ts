import axios from 'axios';

const api = axios.create({
  baseURL: '/outreach/api',  // served at tp.finance/outreach/
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ---- Types ----
export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  sending_account_ids: string[];
  send_window_start: string;
  send_window_end: string;
  skip_weekends: boolean;
  daily_send_limit: number | null;
  stop_on_reply: boolean;
  stop_on_open: boolean;
  created_at: string;
  active_enrollments?: number;
  total_enrollments?: number;
  total_sent?: number;
  total_opens?: number;
  total_clicks?: number;
  total_replies?: number;
  subsector_contacts?: number;
}

export interface CampaignStep {
  id: string;
  sequence_id: string;
  step_number: number;
  template_id: string | null;
  delay_days: number;
  delay_hours: number;
  step_type: string;
  variant_template_id: string | null;
  variant_split: number | null;
  template_name?: string;
  template_subject?: string;
  variant_template_name?: string;
}

export interface Contact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company: string | null;
  company_domain: string | null;
  linkedin_url: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  email_verified: boolean;
  tags: string[];
  source: string;
  contact_type: string | null;
  subsector: string | null;
  created_at: string;
  active_sequences?: number;
}

export interface SubsectorCount {
  key: string;
  label: string;
  count: number;
}

export interface ContactBreakdown {
  total: number;
  introducers: { total: number; subsectors: SubsectorCount[]; unsectored: number };
  clients: { total: number; subsectors: SubsectorCount[]; unsectored: number };
  lenders: { total: number };
  unclassified: { total: number };
}

export interface ContactSuggestion {
  category: 'introducer' | 'client';
  subsector: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  merge_fields: string[];
  is_active: boolean;
  position: number | null;
  step_number: number | null;
  delay_days: number | null;
  sequence_id: string | null;
  sequence_name: string | null;
  linkedin_content: string | null;
  linkedin_poster_html: string | null;
  created_at: string;
}

export interface EmailAccount {
  id: string;
  email: string;
  display_name: string | null;
  daily_limit: number;
  hourly_limit: number;
  sends_today: number;
  sends_this_hour: number;
  last_send_at: string | null;
  is_active: boolean;
}

export interface AnalyticsOverview {
  total_sent: number;
  total_failed: number;
  total_queued: number;
  open_rate: number;
  click_rate: number;
  reply_rate: number;
  unique_opens: number;
  unique_clicks: number;
  total_replies: number;
  active_enrollments: number;
  completed_enrollments: number;
  replied_enrollments: number;
}

export interface DailyStats {
  date: string;
  sent: number;
  unique_contacts: number;
}

export interface DripifyData {
  snapshot: {
    id: string;
    search_credits: number | null;
    daily_invites_used: number | null;
    daily_invites_limit: number | null;
    daily_messages_used: number | null;
    daily_messages_limit: number | null;
    campaigns: Array<{
      id: string;
      name: string;
      status: string;
    }> | null;
    scraped_at: string;
  } | null;
  alerts: Array<{
    id: string;
    alert_type: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    is_read: boolean;
    created_at: string;
  }>;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ---- Auth ----
export const authApi = {
  login: (email: string, password: string) => api.post<{ success: boolean; email: string }>('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get<{ authenticated: boolean }>('/auth/me'),
};

// ---- Campaigns ----
export const campaignsApi = {
  list: () => api.get<Campaign[]>('/campaigns'),
  create: (data: Partial<Campaign>) => api.post<Campaign>('/campaigns', data),
  get: (id: string) => api.get<Campaign & { steps: CampaignStep[]; enrollment_stats: Array<{ status: string; count: string }> }>(`/campaigns/${id}`),
  update: (id: string, data: Partial<Campaign>) => api.put<Campaign>(`/campaigns/${id}`, data),
  delete: (id: string) => api.delete(`/campaigns/${id}`),
  addStep: (id: string, data: Partial<CampaignStep>) => api.post<CampaignStep>(`/campaigns/${id}/steps`, data),
  updateStep: (id: string, stepId: string, data: Partial<CampaignStep>) => api.put<CampaignStep>(`/campaigns/${id}/steps/${stepId}`, data),
  deleteStep: (id: string, stepId: string) => api.delete(`/campaigns/${id}/steps/${stepId}`),
  enroll: (id: string, contactIds: string[]) => api.post(`/campaigns/${id}/enroll`, { contact_ids: contactIds }),
  setStatus: (id: string, status: string) => api.put(`/campaigns/${id}/status`, { status }),
  getEnrollments: (id: string, page = 1) => api.get(`/campaigns/${id}/enrollments?page=${page}`),
};

// ---- Contacts ----
export const contactsApi = {
  list: (params?: { page?: number; limit?: number; search?: string; tag?: string; company?: string; source?: string; category?: string; subsector?: string; sort?: string; dir?: string }) =>
    api.get<PaginatedResponse<Contact>>('/contacts', { params }),
  create: (data: Partial<Contact>) => api.post<Contact>('/contacts', data),
  get: (id: string) => api.get<Contact>(`/contacts/${id}`),
  update: (id: string, data: Partial<Contact>) => api.put<Contact>(`/contacts/${id}`, data),
  delete: (id: string) => api.delete(`/contacts/${id}`),
  importCsv: (csv: string, source?: string) => api.post('/contacts/import', { csv, source }),
  getTags: () => api.get<string[]>('/contacts/tags'),
  addTags: (id: string, tags: string[]) => api.post(`/contacts/${id}/tags`, { tags }),
  lookupName: (id: string) => api.post<{ found: boolean; first_name?: string; last_name?: string; message?: string }>(`/contacts/${id}/lookup-name`),
  bulkLookupNames: () => api.post<{ processed: number; updated: number; message?: string }>('/contacts/bulk-lookup-names'),
  getLists: () => api.get('/contacts/lists'),
  createList: (data: { name: string; description?: string }) => api.post('/contacts/lists', data),
  addToList: (listId: string, contactIds: string[]) => api.post(`/contacts/lists/${listId}/members`, { contact_ids: contactIds }),
  breakdown: () => api.get<ContactBreakdown>('/contacts/breakdown'),
  suggest: (contactIds: string[]) => api.post<Record<string, ContactSuggestion | null>>('/contacts/suggest', { contact_ids: contactIds }),
  bulkAssign: (contactIds: string[], contactType: string, subsector?: string) =>
    api.post<{ updated: number }>('/contacts/bulk-assign', { contact_ids: contactIds, contact_type: contactType, subsector }),
};

// ---- Templates ----
export const templatesApi = {
  list: () => api.get<{ templates: Template[]; subsectorCounts: Record<string, number>; stepStats: Record<string, { awaiting: number; sent: number; opened: number; clicked: number; replied: number }> }>('/templates'),
  create: (data: Partial<Template>) => api.post<Template>('/templates', data),
  get: (id: string) => api.get<Template>(`/templates/${id}`),
  update: (id: string, data: Partial<Template>) => api.put<Template>(`/templates/${id}`, data),
  delete: (id: string) => api.delete(`/templates/${id}`),
  preview: (id: string, contactId?: string) => api.post<{ subject: string; bodyHtml: string; bodyText: string }>(`/templates/${id}/preview`, { contact_id: contactId }),
  aiEdit: (id: string, prompt: string) => api.post<{ body_html: string }>(`/templates/${id}/ai-edit`, { prompt }),
  reorder: (ids: string[]) => api.put('/templates/reorder', { ids }),
};

// ---- Analytics ----
export const analyticsApi = {
  overview: (days?: number) => api.get<AnalyticsOverview>(`/analytics/overview${days ? `?days=${days}` : ''}`),
  daily: (days?: number) => api.get<DailyStats[]>(`/analytics/daily${days ? `?days=${days}` : ''}`),
  accounts: (days?: number) => api.get<EmailAccount[]>(`/analytics/accounts${days ? `?days=${days}` : ''}`),
  campaigns: (days?: number) => api.get(`/analytics/campaigns${days ? `?days=${days}` : ''}`),
  broadcasts: () => api.get('/analytics/broadcasts'),
  staleContacts: () => api.get('/analytics/stale-contacts'),
  deliverability: () => api.get('/analytics/deliverability'),
  runDeliverabilityCheck: () => api.post('/analytics/deliverability/run'),
  dmarc: (days?: number) => api.get(`/analytics/dmarc${days ? `?days=${days}` : ''}`),
  dmarcScan: () => api.post('/analytics/dmarc/scan'),
  failedEmails: (days?: number) => api.get(`/analytics/failed-emails${days ? `?days=${days}` : ''}`),
  recent: () => api.get('/analytics/recent'),
};

// ---- Dripify ----
export const dripifyApi = {
  latest: () => api.get<DripifyData>('/dripify/latest'),
  markAlertRead: (id: string) => api.put(`/dripify/alerts/${id}/read`),
  markAllRead: () => api.put('/dripify/alerts/read-all'),
};

// ---- Settings ----
export const settingsApi = {
  get: () => api.get<Record<string, unknown>>('/settings'),
  update: (data: Record<string, unknown>) => api.put<Record<string, unknown>>('/settings', data),
  getEmailAccounts: () => api.get<EmailAccount[]>('/settings/email-accounts'),
  updateEmailAccount: (id: string, data: Partial<EmailAccount>) => api.put<EmailAccount>(`/settings/email-accounts/${id}`, data),
  disconnectEmailAccount: (id: string) => api.delete(`/settings/email-accounts/${id}`),
};

// ---- Apollo ----
export const apolloApi = {
  sync: (type: 'full' | 'incremental' = 'incremental') => api.post('/apollo/sync', { type }),
  logs: () => api.get('/apollo/logs'),
};

// ---- Campaign Planner ----
export interface CampaignPlannerSettings {
  frequency_days: number;
  start_date: string;
  is_active: boolean;
}

export interface CampaignSector {
  sector: string;
  sends: number;
  contacts: number;
}

export interface CampaignScheduleEntry {
  id: string;
  tenant: string;
  sector: string;
  send_number: number;
  hero_image: string;
  subject_line: string;
  body_copy: string;
  article_slug: string | null;
  article_title: string | null;
  article_excerpt: string | null;
  template_id: string | null;
  status: 'draft' | 'approved' | 'sent' | 'skipped';
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  calculated_send_date?: string;
  frequency_days?: number;
  start_date?: string;
  template_name?: string;
  template_subject?: string;
  hero_data_uri?: string;
}

export interface CampaignPreview {
  hero_image: string;
  subject_line: string;
  body_copy: string;
  sector: string;
  article_title: string | null;
  hero_data_uri: string;
  preview_html: string;
}

export interface EngineStatus {
  running: boolean;
  last_run_at: string | null;
  last_result: {
    ran: boolean;
    reason?: string;
    due_entries: number;
    contacts_queued: number;
    contacts_skipped: number;
    errors: string[];
  } | null;
  total_scheduled: number;
  approved: number;
  sent: number;
  draft: number;
  sends_today: number;
  sends_total: number;
  next_due: string | null;
}

export interface EngineLogEntry {
  campaign_status: string;
  sent_at: string | null;
  created_at: string;
  sector: string;
  send_number: number;
  subject_line: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email_status: string | null;
  email_sent_at: string | null;
  error_message: string | null;
}

export const campaignPlannerApi = {
  getSettings: () => api.get<CampaignPlannerSettings>('/campaign-planner/settings'),
  updateSettings: (data: Partial<CampaignPlannerSettings>) => api.put<CampaignPlannerSettings>('/campaign-planner/settings', data),
  getSectors: () => api.get<CampaignSector[]>('/campaign-planner/sectors'),
  getSchedule: (sector?: string) => api.get<CampaignScheduleEntry[]>('/campaign-planner/schedule', { params: sector ? { sector } : {} }),
  getScheduleEntry: (id: string) => api.get<CampaignScheduleEntry>(`/campaign-planner/schedule/${id}`),
  updateScheduleEntry: (id: string, data: Partial<CampaignScheduleEntry>) => api.put<CampaignScheduleEntry>(`/campaign-planner/schedule/${id}`, data),
  getPreview: (id: string) => api.get<CampaignPreview>(`/campaign-planner/preview/${id}`),
  getHeroImages: () => api.get<string[]>('/campaign-planner/hero-images'),
  // Engine controls
  getEngineStatus: () => api.get<EngineStatus>('/campaign-planner/engine/status'),
  runEngine: () => api.post<EngineStatus>('/campaign-planner/engine/run'),
  pauseEngine: () => api.post('/campaign-planner/engine/pause'),
  resumeEngine: () => api.post('/campaign-planner/engine/resume'),
  getEngineLog: (limit = 50) => api.get<EngineLogEntry[]>('/campaign-planner/engine/log', { params: { limit } }),
  approveAll: () => api.post<{ approved: number }>('/campaign-planner/engine/approve-all'),
};

// ---- Draft Reviews ----
export interface DraftReview {
  id: string;
  theme: string;
  season: string;
  week_start: string;
  round: number;
  email_subject: string;
  email_html: string;
  email_content_json?: { poster_headline?: string; poster_subline?: string; [key: string]: unknown };
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
  approval_token?: string;
  skip_token?: string;
}

export interface SeriesCounts {
  intro_steps: Record<string, number>;
  intro_enrolled: number;
  intro_active: number;
  biweekly_eligible: number;
  total_contacts: number;
}

export const draftReviewsApi = {
  list: () => api.get<DraftReview[]>('/draft-reviews'),
  get: (id: string) => api.get<DraftReview & { stats?: Record<string, number> }>(`/draft-reviews/${id}`),
  seriesCounts: () => api.get<SeriesCounts>('/draft-reviews/series-counts'),
  approveDirect: (id: string) => api.post<{ success: boolean; draft: DraftReview }>(`/draft-reviews/${id}/approve-direct`),
  skipDirect: (id: string) => api.post<{ success: boolean }>(`/draft-reviews/${id}/skip-direct`),
  update: (id: string, data: { email_subject: string; email_html: string }) => api.patch<DraftReview>(`/draft-reviews/${id}`, data),
  delete: (id: string) => api.delete(`/draft-reviews/${id}`),
  generate: () => api.post('/draft-reviews/generate'),
  generateBulk: (weeks?: number) => api.post('/draft-reviews/generate-bulk', { weeks: weeks || 13 }),
  feedback: (id: string, feedback: string) => api.post(`/draft-reviews/${id}/feedback`, { feedback }),
  updatePoster: (id: string, headline: string, subline: string) => api.patch<DraftReview>(`/draft-reviews/${id}/poster`, { headline, subline }),
};

export default api;
