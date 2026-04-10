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
  created_at: string;
  active_sequences?: number;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  merge_fields: string[];
  is_active: boolean;
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
  list: (params?: { page?: number; limit?: number; search?: string; tag?: string; company?: string; source?: string; sort?: string; dir?: string }) =>
    api.get<PaginatedResponse<Contact>>('/contacts', { params }),
  create: (data: Partial<Contact>) => api.post<Contact>('/contacts', data),
  get: (id: string) => api.get<Contact>(`/contacts/${id}`),
  update: (id: string, data: Partial<Contact>) => api.put<Contact>(`/contacts/${id}`, data),
  delete: (id: string) => api.delete(`/contacts/${id}`),
  importCsv: (csv: string, source?: string) => api.post('/contacts/import', { csv, source }),
  getTags: () => api.get<string[]>('/contacts/tags'),
  addTags: (id: string, tags: string[]) => api.post(`/contacts/${id}/tags`, { tags }),
  getLists: () => api.get('/contacts/lists'),
  createList: (data: { name: string; description?: string }) => api.post('/contacts/lists', data),
  addToList: (listId: string, contactIds: string[]) => api.post(`/contacts/lists/${listId}/members`, { contact_ids: contactIds }),
};

// ---- Templates ----
export const templatesApi = {
  list: () => api.get<Template[]>('/templates'),
  create: (data: Partial<Template>) => api.post<Template>('/templates', data),
  get: (id: string) => api.get<Template>(`/templates/${id}`),
  update: (id: string, data: Partial<Template>) => api.put<Template>(`/templates/${id}`, data),
  delete: (id: string) => api.delete(`/templates/${id}`),
  preview: (id: string, contactId?: string) => api.post<{ subject: string; bodyHtml: string; bodyText: string }>(`/templates/${id}/preview`, { contact_id: contactId }),
  aiEdit: (id: string, prompt: string) => api.post<{ body_html: string }>(`/templates/${id}/ai-edit`, { prompt }),
};

// ---- Analytics ----
export const analyticsApi = {
  overview: () => api.get<AnalyticsOverview>('/analytics/overview'),
  daily: (days?: number) => api.get<DailyStats[]>(`/analytics/daily${days ? `?days=${days}` : ''}`),
  accounts: () => api.get<EmailAccount[]>('/analytics/accounts'),
  campaigns: () => api.get('/analytics/campaigns'),
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

export default api;
