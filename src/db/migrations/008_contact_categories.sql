-- 008_contact_categories.sql
-- Add normalized subsector column for the 18 canonical outreach sectors
-- Introducer (8): accountant, advisory, agent, construction, lawyer, planning_architect, surveyor, wealth
-- Client (10):    btr, care, hospitality, leisure, living, logistics, office, pbsa, retail, sfh

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS subsector VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_contacts_subsector ON contacts(subsector);
CREATE INDEX IF NOT EXISTS idx_contacts_type_subsector ON contacts(contact_type, subsector);

-- Backfill subsector from custom_fields->>'sector' (messy data → canonical names)
-- Takes the first sector if comma-separated (e.g. "BTR, PBSA" → "btr")
UPDATE contacts SET subsector =
  CASE LOWER(TRIM(SPLIT_PART(custom_fields->>'sector', ',', 1)))
    -- Introducer subsectors
    WHEN 'accountant'          THEN 'accountant'
    WHEN 'advisory'            THEN 'advisory'
    WHEN 'agent'               THEN 'agent'
    WHEN 'lawyer'              THEN 'lawyer'
    WHEN 'surveyor'            THEN 'surveyor'
    WHEN 'valuer'              THEN 'surveyor'
    WHEN 'qs'                  THEN 'surveyor'
    WHEN 'wealth'              THEN 'wealth'
    WHEN 'construction'        THEN 'construction'
    WHEN 'architect'           THEN 'planning_architect'
    WHEN 'planning / architect' THEN 'planning_architect'
    WHEN 'planning'            THEN 'planning_architect'
    -- Client subsectors
    WHEN 'btr'                 THEN 'btr'
    WHEN 'care'                THEN 'care'
    WHEN 'hospitality'         THEN 'hospitality'
    WHEN 'leisure'             THEN 'leisure'
    WHEN 'living'              THEN 'living'
    WHEN 'logistics'           THEN 'logistics'
    WHEN 'office'              THEN 'office'
    WHEN 'pbsa'                THEN 'pbsa'
    WHEN 'retail'              THEN 'retail'
    WHEN 'sfh'                 THEN 'sfh'
    -- Close matches
    WHEN 'strategic land'      THEN 'sfh'
    WHEN 'supported living'    THEN 'living'
    WHEN 'interior'            THEN 'planning_architect'
    WHEN 'pm'                  THEN 'construction'
    ELSE NULL
  END
WHERE custom_fields->>'sector' IS NOT NULL
  AND subsector IS NULL;
