-- TP.Finance Outreach Engine - Initial Schema

CREATE TABLE email_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    display_name    VARCHAR(255),
    oauth_tokens    JSONB NOT NULL,
    daily_limit     INT NOT NULL DEFAULT 2000,
    hourly_limit    INT NOT NULL DEFAULT 50,
    sends_today     INT NOT NULL DEFAULT 0,
    sends_this_hour INT NOT NULL DEFAULT 0,
    last_send_at    TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    apollo_id       VARCHAR(255) UNIQUE,
    email           VARCHAR(255) NOT NULL,
    first_name      VARCHAR(255),
    last_name       VARCHAR(255),
    title           VARCHAR(500),
    company         VARCHAR(500),
    company_domain  VARCHAR(255),
    linkedin_url    VARCHAR(500),
    phone           VARCHAR(100),
    city            VARCHAR(255),
    country         VARCHAR(255),
    tags            TEXT[] DEFAULT '{}',
    custom_fields   JSONB DEFAULT '{}',
    email_verified  BOOLEAN DEFAULT false,
    source          VARCHAR(50) NOT NULL DEFAULT 'apollo',
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_contacts_email ON contacts (LOWER(email));
CREATE INDEX idx_contacts_company ON contacts (company);
CREATE INDEX idx_contacts_tags ON contacts USING GIN (tags);
CREATE INDEX idx_contacts_source ON contacts (source);

CREATE TABLE templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    subject         VARCHAR(500) NOT NULL,
    body_html       TEXT NOT NULL,
    body_text       TEXT,
    merge_fields    TEXT[] DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sequences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'draft',
    sending_account_ids UUID[] DEFAULT '{}',
    send_window_start   TIME DEFAULT '08:00',
    send_window_end     TIME DEFAULT '18:00',
    skip_weekends       BOOLEAN NOT NULL DEFAULT true,
    daily_send_limit    INT DEFAULT 100,
    stop_on_reply       BOOLEAN NOT NULL DEFAULT true,
    stop_on_open        BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sequence_steps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id     UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    step_number     INT NOT NULL,
    template_id     UUID REFERENCES templates(id),
    delay_days      INT NOT NULL DEFAULT 0,
    delay_hours     INT NOT NULL DEFAULT 0,
    step_type       VARCHAR(20) NOT NULL DEFAULT 'email',
    variant_template_id UUID REFERENCES templates(id),
    variant_split   INT DEFAULT 50,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(sequence_id, step_number)
);

CREATE INDEX idx_sequence_steps_sequence ON sequence_steps (sequence_id);

CREATE TABLE sequence_enrollments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id     UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    current_step    INT NOT NULL DEFAULT 0,
    enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    replied_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(sequence_id, contact_id)
);

CREATE INDEX idx_enrollments_sequence ON sequence_enrollments (sequence_id);
CREATE INDEX idx_enrollments_contact ON sequence_enrollments (contact_id);
CREATE INDEX idx_enrollments_status ON sequence_enrollments (status);

CREATE TABLE email_sends (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id       UUID REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
    sequence_step_id    UUID REFERENCES sequence_steps(id) ON DELETE SET NULL,
    contact_id          UUID NOT NULL REFERENCES contacts(id),
    email_account_id    UUID NOT NULL REFERENCES email_accounts(id),
    template_id         UUID REFERENCES templates(id),
    to_email            VARCHAR(255) NOT NULL,
    from_email          VARCHAR(255) NOT NULL,
    subject             VARCHAR(500) NOT NULL,
    body_html           TEXT NOT NULL,
    gmail_message_id    VARCHAR(255),
    gmail_thread_id     VARCHAR(255),
    tracking_id         VARCHAR(64) NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
    status              VARCHAR(20) NOT NULL DEFAULT 'queued',
    sent_at             TIMESTAMPTZ,
    error_message       TEXT,
    ab_variant          CHAR(1),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sends_contact ON email_sends (contact_id);
CREATE INDEX idx_sends_enrollment ON email_sends (enrollment_id);
CREATE INDEX idx_sends_tracking ON email_sends (tracking_id);
CREATE INDEX idx_sends_gmail_thread ON email_sends (gmail_thread_id);
CREATE INDEX idx_sends_status ON email_sends (status);
CREATE INDEX idx_sends_sent_at ON email_sends (sent_at);

CREATE TABLE email_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_send_id   UUID NOT NULL REFERENCES email_sends(id) ON DELETE CASCADE,
    event_type      VARCHAR(20) NOT NULL,
    url             TEXT,
    ip_address      VARCHAR(45),
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_send ON email_events (email_send_id);
CREATE INDEX idx_events_type ON email_events (event_type);
CREATE INDEX idx_events_created ON email_events (created_at);

CREATE TABLE contact_lists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    apollo_list_id  VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE contact_list_members (
    list_id         UUID NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
    contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE dripify_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_data   JSONB NOT NULL,
    search_credits  INT,
    daily_invites_used INT,
    daily_invites_limit INT,
    daily_messages_used INT,
    daily_messages_limit INT,
    campaigns       JSONB,
    scraped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dripify_scraped ON dripify_snapshots (scraped_at DESC);

CREATE TABLE dripify_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type      VARCHAR(50) NOT NULL,
    message         TEXT NOT NULL,
    severity        VARCHAR(20) NOT NULL DEFAULT 'warning',
    is_read         BOOLEAN NOT NULL DEFAULT false,
    snapshot_id     UUID REFERENCES dripify_snapshots(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_unread ON dripify_alerts (is_read) WHERE is_read = false;

CREATE TABLE apollo_sync_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_type       VARCHAR(20) NOT NULL,
    status          VARCHAR(20) NOT NULL,
    contacts_added  INT DEFAULT 0,
    contacts_updated INT DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE TABLE settings (
    key             VARCHAR(255) PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings (key, value) VALUES
    ('apollo_sync_interval_hours', '6'),
    ('dripify_alert_credits_threshold', '50'),
    ('dripify_alert_limit_pct', '90'),
    ('reply_poll_interval_minutes', '5'),
    ('send_delay_min_seconds', '30'),
    ('send_delay_max_seconds', '120');
