-- DMARC aggregate reports parsed from Gmail
CREATE TABLE IF NOT EXISTS dmarc_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant          VARCHAR(50) NOT NULL DEFAULT 'tp',
    org_name        VARCHAR(255) NOT NULL,
    report_id       VARCHAR(500),
    domain          VARCHAR(255) NOT NULL,
    date_begin      TIMESTAMPTZ NOT NULL,
    date_end        TIMESTAMPTZ NOT NULL,
    policy          VARCHAR(50),
    pct             INT,
    total_messages  INT NOT NULL DEFAULT 0,
    pass_count      INT NOT NULL DEFAULT 0,
    fail_count      INT NOT NULL DEFAULT 0,
    spf_pass        INT NOT NULL DEFAULT 0,
    spf_fail        INT NOT NULL DEFAULT 0,
    dkim_pass       INT NOT NULL DEFAULT 0,
    dkim_fail       INT NOT NULL DEFAULT 0,
    source_ips      JSONB DEFAULT '[]',
    raw_records     JSONB DEFAULT '[]',
    gmail_message_id VARCHAR(255),
    gmail_account   VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant, report_id, org_name)
);

CREATE INDEX IF NOT EXISTS idx_dmarc_reports_tenant_date ON dmarc_reports(tenant, date_end DESC);
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_gmail_msg ON dmarc_reports(gmail_message_id);
