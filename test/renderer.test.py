#!/usr/bin/env python3
"""渲染层测试：mock window.glm 桥，验证 胶囊(多列)/面板(动态页签+账户chips)/设置(账户管理) 各状态与交互
（经本地 HTTP 提供页面，并仅在测试中剥掉 CSP 以便 evaluate 推送状态）"""
import pathlib, sys, re, threading, functools, http.server, json
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

# 窗口尺寸：卡片 + 2×12 padding。胶囊卡片是 max-content，宽高由内容决定，渲染层实测后上报
# （window.__capSize），所以这里的 viewport 跟着上报值走 —— 不再按 meta.capsuleW 估。
PAD = 12
CAP_BOTH = (207, 64)     # 双列胶囊（实测 183 → 183+24）
PANEL_GLM = (350, 294)
PANEL_DS = (350, 294)   # 与 GLM 视图同高
SETTINGS = (416, 736)


def fit_window(pg):
    """把 viewport 调成「渲染层实测的胶囊尺寸 + 2×PAD」——模拟主进程按上报值改窗口"""
    sz = pg.evaluate("window.__capSize")
    if sz:
        pg.set_viewport_size({"width": sz["w"] + 2 * PAD, "height": sz["h"] + 2 * PAD})
    return sz


def fit_panel(pg):
    """把 viewport 调成「渲染层实测的面板高 + 2×PAD」——模拟主进程按上报值改窗口"""
    sz = pg.evaluate("window.__panelSize")
    if sz:
        pg.set_viewport_size({"width": PANEL_GLM[0], "height": sz["h"] + 2 * PAD})
    return sz


def capsule_pad(pg):
    """卡片左右两侧的留白（内容盒到卡片边框的距离），应当恒等于 1px 边框 + 11px 内边距"""
    return pg.evaluate("""() => {
        const card = document.querySelector('#capsule').getBoundingClientRect();
        const kids = [...document.querySelectorAll('#capsule > .cap-grp, #capsule > .cap-sep')];
        if (!kids.length) return null;
        const boxes = kids.map(k => k.getBoundingClientRect());
        return { l: +Math.min(...boxes.map(b => b.left)).toFixed(2) - card.left,
                 r: card.right - +Math.max(...boxes.map(b => b.right)).toFixed(2) };
      }""")

NOW_EXPR = "Date.now()"


def make_state():
    """基础状态：每家 1 个账户（chips/角标不出现，与单账户时代的布局一致）"""
    return {
        "view": "capsule", "hasAcrylic": False, "theme": "dark", "platform": "win32", "worstTier": "low",
        "providers": {
            "glm": {
                "name": "GLM Coding Plan", "tab": "GLM", "tier": "low",
                "accounts": [{"id": "a1", "name": "主号", "enabled": True, "status": "ok", "msg": "",
                              "lastFetchAt": "NOW-60000", "data": "GLMDATA", "tier": "low"}],
                "activeId": "a1",
            },
            "deepseek": {
                "name": "DeepSeek 官方 API", "tab": "DeepSeek", "tier": None,
                "accounts": [{"id": "d1", "name": "DeepSeek", "enabled": True, "status": "ok", "msg": "",
                              "lastFetchAt": "NOW-60000", "data": "DSDATA"}],
                "activeId": "d1",
            },
        },
        "config": {
            "intervalMin": 10, "warnThreshold": 80, "paceAlert": True, "notifyReset": False,
            "autoStart": True, "alwaysOnTop": True, "zoom": 1, "theme": "auto", "panelTab": "glm",
            "dsRange": "7d", "dsPollMin": 2, "isPortable": False, "capsuleLayout": "switch",
            "active": {"glm": "a1", "deepseek": "d1"},
            "accounts": [
                {"id": "a1", "provider": "glm", "name": "主号", "enabled": True,
                 "creds": {"token": {"set": True, "tail": "0LD_OLD"}}},
                {"id": "d1", "provider": "deepseek", "name": "DeepSeek", "enabled": True,
                 "creds": {"apiKey": {"set": True, "tail": "def"}, "platformToken": {"set": True, "tail": "xyz"}}},
            ],
        },
    }


GLM_DATA = {
    "level": "max",
    "five": {"percent": 5, "used": 1585, "total": 28000, "remaining": 26415,
             "nextResetTime": "NOW+4.7H", "windowStart": "NOW-0.3H"},
    "week": {"percent": 7, "used": 10407, "total": 140000, "remaining": 129593,
             "nextResetTime": "NOW+99H", "windowStart": "NOW-48H"},
    "fetchedAt": "NOW-60000",
}

DS_DATA = {
    "balance": {"currency": "CNY", "total": 318.29, "granted": 0, "toppedUp": 318.29, "available": True},
    "summary": {"source": "platform", "today": 1.23, "last7": 8.45, "last30": 21.7, "month": 12.3,
                "avg7": 1.21, "daysLeft": 263, "days": 7, "monthLabel": "2026-09", "currency": "CNY",
                "byModel": [{"model": "deepseek-flash", "cost": 12.3}], "since": "2026-09-01", "samples": 9,
                "last1h": 0.42, "last5m": 0.08, "firstSampleAt": "NOW-26H",
                "fine": "FINE_SERIES", "hourly": "HOURLY_SERIES",
                "series": [{"date": "2026-09-08", "spend": 0.5}, {"date": "2026-09-09", "spend": 0},
                           {"date": "2026-09-10", "spend": 2.1}, {"date": "2026-09-11", "spend": 1.4},
                           {"date": "2026-09-12", "spend": 3.0}, {"date": "2026-09-13", "spend": 0.22},
                           {"date": "2026-09-14", "spend": 1.23}]},
    "tokens": {"total": {"promptTokens": 9000000, "cacheHit": 8000000, "cacheMiss": 1000000,
                         "response": 3300000, "request": 1200, "total": 12300000},
               "byModel": []},
    "platform": {"status": "ok", "msg": "", "lastFetchAt": "NOW-60000"},
}

INIT = """
const NOW = Date.now();
const H = 3600e3, D = 86400e3;
const sub = (s) => {
  if (typeof s !== 'string') return s;
  const out = s.replace(/NOW-([\\d.]+)H/g, (_, n) => NOW - parseFloat(n) * H)
          .replace(/NOW\\+([\\d.]+)H/g, (_, n) => NOW + parseFloat(n) * H)
          .replace(/NOW-([\\d.]+)D/g, (_, n) => NOW - parseFloat(n) * D)
          .replace(/NOW-60000/g, NOW - 60000)
          .replace(/NOW/g, NOW);
  return /^-?\\d+(\\.\\d+)?$/.test(out.trim()) ? Number(out) : out;   // 全数字则转回数值（时间戳等）
};
const deep = (v) => (typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(deep)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);

const FINE = Array.from({length: 12}, (_, i) => ({
  ts: Math.floor((NOW - (11 - i) * 300e3) / 300e3) * 300e3,
  spend: [0,0.05,0,0.12,0,0,0.08,0,0,0.03,0,0.08][i], partial: i === 11 }));
const HOURLY = Array.from({length: 24}, (_, i) => ({
  ts: Math.floor((NOW - (23 - i) * 3600e3) / 3600e3) * 3600e3,
  spend: [1.2,0,0.4,2.0,0,0,0.8,0,0,3.1,0,0.2,0,0,1.5,0,0,0,0.6,0,0,0,0.3,0.42][i], partial: i === 23 }));

window.__state = deep(%s);
window.__state.providers.glm.accounts[0].data = deep(%s);
window.__state.providers.deepseek.accounts[0].data = deep(%s);
const glmData = window.__state.providers.glm.accounts[0].data;
glmData.five.nextResetTime = NOW + 4.7*H;
glmData.week.nextResetTime = NOW + (4*D + 7*H);
const dsData = window.__state.providers.deepseek.accounts[0].data;
dsData.summary.fine = FINE;
dsData.summary.hourly = HOURLY;
dsData.summary.firstSampleAt = NOW - 26*H;
window.__glmData = JSON.parse(JSON.stringify(glmData));
window.__view = null; window.__saved = null; window.__tab = null; window.__tray = null; window.__clip = null;
window.__ready = false; window.__ctx = 0; window.__activated = null;
window.__capSize = null; window.__capSizes = []; window.__menu = null; window.__panelSize = null; window.__panelSizes = [];
window.__dragStart = null; window.__dragMove = 0; window.__dragEnd = 0;
// 与主进程一致的最小凭据校验：填了但形态不对 → 桥返回 { err }（用来测「静默失败」那条链路）
const REQ = { glm: { token: /[A-Za-z0-9]{16,}\\.[A-Za-z0-9]{12,}|ey[A-Za-z0-9_-]{10,}\\./ },
              deepseek: { apiKey: /sk-[A-Za-z0-9]{16,}/ } };
const badCred = (provider, creds) => Object.entries(REQ[provider] || {})
  .find(([k, re]) => { const v = String((creds || {})[k] || '').trim(); return v && !re.test(v); });
window.glm = {
  getState: async () => window.__state,
  save: async (patch) => {
    window.__saved = patch;
    window.__state.config = {...window.__state.config, ...patch};
    if (patch.theme && patch.theme !== 'auto') window.__state.theme = patch.theme;
    return window.__state;
  },
  refreshNow: async () => window.__state,
  clipboardPeek: async () => window.__clip,
  accAdd: async (p) => { window.__added = p;
    const bad = badCred(p.provider, p.credentials);
    if (bad) return { err: '识别不出「' + bad[0] + '」—— 粘贴的内容里没有可用的凭据，确认一下是不是粘错了字段、或没复制完整' };
    const id = 'new1'; const meta = { glm: ['token'], deepseek: ['apiKey','platformToken'] }[p.provider];
    const creds = {}; Object.keys(p.credentials || {}).forEach(k => creds[k] = { set: !!p.credentials[k], tail: 'newxx' });
    window.__state.config.accounts.push({ id, provider: p.provider, name: p.name || '新账户', enabled: true, creds });
    window.__state.providers[p.provider].accounts.push({ id, name: p.name || '新账户', enabled: true, status: 'loading', msg: '', lastFetchAt: 0, data: null });
    return window.__state; },
  accUpdate: async (p) => { window.__updated = p;
    const a = window.__state.config.accounts.find(x => x.id === p.id);
    const bad = badCred(a && a.provider, p.credentials);
    if (bad) return { err: '识别不出「' + bad[0] + '」—— 粘贴的内容里没有可用的凭据，确认一下是不是粘错了字段、或没复制完整' };
    return window.__state; },
  accRemove: async (p) => { window.__removed = p;
    window.__state.config.accounts = window.__state.config.accounts.filter(a => a.id !== p.id);
    for (const pid of Object.keys(window.__state.providers)) {
      window.__state.providers[pid].accounts = window.__state.providers[pid].accounts.filter(a => a.id !== p.id);
    }
    return window.__state; },
  accActivate: async (p) => {
    window.__activated = p;   // 记下「谁发过切换请求」——被拒的请求也留痕，测试据此看死循环
    const prov = window.__state.providers[p.provider] || { accounts: [] };
    const acc = prov.accounts.find(a => a.id === p.id);
    // 与主进程一致：停用的账户切不过去（返回 { err }，前端不该拿它当新状态）
    if (!acc || acc.enabled === false) return { err: '账户不存在或未启用' };
    prov.activeId = p.id;
    window.__state.config.active[p.provider] = p.id;
    return window.__state;
  },
  accMenu: async (p) => { window.__menu = p; return window.__state; },   // 原生菜单：只记请求
  capsuleSize: (s) => { window.__capSize = s; window.__capSizes.push(s); },
  panelSize: (s) => { window.__panelSize = s; window.__panelSizes = (window.__panelSizes || []).concat([s]); },
  setView: (v) => { window.__view = v; window.__state.view = v; },
  setTab: (t) => { window.__tab = t; window.__state.config.panelTab = t; },
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
""" % (json.dumps(make_state(), ensure_ascii=False), json.dumps(GLM_DATA), json.dumps(DS_DATA))

