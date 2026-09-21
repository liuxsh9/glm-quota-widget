'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage,
  Notification, shell, screen, powerMonitor, desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('electron').net;
const providers = require('./lib/providers');
const dsHistoryLib = require('./lib/ds-history');
const { levelName, fmtResetTime, fmtMoney, normWarn } = require('./lib/format');
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

/* ---------------- 配置 ----------------
 * 账户是一等实体：config.accounts[] 每项 = 一家云的一个账号。
 * provider 的凭据字段由 lib/providers/meta.js 声明（glm: token；deepseek: apiKey + platformToken）。
 * 全局设置不随账户重复；提醒去重（alertState）与重启秒显快照（snapshot）都挂在账户维度。 */
const DEFAULTS = {
  accounts: [],         // [{ id, provider, name, enabled, credentials:{…}, alertState:{…} }]
  active: {},           // { [providerId]: accountId } 胶囊/面板当前展示的账户
  intervalMin: 10,      // 0 = 仅手动
  warnThreshold: 80,    // 提醒阈值（%）：同时决定变色档位与系统通知，1–99
  paceAlert: true,      // 实际用量超过预期进度时变色提醒
  notifyReset: false,   // 5h 窗口重置且此前用量高时提醒
  autoStart: true,
  alwaysOnTop: true,
  zoom: 1,             // 展开态缩放（0.8–1.6，Ctrl+滚轮），胶囊不缩放
  theme: 'auto',       // auto=跟随背景明暗 | dark | light
  view: 'capsule',      // capsule | panel | settings
  panelTab: 'glm',      // 展开面板当前 provider 页签（值 = provider id）
  capsuleLayout: 'switch', // switch=每家只显示当前账户（点账户标签切换）| all=每个账户各占一格
  pos: null,            // {x,y} 胶囊左上角
  snapshot: {},         // { [accountId]: 最近一次成功 data }（重启秒显）
  dsRange: '7d',        // DeepSeek 面板图表区间：1h | 24h | 7d | 30d
  dsPollMin: 2,         // 余额高频采样间隔（分钟，0=关闭）：实时读数的分辨率就是它
};
let config = { ...DEFAULTS };
let migrated = false;   // 本次启动做了旧配置迁移（启动后立即写回，避免半迁移状态滞留）
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

/** 旧平铺配置 → accounts[] 的确定性 id（ds 差值历史迁移要挂到同一个 id 上） */
const MIGRATE_GLM_ID = 'glm0';
const MIGRATE_DS_ID = 'ds0';

function mkAccount(provider, id, name, credentials) {
  return { id, provider, name, enabled: true, credentials, alertState: {} };
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    const wasFlat = !Array.isArray(raw.accounts);   // 平铺格式（迁移前）——置位要在迁移动手之前
    // 旧配置迁移 ①：notifyThreshold 时代 0 = 关闭通知，现在阈值只管高低
    if (raw.notifyThreshold != null && raw.warnThreshold == null) {
      const old = Number(raw.notifyThreshold);
      raw.warnThreshold = old === 0 ? 99 : old;
    }
    delete raw.notifyThreshold;
    // 旧配置迁移 ②：dsDays 时代只有 7/30 两档，换成带 1 小时 / 24 小时的四档区间
    if (raw.dsDays != null && raw.dsRange == null) raw.dsRange = Number(raw.dsDays) === 30 ? '30d' : '7d';
    delete raw.dsDays;
    // 旧配置迁移 ③：平铺单凭据 → accounts[]（老用户升级路径，必须幂等）
    if (!Array.isArray(raw.accounts)) {
      raw.accounts = [];
      if (raw.token) raw.accounts.push(mkAccount('glm', MIGRATE_GLM_ID, 'GLM', { token: raw.token }));
      if (raw.dsToken) {
        raw.accounts.push(mkAccount('deepseek', MIGRATE_DS_ID, 'DeepSeek', {
          apiKey: raw.dsToken, platformToken: raw.dsPlatformToken || '',
        }));
      }
      raw.snapshot = {};
      if (raw.lastData && raw.accounts[0]) raw.snapshot[raw.accounts[0].id] = raw.lastData;
      const dsAcc = raw.accounts.find((a) => a.provider === 'deepseek');
      if (raw.lastDs && dsAcc) raw.snapshot[dsAcc.id] = raw.lastDs;
      // 提醒去重状态迁到账户维度
      if (raw.lastNotifiedWindowStart != null) {
        const g = raw.accounts.find((a) => a.provider === 'glm');
        if (g) g.alertState = { five: raw.lastNotifiedWindowStart || 0, week: raw.lastNotifiedWeekStart || 0 };
      }
    }
    for (const k of ['token', 'dsToken', 'dsPlatformToken', 'lastData', 'lastDs', 'lastNotifiedWindowStart', 'lastNotifiedWeekStart']) delete raw[k];
    config = { ...DEFAULTS, ...raw };
    // 账户结构兜底：缺字段补齐，未知 provider 剔除（实现被裁掉的升级场景）
    config.accounts = (config.accounts || []).filter((a) => a && providers.byId(a.provider)).map((a) => ({
      id: String(a.id || ''), provider: a.provider, name: String(a.name || ''), enabled: a.enabled !== false,
      credentials: a.credentials || {}, alertState: a.alertState || {},
    }));
    // active 指向失效/缺失时回填第一个启用的账户（迁移后必为空 → 这里一次性补齐）
    for (const p of providers.list) {
      const list = config.accounts.filter((a) => a.provider === p.id && a.enabled !== false);
      if (!list.length) continue;
      if (!list.some((a) => a.id === config.active[p.id])) config.active[p.id] = list[0].id;
    }
    if (wasFlat) migrated = true;   // 迁移结果尽快写回磁盘
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
let lastManualAt = 0;
let menuOpen = false;
let rendererReady = false;
let hasAcrylic = false;
let resolvedTheme = 'dark';   // 实际生效主题（auto 时由截屏采样决定）
let dragCtx = null;           // 拖拽上下文：{ ctx, pending, timer, idle, lastX, lastY } —— 见 bindIpc
let dragDiag = false;         // 下次采样时打一条坐标系诊断日志（排障用，一次即止）
let dragging = false;         // 拖拽进行中：看门狗静默、主题巡逻暂停
let themeDebounce = 0;
let dsTimer = null;           // 余额类高频轮询的定时器
let dsPolling = false;        // 轮询进行中（避免与主周期叠加）

/** 按账户的运行态：状态机、最近数据、provider 草稿（mem）、解析重试节流 */
const rt = new Map();
function rtOf(acc) {
  if (!rt.has(acc.id)) rt.set(acc.id, { status: 'boot', msg: '', lastFetchAt: 0, data: null, mem: { notified: {} }, backoffUntil: 0, parseRetryAt: 0 });
  return rt.get(acc.id);
}
const getAcc = (id) => config.accounts.find((a) => a.id === id) || null;
const enabledOf = (pid) => config.accounts.filter((a) => a.provider === pid && a.enabled !== false);

/** DeepSeek 差值历史（按账户分桶）：Map<accountId, samples[]>，落盘为 {[id]: […]} */
const dsSamples = new Map();
const DS_HISTORY_PATH = () => path.join(app.getPath('userData'), 'ds-history.json');

function sanitizeSamples(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([t, b]) => [Number(t), Number(b)])
    .filter(([t, b]) => Number.isFinite(t) && Number.isFinite(b));
}

function loadDsHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(DS_HISTORY_PATH(), 'utf8'));
    if (Array.isArray(raw)) {
      // 旧版平铺数组 → 挂到迁移出来的那个 DeepSeek 账户上
      const acc = config.accounts.find((a) => a.provider === 'deepseek');
      if (acc) dsSamples.set(acc.id, sanitizeSamples(raw));
      return;
    }
    if (raw && typeof raw === 'object') {
      for (const [id, arr] of Object.entries(raw)) {
        if (getAcc(id)) dsSamples.set(id, sanitizeSamples(arr));
      }
    }
  } catch { /* 首次运行 / 文件损坏：从空历史开始 */ }
}

function saveDsHistory() {
  try {
    const out = {};
    for (const [id, arr] of dsSamples) if (arr.length) out[id] = arr;
    fs.writeFileSync(DS_HISTORY_PATH(), JSON.stringify(out));
  } catch (e) { log('保存 DS 差值历史失败:', e); }
}

// 视觉卡片尺寸；窗口 = 卡片 + 2*PAD（阴影在窗口内衰减完，避免圆角外被切出直角残影）
const PAD = 12;
// 胶囊：列宽来自 provider meta（capsuleW），多列之间竖发丝线；没配任何账户时兜底放提示文案
const CAP_SEP = 10;
const CAP_MIN = 150;
const CAPSULE_H = 40;
// 胶囊真实尺寸由渲染层实测上报（见 capsule:size）：meta 里的 capsuleW / CAPSULE_H 只用于
// 「首帧还没测出来」的兜底。写死的宽度会被内容撑破（多账户、余额位数变化、账户名长短），
// 所以窗口尺寸一律以实测为准 —— 渲染层画多大，窗口就多大。
let capsuleBox = null;        // { w, h } 内容盒尺寸（CSS px，不含 PAD）
let panelBoxH = 0;            // 面板实测内容高度（CSS px）：两页签取高者，切页签不跳
let boxDirty = false;         // 拖拽期间收到的尺寸变化：松手后再补一次重排
// 面板：账户 chips 行只有在「某家配了多个账户」时才出现（行高恒定，切页签窗口零位移）
const ACC_ROW_H = 26;
const SIZES = {
  // 两个页签**同高**：切页签时窗口尺寸一个像素都不动，视觉上完全不跳
  panel: { w: 326, h: 270 },
  settings: { w: 392, h: 712 },  // 内容本身可滚动，窗口高度不再随内容增长
};

/** 当前有启用账户的 provider（按注册表顺序），胶囊列与此同序 */
function activeProviders() {
  return providers.list.filter((p) => enabledOf(p.id).length > 0);
}

function winSize(view) {
  if (view === 'capsule') {
    // 实测优先；未测过（首帧 / 渲染层崩溃）才按 meta 估算
    if (capsuleBox && capsuleBox.w > 0) {
      return { w: capsuleBox.w + PAD * 2, h: capsuleBox.h + PAD * 2 };
    }
    const cols = activeProviders();
    const w = cols.length
      ? cols.reduce((s, p) => s + p.capsuleW, 0) + CAP_SEP * (cols.length - 1)
      : CAP_MIN;
    return { w: w + PAD * 2, h: CAPSULE_H + PAD * 2 };
  }
  if (view === 'panel') {
    const s = SIZES.panel;
    // 实测优先（渲染层按两个页签里高的那个报）：换字体/换系统时行高会差几像素，
    // 写死的高度不是把 chips 行裁掉、就是在底部多出一截空白。兜底才用 meta 估。
    if (panelBoxH > 0) return { w: s.w + PAD * 2, h: panelBoxH + PAD * 2 };
    const multi = providers.list.some((p) => config.accounts.filter((a) => a.provider === p.id).length > 1);
    return { w: s.w + PAD * 2, h: s.h + PAD * 2 + (multi ? ACC_ROW_H : 0) };
  }
  const s = SIZES[view] || SIZES.panel;
  return { w: s.w + PAD * 2, h: s.h + PAD * 2 };
}

/** 渲染层实测的胶囊内容尺寸（CSS px）：只在真的变了才重排窗口，避免每秒空转 */
function setCapsuleBox(sz) {
  const w = Math.round(Number(sz && sz.w) || 0);
  const h = Math.round(Number(sz && sz.h) || 0);
  if (!(w > 0) || !(h > 0) || w > 4000 || h > 400) return;   // 明显不合理的值直接丢（渲染层没布局完）
  if (capsuleBox && capsuleBox.w === w && capsuleBox.h === h) return;
  capsuleBox = { w, h };
  // 不在胶囊视图时不重排（面板/设置的尺寸与它无关）；首帧重排无妨 —— 此时窗口还没出场
  if (config.view !== 'capsule') return;
  // 拖拽中不动尺寸：此时改窗口会和拖拽那套「尺寸钉死」的定位打架，松手后再对齐
  if (dragging) { boxDirty = true; return; }
  applyView('capsule');
}

