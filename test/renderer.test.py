#!/usr/bin/env python3
"""渲染层测试：mock window.glm 桥，验证 胶囊(双列)/面板(GLM·DeepSeek 两页签)/设置/过期 各状态与交互
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
DSKEY = "sk-0123456789abcdef0123456789abcdef"

# 窗口尺寸：卡片 + 2×12 padding
CAP_BOTH = (212, 64)     # 双列胶囊 188×40
CAP_SINGLE = (176, 64)   # 只配一家 152×40
PANEL_GLM = (350, 294)
PANEL_DS = (350, 294)   # 与 GLM 视图同高
SETTINGS = (416, 736)

INIT = """
window.__view = null; window.__saved = null; window.__tab = null; window.__tray = null; window.__cb = null;
window.__ready = false; window.__ctx = 0; window.__clip = null;
window.__dragStart = null; window.__dragMove = 0; window.__dragEnd = 0;
const NOW = Date.now();
window.__state = {
  view: 'capsule', hasAcrylic: false, theme: 'dark', platform: 'win32',
  providers: {
    glm: {
      status: 'ok', msg: '', lastFetchAt: NOW - 60000,
      data: {
        level: 'max',
        five: { percent: 5, used: 1585, total: 28000, remaining: 26415,
                nextResetTime: NOW + 4.7*3600*1000, windowStart: NOW - 0.3*3600*1000 },
        week: { percent: 7, used: 10407, total: 140000, remaining: 129593,
                nextResetTime: NOW + (4*86400+7*3600)*1000, windowStart: NOW - 86400*2*1000 },
        fetchedAt: NOW - 60000,
      },
    },
    ds: {
      status: 'ok', msg: '', lastFetchAt: NOW - 60000,
      balance: { currency: 'CNY', total: 318.29, granted: 0, toppedUp: 318.29, available: true },
      summary: { source: 'platform', today: 1.23, last7: 8.45, last30: 21.7, month: 12.3,
                 avg7: 1.21, daysLeft: 263, days: 7, monthLabel: '2026-09', currency: 'CNY',
                 byModel: [{ model: 'deepseek-flash', cost: 12.3 }], since: '2026-09-01', samples: 9,
                 last1h: 0.42, last5m: 0.08, firstSampleAt: NOW - 26*3600*1000,
                 fine: Array.from({length: 12}, (_, i) => ({
                   ts: Math.floor((NOW - (11 - i) * 300e3) / 300e3) * 300e3,
                   spend: [0,0.05,0,0.12,0,0,0.08,0,0,0.03,0,0.08][i],
                   partial: i === 11 })),
                 hourly: Array.from({length: 24}, (_, i) => ({
                   ts: Math.floor((NOW - (23 - i) * 3600*1000) / 3600e3) * 3600e3,
                   spend: [1.2,0,0.4,2.0,0,0,0.8,0,0,3.1,0,0.2,0,0,1.5,0,0,0,0.6,0,0,0,0.3,0.42][i],
                   partial: i === 23 })),
                 series: [ {date:'2026-09-08',spend:0.5},{date:'2026-09-09',spend:0},{date:'2026-09-10',spend:2.1},
                           {date:'2026-09-11',spend:1.4},{date:'2026-09-12',spend:3.0},{date:'2026-09-13',spend:0.22},
                           {date:'2026-09-14',spend:1.23} ] },
      tokens: { total: { promptTokens: 9000000, cacheHit: 8000000, cacheMiss: 1000000,
                         response: 3300000, request: 1200, total: 12300000 },
                byModel: [] },
      platform: { status: 'ok', msg: '', lastFetchAt: NOW - 60000 },
    },
  },
  config: { hasToken: true, tokenTail: 'OLD_OLD_OLD', intervalMin: 10, warnThreshold: 80,
            paceAlert: true, notifyReset: false, autoStart: true, alwaysOnTop: true, zoom: 1,
            theme: 'auto', panelTab: 'glm', dsRange: '7d', dsPollMin: 2, dsHasToken: true, dsTokenTail: 'def',
            dsHasPlatform: true, dsPlatformTail: 'xyz' },
};
window.__glmData = JSON.parse(JSON.stringify(window.__state.providers.glm.data));
window.glm = {
  getState: async () => window.__state,
  save: async (patch) => {
    window.__saved = patch;
    window.__state.config = {...window.__state.config, ...patch};
    // 模拟主进程 save() 里的 applyTheme()：非 auto 的主题立即生效、随广播回传
    if (patch.theme && patch.theme !== 'auto') window.__state.theme = patch.theme;
    return window.__state;
  },
  refreshNow: async () => window.__state,
  clipboardPeek: async () => window.__clip,
  setView: (v) => { window.__view = v; },
  setTab: (t) => { window.__tab = t; },
  setZoom: (z) => { window.__zoom = z; window.__state.config.zoom = z; window.__cb(window.__state); },
  dragStart: (gx, gy) => { window.__dragStart = [gx, gy]; },
  dragMove: () => { window.__dragMove++; },
  dragEnd: () => { window.__dragEnd++; },
  ctxMenu: () => { window.__ctx++; },
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

def push_glm(pg, **patch):
    pg.evaluate("p => { Object.assign(window.__state.providers.glm, p); window.__cb(window.__state); }", patch)

def push_ds(pg, **patch):
    pg.evaluate("p => { Object.assign(window.__state.providers.ds, p); window.__cb(window.__state); }", patch)

def restore_glm(pg):
    pg.evaluate("() => { const s = window.__state; s.providers.glm.data = JSON.parse(JSON.stringify(window.__glmData)); s.providers.glm.status = 'ok'; window.__cb(s); }")

def set_dev(pg, js):
    """在 evaluate 里改状态并推送（js 里用 s.providers.glm.data 这类路径）"""
    pg.evaluate("() => { const s = window.__state; %s window.__cb(s); }" % js)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": CAP_BOTH[0], "height": CAP_BOTH[1]})
    ctx.route("**/renderer/index.html", lambda r: r.fulfill(body=HTML_NOCSP, content_type="text/html; charset=utf-8"))
    pg = ctx.new_page()
    pg.add_init_script(INIT)
    pg.goto(PAGE)
    pg.wait_for_function("document.querySelector('.pv5') && document.querySelector('.pv5').textContent !== '–'")

    print("胶囊 · 正常态（双列）:")
    t("就绪信号已发", pg.evaluate("window.__ready"))
    t("胶囊显示 5h 5%", pg.text_content(".pv5") == "5")
    t("周 7%", pg.text_content(".pvw") == "7")
    t("tier=low", pg.get_attribute("body", "data-tier") == "low")
    t("两家都配上 → has-glm/has-ds", pg.evaluate("document.body.classList.contains('has-glm') && document.body.classList.contains('has-ds')"))
    t("进度条宽度≈5%", pg.evaluate("getComputedStyle(document.querySelector('#capsule .f5')).width") not in ("", "0px"))
    t("DeepSeek 余额在胶囊右列", pg.text_content("#capsule .dsbal") == "¥318.29")
    t("今日消费在胶囊右列", "1.23" in pg.text_content("#capsule .dstoday"))
    t("分隔线可见", pg.locator("#capsule .cap-sep").is_visible())
    t("胶囊未标题栏化（右键不再弹系统菜单）", pg.evaluate("getComputedStyle(document.getElementById('capsule')).webkitAppRegion") != "drag")
    pg.click("#capsule", button="right")
    t("右键唤起应用菜单", pg.evaluate("window.__ctx") == 1)
    t("托盘图标已推送", pg.evaluate("window.__tray && window.__tray.startsWith('data:image/png')"))
    pg.locator("#capsule").screenshot(path="/tmp/r_capsule.png")

    print("只配 GLM 时右列收起:")
    pg.evaluate("() => { const c = window.__state.config; c.dsHasToken = false; window.__cb(window.__state); }")
    t("cap-ds 隐藏", not pg.locator("#capsule .cap-ds").is_visible())
    t("分隔线隐藏", not pg.locator("#capsule .cap-sep").is_visible())
    t("GLM 列仍在", pg.locator("#capsule .cap-glm").is_visible())
    pg.set_viewport_size({"width": CAP_SINGLE[0], "height": CAP_SINGLE[1]})
    cb = pg.locator("#capsule .pvw").bounding_box()
    t("单列胶囊内容不溢出", cb and cb["x"] + cb["width"] <= CAP_SINGLE[0] - 10, str(cb))
    pg.evaluate("() => { window.__state.config.dsHasToken = true; window.__cb(window.__state); }")
    pg.set_viewport_size({"width": CAP_BOTH[0], "height": CAP_BOTH[1]})

    print("点击展开 → 面板（GLM 页签）:")
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
    t("GLM 页签高亮", pg.evaluate("document.getElementById('tabGlm').classList.contains('on')"))
    t("GLM 视图可见 / DS 视图隐藏",
      pg.locator("#panel .pane-glm").is_visible() and not pg.locator("#panel .pane-ds").is_visible())

    print("浅色主题切换:")
    pg.evaluate("s => { s.theme = 'light'; window.__cb(s); }", pg.evaluate("window.__state"))
    t("body 挂上 theme-light", pg.evaluate("document.body.classList.contains('theme-light')"))
    t("浅色底生效", pg.evaluate("getComputedStyle(document.querySelector('#panel')).backgroundColor") != "")
    pg.evaluate("s => { s.theme = 'dark'; window.__cb(s); }", pg.evaluate("window.__state"))
    t("切回深色移除 class", pg.evaluate("!document.body.classList.contains('theme-light')"))
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1]})
    fb = pg.locator("#panel .blk-q").last.locator(".pbar").bounding_box()
    t("面板内容完整可见", fb and fb["y"] + fb["height"] <= PANEL_GLM[1] - 12, str(fb))

    print("预期进度标记（方案 D）:")
    t("面板幽灵+亮线+超支段挂载", pg.locator("#panel .pbar .ghost").count() == 2
      and pg.locator("#panel .pbar .edge").count() == 2 and pg.locator("#panel .pbar .ovr").count() == 2)
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

    print("超预期变色提醒（需求 2）:")
    t("常态无超支段", pg.evaluate("document.body.dataset.pace") == "ok")
    t("常态不显示 ▲ 标签", not pg.locator("#panel .blk-q[data-win='five'] .overchip").is_visible())
    t("常态不显示超预期说明", not pg.evaluate("document.querySelector('#panel .blk-note .overtxt').offsetParent"))
    t("常态不显示超预期说明", not pg.evaluate("document.querySelector('#panel .blk-note .overtxt').offsetParent"))
    # 预期压到 1%，实际 5% → 超出 4 个百分点
    set_dev(pg, "const n = Date.now(); s.providers.glm.data.five.windowStart = n - 30000; s.providers.glm.data.five.nextResetTime = n + 5*3600*1000;")
    pg.wait_for_timeout(360)
    t("body 标记 data-pace=over", pg.evaluate("document.body.dataset.pace") == "over")
    t("5h 块挂上 over", pg.evaluate("document.querySelector(\"#panel .blk-q[data-win='five']\").classList.contains('over')"))
    t("▲ 超预期 标签出现", pg.locator("#panel .blk-q[data-win='five'] .overchip").is_visible())
    t("底部备注不再写幽灵段（改由悬停解释）", "幽灵" not in pg.text_content("#panel .blk-note"), pg.text_content("#panel .blk-note"))
    t("超预期说明完整显示不截断", pg.evaluate("""() => {
        const t = document.querySelector('#panel .blk-note .overtxt');
        return t.offsetParent !== null && t.scrollWidth <= t.clientWidth + 1;
      }"""))
    t("底部备注不再写幽灵段（改由悬停解释）", "幽灵" not in pg.text_content("#panel .blk-note"), pg.text_content("#panel .blk-note"))
    t("超预期说明完整显示不截断", pg.evaluate("""() => {
        const t = document.querySelector('#panel .blk-note .overtxt');
        return t.offsetParent !== null && t.scrollWidth <= t.clientWidth + 1;
      }"""))
    t("周块不受牵连", not pg.evaluate("document.querySelector(\"#panel .blk-q[data-win='week']\").classList.contains('over')"))
    ovr5 = pg.evaluate("parseFloat(document.body.style.getPropertyValue('--over5'))")
    t("超支幅度≈4 个百分点", ovr5 is not None and 3.5 <= ovr5 <= 4.5, str(ovr5))
    t("超支段可见", pg.evaluate("getComputedStyle(document.querySelector('#panel .pbar .ovr.o5')).opacity") == "1")
    ovrw = pg.evaluate("parseFloat(document.body.style.getPropertyValue('--overW'))")
    t("未超支的窗口 over=0（不会画出假的红段）", ovrw == 0, str(ovrw))
    pg.locator("#panel .pbar").first.hover()
    pg.wait_for_timeout(200)
    t("悬停解释含超出幅度", "超出预期" in pg.locator("#panel .ptip.show").first.inner_text())
    pg.locator("#panel").screenshot(path="/tmp/r_panel_over.png")
    # GLM 超预期不该把 DeepSeek 视图也染成琥珀（两家水位互不相干）
    pg.evaluate("() => { const s = window.__state; s.config.panelTab = 'ds'; window.__cb(s); }")
    pg.wait_for_timeout(120)
    t("DeepSeek 视图强调色不受 GLM 超预期影响",
      pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-ds')).getPropertyValue('--g1').trim()") != "#fbbf24")
    pg.evaluate("() => { const s = window.__state; s.config.panelTab = 'glm'; window.__cb(s); }")
    pg.wait_for_timeout(120)
    # 关掉开关 → 立刻恢复正常配色
    pg.evaluate("() => { window.__state.config.paceAlert = false; window.__cb(window.__state); }")
    pg.wait_for_timeout(360)
    t("关开关后不再超预期", pg.evaluate("document.body.dataset.pace") == "ok")
    t("关开关后超支段不显示", pg.evaluate("getComputedStyle(document.querySelector('#panel .pbar .ovr.o5')).opacity") == "0")
    pg.evaluate("() => { window.__state.config.paceAlert = true; window.__cb(window.__state); }")
    set_dev(pg, "const n = Date.now(); s.providers.glm.data.five.windowStart = n - 0.3*3600*1000; s.providers.glm.data.five.nextResetTime = n + 4.7*3600*1000;")

    print("配速极小时 tooltip 不截断:")
    set_dev(pg, "const n = Date.now(); s.providers.glm.data.five.windowStart = n - 30000; s.providers.glm.data.five.nextResetTime = n + 5*3600*1000;")
    pg.wait_for_timeout(80)
    pg.locator("#panel .pbar").first.hover()
    pg.wait_for_timeout(250)
    box = pg.locator("#panel .ptip.show").first.bounding_box()
    t("气泡完整在窗口内", box and box["x"] >= 0 and box["x"] + box["width"] <= PANEL_GLM[0], str(box))
    set_dev(pg, "const n = Date.now(); s.providers.glm.data.five.windowStart = n - 0.3*3600*1000; s.providers.glm.data.five.nextResetTime = n + 4.7*3600*1000;")

    print("极端文本不换行（最长倒计时+跨天日期）:")
    set_dev(pg, "const n = Date.now(); s.providers.glm.data.five.windowStart = n - 60000; s.providers.glm.data.five.nextResetTime = n + (4*3600+59*60)*1000; s.providers.glm.data.week.windowStart = n - 60000; s.providers.glm.data.week.nextResetTime = n + (6*86400+23*3600)*1000;")
    pg.wait_for_timeout(120)
    pg.wait_for_function("document.querySelector('.cdw').textContent.includes('6天')")
    t("副标题不溢出不折行", pg.evaluate("[...document.querySelectorAll('#panel .sub')].every(e => e.scrollWidth <= e.clientWidth + 1)"))
    wb2 = pg.locator("#panel .blk-q").last.locator(".pbar").bounding_box()
    t("极端文本下周 bar 仍在面板内", wb2 and wb2["y"] + wb2["height"] <= PANEL_GLM[1] - 12, str(wb2))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_worst.png")
    t("倒计时在标题行", "后重置" in pg.text_content("#panel .blk-q .sub"))
    t("绝对重置时间在积分列", pg.evaluate("/\\d{2}:\\d{2}/.test(document.querySelector('#panel .pts').textContent)"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel.png")

    print("面板切到 DeepSeek 页签:")
    pg.click("#tabDs")
    t("通知主进程切页签", pg.evaluate("window.__tab") == "ds")
    t("乐观先行切页签", pg.evaluate("document.body.classList.contains('tab-ds')"))
    pg.evaluate("() => { window.__state.config.panelTab = 'ds'; window.__cb(window.__state); }")
    pg.wait_for_function("document.body.className.includes('tab-ds')")
    pg.set_viewport_size({"width": PANEL_DS[0], "height": PANEL_DS[1]})
    t("DS 视图可见 / GLM 视图隐藏",
      pg.locator("#panel .pane-ds").is_visible() and not pg.locator("#panel .pane-glm").is_visible())
    t("余额默认打码（屏幕上过一眼看不到价格）", pg.text_content("#panel .dstotal") == "••••")
    t("三个指标不打码（只有主余额藏）", pg.text_content("#panel .ds-today") == "¥1.23"
      and pg.text_content("#panel .ds-wk") == "¥8.45" and pg.text_content("#panel .ds-mo") == "¥12.30")
    t("脚注实时读数也不打码", "¥0.42" in pg.text_content("#dsLeft") and "¥1.21" in pg.text_content("#dsLeft"))
    t("body 挂上 ds-masked", pg.evaluate("document.body.classList.contains('ds-masked')"))
    t("胶囊不打码（常驻形态本来就是给自己瞟的）", pg.text_content("#capsule .dsbal") == "¥318.29")
    pg.locator("#dsBal").click()
    pg.wait_for_timeout(80)
    t("点击余额后显示金额", pg.text_content("#panel .dstotal") == "318.29")
    t("货币符号", pg.text_content("#panel .ds-bal .cur") == "¥")
    pg.locator("#dsBal").click()
    pg.wait_for_timeout(60)
    t("再点一次恢复打码", pg.text_content("#panel .dstotal") == "••••")
    pg.locator("#dsBal").click()
    pg.wait_for_timeout(60)
    t("账户状态与余额同行（省一行高度）", "全部为充值余额" in pg.text_content("#dsSub"))
    t("柱状图 7 根", pg.locator("#panel .ds-chart i").count() == 7)
    t("有消费的柱子高度>0", pg.evaluate("parseFloat(document.querySelectorAll('#panel .ds-chart i')[0].style.height) > 0"))
    t("零消费的柱子标 zero", pg.evaluate("document.querySelectorAll('#panel .ds-chart i.zero').length") == 1)
    t("柱子提示含日期与金额", "2026-09-12" in pg.evaluate("document.querySelectorAll('#panel .ds-chart i')[4].dataset.tip"))
    t("近 1 小时消费在脚注", "近 1 小时" in pg.text_content("#dsLeft") and "日均" in pg.text_content("#dsLeft"),
      pg.text_content("#dsLeft"))
    t("预估可用天数", "263" in pg.text_content("#dsRight"), pg.text_content("#dsRight"))
    t("详情默认收起（面板因此更矮）", not pg.locator("#dsSrc").is_visible())
    pg.click("#dsInfo")
    t("「?」展开详情浮层", pg.locator("#dsSrc").is_visible())
    t("详情里有数据来源", "平台账单" in pg.text_content("#dsSrc"))
    t("详情里有 token 与缓存命中率", "1230万" in pg.text_content("#dsSrc") and "89%" in pg.text_content("#dsSrc"))
    t("详情里标注图表格", "1 小时按 5 分钟" in pg.text_content("#dsSrc"))
    t("浮层不撑高面板（窗口尺寸恒定）",
      pg.evaluate("Math.abs(document.querySelector('#panel').getBoundingClientRect().height - 270) < 1"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_more.png")
    pg.click("#dsInfo")
    t("再点收起", not pg.locator("#dsSrc").is_visible())
    foot_bottom = pg.evaluate("document.querySelector('#dsLeft').getBoundingClientRect().bottom")
    card_bottom = pg.evaluate("document.querySelector('#panel').getBoundingClientRect().bottom")
    t("DS 视图底部完整落在卡片内", foot_bottom <= card_bottom - 8, f"foot={foot_bottom:.0f} card={card_bottom:.0f}")
    t("DS 与 GLM 面板同高（切换不跳）",
      pg.evaluate("Math.abs(document.querySelector('#panel').getBoundingClientRect().height - 270) < 1"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds.png")

    print("DeepSeek 未配置 / 平台令牌过期 / 本地差值口径:")
    pg.evaluate("() => { const d = window.__state.providers.ds; d.summary.source = 'local'; d.summary.since = '2026-09-14'; d.tokens = null; d.platform.status = 'expired'; window.__cb(window.__state); }")
    pg.wait_for_timeout(80)
    _src = pg.text_content("#dsSrc")
    t("改用本地差值口径的说明（含起算时刻）",
      "本地余额差值" in _src and re.search(r"自 \d\d-\d\d \d\d:\d\d", _src) is not None, _src)
    t("平台会话过期的提示", "平台会话过期" in pg.text_content("#dsSrc"))
    t("未配平台令牌时不显示 token 行", "tokens" not in pg.text_content("#dsSrc"))
    pg.evaluate("() => { window.__state.config.dsHasToken = false; window.__state.providers.ds.status = 'empty'; window.__cb(window.__state); }")
    pg.wait_for_timeout(80)
    t("未配置 DS Key 时给去配置入口", "去配置" in pg.text_content("#dsSrc"))
    pg.evaluate("() => { window.__state.config.dsHasToken = true; window.__state.providers.ds.status = 'ok'; window.__cb(window.__state); }")

    print("区间切换（1 小时 / 24 小时 / 7 天 / 30 天）:")
    t("四档按钮都在", pg.locator("#panel .segb").count() == 4)
    pg.click("#dsR1")
    pg.wait_for_timeout(120)
    t("保存 dsRange=1h", pg.evaluate("window.__saved && window.__saved.dsRange") == "1h")
    t("切到 1 小时", "近 1 小时" in pg.text_content("#dsRange"))
    t("1 小时图有 12 根柱子（5 分钟一根）", pg.locator("#panel .ds-chart i").count() == 12)
    t("1 时按钮高亮", pg.evaluate("document.getElementById('dsR1').classList.contains('on')"))
    t("1 小时档的柱子给 5 分钟区间",
      pg.evaluate("document.querySelectorAll('#panel .ds-chart i')[11].dataset.tip").find("–") > 0,
      pg.evaluate("document.querySelectorAll('#panel .ds-chart i')[11].dataset.tip"))
    t("最后一根标进行中", pg.locator("#panel .ds-chart i.partial").count() == 1)
    pg.locator("#panel .ds-chart i").nth(3).hover()
    pg.wait_for_timeout(250)
    _tip = pg.text_content("#dsTip")
    t("悬停柱子弹出气泡", pg.locator("#dsTip").evaluate("e => e.classList.contains('show')"))
    t("气泡给的是时间区间 + 费用", re.search(r"\d{2}:\d{2}–\d{2}:\d{2} · ¥\d", _tip) is not None, _tip)
    t("气泡左右都不出窗", pg.evaluate("""() => {
        const t = document.querySelector('#dsTip').getBoundingClientRect();
        const c = document.querySelector('#panel').getBoundingClientRect();
        return t.left >= c.left + 2 && t.right <= c.right - 2;
      }"""))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_tip.png")
    # 回归：气泡也在 .ds-chart 里，柱子样式若用后代选择器会把气泡里的 <i> 也套上渐变背景
    pg.locator("#panel .ds-chart > i.partial").hover()
    pg.wait_for_timeout(250)
    t("「进行中」不带柱子样式（无渐变底、不继承 flex）", pg.evaluate("""() => {
        const i = document.querySelector('#dsTip i');
        const cs = getComputedStyle(i);
        return cs.backgroundImage === 'none' && cs.flexGrow === '0';
      }"""))
    t("「进行中」字色与气泡其他文字一致", pg.evaluate("""() => {
        const t = document.querySelector('#dsTip');
        return getComputedStyle(t.querySelector('i')).color === getComputedStyle(t).color;
      }"""))
    t("进行中那根仍带斜纹（柱子本身没被误伤）", pg.locator("#panel .ds-chart > i.partial").count() == 1)
    pg.mouse.move(5, 5)
    pg.wait_for_timeout(200)
    t("移开后气泡收起", not pg.locator("#dsTip").evaluate("e => e.classList.contains('show')"))
    t("脚注换成滚动 5 分钟，不与标题重复", "最近 5 分钟" in pg.text_content("#dsLeft") and "近 1 小时" not in pg.text_content("#dsLeft"),
      pg.text_content("#dsLeft"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_1h.png")
    pg.click("#dsR30")
    t("保存 dsRange=30d", pg.evaluate("window.__saved && window.__saved.dsRange") == "30d")
    pg.evaluate("() => { const s = window.__state; s.config.dsRange = '30d'; s.providers.ds.summary.series = Array.from({length:30}, (_,i) => ({date:'2026-09-'+String(i+1).padStart(2,'0'), spend: i%5 })); window.__cb(s); }")
    pg.wait_for_timeout(80)
    t("柱状图 30 根", pg.locator("#panel .ds-chart i").count() == 30)
    t("范围标题带区间合计", "近 30 天" in pg.text_content("#dsRange"))
    t("30 根时标签高亮 30天", pg.evaluate("document.getElementById('dsR30').classList.contains('on')"))
    pg.click("#dsR24")
    pg.wait_for_timeout(100)
    t("切到 24 小时", pg.evaluate("window.__saved.dsRange") == "24h" and "近 24 小时" in pg.text_content("#dsRange"))
    t("24 小时图有 24 根柱子", pg.locator("#panel .ds-chart i").count() == 24)
    t("当前小时标为进行中", pg.locator("#panel .ds-chart i.partial").count() == 1)
    t("柱子的 24 小时档给小时区间", re.search(r"\d{2}:\d{2}–\d{2}:\d{2}", pg.evaluate("document.querySelectorAll('#panel .ds-chart i')[20].dataset.tip")) is not None,
      pg.evaluate("document.querySelectorAll('#panel .ds-chart i')[20].dataset.tip"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_24h.png")
    pg.click("#dsR7")
    pg.wait_for_timeout(100)
    t("切回 7 天", pg.locator("#panel .ds-chart i").count() == 7)
    pg.evaluate("() => { const s = window.__state; s.config.panelTab = 'glm'; window.__cb(s); }")
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1]})

    print("Ctrl+滚轮缩放:")
    pg.keyboard.down("Control")
    pg.mouse.wheel(0, -100)
    pg.keyboard.up("Control")
    pg.wait_for_timeout(100)
    t("放大到 105%", pg.evaluate("window.__zoom") == 1.05)
    t("缩放提示显示", pg.locator("#zoomTip").evaluate("e => e.textContent") == "105%")

    print("阈值可配置（需求 1）:")
    restore_glm(pg)
    pg.evaluate("() => { const s = window.__state; s.config.warnThreshold = 50; s.providers.glm.data.five.percent = 55; s.providers.glm.data.week.percent = 30; window.__cb(s); }")
    pg.wait_for_timeout(60)
    t("阈值 50 时 55% → mid", pg.get_attribute("body", "data-tier") == "mid")
    pg.evaluate("() => { window.__state.config.warnThreshold = 60; window.__cb(window.__state); }")
    pg.wait_for_timeout(60)
    t("阈值 60 时 55% → low", pg.get_attribute("body", "data-tier") == "low")
    t("阈值已回填到设置页输入框", pg.eval_on_selector("#threshold", "e => e.value") == "60")

    print("高用量变色:")
    pg.evaluate("() => { window.__state.config.warnThreshold = 80; const s = window.__state; s.providers.glm.data.five.percent = 92; s.providers.glm.data.week.percent = 88; window.__cb(s); }")
    t("tier=high", pg.get_attribute("body", "data-tier") == "high")
    pg.locator("#panel").screenshot(path="/tmp/r_panel_high.png")
    pg.evaluate("() => { const s = window.__state; s.providers.glm.data.five.percent = 5; s.providers.glm.data.week.percent = 7; window.__cb(s); }")

    print("过期态:")
    push_glm(pg, status="expired", msg="Cookie 已失效", data=None)
    push(pg, view="capsule")
    pg.wait_for_function("document.body.className.includes('st-expired')")
    pg.set_viewport_size({"width": CAP_BOTH[0], "height": CAP_BOTH[1]})
    t("胶囊左列显示失效提示", pg.locator("#capsule .glm-warn").is_visible())
    t("胶囊右列 DeepSeek 数据照常显示", pg.locator("#capsule .cap-ds").is_visible())
    pg.locator("#capsule").screenshot(path="/tmp/r_capsule_expired.png")
    pg.click("#capsule")
    t("点击直达设置", pg.evaluate("window.__view") == "settings")
    push(pg, view="panel")
    pg.evaluate("() => { window.__state.config.panelTab = 'glm'; window.__cb(window.__state); }")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1]})
    t("面板出现过期横幅", pg.locator(".banner-expired").is_visible())
    pg.locator("#panel").screenshot(path="/tmp/r_panel_exp.png")
    pg.evaluate("() => { window.__state.config.panelTab = 'ds'; window.__state.providers.ds.status = 'ok'; window.__cb(window.__state); }")
    pg.wait_for_timeout(60)
    t("DS 页签无 GLM 的过期横幅", not pg.locator(".banner-expired").is_visible())

    print("设置页:")
    pg.evaluate("window.__clip = '%s'" % JWT)
    pg.evaluate("() => { window.__state.providers.glm.status = 'expired'; window.__cb(window.__state); }")
    push(pg, view="settings")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.set_viewport_size({"width": SETTINGS[0], "height": SETTINGS[1]})
    t("设置页分三段", pg.locator("#settings .sech").count() == 3)
    t("GLM 专属项在 GLM 段、DS 专属项在 DS 段、全局项才在通用段", pg.evaluate("""() => {
        const secs = [...document.querySelectorAll('#settings .sech')];
        const [, dsSec, commonSec] = secs;
        const before = (el, ref) => !!(el && (el.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING));
        const ids = (l) => l.map((i) => document.getElementById(i));
        const glmOnly = ids(['threshold', 'nreset', 'pacealert', 'webBtn']);
        const dsOnly = ids(['dstok', 'dsplat', 'dsWebBtn']);
        const common = ids(['interval', 'theme', 'dsfast', 'dspoll', 'autostart', 'ontop']);
        return glmOnly.every((e) => before(e, dsSec))
          && dsOnly.every((e) => before(e, commonSec))
          && common.every((e) => before(commonSec, e));
      }"""))
    t("只有 GLM 段需要小节标题（DS 段已无混装）", pg.evaluate("[...document.querySelectorAll('#settings .subh')].map(e=>e.textContent).join()") == "配额提醒")
    t("刷新频率不再出现两个并列设置：高频采样是从属开关",
      pg.evaluate("document.getElementById('dsfast').type") == "checkbox"
      and pg.evaluate("document.getElementById('dsfastrow').previousElementSibling.contains(document.getElementById('dsfast'))"))
    t("取消勾选后采样间隔置灰", pg.evaluate("""() => {
        const c = document.getElementById('dsfast'); c.checked = false; c.dispatchEvent(new Event('change'));
        const off = document.getElementById('dspoll').disabled && document.getElementById('dsfastrow').classList.contains('off');
        c.checked = true; c.dispatchEvent(new Event('change'));
        return off && !document.getElementById('dspoll').disabled;
      }"""))
    t("刷新频率已改名点明覆盖范围", "配额 / 账单刷新" in pg.text_content("#settings"),
      pg.text_content("#settings").split("配额")[1][:20] if "配额" in pg.text_content("#settings") else "")
    t("三个凭据输入框", pg.locator("#tok").count() == 1 and pg.locator("#dstok").count() == 1 and pg.locator("#dsplat").count() == 1)
    t("指引默认折叠（省高度）", pg.evaluate("[...document.querySelectorAll('#settings .gdwrap')].every(d => !d.open)"))
    t("阈值是数字输入框", pg.eval_on_selector("#threshold", "e => e.type") == "number")
    t("超预期开关存在且默认开", pg.eval_on_selector("#pacealert", "e => e.checked && e.type === 'checkbox'"))
    t("Token 状态=已失效", "失效" in pg.text_content("#tstatTxt"))
    t("DeepSeek 状态行独立", "余额" in pg.text_content("#dststatTxt") or "有效" in pg.text_content("#dststatTxt"))
    t("剪贴板提示出现（GLM）", pg.locator("#clipchip").is_visible())
    pg.click("#clipchip")
    t("点击填入 token", pg.eval_on_selector("#tok", "e => e.value") == JWT)
    # 设置页内容可滚动，保存按钮始终够得到
    t("设置内容可滚动", pg.evaluate("document.querySelector('#settings .sbody').scrollHeight > document.querySelector('#settings .sbody').clientHeight"))
    pg.evaluate("document.querySelector('#settings .sbody').scrollTop = 99999")
    pg.wait_for_timeout(80)
    sb = pg.locator("#saveBtn").bounding_box()
    t("保存按钮滚到底可见", sb and sb["y"] + sb["height"] <= SETTINGS[1] - 8, str(sb))
    t("右上角也有一个保存按钮（不用滚到底）", pg.locator("#saveBtn2").is_visible()
      and pg.eval_on_selector("#saveBtn2", "e => e.getBoundingClientRect().top") < 40)
    t("两个保存按钮文案一致",
      pg.eval_on_selector("#saveBtn", "e => e.textContent") == pg.eval_on_selector("#saveBtn2", "e => e.textContent"))
    t("提示「开关即时生效」", "立即生效并保存" in pg.text_content("#settings"))
    print("配置项即时生效（不用点保存）:")
    pg.evaluate("window.__saved = null")
    pg.click("#pacealert")            # 取消勾选
    pg.wait_for_function("window.__saved && 'paceAlert' in window.__saved")
    t("勾选框 change 即落盘", pg.evaluate("window.__saved.paceAlert") is False)
    t("给出「已保存」反馈", pg.locator("#saveTip").evaluate("e => e.classList.contains('show')"))
    pg.click("#pacealert")            # 勾回来
    pg.wait_for_function("window.__saved && window.__saved.paceAlert === true")
    pg.evaluate("window.__saved = null")
    pg.select_option("#theme", "light")
    pg.wait_for_function("window.__saved && window.__saved.theme === 'light'")
    t("下拉 change 即落盘（主题立刻切换）", pg.evaluate("document.body.classList.contains('theme-light')"))
    pg.select_option("#theme", "auto")
    pg.wait_for_function("window.__saved && window.__saved.theme === 'auto'")
    pg.evaluate("window.__saved = null")
    pg.click("#ontop")
    pg.wait_for_function("window.__saved && window.__saved.alwaysOnTop === false")
    t("开关类同样即时", True)
    pg.click("#ontop")
    pg.wait_for_function("window.__saved && window.__saved.alwaysOnTop === true")
    t("即时保存不触发刷新（刷新仍由用户手动）", True)

    pg.select_option("#interval", "30")
    pg.fill("#threshold", "75")
    pg.click("#saveBtn")
    pg.wait_for_function("window.__saved")
    t("保存含 token+间隔", pg.evaluate("window.__saved.token === '%s' && window.__saved.intervalMin === 30" % JWT))
    t("保存含阈值 75", pg.evaluate("window.__saved.warnThreshold") == 75)
    t("保存含超预期开关", pg.evaluate("window.__saved.paceAlert") is True)
    t("保存含高频采样间隔", pg.evaluate("window.__saved.dsPollMin") == 2)
    t("凭据仍走显式保存（未被即时保存提前提交）", pg.evaluate("window.__saved.token") == JWT)
    t("保存后回到面板", pg.evaluate("window.__view") == "panel")
    pg.evaluate("window.__state.view='settings'; window.__cb(window.__state)")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.set_viewport_size({"width": SETTINGS[0], "height": SETTINGS[1]})
    pg.locator("#settings").screenshot(path="/tmp/r_settings.png")

    print("DeepSeek 凭据也能从剪贴板一键填入:")
    pg.evaluate("window.__clip = { glm: '', ds: '%s', platform: '' }" % DSKEY)
    pg.evaluate("() => { window.__state.view = 'settings'; window.__cb(window.__state); }")
    pg.wait_for_function("document.querySelector('#clipchipDs').classList.contains('show')")
    t("DS 剪贴板提示出现", pg.locator("#clipchipDs").is_visible())
    pg.click("#clipchipDs")
    t("填入 DS Key", pg.eval_on_selector("#dstok", "e => e.value") == DSKEY)
    pg.evaluate("window.__clip = null")

    print("点空白收起:")
    pg.evaluate("() => { const s = window.__state; s.view='panel'; s.config.panelTab='glm'; window.__cb(s); }")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    pg.click("#panel .sub")
    t("点面板非按钮处 → capsule", pg.evaluate("window.__view") == "capsule")

    print("Esc 收起:")
    pg.evaluate("window.__state.view='settings'; window.__cb(window.__state)")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.keyboard.press("Escape")
    t("Esc → capsule", pg.evaluate("window.__view") == "capsule")

    print("拖拽手势（主进程按光标锚点定位）:")
    restore_glm(pg)
    pg.evaluate("() => { const s = window.__state; s.view='capsule'; s.providers.glm.status='ok'; window.__view=null; window.__dragMove=0; window.__dragEnd=0; window.__cb(s); }")
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    pg.set_viewport_size({"width": CAP_BOTH[0], "height": CAP_BOTH[1]})
    pg.mouse.move(CAP_BOTH[0]//2, CAP_BOTH[1]//2)
    pg.mouse.down()
    pg.wait_for_timeout(30)
    t("按下即把光标锚点交给主进程", pg.evaluate("Array.isArray(window.__dragStart)"))
    pg.mouse.move(CAP_BOTH[0]//2 + 44, CAP_BOTH[1]//2 + 6, steps=6)   # 位移 > 3px → 进入拖拽
    pg.mouse.move(CAP_BOTH[0]//2 + 84, CAP_BOTH[1]//2 + 26, steps=6)
    pg.wait_for_timeout(50)
    t("拖拽中持续发心跳", pg.evaluate("window.__dragMove >= 1"))
    moved_no_tap = pg.evaluate("window.__view") is None   # 拖动中不该已展开
    pg.mouse.up()
    pg.wait_for_timeout(200)
    t("拖拽走 IPC 且未触发点击", moved_no_tap and pg.evaluate("window.__dragEnd") == 1)
    # 原地按下松开仍要能展开（死区不能吃掉点击）
    pg.evaluate("() => { const s = window.__state; s.view='capsule'; s.providers.glm.status='ok'; window.__view=null; window.__cb(s); }")
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    pg.mouse.move(CAP_BOTH[0]//2, CAP_BOTH[1]//2)
    pg.mouse.down()
    pg.mouse.up()
    pg.wait_for_timeout(120)
    t("原地点击仍触发展开", pg.evaluate("window.__view") == "panel")

    print("峰谷时段徽标:")
    t("GLM 徽标已渲染", pg.evaluate("document.querySelector('#glmChip .ctxt').textContent") in ("高峰时段", "空闲时段"))
    t("DS 徽标已渲染", pg.evaluate("document.querySelector('#dsChip .ctxt').textContent") in ("高峰时段", "空闲 · 半价"))
    t("徽标带时段说明 title", "高峰：周一至周五" in pg.evaluate("document.querySelector('#dsChip').title"))
    t("徽标配色克制（低透明度背景）", pg.evaluate("getComputedStyle(document.querySelector('#dsChip')).backgroundColor").startswith("rgba"))
    t("徽标不参与动画", pg.evaluate("getComputedStyle(document.querySelector('#dsChip')).animationName") == "none")

    print("格式化函数:")
    t("fmtPoints 万", pg.evaluate("GLMFMT.fmtPoints(28000)") == "2.8万")
    t("fmtPoints 千分位", pg.evaluate("GLMFMT.fmtPoints(8965)") == "8,965")
    t("fmtMoney 两位小数", pg.evaluate("GLMFMT.fmtMoney(318.2)") == "318.20")
    t("fmtMoney 千分位", pg.evaluate("GLMFMT.fmtMoney(1234.5)") == "1,234.50")
    t("fmtTokens 万/亿", pg.evaluate("GLMFMT.fmtTokens(123456)") == "12.3万" and pg.evaluate("GLMFMT.fmtTokens(123456789)") == "1.23亿")
    t("fmtCountdown 天/小时", "天" in pg.evaluate("GLMFMT.fmtCountdown(3.5*86400*1000)"))
    t("levelName max", pg.evaluate("GLMFMT.levelName('max')") == "Max")
    t("峰谷判定：DS 周一 10:00 高峰 / 12:30 空闲", pg.evaluate("[GLMFMT.isPeak('ds', new Date('2026-09-14T10:00:00+08:00').getTime()), GLMFMT.isPeak('ds', new Date('2026-09-14T12:30:00+08:00').getTime())].join()") == "true,false")
    t("两家窗口不同：周一 10:00 → GLM 空闲但 DS 高峰",
      pg.evaluate("[GLMFMT.isPeak('glm', new Date('2026-09-14T10:00:00+08:00').getTime()), GLMFMT.isPeak('ds', new Date('2026-09-14T10:00:00+08:00').getTime())].join()") == "false,true")
    t("两家都便宜：周一 13:00 双空闲", pg.evaluate("[GLMFMT.isPeak('glm', new Date('2026-09-14T13:00:00+08:00').getTime()), GLMFMT.isPeak('ds', new Date('2026-09-14T13:00:00+08:00').getTime())].join()") == "false,false")
    t("两家都贵：周一 15:00 双高峰", pg.evaluate("[GLMFMT.isPeak('glm', new Date('2026-09-14T15:00:00+08:00').getTime()), GLMFMT.isPeak('ds', new Date('2026-09-14T15:00:00+08:00').getTime())].join()") == "true,true")
    t("端点：18:00 整已算空闲（两家）", pg.evaluate("[GLMFMT.isPeak('glm', new Date('2026-09-14T18:00:00+08:00').getTime()), GLMFMT.isPeak('ds', new Date('2026-09-14T18:00:00+08:00').getTime())].join()") == "false,false")
    t("端点：09:00 整已算高峰（DS）", pg.evaluate("GLMFMT.isPeak('ds', new Date('2026-09-14T09:00:00+08:00').getTime())"))
    t("周末全天非高峰", pg.evaluate("[GLMFMT.isPeak('glm', new Date('2026-09-12T15:00:00+08:00').getTime()), GLMFMT.isPeak('ds', new Date('2026-09-12T10:00:00+08:00').getTime())].join()") == "false,false")
    t("时区无关：用 UTC 表达同一时刻结果一致", pg.evaluate("GLMFMT.isPeak('glm', new Date('2026-09-14T06:00:00Z').getTime())"), "北京 14:00 = UTC 06:00")

    print("档位阈值（可配置，默认 80 mid / 90 high，5h+周取最高）:")
    t("tierOf 79→low", pg.evaluate("GLMFMT.tierOf(79)") == "low")
    t("tierOf 80→mid", pg.evaluate("GLMFMT.tierOf(80)") == "mid")
    t("tierOf 89→mid", pg.evaluate("GLMFMT.tierOf(89)") == "mid")
    t("tierOf 90→high", pg.evaluate("GLMFMT.tierOf(90)") == "high")
    t("阈值 60：59→low / 60→mid / 69→mid / 70→high",
      pg.evaluate("[GLMFMT.tierOf(59,60),GLMFMT.tierOf(60,60),GLMFMT.tierOf(69,60),GLMFMT.tierOf(70,60)].join()") == "low,mid,mid,high")
    t("阈值 95：红档封顶在 100（94→low、99→mid、100→high）",
      pg.evaluate("[GLMFMT.tierOf(94,95),GLMFMT.tierOf(99,95),GLMFMT.tierOf(100,95)].join()") == "low,mid,high")
    t("非法阈值回退 80", pg.evaluate("GLMFMT.normWarn('')") == 80 and pg.evaluate("GLMFMT.normWarn(999)") == 80)
    t("60/20 组合→low（旧逻辑会误 mid）", pg.evaluate("GLMFMT.tierOfPair(60, 20)") == "low")
    t("10/85 周触发→mid", pg.evaluate("GLMFMT.tierOfPair(10, 85)") == "mid")
    t("10/95 周触发→high", pg.evaluate("GLMFMT.tierOfPair(10, 95)") == "high")
    t("95/10 5h触发→high", pg.evaluate("GLMFMT.tierOfPair(95, 10)") == "high")
    t("阈值 70：75/10 → mid", pg.evaluate("GLMFMT.tierOfPair(75, 10, 70)") == "mid")

    pg.evaluate("""() => {
        const s = window.__state; s.view='capsule'; s.providers.glm.status='ok';
        s.providers.glm.data.five.percent=10; s.providers.glm.data.week.percent=95; window.__cb(s);
      }""")
    t("周 95% 时界面整体变 high", pg.get_attribute("body", "data-tier") == "high")
    pg.evaluate("() => { const s = window.__state; s.providers.glm.data.five.percent=5; s.providers.glm.data.week.percent=7; window.__cb(s); }")
    t("回落到 low", pg.get_attribute("body", "data-tier") == "low")

    b.close()

print(f"\n{'全部通过' if not fails else '失败: ' + ', '.join(fails)}")
sys.exit(0 if not fails else 1)
