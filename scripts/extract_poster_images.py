#!/usr/bin/env python3
"""
Extract base64-encoded poster images from templates, save as hosted files,
and update templates to reference the hosted URLs instead.
"""
import os
import re
import base64
import hashlib
import psycopg2

def _db_url():
    import os
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    for line in open("/root/tp-outreach/.env"):
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("DATABASE_URL not set")


DB_URL = _db_url()
TENANT = "tp"
OUTPUT_DIR = "/root/tp-outreach/public/posters"
BASE_URL = "https://tp.finance/outreach/posters"

os.makedirs(OUTPUT_DIR, exist_ok=True)

conn = psycopg2.connect(DB_URL)
cur = conn.cursor()

# Get all templates with base64 images
cur.execute("""
    SELECT id, name, body_html FROM templates
    WHERE tenant = %s AND body_html LIKE '%%data:image%%'
""", (TENANT,))

templates = cur.fetchall()
print(f"Found {len(templates)} templates with base64 images")

updated = 0
for tid, name, html in templates:
    # Find all data:image URIs
    pattern = r'(data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+))'
    matches = list(re.finditer(pattern, html))

    if not matches:
        continue

    new_html = html
    for match in matches:
        full_uri = match.group(0)
        img_format = match.group(2)
        b64_data = match.group(3).replace('\n', '').replace('\r', '').replace(' ', '')

        # Decode and save
        try:
            img_bytes = base64.b64decode(b64_data)
        except Exception as e:
            print(f"  SKIP {name}: decode error: {e}")
            continue

        # Use content hash for filename to deduplicate
        content_hash = hashlib.md5(img_bytes).hexdigest()[:12]
        ext = 'jpg' if img_format in ('jpeg', 'jpg') else img_format
        filename = f"{content_hash}.{ext}"
        filepath = os.path.join(OUTPUT_DIR, filename)

        if not os.path.exists(filepath):
            with open(filepath, 'wb') as f:
                f.write(img_bytes)
            print(f"  Saved {filename} ({len(img_bytes):,} bytes)")

        hosted_url = f"{BASE_URL}/{filename}"
        new_html = new_html.replace(full_uri, hosted_url)

    if new_html != html:
        cur.execute(
            "UPDATE templates SET body_html = %s, updated_at = NOW() WHERE id = %s",
            (new_html, tid)
        )
        old_size = len(html)
        new_size = len(new_html)
        print(f"  Updated: {name} ({old_size:,} -> {new_size:,} bytes, saved {old_size - new_size:,})")
        updated += 1

conn.commit()
cur.close()
conn.close()

# List saved images
images = os.listdir(OUTPUT_DIR)
total_size = sum(os.path.getsize(os.path.join(OUTPUT_DIR, f)) for f in images)
print(f"\nDone: {updated} templates updated, {len(images)} unique images saved ({total_size:,} bytes)")
