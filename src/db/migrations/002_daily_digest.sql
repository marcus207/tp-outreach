-- Daily digest table for approval-based email sends
CREATE TABLE IF NOT EXISTS daily_digest (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_date DATE NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, approved, sending, sent, rejected
  contacts JSONB NOT NULL DEFAULT '[]',          -- recommended contacts with assignments
  approved_contacts JSONB,                        -- edited list after approval (null = use contacts as-is)
  approval_token UUID NOT NULL DEFAULT gen_random_uuid(),
  approved_at TIMESTAMP WITH TIME ZONE,
  sent_at TIMESTAMP WITH TIME ZONE,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS daily_digest_date_idx ON daily_digest(digest_date DESC);
CREATE INDEX IF NOT EXISTS daily_digest_token_idx ON daily_digest(approval_token);
