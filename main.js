'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage,
  Notification, shell, screen, powerMonitor, desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('electron').net;
const { extractToken, fetchUsage } = require('./lib/usage');
const {
  extractDsToken, extractPlatformToken, fetchBalance, fetchMonthlyCost, fetchMonthlyAmount,
} = require('./lib/deepseek');
const dsHistory = require('./lib/ds-history');
const { tierOf, levelName, fmtResetTime, fmtPoints, fmtMoney, normWarn } = require('./lib/format');
const drag = require('./lib/drag');

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
  warnThreshold: 80,    // 提醒阈值（%）：同时决定变色档位与系统通知，1–99
  paceAlert: true,      // 实际用量超过预期进度时变色提醒
  notifyReset: false,   // 5h 窗口重置且此前用量高时提醒
  autoStart: true,
  alwaysOnTop: true,
  zoom: 1,             // 展开态缩放（0.8–1.6，Ctrl+滚轮），胶囊不缩放
  theme: 'auto',       // auto=跟随背景明暗 | dark | light
  view: 'capsule',      // capsule | panel | settings
  panelTab: 'glm',      // glm | ds（展开面板当前视图）
  pos: null,            // {x,y} 胶囊左上角
  lastData: null,       // 最近一次成功数据（重启秒显）
  lastNotifiedWindowStart: 0,   // 5h 窗口提醒去重（存 windowStart）
  lastNotifiedWeekStart: 0,     // 周窗口提醒去重（同上）
};
// DeepSeek 相关（凭证与缓存）：与 GLM 的 token 分开，缺失即视为未启用
const DS_DEFAULTS = {
  dsToken: '',          // 官方 API Key（sk-…），长期有效 → 余额
  dsPlatformToken: '',  // 平台 userToken（选配，短命）→ 精确账单
  dsRange: '7d',        // 面板图表区间：1h | 24h | 7d | 30d
  dsPollMin: 2,         // 余额单独轮询间隔（分钟，0=关闭）：实时读数的分辨率就是它
  lastDs: null,         // 最近一次成功的 DeepSeek 快照（重启秒显）
};
const ALL_DEFAULTS = { ...DEFAULTS, ...DS_DEFAULTS };
let config = { ...ALL_DEFAULTS };
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    // 旧配置迁移：notifyThreshold 时代 0 = 关闭通知，现在阈值只管高低
    if (raw.notifyThreshold != null && raw.warnThreshold == null) {
      const old = Number(raw.notifyThreshold);
      raw.warnThreshold = old === 0 ? 99 : old;
    }
    delete raw.notifyThreshold;
    // dsDays 时代只有 7/30 两档，换成带 1 小时 / 24 小时的四档区间
    if (raw.dsDays != null && raw.dsRange == null) raw.dsRange = Number(raw.dsDays) === 30 ? '30d' : '7d';
    delete raw.dsDays;
    config = { ...ALL_DEFAULTS, ...raw };
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
let dragCtx = null;           // 拖拽上下文：{ ctx, pending, timer, idle, lastX, lastY } —— 见 bindIpc
let dragDiag = false;         // 下次采样时打一条坐标系诊断日志（排障用，一次即止）
let dragging = false;         // 拖拽进行中：看门狗静默、主题巡逻暂停
let themeDebounce = 0;
let lastParseRetryAt = 0;     // 解析失败自动重试的节流

const status = { kind: 'boot', msg: '' }; // boot|loading|ok|expired|ratelimit|error|empty

/* ---------------- DeepSeek 运行态 ----------------
   两条链路各自记状态：余额（API Key，长期有效）与平台账单（userToken，短命、选配）。
   平台链路挂掉只降级「精确账单」，余额与本地差值口径照常工作。 */
const ds = {
  status: 'empty',      // empty|loading|ok|expired|ratelimit|error
  msg: '',
  lastFetchAt: 0,
  balance: null,        // fetchBalance().data
  pStatus: 'empty',     // 平台账单链路
  pMsg: '',
  pLastFetchAt: 0,
  costMonths: null,     // [本月, 上月] 的 fetchMonthlyCost().data
  amount: null,         // fetchMonthlyAmount().data
  summary: null,        // summarize()/summarizePlatform() 结果，供面板直接渲染
};
let dsSamples = [];            // 余额样本 [[ts, 余额], …]
let dsExpiredNotified = false;
let dsPlatformExpiredNotified = false;
let dsTimer = null;            // 余额单独轮询的定时器
let dsPolling = false;         // 余额轮询进行中（避免与主周期叠加）
const DS_HISTORY_PATH = () => path.join(app.getPath('userData'), 'ds-history.json');

function loadDsHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(DS_HISTORY_PATH(), 'utf8'));
    if (Array.isArray(raw)) {
      dsSamples = raw
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map(([t, b]) => [Number(t), Number(b)])
        .filter(([t, b]) => Number.isFinite(t) && Number.isFinite(b));
    }
  } catch { /* 首次运行 / 文件损坏：从空历史开始 */ }
}

function saveDsHistory() {
  try { fs.writeFileSync(DS_HISTORY_PATH(), JSON.stringify(dsSamples)); }
  catch (e) { log('保存 DS 差值历史失败:', e); }
}

/** 记一个余额样本（内部会抽稀：值没变的轮询不落盘） */
function recordSample(ts, balance) {
  const before = dsSamples;
  const next = dsHistory.appendSample(before, ts, balance);
  const lastChanged = next.length && before.length && next[next.length - 1][1] !== before[before.length - 1][1];
  if (next.length === before.length && !lastChanged) return;
  dsSamples = next;
  saveDsHistory();
}

/** 用平台账单（权威）或本地差值重算汇总；余额用作「预估可用天数」的分子 */
function refreshDsSummary() {
  const balance = ds.balance ? ds.balance.total : null;
  const days = dsRangeDays();
  const now = Date.now();
  // 平台账单给的是已结算的日粒度数字；实时读数（近 1 小时 / 24 小时图）永远来自本地样本
  ds.summary = (ds.costMonths && ds.costMonths.length)
    ? dsHistory.summarizePlatform(ds.costMonths, now, { days, balance, samples: dsSamples })
    : dsHistory.summarize(dsSamples, now, { days, balance });
}

/** 逐日序列的长度：24h 档用不上它（图表走 summary.hourly），给 7 即可 */
const dsRangeDays = () => (config.dsRange === '30d' ? 30 : 7);

// 视觉卡片尺寸；窗口 = 卡片 + 2*PAD（阴影在窗口内衰减完，避免圆角外被切出直角残影）
const PAD = 12;
// 胶囊是双列布局：左 GLM 右 DeepSeek；只配了一边就收回单列宽度
const CAPSULE = { both: 188, single: 152, h: 40 };
const SIZES = {
  // 两个页签**同高**：切页签时窗口尺寸一个像素都不动，视觉上完全不跳
  panel: { w: 326, h: 270 },
  settings: { w: 392, h: 712 },  // 内容本身可滚动，窗口高度不再随内容增长
};

function winSize(view) {
  if (view === 'capsule') {
    const both = !!config.token && !!config.dsToken;
    return { w: (both ? CAPSULE.both : CAPSULE.single) + PAD * 2, h: CAPSULE.h + PAD * 2 };
  }
  const s = SIZES[view] || SIZES.panel;
  return { w: s.w + PAD * 2, h: s.h + PAD * 2 };
}

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

function clampY(y, h) {
  const wa = workArea();
  return Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
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

/** 只把凭据尾号下发给渲染层用于回显，明文不出主进程 */
const tail = (t) => (t ? String(t).slice(-6) : '');

function buildState() {
  return {
    view: config.view,
    hasAcrylic,
    theme: resolvedTheme,
    platform: process.platform,
    providers: {
      glm: {
        status: status.kind,
        msg: status.msg,
        data: config.lastData,
        lastFetchAt,
      },
      ds: {
        status: ds.status,
        msg: ds.msg,
        lastFetchAt: ds.lastFetchAt,
        balance: ds.balance,        // {currency,total,granted,toppedUp,available}
        summary: ds.summary,        // 今日/近7/近30/本月/日均/可用天数/逐日序列
        tokens: ds.amount,          // 本月 token 分类（需平台令牌）
        platform: { status: ds.pStatus, msg: ds.pMsg, lastFetchAt: ds.pLastFetchAt },
      },
    },
    config: {
      hasToken: !!config.token,
      tokenTail: tail(config.token),
      intervalMin: config.intervalMin,
      warnThreshold: normWarn(config.warnThreshold),
      paceAlert: !!config.paceAlert,
      notifyReset: config.notifyReset,
      autoStart: config.autoStart,
      alwaysOnTop: config.alwaysOnTop,
      zoom: config.zoom || 1,
      theme: config.theme,
      panelTab: config.panelTab === 'ds' ? 'ds' : 'glm',
      dsRange: ['1h', '24h', '7d', '30d'].includes(config.dsRange) ? config.dsRange : '7d',
      dsPollMin: Number(config.dsPollMin) || 0,
      dsHasToken: !!config.dsToken,
      dsTokenTail: tail(config.dsToken),
      dsHasPlatform: !!config.dsPlatformToken,
      dsPlatformTail: tail(config.dsPlatformToken),
      isPortable: IS_PORTABLE,
    },
  };
}
function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', buildState());
  updateTray();
}

