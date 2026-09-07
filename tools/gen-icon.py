#!/usr/bin/env python3
"""渲染应用图标：assets/icon.png (512) + assets/tray.png (32)"""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 700, "height": 700}, device_scale_factor=1)
    pg.goto((ROOT / "tools" / "icon.html").as_uri())
    pg.wait_for_timeout(200)
    pg.locator("#icon").screenshot(path=str(OUT / "icon.png"))
    pg.locator("#tray").screenshot(path=str(OUT / "tray.png"))
    b.close()

i, t = (OUT / "icon.png").stat().st_size, (OUT / "tray.png").stat().st_size
print(f"icon.png {i}B  tray.png {t}B")
sys.exit(0 if i > 1000 and t > 100 else 1)
