-- Track when an email_send was last enqueued to Bull to prevent duplicate jobs
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS last_enqueued_at TIMESTAMPTZ;