/** 渲染层实测的面板内容高度（两页签取高者）：同上，只在真的变了才重排 */
function setPanelBoxH(h) {
  const n = Math.round(Number(h) || 0);
  if (!(n > 0) || n > 4000) return;
  if (panelBoxH === n) return;
  panelBoxH = n;
  if (config.view !== 'panel') return;
  if (dragging) { boxDirty = true; return; }
  applyView('panel');
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

/** 当前显示器拓扑：排查「胶囊停在已消失的屏幕上」时一眼看清布局 */
function dumpDisplays() {
  return screen.getAllDisplays().map((d) => {
    const b = d.bounds, w = d.workArea;
    return `#${d.id} ${b.x},${b.y} ${b.width}x${b.height} wa ${w.x},${w.y} ${w.width}x${w.height} @${d.scaleFactor}x`;
  }).join(' · ');
}

/** 窗口真实几何 + 可见性：与 applyView 请求的 bounds 可能不一致（透明窗口移动/改尺寸会静默失效） */
function winState() {
  if (!win || win.isDestroyed()) return '窗口已销毁';
  const b = win.getBounds();
  return `${b.x},${b.y} ${b.width}x${b.height}${win.isVisible() ? '' : ' · 不可见'}`;
}

/** 强制整窗重绘：透明窗口在显示器变化/睡眠唤醒后偶发整窗空白（全透明 = 看不见） */
function repaint() {
  try { win.webContents.invalidate(); } catch { /* 窗口销毁竞态，忽略 */ }
}

function applyView(view, forceDefaultPos) {
  const prevView = config.view;   // 必须在赋值前抓：判断这次是「换视图」还是「胶囊自身长胖了」
  config.view = view;
  // 展开态按 zoom 等比缩放（内容 setZoomFactor + 窗口尺寸同步乘 zoom）；胶囊保持原始大小
  const factor = view === 'capsule' ? 1 : (config.zoom || 1);
  try { win.webContents.setZoomFactor(factor); } catch { }
  const base = winSize(view);
  const s = { w: Math.round(base.w * factor), h: Math.round(base.h * factor) };
  const cp = capsulePos();
  let b;
  if (view === 'capsule') {
    // 胶囊自身尺寸变了（账户增减 / 数字位数变化 / 换布局）：锚住「就近的一边」长出去。
    // 贴在屏幕右侧的挂件变宽时若固定左上角，会向右溢出再被夹回来 —— 视觉上跳一下。
    const cur = (!forceDefaultPos && prevView === 'capsule' && win && !win.isDestroyed()) ? win.getBounds() : null;
    let x = cp.x, y = cp.y;
    if (cur && (cur.width !== s.w || cur.height !== s.h)) {
      const cwa = waFor(cur);
      const dockRight = cur.x + cur.width / 2 > cwa.x + cwa.width / 2;
      x = dockRight ? cur.x + cur.width - s.w : cur.x;
      y = cur.y;
    }
    const wa = waFor({ x, y, width: s.w, height: s.h });
    b = {
      x: Math.min(Math.max(x, wa.x), wa.x + wa.width - s.w),
      y: Math.min(Math.max(y, wa.y), wa.y + wa.height - s.h),
      width: s.w, height: s.h,
    };
    // 用户拖过的位置要跟着尺寸走，否则下次「面板 → 胶囊」会跳回旧锚点；
    // 没拖过（pos=null）就保持 defaultPos 的「自动贴右边」行为，不落盘
    if (config.pos && (config.pos.x !== b.x || config.pos.y !== b.y)) {
      config.pos = { x: b.x, y: b.y };
      saveConfig();
    }
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
    // 改尺寸后安排一次整窗重绘：透明窗口在 Windows 上偶发「长出来的那块没重绘」（看着像下方空白）
    repaint();
    assertTopmost(); // 样式操作可能扰动 z 序，随手自愈
    // 请求的 bounds 和「实际」都打：两者不一致就说明这次移动/改尺寸没生效（静默失效），
    // 也是唯一能把「窗口不在它以为的地方」和「窗口在那儿但没重绘」分开的证据
    log('view →', view, JSON.stringify(b), '· 实际', winState());
    broadcast();
  });
}

function setView(view) {
  if (!win) return;
  applyView(view);
}

/** 自检：把窗口收回工作区、重采样主题，并把真实几何与显示器布局落进日志 */
function revalidateWindow() {
  if (!win || win.isDestroyed()) return;
  applyView(config.view);
  applyTheme();
  log('自检 →', winState(), '· 显示器:', dumpDisplays());
}

