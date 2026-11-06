# Builds public/og-image.jpg (the link-preview picture for WhatsApp, Facebook and others) from scripts/og-card.html.
# Needs Google Chrome (or Chromium / Microsoft Edge) and Pillow (pip install pillow).
# Usage: python scripts/build-og-image.py
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent.parent
card = root / 'scripts' / 'og-card.html'
out = root / 'public' / 'og-image.jpg'

browsers = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    shutil.which('google-chrome') or '', shutil.which('chromium') or '',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',  # its headless mode can quietly do nothing
]
browser = next((b for b in browsers if b and os.path.exists(b)), None)
if not browser:
    sys.exit('Install Google Chrome first.')

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
    png = Path(tmp) / 'card.png'
    subprocess.run([
        browser, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--window-size=1200,630', '--virtual-time-budget=8000', f'--user-data-dir={Path(tmp) / "profile"}',
        f'--screenshot={png}', card.as_uri(),
    ], capture_output=True, timeout=120)
    if not png.exists():
        sys.exit(f'{browser} did not write the picture. Try Google Chrome.')
    img = Image.open(png).convert('RGB')
    if img.size != (1200, 630):
        img = img.crop((0, 0, 1200, 630))
    # WhatsApp skips preview pictures over about 300 KB
    img.save(out, 'JPEG', quality=85, optimize=True, progressive=True)

print(f'Wrote {out.relative_to(root)}: {out.stat().st_size // 1024} KB, 1200x630')
