'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage,
  Notification, shell, screen, powerMonitor, desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('electron').net;
const { extractToken, fetchUsage } = require('./lib/usage');
const { tierOf, levelName, fmtResetTime } = require('./lib/format');

const OVERVIEW_URL = 'https://www.bigmodel.cn/coding-plan/personal/overview';
const IS_DEV = !app.isPackaged;
// 便携版每次解压到临时目录运行，exe 路径不固定，开机自启注册会失效
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const ASSET = (f) => path.join(__dirname, 'assets', f);

/* ---------------- 日志（%APPDATA%/GLM 用量挂件/main.log，异步写不挡交互） ---------------- */
let logCount = 0;
function log() {
  try {
    const parts = [];
    for (const a of arguments) {
      if (a instanceof Error) parts.push(a.stack || a.message);
      else { try { parts.push(typeof a === 'string' ? a : JSON.stringify(a)); } catch { parts.push(String(a)); } }
    }
    const file = path.join(app.getPath('userData'), 'main.log');
    fs.appendFile(file, `[${new Date().toLocaleString('sv-SE')}] ${parts.join(' ')}\n`, () => { });
    if (++logCount % 50 === 0) { // 低频环形截断
      fs.stat(file, (e, st) => {
        if (!e && st.size > 256 * 1024) {
          fs.readFile(file, (e2, buf) => {
            if (!e2) fs.writeFile(file, '--- 旧日志已截断 ---\n' + buf.slice(-128 * 1024), () => { });
          });
        }
      });
    }
  } catch { /* 日志失败不影响运行 */ }
}
process.on('uncaughtException', (e) => log('FATAL uncaughtException:', e));
process.on('unhandledRejection', (e) => log('FATAL unhandledRejection:', e));

/* ---------------- 配置 ---------------- */
const DEFAULTS = {
  token: '',
  intervalMin: 10,      // 0 = 仅手动
  notifyThreshold: 80,  // 0 = 关闭
  notifyReset: false,   // 5h 窗口重置且此前用量高时提醒
  autoStart: true,
  alwaysOnTop: true,
  zoom: 1,             // 展开态缩放（0.8–1.6，Ctrl+滚轮），胶囊不缩放
  theme: 'auto',       // auto=跟随背景明暗 | dark | light
  view: 'capsule',      // capsule | panel | settings
  pos: null,            // {x,y} 胶囊左上角
  lastData: null,       // 最近一次成功数据（重启秒显）
  lastNotifiedWindowStart: 0,
};
let config = { ...DEFAULTS };
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    config = { ...DEFAULTS, ...raw };
  } catch { /* 首次运行 */ }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2)); }
  catch (e) { log('保存配置失败:', e); }
}

/* ---------------- 运行态 ---------------- */
let win = null;
let tray = null;
let timer = null;
let fetching = false;
let lastFetchAt = 0;
let lastManualAt = 0;
let backoffUntil = 0;
let menuOpen = false;
let rendererReady = false;
let hasAcrylic = false;
let prevData = null;          // 内存中上一次数据（判断窗口滚动）
let expiredNotified = false;
let resolvedTheme = 'dark';   // 实际生效主题（auto 时由截屏采样决定）
let dragging = false;         // 拖拽进行中：看门狗静默，避免把窗口拽出移动节奏
let dragSilent = 0;
let themeDebounce = 0;

const status = { kind: 'boot', msg: '' }; // boot|loading|ok|expired|ratelimit|error|empty

// 视觉卡片尺寸；窗口 = 卡片 + 2*PAD（阴影在窗口内衰减完，避免圆角外被切出直角残影）
const PAD = 12;
const SIZES = {
  capsule: { w: 168, h: 44 },
  panel: { w: 326, h: 242 },
  settings: { w: 392, h: 712 },
};
const winSize = (view) => {
  const s = SIZES[view] || SIZES.capsule;
  return { w: s.w + PAD * 2, h: s.h + PAD * 2 };
};

/* ---------------- 窗口与视图 ---------------- */
function workArea() { return screen.getPrimaryDisplay().workArea; }

/** 某个矩形所在显示器的工作区 */
function waFor(b) { return screen.getDisplayMatching(b).workArea; }

