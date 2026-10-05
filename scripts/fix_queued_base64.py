#!/usr/bin/env python3
"""Fix queued email_sends that still have base64 images — replace with hosted URLs."""
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

conn = psycopg2.connect(DB_URL)
cur = conn.cursor()

cur.execute("""
    SELECT id, body_html FROM email_sends
    WHERE tenant = %s AND status = 'queued' AND body_html LIKE '%%data:image%%'
""", (TENANT,))

rows = cur.fetchall()
print(f"Found {len(rows)} queued emails with base64 images")

updated = 0
batch = []
for sid, html in rows:
    pattern = r'(data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+))'
    matches = list(re.finditer(pattern, html))
    if not matches:
        continue

    new_html = html
    for match in matches:
        full_uri = match.group(0)
        img_format = match.group(2)
        b64_data = match.group(3).replace('\n', '').replace('\r', '').replace(' ', '')
        try:
            img_bytes = base64.b64decode(b64_data)
        except:
            continue
        content_hash = hashlib.md5(img_bytes).hexdigest()[:12]
        ext = 'jpg' if img_format in ('jpeg', 'jpg') else img_format
        filename = f"{content_hash}.{ext}"
        filepath = os.path.join(OUTPUT_DIR, filename)
        if not os.path.exists(filepath):
            with open(filepath, 'wb') as f:
                f.write(img_bytes)
        hosted_url = f"{BASE_URL}/{filename}"
        new_html = new_html.replace(full_uri, hosted_url)

    if new_html != html:
        batch.append((new_html, sid))
        updated += 1

    if len(batch) >= 500:
        cur.executemany("UPDATE email_sends SET body_html = %s WHERE id = %s", batch)
        conn.commit()
        print(f"  Committed {updated} so far...")
        batch = []

if batch:
    cur.executemany("UPDATE email_sends SET body_html = %s WHERE id = %s", batch)
    conn.commit()

cur.close()
conn.close()
print(f"Done: {updated} queued emails fixed")