/** 找回窗口：位置模型和现实分叉时（拔插屏、唤醒后失踪）一键拉回主屏默认位置 */
function recallWindow() {
  if (!win) return;
  config.pos = null;              // 丢掉可能已经失效的位置记忆 → 回到 defaultPos（主屏右上角）
  saveConfig();
  win.showInactive();             // 顺带从最小化/隐藏里恢复（不抢焦点）
  applyView(config.view, true);   // 强制按默认位置重排，不锚定可能已经跑偏的窗口
  log('找回窗口 →', winState(), '· 显示器:', dumpDisplays());
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

/** 某家 provider 当前应展示的账户（胶囊/面板）；指向失效时顺到第一个启用的 */
function activeOf(pid) {
  const list = enabledOf(pid);
  if (!list.length) return null;
  const cur = config.active[pid];
  return list.find((a) => a.id === cur) ? cur : list[0].id;
}

const TIER_RANK = { low: 0, mid: 1, high: 2 };
const worseOf = (a, b) => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

/** 单个账户的档位：过期算 high；还没数据返回 null（渲染层沿用全局档位色）。
 *  胶囊平铺时每个账户各按自己的水位变色，所以档位要下到账户粒度而不是只给全局。 */
function tierOfAccount(p, r) {
  if (typeof p.tier !== 'function') return null;
  if (r.status === 'expired') return 'high';
  if (r.status !== 'ok' || !r.data) return null;
  return p.tier(r.data, config.warnThreshold);
}

/** 档位型 provider 的最差账户档位（无档位实现的返回 null） */
function worstTierProvider(p) {
  if (typeof p.tier !== 'function') return null;
  let tier = 'low';
  for (const a of enabledOf(p.id)) {
    const t = tierOfAccount(p, rtOf(a));
    if (t) tier = worseOf(tier, t);
  }
  return tier;
}

/** 全局最差档位：任一账户过期 → high；否则取档位型 provider 各账户的最差档 */
function worstTier() {
  let tier = 'low';
  for (const p of providers.list) {
    const t = worstTierProvider(p);
    if (t) tier = worseOf(tier, t);
  }
  return tier;
}

/** 账户的凭据回显（{credKey: {set, tail}}），明文不出主进程 */
function credsView(a) {
  const p = providers.byId(a.provider);
  const out = {};
  for (const c of (p ? p.credentials : [])) {
    const v = a.credentials[c.key] || '';
    // 枚举类字段（如「套餐」）不是秘密，得把原值带出去——设置页要据它把下拉选中当前项，
    // 光有尾号没法回显。秘密字段仍然只给「是否已配 + 尾号」。
    out[c.key] = c.kind === 'select' ? { set: !!v, tail: tail(v), value: v } : { set: !!v, tail: tail(v) };
  }
  return out;
}

function panelTabResolved() {
  if (providers.byId(config.panelTab) && config.accounts.some((a) => a.provider === config.panelTab)) {
    return config.panelTab;
  }
  const first = providers.list.find((p) => config.accounts.some((a) => a.provider === p.id));
  return first ? first.id : 'glm';
}

function buildState() {
  const provState = {};
  for (const p of providers.list) {
    const accs = config.accounts.filter((a) => a.provider === p.id);
    if (!accs.length) continue;   // 只下发配了账户的 provider（渲染层据此出页签/胶囊列）
    provState[p.id] = {
      name: p.name,
      tab: p.tab,
      tier: worstTierProvider(p),
      accounts: accs.map((a) => {
        const r = rtOf(a);
        return {
          id: a.id, name: a.name, enabled: a.enabled !== false,
          status: r.status, msg: r.msg, lastFetchAt: r.lastFetchAt, data: r.data,
          tier: tierOfAccount(p, r),   // 账户自己的水位（胶囊平铺时各格独立变色）
        };
      }),
      activeId: activeOf(p.id),
    };
  }
  return {
    view: config.view,
    hasAcrylic,
    theme: resolvedTheme,
    platform: process.platform,
    worstTier: worstTier(),
    providers: provState,
    config: {
      intervalMin: config.intervalMin,
      warnThreshold: normWarn(config.warnThreshold),
      paceAlert: !!config.paceAlert,
      notifyReset: config.notifyReset,
      autoStart: config.autoStart,
      alwaysOnTop: config.alwaysOnTop,
      zoom: config.zoom || 1,
      theme: config.theme,
      panelTab: panelTabResolved(),
      capsuleLayout: config.capsuleLayout === 'all' ? 'all' : 'switch',
      dsRange: ['1h', '24h', '7d', '30d'].includes(config.dsRange) ? config.dsRange : '7d',
      dsPollMin: Number(config.dsPollMin) || 0,
      isPortable: IS_PORTABLE,
      active: { ...config.active },
      // 账户清单（凭据只给「是否已配 + 尾号」）
      accounts: config.accounts.map((a) => ({
        id: a.id, provider: a.provider, name: a.name, enabled: a.enabled !== false,
        creds: credsView(a),
      })),
    },
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', buildState());
  updateTray();
}

/* ---------------- 刷新 ---------------- */
/** Electron net 走系统代理与 Chromium 网络栈；单次失败退回 Node fetch（尊重 NODE_USE_ENV_PROXY） */
async function netFetch(u, o) {
  try { return await net.fetch(u, o); } catch { return fetch(u, o); }
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

/** provider 拉取上下文：把「这一个是哪个账户、上一次什么状态、历史存哪」一次说清 */
function makeCtx(acc, prevKind) {
  const r = rtOf(acc);
  const sibs = enabledOf(acc.provider);
  return {
    fetchImpl: netFetch,
    accountName: sibs.length > 1 ? `「${acc.name}」` : '',   // 单账户保持与旧版相同的文案
    config: { warnThreshold: config.warnThreshold, notifyReset: config.notifyReset, dsRange: config.dsRange },
    prev: r.data,
    prevKind: prevKind || r.status,
    prevPlatform: (r.data && r.data.platform && r.data.platform.status) || 'empty',
    alertState: acc.alertState || (acc.alertState = {}),
    mem: r.mem,
    store: {
      get samples() { return dsSamples.get(acc.id) || []; },
      setSamples(next) { dsSamples.set(acc.id, next || []); },
      save: saveDsHistory,
    },
    now: Date.now(),
  };
}

/** 主周期：遍历所有启用账户并行拉取；任一账户失败不影响别人 */
async function refresh(manual = false) {
  if (fetching) return;
  const list = config.accounts.filter((a) => a.enabled !== false);
  // 「没账户」要排在节流之前判断：否则刚删光账户时，30 秒内的手动刷新会被挡掉
  if (!list.length) {
    for (const a of config.accounts) { const r = rtOf(a); r.status = 'empty'; r.msg = ''; }
    broadcast();
    return;
  }
  if (manual) {
    if (Date.now() - lastManualAt < 30 * 1000) { broadcast(); return; }
    lastManualAt = Date.now();
  }
  fetching = true;
  for (const a of list) { const r = rtOf(a); r.status = 'loading'; r.msg = ''; }
  broadcast();

  await Promise.all(list.map((a) => refreshAccount(a)));

  fetching = false;
  broadcast();
  schedule();
  applyTheme(); // 顺带每轮刷新重新采样背景明暗
  log('refresh 结果 ·', list.map((a) => {
    const r = rtOf(a);
    return `${a.name}(${a.provider})=${r.status}${r.msg ? ' ' + r.msg : ''}`;
  }).join(' · '));
}

async function refreshAccount(acc) {
  const prov = providers.byId(acc.provider);
  if (!prov || typeof prov.fetch !== 'function') return;
  const r = rtOf(acc);
  const ctx = makeCtx(acc, 'loading');
  let res;
  try {
    res = await prov.fetch(acc.credentials, ctx);
  } catch (e) {
    res = { ok: false, kind: 'error', msg: String((e && e.message) || e), notes: [] };
  }
  r.lastFetchAt = Date.now();
  for (const n of res.notes || []) notify(n.title, n.body);
  if (res.ok) {
    r.data = res.data;
    r.status = 'ok'; r.msg = '';
    r.backoffUntil = 0;
    config.snapshot[acc.id] = res.data;   // 重启秒显
    saveConfig();                          // 同时持久化 alertState 的去重推进
    return;
  }
  if (res.kind === 'ratelimit') {
    r.status = 'ratelimit'; r.msg = res.msg;
    const base = config.intervalMin > 0 ? config.intervalMin : 10;
    r.backoffUntil = Date.now() + base * 2 * 60000;
    return;
  }
  r.status = res.kind === 'empty' ? 'empty' : res.kind;   // expired|error|parse|empty
  r.msg = res.msg || '';
  // 解析失败多为过渡态（如 5h 窗口滚动瞬间字段不全）：15 秒后自动重试一次（5 分钟内最多一次）
  if (res.kind === 'parse' && Date.now() - r.parseRetryAt > 5 * 60 * 1000) {
    r.parseRetryAt = Date.now();
    log('解析失败，15 秒后自动重试 ·', acc.id);
    setTimeout(() => {
      const a = getAcc(acc.id);
      if (a && a.enabled !== false && !fetching) refreshAccount(a).then(broadcast);
    }, 15000);
  }
}

/**
 * 余额类高频轮询（provider 声明 pollable 才参与）。
 * 官方余额接口又便宜又是公开文档接口，没必要跟配额、平台账单挤在主周期里；
 * 差值历史的分辨率就等于这个频率——「最近 1 小时」「24 小时图」全靠它。
 */
function scheduleDs() {
  if (dsTimer) clearTimeout(dsTimer);
  const min = Number(config.dsPollMin);
  const targets = pollTargets();
  if (!(min > 0) || !targets.length) return;
  const jitter = (Math.random() * 20 - 10) * 1000; // ±10s
  dsTimer = setTimeout(async () => {
    await pollTick();
    scheduleDs();
  }, min * 60000 + jitter);
}

function pollTargets() {
  return config.accounts.filter((a) => {
    if (a.enabled === false) return false;
    const p = providers.byId(a.provider);
    return !!(p && p.pollable && a.credentials && Object.keys(p.extractors || {}).some((k) => a.credentials[k]));
  });
}

async function pollTick() {
  if (fetching || dsPolling) return;
  const targets = pollTargets();
  if (!targets.length) return;
  dsPolling = true;
  try {
    // 多账户错峰起步，避免同一瞬间齐射
    await Promise.all(targets.map((a, i) => pollAccount(a, i * 900)));
  } finally {
    dsPolling = false;
  }
}

async function pollAccount(acc, delay) {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const accNow = getAcc(acc.id);
  if (!accNow || accNow.enabled === false) return;
  const prov = providers.byId(accNow.provider);
  if (!prov || typeof prov.pollBalance !== 'function') return;
  const r = rtOf(accNow);
  const ctx = makeCtx(accNow, r.status);
  let res;
  try {
    res = await prov.pollBalance(accNow.credentials, ctx);
  } catch { return; }   // 高频轮询失败不覆盖状态：让主周期的完整刷新去报错（避免偶发网络抖动刷屏）
  r.lastFetchAt = Date.now();
  for (const n of res.notes || []) notify(n.title, n.body);
  if (res.ok) {
    r.data = res.data;
    r.status = 'ok'; r.msg = '';
    config.snapshot[accNow.id] = res.data;
    saveConfig();
    broadcast();
    return;
  }
  if (res.kind === 'expired') {
    r.status = 'expired'; r.msg = res.msg;
    broadcast();
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  const min = config.intervalMin > 0 ? config.intervalMin : 0;
  if (!config.accounts.some((a) => a.enabled !== false)) return;
  if (!min) return;
  const jitter = (Math.random() * 40 - 20) * 1000; // ±20s，避免整点齐射
  timer = setTimeout(refresh, min * 60000 + jitter);
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
  for (const p of providers.list) {
    const accs = config.accounts.filter((a) => a.provider === p.id);
    if (!accs.length) continue;
    const named = accs.length > 1;
    for (const a of accs) {
      const who = named ? `「${a.name}」` : '';
      const r = rtOf(a);
      if (r.status === 'ok' && r.data) {
        if (p.id === 'glm') {
          const lv = r.data.level ? ` ${levelName(r.data.level)}` : '';
          lines.push(`${who}GLM Coding${lv}`);
          lines.push(`5小时 ${r.data.five.percent}% · 周 ${r.data.week.percent}% · ${fmtResetTime(r.data.five.nextResetTime)} 重置`);
        } else if (p.id === 'deepseek' && r.data.balance) {
          let l = `${who}DeepSeek ${money(r.data.balance.total, r.data.balance.currency)}`;
          if (r.data.summary && r.data.summary.today > 0) l += ` · 今日 ${money(r.data.summary.today, r.data.balance.currency)}`;
          lines.push(l);
        } else if (p.id === 'volc') {
          const lv = r.data.level ? ` ${levelName(r.data.level)}` : '';
          const seg = (n, w) => (w && w.known ? `${n} ${w.percent}%` : null);
          const parts = [seg('5小时', r.data.five), seg('周', r.data.week), seg('月', r.data.month)].filter(Boolean);
          lines.push(`${who}火山方舟${lv}`);
          const rst = r.data.five && r.data.five.nextResetTime;
          if (parts.length) lines.push(parts.join(' · ') + (rst ? ` · ${fmtResetTime(rst)} 重置` : ''));
        } else {
          lines.push(`${who}${p.name}`);
        }
      } else if (r.status === 'expired') lines.push(`${who}${p.name}：凭据已失效，点击更新`);
      else if (r.status === 'ratelimit') lines.push(`${who}${p.name}：限流退避中，稍后自动重试`);
      else if (r.status === 'empty') lines.push(`${who}${p.name}：未配置，点击设置`);
      // 未开通套餐既不是「配置错」也不是「更新失败」，得单独说——否则这一行根本不出现
      else if (r.status === 'nosub') lines.push(`${who}${p.name}：未开通套餐，点击设置`);
      else if (r.status === 'error') lines.push(`${who}${p.name}：更新失败`);
    }
  }
  if (!lines.length) lines.push('用量挂件');
  tray.setToolTip(lines.slice(0, 5).join('\n')); // Windows 托盘提示有长度上限

  // 动态图标：状态未变化时不重设
  const tier = worstTier();
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
    { label: '找回窗口', click: recallWindow },   // 拔插屏/唤醒把胶囊搞丢时的自救，不必重启
    { label: '打开日志文件夹', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '打开官网', click: () => shell.openExternal(OVERVIEW_URL) },
    { label: '窗口置顶', type: 'checkbox', checked: config.alwaysOnTop,
      click: (m) => saveGlobal({ alwaysOnTop: m.checked }) },
    { label: '开机自启', type: 'checkbox', checked: config.autoStart,
      click: (m) => saveGlobal({ autoStart: m.checked }) },
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

/* ---------------- 全局设置保存（含副作用） ---------------- */
function saveGlobal(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS) || k === 'view' || k === 'pos' || k === 'snapshot' || k === 'accounts' || k === 'active') continue;
    if (k === 'theme' && !['auto', 'dark', 'light'].includes(v)) continue;
    if (k === 'panelTab') { if (providers.byId(v)) config.panelTab = v; continue; }
    // 枚举类非法值一律忽略、保留原值（与 theme / panelTab 一致），不回退成默认
    if (k === 'dsRange') { if (!['1h', '24h', '7d', '30d'].includes(v)) continue; config.dsRange = v; continue; }
    if (k === 'capsuleLayout') { if (!['switch', 'all'].includes(v)) continue; config.capsuleLayout = v; continue; }
    if (k === 'dsPollMin') { const n = Math.round(Number(v)); config.dsPollMin = n >= 0 && n <= 60 ? n : 2; continue; }
    if (k === 'warnThreshold') { config.warnThreshold = normWarn(v); continue; }
    if (k === 'paceAlert') { config.paceAlert = !!v; continue; }
    config[k] = v;
  }
  saveConfig();

  if ('autoStart' in (patch || {}) && !IS_PORTABLE) {
    app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
  }
  if ('alwaysOnTop' in (patch || {}) && win) {
    win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  }
  if ('intervalMin' in (patch || {}) || 'warnThreshold' in (patch || {})) {
    // 阈值/节奏变更后清提醒去重：新阈值要能立刻表达（下一轮成功刷新即按新阈值判）
    for (const a of config.accounts) a.alertState = {};
  }
  if ('dsRange' in (patch || {})) resummarizeDs(); // 图表区间变了，汇总要重算
  broadcast();
  schedule();
  scheduleDs();   // 频率变了，重排余额轮询
  if ('theme' in (patch || {})) applyTheme(); // 强制主题立即生效；auto 也会重新采样
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/** dsRange 变更后重算所有 DeepSeek 账户的汇总（不发请求，从已有数据反推） */
function resummarizeDs() {
  const { summarize, summarizePlatform } = dsHistoryLib;
  for (const a of config.accounts) {
    if (a.provider !== 'deepseek') continue;
    const r = rtOf(a);
    if (!r.data || !r.data.balance) continue;
    const days = config.dsRange === '30d' ? 30 : 7;
    const samples = dsSamples.get(a.id) || [];
    const bal = r.data.balance.total;
    const months = r.mem.costMonths;
    r.data = {
      ...r.data,
      summary: (months && months.length)
        ? summarizePlatform(months, Date.now(), { days, balance: bal, samples })
        : summarize(samples, Date.now(), { days, balance: bal }),
    };
  }
  broadcast();
}

/* ---------------- 账户 CRUD ---------------- */
function shortId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

/** 校验 + 提炼凭据：非法的非空输入被忽略（保留旧值），空串表示显式清除 */
function cleanCredentials(provider, input, oldCreds) {
  const p = providers.byId(provider);
  const out = { ...(oldCreds || {}) };
  if (!p) return out;
  for (const decl of p.credentials) {
    if (!(decl.key in (input || {}))) continue;
    const raw = String(input[decl.key] == null ? '' : input[decl.key]).trim();
    const ex = (p.extractors || {})[decl.key];
    const t = raw === '' ? '' : (ex ? ex(raw) : raw);
    if (!t && raw !== '') continue;   // 无法解析且非清空意图 → 忽略
    out[decl.key] = t;
  }
  return out;
}

/**
 * 「填了、但提取不出凭据」的字段（返回 label 列表）。
 * 这是最常踩的坑：粘错字段（比如把平台的 userToken 粘进 API Key）、粘了别家的 key、粘一半。
 * 必须报得具体 —— 否则表现是「提示保存成功、账户却没多」，用户只会觉得「加不上」。
 * 留空不算：清空某个字段是明确意图，交给调用方按自己的语义处理。
 */
function unparsedFields(p, input) {
  const out = [];
  for (const decl of p.credentials) {
    if (!(decl.key in (input || {}))) continue;
    const raw = String(input[decl.key] == null ? '' : input[decl.key]).trim();
    if (!raw) continue;
    const ex = (p.extractors || {})[decl.key];
    if (ex && !ex(raw)) out.push(decl.label);
  }
  return out;
}

const credErr = ({ missing, unparsed }) => (unparsed.length
  ? `识别不出「${unparsed.join('、')}」—— 粘贴的内容里没有可用的凭据，确认一下是不是粘错了字段、或没复制完整`
  : `缺少必填凭据：${missing.join('、')}`);

function accAdd({ provider, name, credentials }) {
  const p = providers.byId(provider);
  if (!p) return { err: '未知 provider' };
  const creds = cleanCredentials(provider, credentials || {}, {});
  const unparsed = unparsedFields(p, credentials);
  const missing = p.credentials.filter((c) => c.required && !creds[c.key]).map((c) => c.label);
  if (unparsed.length || missing.length) {
    const err = credErr({ missing, unparsed });
    log('账户添加被拒 ·', provider, err);
    return { err };
  }
  const acc = mkAccount(provider, shortId(),
    String(name || '').trim() || `${p.tab} ${config.accounts.filter((x) => x.provider === provider).length + 1}`,
    creds);
  config.accounts.push(acc);
  if (!config.active[provider]) config.active[provider] = acc.id;
  afterAccountsChanged();
  refreshAccount(acc).then(broadcast);   // 新账户立刻验证一次
  log('账户添加 ·', provider, acc.id, acc.name);
  return { ok: true, id: acc.id };
}

function accUpdate({ id, name, enabled, credentials }) {
  const acc = getAcc(id);
  if (!acc) return { err: '账户不存在' };
  if (typeof name === 'string' && name.trim()) acc.name = name.trim();
  if (enabled != null) acc.enabled = !!enabled;
  const before = JSON.stringify(acc.credentials);
  if (credentials) {
    const p = providers.byId(acc.provider);
    // 只拦「填了但识别不出」：留空（含清空某字段）是明确意图，照旧生效
    const unparsed = p ? unparsedFields(p, credentials) : [];
    if (unparsed.length) {
      const err = credErr({ missing: [], unparsed });
      log('账户更新被拒 ·', acc.provider, err);
      return { err };
    }
    acc.credentials = cleanCredentials(acc.provider, credentials, acc.credentials);
  }
  const credsChanged = before !== JSON.stringify(acc.credentials);
  afterAccountsChanged();
  if (credsChanged) {
    const r = rtOf(acc);
    r.status = Object.keys(acc.credentials).length ? 'loading' : 'empty';
    r.msg = '';
    refreshAccount(acc).then(broadcast);
  }
  log('账户更新 ·', acc.provider, acc.id, credsChanged ? '(凭据变更)' : '');
  return { ok: true };
}

function accRemove({ id }) {
  const acc = getAcc(id);
  if (!acc) return { err: '账户不存在' };
  config.accounts = config.accounts.filter((a) => a.id !== id);
  rt.delete(id);
  dsSamples.delete(id);
  saveDsHistory();
  delete config.snapshot[id];
  afterAccountsChanged();
  log('账户删除 ·', acc.provider, id);
  return { ok: true };
}

function accActivate({ provider, id }) {
  if (!providers.byId(provider)) return { err: '未知 provider' };
  if (!enabledOf(provider).some((a) => a.id === id)) return { err: '账户不存在或未启用' };
  config.active[provider] = id;
  saveConfig();
  broadcast();
  return { ok: true };
}

/**
 * 胶囊上的账户切换菜单。
 * 走系统原生菜单而不是自绘弹层：胶囊窗口只有 40px 高，自绘菜单要么把窗口撑大、要么被
 * 窗口矩形裁掉，而原生菜单是独立窗口，既不受限也不会贴边翻车。返回选中后的新状态。
 */
function accMenu({ provider }) {
  const p = providers.byId(provider);
  const list = p ? enabledOf(provider) : [];
  if (list.length < 2) return null;
  const cur = activeOf(provider);
  return new Promise((resolve) => {
    let picked = null;
    const template = list.map((a) => ({
      label: a.name,
      type: 'radio',
      checked: a.id === cur,
      click: () => { picked = a.id; },
    }));
    template.push({ type: 'separator' }, {
      label: `管理 ${p.tab} 账户…`,
      click: () => { picked = null; setView('settings'); },
    });
    menuOpen = true;
    Menu.buildFromTemplate(template).popup({
      window: win || undefined,
      callback: () => {
        menuOpen = false;
        if (picked) accActivate({ provider, id: picked });
        // 关闭后再回包：renderer 那边 await 到的就是切换后的状态
        setImmediate(() => resolve(buildState()));
      },
    });
  });
}

/** 账户集合变化后的共同收尾：active 兜底 + 布局/定时器重排 + 落盘 */
function afterAccountsChanged() {
  for (const p of providers.list) {
    const list = enabledOf(p.id);
    if (!list.length) {
      delete config.active[p.id];
    } else if (!list.some((a) => a.id === config.active[p.id])) {
      config.active[p.id] = list[0].id;
    }
  }
  saveConfig();
  if (win && !win.isDestroyed() && (config.view === 'capsule' || config.view === 'panel')) {
    applyView(config.view);   // 胶囊列数 / 面板 chips 行可能变了
  }
  broadcast();
  schedule();
  scheduleDs();
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const s = winSize('capsule');
  const p = capsulePos();
  win = new BrowserWindow({
    // 落盘的位置可能属于已经拔掉的屏：两个轴都夹进主屏工作区（只夹 x 的话，
    // 上一次停在扩展屏下方的 y 会让窗口开局就在屏幕外）
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
    log('ipc cfg:save', keys.join(','));
    saveGlobal(patch); return buildState();
  });
  ipcMain.handle('refresh:now', async () => { log('ipc refresh:now'); await refresh(true); return buildState(); });
  // 剪贴板按 provider 声明识别：返回 { [providerId]: { [credKey]: 提取值 } }
  ipcMain.handle('clipboard:peek', () => {
    const txt = require('electron').clipboard.readText();
    const out = {};
    for (const p of providers.list) {
      const creds = {};
      let any = false;
      for (const c of p.credentials) {
        const ex = (p.extractors || {})[c.key];
        const v = ex ? ex(txt) : '';
        creds[c.key] = v || '';
        if (v) any = true;
      }
      if (any) out[p.id] = creds;
    }
    return out;
  });

  ipcMain.on('view:set', (_e, v) => {
    log('ipc view:set', v);
    setView(['capsule', 'panel', 'settings'].includes(v) ? v : 'capsule');
    setTimeout(applyTheme, 150); // 截屏采样移出展开/收起的关键路径
  });
  // 面板 provider 页签：窗口高度可能与 chips 行有关，切完要重算尺寸
  ipcMain.on('tab:set', (_e, t) => {
    const tab = providers.byId(t) ? t : panelTabResolved();
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
  /* ---------- 账户 CRUD（返回最新广播状态；{err} 表示操作被拒绝） ---------- */
  ipcMain.handle('acc:add', (_e, payload) => { const r = accAdd(payload || {}); return r.err ? r : buildState(); });
  ipcMain.handle('acc:update', (_e, payload) => { const r = accUpdate(payload || {}); return r.err ? r : buildState(); });
  ipcMain.handle('acc:remove', (_e, payload) => { const r = accRemove(payload || {}); return r.err ? r : buildState(); });
  ipcMain.handle('acc:activate', (_e, payload) => { const r = accActivate(payload || {}); return r.err ? r : buildState(); });
  ipcMain.handle('acc:menu', (_e, payload) => accMenu(payload || {}));
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
    const timer0 = dragCtx.timer;
    const wasMoving = !dragCtx.pending && dragging;   // 点击（未越过死区）不该触发收尾动作
    const dirty = boxDirty;                           // 拖拽期间攒下的尺寸变化
    boxDirty = false;
    dragCtx = null;
    dragging = false;
    clearInterval(timer0);
    if (!wasMoving || !win || win.isDestroyed()) return;   // 点击：位置没变，不必写盘
    config.pos = { x: win.getPosition()[0], y: win.getPosition()[1] };
    saveConfig();
    if (dirty && (config.view === 'capsule' || config.view === 'panel')) applyView(config.view);   // 松手后补上尺寸对齐
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
  // 只放行已注册 provider 声明的官方域名
  const OPEN_OK = new RegExp('^https://([a-z0-9-]+\\.)*(' +
    providers.list.flatMap((p) => p.domains || []).join('|') + ')(/|$)', 'i');
  ipcMain.on('open:external', (_e, u) => {
    if (typeof u === 'string' && OPEN_OK.test(u)) shell.openExternal(u);
    else log('open:external 拒绝非官方域名:', u);
  });
  ipcMain.on('app:quit', () => app.quit());
  ipcMain.on('capsule:size', (_e, sz) => setCapsuleBox(sz));
  ipcMain.on('panel:size', (_e, sz) => setPanelBoxH(sz && sz.h));
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
    if (migrated) saveConfig();   // 平铺 → accounts 的迁移立即落盘
    // 重启秒显：先用上次的快照铺上，再去拉新数据
    for (const a of config.accounts) {
      const snap = config.snapshot[a.id];
      if (snap) { const r = rtOf(a); r.data = snap; r.status = 'ok'; }
      else if (a.enabled !== false) rtOf(a).status = 'loading';
    }
    log('boot ·', JSON.stringify({
      electron: process.versions.electron, node: process.versions.node,
      platform: process.platform, portable: IS_PORTABLE, dev: IS_DEV,
      accounts: config.accounts.map((a) => `${a.provider}:${a.id}${a.enabled === false ? '(停用)' : ''}`),
      dsSamples: [...dsSamples.entries()].map(([id, arr]) => `${id}:${arr.length}`).join(','),
      savedView: config.view, pos: config.pos,
    }), '· 显示器:', dumpDisplays(), '· userData =', app.getPath('userData'));
    // 立即应用自启设置（清理遗留或首启）；便携版不支持
    if (!IS_PORTABLE) app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
    try { createWindow(); log('window created'); }
    catch (e) { log('FATAL createWindow:', e); }
    try { createTray(); log('tray created'); }
    catch (e) { log('FATAL createTray:', e); }
    try { bindIpc(); log('ipc bound'); } catch (e) { log('FATAL bindIpc:', e); }
    schedule();
    scheduleDs();

    powerMonitor.on('resume', () => {
      setTimeout(() => { assertTopmost(); refresh(true); }, 5000);
      // 睡眠期间的插拔很可能一个事件都没收到（或收到时桌面还没稳定）：唤醒后再自检两次，
      // 跨过显示器列表稳定期。第二次比第一次晚，是因为插拔事件本身也可能是错峰到达的
      for (const delay of [1500, 6000]) setTimeout(revalidateWindow, delay);
    });
    // 锁屏期间同样会插拔（锁屏 → 拔屏 → 回家），解锁时补一次
    powerMonitor.on('unlock-screen', () => setTimeout(revalidateWindow, 1200));

    // 置顶看门狗：每 5 秒重申一次，覆盖其他置顶窗口的挤压
    setInterval(assertTopmost, 5000);
    win.on('show', assertTopmost);

    // 背景明暗巡逻：浮窗不动、底下窗口切换（深↔浅）也要跟着换肤；拖拽中不采样
    setInterval(() => { if (!dragging) applyTheme(); }, 20000);
    // 显示器热插拔/分辨率缩放变化后，把窗口收回工作区内并重采样主题。
    // 拔屏往往只对被拔的那块屏派发 display-removed（幸存屏度量没变 → metrics-changed 不来），
    // 插屏同理只派发 display-added：三个事件都得挂，否则胶囊会停在已消失的屏幕上（看不见也点不着）。
    // 而且这批事件是错峰到达的（一块屏一个、间隔可达几百毫秒），单发即算会在「列表还没稳定」时
    // 得出一个自以为合法、此后再不复核的位置 —— 所以要跨整批事件防抖
    let reflowTimer = 0;
    const reflowDisplays = () => {
      clearTimeout(reflowTimer);
      reflowTimer = setTimeout(revalidateWindow, 300);
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