/** 所有显示器工作区的并集（拖拽可自由跨屏） */
function waUnion() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const d of screen.getAllDisplays()) {
    const w = d.workArea;
    x1 = Math.min(x1, w.x); y1 = Math.min(y1, w.y);
    x2 = Math.max(x2, w.x + w.width); y2 = Math.max(y2, w.y + w.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function defaultPos() {
  const wa = workArea();
  return { x: wa.x + wa.width - winSize('capsule').w - 20, y: wa.y + 16 };
}

function capsulePos() { return config.pos || defaultPos(); }

function clampX(x, w) {
  const wa = workArea();
  return Math.min(Math.max(x, wa.x), wa.x + wa.width - w);
}

function applyView(view) {
  config.view = view;
  // 展开态按 zoom 等比缩放（内容 setZoomFactor + 窗口尺寸同步乘 zoom）；胶囊保持原始大小
  const factor = view === 'capsule' ? 1 : (config.zoom || 1);
  try { win.webContents.setZoomFactor(factor); } catch { }
  const base = winSize(view);
  const s = { w: Math.round(base.w * factor), h: Math.round(base.h * factor) };
  const cp = capsulePos();
  let b;
  if (view === 'capsule') {
    const wa = waFor({ x: cp.x, y: cp.y, width: s.w, height: s.h });
    b = {
      x: Math.min(Math.max(cp.x, wa.x), wa.x + wa.width - s.w),
      y: Math.min(Math.max(cp.y, wa.y), wa.y + wa.height - s.h),
      width: s.w, height: s.h,
    };
  } else {
    // 与胶囊同一左上角、向右下生长：窗口原点不跳变，越界才收回工作区内
    const wa = waFor({ x: cp.x, y: cp.y, width: s.w, height: s.h });
    const x = Math.min(Math.max(cp.x, wa.x), wa.x + wa.width - s.w);
    const y = Math.min(Math.max(cp.y, wa.y), wa.y + wa.height - s.h);
    b = { x, y, width: s.w, height: s.h };
  }
  // Windows 透明窗口 resizable:false 时改尺寸会静默失效 → 临时解锁再锁回。
  // 交互关键路径上只做这一件事：日志/置顶重申/广播推迟一拍，避免挡住窗口重绘造成顿挫
  win.setResizable(true);
  win.setBounds(b);
  win.setResizable(false);
  setImmediate(() => {
    assertTopmost(); // 样式操作可能扰动 z 序，随手自愈
    log('view →', view, JSON.stringify(b));
    broadcast();
  });
}

function setView(view) {
  if (!win) return;
  applyView(view);
}

/* 置顶自愈：样式操作/拖拽/其他置顶窗口都可能把本窗挤出置顶带，
   关键节点 + 定时重申（setAlwaysOnTop/moveTop 均不激活窗口、不抢焦点）；
   拖拽进行中静默——中途 SetWindowPos 会打断拖拽节奏 */
function assertTopmost() {
  if (!win || win.isDestroyed() || !config.alwaysOnTop || dragging) return;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  } catch { /* 窗口销毁竞态，忽略 */ }
}

/* ---------------- 状态广播 ---------------- */
/* ---------------- 主题：截屏采样背景明暗 ---------------- */
function avgLum(img) {
  const bm = img.toBitmap(); // BGRA
  let sum = 0, n = 0;
  for (let i = 0; i + 3 < bm.length; i += 4) {
    sum += 0.2126 * bm[i + 2] + 0.7152 * bm[i + 1] + 0.0722 * bm[i];
    n++;
  }
  return n ? sum / n / 255 : null;
}

/** 采样窗口四周环带的平均亮度（0~1）；全贴边时退化为整屏均值 */
async function sampleAround() {
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const tw = 240;
  const th = Math.max(1, Math.round((tw * d.bounds.height) / d.bounds.width));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tw, height: th } });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  const img = src && src.thumbnail;
  if (!img || img.isEmpty()) return null;
  const { width: W, height: H } = img.getSize();
  const sx = W / d.bounds.width, sy = H / d.bounds.height;
  const m = 56; // 环带宽度（物理像素）
  const x1 = Math.round((b.x - d.bounds.x) * sx);
  const x2 = Math.round(((b.x + b.width) - d.bounds.x) * sx);
  const y1 = Math.round((b.y - d.bounds.y) * sy);
  const y2 = Math.round(((b.y + b.height) - d.bounds.y) * sy);
  const bw = Math.max(2, Math.round(m * sx)), bh = Math.max(2, Math.round(m * sy));
  const bands = [
    { x: x1, y: Math.max(0, y1 - bh), width: x2 - x1, height: Math.min(bh, y1) },   // 上
    { x: x1, y: y2, width: x2 - x1, height: Math.min(bh, H - y2) },                 // 下
    { x: Math.max(0, x1 - bw), y: y1, width: Math.min(bw, x1), height: y2 - y1 },   // 左
    { x: x2, y: y1, width: Math.min(bw, W - x2), height: y2 - y1 },                 // 右
  ].filter((r) => r.width >= 2 && r.height >= 2);
  if (!bands.length) return avgLum(img.resize({ width: 32, height: 32 }));
  let sum = 0, wgt = 0;
  for (const r of bands) {
    const lum = avgLum(img.crop(r).resize({ width: 12, height: 4 }));
    if (lum == null) continue;
    sum += lum * r.width * r.height;
    wgt += r.width * r.height;
  }
  return wgt ? sum / wgt : null;
}

