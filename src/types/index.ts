// Extend express-session to include our custom fields
declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
    email?: string;
  }
}

export interface EmailAccount {
  id: string;
  email: string;
  display_name: string | null;
  oauth_tokens: OAuthTokens;
  daily_limit: number;
  hourly_limit: number;
  sends_today: number;
  sends_this_hour: number;
  last_send_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

export interface Contact {
  id: string;
  apollo_id: string | null;
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
  tags: string[];
  custom_fields: Record<string, unknown>;
  email_verified: boolean;
  source: string;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  merge_fields: string[];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Sequence {
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
  created_at: Date;
  updated_at: Date;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_number: number;
  template_id: string | null;
  delay_days: number;
  delay_hours: number;
  step_type: 'email' | 'task';
  variant_template_id: string | null;
  variant_split: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  status: 'active' | 'completed' | 'cancelled' | 'replied' | 'paused';
  current_step: number;
  enrolled_at: Date;
  completed_at: Date | null;
  replied_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface EmailSend {
  id: string;
  enrollment_id: string | null;
  sequence_step_id: string | null;
  contact_id: string;
  email_account_id: string;
  template_id: string | null;
  to_email: string;
  from_email: string;
  subject: string;
  body_html: string;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  tracking_id: string;
  status: 'queued' | 'sent' | 'failed' | 'bounced';
  sent_at: Date | null;
  error_message: string | null;
  ab_variant: string | null;
  created_at: Date;
}

export interface EmailEvent {
  id: string;
  email_send_id: string;
  event_type: 'open' | 'click' | 'reply' | 'bounce' | 'unsubscribe';
  url: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface DripifySnapshot {
  id: string;
  snapshot_data: Record<string, unknown>;
  search_credits: number | null;
  daily_invites_used: number | null;
  daily_invites_limit: number | null;
  daily_messages_used: number | null;
  daily_messages_limit: number | null;
  campaigns: DripifyCampaign[] | null;
  scraped_at: Date;
}

export interface DripifyCampaign {
  id: string;
  name: string;
  status: string;
  leads_count?: number;
  accepted?: number;
  replied?: number;
}

export interface DripifyAlert {
  id: string;
  alert_type: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  is_read: boolean;
  snapshot_id: string | null;
  created_at: Date;
}

export interface ApolloSyncLog {
  id: string;
  sync_type: 'full' | 'incremental';
  status: 'running' | 'completed' | 'failed';
  contacts_added: number;
  contacts_updated: number;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export interface ContactList {
  id: string;
  name: string;
  description: string | null;
  apollo_list_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Setting {
  key: string;
  value: unknown;
  updated_at: Date;
}

// Job data types
export interface SequenceStepJobData {
  enrollmentId: string;
  stepNumber: number;
}

export interface EmailSendJobData {
  emailSendId: string;
}

export interface ReplyPollJobData {
  accountId?: string;
}

export interface ApolloSyncJobData {
  syncType: 'full' | 'incremental';
}

// API response helpers
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ApiError {
  error: string;
  message?: string;
}
