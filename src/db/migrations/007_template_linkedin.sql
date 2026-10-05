-- Add LinkedIn content columns to templates table
ALTER TABLE templates ADD COLUMN IF NOT EXISTS linkedin_content TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS linkedin_poster_html TEXT;
