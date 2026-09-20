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
def glm_data(level="max", five_pct=41, week_pct=23, start_min=54):
    # start_min：5 小时窗口已经走了多少分钟 —— 决定「是否超出按时间均摊的预期」（超了会变琥珀）
    return {"level": level,
            "five": {"percent": five_pct, "used": 11480, "total": 28000, "remaining": 16520,
                     "nextResetTime": FAKE_NOW + 4 * H + 6 * 60_000, "windowStart": FAKE_NOW - start_min * 60_000},
            "week": {"percent": week_pct, "used": 32200, "total": 140000, "remaining": 107800,
                     "nextResetTime": FAKE_NOW + 5 * D + 3 * H, "windowStart": FAKE_NOW - 2 * D},
            "fetchedAt": FAKE_NOW - 90_000}


# tier 由主进程按各账户的水位算好下发（渲染层据此给每一格上色），这里照抄
GLM_A1 = {"id": "a1", "name": "主号", "enabled": True, "status": "ok", "msg": "",
          "lastFetchAt": FAKE_NOW - 90_000, "tier": "low", "data": glm_data()}
GLM_A2 = {"id": "a2", "name": "备用号", "enabled": True, "status": "ok", "msg": "",
          "lastFetchAt": FAKE_NOW - 90_000, "tier": "mid", "data": glm_data("pro", 78, 12)}

SPEND_24H = [0.42, 0, 0, 0.18, 1.05, 0.62, 0, 0, 0, 0.86, 2.14, 1.32,
             0.44, 0, 0, 0.90, 1.68, 0.52, 0, 0, 0.28, 1.44, 0.76, 1.12]