async function applyTheme() {
  try {
    if (config.theme !== 'auto') {
      resolvedTheme = config.theme;
    } else if (win) {
      const lum = await sampleAround();
      if (lum != null) {
        // 双阈值迟滞：暗→亮需 >0.55，亮→暗需 <0.45，中间保持现主题
        // （定时采样后必须防抖：窗口边缘在采样环带内晃动时不来回横跳）
        let next = resolvedTheme;
        if (resolvedTheme === 'light' && lum < 0.45) next = 'dark';
        else if (resolvedTheme === 'dark' && lum > 0.55) next = 'light';
        if (next !== resolvedTheme) log('主题切换 →', next, `背景亮度 ${lum.toFixed(2)}`);
        resolvedTheme = next;
      }
    }
  } catch (e) { log('主题采样失败（保持现主题）:', e && e.message); }
  broadcast();
}

function buildState() {
  return {
    view: config.view,
    status: status.kind,
    msg: status.msg,
    data: config.lastData,
    lastFetchAt,
    hasAcrylic,
    theme: resolvedTheme,
    platform: process.platform,
    config: {
      hasToken: !!config.token,
      token: config.token,
      intervalMin: config.intervalMin,
      notifyThreshold: config.notifyThreshold,
      notifyReset: config.notifyReset,
      autoStart: config.autoStart,
      alwaysOnTop: config.alwaysOnTop,
      zoom: config.zoom || 1,
      theme: config.theme,
      isPortable: IS_PORTABLE,
    },
  };
}
function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', buildState());
  updateTray();
}

/* ---------------- 刷新 ---------------- */
async function doFetch() {
  // Electron net 走系统代理与 Chromium 网络栈；失败退回 Node fetch（尊享 NODE_USE_ENV_PROXY）
  try { return await fetchUsage(config.token, (u, o) => net.fetch(u, o)); }
  catch { return fetchUsage(config.token); }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, icon: nativeImage.createFromPath(ASSET('icon.png')), silent: false });
      n.on('click', () => { if (win) { win.show(); setView('panel'); } });
      n.show();
    }
  } catch { /* 通知失败不影响主流程 */ }
}

function schedule() {
  if (timer) clearTimeout(timer);
  const min = config.intervalMin > 0 ? config.intervalMin : 0;
  if (!min) return;
  const jitter = (Math.random() * 40 - 20) * 1000; // ±20s，避免整点齐射
  timer = setTimeout(refresh, min * 60000 + jitter);
}

