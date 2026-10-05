#!/usr/bin/env python3
"""
Download sector-specific hero images from Unsplash for email campaigns.
12 images per sector, resized to 600px wide, compressed for email embedding.
"""

import os
import sys
import json
import time
import subprocess
import urllib.request
import urllib.error

HERO_DIR = '/root/tp-outreach/public/hero'

# Unsplash search collections — each URL returns a page with photo data
# We'll use the Unsplash source endpoint which gives random photos for a query
SECTOR_SEARCHES = {
    'btr': [
        'UK modern apartment building exterior',
        'london residential tower block new',
        'UK housing development modern',
        'manchester apartment building new build',
        'UK build to rent apartments modern',
        'london residential building contemporary',
        'UK new build flats exterior',
        'birmingham apartment complex modern',
        'UK residential development facade',
        'leeds modern apartments building',
        'UK city apartments new construction',
        'london luxury apartments exterior',
    ],
    'hospitality': [
        'UK luxury hotel exterior',
        'london boutique hotel building',
        'UK hotel lobby grand',
        'british country house hotel',
        'london five star hotel entrance',
        'UK seaside hotel building',
        'edinburgh hotel exterior classic',
        'UK hotel bedroom luxury suite',
        'manchester hotel modern building',
        'UK spa hotel exterior',
        'london hotel facade night',
        'UK heritage hotel building stone',
    ],
    'sfh': [
        'UK detached house modern',
        'british semi detached houses street',
        'UK new build house estate',
        'english village houses residential',
        'UK suburban houses street',
        'british countryside home',
        'UK housing estate new development',
        'english terraced houses brick',
        'UK family home garden',
        'british new build houses development',
        'UK residential street houses',
        'english cottage countryside home',
    ],
    'pbsa': [
        'UK student accommodation building',
        'university campus modern building UK',
        'student housing block modern',
        'UK university halls residence',
        'modern student flats exterior',
        'UK campus accommodation building',
        'student living quarters modern UK',
        'university dormitory building exterior',
        'UK student housing development',
        'modern campus building glass',
        'UK education building university',
        'student accommodation tower modern',
    ],
    'living': [
        'UK residential street london',
        'british houses neighbourhood',
        'UK modern housing mixed development',
        'london residential area',
        'UK senior living facility modern',
        'shared living building modern UK',
        'UK co living development',
        'retirement village UK modern',
        'UK mixed use residential building',
        'london townhouses residential',
        'UK later living development modern',
        'UK residential neighbourhood aerial',
    ],
    'logistics': [
        'UK warehouse exterior modern',
        'logistics distribution centre UK',
        'UK industrial estate modern',
        'warehouse park aerial view UK',
        'UK freight depot modern',
        'logistics hub exterior building',
        'UK distribution warehouse modern',
        'industrial warehouse corrugated UK',
        'UK logistics park entrance',
        'modern warehouse interior shelves',
        'UK cargo depot aerial',
        'distribution centre loading bay UK',
    ],
    'office': [
        'london city office building modern',
        'UK commercial office tower glass',
        'canary wharf office building',
        'london office interior modern workspace',
        'UK business park office building',
        'city of london skyscraper',
        'manchester commercial office modern',
        'UK glass office building exterior',
        'london financial district building',
        'UK modern office complex',
        'birmingham office building commercial',
        'london office building entrance',
    ],
    'retail': [
        'UK high street shops',
        'london retail building commercial',
        'UK shopping centre modern',
        'british high street retail',
        'UK retail park exterior',
        'london oxford street shops',
        'UK commercial retail unit modern',
        'shopping mall interior UK',
        'UK town centre shops',
        'british retail high street architecture',
        'UK out of town retail park',
        'london luxury retail mayfair',
    ],
    'care': [
        'UK care home modern building',
        'nursing home exterior UK modern',
        'UK healthcare facility building',
        'care home garden residents UK',
        'UK assisted living facility modern',
        'retirement home UK building exterior',
        'UK care facility modern architecture',
        'healthcare building entrance UK',
        'UK supported housing building',
        'care home lounge modern UK',
        'UK elderly care facility exterior',
        'modern healthcare centre UK',
    ],
    'leisure': [
        'UK leisure centre modern',
        'british sports centre building',
        'UK entertainment venue modern',
        'cinema multiplex UK exterior',
        'UK gym fitness centre building',
        'bowling alley UK modern',
        'UK leisure park aerial',
        'swimming pool centre UK',
        'UK recreation centre modern',
        'british pub restaurant exterior',
        'UK trampoline park leisure',
        'holiday park UK resort',
    ],
}

