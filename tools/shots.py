#!/usr/bin/env python3
"""生成 README 用的界面截图（跑在 Node 侧不用 Electron，纯 playwright 驱动渲染层）。

脱敏原则：**全程用假数据**——余额、消费、token、套餐、凭据尾号都是编的，
不读取任何真实凭据，也不连网。时钟钉在「周一 10:30（北京时间）」，
这样 GLM 显示空闲、DeepSeek 显示高峰，一张图里能看出两家规则不同。

用法：python3 tools/shots.py        →  输出到 docs/*.png（2x 缩放，GitHub 上不糊）
依赖：pip install playwright && playwright install chromium
"""
import json, pathlib, re, sys, threading, functools, http.server
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs"
STAGE = ROOT / "_shots_stage.html"

# 钉住的时钟：2026-09-14（周一）10:30 北京时间
FAKE_NOW = 1789353000000          # 2026-09-14（周一）10:30 北京时间
H, D = 3600_000, 86400_000
BUCKET5, BUCKET60 = 300_000, 3600_000

# ---- 假数据（全部编的，和任何真实账户无关）----
GLM = {
    "level": "max",
    "five": {"percent": 41, "used": 11480, "total": 28000, "remaining": 16520,
             "nextResetTime": FAKE_NOW + 4 * H + 6 * 60_000, "windowStart": FAKE_NOW - 54 * 60_000},
    "week": {"percent": 23, "used": 32200, "total": 140000, "remaining": 107800,
             "nextResetTime": FAKE_NOW + 5 * D + 3 * H, "windowStart": FAKE_NOW - 2 * D},
    "fetchedAt": FAKE_NOW - 90_000,
}
SPEND_24H = [0.42, 0, 0, 0.18, 1.05, 0.62, 0, 0, 0, 0.86, 2.14, 1.32,
             0.44, 0, 0, 0.90, 1.68, 0.52, 0, 0, 0.28, 1.44, 0.76, 1.12]
