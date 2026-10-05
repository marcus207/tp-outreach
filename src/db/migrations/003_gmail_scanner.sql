-- Gmail Scanner: track processed messages and contact classification

-- Track which Gmail message IDs have been scanned per account
CREATE TABLE IF NOT EXISTS gmail_scanned_messages (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id       UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    gmail_message_id VARCHAR(255) NOT NULL,
    direction        VARCHAR(10) NOT NULL CHECK (direction IN ('sent', 'received')),
    contact_email    VARCHAR(255),
    scanned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_gmail_scanned_account ON gmail_scanned_messages (account_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_scanned_at ON gmail_scanned_messages (scanned_at DESC);

-- Contact classification columns
ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS contact_type      VARCHAR(50),
    ADD COLUMN IF NOT EXISTS classification_data JSONB DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS classified_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts (contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_unclassified ON contacts (created_at DESC) WHERE contact_type IS NULL;

-- Tenant column on gmail_scanned_messages (consistent with rest of schema)
ALTER TABLE gmail_scanned_messages ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