def download_image(query: str, filepath: str, width: int = 600) -> bool:
    """Download an image from Unsplash using their source redirect endpoint."""
    # Use Unsplash source which redirects to a random matching photo
    url = f"https://source.unsplash.com/featured/{width}x400/?{urllib.request.quote(query)}"

    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    }

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            data = response.read()
            if len(data) < 5000:  # Too small, probably an error
                return False
            with open(filepath, 'wb') as f:
                f.write(data)
            return True
    except Exception as e:
        print(f"  Failed: {e}")
        return False


def download_from_pexels_scrape(query: str, filepath: str) -> bool:
    """Fallback: download from Pexels by scraping their search page."""
    url = f"https://www.pexels.com/search/{urllib.request.quote(query)}/"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            html = response.read().decode('utf-8', errors='ignore')

        # Find image URLs in the page
        import re
        # Look for data-photo-modal-medium-image-download or similar
        matches = re.findall(r'src="(https://images\.pexels\.com/photos/\d+/[^"]+\?auto=compress[^"]*w=600[^"]*)"', html)
        if not matches:
            matches = re.findall(r'src="(https://images\.pexels\.com/photos/\d+/[^"]+)"', html)

        if matches:
            img_url = matches[0]
            if '?' in img_url:
                img_url = img_url.split('?')[0] + '?auto=compress&cs=tinysrgb&w=600'
            req2 = urllib.request.Request(img_url, headers=headers)
            with urllib.request.urlopen(req2, timeout=15) as img_resp:
                data = img_resp.read()
                if len(data) > 5000:
                    with open(filepath, 'wb') as f:
                        f.write(data)
                    return True
    except Exception as e:
        print(f"  Pexels fallback failed: {e}")
    return False


def main():
    os.makedirs(HERO_DIR, exist_ok=True)

    total = 0
    failed = 0

    for sector, queries in SECTOR_SEARCHES.items():
        print(f"\n=== {sector.upper()} ===")
        for i, query in enumerate(queries, 1):
            filename = f"{sector}_{i:02d}.jpg"
            filepath = os.path.join(HERO_DIR, filename)

            if os.path.exists(filepath) and os.path.getsize(filepath) > 5000:
                print(f"  [{i}/12] {filename} — already exists, skipping")
                total += 1
                continue

            print(f"  [{i}/12] Downloading {filename} — query: '{query}'...")

            success = download_image(query, filepath)
            if not success:
                print(f"  [{i}/12] Unsplash failed, trying Pexels...")
                success = download_from_pexels_scrape(query, filepath)

            if success:
                # Resize with imagemagick
                subprocess.run(['convert', filepath, '-resize', '600x', '-quality', '75', '-strip', filepath],
                             capture_output=True)
                size_kb = os.path.getsize(filepath) / 1024
                print(f"  [{i}/12] ✓ {filename} ({size_kb:.0f}KB)")
                total += 1
            else:
                print(f"  [{i}/12] ✗ {filename} — FAILED")
                failed += 1

            # Rate limit
            time.sleep(1.5)

    print(f"\n=== DONE: {total} downloaded, {failed} failed ===")


if __name__ == '__main__':
    main()