SPEND_1H = [0, 0.12, 0, 0.05, 0.22, 0, 0, 0.18, 0.09, 0, 0.14, 0.31]
SPEND_7D = [2.10, 3.44, 1.86, 2.92, 4.18, 1.60, 3.42]
DS = {
    "balance": {"currency": "CNY", "total": 128.66, "granted": 0, "toppedUp": 128.66, "available": True},
    "tokens": {"total": {"promptTokens": 9_100_000, "cacheHit": 8_200_000, "cacheMiss": 900_000,
                         "response": 3_150_000, "request": 1284, "total": 12_250_000}, "byModel": []},
    "summary": {
        "source": "platform", "today": 3.42, "last7": 18.90, "last30": 62.15, "month": 56.30,
        "avg7": 2.70, "daysLeft": 47, "days": 7, "monthLabel": "2026-09", "currency": "CNY",
        "last1h": 1.11, "last5m": 0.31, "firstSampleAt": FAKE_NOW - 26 * H, "samples": 812,
        "since": "2026-09-01",
        "byModel": [{"model": "deepseek-flash", "cost": 48.20}, {"model": "deepseek-v4-pro", "cost": 8.10}],
        "hourly": [{"ts": (FAKE_NOW // BUCKET60 - (23 - i)) * BUCKET60, "spend": s, "partial": i == 23}
                   for i, s in enumerate(SPEND_24H)],
        "fine": [{"ts": (FAKE_NOW // BUCKET5 - (11 - i)) * BUCKET5, "spend": s, "partial": i == 11}
                 for i, s in enumerate(SPEND_1H)],
        "series": [{"date": f"2026-09-{8 + i:02d}", "spend": s} for i, s in enumerate(SPEND_7D)],
    },
    "platform": {"status": "ok", "msg": "", "lastFetchAt": FAKE_NOW - 90_000},
}
# 设置页里出现的尾号也是编的
CFG = {
    "hasToken": True, "tokenTail": "a1b2c3", "intervalMin": 10, "warnThreshold": 80,
    "paceAlert": True, "notifyReset": False, "autoStart": True, "alwaysOnTop": True, "zoom": 1,
    "theme": "auto", "panelTab": "glm", "dsRange": "24h", "dsPollMin": 2,
    "dsHasToken": True, "dsTokenTail": "d4e5f6", "dsHasPlatform": True, "dsPlatformTail": "9z8y7x",
    "isPortable": False,
}


def state(view="capsule", theme="dark", tab="glm"):
    return {"view": view, "hasAcrylic": False, "theme": theme, "platform": "win32",
            "providers": {"glm": {"status": "ok", "msg": "", "lastFetchAt": FAKE_NOW - 90_000, "data": GLM},
                          "ds": {"status": "ok", "msg": "", "lastFetchAt": FAKE_NOW - 90_000, **DS}},
            "config": dict(CFG, panelTab=tab)}


def put(pg, frame_name, cfg, reveal=False):
    """把某个 iframe 推到指定状态（每帧独立）；reveal=点开打码的余额（截图要看得见金额）"""
    fr = next(f for f in pg.frames if f.name == frame_name)
    fr.wait_for_function("document.querySelector('.pv5') && document.querySelector('.pv5').textContent !== '–'")
    fr.evaluate("s => { window.__state = s; window.__cb(s); }", cfg)
    fr.wait_for_timeout(350)
    if reveal:
        fr.click("#dsBal")          # 默认是打码态，点一下展开（展示用；真实使用中它默认藏起来）
        # 余额旁的 👁 是 emoji，无 emoji 字体的环境（本机无头 Chromium）会渲染成豆腐块。
        # Windows 上有 Segoe UI Emoji 正常显示，截图里先藏掉，避免 README 出现方框。
        fr.add_style_tag(content="#panel .ds-bal .eye{display:none}")
        fr.wait_for_timeout(250)


INIT = """
const FAKE_NOW = %d;
Date.now = () => FAKE_NOW;                 // 钉住时钟：峰谷徽标与倒计时都可复现
window.__state = %s;
window.glm = {
  getState: async () => window.__state,
  save: async (p) => { Object.assign(window.__state.config, p); return window.__state; },
  refreshNow: async () => window.__state, clipboardPeek: async () => null,
  setView: () => {}, setTab: () => {}, setZoom: () => {}, dragStart: () => {}, dragMove: () => {},
  dragEnd: () => {}, ctxMenu: () => {}, trayIcon: () => {}, openExternal: () => {}, quit: () => {},
  onState: (cb) => { window.__cb = cb; }, ready: () => {},
};
""" % (FAKE_NOW, json.dumps(state("capsule"), ensure_ascii=False))

BG = {
    "dark": ("radial-gradient(120% 90% at 15% 0%, #2b3350 0%, transparent 60%),"
             "radial-gradient(100% 80% at 90% 100%, #1d3a45 0%, transparent 55%),"
             "linear-gradient(160deg,#171922 0%,#0e1016 100%)"),
    "light": ("radial-gradient(120% 90% at 12% 0%, #dfe6f3 0%, transparent 60%),"
              "radial-gradient(100% 80% at 88% 100%, #d6e6ea 0%, transparent 55%),"
              "linear-gradient(160deg,#f2f4f8 0%,#e4e7ee 100%)"),
}
STAGE_HTML = """<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%%;background:%(bg)s;}
  .wrap{position:relative;width:%(w)dpx;height:%(h)dpx;}
  iframe{position:absolute;border:0;background:transparent;}
</style>
<div class="wrap">%(frames)s</div>
"""


def build_stage(frames, w, h, bg="dark"):
    html = "".join(
        f'<iframe name="{n}" src="/renderer/index.html" style="left:{x}px;top:{y}px;width:{fw}px;height:{fh}px"></iframe>'
        for n, x, y, fw, fh in frames)
    STAGE.write_text(STAGE_HTML % {"w": w, "h": h, "frames": html, "bg": BG[bg]}, encoding="utf-8")


def setup(ctx):
    html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', "",
                  (ROOT / "renderer" / "index.html").read_text(encoding="utf-8"))
    ctx.route("**/renderer/index.html", lambda r: r.fulfill(body=html, content_type="text/html; charset=utf-8"))
    ctx.add_init_script(INIT)


def main():
    OUT.mkdir(exist_ok=True)
    serve = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), serve)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        with sync_playwright() as p:
            b = p.chromium.launch()

            # ① 主图：胶囊 + GLM 面板 + DeepSeek 面板（深色）
            build_stage([("cap", 60, 62, 212, 64), ("glm", 60, 176, 350, 294), ("ds", 440, 176, 350, 294)], 850, 530)
            ctx = b.new_context(viewport={"width": 850, "height": 530}, device_scale_factor=2)
            setup(ctx)
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{port}/_shots_stage.html")
            pg.wait_for_timeout(700)
            put(pg, "cap", state("capsule"))
            put(pg, "glm", state("panel", "dark", "glm"))
            put(pg, "ds", state("panel", "dark", "ds"), reveal=True)
            pg.screenshot(path=str(OUT / "hero.png"))
            ctx.close()

            # ② 浅色主题（自适应背景明暗）
            build_stage([("ds", 60, 60, 350, 294)], 470, 414, bg="light")
            ctx = b.new_context(viewport={"width": 470, "height": 414}, device_scale_factor=2)
            setup(ctx)
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{port}/_shots_stage.html")
            pg.wait_for_timeout(500)
            put(pg, "ds", state("panel", "light", "ds"), reveal=True)
            pg.screenshot(path=str(OUT / "panel-light.png"))
            ctx.close()

            # ③ 设置页（窗口高，1x 即可）
            build_stage([("set", 40, 40, 416, 736)], 496, 816)
            ctx = b.new_context(viewport={"width": 496, "height": 816}, device_scale_factor=1.5)
            setup(ctx)
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{port}/_shots_stage.html")
            pg.wait_for_timeout(500)
            put(pg, "set", state("settings"))
            pg.screenshot(path=str(OUT / "settings.png"))
            ctx.close()
            b.close()
    finally:
        srv.shutdown()
        STAGE.unlink(missing_ok=True)

    for f in sorted(OUT.glob("*.png")):
        print(f"  {f.relative_to(ROOT)}  {f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