async function refresh(manual = false) {
  if (!config.token) { status.kind = 'empty'; status.msg = ''; broadcast(); return; }
  if (fetching) return;
  if (manual) {
    if (Date.now() - lastManualAt < 30 * 1000) { broadcast(); return; }
    lastManualAt = Date.now();
  }
  fetching = true;
  status.kind = 'loading'; status.msg = '';
  broadcast();
  const r = await doFetch();
  fetching = false;
  lastFetchAt = Date.now();
  lastDataKeeper: {
    if (r.ok) {
      const wasExpired = status.kind === 'expired';
      prevData = config.lastData;
      config.lastData = r.data;
      status.kind = 'ok'; status.msg = '';
      saveConfig();

      if (wasExpired) notify('Cookie 已恢复', '用量数据恢复正常刷新');
      expiredNotified = false;

      const five = r.data.five;
      // 超额提醒：每个 5h 窗口至多一次
      if (config.notifyThreshold > 0 && five.percent >= config.notifyThreshold &&
          config.lastNotifiedWindowStart !== five.windowStart) {
        config.lastNotifiedWindowStart = five.windowStart;
        saveConfig();
        notify(`5小时额度已用 ${five.percent}%`,
          `剩余 ${Math.round(five.remaining).toLocaleString('en-US')} 积分 · ${fmtResetTime(five.nextResetTime)} 重置`);
      }
      // 重置回满提醒：窗口滚动且此前用量过半
      if (config.notifyReset && prevData && prevData.five &&
          prevData.five.windowStart !== five.windowStart && prevData.five.percent >= 50) {
        notify('5小时额度已重置', '新窗口已开启，额度回满');
      }
      backoffUntil = 0;
      break lastDataKeeper;
    }
    if (r.kind === 'expired') {
      status.kind = 'expired'; status.msg = r.msg;
      if (!expiredNotified) { notify('Cookie 已过期', '点击挂件更新 Cookie'); expiredNotified = true; }
      break lastDataKeeper;
    }
    if (r.kind === 'ratelimit') {
      status.kind = 'ratelimit'; status.msg = r.msg;
      const base = config.intervalMin > 0 ? config.intervalMin : 10;
      backoffUntil = Date.now() + base * 2 * 60000;
      break lastDataKeeper;
    }
    status.kind = 'error'; status.msg = r.msg; // 保留 lastData 展示旧值
  }
  broadcast();
  schedule();
  applyTheme(); // 顺带每轮刷新重新采样背景明暗
  log('refresh 结果 ·', status.kind, status.msg || '', config.lastData ? `5h=${config.lastData.five.percent}% 周=${config.lastData.week.percent}%` : '无数据');
}

/* ---------------- 托盘 ---------------- */
let trayIconCache = { url: '', tier: '' };

function updateTray() {
  if (!tray) return;
  let tip;
  const d = config.lastData;
  if (status.kind === 'ok' && d) {
    const lv = d.level ? ` ${levelName(d.level)}` : '';
    tip = `GLM Coding${lv}\n5小时 ${d.five.percent}% · 周 ${d.week.percent}%\n重置 ${fmtResetTime(d.five.nextResetTime)}`;
  } else if (status.kind === 'expired') tip = 'GLM 用量挂件\nCookie 已过期，点击更新';
  else if (status.kind === 'ratelimit') tip = 'GLM 用量挂件\n限流退避中，稍后自动重试';
  else if (status.kind === 'empty') tip = 'GLM 用量挂件\n未配置 Cookie，点击设置';
  else tip = 'GLM 用量挂件';
  tray.setToolTip(tip);

  // 动态图标：状态未变化时不重设
  const tier = status.kind === 'ok' && d ? tierOf(d.five.percent) : status.kind === 'expired' ? 'high' : 'low';
  if (trayIconCache.tier !== tier || !trayIconCache.url) {
    if (trayIconCache.url) { try { tray.setImage(nativeImage.createFromDataURL(trayIconCache.url)); } catch { } }
    trayIconCache.tier = tier; // url 由渲染层推送
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: config.view === 'capsule' ? '展开面板' : '收起为胶囊', click: () => setView(config.view === 'capsule' ? 'panel' : 'capsule') },
    { label: '设置', click: () => setView('settings') },
    { label: '立即刷新', click: () => refresh(true) },
    { label: '打开日志文件夹', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '打开官网', click: () => shell.openExternal(OVERVIEW_URL) },
    { label: '窗口置顶', type: 'checkbox', checked: config.alwaysOnTop,
      click: (m) => save({ alwaysOnTop: m.checked }) },
    { label: '开机自启', type: 'checkbox', checked: config.autoStart,
      click: (m) => save({ autoStart: m.checked }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ASSET('tray.png')));
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => setView(config.view === 'capsule' ? 'panel' : 'capsule'));
  updateTray();
}

