#!/usr/bin/env python3
"""生成 README 的主图（跑在 Node 侧不用 Electron，纯 playwright 驱动渲染层）。

一张图 = 一段假桌面：左上胶囊 + 两张面板（弹窗），右侧屏幕边贴边列 + 悬停圆圈飞出的详情卡片。
每个 iframe 都是一个真实渲染层实例，摆位按主进程的落点公式算 —— 图里的相对位置就是真机上的样子。

脱敏原则：**全程用假数据**——余额、消费、token、套餐、凭据尾号都是编的，
不读取任何真实凭据，也不连网。时钟钉在「周一 10:30（北京时间）」，
这样 GLM 显示空闲、DeepSeek 显示高峰，一张图里能看出两家规则不同。

用法：python3 tools/shots.py        →  输出 docs/hero.png（2x 缩放，GitHub 上不糊）
依赖：pip install playwright && playwright install chromium
"""
import json, pathlib, re, sys, threading, functools, http.server
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
IDX = "/renderer/index.html"          # 舞台里每个 iframe 的默认页面（飞出窗加 ?flyout=1）
OUT = ROOT / "docs"
STAGE = ROOT / "_shots_stage.html"

# 钉住的时钟：2026-09-14（周一）10:30 北京时间
FAKE_NOW = 1789353000000          # 2026-09-14（周一）10:30 北京时间
H, D = 3600_000, 86400_000
BUCKET5, BUCKET60 = 300_000, 3600_000

# ---- 假数据（全部编的，和任何真实账户无关）----
def glm_data(level=None, five_pct=41, week_pct=23, start_min=54):
    # start_min：5 小时窗口已经走了多少分钟 —— 决定「是否超出按时间均摊的预期」（超了会变琥珀）
    return {"level": level,
            "five": {"percent": five_pct, "used": 11480, "total": 28000, "remaining": 16520,
                     "nextResetTime": FAKE_NOW + 4 * H + 6 * 60_000, "windowStart": FAKE_NOW - start_min * 60_000},
            "week": {"percent": week_pct, "used": 32200, "total": 140000, "remaining": 107800,
                     "nextResetTime": FAKE_NOW + 5 * D + 3 * H, "windowStart": FAKE_NOW - 2 * D},
            "fetchedAt": FAKE_NOW - 90_000}


# tier 由主进程按各账户的水位算好下发（渲染层据此给每一格上色），这里照抄
GLM_A1 = {"id": "a1", "name": "主号", "enabled": True, "status": "ok", "msg": "",
          "lastFetchAt": FAKE_NOW - 90_000, "tier": "low", "data": glm_data(),
          "dock": {"metric": "both"}}     # 双环：外环 5h、内环周
GLM_A2 = {"id": "a2", "name": "备用号", "enabled": True, "status": "ok", "msg": "",
          "lastFetchAt": FAKE_NOW - 90_000, "tier": "mid", "data": glm_data(None, 78, 12),
          "dock": {"metric": "five"}}

SPEND_24H = [0.42, 0, 0, 0.18, 1.05, 0.62, 0, 0, 0, 0.86, 2.14, 1.32,
             0.44, 0, 0, 0.90, 1.68, 0.52, 0, 0, 0.28, 1.44, 0.76, 1.12]
