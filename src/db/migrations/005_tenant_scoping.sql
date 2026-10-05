-- 005_tenant_scoping.sql
-- Add tenant column to all core tables for multi-tenant isolation
-- Matches the Loan Intel outreach schema pattern

-- email_accounts
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
CREATE INDEX IF NOT EXISTS idx_email_accounts_tenant ON email_accounts(tenant);

-- contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant);

-- templates
ALTER TABLE templates ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS position INTEGER;
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant);

-- sequences
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
CREATE INDEX IF NOT EXISTS idx_sequences_tenant ON sequences(tenant);

-- sequence_enrollments
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_tenant ON sequence_enrollments(tenant);

-- email_sends
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
CREATE INDEX IF NOT EXISTS idx_email_sends_tenant ON email_sends(tenant);

-- contact_lists
ALTER TABLE contact_lists ADD COLUMN IF NOT EXISTS tenant VARCHAR(50) NOT NULL DEFAULT 'tp';
CREATE INDEX IF NOT EXISTS idx_contact_lists_tenant ON contact_lists(tenant);
