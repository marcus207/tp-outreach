-- Template draft review workflow for bi-weekly outreach
-- Each row = one draft round (up to 3 rounds before approval)

CREATE TABLE IF NOT EXISTS template_draft_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant            TEXT NOT NULL DEFAULT 'tp',
  theme             VARCHAR(100) NOT NULL,
  season            VARCHAR(20) NOT NULL,
  week_start        DATE NOT NULL,
  round             SMALLINT NOT NULL DEFAULT 1,
  email_subject     VARCHAR(500) NOT NULL,
  email_html        TEXT NOT NULL,
  email_content_json JSONB,
  linkedin_content  TEXT,
  linkedin_poster_html TEXT,
  image_url         TEXT,
  gmail_thread_id   VARCHAR(255),
  gmail_message_id  VARCHAR(255),
  from_account_id   UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  approval_token    UUID NOT NULL DEFAULT gen_random_uuid(),
  skip_token        UUID NOT NULL DEFAULT gen_random_uuid(),
  -- drafting | awaiting_approval | approved | skipped | sent
  status            VARCHAR(30) NOT NULL DEFAULT 'drafting',
  feedback_1        TEXT,
  feedback_2        TEXT,
  approved_at       TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  emails_sent       INTEGER NOT NULL DEFAULT 0,
  reply_processed_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tdr_tenant       ON template_draft_reviews (tenant);
CREATE INDEX IF NOT EXISTS idx_tdr_week         ON template_draft_reviews (week_start DESC);
CREATE INDEX IF NOT EXISTS idx_tdr_approval     ON template_draft_reviews (approval_token);
CREATE INDEX IF NOT EXISTS idx_tdr_skip         ON template_draft_reviews (skip_token);
CREATE INDEX IF NOT EXISTS idx_tdr_thread       ON template_draft_reviews (gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_tdr_status       ON template_draft_reviews (status);