SPEND_1H = [0, 0.12, 0, 0.05, 0.22, 0, 0, 0.18, 0.09, 0, 0.14, 0.31]
SPEND_7D = [2.10, 3.44, 1.86, 2.92, 4.18, 1.60, 3.42]
DS_DATA = {
    "balance": {"currency": "CNY", "total": 128.66, "granted": 0, "toppedUp": 128.66, "available": True},
    "tokens": {"total": {"promptTokens": 9_100_000, "cacheHit": 8_200_000, "cacheMiss": 900_000,
                         "response": 3_150_000, "request": 1284, "total": 12_250_000}, "byModel": []},
    "summary": {
        "source": "platform", "today": 12.40, "last7": 18.90, "last30": 62.15, "month": 56.30,
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
         "lastFetchAt": FAKE_NOW - 90_000, "data": DS_DATA,
         # 圆圈下显示金额（¥12.4）：12.40 ÷ 预算 15 ≈ 83%，环走橙段
         "dock": {"metric": "today", "budget": 15, "show": "cost"}}


def quota_win(pct, reset_h, window_h, used=None, total=None):
    """火山 / Codex 的窗口（与 lib/volc.js / lib/codex.js 的归一化形状一致）"""
    reset = FAKE_NOW + reset_h * H
    ms = window_h * H
    return {"known": True, "percent": pct, "used": used, "total": total,
            "remaining": (total - used) if (used is not None and total is not None) else None,
            "nextResetTime": reset, "windowStart": reset - ms, "windowMs": ms}


# 火山方舟（Agent Plan 有绝对值）：5h 63% / 周 28% / 月 12%，都低于按时间均摊的预期
VOLC_A1 = {"id": "v1", "name": "火山方舟", "enabled": True, "status": "ok", "msg": "",
           "lastFetchAt": FAKE_NOW - 90_000, "tier": "low",
           "dock": {"metric": "five"},
           "data": {"plan": "agent", "level": None,
                    "five": quota_win(63, 1, 5, 630, 1000),
                    "week": quota_win(28, 4 * 24 + 3, 7 * 24, 1400, 5000),
                    "month": quota_win(12, 17 * 24, 30 * 24, 2400, 20000),
                    "fetchedAt": FAKE_NOW - 90_000, "bothSubscribed": False, "warn": ""}}

# OpenAI Codex（Pro 档）：5h 62% / 周 46% / 月 28%（都低于按时间均摊的预期），令牌 7 天后过期
CODEX_A1 = {"id": "c1", "name": "ChatGPT", "enabled": True, "status": "ok", "msg": "",
            "lastFetchAt": FAKE_NOW - 90_000, "tier": "low",
            "dock": {"metric": "week"},
            "data": {"level": None, "reached": False,
                     "five": quota_win(62, 1.5, 5),
                     "week": quota_win(46, 3 * 24 + 5, 7 * 24),
                     "month": quota_win(28, 18 * 24, 30 * 24),
                     "extras": [], "credits": None,
                     "tokenExp": FAKE_NOW + 7 * D, "source": "paste",
                     "fetchedAt": FAKE_NOW - 90_000}}

# 主图四家一起出场：GLM 两个账户（备用号 78% → 全局档位 mid），其余各一个
PROV_HERO = {"glm": {"name": "GLM Coding Plan", "tab": "GLM", "tier": "mid",
                     "accounts": [GLM_A1, GLM_A2], "activeId": "a1"},
             "deepseek": {"name": "DeepSeek 官方 API", "tab": "DeepSeek", "tier": None,
                          "accounts": [DS_A1], "activeId": "d1"},
             "volc": {"name": "火山方舟 Coding / Agent Plan", "tab": "火山", "tier": "low",
                      "accounts": [VOLC_A1], "activeId": "v1"},
             "codex": {"name": "OpenAI Codex（ChatGPT 套餐）", "tab": "Codex", "tier": "low",
                       "accounts": [CODEX_A1], "activeId": "c1"}}

# 设置页里出现的尾号也是编的（config.accounts 供渲染层查凭据回显，如 DS 面板的「?」浮层）
CFG = {
    "intervalMin": 10, "warnThreshold": 80, "paceAlert": True, "notifyReset": False,
    "autoStart": True, "alwaysOnTop": True, "zoom": 1, "theme": "auto", "panelTab": "glm",
    "dsRange": "7d", "dsPollMin": 2, "isPortable": False,
    "active": {"glm": "a1", "deepseek": "d1", "volc": "v1", "codex": "c1"},
    "capsuleLayout": "switch",
    "accounts": [
        {"id": "a1", "provider": "glm", "name": "主号", "enabled": True,
         "creds": {"token": {"set": True, "tail": "a1b2c3"}}},
        {"id": "a2", "provider": "glm", "name": "备用号", "enabled": True,
         "creds": {"token": {"set": True, "tail": "d4e5f6"}}},
        {"id": "d1", "provider": "deepseek", "name": "DeepSeek", "enabled": True,
         "creds": {"apiKey": {"set": True, "tail": "e6f7g8"}, "platformToken": {"set": True, "tail": "9z8y7x"}}},
        {"id": "v1", "provider": "volc", "name": "火山方舟", "enabled": True,
         "creds": {"accessKeyId": {"set": True, "tail": "lt0x1y"}, "accessKeySecret": {"set": True, "tail": "2z3w4v"},
                   "plan": {"set": True, "tail": "gent", "value": "agent"}}},
        {"id": "c1", "provider": "codex", "name": "ChatGPT", "enabled": True,
         "creds": {"source": {"set": True, "tail": "aste", "value": "paste"},
                   "accessToken": {"set": True, "tail": "k9j8h7"}}},
    ],
}


def state(view="capsule", theme="dark", tab="glm", providers=None, worst="mid", layout="switch"):
    return {"view": view, "hasAcrylic": False, "theme": theme, "platform": "win32",
            "worstTier": worst,
            "providers": json.loads(json.dumps(providers or PROV_HERO)),
            "config": dict(CFG, panelTab=tab, capsuleLayout=layout)}


def put(pg, frame_name, cfg, ready="document.querySelector('.pv5') && document.querySelector('.pv5').textContent !== '–'",
        reveal=False):
    """把某个 iframe 推到指定状态（每帧独立）。ready=就绪判据（数据已回填、不是占位「–」）；
    reveal=点开打码的余额（截图要看得见金额）"""
    fr = next(f for f in pg.frames if f.name == frame_name)
    fr.wait_for_function(ready)
    fr.evaluate("s => { window.__state = s; window.__cb(s); }", cfg)
    fr.wait_for_timeout(350)
    if reveal:
        fr.click(".pane-ds .ds-bal")   # 默认是打码态，点一下展开（展示用；真实使用中它默认藏起来）
        # 余额旁的 👁 是 emoji，无 emoji 字体的环境（本机无头 Chromium）会渲染成豆腐块。
        # Windows 上有 Segoe UI Emoji 正常显示，截图里先藏掉，避免 README 出现方框。
        fr.add_style_tag(content="#panel .pane-ds .ds-bal .eye, #flyout .pane-ds .ds-bal .eye{display:none}")
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


def fit_panel(pg, frame_name):
    """面板窗口高度 = 渲染层实测的内容高（与主进程同一口径：need + 2×12）。
    四家页签里火山 / Codex 那页多一个「月」块、比 GLM / DeepSeek 高一截，写死高度会把它裁掉"""
    fr = next(f for f in pg.frames if f.name == frame_name)
    fr.wait_for_function("window.__panelSize && window.__panelSize.h")
    h = fr.evaluate("window.__panelSize.h")
    fr.evaluate("""(h) => {
        const el = parent.document.querySelector(`iframe[name="${window.name}"]`);
        el.style.height = (h + 24) + 'px';
      }""", h)
    pg.wait_for_timeout(150)


def dock_state(theme, side):
    """贴边列：窗口就是内容本身（不留 PAD），贴边侧由 dockSide 决定"""
    s = state("dock", theme)
    s["config"] = dict(s["config"], dockSide=side)
    return s


def fit_dock(pg, frame_name, stage_w, stage_h, side):
    """贴边列也是 max-content：iframe 按实测尺寸改，并**贴到舞台对应那条边**（模拟屏幕边缘），
    这样截图里才看得出反向圆角是贴着画面边缘长出来的。返回实测尺寸（飞出卡片要按它摆位）"""
    fr = next(f for f in pg.frames if f.name == frame_name)
    fr.wait_for_function("window.__dockSize")
    sz = fr.evaluate("window.__dockSize")
    fr.evaluate("""([sz, side, sw, sh]) => {
        const el = parent.document.querySelector(`iframe[name="${window.name}"]`);
        el.style.width = sz.w + 'px';
        el.style.height = sz.h + 'px';
        el.style.left = (side === 'right' ? sw - sz.w : 0) + 'px';
        el.style.top = ((sh - sz.h) / 2) + 'px';
      }""", [sz, side, stage_w, stage_h])
    pg.wait_for_timeout(150)
    return sz


def place_flyout(pg, frame_name, cfg, target, dock_left, dock_top, dock_cy, reveal=False):
    """飞出卡片：推状态 + 悬停目标，再按主进程同一套落点公式把 iframe 摆到 dock 内侧
    （x = dock 左边 − 8 − 卡宽；y = dock 顶 + 圆心 − 卡高/2），两个窗口的相对位置就是真机上的样子"""
    fr = next(f for f in pg.frames if f.name == frame_name)
    # 飞出窗渲染层就绪（订阅了飞窗目标）。写成 typeof 判断：wait_for_function 拿函数值当结果时
    # 序列化不了，会被当成「还没好」一直等到超时
    fr.wait_for_function("typeof window.__fxCb === 'function'")
    fr.evaluate("s => { window.__state = s; window.__cb(s); }", cfg)
    fr.evaluate("t => window.__fxCb(t)", target)
    fr.wait_for_function("window.__flyoutSize")
    fr.wait_for_timeout(300)
    if reveal:
        # 卡片里的 DS 余额也点开（默认打码）。就绪判据用 .dstotal：DS 面板里没有 GLM 的 .pv5
        put(pg, frame_name, cfg, reveal=True,
            ready="document.querySelector('.pane-ds .dstotal') && document.querySelector('.pane-ds .dstotal').textContent !== '–'")
    sz = fr.evaluate("window.__flyoutSize")
    fr.evaluate("""([sz, x, y]) => {
        const el = parent.document.querySelector(`iframe[name="${window.name}"]`);
        el.style.width = sz.w + 'px';
        el.style.height = sz.h + 'px';
        el.style.left = x + 'px';
        el.style.top = y + 'px';
      }""", [sz, dock_left - 8 - sz["w"], dock_top + dock_cy - sz["h"] / 2])
    pg.wait_for_timeout(250)
    return sz


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
  dockSize: (s) => { window.__dockSize = s; },     // 同上（贴边列）
  flyoutSize: (s) => { window.__flyoutSize = s; }, // 同上（飞出卡片：窗口 = 卡片 + 2×12）
  panelSize: (s) => { window.__panelSize = s; },   // 同上（面板：高度按内容实测，见 fit_panel）
  dockHover: () => {}, flyoutHover: () => {},      // 截图不需要主进程回话，只记目标就够了
  onFlyoutTarget: (cb) => { window.__fxCb = cb; },
  setView: () => {}, setTab: () => {}, setZoom: () => {}, dragStart: () => {}, dragMove: () => {},
  dragEnd: () => {}, ctxMenu: () => {}, trayIcon: () => {}, openExternal: () => {}, quit: () => {},
  onState: (cb) => { window.__cb = cb; }, ready: () => {},
};
""" % (FAKE_NOW, json.dumps(state("capsule"), ensure_ascii=False))

# 假「桌面」底：窗口是透明的，贴着屏幕边的反向圆角 / 玻璃卡片都靠它显形
BG = {
    "desk-dark": ("radial-gradient(85% 70% at 76% 18%, #2c3a63 0%, transparent 62%),"
                  "radial-gradient(70% 60% at 10% 92%, #3a2b4e 0%, transparent 60%),"
                  "linear-gradient(155deg,#14161d 0%,#0b0d12 100%)"),
}
STAGE_HTML = """<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%%;background:%(bg)s;}
  .wrap{position:relative;width:%(w)dpx;height:%(h)dpx;}
  iframe{position:absolute;border:0;background:transparent;}