/* ---------------- 配置保存（含副作用） ---------------- */
function save(patch) {
  let tokenChanged = false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS) || k === 'view' || k === 'pos' || k === 'lastData') continue;
    if (k === 'token') {
      const t = extractToken(String(v));
      if (!t && String(v).trim() !== '') continue; // 无法解析且非清空意图 → 忽略
      if (t !== config.token) tokenChanged = true;
      config.token = t;
      continue;
    }
    if (k === 'theme' && !['auto', 'dark', 'light'].includes(v)) continue;
    config[k] = v;
  }
  saveConfig();

  if ('autoStart' in (patch || {}) && !IS_PORTABLE) {
    app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
  }
  if ('alwaysOnTop' in (patch || {}) && win) {
    win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  }
  if ('intervalMin' in (patch || {}) || 'notifyThreshold' in (patch || {})) {
    config.lastNotifiedWindowStart = 0; // 设置变更后重置提醒去重
  }
  broadcast();
  schedule();
  if (tokenChanged) {
    expiredNotified = false;
    refresh(true);
  }
  if ('theme' in (patch || {})) applyTheme(); // 强制主题立即生效；auto 也会重新采样
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const s = winSize('capsule');
  const p = capsulePos();
  win = new BrowserWindow({
    x: clampX(p.x, s.w), y: p.y,
    width: s.w, height: s.h,
    transparent: true, frame: false,
    resizable: false, thickFrame: false, // 改尺寸在 applyView 里临时解锁，平时锁死以避免系统隐形调节柄
    skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      devTools: IS_DEV,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');

  // 拖拽走渲染层 JS（pointer 事件 + rAF 合帧），原生 app-region 方案已回退：
  // 标题栏化导致右键弹系统菜单、单击事件不可靠
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 渲染层 console/error 抄进 main.log（preload 或 app.js 崩溃也能看到）
  win.webContents.on('console-message', (event, legacyLevel, legacyMsg, legacyLine, legacySrc) => {
    const d = event && event.message !== undefined
      ? event
      : { level: legacyLevel, message: legacyMsg, lineNumber: legacyLine, sourceId: legacySrc };
    const lv = Number(d.level) || 0;
    if (lv >= 2 || /GLM_APP|NO_GLM|初始化失败/.test(String(d.message))) {
      log(`[renderer L${lv}] ${d.message} ${d.sourceId || ''}:${d.lineNumber == null ? '' : d.lineNumber}`);
    }
  });
  win.webContents.on('did-finish-load', () => log('renderer did-finish-load · preload 存在:', fs.existsSync(path.join(__dirname, 'preload.js'))));
  win.webContents.on('render-gone', (_e, details) => log('FATAL render-gone:', details && details.reason));

  // 5 秒还没收到 renderer:ready → 渲染层启动失败，日志里通常有上面的 [renderer] 报错
  setTimeout(() => { if (!rendererReady) log('WARN renderer:ready 5s 未到达（preload/app.js 崩溃?）'); }, 5000);

  // 失焦不再自动收起：收起只由「点击浮窗非按钮处 / Esc / 托盘」触发
  win.on('closed', () => { win = null; });

  // v0.1.1 停用 Win11 亚克力：与透明无边框窗口组合存在「窗口收不到任何鼠标输入」的已知问题

  if (IS_DEV) win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') win.webContents.toggleDevTools();
  });
}