SPEND_1H = [0, 0.12, 0, 0.05, 0.22, 0, 0, 0.18, 0.09, 0, 0.14, 0.31]
SPEND_7D = [2.10, 3.44, 1.86, 2.92, 4.18, 1.60, 3.42]
DS_DATA = {
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
DS_A1 = {"id": "d1", "name": "DeepSeek", "enabled": True, "status": "ok", "msg": "",
         "lastFetchAt": FAKE_NOW - 90_000, "data": DS_DATA}

# 设置页里出现的尾号也是编的
CFG = {
    "intervalMin": 10, "warnThreshold": 80, "paceAlert": True, "notifyReset": False,
    "autoStart": True, "alwaysOnTop": True, "zoom": 1, "theme": "auto", "panelTab": "glm",
    "dsRange": "24h", "dsPollMin": 2, "isPortable": False,
    "active": {"glm": "a1", "deepseek": "d1"}, "capsuleLayout": "switch",
    "accounts": [
        {"id": "a1", "provider": "glm", "name": "主号", "enabled": True,
         "creds": {"token": {"set": True, "tail": "a1b2c3"}}},
        {"id": "a2", "provider": "glm", "name": "备用号", "enabled": True,
         "creds": {"token": {"set": True, "tail": "d4e5f6"}}},
        {"id": "d1", "provider": "deepseek", "name": "DeepSeek", "enabled": True,
         "creds": {"apiKey": {"set": True, "tail": "e6f7g8"}, "platformToken": {"set": True, "tail": "9z8y7x"}}},
    ],
}

# 主图 showcase 多账户：GLM 两个账户（备用号 78% → 全局档位 mid）
PROV_MID = {"glm": {"name": "GLM Coding Plan", "tab": "GLM", "tier": "mid",
                    "accounts": [GLM_A1, GLM_A2], "activeId": "a1"},
            "deepseek": {"name": "DeepSeek 官方 API", "tab": "DeepSeek", "tier": None,
                         "accounts": [DS_A1], "activeId": "d1"}}

# 多账户两种布局的对比图用：GLM 三个账户（各自档位不同 → 平铺时各格各色）+ DS 两个账户。
# start_min=200：窗口总长 = 已经过的 200 分钟 + 还剩的 4h6m，预期 ≈45%（低于主号的 41% 用量），
# 这样主号看到的是纯档位色（青）而不是超预期的提醒色；备用号/工作号本来就已经超过预期。
def glm_acct(i, name, tier, pct, wk):
    return {"id": i, "name": name, "enabled": True, "status": "ok", "msg": "", "lastFetchAt": FAKE_NOW - 90_000,
            "tier": tier, "data": glm_data("pro" if i != "a1" else "max", pct, wk, start_min=200)}


DS_A2 = {"id": "d2", "name": "备用", "enabled": True, "status": "ok", "msg": "",
         "lastFetchAt": FAKE_NOW - 90_000,
         "data": dict(json.loads(json.dumps(DS_DATA)),
                      balance={"currency": "CNY", "total": 42.50, "granted": 0, "toppedUp": 42.50, "available": True})}
PROV_MANY = {"glm": {"name": "GLM Coding Plan", "tab": "GLM", "tier": "high",
                     "accounts": [glm_acct("a1", "主号", "low", 41, 23),
                                  glm_acct("a2", "备用号", "mid", 78, 12),
                                  glm_acct("a3", "工作", "high", 93, 40)], "activeId": "a1"},
             "deepseek": {"name": "DeepSeek 官方 API", "tab": "DeepSeek", "tier": None,
                          "accounts": [DS_A1, DS_A2], "activeId": "d1"}}


def state(view="capsule", theme="dark", tab="glm", providers=None, worst="mid", layout="switch"):
    return {"view": view, "hasAcrylic": False, "theme": theme, "platform": "win32",
            "worstTier": worst,
            "providers": json.loads(json.dumps(providers or PROV_MID)),
            "config": dict(CFG, panelTab=tab, capsuleLayout=layout)}


def put(pg, frame_name, cfg, reveal=False):
    """把某个 iframe 推到指定状态（每帧独立）；reveal=点开打码的余额（截图要看得见金额）"""
    fr = next(f for f in pg.frames if f.name == frame_name)
    fr.wait_for_function("document.querySelector('.pv5') && document.querySelector('.pv5').textContent !== '–'")
    fr.evaluate("s => { window.__state = s; window.__cb(s); }", cfg)
    fr.wait_for_timeout(350)
    if reveal:
        fr.click(".pane-ds .ds-bal")   # 默认是打码态，点一下展开（展示用；真实使用中它默认藏起来）
        # 余额旁的 👁 是 emoji，无 emoji 字体的环境（本机无头 Chromium）会渲染成豆腐块。
        # Windows 上有 Segoe UI Emoji 正常显示，截图里先藏掉，避免 README 出现方框。
        fr.add_style_tag(content="#panel .pane-ds .ds-bal .eye{display:none}")
        fr.wait_for_timeout(250)


def fit_cap(pg, frame_name):
    """胶囊卡片是 max-content（宽窄由内容决定），iframe 按渲染层实测尺寸改 —— 跟真实窗口一致"""
    fr = next(f for f in pg.frames if f.name == frame_name)
    sz = fr.evaluate("window.__capSize")
    if not sz:
        return
    fr.evaluate("""(sz) => {
        const el = parent.document.querySelector(`iframe[name="${window.name}"]`);
        el.style.width = (sz.w + 24) + 'px';
        el.style.height = (sz.h + 24) + 'px';
      }""", sz)
    pg.wait_for_timeout(150)


INIT = """
const FAKE_NOW = %d;
Date.now = () => FAKE_NOW;                 // 钉住时钟：峰谷徽标与倒计时都可复现
window.__state = %s;
window.glm = {
  getState: async () => window.__state,
  save: async (p) => { Object.assign(window.__state.config, p); return window.__state; },
  refreshNow: async () => window.__state, clipboardPeek: async () => null,
  accAdd: async () => window.__state, accUpdate: async () => window.__state,
  accRemove: async () => window.__state, accActivate: async () => window.__state, accMenu: async () => window.__state,
  capsuleSize: (s) => { window.__capSize = s; },   // 实测尺寸：舞台按它调 iframe 大小
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

    # GLM 配了两个账户 → 面板出现账户 chips 行（+26px），多账户也是要 show off 的能力
    PH = 294 + 26
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()

            # ① 主图：胶囊 + GLM 面板 + DeepSeek 面板（深色）
            build_stage([("cap", 60, 62, 240, 64), ("glm", 60, 176, 350, PH), ("ds", 440, 176, 350, PH)], 850, 560)
            ctx = b.new_context(viewport={"width": 850, "height": 560}, device_scale_factor=2)
            setup(ctx)
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{port}/_shots_stage.html")
            pg.wait_for_timeout(700)
            put(pg, "cap", state("capsule"))
            fit_cap(pg, "cap")   # 胶囊宽度由内容定：按实测尺寸把 iframe 摆成窗口大小
            put(pg, "glm", state("panel", "dark", "glm"))
            put(pg, "ds", state("panel", "dark", "deepseek"), reveal=True)
            pg.screenshot(path=str(OUT / "hero.png"))
            ctx.close()

            # ①b 多账户两种布局（README「多账户」一节）：切换（点账户标签）+ 平铺（一眼看全）
            CW, TW = 400, 760
            build_stage([("sw", 30, 46, CW, 64), ("tile", 30, 168, TW, 72)], 820, 268)
            ctx = b.new_context(viewport={"width": 820, "height": 268}, device_scale_factor=2)
            setup(ctx)
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{port}/_shots_stage.html")
            pg.wait_for_timeout(600)
            put(pg, "sw", state("capsule", worst="mid"))
            fit_cap(pg, "sw")
            put(pg, "tile", state("capsule", providers=PROV_MANY, worst="high", layout="all"))
            fit_cap(pg, "tile")
            pg.screenshot(path=str(OUT / "capsule-multi.png"))
            ctx.close()

            # ② 浅色主题（自适应背景明暗）
            build_stage([("ds", 60, 60, 350, PH)], 470, PH + 120, bg="light")
            ctx = b.new_context(viewport={"width": 470, "height": PH + 120}, device_scale_factor=2)
            setup(ctx)
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{port}/_shots_stage.html")
            pg.wait_for_timeout(500)
            put(pg, "ds", state("panel", "light", "deepseek"), reveal=True)
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
            # ③b 设置页的「通用」段（滚到底）：胶囊布局等全局项在这
            fr = next(f for f in pg.frames if f.name == "set")
            fr.evaluate("document.querySelector('#settings .sbody').scrollTop = 99999")
            fr.wait_for_timeout(250)
            pg.screenshot(path=str(OUT / "settings-general.png"))
            ctx.close()
            b.close()
    finally:
        srv.shutdown()
        STAGE.unlink(missing_ok=True)

    for f in sorted(OUT.glob("*.png")):
        print(f"  {f.relative_to(ROOT)}  {f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
