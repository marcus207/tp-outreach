#!/usr/bin/env python3
"""Fix truncated/broken campaign_schedule entries using actual Strapi article data."""

import json
import subprocess
import os
import re

# Load Strapi articles
with open('/tmp/strapi_articles.json') as f:
    strapi_articles = json.load(f)

# Build slug → article lookup
slug_lookup = {}
for a in strapi_articles:
    slug = a.get('slug', '')
    slug_lookup[slug] = {
        'slug': slug,
        'title': a.get('title', ''),
        'excerpt': a.get('excerpt') or a.get('description') or '',
    }

# Also build a fuzzy lookup: slug prefix → full slug
prefix_lookup = {}
for slug in slug_lookup:
    # Store progressively longer prefixes
    for length in range(20, len(slug) + 1):
        prefix = slug[:length]
        if prefix not in prefix_lookup:
            prefix_lookup[prefix] = []
        prefix_lookup[prefix].append(slug)


def normalize_slug(broken_slug):
    """Try to match a broken/truncated slug to the correct Strapi slug."""
    # Direct match
    if broken_slug in slug_lookup:
        return broken_slug

    # Clean special chars: remove commas, em-dashes, en-dashes, double-dashes, parens, ellipsis
    cleaned = broken_slug
    cleaned = cleaned.replace('—', '-').replace('–', '-').replace(',', '')
    cleaned = cleaned.replace('(', '').replace(')', '')
    cleaned = cleaned.replace('...', '')
    cleaned = re.sub(r'-{2,}', '-', cleaned)  # double/triple dashes → single
    cleaned = cleaned.strip('-')

    if cleaned in slug_lookup:
        return cleaned

    # Prefix match: find Strapi slug that starts with the cleaned truncated slug
    best_match = None
    best_len = 0
    for strapi_slug in slug_lookup:
        # Check if the cleaned broken slug is a prefix of the strapi slug
        if strapi_slug.startswith(cleaned):
            if len(cleaned) > best_len:
                best_match = strapi_slug
                best_len = len(cleaned)
        # Also try if strapi slug starts with broken slug (without cleaning)
        if strapi_slug.startswith(broken_slug.rstrip('-')):
            if len(broken_slug) > best_len:
                best_match = strapi_slug
                best_len = len(broken_slug)

    if best_match:
        return best_match

    # Try even more aggressive: strip trailing hyphen and match
    stripped = cleaned.rstrip('-')
    for strapi_slug in slug_lookup:
        if strapi_slug.startswith(stripped) and len(stripped) > 30:
            return strapi_slug

    return None


# Get current campaign schedule from DB
env = os.environ.copy()
result = subprocess.run(
    ['psql', os.environ.get('DATABASE_URL', ''), '-t', '-A', '-c',
     "SELECT id, sector, send_number, subject_line, article_slug, article_title, article_excerpt FROM campaign_schedule WHERE tenant='tp' ORDER BY sector, send_number;"],
    capture_output=True, text=True, env=env
)

updates = []
issues = []
fixed = 0
total = 0

for line in result.stdout.strip().split('\n'):
    if not line:
        continue
    parts = line.split('|')
    if len(parts) < 7:
        continue

    row_id, sector, send_num, subject_line, article_slug, article_title, article_excerpt = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
    total += 1

    # Try to match the article slug
    correct_slug = normalize_slug(article_slug)

    if correct_slug and correct_slug in slug_lookup:
        article = slug_lookup[correct_slug]
        correct_title = article['title']
        correct_excerpt = article['excerpt']

        # Build correct subject line (full title, not truncated)
        correct_subject = f"{{{{first_name}}}}, new insight: {correct_title}"

        needs_update = False
        changes = []

        if article_slug != correct_slug:
            changes.append(f"  slug: {article_slug[:60]}... → {correct_slug[:60]}...")
            needs_update = True

        if subject_line != correct_subject:
            changes.append(f"  subject truncated/wrong")
            needs_update = True

        if article_title != correct_title:
            changes.append(f"  title: {article_title[:60]}... → {correct_title[:60]}...")
            needs_update = True

        if not article_excerpt or len(article_excerpt) < 20:
            if correct_excerpt and len(correct_excerpt) > 20:
                changes.append(f"  excerpt: stub → real excerpt")
                needs_update = True

        if needs_update:
            fixed += 1
            # Escape single quotes for SQL
            safe_subject = correct_subject.replace("'", "''")
            safe_slug = correct_slug.replace("'", "''")
            safe_title = correct_title.replace("'", "''")
            safe_excerpt = correct_excerpt.replace("'", "''")

            sql = f"""UPDATE campaign_schedule SET
  subject_line = '{safe_subject}',
  article_slug = '{safe_slug}',
  article_title = '{safe_title}',
  article_excerpt = '{safe_excerpt}',
  updated_at = NOW()
WHERE id = '{row_id}';"""
            updates.append(sql)

            if changes:
                print(f"FIX {sector} #{send_num}:")
                for c in changes:
                    print(c)
    else:
        issues.append(f"NO MATCH: {sector} #{send_num} slug={article_slug[:60]}")

print(f"\n{'='*60}")
print(f"Total entries: {total}")
print(f"Entries to fix: {fixed}")
print(f"Unmatched slugs: {len(issues)}")

if issues:
    print(f"\nUNMATCHED ENTRIES:")
    for i in issues:
        print(f"  {i}")

# Write SQL file
with open('/tmp/fix_campaign_schedule.sql', 'w') as f:
    f.write("BEGIN;\n\n")
    for sql in updates:
        f.write(sql + "\n\n")
    f.write("COMMIT;\n")

print(f"\nSQL written to /tmp/fix_campaign_schedule.sql ({len(updates)} UPDATE statements)")
