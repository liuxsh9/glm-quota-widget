#!/usr/bin/env python3
"""把 tools/dockgoo.html 的 4 帧融合状态截成一张对照图（docs/dock-goo-preview.png）。

纯预览脚本：本地起 http 服务（页面要加载 ../lib/dock-metric.js 与 ../renderer/logos.js，
file:// 下会被 CORS 拦），playwright 截图，2x 缩放。跑法：python3 tools/goo_preview.py
"""
import pathlib, threading, functools, http.server, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "dock-goo-preview.png"

serve = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), serve)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1720, "height": 1120}, device_scale_factor=2)
    pg.goto(f"http://127.0.0.1:{PORT}/tools/dockgoo.html?sheet=1")
    pg.wait_for_timeout(600)  # 等字体/环色落定
    pg.locator("#sheet").screenshot(path=str(OUT))
    # 融合处特写单独出一张（放大了看液桥）
    pg.locator(".zoombox").nth(1).screenshot(path=str(OUT.with_name("dock-goo-zoom-bridge.png")))
    pg.locator(".zoombox").nth(2).screenshot(path=str(OUT.with_name("dock-goo-zoom-merged.png")))
    b.close()

print("已生成:", OUT)