</style>
<div class="wrap">%(frames)s</div>
"""


def build_stage(frames, w, h, bg="desk-dark"):
    html = "".join(
        f'<iframe name="{n}" src="{src}" style="left:{x}px;top:{y}px;width:{fw}px;height:{fh}px"></iframe>'
        for n, x, y, fw, fh, src in frames)
    STAGE.write_text(STAGE_HTML % {"w": w, "h": h, "frames": html, "bg": BG[bg]}, encoding="utf-8")


def setup(ctx):
    html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', "",
                  (ROOT / "renderer" / "index.html").read_text(encoding="utf-8"))
    # 正则匹配：?flyout=1 的飞出窗 iframe 也走同一份去 CSP 的 HTML
    ctx.route(re.compile(r"/renderer/index\.html"), lambda r: r.fulfill(body=html, content_type="text/html; charset=utf-8"))
    ctx.add_init_script(INIT)


def main():
    OUT.mkdir(exist_ok=True)
    serve = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), serve)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 主图舞台：1280×800 的假桌面。胶囊在左上（默认位置就是屏幕角落），两张面板在它下面；
    # 贴边列贴右缘、纵向居中（真机上圆圈列就是屏幕边居中），飞出卡片按悬停圆圈摆到它内侧。
    # 面板选 GLM + Codex（一横一竖两套版式），悬停 DeepSeek 圆圈的飞出卡片补上第三家
    W, HGT = 1280, 800
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            build_stage([("cap", 64, 80, 420, 64, IDX),
                         ("glm", 64, 200, 350, 340, IDX),
                         ("codex", 444, 200, 350, 440, IDX),
                         ("dock", 0, 0, 120, 420, IDX),                          # 位置由 fit_dock 定
                         ("fly", 0, 0, 350, 430, "/renderer/index.html?flyout=1")], W, HGT)
            ctx = b.new_context(viewport={"width": W, "height": HGT}, device_scale_factor=2)
            setup(ctx)
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{port}/_shots_stage.html")
            pg.wait_for_timeout(800)
            put(pg, "cap", state("capsule"))
            fit_cap(pg, "cap")   # 胶囊宽度由内容定：按实测尺寸把 iframe 摆成窗口大小
            put(pg, "glm", state("panel", "dark", "glm"))
            fit_panel(pg, "glm")
            # Codex 面板没有 .pv5（那是 GLM 的），就绪判据换成配额块的 .pv
            put(pg, "codex", state("panel", "dark", "codex"),
                ready="document.querySelector('.pane-quota .pv') && document.querySelector('.pane-quota .pv').textContent !== '–'")
            fit_panel(pg, "codex")
            dst = dock_state("dark", "right")
            put(pg, "dock", dst)
            dock_sz = fit_dock(pg, "dock", W, HGT, "right")
            dock_left = W - dock_sz["w"]                       # 贴右：窗口右边贴舞台右缘
            dock_top = (HGT - dock_sz["h"]) / 2                # fit_dock 把它纵向居中
            dock_fr = next(f for f in pg.frames if f.name == "dock")
            cy = dock_fr.evaluate("""(i) => {                   // 第 i 个圆圈（DeepSeek）的圆心
                const list = document.querySelectorAll('#dock .dc .dc-top');
                const r = list[i].getBoundingClientRect();
                return r.top + r.height / 2; }""", 2)           # 圆圈序：GLM 主号 / 备用号 / DeepSeek / 火山 / Codex
            place_flyout(pg, "fly", dst, {"pid": "deepseek", "accId": "d1", "side": "right"},
                         dock_left, dock_top, cy, reveal=True)
            pg.screenshot(path=str(OUT / "hero.png"))
            ctx.close()
            b.close()
    finally:
        srv.shutdown()
        STAGE.unlink(missing_ok=True)

    f = OUT / "hero.png"
    print(f"  {f.relative_to(ROOT)}  {f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
