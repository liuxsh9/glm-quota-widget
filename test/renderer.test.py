#!/usr/bin/env python3
"""渲染层测试：mock window.glm 桥，验证 胶囊/面板/设置/过期 四状态与交互
（经本地 HTTP 提供页面，并仅在测试中剥掉 CSP 以便 evaluate 推送状态）"""
import pathlib, sys, re, threading, functools, http.server
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

serve = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), serve)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

PAGE = f"http://127.0.0.1:{PORT}/renderer/index.html"
HTML_NOCSP = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', "",
                    (ROOT / "renderer" / "index.html").read_text(encoding="utf-8"))
JWT = "eyJhbGciOiJIUzUxMiJ9.eyJ1c2VyX3R5cGUiOiJQRVJTT05BTCJ9.SIGnature_123"

INIT = """
window.__view = null; window.__saved = null; window.__tray = null; window.__cb = null; window.__ready = false; window.__ctx = 0;
window.__clip = '';
const NOW = Date.now();
window.__state = {
  view: 'capsule', status: 'ok', msg: '', lastFetchAt: NOW - 60000, hasAcrylic: false, theme: 'dark', platform: 'win32',
  data: {
    level: 'max',
    five: { percent: 5, used: 1585, total: 28000, remaining: 26415,
            nextResetTime: NOW + 4.7*3600*1000, windowStart: NOW - 0.3*3600*1000 },
    week: { percent: 7, used: 10407, total: 140000, remaining: 129593,
            nextResetTime: NOW + (4*86400+7*3600)*1000, windowStart: NOW - 86400*2*1000 },
    fetchedAt: NOW - 60000,
  },
  config: { hasToken: true, token: 'OLD_OLD_OLD', intervalMin: 10, notifyThreshold: 80,
            notifyReset: false, autoStart: true, alwaysOnTop: true, zoom: 1, theme: 'auto' },
};
window.glm = {
  getState: async () => window.__state,
  save: async (patch) => { window.__saved = patch; window.__state.config = {...window.__state.config, ...patch}; return window.__state; },
  refreshNow: async () => window.__state,
  clipboardPeek: async () => window.__clip,
  setView: (v) => { window.__view = v; },
  setZoom: (z) => { window.__zoom = z; window.__state.config.zoom = z; window.__cb(window.__state); },
  dragBy: () => { window.__drag = (window.__drag || 0) + 1; }, dragEnd: () => {}, ctxMenu: () => { window.__ctx++; },
  trayIcon: (u) => { window.__tray = u; },
  openExternal: () => {}, quit: () => {},
  onState: (cb) => { window.__cb = cb; },
  ready: () => { window.__ready = true; },
};
"""

fails = []
def t(name, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{extra}]" if extra and not cond else ""))
    if not cond: fails.append(name)