fails = []
def t(name, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{extra}]" if extra and not cond else ""))
    if not cond: fails.append(name)

def push(pg, **patch):
    pg.evaluate("p => { Object.assign(window.__state, p); window.__cb(window.__state); }", patch)

def push_glm_acc(pg, **patch):
    pg.evaluate("p => { Object.assign(window.__state.providers.glm.accounts[0], p); window.__cb(window.__state); }", patch)

def set_dev(pg, js):
    """在 evaluate 里改状态并推送（js 里用 s.providers.glm.accounts[0].data 这类路径）"""
    pg.evaluate("() => { const s = window.__state; %s window.__cb(s); }" % js)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": CAP_BOTH[0], "height": CAP_BOTH[1]})
    ctx.route("**/renderer/index.html", lambda r: r.fulfill(body=HTML_NOCSP, content_type="text/html; charset=utf-8"))
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    pg.goto(PAGE)
    pg.wait_for_function("document.querySelector('.pv5') && document.querySelector('.pv5').textContent !== '–'")

    print("胶囊 · 正常态（双列）:")
    t("就绪信号已发", pg.evaluate("window.__ready"))
    t("胶囊显示 5h 5%", pg.text_content(".pv5") == "5")
    t("周 7%", pg.text_content(".cap-glm .pvw") == "7")
    t("tier=low", pg.get_attribute("body", "data-tier") == "low")
    t("两组都在（glm 组 + ds 组）", pg.locator("#capsule .cap-grp").count() == 2)
    t("进度条宽度≈5%", pg.evaluate("getComputedStyle(document.querySelector('#capsule .f5')).width") not in ("", "0px"))
    t("DeepSeek 余额在胶囊右列", pg.text_content("#capsule .dsbal") == "¥318.29")
    t("今日消费在胶囊右列", "1.23" in pg.text_content("#capsule .dstoday"))
    t("分隔线可见", pg.locator("#capsule .cap-sep").count() == 1)
    t("单账户不出账户 chip", pg.locator("#capsule .acc-chip").count() == 0)
    t("单账户不占名字行（胶囊厚度=40）",
      abs(pg.evaluate("document.querySelector('#capsule').getBoundingClientRect().height") - 40) < 0.6)
    sz = fit_window(pg)
    t("上报实测尺寸给主进程", sz is not None, str(sz))
    t("上报值 = 卡片实际尺寸（内容驱动，不靠写死的列宽）", pg.evaluate("""() => {
        const r = document.querySelector('#capsule').getBoundingClientRect();
        return Math.ceil(r.width) === window.__capSize.w && Math.ceil(r.height) === window.__capSize.h;
      }"""))
    t("上报尺寸只发一次（没变就不重复发）", pg.evaluate("window.__capSizes.length") == 1,
      str(pg.evaluate("window.__capSizes")))
    _pad = capsule_pad(pg)
    t("左右留白对称（右边不再贴边框）", _pad and abs(_pad["l"] - _pad["r"]) < 0.6 and _pad["l"] >= 11.5, str(_pad))
    pg.click("#capsule", button="right")
    t("右键唤起应用菜单", pg.evaluate("window.__ctx") == 1)
    t("托盘图标已推送", pg.evaluate("window.__tray && window.__tray.startsWith('data:image/png')"))
    pg.locator("#capsule").screenshot(path="/tmp/r_capsule.png")

    print("数字位数变化 → 窗口跟着长（写死宽度会挤压出边框）:")
    set_dev(pg, "s.providers.deepseek.accounts[0].data.balance.total = 12345.67;")
    pg.wait_for_timeout(120)
    sz2 = fit_window(pg)
    t("余额变长后重新上报尺寸", sz2 and sz2["w"] > sz["w"], f'{sz} → {sz2}')
    t("变长后左右留白仍对称", capsule_pad(pg)["r"] >= 11.5, str(capsule_pad(pg)))
    set_dev(pg, "s.providers.deepseek.accounts[0].data.balance.total = 318.29;")
    pg.wait_for_timeout(120)
    fit_window(pg)

    print("只配 GLM 时右列收起:")
    set_dev(pg, "window.__dsBackup = JSON.parse(JSON.stringify(s.providers.deepseek));"
                " window.__dsAccBackup = JSON.parse(JSON.stringify(s.config.accounts.find(a => a.id === 'd1')));"
                " delete s.providers.deepseek;"
                " s.config.accounts = s.config.accounts.filter(a => a.id !== 'd1');")
    pg.wait_for_timeout(120)
    t("cap-ds 不再渲染", pg.locator("#capsule .cap-ds").count() == 0)
    t("分隔线消失", pg.locator("#capsule .cap-sep").count() == 0)
    t("GLM 列仍在", pg.locator("#capsule .cap-glm").is_visible())
    fit_window(pg)
    _pad1 = capsule_pad(pg)
    t("单列时左右留白也对称", _pad1 and abs(_pad1["l"] - _pad1["r"]) < 0.6, str(_pad1))
    set_dev(pg, "s.providers.deepseek = JSON.parse(JSON.stringify(window.__dsBackup));"
                " s.config.accounts.push(JSON.parse(JSON.stringify(window.__dsAccBackup)));")
    pg.wait_for_timeout(120)
    fit_window(pg)

    print("点击展开 → 面板（GLM 页签）:")
    pg.click("#capsule")
    t("setView('panel')", pg.evaluate("window.__view") == "panel")
    t("乐观先行切换（不等主进程回包）", pg.evaluate("document.body.classList.contains('view-panel')"))
    push(pg, view="panel")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    t("面板百分比对", pg.text_content("#panel .pane-glm .pv5") == "5")
    t("积分 1585/2.8万", pg.text_content("#panel .pane-glm .u5") == "1,585" and pg.text_content("#panel .pane-glm .t5") == "2.8万")
    t("5h 倒计时文案", pg.evaluate("/小时|分钟/.test(document.querySelector('.pane-glm .cd5').textContent)"))
    t("周倒计时含天", "天" in pg.text_content(".pane-glm .cdw"))
    t("套餐名 Max", pg.text_content("#tabs .lvl") == "Max")
    t("GLM 页签高亮", pg.evaluate("document.querySelector('#tabs .tab[data-pid=\\'glm\\']').classList.contains('on')"))
    t("GLM 视图可见 / DS 视图隐藏",
      pg.locator("#panel .pane-glm").is_visible() and not pg.locator("#panel .pane-ds").is_visible(),
      "glmDisplay=" + str(pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-glm')).display"))
      + " glmVisible=" + str(pg.locator("#panel .pane-glm").is_visible())
      + " glmStyle=" + str(pg.get_attribute("#panel .pane-glm", "style"))
      + " dsDisplay=" + str(pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-ds')).display"))
      + " dsStyle=" + str(pg.get_attribute("#panel .pane-ds", "style")))

    print("浅色主题切换:")
    pg.evaluate("s => { s.theme = 'light'; window.__cb(s); }", pg.evaluate("window.__state"))
    t("body 挂上 theme-light", pg.evaluate("document.body.classList.contains('theme-light')"))
    t("浅色底生效", pg.evaluate("getComputedStyle(document.querySelector('#panel')).backgroundColor") != "")
    pg.evaluate("s => { s.theme = 'dark'; window.__cb(s); }", pg.evaluate("window.__state"))
    t("切回深色移除 class", pg.evaluate("!document.body.classList.contains('theme-light')"))
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1]})   # 主进程先按兜底尺寸开窗
    pg.wait_for_timeout(150)
    fit_panel(pg)                                                          # 渲染层实测上报后再对齐
    fb = pg.locator("#panel .pane-glm .blk-q").last.locator(".pbar").bounding_box()
    t("面板内容完整可见", fb and fb["y"] + fb["height"] <= PANEL_GLM[1] - 12, str(fb))
    t("面板高度按实测上报（不再是写死的 270）", (pg.evaluate("window.__panelSize") or {}).get("h", 0) > 200,
      str(pg.evaluate("window.__panelSize")))
    pg.evaluate("window.__glmPanelH = window.__panelSize.h")

    print("预期进度标记（方案 D）:")
    t("面板幽灵+亮线+超支段挂载", pg.locator("#panel .pane-glm .pbar .ghost").count() == 2
      and pg.locator("#panel .pane-glm .pbar .edge").count() == 2 and pg.locator("#panel .pane-glm .pbar .ovr").count() == 2)
    t("胶囊幽灵挂载", pg.locator("#capsule .bar .ghost").count() == 2)
    t("胶囊 bar 未裁剪亮线", pg.evaluate("getComputedStyle(document.querySelector('#capsule .bar')).overflow") == "visible")
    pace5 = pg.evaluate("parseFloat(document.querySelector('.pane-glm').style.getPropertyValue('--pace5'))")
    t("5h 预期≈6%（0.3h/5h 时间均摊）", pace5 is not None and 5.3 <= pace5 <= 6.7, str(pace5))
    paceW = pg.evaluate("parseFloat(document.querySelector('.pane-glm').style.getPropertyValue('--paceW'))")
    t("周预期已计算", paceW is not None and 25 <= paceW <= 36, str(paceW))
    pg.locator("#panel .pane-glm .pbar").first.hover()
    pg.wait_for_timeout(250)
    t("悬停幽灵显示解释", "预期" in (pg.locator("#panel .pane-glm .ptip.show").first.inner_text() if pg.locator("#panel .pane-glm .ptip.show").count() else ""))
    t("解释含实际用量对照", pg.evaluate("[...document.querySelectorAll('#panel .pane-glm .ptip.show')].some(e => e.textContent.includes('实际'))"))

    print("超预期变色提醒（需求 2）:")
    t("常态无超支段", pg.evaluate("document.querySelector('.pane-glm').dataset.pace") == "ok")
    t("常态不显示 ▲ 标签", not pg.locator("#panel .pane-glm .blk-q[data-win='five'] .overchip").is_visible())
    t("常态不显示超预期说明", not pg.evaluate("document.querySelector('#panel .pane-glm .blk-note .overtxt').offsetParent"))
    # 预期压到 1%，实际 5% → 超出 4 个百分点
    set_dev(pg, "const n = Date.now(); const d = s.providers.glm.accounts[0].data;"
               " d.five.windowStart = n - 30000; d.five.nextResetTime = n + 5*3600*1000;")
    pg.wait_for_timeout(360)
    t("pane 标记 data-pace=over", pg.evaluate("document.querySelector('.pane-glm').dataset.pace") == "over")
    t("5h 块挂上 over", pg.evaluate("document.querySelector(\"#panel .pane-glm .blk-q[data-win='five']\").classList.contains('over')"))
    t("▲ 超预期 标签出现", pg.locator("#panel .pane-glm .blk-q[data-win='five'] .overchip").is_visible())
    t("底部备注不再写幽灵段（改由悬停解释）", "幽灵" not in pg.text_content("#panel .pane-glm .blk-note"), pg.text_content("#panel .pane-glm .blk-note"))
    t("超预期说明完整显示不截断", pg.evaluate("""() => {
        const t = document.querySelector('#panel .pane-glm .blk-note .overtxt');
        return t.offsetParent !== null && t.scrollWidth <= t.clientWidth + 1;
      }"""))
    t("周块不受牵连", not pg.evaluate("document.querySelector(\"#panel .pane-glm .blk-q[data-win='week']\").classList.contains('over')"))
    ovr5 = pg.evaluate("parseFloat(document.querySelector('.pane-glm').style.getPropertyValue('--over5'))")
    t("超支幅度≈4 个百分点", ovr5 is not None and 3.5 <= ovr5 <= 4.5, str(ovr5))
    t("超支段可见", pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-glm .pbar .ovr.o5')).opacity") == "1")
    ovrw = pg.evaluate("parseFloat(document.querySelector('.pane-glm').style.getPropertyValue('--overW'))")
    t("未超支的窗口 over=0（不会画出假的红段）", ovrw == 0, str(ovrw))
    pg.locator("#panel .pane-glm .pbar").first.hover()
    pg.wait_for_timeout(200)
    t("悬停解释含超出幅度", "超出预期" in pg.locator("#panel .pane-glm .ptip.show").first.inner_text())
    pg.locator("#panel").screenshot(path="/tmp/r_panel_over.png")
    # GLM 超预期不该把 DeepSeek 视图也染成琥珀（两家水位互不相干）
    pg.evaluate("() => { const s = window.__state; s.config.panelTab = 'deepseek'; window.__cb(s); }")
    pg.wait_for_timeout(120)
    t("DeepSeek 视图强调色不受 GLM 超预期影响",
      pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-ds')).getPropertyValue('--g1').trim()") != "#fbbf24")
    pg.evaluate("() => { const s = window.__state; s.config.panelTab = 'glm'; window.__cb(s); }")
    pg.wait_for_timeout(120)
    # 关掉开关 → 立刻恢复正常配色
    pg.evaluate("() => { window.__state.config.paceAlert = false; window.__cb(window.__state); }")
    pg.wait_for_timeout(360)
    t("关开关后不再超预期", pg.evaluate("document.querySelector('.pane-glm').dataset.pace") == "ok")
    t("关开关后超支段不显示", pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-glm .pbar .ovr.o5')).opacity") == "0")
    pg.evaluate("() => { window.__state.config.paceAlert = true; window.__cb(window.__state); }")
    set_dev(pg, "const n = Date.now(); const d = s.providers.glm.accounts[0].data;"
               " d.five.windowStart = n - 0.3*3600*1000; d.five.nextResetTime = n + 4.7*3600*1000;")

    print("配速极小时 tooltip 不截断:")
    set_dev(pg, "const n = Date.now(); const d = s.providers.glm.accounts[0].data;"
               " d.five.windowStart = n - 30000; d.five.nextResetTime = n + 5*3600*1000;")
    pg.wait_for_timeout(80)
    pg.locator("#panel .pane-glm .pbar").first.hover()
    pg.wait_for_timeout(250)
    box = pg.locator("#panel .pane-glm .ptip.show").first.bounding_box()
    t("气泡完整在窗口内", box and box["x"] >= 0 and box["x"] + box["width"] <= PANEL_GLM[0], str(box))
    set_dev(pg, "const n = Date.now(); const d = s.providers.glm.accounts[0].data;"
               " d.five.windowStart = n - 0.3*3600*1000; d.five.nextResetTime = n + 4.7*3600*1000;")

    print("极端文本不换行（最长倒计时+跨天日期）:")
    set_dev(pg, "const n = Date.now(); const d = s.providers.glm.accounts[0].data;"
               " d.five.windowStart = n - 60000; d.five.nextResetTime = n + (4*3600+59*60)*1000;"
               " d.week.windowStart = n - 60000; d.week.nextResetTime = n + (6*86400+23*3600)*1000;")
    pg.wait_for_timeout(120)
    pg.wait_for_function("document.querySelector('.pane-glm .cdw').textContent.includes('6天')")
    t("副标题不溢出不折行", pg.evaluate("[...document.querySelectorAll('#panel .pane-glm .sub')].every(e => e.scrollWidth <= e.clientWidth + 1)"))
    wb2 = pg.locator("#panel .pane-glm .blk-q").last.locator(".pbar").bounding_box()
    t("极端文本下周 bar 仍在面板内", wb2 and wb2["y"] + wb2["height"] <= PANEL_GLM[1] - 12, str(wb2))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_worst.png")
    t("倒计时在标题行", "后重置" in pg.text_content("#panel .pane-glm .blk-q .sub"))
    t("绝对重置时间在积分列", pg.evaluate("/\\d{2}:\\d{2}/.test(document.querySelector('#panel .pane-glm .pts').textContent)"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel.png")

    print("面板切到 DeepSeek 页签:")
    pg.click("#tabs .tab[data-pid='deepseek']")
    t("通知主进程切页签", pg.evaluate("window.__tab") == "deepseek")
    t("乐观先行切页签", pg.evaluate("document.querySelector('#panel .pane-ds').classList.contains('on')"))
    pg.evaluate("() => { window.__state.config.panelTab = 'deepseek'; window.__cb(window.__state); }")
    pg.wait_for_function("document.body.className.includes('tab-') || true")
    pg.wait_for_timeout(150)
    fit_panel(pg)
    pg.wait_for_timeout(120)
    t("DS 视图可见 / GLM 视图隐藏",
      pg.locator("#panel .pane-ds").is_visible() and not pg.locator("#panel .pane-glm").is_visible(),
      "ds=" + str(pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-ds')).display"))
      + " glm=" + str(pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-glm')).display"))
      + " glmStyle=" + str(pg.get_attribute("#panel .pane-glm", "style")))
    t("余额默认打码（屏幕上过一眼看不到价格）", pg.text_content("#panel .pane-ds .dstotal") == "••••")
    t("三个指标不打码（只有主余额藏）", pg.text_content("#panel .pane-ds .ds-today") == "¥1.23"
      and pg.text_content("#panel .pane-ds .ds-wk") == "¥8.45" and pg.text_content("#panel .pane-ds .ds-mo") == "¥12.30")
    t("脚注实时读数也不打码", "¥0.42" in pg.text_content("#panel .pane-ds .ds-left") and "¥1.21" in pg.text_content("#panel .pane-ds .ds-left"))
    t("pane 挂上 ds-masked", pg.evaluate("document.querySelector('#panel .pane-ds').classList.contains('ds-masked')"))
    t("胶囊不打码（常驻形态本来就是给自己瞟的）", pg.text_content("#capsule .dsbal") == "¥318.29")
    pg.locator("#panel .pane-ds .ds-bal").click()
    pg.wait_for_timeout(80)
    t("点击余额后显示金额", pg.text_content("#panel .pane-ds .dstotal") == "318.29")
    t("货币符号", pg.text_content("#panel .pane-ds .ds-bal .cur") == "¥")
    pg.locator("#panel .pane-ds .ds-bal").click()
    pg.wait_for_timeout(60)
    t("再点一次恢复打码", pg.text_content("#panel .pane-ds .dstotal") == "••••")
    pg.locator("#panel .pane-ds .ds-bal").click()
    pg.wait_for_timeout(60)
    t("账户状态与余额同行（省一行高度）", "全部为充值余额" in pg.text_content("#panel .pane-ds .ds-sub"))
    t("柱状图 7 根", pg.locator("#panel .pane-ds .ds-chart > i").count() == 7)
    t("有消费的柱子高度>0", pg.evaluate("parseFloat(document.querySelectorAll('#panel .pane-ds .ds-chart > i')[0].style.height) > 0"))
    t("零消费的柱子标 zero", pg.evaluate("document.querySelectorAll('#panel .pane-ds .ds-chart > i.zero').length") == 1)
    t("柱子提示含日期与金额", "2026-09-12" in pg.evaluate("document.querySelectorAll('#panel .pane-ds .ds-chart > i')[4].dataset.tip"))
    t("近 1 小时消费在脚注", "近 1 小时" in pg.text_content("#panel .pane-ds .ds-left") and "日均" in pg.text_content("#panel .pane-ds .ds-left"),
      pg.text_content("#panel .pane-ds .ds-left"))
    t("预估可用天数", "263" in pg.text_content("#panel .pane-ds .ds-right"), pg.text_content("#panel .pane-ds .ds-right"))
    t("详情默认收起（面板因此更矮）", not pg.locator("#panel .pane-ds .ds-more").is_visible())
    pg.click("#panel .pane-ds .qbtn")
    t("「?」展开详情浮层", pg.locator("#panel .pane-ds .ds-more").is_visible())
    t("详情里有数据来源", "平台账单" in pg.text_content("#panel .pane-ds .ds-more"))
    t("详情里有 token 与缓存命中率", "1230万" in pg.text_content("#panel .pane-ds .ds-more") and "89%" in pg.text_content("#panel .pane-ds .ds-more"))
    t("详情里标注图表格", "1 小时按 5 分钟" in pg.text_content("#panel .pane-ds .ds-more"))
    t("浮层不撑高面板（卡片高 = 上报的内容高）",
      pg.evaluate("Math.abs(document.querySelector('#panel').getBoundingClientRect().height - window.__panelSize.h) < 1"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_more.png")
    pg.click("#panel .pane-ds .qbtn")
    t("再点收起", not pg.locator("#panel .pane-ds .ds-more").is_visible())
    foot_bottom = pg.evaluate("document.querySelector('#panel .pane-ds .ds-left').getBoundingClientRect().bottom")
    card_bottom = pg.evaluate("document.querySelector('#panel').getBoundingClientRect().bottom")
    t("DS 视图底部完整落在卡片内", foot_bottom <= card_bottom - 8, f"foot={foot_bottom:.0f} card={card_bottom:.0f}")
    # 面板高度跟着当前页签走：DS 报自己那条（不再被别家页签顶高）
    t("DS 与 GLM 上报同一个高度（切换不跳）", pg.evaluate("window.__glmPanelH") == pg.evaluate("window.__panelSize.h"),
      f"{pg.evaluate('window.__glmPanelH')} vs {pg.evaluate('window.__panelSize.h') if pg.evaluate('window.__panelSize') else None}")
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds.png")

    print("DeepSeek 未配置 / 平台令牌过期 / 本地差值口径:")
    pg.evaluate("""() => { const d = window.__state.providers.deepseek.accounts[0].data;
        d.summary.source = 'local'; d.summary.since = '2026-09-14'; d.tokens = null; d.platform.status = 'expired';
        window.__cb(window.__state); }""")
    pg.wait_for_timeout(80)
    _src = pg.text_content("#panel .pane-ds .ds-more")
    t("改用本地差值口径的说明（含起算时刻）",
      "本地余额差值" in _src and re.search(r"自 \d\d-\d\d \d\d:\d\d", _src) is not None, _src)
    t("平台会话过期的提示", "平台会话过期" in pg.text_content("#panel .pane-ds .ds-more"))
    t("未配平台令牌时不显示 token 行", "tokens" not in pg.text_content("#panel .pane-ds .ds-more"))
    set_dev(pg, "s.config.accounts.find(a => a.id === 'd1').creds.apiKey.set = false;"
                " s.providers.deepseek.accounts[0].status = 'empty';")
    pg.wait_for_timeout(80)
    t("未配置 DS Key 时给去配置入口", "去配置" in pg.text_content("#panel .pane-ds .ds-more"))
    set_dev(pg, "s.config.accounts.find(a => a.id === 'd1').creds.apiKey.set = true;"
                " s.providers.deepseek.accounts[0].status = 'ok';")

    print("面板测量是只读的（不许为了量高度去改页签样式）:")
    styles_before = pg.evaluate("[...document.querySelectorAll('#panel .pane')].map(p => p.getAttribute('style'))")
    for _ in range(3):
        pg.evaluate("() => window.__cb(window.__state)")
        pg.wait_for_timeout(120)
    t("反复测量后页签样式一字未改",
      pg.evaluate("[...document.querySelectorAll('#panel .pane')].map(p => p.getAttribute('style'))") == styles_before)
    t("页签既没被脱流（position 仍是 static，永远留在布局里）",
      pg.evaluate("""() => [...document.querySelectorAll('#panel .pane')].every(p => getComputedStyle(p).position === 'static')"""))
    t("非当前页签靠 visibility 藏（高度照样参与，GLM / DeepSeek 取最高对齐）",
      pg.evaluate("""() => { const off = document.querySelector('#panel .pane:not(.on)');
          return off ? getComputedStyle(off).visibility === 'hidden' : true; }"""))
    t("当前页签内容完整可见（高度不是 0）",
      pg.evaluate("document.querySelector('#panel .pane.on').getBoundingClientRect().height") > 100)
    fit_panel(pg)
    pg.wait_for_timeout(150)

    print("面板高度自愈（量少了 → 窗口按偏低值就位 → 自检加码）:")
    fit_panel(pg)
    pg.wait_for_timeout(150)
    exact = pg.evaluate("window.__panelSize.h")
    # 忠实模拟「测量偏小」：把测量函数桩成比实际矮 80px
    pg.evaluate("""() => { window.__origPH = panesHeight; panesHeight = () => 120; }""")
    pg.evaluate("() => window.__cb(window.__state)")
    pg.wait_for_timeout(200)
    low = pg.evaluate("window.__panelSize.h")
    fit_panel(pg)                                     # 主进程按这个偏低值把窗口调好
    pg.wait_for_timeout(250)
    after = pg.evaluate("window.__panelSize.h")
    t("低估的高度被自检抓住并加码", after > low + 50, f"精确 {exact} / 误报 {low} / 自愈后 {after}")
    fit_panel(pg)                                     # 窗口跟上加码后的高度
    pg.wait_for_timeout(200)
    t("加码后内容完整可见",
      pg.evaluate("""() => { const p = document.querySelector('#panel .pane.on');
          const host = document.querySelector('#panel'); const cs = getComputedStyle(host);
          return p.lastElementChild.getBoundingClientRect().bottom
            <= host.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom) + 1.5; }"""))
    pg.evaluate("() => { const s = window.__state; s.worstTier = 'mid'; window.__cb(s); }")
    pg.wait_for_timeout(200)
    t("补偿单调（不会和窗口来回抖）", pg.evaluate("window.__panelSize.h") == after,
      f"{after} vs {pg.evaluate('window.__panelSize.h')}")
    # 收拾干净（补偿是会话级的，别影响后面的对齐断言）
    pg.evaluate("""() => { panesHeight = window.__origPH; healAsked = 0; lastPanelH = 0;
        window.__cb(window.__state); }""")
    pg.wait_for_timeout(200)
    fit_panel(pg)
    pg.wait_for_timeout(150)
    t("撤掉补偿后回到精确高度", pg.evaluate("window.__panelSize.h") == exact,
      f"{exact} vs {pg.evaluate('window.__panelSize.h')}")

    print("面板像素：两页签首行 / 末行 / 峰谷徽标对齐:")
    fit_panel(pg)
    METRICS = """(firstSel) => {
        const q = (s) => document.querySelector(s);
        const card = q('#panel').getBoundingClientRect();
        const head = q('#panel .phead').getBoundingClientRect();
        const pane = q('#panel .pane.on');
        const kids = [...pane.children];
        const first = q(firstSel).getBoundingClientRect();
        const last = kids[kids.length - 1].getBoundingClientRect();
        const chip = pane.querySelector('.prov-chip');
        const row = q('#accRow');
        const rowChip = row && !row.hidden ? row.querySelector('.acc-chip') : null;
        return {
          firstTop: +(first.top - head.bottom).toFixed(2),
          lastGap: +(card.bottom - last.bottom).toFixed(2),
          chipLeft: chip ? +chip.getBoundingClientRect().left.toFixed(1) : null,
          chipRight: chip ? +chip.getBoundingClientRect().right.toFixed(1) : null,
          chipText: chip ? chip.textContent.trim() : null,
          rowClip: rowChip ? +(rowChip.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom).toFixed(2) : null,
          rowH: row && !row.hidden ? +row.getBoundingClientRect().height.toFixed(2) : null,
          paneH: +pane.getBoundingClientRect().height.toFixed(2),
        };
      }"""
    # 切页签后要 fit 一次：面板高度跟着页签走，主进程也是收到新高度才改窗口的，
    # 不 fit 就是在「窗口还是上一个页签的高度」下量，末行距卡片底必然偏
    pg.evaluate("() => { window.__state.config.panelTab = 'glm'; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)
    fit_panel(pg)
    pg.wait_for_timeout(150)
    g = pg.evaluate(METRICS, "#panel .pane-glm .pct")
    pg.evaluate("() => { window.__state.config.panelTab = 'deepseek'; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)
    fit_panel(pg)
    pg.wait_for_timeout(150)
    d = pg.evaluate(METRICS, "#panel .pane-ds .ds-bal")
    t("首行距页头一致（GLM 大数字 / DS 总余额）", abs(g["firstTop"] - d["firstTop"]) < 0.6, f'{g["firstTop"]} vs {d["firstTop"]}')
    t("首行距页头 = 12px（与页头下边距对称）", abs(g["firstTop"] - 12) < 0.6, str(g["firstTop"]))
    t("末行距卡片底一致（不留多余空白）", abs(g["lastGap"] - d["lastGap"]) < 1.6, f'{g["lastGap"]} vs {d["lastGap"]}')
    t("末行距卡片底 = 内边距 16px + 边框 1px", 16.4 <= g["lastGap"] <= 18.2, str(g["lastGap"]))
    t("两页签的峰谷徽标同一位置（右侧对齐）",
      g["chipRight"] is not None and d["chipRight"] is not None
      and abs(g["chipRight"] - d["chipRight"]) < 0.6 and abs(g["chipLeft"] - d["chipLeft"]) < 0.6,
      f'{g["chipLeft"]}..{g["chipRight"]} vs {d["chipLeft"]}..{d["chipRight"]}')
    t("两页签的峰谷徽标同一套文案",
      g["chipText"] in ("高峰时段", "空闲时段") and d["chipText"] == g["chipText"],
      f'{g["chipText"]} / {d["chipText"]}')
    pg.evaluate("() => { window.__state.config.panelTab = 'deepseek'; window.__cb(window.__state); }")
    pg.wait_for_timeout(120)

    print("区间切换（1 小时 / 24 小时 / 7 天 / 30 天）:")
    t("四档按钮都在", pg.locator("#panel .pane-ds .segb").count() == 4)
    pg.click("#panel .pane-ds .segb[data-r='1h']")
    pg.wait_for_timeout(120)
    t("保存 dsRange=1h", pg.evaluate("window.__saved && window.__saved.dsRange") == "1h")
    t("切到 1 小时", "近 1 小时" in pg.text_content("#panel .pane-ds .ds-range"))
    t("1 小时图有 12 根柱子（5 分钟一根）", pg.locator("#panel .pane-ds .ds-chart > i").count() == 12)
    t("1 时按钮高亮", pg.evaluate("document.querySelector('#panel .pane-ds .segb[data-r=\\'1h\\']').classList.contains('on')"))
    t("1 小时档的柱子给 5 分钟区间",
      pg.evaluate("document.querySelectorAll('#panel .pane-ds .ds-chart > i')[11].dataset.tip").find("–") > 0,
      pg.evaluate("document.querySelectorAll('#panel .pane-ds .ds-chart > i')[11].dataset.tip"))
    t("最后一根标进行中", pg.locator("#panel .pane-ds .ds-chart > i.partial").count() == 1)
    pg.locator("#panel .pane-ds .ds-chart > i").nth(3).hover()
    pg.wait_for_timeout(250)
    _tip = pg.text_content("#panel .pane-ds .dstrip")
    t("悬停柱子弹出气泡", pg.locator("#panel .pane-ds .dstrip").evaluate("e => e.classList.contains('show')"))
    t("气泡给的是时间区间 + 费用", re.search(r"\d{2}:\d{2}–\d{2}:\d{2} · ¥\d", _tip) is not None, _tip)
    t("气泡左右都不出窗", pg.evaluate("""() => {
        const t = document.querySelector('#panel .pane-ds .dstrip').getBoundingClientRect();
        const c = document.querySelector('#panel').getBoundingClientRect();
        return t.left >= c.left + 2 && t.right <= c.right - 2;
      }"""))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_tip.png")
    # 回归：气泡也在 .ds-chart 里，柱子样式若用后代选择器会把气泡里的 <i> 也套上渐变背景
    pg.locator("#panel .pane-ds .ds-chart > i.partial").hover()
    pg.wait_for_timeout(250)
    t("「进行中」不带柱子样式（无渐变底、不继承 flex）", pg.evaluate("""() => {
        const i = document.querySelector('#panel .pane-ds .dstrip i');
        const cs = getComputedStyle(i);
        return cs.backgroundImage === 'none' && cs.flexGrow === '0';
      }"""))
    t("「进行中」字色与气泡其他文字一致", pg.evaluate("""() => {
        const t = document.querySelector('#panel .pane-ds .dstrip');
        return getComputedStyle(t.querySelector('i')).color === getComputedStyle(t).color;
      }"""))
    t("进行中那根仍带斜纹（柱子本身没被误伤）", pg.locator("#panel .pane-ds .ds-chart > i.partial").count() == 1)
    pg.mouse.move(5, 5)
    pg.wait_for_timeout(200)
    t("移开后气泡收起", not pg.locator("#panel .pane-ds .dstrip").evaluate("e => e.classList.contains('show')"))
    t("脚注换成滚动 5 分钟，不与标题重复", "最近 5 分钟" in pg.text_content("#panel .pane-ds .ds-left") and "近 1 小时" not in pg.text_content("#panel .pane-ds .ds-left"),
      pg.text_content("#panel .pane-ds .ds-left"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_1h.png")
    pg.click("#panel .pane-ds .segb[data-r='30d']")
    t("保存 dsRange=30d", pg.evaluate("window.__saved && window.__saved.dsRange") == "30d")
    pg.evaluate("""() => { const s = window.__state;
        s.config.dsRange = '30d';
        s.providers.deepseek.accounts[0].data.summary.series =
          Array.from({length:30}, (_,i) => ({date:'2026-09-'+String(i+1).padStart(2,'0'), spend: i%5}));
        window.__cb(s); }""")
    pg.wait_for_timeout(80)
    t("柱状图 30 根", pg.locator("#panel .pane-ds .ds-chart > i").count() == 30)
    t("范围标题带区间合计", "近 30 天" in pg.text_content("#panel .pane-ds .ds-range"))
    t("30 根时标签高亮 30天", pg.evaluate("document.querySelector('#panel .pane-ds .segb[data-r=\\'30d\\']').classList.contains('on')"))
    pg.click("#panel .pane-ds .segb[data-r='24h']")
    pg.wait_for_timeout(100)
    t("切到 24 小时", pg.evaluate("window.__saved.dsRange") == "24h" and "近 24 小时" in pg.text_content("#panel .pane-ds .ds-range"))
    t("24 小时图有 24 根柱子", pg.locator("#panel .pane-ds .ds-chart > i").count() == 24)
    t("当前小时标为进行中", pg.locator("#panel .pane-ds .ds-chart > i.partial").count() == 1)
    t("柱子的 24 小时档给小时区间", re.search(r"\d{2}:\d{2}–\d{2}:\d{2}", pg.evaluate("document.querySelectorAll('#panel .pane-ds .ds-chart > i')[20].dataset.tip")) is not None,
      pg.evaluate("document.querySelectorAll('#panel .pane-ds .ds-chart > i')[20].dataset.tip"))
    pg.locator("#panel").screenshot(path="/tmp/r_panel_ds_24h.png")
    pg.click("#panel .pane-ds .segb[data-r='7d']")
    pg.wait_for_timeout(100)
    t("切回 7 天", pg.locator("#panel .pane-ds .ds-chart > i").count() == 7)
    pg.evaluate("() => { const s = window.__state; s.config.panelTab = 'glm'; window.__cb(s); }")
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1]})

    print("多账户（chips 行 + 胶囊角标 + 切换）:")
    set_dev(pg, """const acc2 = { id:'a2', name:'备用号', enabled:true, status:'ok', msg:'', lastFetchAt: Date.now(),
        data: JSON.parse(JSON.stringify(s.providers.glm.accounts[0].data)), tier: 'mid' };
      acc2.data.five.percent = 88; acc2.data.level = 'pro';
      s.providers.glm.accounts.push(acc2);
      s.config.accounts.push({ id:'a2', provider:'glm', name:'备用号', enabled:true,
        creds:{ token:{ set:true, tail:'n3wtok' } } });
      s.worstTier = 'mid'; s.providers.glm.tier = 'mid';""")
    pg.wait_for_timeout(150)
    t("chips 行出现", pg.locator("#accRow").is_visible())
    t("两个 chips", pg.locator("#accRow .acc-chip").count() == 2)
    t("chips 行不被压缩：tag 底部不溢出（面板 flex 列里它最容易被挤）",
      pg.evaluate("""() => { const row = document.querySelector('#accRow');
          const chip = row.querySelector('.acc-chip');
          return +(chip.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom).toFixed(2); }""") <= 0.5,
      str(pg.evaluate("""() => { const row = document.querySelector('#accRow');
          const chip = row.querySelector('.acc-chip');
          return +(chip.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom).toFixed(2); }""")))
    t("chips 行留了姓名 tag 的完整高度（29~31px，不是被压扁的 24）",
      pg.evaluate("document.querySelector('#accRow').getBoundingClientRect().height") > 28.5,
      str(pg.evaluate("document.querySelector('#accRow').getBoundingClientRect().height")))
    t("当前账户 chip 高亮", pg.evaluate("document.querySelector('#accRow .acc-chip[data-id=\\'a1\\']').classList.contains('on')"))
    pg.click("#accRow .acc-chip[data-id='a2']")
    pg.wait_for_timeout(150)
    t("chip 点击切账户", (pg.evaluate("window.__activated") or {}).get("id") == "a2")
    t("面板数字切到备用号 88", pg.text_content("#panel .pane-glm .pv5") == "88")
    t("页签套餐徽标变 Pro", pg.text_content("#tabs .lvl") == "Pro")
    push(pg, view="capsule")
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    szm = fit_window(pg)
    t("多账户：胶囊出现账户 chip", pg.locator("#capsule .cap-glm .acc-chip").is_visible())
    t("chip 显示当前账户名（切到哪个显示哪个）", "备用号" in (pg.text_content("#capsule .cap-glm .acc-chip") or ""),
      pg.text_content("#capsule .cap-glm .acc-chip"))
    t("chip 在数据后面，不压内容（切换布局仍只有一格）", pg.locator("#capsule .cap-glm .cap-acct").count() == 1)
    t("胶囊数字=当前账户 88", pg.text_content("#capsule .cap-glm .pv5") == "88")
    t("tier 取最差（88 → mid）", pg.get_attribute("body", "data-tier") == "mid", pg.get_attribute("body", "data-tier"))
    t("账户格带上自己的档位（多账户各自变色）",
      pg.get_attribute("#capsule .cap-glm .cap-acct", "data-tier") == "mid")
    t("多账户时左右留白仍对称（chip 不再挤压右列）", capsule_pad(pg)["r"] >= 11.5, str(capsule_pad(pg)))
    pg.click("#capsule .cap-glm .acc-chip")
    pg.wait_for_timeout(150)
    t("点 chip 弹原生账户菜单", (pg.evaluate("window.__menu") or {}).get("provider") == "glm")
    # 菜单里选「主号」→ 主进程 accActivate + 广播（这里手动模拟这一拍）
    pg.evaluate("""async () => {
        const ns = await window.glm.accActivate({ provider: 'glm', id: 'a1' });
        window.__cb(ns);
      }""")
    pg.wait_for_timeout(150)
    t("菜单选主号后切回", (pg.evaluate("window.__activated") or {}).get("id") == "a1")
    t("胶囊数字切回 5", pg.text_content("#capsule .cap-glm .pv5") == "5")
    t("chip 名字跟着换成主号", "主号" in pg.text_content("#capsule .cap-glm .acc-chip"))

    print("平铺布局（每个账户各一格）:")
    set_dev(pg, "s.config.capsuleLayout = 'all';")
    pg.wait_for_timeout(200)
    szall = fit_window(pg)
    t("平铺：GLM 两个账户各一格", pg.locator("#capsule .cap-glm .cap-acct").count() == 2)
    t("平铺：格顶出现账户名行", pg.evaluate("[...document.querySelectorAll('#capsule .cap-glm .cap-aname')].every(e => e.offsetParent)")
      and pg.locator("#capsule .cap-glm .cap-aname").count() == 2)
    t("平铺：切换布局的 chip 收起", pg.locator("#capsule .cap-glm .acc-chip").count() == 0)
    t("平铺：两格各显示自己的数据", pg.evaluate(
      "[...document.querySelectorAll('#capsule .cap-glm .cap-acct')].map(c => c.querySelector('.pv5').textContent).join(',')") == "5,88")
    t("平铺：两格各带自己的档位色", pg.evaluate(
      "[...document.querySelectorAll('#capsule .cap-glm .cap-acct')].map(c => c.dataset.tier).join(',')") == "low,mid")
    t("平铺：组间分隔线还在（且标记为平铺态）",
      pg.locator("#capsule .cap-sep").count() == 1
      and pg.evaluate("document.querySelector('#capsule').classList.contains('cap-tiled')"))
    t("平铺：组间线满高（比切换布局的短线更长）",
      pg.evaluate("document.querySelector('#capsule .cap-sep').getBoundingClientRect().height") > 30,
      str(pg.evaluate("document.querySelector('#capsule .cap-sep').getBoundingClientRect().height")))
    t("平铺：组内的账户间线改用伪元素（不撑满格高、不抢组间线）",
      pg.evaluate("getComputedStyle(document.querySelectorAll('#capsule .cap-glm .cap-acct')[1]).borderLeftWidth") == "0px"
      and pg.evaluate("getComputedStyle(document.querySelectorAll('#capsule .cap-glm .cap-acct')[1], '::before').width") == "1px")
    t("平铺是全胶囊的统一决定：DS 只有一个账户也带账户名小 tag",
      pg.evaluate("!!document.querySelector('#capsule .cap-ds .cap-aname')"
                  " && document.querySelector('#capsule .cap-ds .cap-aname').offsetParent !== null"
                  " && document.querySelector('#capsule .cap-ds .cap-aname').textContent.trim() === 'DeepSeek'"))
    t("平铺：两列格子等高（名字行都在顶上，左右不再一高一低）",
      pg.evaluate("""() => {
          const g = document.querySelector('#capsule .cap-glm .cap-acct').getBoundingClientRect();
          const d = document.querySelector('#capsule .cap-ds .cap-acct').getBoundingClientRect();
          return Math.abs(g.height - d.height) < 1.5 && Math.abs(g.top - d.top) < 1.5;
        }"""))
    t("平铺：名字行不挤出卡片（高度=43 左右）", szall and 42 <= szall["h"] <= 52, str(szall))
    t("平铺：左右留白对称", abs(capsule_pad(pg)["l"] - capsule_pad(pg)["r"]) < 0.6, str(capsule_pad(pg)))
    pg.locator("#capsule").screenshot(path="/tmp/r_capsule_tile.png")
    # 点第二格的名字 = 把它设为当前账户
    pg.locator("#capsule .cap-glm .cap-aname").nth(1).click()
    pg.wait_for_timeout(150)
    t("平铺：点账户名设为当前账户", (pg.evaluate("window.__activated") or {}).get("id") == "a2")
    set_dev(pg, "s.config.capsuleLayout = 'switch';")
    pg.wait_for_timeout(200)
    fit_window(pg)
    t("切回切换布局：又只剩一格", pg.locator("#capsule .cap-glm .cap-acct").count() == 1)

    print("停用的账户不进切换器:")
    set_dev(pg, """const acc3 = { id:'a3', name:'停用号', enabled:false, status:'ok', msg:'', lastFetchAt: Date.now(), data: null };
      s.providers.glm.accounts.push(acc3);
      s.config.accounts.push({ id:'a3', provider:'glm', name:'停用号', enabled:false,
        creds:{ token:{ set:true, tail:'offxxx' } } });""")
    pg.wait_for_timeout(150)
    # 当前账户是 a2，列表里紧挨着的下一个正是停用的 a3 —— 修之前滚轮从这里再也回不到 a1
    # （切 a3 被主进程拒 → 当前账户没变 → 下次又切 a3）。所以滚一下必须落到 a1
    box = pg.locator("#capsule .cap-glm").bounding_box()
    pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pg.mouse.wheel(0, 100)
    pg.wait_for_timeout(150)
    t("滚轮跳过停用账户，直接切到下一个启用的（a1）",
      (pg.evaluate("window.__activated") or {}).get("id") == "a1",
      str(pg.evaluate("window.__activated")))
    push(pg, view="panel")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1] + 26})
    pg.wait_for_timeout(150)
    t("停用的账户仍列在 chips 行里（灰着，不是删掉配置）",
      pg.locator("#accRow .acc-chip[data-id='a3'].acc-chip-off").count() == 1)
    set_dev(pg, """s.providers.glm.accounts = s.providers.glm.accounts.filter(a => a.id !== 'a3');
      s.config.accounts = s.config.accounts.filter(a => a.id !== 'a3');""")
    pg.wait_for_timeout(150)

    print("设置页的「胶囊布局」开关:")
    push(pg, view="settings")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.set_viewport_size({"width": SETTINGS[0], "height": SETTINGS[1]})
    t("多账户时出现布局下拉", pg.locator("#caplayout").is_visible())
    t("下拉回填当前值", pg.eval_on_selector("#caplayout", "e => e.value") == "switch")
    pg.select_option("#caplayout", "all")
    pg.wait_for_timeout(150)
    t("选择「平铺」立即落盘（不用点保存）", pg.evaluate("(window.__saved || {}).capsuleLayout") == "all")
    pg.select_option("#caplayout", "switch")
    pg.wait_for_timeout(120)
    push(pg, view="panel")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1] + 26})
    t("DS 单账户无 chips 干扰（deepseek 家仅 1 账户）",
      pg.evaluate("[...document.querySelectorAll('#accRow .acc-chip')].filter(e => !e.classList.contains('acc-chip-off')).length") == 2)

    print("Ctrl+滚轮缩放:")
    pg.keyboard.down("Control")
    pg.mouse.wheel(0, -100)
    pg.keyboard.up("Control")
    pg.wait_for_timeout(100)
    t("放大到 105%", pg.evaluate("window.__zoom") == 1.05)
    t("缩放提示显示", pg.locator("#zoomTip").evaluate("e => e.textContent") == "105%")

    print("阈值可配置（需求 1）:")
    # worstTier 由主进程算好下发；mock 里随阈值/用量一起改，模拟主进程行为
    set_dev(pg, "s.config.warnThreshold = 50; const d = s.providers.glm.accounts[0].data;"
               " d.five.percent = 55; d.week.percent = 30; s.worstTier = 'mid'; s.providers.glm.tier = 'mid';")
    pg.wait_for_timeout(60)
    t("阈值 50 时 55% → mid", pg.get_attribute("body", "data-tier") == "mid")
    set_dev(pg, "s.config.warnThreshold = 60; s.worstTier = 'low'; s.providers.glm.tier = 'low';")
    pg.wait_for_timeout(60)
    t("阈值 60 时 55% → low", pg.get_attribute("body", "data-tier") == "low")

    print("高用量变色:")
    set_dev(pg, "s.config.warnThreshold = 80; const d = s.providers.glm.accounts[0].data;"
               " d.five.percent = 92; d.week.percent = 88; s.worstTier = 'high'; s.providers.glm.tier = 'high';")
    t("tier=high", pg.get_attribute("body", "data-tier") == "high")
    pg.locator("#panel").screenshot(path="/tmp/r_panel_high.png")
    set_dev(pg, "const d = s.providers.glm.accounts[0].data; d.five.percent = 5; d.week.percent = 7;"
               " s.worstTier = 'low'; s.providers.glm.tier = 'low';")
    t("回落到 low", pg.get_attribute("body", "data-tier") == "low")

    print("过期态:")
    # 让「当前账户」失效（多账户下未必是第一个 —— 前面刚切过账户）
    pg.evaluate("() => { const s = window.__state; const p = s.providers.glm;"
                " const a = p.accounts.find(x => x.id === p.activeId) || p.accounts[0];"
                " a.status = 'expired'; a.msg = 'Cookie 已失效'; a.data = null; window.__cb(s); }")
    push(pg, view="capsule")
    pg.wait_for_function("document.body.className.includes('st-') || true")
    fit_window(pg)
    pg.wait_for_timeout(100)
    t("胶囊左列显示失效提示", pg.locator("#capsule .cap-glm .glm-warn").is_visible())
    t("失效时账户 chip 仍在（还得能切走）", pg.locator("#capsule .cap-glm .acc-chip").is_visible())
    t("胶囊右列 DeepSeek 数据照常显示", pg.locator("#capsule .cap-ds").is_visible())
    pg.locator("#capsule").screenshot(path="/tmp/r_capsule_expired.png")
    # 点胶囊的「非控件处」= 展开；账户 chip 是按钮，点它会弹账户菜单而不是展开
    pg.locator("#capsule .cap-ds .dsbal").click()
    t("点击直达设置", pg.evaluate("window.__view") == "settings")
    push(pg, view="panel")
    pg.evaluate("() => { window.__state.config.panelTab = 'glm'; window.__cb(window.__state); }")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    pg.set_viewport_size({"width": PANEL_GLM[0], "height": PANEL_GLM[1] + 26})
    t("面板出现过期横幅", pg.locator(".banner-expired").is_visible())
    pg.locator("#panel").screenshot(path="/tmp/r_panel_exp.png")
    pg.evaluate("() => { window.__state.config.panelTab = 'deepseek'; window.__cb(window.__state); }")
    pg.wait_for_timeout(60)
    t("DS 页签无 GLM 的过期横幅", not pg.locator(".banner-expired").is_visible())

    print("设置页（账户管理）:")
    pg.evaluate("window.__clip = { glm: { token: '%s' }, deepseek: { apiKey: '%s' } }" % (JWT, DSKEY))
    pg.evaluate("() => { window.__state.providers.glm.accounts[0].status = 'expired'; window.__cb(window.__state); }")
    push(pg, view="settings")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.set_viewport_size({"width": SETTINGS[0], "height": SETTINGS[1]})
    t("设置页分四段（三家 provider + 通用）", pg.locator("#settings .sech").count() == 4)
    t("三行账户（主号/备用号/DeepSeek）", pg.locator("#settings .acc-row").count() == 3)
    t("账户行显示尾号", "0LD_OLD" in pg.text_content("#provSecs"))
    t("账户状态词=已失效", "已失效" in pg.text_content("#provSecs .acc-row[data-id='a1'] .aword"))
    t("三个添加按钮", pg.locator("#settings .acc-add").count() == 3)
    t("GLM 专属控件在 GLM 段", pg.evaluate("""() => {
        const glmSec = document.querySelector('#provSecs .acc-wrap[data-pid=\\'glm\\']');
        return !!glmSec && !!glmSec.querySelector('#threshold') && !!glmSec.querySelector('#pacealert');
      }"""))
    t("DS 专属控件在 DS 段", pg.evaluate("""() => {
        const dsSec = document.querySelector('#provSecs .acc-wrap[data-pid=\\'deepseek\\']');
        return !!dsSec && !!dsSec.querySelector('#dsfast');
      }"""))
    t("通用段保留 interval/theme", pg.locator("#interval").count() == 1 and pg.locator("#theme").count() == 1)
    t("阈值已回填到设置页输入框", pg.eval_on_selector("#threshold", "e => e.value") == "80")
    t("指引默认折叠（省高度）", pg.evaluate("[...document.querySelectorAll('#provSecs .gdwrap')].every(d => !d.open)"))
    t("保存按钮滚到底可见", (lambda: (pg.evaluate("document.querySelector('#settings .sbody').scrollTop = 99999"),
                                 pg.wait_for_timeout(80),
                                 (pg.locator("#saveBtn").bounding_box() or {"y": -1})["y"] + (pg.locator("#saveBtn").bounding_box() or {"w": 0, "y": -1, "height": 0})["height"] <= SETTINGS[1] - 8)[2])())
    t("右上角也有一个保存按钮（不用滚到底）", pg.locator("#saveBtn2").is_visible())
    t("凭据输入框在编辑表单里（不在列表上）", pg.locator("#provSecs form.acc-form textarea[data-cred]").count() == 0)

    print("添加账户表单:")
    pg.evaluate("document.querySelector('#settings .sbody').scrollTop = 0")
    pg.locator("#provSecs .acc-add[data-pid='glm']").first.click()
    pg.wait_for_timeout(150)
    t("表单出现", pg.locator("#provSecs form.acc-form").count() == 1)
    t("表单有名称框与凭据框", pg.locator("#provSecs form.acc-form .aname-input").count() == 1
      and pg.locator("#provSecs form.acc-form textarea[data-cred='token']").count() == 1)
    t("取消关闭表单", (lambda: (pg.locator("#provSecs form.acc-form .fcancel").first.click(), pg.wait_for_timeout(150),
                              pg.locator("#provSecs form.acc-form").count() == 0)[2])())

    print("添加第二个 DeepSeek 账户（走表单全链路）:")
    pg.locator("#provSecs .acc-add[data-pid='deepseek']").first.click()
    pg.wait_for_timeout(150)
    t("DS 添加表单出现（两个凭据框）",
      pg.locator("#provSecs form.acc-form[data-pid='deepseek'] textarea[data-cred]").count() == 2)
    pg.fill("#provSecs form.acc-form[data-pid='deepseek'] .aname-input", "DS 二号")
    pg.fill("#provSecs form.acc-form[data-pid='deepseek'] textarea[data-cred='apiKey']", DSKEY + "22")
    pg.locator("#provSecs form.acc-form[data-pid='deepseek'] button[type='submit']").click()
    pg.wait_for_timeout(200)
    t("提交的是 deepseek + 名与 Key", pg.evaluate("(window.__added||{}).provider") == "deepseek"
      and pg.evaluate("(window.__added||{}).name") == "DS 二号"
      and pg.evaluate("((window.__added||{}).credentials||{}).apiKey || ''").startswith("sk-"),
      str(pg.evaluate("window.__added")))
    t("表单提交后自动收起", pg.locator("#provSecs form.acc-form").count() == 0)
    t("设置页 DS 段出现第二行账户", pg.locator("#provSecs .acc-wrap[data-pid='deepseek'] .acc-row").count() == 2)
    # 胶囊与面板都要立刻反映新账户（这里只看布局，数据由主进程随后刷新）
    push(pg, view="capsule")
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    fit_window(pg)
    t("胶囊 DS 列出现账户 chip（两个账户了）", pg.locator("#capsule .cap-ds .acc-chip").is_visible())
    set_dev(pg, "s.config.capsuleLayout = 'all';")
    pg.wait_for_timeout(200)
    fit_window(pg)
    t("平铺：DS 两个账户各一格", pg.locator("#capsule .cap-ds .cap-acct").count() == 2)
    t("平铺：DS 每格都有账户名小 tag",
      pg.evaluate("[...document.querySelectorAll('#capsule .cap-ds .cap-aname')].every(e => e.offsetParent && e.textContent.trim())"))
    set_dev(pg, "s.config.capsuleLayout = 'switch';")
    pg.wait_for_timeout(150)
    push(pg, view="settings")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.set_viewport_size({"width": SETTINGS[0], "height": SETTINGS[1]})
    print("凭据识别不出时不许「静默成功」:")
    pg.locator("#provSecs .acc-add[data-pid='deepseek']").first.click()
    pg.wait_for_timeout(150)
    # 经典踩法：把平台的 userToken 粘进 API Key 框
    pg.fill("#provSecs form.acc-form[data-pid='deepseek'] .aname-input", "粘错字段")
    pg.fill("#provSecs form.acc-form[data-pid='deepseek'] textarea[data-cred='apiKey']",
            "eyJhbGciOiJIUzUxMiJ9.eyJ1c2VyX3R5cGUiOiJQRVJTT05BTCJ9.SIG")
    pg.locator("#provSecs form.acc-form[data-pid='deepseek'] button[type='submit']").click()
    pg.wait_for_timeout(200)
    t("表单不关（留在原地让人改）", pg.locator("#provSecs form.acc-form").count() == 1)
    t("错误显示在表单里，说的是「识别不出」",
      pg.locator("#provSecs form.acc-form .formerr").count() == 1
      and "识别不出" in pg.text_content("#provSecs form.acc-form .formerr"),
      pg.text_content("#provSecs form.acc-form .formerr") if pg.locator("#provSecs form.acc-form .formerr").count() else "(没有提示)")
    t("没有多出账户行", pg.locator("#provSecs .acc-wrap[data-pid='deepseek'] .acc-row").count() == 2)
    pg.fill("#provSecs form.acc-form[data-pid='deepseek'] textarea[data-cred='apiKey']", DSKEY + "33")
    pg.wait_for_timeout(80)
    t("一动手报错就收走", pg.locator("#provSecs form.acc-form .formerr").count() == 0)
    pg.locator("#provSecs form.acc-form[data-pid='deepseek'] button[type='submit']").click()
    pg.wait_for_timeout(200)
    t("改对之后提交成功（第三行出现）", pg.locator("#provSecs .acc-wrap[data-pid='deepseek'] .acc-row").count() == 3)
    t("成功后表单才收起", pg.locator("#provSecs form.acc-form").count() == 0)
    # 收拾干净（mock 里 accAdd 的 id 固定是 new1），别影响后面的断言
    pg.evaluate("""() => { const s = window.__state;
        s.config.accounts = s.config.accounts.filter(a => a.id !== 'new1');
        for (const pid of Object.keys(s.providers)) {
          s.providers[pid].accounts = s.providers[pid].accounts.filter(a => a.id !== 'new1');
        }
        window.__cb(s); }""")
    pg.wait_for_timeout(150)
    t("清理回单账户（不影响后续断言）", pg.locator("#provSecs .acc-wrap[data-pid='deepseek'] .acc-row").count() == 1)

    print("编辑表单（DS 双凭据 + 尾号回显 + 清除按钮）:")
    pg.locator("#settings .acc-row[data-id='d1'] [data-act='edit']").click()
    pg.wait_for_timeout(150)
    t("DS 表单 2 个凭据框", pg.locator("#provSecs form.acc-form textarea[data-cred]").count() == 2)
    ph = pg.get_attribute("#provSecs form.acc-form textarea[data-cred='apiKey']", "placeholder")
    t("占位带尾号回显", "def" in (ph or ""), ph)
    t("清除按钮只在已配字段", pg.locator("#provSecs form.acc-form [data-clr]").count() == 2)
    pg.locator("#provSecs form.acc-form .fcancel").first.click()
    pg.wait_for_timeout(120)

    print("剪贴板一键填入（按凭据字段）:")
    pg.evaluate("() => { window.__state.view = 'settings'; window.__cb(window.__state); }")
    pg.wait_for_timeout(120)
    pg.locator("#provSecs .acc-add[data-pid='glm']").first.click()
    pg.wait_for_timeout(150)
    pg.wait_for_function("document.querySelector('#provSecs .clipchip') && document.querySelector('#provSecs .clipchip').classList.contains('show')")
    t("GLM 剪贴板提示出现", pg.locator("#provSecs form.acc-form .clipchip").first.is_visible())
    pg.click("#provSecs form.acc-form .clipchip")
    t("点击填入 token", pg.eval_on_selector("#provSecs form.acc-form textarea[data-cred='token']", "e => e.value") == JWT)
    pg.locator("#provSecs form.acc-form .fcancel").first.click()
    pg.wait_for_timeout(120)
    pg.evaluate("window.__clip = null")

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
    pg.click("#ontop")
    pg.wait_for_function("window.__saved && window.__saved.alwaysOnTop === true")
    t("即时保存不触发刷新（刷新仍由用户手动）", pg.evaluate("window.__saved.refreshing") is None)

    pg.select_option("#interval", "30")
    pg.fill("#threshold", "75")
    pg.click("#saveBtn")
    pg.wait_for_function("window.__saved")
    t("保存含阈值 75 与间隔", pg.evaluate("window.__saved.warnThreshold === 75 && window.__saved.intervalMin === 30"))
    t("保存后回到面板", pg.evaluate("window.__view") == "panel")

    print("点空白收起:")
    pg.evaluate("() => { const s = window.__state; s.view='panel'; s.config.panelTab='glm'; window.__cb(s); }")
    pg.wait_for_function("document.body.className.includes('view-panel')")
    pg.click("#panel .pane-glm .sub")
    t("点面板非按钮处 → capsule", pg.evaluate("window.__view") == "capsule")

    print("Esc 收起:")
    pg.evaluate("window.__state.view='settings'; window.__cb(window.__state)")
    pg.wait_for_function("document.body.className.includes('view-settings')")
    pg.keyboard.press("Escape")
    t("Esc → capsule", pg.evaluate("window.__view") == "capsule")

    print("拖拽手势（主进程按光标锚点定位）:")
    # 回一个干净的初始态：当前账户设回 a1、两个账户都健康（前面切过账户、造过失效态）
    set_dev(pg, "const p = s.providers.glm; p.activeId = 'a1';"
                " p.accounts.forEach(a => { a.status = 'ok'; a.data = JSON.parse(JSON.stringify(window.__glmData)); });")
    pg.evaluate("() => { const s = window.__state; s.view='capsule'; window.__view=null; window.__dragMove=0; window.__dragEnd=0; window.__cb(s); }")
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    pg.set_viewport_size({"width": CAP_BOTH[0], "height": CAP_BOTH[1]})
    # 起点取「右列余额」的中心：一定不是按钮（账户 chip 也是按钮，点它走的是菜单不是展开），
    # 不跟着左侧数据宽度漂移，测试才稳
    db = pg.locator("#capsule .cap-ds .dsbal").bounding_box()
    sx, sy = db["x"] + db["width"] / 2, db["y"] + db["height"] / 2
    pg.mouse.move(sx, sy)
    pg.mouse.down()
    pg.wait_for_timeout(30)
    t("按下即把光标锚点交给主进程", pg.evaluate("Array.isArray(window.__dragStart)"))
    pg.mouse.move(sx + 44, sy + 6, steps=6)     # 位移 > 3px → 进入拖拽
    pg.mouse.move(sx + 84, sy + 26, steps=6)
    pg.wait_for_timeout(50)
    t("拖拽中持续发心跳", pg.evaluate("window.__dragMove >= 1"))
    moved_no_tap = pg.evaluate("window.__view") is None   # 拖动中不该已展开
    pg.mouse.up()
    pg.wait_for_timeout(200)
    t("拖拽走 IPC 且未触发点击", moved_no_tap and pg.evaluate("window.__dragEnd") == 1)
    # 原地按下松开仍要能展开（死区不能吃掉点击）
    pg.evaluate("() => { const s = window.__state; s.view='capsule'; window.__view=null; window.__cb(s); }")
    pg.wait_for_function("document.body.className.includes('view-capsule')")
    db = pg.locator("#capsule .cap-ds .dsbal").bounding_box()
    pg.mouse.move(db["x"] + db["width"] / 2, db["y"] + db["height"] / 2)
    pg.mouse.down()
    pg.mouse.up()
    pg.wait_for_timeout(120)
    t("原地点击仍触发展开", pg.evaluate("window.__view") == "panel")

    print("峰谷时段徽标:")
    push(pg, view="panel")
    pg.evaluate("() => { window.__state.config.panelTab = 'glm'; window.__cb(window.__state); }")
    pg.wait_for_timeout(100)
    t("GLM 徽标已渲染", pg.evaluate("document.querySelector('#panel .pane-glm .prov-chip .ctxt').textContent") in ("高峰时段", "空闲时段"))
    pg.evaluate("() => { window.__state.config.panelTab = 'deepseek'; window.__cb(window.__state); }")
    pg.wait_for_timeout(100)
    t("DS 徽标已渲染（与 GLM 同一套文案）", pg.evaluate("document.querySelector('#panel .pane-ds .prov-chip .ctxt').textContent") in ("高峰时段", "空闲时段"))
    t("徽标带时段说明 title", "高峰：周一至周五" in pg.evaluate("document.querySelector('#panel .pane-ds .prov-chip').title"))
    t("徽标配色克制（低透明度背景）", pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-ds .prov-chip')).backgroundColor").startswith("rgba"))
    t("徽标不参与动画", pg.evaluate("getComputedStyle(document.querySelector('#panel .pane-ds .prov-chip')).animationName") == "none")
    pg.evaluate("() => { window.__state.config.panelTab = 'glm'; window.__cb(window.__state); }")

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
    t("周末全天非高峰", pg.evaluate("[GLMFMT.isPeak('glm', new Date('2026-09-12T15:00:00+08:00').getTime()), GLMFMT.isPeak('ds', new Date('2026-09-12T10:00:00+08:00').getTime())].join()") == "false,false")
    t("时区无关：用 UTC 表达同一时刻结果一致", pg.evaluate("GLMFMT.isPeak('glm', new Date('2026-09-14T06:00:00Z').getTime())"), "北京 14:00 = UTC 06:00")

    print("档位阈值（可配置，默认 80 mid / 90 high，5h+周取最高）:")
    t("tierOf 79→low", pg.evaluate("GLMFMT.tierOf(79)") == "low")
    t("tierOf 80→mid", pg.evaluate("GLMFMT.tierOf(80)") == "mid")
    t("tierOf 90→high", pg.evaluate("GLMFMT.tierOf(90)") == "high")
    t("阈值 60：59→low / 60→mid / 69→mid / 70→high",
      pg.evaluate("[GLMFMT.tierOf(59,60),GLMFMT.tierOf(60,60),GLMFMT.tierOf(69,60),GLMFMT.tierOf(70,60)].join()") == "low,mid,mid,high")
    t("非法阈值回退 80", pg.evaluate("GLMFMT.normWarn('')") == 80 and pg.evaluate("GLMFMT.normWarn(999)") == 80)
    t("60/20 组合→low（旧逻辑会误 mid）", pg.evaluate("GLMFMT.tierOfPair(60, 20)") == "low")
    t("10/95 周触发→high", pg.evaluate("GLMFMT.tierOfPair(10, 95)") == "high")
    t("95/10 5h触发→high", pg.evaluate("GLMFMT.tierOfPair(95, 10)") == "high")

    # ---- 火山方舟：第三家 provider 的胶囊 / 面板 / 设置 ----
    print("火山方舟（第三家 provider）:")
    pg.evaluate("""() => {
      const s = window.__state, H = 3600e3, D = 86400e3, NOW = Date.now();
      const win = (percent, resetH, lenMs) => ({ known: true, percent, used: null, total: null, remaining: null,
        nextResetTime: NOW + resetH * H, windowStart: NOW + resetH * H - lenMs, windowMs: lenMs });
      s.view = 'capsule';
      s.providers.volc = { name: '火山方舟 Coding / Agent Plan', tab: '火山', tier: 'low',
        accounts: [{ id: 'v1', name: '火山', enabled: true, status: 'ok', msg: '', lastFetchAt: NOW, tier: 'low',
          data: { plan: 'coding', level: null, bothSubscribed: false, warn: '', fetchedAt: NOW,
                  five: win(62, 3, 5*H), week: win(38, 99, 7*D), month: win(21, 480, 30*D) } }],
        activeId: 'v1' };
      s.config.accounts.push({ id: 'v1', provider: 'volc', name: '火山', enabled: true,
        creds: { accessKeyId: { set: true, tail: 'xxxxxx' }, accessKeySecret: { set: true, tail: 'yyyyyy' },
                 plan: { set: true, tail: 'auto', value: 'coding' } } });
      s.config.active.volc = 'v1';
      window.__cb(s);
    }""")
    pg.wait_for_timeout(200)
    t("三家 provider 时胶囊出三列", pg.locator("#capsule .cap-grp").count() == 3)
    t("胶囊分隔线两条", pg.locator("#capsule .cap-sep").count() == 2)
    t("火山格子只占两行：5h / 周（月不排第三行）", pg.locator("#capsule .cap-volc .grp").count() == 2)
    t("两个条形仍是 62 / 38，月的数字 21 也在",
      [pg.text_content("#capsule .cap-volc .pct-%s" % k) for k in ("five", "week")] == ["62", "38"]
      and pg.text_content("#capsule .cap-volc .pct-month") == "21")
    t("月的数字挂在「周」那一行里（不是另起一行）",
      pg.evaluate("""() => { const m = document.querySelector('#capsule .cap-volc .mnum');
        return !!m && !!m.closest('.grp').querySelector('.pct-week'); }"""))
    t("月不再画条：胶囊里只有 5h / 周 两条 bar",
      pg.locator("#capsule .cap-volc .bar").count() == 2
      and pg.locator("#capsule .cap-volc .fm").count() == 0)
    t("5h / 周的幽灵段变量还在（月让位后没连累别家）",
      pg.evaluate("""() => { const e = document.querySelector('#capsule .cap-volc .cap-acct');
        const g = getComputedStyle(e);
        return [g.getPropertyValue('--pace5'), g.getPropertyValue('--paceW')].filter(Boolean).length; }""") == 2)
    t("胶囊高度回到 40（不再被第三行顶高）",
      pg.evaluate("Math.round(document.querySelector('#capsule').getBoundingClientRect().height)") == 40)
    # 月没有条可上色，超出预期得标在数字上（否则这条信号在胶囊里就没了）
    pg.evaluate("() => { window.__state.providers.volc.accounts[0].data.month.percent = 95; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)
    t("月超出预期 → 数字标红（.mnum.over）",
      pg.evaluate("document.querySelector('#capsule .cap-volc .mnum').classList.contains('over')") is True)
    pg.evaluate("() => { window.__state.providers.volc.accounts[0].data.month.percent = 21; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)

    pg.evaluate("() => { window.__state.config.panelTab = 'volc'; window.__state.view = 'panel'; window.__cb(window.__state); }")
    pg.wait_for_timeout(200)
    fit_panel(pg)      # 换视图那一帧窗口还是胶囊尺寸，量不准；等窗口跟上再量
    pg.wait_for_timeout(200)
    t("跳出取最高的那页（.pane-solo）不占格子，靠 absolute 脱流",
      pg.evaluate("""() => { const s = document.querySelector('#panel .pane-solo');
          return !!s && getComputedStyle(s).position === 'absolute'
            && document.querySelector('#panel #panes').getBoundingClientRect().height
               < s.getBoundingClientRect().height - 50; }"""),
      pg.evaluate("document.querySelector('#panel #panes').getBoundingClientRect().height"))
    t("火山面板有三个配额块", pg.locator("#panel .pane-volc .blk-q").count() == 3)
    # 三块比 GLM 的两块高出一截：这一页要自己高，但**不能把 GLM / DeepSeek 也顶高**
    t("火山这页自己的高度（比 GLM 高出一块）",
      pg.evaluate("window.__panelSize.h") > pg.evaluate("window.__glmPanelH") + 50,
      f"火山 {pg.evaluate('window.__panelSize.h')} vs GLM {pg.evaluate('window.__glmPanelH')}")
    t("月额度块存在（GLM 只有两块）", pg.locator("#panel .pane-volc [data-win='month']").count() == 1)
    t("三块分别标着 5 小时 / 周 / 月",
      [pg.text_content("#panel .pane-volc [data-win='%s'] .wname" % k) for k in ("five", "week", "month")]
      == ["5小时额度", "周额度", "月额度"])
    t("Coding Plan 没有绝对值时不写「次」（不假装有）",
      pg.evaluate("document.querySelector(\"#panel .pane-volc [data-win='five'] .abs\").textContent.trim()") == "")
    t("脚注标出当前是哪一种套餐", "Coding Plan" in pg.text_content("#panel .pane-volc .notetxt"))

    pg.evaluate("""() => {
      const a = window.__state.providers.volc.accounts[0];
      a.data.plan = 'agent';
      a.data.five = Object.assign({}, a.data.five, { used: 250, total: 1000 });
      window.__cb(window.__state);
    }""")
    pg.wait_for_timeout(150)
    t("Agent Plan 有绝对值时显示 已用/总量",
      "250" in pg.text_content("#panel .pane-volc [data-win='five'] .abs")
      and "1,000" in pg.text_content("#panel .pane-volc [data-win='five'] .abs"))

    pg.evaluate("() => { window.__state.providers.volc.accounts[0].data.bothSubscribed = true; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)
    t("两种套餐都订了 → 脚注给出提示", "两种套餐都订了" in pg.text_content("#panel .pane-volc .notetxt"))

    pg.evaluate("() => { const a = window.__state.providers.volc.accounts[0]; a.status = 'nosub'; a.data = null; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)
    t("未开通套餐：面板显示「–」而不是 0（0 会被读成「用光了」）",
      pg.text_content("#panel .pane-volc [data-win='five'] .pv") == "–")

    pg.evaluate("() => { window.__state.view = 'capsule'; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)
    t("未开通套餐：胶囊改说人话（藏掉数据行）", "未开通套餐" in pg.text_content("#capsule .cap-volc .cap-warn")
      and pg.locator("#capsule .cap-volc .rows").is_hidden())
    pg.evaluate("() => { const a = window.__state.providers.volc.accounts[0]; a.status = 'expired'; window.__cb(window.__state); }")
    pg.wait_for_timeout(150)
    t("凭据失效：胶囊也改说人话（这条曾经因为 CSS 只匹配 GLM 的类名而漏掉）",
      "凭据失效" in pg.text_content("#capsule .cap-volc .cap-warn")
      and pg.locator("#capsule .cap-volc .rows").is_hidden())

    # 设置页：套餐下拉（渲染 + 回显当前值 + 原值提交）
    pg.evaluate("() => { window.__state.providers.volc.accounts[0].status = 'ok'; window.__state.view = 'settings'; window.__cb(window.__state); }")
    pg.set_viewport_size({"width": SETTINGS[0], "height": SETTINGS[1]})
    pg.wait_for_timeout(200)
    # 火山段在列表最底下，直接点会被吸顶的标题栏截住——先滚到可视区中间
    pg.evaluate("document.querySelector(\"#provSecs .acc-row[data-id='v1']\").scrollIntoView({ block: 'center' })")
    pg.wait_for_timeout(150)
    pg.locator("#provSecs .acc-row[data-id='v1'] [data-act='edit']").click()
    pg.wait_for_timeout(200)
    t("编辑表单里「套餐」是下拉而不是文本框",
      pg.locator("form.acc-form select[data-cred='plan']").count() == 1
      and pg.locator("form.acc-form textarea[data-cred='plan']").count() == 0)
    t("下拉回显当前套餐（coding）",
      pg.eval_on_selector("form.acc-form select[data-cred='plan']", "e => e.value") == "coding")
    t("下拉有三个选项", pg.locator("form.acc-form select[data-cred='plan'] option").count() == 3)
    t("枚举字段没有「清除」按钮（枚举没有空值语义）",
      pg.locator("form.acc-form [data-clr='plan']").count() == 0)
    t("枚举字段不进账户行尾号（不然会冒出「…auto」）",
      "auto" not in pg.text_content("#provSecs .acc-row[data-id='v1'] .atail"))
    t("AK/SK 尾号仍然显示", "xxxxxx" in pg.text_content("#provSecs .acc-row[data-id='v1'] .atail"))
    pg.locator("form.acc-form .fcancel").click()
    pg.wait_for_timeout(150)

    # ---- 停用唯一账户 = 整家不出场 ----
    # 主进程那边停用后就不再把这家放进 providers（只留在 config.accounts 里）：
    # 页签和胶囊列跟着 providers 的键走，设置页的账户行跟着 accounts 走。
    pg.evaluate("""() => {
      const s = window.__state;
      s.config.accounts.find(a => a.id === 'v1').enabled = false;
      delete s.providers.volc;
      delete s.config.active.volc;
      s.config.panelTab = 'glm';
      window.__cb(s);
    }""")
    pg.wait_for_timeout(200)
    t("停用后设置页仍有这一行（停用的是展示，不是配置）",
      pg.locator("#provSecs .acc-row[data-id='v1']").count() == 1)
    t("这一行标着「已停用」、按钮翻成「启用」",
      pg.text_content("#provSecs .acc-row[data-id='v1'] .aword") == "已停用"
      and pg.text_content("#provSecs .acc-row[data-id='v1'] [data-act='toggle']") == "启用")
    pg.evaluate("() => { window.__state.view = 'capsule'; window.__cb(window.__state); }")
    pg.wait_for_timeout(200)
    t("胶囊回到两列（火山那列收掉）", pg.locator("#capsule .cap-grp").count() == 2)
    t("分隔线只剩一条", pg.locator("#capsule .cap-sep").count() == 1)
    t("面板页签也回到两个", pg.locator("#tabs .tab").count() == 2)
    t("页签里没有「火山」", pg.locator("#tabs .tab", has_text="火山").count() == 0)

    print("provider 元数据（GLMPROV）:")
    t("三家注册且 id 正确", pg.evaluate("GLMPROV.list.map(p => p.id).join()") == "glm,deepseek,volc")
    t("凭据声明驱动设置页", pg.evaluate("GLMPROV.byId('deepseek').credentials.length") == 2)
    t("火山的套餐是下拉字段（带选项）", pg.evaluate("(() => { const c = GLMPROV.byId('volc').credentials.find(c => c.key === 'plan'); return c && c.kind === 'select' && c.options.length; })()") == 3)
    t("胶囊列宽已声明", pg.evaluate("GLMPROV.byId('glm').capsuleW") > 0)

    b.close()

print(f"\n{'全部通过' if not fails else '失败: ' + ', '.join(fails)}")
sys.exit(0 if not fails else 1)
