-- Campaign Planner: sector-based outreach with configurable frequency
-- Supports monthly, biweekly, or custom interval sends

-- Global campaign settings (one row per tenant)
CREATE TABLE IF NOT EXISTS campaign_settings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant      TEXT NOT NULL DEFAULT 'tp',
  -- Frequency in days between sends (30 = monthly, 14 = biweekly, 7 = weekly)
  frequency_days  INTEGER NOT NULL DEFAULT 30,
  -- When the first send goes out
  start_date      DATE NOT NULL DEFAULT '2026-05-01',
  -- Whether the campaign is active
  is_active       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant)
);

-- One row per sector per send number — the full content plan
CREATE TABLE IF NOT EXISTS campaign_schedule (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant          TEXT NOT NULL DEFAULT 'tp',
  -- Which sector this send targets
  sector          TEXT NOT NULL,
  -- Send number (1, 2, 3 ... 12+). Combined with frequency_days determines actual send date.
  send_number     INTEGER NOT NULL,
  -- Hero image filename (in public/hero/)
  hero_image      TEXT NOT NULL DEFAULT 'london_skyline.jpg',
  -- Email subject line (supports {{merge_fields}})
  subject_line    TEXT NOT NULL DEFAULT '',
  -- Email body copy (HTML, supports {{merge_fields}})
  body_copy       TEXT NOT NULL DEFAULT '',
  -- Article from tp.finance to link to
  article_slug    TEXT,
  article_title   TEXT,
  article_excerpt TEXT,
  -- Override: if set, use this template_id instead of generating from schedule
  template_id     UUID REFERENCES templates(id),
  -- Status
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'skipped')),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant, sector, send_number)
);

-- Track which contacts have been sent which scheduled campaign emails
CREATE TABLE IF NOT EXISTS campaign_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id     UUID NOT NULL REFERENCES campaign_schedule(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email_send_id   UUID REFERENCES email_sends(id),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(schedule_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_schedule_sector ON campaign_schedule(tenant, sector, send_number);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_schedule ON campaign_sends(schedule_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_contact ON campaign_sends(contact_id);

-- Insert default settings
INSERT INTO campaign_settings (tenant, frequency_days, start_date, is_active)
VALUES ('tp', 30, '2026-05-01', false)
ON CONFLICT (tenant) DO NOTHING;