/* ---------------- 刷新 ---------------- */
/** Electron net 走系统代理与 Chromium 网络栈；失败退回 Node fetch（尊享 NODE_USE_ENV_PROXY） */
async function withNet(fn) {
  try { return await fn((u, o) => net.fetch(u, o)); }
  catch { return fn(); }
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

/**
 * 超额提醒：5h 与周两个窗口共用同一个阈值（与进度条变色档位同源），
 * 各自跨过阈值时提醒一次，按 windowStart 去重（窗口滚动后才可能再次提醒）。
 * 两个窗口同一轮都越线时合成一条，避免连弹两条。
 */
function notifyOverQuota(data) {
  const w = normWarn(config.warnThreshold);
  const checks = [
    { key: 'lastNotifiedWindowStart', win: data.five, name: '5小时额度' },
    { key: 'lastNotifiedWeekStart', win: data.week, name: '周额度' },
  ];
  const hits = [];
  for (const c of checks) {
    if (!c.win || c.win.windowStart == null) continue;
    if (c.win.percent < w || config[c.key] === c.win.windowStart) continue;
    config[c.key] = c.win.windowStart;
    hits.push(c);
  }
  if (!hits.length) return;
  saveConfig();
  const reset = (win) => (win.nextResetTime ? `${fmtResetTime(win.nextResetTime)} 重置` : '重置时间未知');
  notify(
    hits.map((c) => `${c.name}已用 ${c.win.percent}%`).join(' · '),
    hits.map((c) => `剩余 ${fmtPoints(c.win.remaining)} · ${reset(c.win)}`).join('\n'),
  );
}

function schedule() {
  if (timer) clearTimeout(timer);
  const min = config.intervalMin > 0 ? config.intervalMin : 0;
  if (!min) return;
  const jitter = (Math.random() * 40 - 20) * 1000; // ±20s，避免整点齐射
  timer = setTimeout(refresh, min * 60000 + jitter);
}

/**
 * 余额单独的高频轮询：官方余额接口又便宜又是公开文档接口，
 * 没必要跟 GLM 配额、平台账单挤在一个 10 分钟的周期里。
 * 差值历史的分辨率就等于这个频率——「最近 1 小时」「24 小时图」全靠它。
 */
function scheduleDs() {
  if (dsTimer) clearTimeout(dsTimer);
  const min = Number(config.dsPollMin);
  if (!(min > 0) || !config.dsToken) return;
  const jitter = (Math.random() * 20 - 10) * 1000; // ±10s
  dsTimer = setTimeout(async () => {
    await pollDsBalance();
    scheduleDs();
  }, min * 60000 + jitter);
}

/** 只拉余额、只记样本：不碰 GLM 配额，也不碰平台账单接口（后者是私有接口，要克制） */
async function pollDsBalance() {
  if (!config.dsToken || fetching || dsPolling) return;
  dsPolling = true;
  try {
    const prevKind = ds.status;
    const r = await withNet((f) => fetchBalance(config.dsToken, f));
    ds.lastFetchAt = Date.now();
    if (r.ok) {
      ds.balance = r.data;
      ds.status = 'ok'; ds.msg = '';
      if (prevKind === 'expired') notify('DeepSeek 已恢复', '余额数据恢复正常刷新');
      dsExpiredNotified = false;
      recordSample(r.data.fetchedAt, r.data.total);
      config.lastDs = r.data;
      saveConfig();
      refreshDsSummary();
      broadcast();
      return;
    }
    // 高频轮询失败不覆盖状态：让主周期的完整刷新去报错（避免偶发网络抖动刷屏）
    if (r.kind === 'expired') {
      ds.status = 'expired'; ds.msg = r.msg;
      if (!dsExpiredNotified) { notify('DeepSeek API Key 已失效', '点击挂件更新 API Key'); dsExpiredNotified = true; }
      broadcast();
    }
  } finally {
    dsPolling = false;
  }
}

/** GLM 链路：配额百分比。prevKind 是发起前的状态，用来识别「从失效中恢复」 */
async function refreshGlm(prevKind) {
  const r = await withNet((f) => fetchUsage(config.token, f));
  lastFetchAt = Date.now();
  if (r.ok) {
    prevData = config.lastData;
    config.lastData = r.data;
    status.kind = 'ok'; status.msg = '';
    saveConfig();

    if (prevKind === 'expired') notify('Token 已恢复', '用量数据恢复正常刷新');
    expiredNotified = false;

    notifyOverQuota(r.data);
    // 重置回满提醒：窗口滚动且此前用量过半
    if (config.notifyReset && prevData && prevData.five &&
        prevData.five.windowStart !== r.data.five.windowStart && prevData.five.percent >= 50) {
      notify('5小时额度已重置', '新窗口已开启，额度回满');
    }
    backoffUntil = 0;
    return;
  }
  if (r.kind === 'expired') {
    status.kind = 'expired'; status.msg = r.msg;
    if (!expiredNotified) { notify('Token 已失效', '点击挂件更新 Token'); expiredNotified = true; }
    return;
  }
  if (r.kind === 'ratelimit') {
    status.kind = 'ratelimit'; status.msg = r.msg;
    const base = config.intervalMin > 0 ? config.intervalMin : 10;
    backoffUntil = Date.now() + base * 2 * 60000;
    return;
  }
  status.kind = 'error'; status.msg = r.msg; // 保留 lastData 展示旧值
  // 解析失败多为过渡态（如 5h 窗口滚动瞬间字段不全）：15 秒后自动重试一次（5 分钟内最多一次）
  if (r.kind === 'parse' && Date.now() - lastParseRetryAt > 5 * 60 * 1000) {
    lastParseRetryAt = Date.now();
    log('解析失败，15 秒后自动重试');
    setTimeout(() => refresh(false), 15000);
  }
}

/** DeepSeek 余额链路（官方 API Key，长期有效）。prevKind 是发起前的状态，用来识别「从失效中恢复」 */
async function refreshDs(prevKind) {
  if (!config.dsToken) {
    ds.status = 'empty'; ds.msg = ''; ds.balance = null;
    ds.pStatus = 'empty'; ds.pMsg = '';
    refreshDsSummary();
    return;
  }
  const r = await withNet((f) => fetchBalance(config.dsToken, f));
  ds.lastFetchAt = Date.now();
  if (r.ok) {
    ds.balance = r.data;
    ds.status = 'ok'; ds.msg = '';
    if (prevKind === 'expired') notify('DeepSeek 已恢复', '余额数据恢复正常刷新');
    dsExpiredNotified = false;
    recordSample(r.data.fetchedAt, r.data.total);   // 喂给差值历史
    config.lastDs = r.data;
    saveConfig();
  } else if (r.kind === 'expired') {
    ds.status = 'expired'; ds.msg = r.msg;
    if (!dsExpiredNotified) { notify('DeepSeek API Key 已失效', '点击挂件更新 API Key'); dsExpiredNotified = true; }
  } else {
    ds.status = r.kind === 'ratelimit' ? 'ratelimit' : 'error';
    ds.msg = r.msg;
  }
  await refreshDsPlatform();
  refreshDsSummary();
}

/**
 * 平台账单链路（选配，userToken 会过期）。
 * 一次拉当前月 + 上个月：当前月给「本月」，上月补全「近 30 天」跨月的部分。
 * 平台按 UTC 日界切天，界面会标注口径。轮询频率跟随 intervalMin（默认 10 分钟，
 * 远低于社区建议的 60 秒下限，不会触发风控）。
 */
async function refreshDsPlatform() {
  if (!config.dsPlatformToken) {
    ds.pStatus = 'empty'; ds.pMsg = ''; ds.costMonths = null; ds.amount = null;
    return;
  }
  const prevKind = ds.pStatus;
  ds.pStatus = 'loading';
  const now = new Date();
  const cur = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const pm = new Date(Date.UTC(cur.year, cur.month - 2, 1));
  const prev = { year: pm.getUTCFullYear(), month: pm.getUTCMonth() + 1 };
  const [c0, c1, amt] = await Promise.all([
    withNet((f) => fetchMonthlyCost(config.dsPlatformToken, cur, f)),
    withNet((f) => fetchMonthlyCost(config.dsPlatformToken, prev, f)),
    withNet((f) => fetchMonthlyAmount(config.dsPlatformToken, cur, f)),
  ]);
  ds.pLastFetchAt = Date.now();
  if (c0.ok) {
    ds.costMonths = [c0.data, c1.ok ? c1.data : null].filter(Boolean);
    ds.amount = amt.ok ? amt.data : null;
    ds.pStatus = 'ok'; ds.pMsg = '';
    if (prevKind === 'expired') notify('DeepSeek 账单已恢复', '精确用量数据恢复正常刷新');
    dsPlatformExpiredNotified = false;
    return;
  }
  ds.costMonths = null; ds.amount = null;
  if (c0.kind === 'expired') {
    ds.pStatus = 'expired'; ds.pMsg = c0.msg;
    if (!dsPlatformExpiredNotified) {
      notify('DeepSeek 平台会话已过期', '精确账单已退回本地累计，重新获取 userToken 可恢复');
      dsPlatformExpiredNotified = true;
    }
    return;
  }
  ds.pStatus = c0.kind === 'ratelimit' ? 'ratelimit' : 'error';
  ds.pMsg = c0.msg;
}

async function refresh(manual = false) {
  if (fetching) return;
  const hasGlm = !!config.token;
  const hasDs = !!config.dsToken;
  // 「没凭据」要排在节流之前判断：否则刚清空凭据时，30 秒内的手动刷新会被挡掉，
  // 界面继续显示上一次成功的数据，看起来像没生效
  if (!hasGlm && !hasDs) {
    status.kind = 'empty'; status.msg = '';
    ds.status = 'empty'; ds.msg = '';
    refreshDsSummary();
    broadcast();
    return;
  }
  if (manual) {
    if (Date.now() - lastManualAt < 30 * 1000) { broadcast(); return; }
    lastManualAt = Date.now();
  }
  fetching = true;
  const prevGlmKind = status.kind;
  const prevDsKind = ds.status;
  if (hasGlm) { status.kind = 'loading'; status.msg = ''; }
  if (hasDs) { ds.status = 'loading'; ds.msg = ''; }
  broadcast();

  // 两个 provider 并行：任一失败不影响另一个的状态与展示
  await Promise.all([
    hasGlm ? refreshGlm(prevGlmKind) : Promise.resolve(),
    hasDs ? refreshDs(prevDsKind) : Promise.resolve(),
  ]);

  fetching = false;
  broadcast();
  schedule();
  applyTheme(); // 顺带每轮刷新重新采样背景明暗
  const g = config.lastData ? `5h=${config.lastData.five.percent}% 周=${config.lastData.week.percent}%` : '无数据';
  const db = ds.balance ? `${ds.balance.currency} ${ds.balance.total}` : '无数据';
  log('refresh 结果 · GLM', status.kind, status.msg || '', g, '| DS', ds.status, ds.msg || '', db, '| 账单', ds.pStatus, ds.pMsg || '');
}

/* ---------------- 托盘 ---------------- */
let trayIconCache = { url: '', tier: '' };

/** 金额带货币符号（CNY→¥、USD→$，其余原样前缀） */
function money(n, currency) {
  const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency ? currency + ' ' : '';
  return sym + fmtMoney(n);
}

function updateTray() {
  if (!tray) return;
  const lines = [];
  const d = config.lastData;
  if (status.kind === 'ok' && d) {
    const lv = d.level ? ` ${levelName(d.level)}` : '';
    lines.push(`GLM Coding${lv}`);
    lines.push(`5小时 ${d.five.percent}% · 周 ${d.week.percent}% · ${fmtResetTime(d.five.nextResetTime)} 重置`);
  } else if (status.kind === 'expired') lines.push('GLM：Token 已失效，点击更新');
  else if (status.kind === 'ratelimit') lines.push('GLM：限流退避中，稍后自动重试');
  else if (status.kind === 'empty') lines.push('GLM：未配置 Token，点击设置');
  else if (status.kind === 'error') lines.push('GLM：更新失败');

  if (ds.status === 'ok' && ds.balance) {
    let l = `DeepSeek ${money(ds.balance.total, ds.balance.currency)}`;
    if (ds.summary && ds.summary.today > 0) l += ` · 今日 ${money(ds.summary.today, ds.balance.currency)}`;
    lines.push(l);
  } else if (ds.status === 'expired') lines.push('DeepSeek：API Key 已失效，点击更新');
  else if (ds.status === 'ratelimit') lines.push('DeepSeek：限流退避中，稍后自动重试');
  else if (ds.status === 'empty') lines.push('DeepSeek：未配置，点击设置');
  else if (ds.status === 'error') lines.push('DeepSeek：更新失败');

  if (!lines.length) lines.push('用量挂件');
  tray.setToolTip(lines.slice(0, 5).join('\n')); // Windows 托盘提示有长度上限

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
  let dsTokenChanged = false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in ALL_DEFAULTS) || k === 'view' || k === 'pos' || k === 'lastData' || k === 'lastDs') continue;
    if (k === 'token' || k === 'dsToken' || k === 'dsPlatformToken') {
      const extract = k === 'token' ? extractToken : (k === 'dsToken' ? extractDsToken : extractPlatformToken);
      const t = extract(String(v));
      if (!t && String(v).trim() !== '') continue;   // 无法解析且非清空意图 → 忽略
      if (t === config[k]) continue;
      config[k] = t;
      if (k === 'token') tokenChanged = true; else dsTokenChanged = true;
      continue;
    }
    if (k === 'theme' && !['auto', 'dark', 'light'].includes(v)) continue;
    if (k === 'panelTab' && !['glm', 'ds'].includes(v)) continue;
    // 枚举类非法值一律忽略、保留原值（与 theme / panelTab 一致），不回退成默认
    if (k === 'dsRange') { if (!['1h', '24h', '7d', '30d'].includes(v)) continue; config.dsRange = v; continue; }
    if (k === 'dsPollMin') { const n = Math.round(Number(v)); config.dsPollMin = n >= 0 && n <= 60 ? n : 2; continue; }
    if (k === 'warnThreshold') { config.warnThreshold = normWarn(v); continue; }
    if (k === 'paceAlert') { config.paceAlert = !!v; continue; }
    config[k] = v;
  }
  // 凭据被清空时立刻回到空态：否则「最近一次成功的数据」会继续当作现况展示，
  // 而下面的手动刷新还可能被 30 秒节流挡掉（只有真的没凭据了才需要这样兜）
  if (tokenChanged && !config.token) {
    status.kind = 'empty'; status.msg = '';
    config.lastData = null;
  }
  if (dsTokenChanged && !config.dsToken) {
    Object.assign(ds, { status: 'empty', msg: '', balance: null, pStatus: 'empty', pMsg: '', costMonths: null, amount: null });
    config.lastDs = null;
  }
  saveConfig();

  if ('autoStart' in (patch || {}) && !IS_PORTABLE) {
    app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
  }
  if ('alwaysOnTop' in (patch || {}) && win) {
    win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  }
  if ('intervalMin' in (patch || {}) || 'warnThreshold' in (patch || {})) {
    config.lastNotifiedWindowStart = 0; // 设置变更后重置提醒去重
    config.lastNotifiedWeekStart = 0;
  }
  if ('dsRange' in (patch || {})) refreshDsSummary(); // 图表区间变了，汇总要重算
  broadcast();
  schedule();
  scheduleDs();   // 频率变了 / 凭据变了，都重排余额轮询
  if (tokenChanged || dsTokenChanged) {
    if (tokenChanged) expiredNotified = false;
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
    // 初建先粗夹进主屏工作区（ready 时 applyView 再按最近屏精夹；y 以前没夹，副屏在上/下方时启动会出屏）
    x: clampX(p.x, s.w), y: clampY(p.y, s.h),
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
  // 剪贴板三种凭据分别识别，渲染层按当前聚焦的输入框决定填哪个
  ipcMain.handle('clipboard:peek', () => {
    const txt = require('electron').clipboard.readText();
    return { glm: extractToken(txt), ds: extractDsToken(txt), platform: extractPlatformToken(txt) };
  });

  ipcMain.on('view:set', (_e, v) => {
    log('ipc view:set', v);
    setView(['capsule', 'panel', 'settings'].includes(v) ? v : 'capsule');
    setTimeout(applyTheme, 150); // 截屏采样移出展开/收起的关键路径
  });
  // 面板页签：GLM / DeepSeek 两个视图，窗口高度不同，切完要重算尺寸
  ipcMain.on('tab:set', (_e, t) => {
    const tab = t === 'ds' ? 'ds' : 'glm';
    if (config.panelTab === tab) return;
    config.panelTab = tab;
    saveConfig();
    log('ipc tab:set', tab);
    if (config.view === 'panel') applyView('panel');
    else broadcast();
  });
  ipcMain.on('zoom:set', (_e, z) => {
    const nz = Math.min(1.6, Math.max(0.8, Number(z) || 1));
    config.zoom = Math.round(nz * 20) / 20;
    saveConfig();
    log('zoom →', config.zoom);
    applyView(config.view);
    broadcast();
  });
  /* ---------- 拖拽：主进程独占光标坐标系（详见 lib/drag.js 顶部注释） ---------- */
  const DRAG_MS = 8;             // 采样节拍：约一帧一次，足够跟手又不至于刷爆 IPC/SetWindowPos
  const dragTick = () => {
    if (!dragCtx || !win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (dragCtx.pending) {                     // 越过死区才开始移动（原地按下=点击）
      if (Math.abs(p.x - dragCtx.ctx.cx) + Math.abs(p.y - dragCtx.ctx.cy) <= 3) return;
      dragCtx.pending = false;
      dragging = true;
      if (config.alwaysOnTop) {               // 拖拽期间持续置顶：SetWindowPos 会清掉 topmost 位
        try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { }
      }
    }
    const b = drag.boundsFor(dragCtx.ctx, p.x, p.y);
    if (b.x !== dragCtx.lastX || b.y !== dragCtx.lastY) {
      dragCtx.lastX = b.x; dragCtx.lastY = b.y;
      // 整块下发（尺寸钉死）：只改原点的话 frameless 窗口每次 setPosition 都会涨一圈，
      // 拖久了变成「内容不变、四周留白越来越大」。见 lib/drag.js boundsFor 注释。
      win.setBounds(b);
    }
    dragCtx.idle = 0;                          // 渲染层心跳到达，看门狗重新计时
    if (dragDiag) {                            // 一次性诊断：坐标系是否一致 + 窗口有没有被撑大
      if (!dragCtx.diag) {
        dragCtx.diag = { p, b, t: Date.now() };
      } else if (Date.now() - dragCtx.diag.t > 700) {
        const dxw = b.x - dragCtx.diag.b.x, dxc = p.x - dragCtx.diag.p.x;
        const now = win.getBounds();
        dragDiag = false;
        const d = screen.getDisplayNearestPoint(p);
        // 位移比≈1 = 光标与窗口几何同空间（正常）；≈缩放系数 = 有一侧是物理像素，需换算
        log('drag diag · cursor→win 位移比', (dxc ? dxw / dxc : 1).toFixed(3),
          '· scale', d.scaleFactor, '· win', b,
          '· 尺寸漂移', `${now.width - dragCtx.ctx.size.w}x${now.height - dragCtx.ctx.size.h}`, '· zoom', config.zoom);
      }
    }
  };
  const stopDrag = () => {
    if (!dragCtx) return;
    const timer = dragCtx.timer;
    const wasMoving = !dragCtx.pending && dragging;   // 点击（未越过死区）不该触发收尾动作
    dragCtx = null;
    dragging = false;
    clearInterval(timer);
    if (!wasMoving || !win || win.isDestroyed()) return;   // 点击：位置没变，不必写盘
    config.pos = { x: win.getPosition()[0], y: win.getPosition()[1] };
    saveConfig();
    assertTopmost();
    // 落定后再采样背景，避免拖拽尾顿（desktopCapturer 截屏有开销）
    clearTimeout(themeDebounce);
    themeDebounce = setTimeout(applyTheme, 350);
  };
  ipcMain.on('win:drag-start', (_e, { gx, gy }) => {
    if (!win || win.isDestroyed()) return;
    if (dragCtx) stopDrag();
    const [wx, wy] = win.getPosition();
    const [bw, bh] = win.getSize();
    dragCtx = {
      ctx: drag.begin({
        cx: gx, cy: gy, wx, wy,
        wa: waUnion(),                       // 并集：允许拖到任意显示器
        size: { w: bw, h: bh },
      }),
      pending: true, idle: 0, lastX: wx, lastY: wy, diag: null,
      timer: setInterval(dragTick, DRAG_MS),
    };
    dragDiag = true;
    dragTick();
  });
  ipcMain.on('win:drag-move', () => { if (dragCtx) dragCtx.idle = 0; });
  // 看门狗：渲染层崩了/事件断流也不会把窗口卡在拖拽态（idle 以节拍计数 → 600ms）
  ipcMain.on('win:drag-end', stopDrag);
  setInterval(() => {
    if (dragCtx && ++dragCtx.idle > 45) { log('拖拽心跳超时，强制结束'); stopDrag(); }
  }, 120);
  ipcMain.on('ctx:menu', popupWindowMenu);
  ipcMain.on('tray:icon', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('data:image/')) {
      trayIconCache.url = url;
      try { tray && tray.setImage(nativeImage.createFromDataURL(url)); } catch { }
    }
  });
  // 只放行两家官方域名（含任意子域）：bigmodel.cn 与 deepseek.com
  const OPEN_OK = /^https:\/\/([a-z0-9-]+\.)*(bigmodel\.cn|deepseek\.com)(\/|$)/i;
  ipcMain.on('open:external', (_e, u) => {
    if (typeof u === 'string' && OPEN_OK.test(u)) shell.openExternal(u);
    else log('open:external 拒绝非官方域名:', u);
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
    loadDsHistory();
    // 重启秒显：先用上次的快照与本地历史铺上，再去拉新数据
    if (config.lastDs) { ds.balance = config.lastDs; ds.status = 'ok'; }
    else if (config.dsToken) ds.status = 'loading';
    refreshDsSummary();
    log('boot ·', JSON.stringify({
      electron: process.versions.electron, node: process.versions.node,
      platform: process.platform, portable: IS_PORTABLE, dev: IS_DEV,
      hasToken: !!config.token, hasDs: !!config.dsToken, hasDsPlatform: !!config.dsPlatformToken,
      dsSamples: dsSamples.length, savedView: config.view, pos: config.pos,
    }), '· userData =', app.getPath('userData'));
    // 立即应用自启设置（清理遗留或首启）；便携版不支持
    if (!IS_PORTABLE) app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
    try { createWindow(); log('window created'); }
    catch (e) { log('FATAL createWindow:', e); }
    try { createTray(); log('tray created'); }
    catch (e) { log('FATAL createTray:', e); }
    try { bindIpc(); log('ipc bound'); } catch (e) { log('FATAL bindIpc:', e); }
    schedule();
    scheduleDs();

    powerMonitor.on('resume', () => setTimeout(() => { assertTopmost(); refresh(true); }, 5000));

    // 置顶看门狗：每 5 秒重申一次，覆盖其他置顶窗口的挤压
    setInterval(assertTopmost, 5000);
    win.on('show', assertTopmost);

    // 背景明暗巡逻：浮窗不动、底下窗口切换（深↔浅）也要跟着换肤；拖拽中不采样
    setInterval(() => { if (!dragging) applyTheme(); }, 20000);
    // 显示器热插拔/分辨率缩放变化后，把窗口收回工作区内并重采样主题。
    // 拔屏往往只对被拔的那块屏派发 display-removed（幸存屏度量没变 → metrics-changed 不来），
    // 三个事件都得挂，否则胶囊会停在已消失的屏幕上（看不见也点不着，只能重启）；连发用防抖合并
    let reflowTimer = 0;
    const reflowDisplays = () => {
      clearTimeout(reflowTimer);
      reflowTimer = setTimeout(() => { if (win) { applyView(config.view); applyTheme(); } }, 50);
    };
    screen.on('display-metrics-changed', reflowDisplays);
    screen.on('display-removed', reflowDisplays);
    screen.on('display-added', reflowDisplays);

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
