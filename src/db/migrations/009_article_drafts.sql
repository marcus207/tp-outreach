-- 009_article_drafts.sql
-- Article drafts from research scraper: review, publish to Strapi, broadcast to subsectors

CREATE TABLE IF NOT EXISTS article_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(300) NOT NULL UNIQUE,
    excerpt TEXT,
    content TEXT,
    sector VARCHAR(50) DEFAULT 'general',
    author VARCHAR(100) DEFAULT 'Marcus Emadi',
    publish_date DATE,
    source_url TEXT,
    source_org VARCHAR(100) DEFAULT 'Research',
    status VARCHAR(20) DEFAULT 'draft',
    strapi_id VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_drafts_status ON article_drafts(status);
CREATE INDEX IF NOT EXISTS idx_article_drafts_sector ON article_drafts(sector);
CREATE INDEX IF NOT EXISTS idx_article_drafts_publish_date ON article_drafts(publish_date DESC);

CREATE TABLE IF NOT EXISTS article_broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id UUID NOT NULL REFERENCES article_drafts(id) ON DELETE CASCADE,
    subsectors TEXT[] NOT NULL,
    contact_type VARCHAR(20),
    total_contacts INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_opened INTEGER DEFAULT 0,
    total_clicked INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_broadcasts_article ON article_broadcasts(article_id);