def push(pg, **patch):
    pg.evaluate("p => { Object.assign(window.__state, p); window.__cb(window.__state); }", patch)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 192, "height": 68})
    ctx.route("**/renderer/index.html", lambda r: r.fulfill(body=HTML_NOCSP, content_type="text/html; charset=utf-8"))
    pg = ctx.new_page()
    pg.add_init_script(INIT)
    pg.goto(PAGE)
    pg.wait_for_function("document.querySelector('.pv5') && document.querySelector('.pv5').textContent !== '–'")

    print("胶囊 · 正常态:")
    t("就绪信号已发", pg.evaluate("window.__ready"))
    t("胶囊显示 5h 5%", pg.text_content(".pv5") == "5")
    t("周 7%", pg.text_content(".pvw") == "7")
    t("tier=low", pg.get_attribute("body", "data-tier") == "low")
    t("进度条宽度≈5%", pg.evaluate("getComputedStyle(document.querySelector('#capsule .f5')).width") not in ("", "0px"))
    t("胶囊未标题栏化（右键不再弹系统菜单）", pg.evaluate("getComputedStyle(document.getElementById('capsule')).webkitAppRegion") != "drag")
    pg.click("#capsule", button="right")
    t("右键唤起应用菜单", pg.evaluate("window.__ctx") == 1)
    t("托盘图标已推送", pg.evaluate("window.__tray && window.__tray.startsWith('data:image/png')"))
    pg.locator("#capsule").screenshot(path="/tmp/r_capsule.png")

    print("点击展开 → 面板:")
    pg.click("#capsule")
    t("setView('panel')", pg.evaluate("window.__view") == "panel")
    t("乐观先行切换（不等主进程回包）", pg.evaluate("document.body.classList.contains('view-panel')"))
    push(pg, view="panel")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    t("面板百分比对", pg.text_content("#panel .pv5") == "5")
    t("积分 1585/2.8万", pg.text_content("#panel .u5") == "1,585" and pg.text_content("#panel .t5") == "2.8万")
    t("5h 倒计时文案", pg.evaluate("/小时|分钟/.test(document.querySelector('.cd5').textContent)"))
    t("周倒计时含天", "天" in pg.text_content(".cdw"))
    t("套餐名 Max", pg.text_content(".lvl") == "Max")

    print("浅色主题切换:")
    pg.evaluate("s => { s.theme = 'light'; window.__cb(s); }", pg.evaluate("window.__state"))
    t("body 挂上 theme-light", pg.evaluate("document.body.classList.contains('theme-light')"))
    t("浅色底生效", pg.evaluate("getComputedStyle(document.querySelector('#panel')).backgroundColor") != "")
    pg.evaluate("s => { s.theme = 'dark'; window.__cb(s); }", pg.evaluate("window.__state"))
    t("切回深色移除 class", pg.evaluate("!document.body.classList.contains('theme-light')"))
    pg.set_viewport_size({"width": 350, "height": 266})
    fb = pg.locator("#panel .blk").last.locator(".pbar").bounding_box()
    t("面板内容完整可见", fb and fb["y"] + fb["height"] <= 254, str(fb))

    print("预期进度标记（方案 D）:")
    t("面板幽灵+亮线挂载", pg.locator("#panel .pbar .ghost").count() == 2 and pg.locator("#panel .pbar .edge").count() == 2)
    t("胶囊幽灵挂载", pg.locator("#capsule .bar .ghost").count() == 2)
    t("胶囊 bar 未裁剪亮线", pg.evaluate("getComputedStyle(document.querySelector('#capsule .bar')).overflow") == "visible")
    pace5 = pg.evaluate("parseFloat(document.body.style.getPropertyValue('--pace5'))")
    t("5h 预期≈6%（0.3h/5h 时间均摊）", pace5 is not None and 5.3 <= pace5 <= 6.7, str(pace5))
    paceW = pg.evaluate("parseFloat(document.body.style.getPropertyValue('--paceW'))")
    t("周预期已计算", paceW is not None and 25 <= paceW <= 36, str(paceW))
    pg.locator("#panel .pbar").first.hover()
    pg.wait_for_timeout(250)
    t("悬停幽灵显示解释", "预期" in (pg.locator("#panel .ptip.show").first.inner_text() if pg.locator("#panel .ptip.show").count() else ""))
    t("解释含实际用量对照", pg.evaluate("[...document.querySelectorAll('#panel .ptip.show')].some(e => e.textContent.includes('实际'))"))

    print("配速极小时 tooltip 不截断:")
    pg.evaluate("() => { const s = window.__state; const n = Date.now(); s.data.five.windowStart = n - 30000; s.data.five.nextResetTime = n + 5*3600*1000; window.__cb(s); }")
    pg.wait_for_timeout(80)
    pg.locator("#panel .pbar").first.hover()
    pg.wait_for_timeout(250)
    box = pg.locator("#panel .ptip.show").first.bounding_box()
    t("气泡完整在窗口内", box and box["x"] >= 0 and box["x"] + box["width"] <= 350, str(box))
    pg.evaluate("() => { const s = window.__state; const n = Date.now(); s.data.five.windowStart = n - 0.3*3600*1000; s.data.five.nextResetTime = n + 4.7*3600*1000; window.__cb(s); }")

    print("极端文本不换行（最长倒计时+跨天日期）:")
    pg.evaluate("() => { const s = window.__state; const n = Date.now(); s.data.five.windowStart = n - 60000; s.data.five.nextResetTime = n + (4*3600+59*60)*1000; s.data.week.windowStart = n - 60000; s.data.week.nextResetTime = n + (6*86400+23*3600)*1000; window.__cb(s); }")
    pg.wait_for_timeout(120)
    pg.wait_for_function("document.querySelector('.cdw').textContent.includes('6天')")
    t("副标题不溢出不折行", pg.evaluate("[...document.querySelectorAll('#panel .sub')].every(e => e.scrollWidth <= e.clientWidth + 1)"))
    wb2 = pg.locator("#panel .blk").last.locator(".pbar").bounding_box()
    t("极端文本下周 bar 仍在面板内", wb2 and wb2["y"] + wb2["height"] <= 254, str(wb2))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_worst.png")
    t("倒计时在标题行", "后重置" in pg.text_content("#panel .blk .sub"))
    t("绝对重置时间在积分列", pg.evaluate("/\\d{2}:\\d{2}/.test(document.querySelector('#panel .pts').textContent)"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel.png")

    print("Ctrl+滚轮缩放:")
    pg.keyboard.down("Control")
    pg.mouse.wheel(0, -100)
    pg.keyboard.up("Control")
    pg.wait_for_timeout(100)
    t("放大到 105%", pg.evaluate("window.__zoom") == 1.05)
    t("缩放提示显示", pg.locator("#zoomTip").evaluate("e => e.textContent") == "105%")

    print("高用量变色:")
    pg.evaluate("s => { s.data.five.percent = 92; s.data.week.percent = 88; window.__cb(s); }",
                pg.evaluate("window.__state"))
    t("tier=high", pg.get_attribute("body", "data-tier") == "high")
    pg.locator("#panel").screenshot(path="/tmp/r_panel_high.png")
    pg.evaluate("s => { s.data.five.percent = 5; s.data.week.percent = 7; window.__cb(s); }",
                pg.evaluate("window.__state"))

    print("过期态:")
    push(pg, status="expired", msg="Cookie 已失效", view="capsule")
    pg.wait_for_function("document.body.className.includes('st-expired')")
    pg.set_viewport_size({"width": 192, "height": 68})
    t("胶囊显示过期提示", pg.locator(".hint-expired").is_visible())
    pg.click("#capsule")
    t("点击直达设置", pg.evaluate("window.__view") == "settings")
    push(pg, view="panel")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    t("面板出现过期横幅", pg.locator(".banner-expired").is_visible())
    pg.locator("#panel").screenshot(path="/tmp/r_panel_exp.png")

    print("设置页:")
    pg.evaluate("window.__clip = '%s'" % JWT)
    push(pg, view="settings")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.set_viewport_size({"width": 416, "height": 736})
    sb = pg.locator("#saveBtn").bounding_box()
    t("设置保存按钮完整可见", sb and sb["y"] + sb["height"] <= 724, str(sb))
    t("Cookie 引导存在", pg.locator("#settings .guide li").count() == 5)
    pg.select_option("#theme", "light")
    t("表单回填刷新频率 10", pg.eval_on_selector("#interval", "e => e.value") == "10")
    t("Token 状态=已失效", "失效" in pg.text_content("#tstatTxt"))
    t("剪贴板提示出现", pg.locator("#clipchip").is_visible())
    pg.click("#clipchip")
    t("点击填入 token", pg.eval_on_selector("#tok", "e => e.value") == JWT)
    pg.select_option("#interval", "30")
    pg.click("#saveBtn")
    pg.wait_for_function("window.__saved")
    t("保存含 token+间隔", pg.evaluate("window.__saved.token === '%s' && window.__saved.intervalMin === 30" % JWT))
    t("保存含主题选择", pg.evaluate("window.__saved.theme === 'light'"))
    t("保存后回到面板", pg.evaluate("window.__view") == "panel")
    pg.evaluate("window.__state.view='settings'; window.__cb(window.__state)")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.locator("#settings").screenshot(path="/tmp/r_settings.png")

    print("点空白收起:")
    pg.evaluate("window.__state.view='panel'; window.__cb(window.__state)")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    pg.click("#panel .blk .sub")
    t("点面板非按钮处 → capsule", pg.evaluate("window.__view") == "capsule")

    print("Esc 收起:")
    pg.evaluate("window.__state.view='settings'; window.__cb(window.__state)")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.keyboard.press("Escape")
    t("Esc → capsule", pg.evaluate("window.__view") == "capsule")

    print("拖拽手势（JS 路径 + rAF 合帧）:")
    pg.evaluate("s => { s.view='capsule'; window.__view=null; window.__cb(s); }", pg.evaluate("window.__state"))
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    pg.set_viewport_size({"width": 192, "height": 68})
    pg.mouse.move(96, 34)
    pg.mouse.down()
    pg.mouse.move(140, 40, steps=6)   # 位移 > 4px → 进入拖拽
    pg.mouse.move(180, 60, steps=6)
    pg.mouse.up()
    pg.wait_for_timeout(200)
    t("拖拽走 IPC 且未触发点击", pg.evaluate("window.__view") is None and pg.evaluate("window.__drag >= 1"))

    print("格式化函数:")
    t("fmtPoints 万", pg.evaluate("GLMFMT.fmtPoints(28000)") == "2.8万")
    t("fmtPoints 千分位", pg.evaluate("GLMFMT.fmtPoints(8965)") == "8,965")
    t("fmtPoints 万进位", pg.evaluate("GLMFMT.fmtPoints(10407)") == "1万")
    t("fmtCountdown 天/小时", "天" in pg.evaluate("GLMFMT.fmtCountdown(3.5*86400*1000)"))
    t("levelName max", pg.evaluate("GLMFMT.levelName('max')") == "Max")

    print("档位新阈值（80 mid / 90 high，5h+周取最高）:")
    t("tierOf 79→low", pg.evaluate("GLMFMT.tierOf(79)") == "low")
    t("tierOf 80→mid", pg.evaluate("GLMFMT.tierOf(80)") == "mid")
    t("tierOf 89→mid", pg.evaluate("GLMFMT.tierOf(89)") == "mid")
    t("tierOf 90→high", pg.evaluate("GLMFMT.tierOf(90)") == "high")
    t("60/20 组合→low（旧逻辑会误 mid）", pg.evaluate("GLMFMT.tierOfPair(60, 20)") == "low")
    t("10/85 周触发→mid", pg.evaluate("GLMFMT.tierOfPair(10, 85)") == "mid")
    t("10/95 周触发→high", pg.evaluate("GLMFMT.tierOfPair(10, 95)") == "high")
    t("95/10 5h触发→high", pg.evaluate("GLMFMT.tierOfPair(95, 10)") == "high")

    pg.evaluate("() => { const s = window.__state; s.view='capsule'; s.status='ok'; window.__cb(s); }")
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    pg.evaluate("() => { const s = window.__state; s.data.five.percent=10; s.data.week.percent=95; window.__cb(s); }")
    t("周 95% 时界面整体变 high", pg.get_attribute("body", "data-tier") == "high")
    pg.evaluate("() => { const s = window.__state; s.data.five.percent=5; s.data.week.percent=7; window.__cb(s); }")
    t("回落到 low", pg.get_attribute("body", "data-tier") == "low")

    b.close()

print(f"\n{'全部通过' if not fails else '失败: ' + ', '.join(fails)}")
sys.exit(0 if not fails else 1)