function popupWindowMenu() {
  menuOpen = true;
  Menu.buildFromTemplate([
    { label: '设置', click: () => setView('settings') },
    { label: '立即刷新', click: () => refresh(true) },
    { label: '打开日志文件夹', click: () => shell.openPath(app.getPath('userData')) },
    { label: '打开官网', click: () => shell.openExternal(OVERVIEW_URL) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ callback: () => { menuOpen = false; } });
}

/* ---------------- IPC ---------------- */
function bindIpc() {
  ipcMain.on('renderer:boot-error', (_e, msg) => log('FATAL renderer:boot-error:', msg));
  ipcMain.handle('state:get', () => buildState());
  ipcMain.handle('cfg:save', (_e, patch) => {
    const keys = patch ? Object.keys(patch) : [];
    log('ipc cfg:save', keys.join(','), patch && 'token' in patch ? `(token ${String(patch.token || '').length} 字符)` : '');
    save(patch); return buildState();
  });
  ipcMain.handle('refresh:now', async () => { log('ipc refresh:now'); await refresh(true); return buildState(); });
  ipcMain.handle('clipboard:peek', () => extractToken(require('electron').clipboard.readText()));

  ipcMain.on('view:set', (_e, v) => {
    log('ipc view:set', v);
    setView(['capsule', 'panel', 'settings'].includes(v) ? v : 'capsule');
    setTimeout(applyTheme, 150); // 截屏采样移出展开/收起的关键路径
  });
  ipcMain.on('zoom:set', (_e, z) => {
    const nz = Math.min(1.6, Math.max(0.8, Number(z) || 1));
    config.zoom = Math.round(nz * 20) / 20;
    saveConfig();
    log('zoom →', config.zoom);
    applyView(config.view);
    broadcast();
  });
  let lastDragLog = 0;
  ipcMain.on('win:drag', (_e, { dx, dy }) => {
    if (!win) return;
    dragging = true;
    clearTimeout(dragSilent);
    dragSilent = setTimeout(() => { dragging = false; }, 400); // 渲染层丢帧兜底
    const now = Date.now();
    if (now - lastDragLog > 2000) { log('ipc win:drag …'); lastDragLog = now; }
    const [x, y] = win.getPosition();
    const [bw, bh] = win.getSize();
    const wa = waUnion(); // 并集：允许拖到任意显示器
    const nx = Math.min(Math.max(x + dx, wa.x), wa.x + wa.width - bw);
    const ny = Math.min(Math.max(y + dy, wa.y), wa.y + wa.height - bh);
    win.setPosition(nx, ny, false);
  });
  ipcMain.on('win:drag-end', () => {
    if (!win) return;
    dragging = false;
    clearTimeout(dragSilent);
    config.pos = { x: win.getPosition()[0], y: win.getPosition()[1] };
    saveConfig();
    assertTopmost();
    // 落定后再采样背景，避免拖拽尾顿（desktopCapturer 截屏有开销）
    clearTimeout(themeDebounce);
    themeDebounce = setTimeout(applyTheme, 350);
  });
  ipcMain.on('ctx:menu', popupWindowMenu);
  ipcMain.on('tray:icon', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('data:image/')) {
      trayIconCache.url = url;
      try { tray && tray.setImage(nativeImage.createFromDataURL(url)); } catch { }
    }
  });
  ipcMain.on('open:external', (_e, u) => {
    // 允许 bigmodel.cn 任意子域（此前正则漏配 www. 导致按钮静默失效）
    if (typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*bigmodel\.cn(\/|$)/i.test(u)) shell.openExternal(u);
    else log('open:external 拒绝非 bigmodel 域名:', u);
  });
  ipcMain.on('app:quit', () => app.quit());
  ipcMain.on('renderer:ready', () => {
    rendererReady = true;
    log('renderer:ready ✓ · 静默出场不抢焦点');
    applyView('capsule'); // 启动一律从胶囊开始
    win.showInactive();   // 挂件不抢焦点（登录自启时不会打断正在输入的窗口）
    applyTheme();
    refresh(true);
  });
}

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); setView('panel'); }
  });

  app.whenReady().then(() => {
    loadConfig();
    log('boot ·', JSON.stringify({
      electron: process.versions.electron, node: process.versions.node,
      platform: process.platform, portable: IS_PORTABLE, dev: IS_DEV,
      hasToken: !!config.token, savedView: config.view, pos: config.pos,
    }), '· userData =', app.getPath('userData'));
    // 立即应用自启设置（清理遗留或首启）；便携版不支持
    if (!IS_PORTABLE) app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
    try { createWindow(); log('window created'); }
    catch (e) { log('FATAL createWindow:', e); }
    try { createTray(); log('tray created'); }
    catch (e) { log('FATAL createTray:', e); }
    try { bindIpc(); log('ipc bound'); } catch (e) { log('FATAL bindIpc:', e); }
    schedule();

    powerMonitor.on('resume', () => setTimeout(() => { assertTopmost(); refresh(true); }, 5000));

    // 置顶看门狗：每 5 秒重申一次，覆盖其他置顶窗口的挤压
    setInterval(assertTopmost, 5000);
    win.on('show', assertTopmost);

    // 背景明暗巡逻：浮窗不动、底下窗口切换（深↔浅）也要跟着换肤；拖拽中不采样
    setInterval(() => { if (!dragging) applyTheme(); }, 20000);
    screen.on('display-metrics-changed', () => {
      if (win) { applyView(config.view); applyTheme(); } // 显示器变化后收回工作区内并重采样
    });

    app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
  });
}

app.on('before-quit', () => {
  if (win && !win.isDestroyed()) {
    config.pos = { x: win.getPosition()[0], y: win.getPosition()[1] };
    config.view = 'capsule';
    saveConfig();
  }
});
