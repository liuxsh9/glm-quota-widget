'use strict';
/**
 * 主进程集成测试：桩掉 electron，真实加载 main.js，跑通 renderer:ready → refresh 全链路。
 *
 * 本文件重点覆盖「多账户架构」：
 *   - 旧平铺配置 → accounts[] 的迁移（token/dsToken/lastData/lastDs/提醒去重/差值历史）
 *   - state 形状（providers.{pid}.accounts[]、worstTier、凭据只给尾号）
 *   - 账户 CRUD IPC（添加/更新/删除/切换）与窗口尺寸联动（胶囊列宽 / 面板 chips 行）
 *   - 全局设置钳制
 *
 * 网络相关的真实联测仍靠环境变量（GLM_TOKEN / DS_API_KEY），没有则跳过——
 * 本文件的其余断言全部确定性（快照数据 + 无网络路径），不依赖外网。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { spawnSync } = require('child_process');
const dockGeo = require('../lib/dock');

const CWD = path.join(__dirname, '..');
// GLM_TEST_BOOT=<目录> 时进入「子进程模拟重启」模式：直接用那个 userData 跑一次（见 bootOnly）
const USERDATA = process.env.GLM_TEST_BOOT || fs.mkdtempSync(path.join(os.tmpdir(), 'glm-main-test-'));
const posted = [];        // 主进程推给渲染层的状态
const handlers = {};      // 注册过的 IPC
const screenHandlers = {}; // 注册过的 screen 事件
const powerHandlers = {};  // 注册过的 powerMonitor 事件（唤醒/解锁后的自检）
let winOpts = {};          // BrowserWindow 构造参数（验初建位置夹取）
let trayMenu = null;       // 最近一次托盘菜单（Tray.setContextMenu 收到的那份）
let trayTip = '';
// 主屏工作区：测试可临时改小，模拟「扩展屏被拔掉、只剩一块小屏」（拔屏瞬间的列表就是这副样子）
let primaryWA = { x: 0, y: 0, width: 1920, height: 1040 };
// 附加屏（并排 / 拔掉都靠它增删）：主进程三个显示器入口读的是同一份列表
let extraDisplays = [];
let cursor = { x: 0, y: 0 };   // getCursorScreenPoint：拖拽用例自己摆
const disp = () => ({
  id: 1, scaleFactor: 1,
  bounds: { x: primaryWA.x, y: primaryWA.y, width: primaryWA.width, height: primaryWA.height + 40 },
  workArea: primaryWA,
});
const displaysNow = () => [disp(), ...extraDisplays];
/** 造一块附加屏（与主屏同一坐标系）；省略 wa 时工作区 = bounds */
const mkDisplay = (id, x, y, w, h, wa) =>
  ({ id, scaleFactor: 1, bounds: { x, y, width: w, height: h }, workArea: wa || { x, y, width: w, height: h } });
let windowBounds = { x: 100, y: 100, width: 212, height: 64 };
let lastMenu = null;              // 最近一次 buildFromTemplate 的菜单模板
let lastMenuClose = () => { };    // 关闭最近一次 popup（触发它的 callback）

let pass = 0, fails = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fails++; console.log('  ✗', name, extra === undefined ? '' : `  [${extra}]`); process.exitCode = 1; }
}

/* ---------------- electron 桩 ---------------- */
const noop = () => { };

const mkWindow = () => ({
  webContents: { on: noop, send: (_c, s) => posted.push(s), setZoomFactor: noop, toggleDevTools: noop },
  on: noop, loadFile: noop, setAlwaysOnTop: noop, moveTop: noop, show: noop, showInactive: noop,
  setResizable: noop, isDestroyed: () => false, isVisible: () => true,
  setBounds: (b) => { windowBounds = Object.assign({}, windowBounds, b); },
  getBounds: () => windowBounds,
  getPosition: () => [windowBounds.x, windowBounds.y],
  getSize: () => [windowBounds.width, windowBounds.height],
});

const electronStub = {
  app: {
    isPackaged: false,
    getPath: () => USERDATA,
    whenReady: () => Promise.resolve(),
    on: noop,
    requestSingleInstanceLock: () => true,
    setLoginItemSettings: noop,
    quit: noop,
  },
  // 真窗口是认构造参数里的 x/y/width/height 的：桩也得认，否则「预置越界 pos」的用例里
  // 窗口会停在桩的初始坐标上，后面锚左边/锚右边的判断全跟着错
  BrowserWindow: function (o) {
    Object.assign(winOpts, o);
    windowBounds = { x: o.x, y: o.y, width: o.width, height: o.height };
    return mkWindow();
  },
  Tray: function () { return { setContextMenu: (m) => { trayMenu = m; }, setToolTip: (v) => { trayTip = v; }, setImage: noop, on: noop }; },
  // 菜单：记下模板（template），popup 只登记「关闭回调」——测试自己决定何时关（真实原生菜单是异步的）
  Menu: {
    buildFromTemplate: (tpl) => ({
      template: tpl,
      popup: (o) => { lastMenu = tpl; lastMenuClose = () => { if (o && typeof o.callback === 'function') o.callback(); }; },
    }),
  },
  ipcMain: {
    on: (ch, fn) => { handlers[ch] = fn; },
    handle: (ch, fn) => { handlers[ch] = fn; },
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }), createFromDataURL: () => ({}) },
  Notification: Object.assign(function () { return { on: noop, show: noop }; }, { isSupported: () => true }),
  shell: { openPath: noop, openExternal: noop },
  screen: {
    // 三个入口读同一份列表（可增删的额外屏），getCursorScreenPoint 由 cursor 摆布
    getPrimaryDisplay: disp,
    getDisplayMatching: (b) => dockGeo.displayFor(b, displaysNow()) || disp(),
    getAllDisplays: displaysNow,
    getDisplayNearestPoint: () => ({ scaleFactor: 1 }),
    getCursorScreenPoint: () => cursor,
    on: (e, fn) => { (screenHandlers[e] = screenHandlers[e] || []).push(fn); },
  },
  powerMonitor: { on: (e, fn) => { (powerHandlers[e] = powerHandlers[e] || []).push(fn); } },
  desktopCapturer: { getSources: async () => [] },
  clipboard: { readText: () => '' },
  // 只放行两家官方域名：测试里出现别的域名说明代码写错了
  net: {
    fetch: (u, o) => (/deepseek\.com|bigmodel\.cn/.test(String(u))
      ? fetch(u, o)
      : Promise.reject(new Error('测试只允许访问官方域名，出现：' + u))),
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return 'electron-stub';
  return origResolve.call(this, req, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

// 没有真实凭据时把 fetch 桩成「秒失败」：刷新走 error 路径、测试不被 15s 超时拖住
// （子进程模拟重启一律离线：它的结论不该被环境里的真实凭据左右）
const hasRealCreds = !!(process.env.GLM_TOKEN || process.env.DS_API_KEY);
if (!hasRealCreds || process.env.GLM_TEST_BOOT) {
  global.fetch = () => Promise.reject(new Error('离线测试桩'));
}

/* ---------------- 预置配置：故意用**旧版本**格式，迁移就是被测对象 ---------------- */
// 形如 32 位.16 位的合法 GLM Key（可被提取，但连不上网 → 刷新走 error 路径）
const FAKE_GLM = 'a'.repeat(32) + '.' + 'b'.repeat(16);
const FAKE_DS = 'sk-' + '0'.repeat(31) + 'f';
const SNAP = {
  level: 'max',
  five: { percent: 41, used: 11480, total: 28000, remaining: 16520, nextResetTime: Date.now() + 3600e3, windowStart: Date.now() - 3600e3 },
  week: { percent: 23, used: 32200, total: 140000, remaining: 107800, nextResetTime: Date.now() + 86400e3, windowStart: Date.now() - 86400e3 },
  fetchedAt: Date.now() - 60e3,
};
const DS_SNAP = {
  balance: { currency: 'CNY', total: 128.66, granted: 0, toppedUp: 128.66, available: true, fetchedAt: Date.now() - 60e3 },
  summary: { source: 'local', today: 0, last7: 0, last30: 0, month: 0, avg7: 0, daysLeft: null, days: 7, series: [], hourly: [], fine: [], last5m: 0, last1h: 0 },
  tokens: null,
  platform: { status: 'empty', msg: '', lastFetchAt: 0 },
};

// 子进程模式用给定的 userData 原样启动（那份 config.json 就是被测对象），不铺这套预置
if (!process.env.GLM_TEST_BOOT) fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify({
  // 旧版平铺格式 + notifyThreshold 时代的键（迁移链路全覆盖）
  token: FAKE_GLM, dsToken: FAKE_DS, dsPlatformToken: '', intervalMin: 10,
  notifyThreshold: 75, paceAlert: true,
  // pos 故意越界（模拟胶囊留在已拔掉的扩展屏上）：初建位置与显示器事件都应把它收回工作区
  pos: { x: 4000, y: 1500 },
  lastData: SNAP, lastDs: DS_SNAP,
  lastNotifiedWindowStart: 123456, lastNotifiedWeekStart: 654321,
}, null, 2));
// 旧版平铺差值历史 → 应挂到迁移出来的 ds0 账户上
if (!process.env.GLM_TEST_BOOT) fs.writeFileSync(path.join(USERDATA, 'ds-history.json'), JSON.stringify([[Date.now() - 600e3, 130.02], [Date.now() - 300e3, 128.66]]));

require(path.join(CWD, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (ch, arg) => handlers[ch]({}, arg);
// 触发已注册的事件回调；缺了就当作没触发 —— 回归版正是「少挂了这个监听」，
// 那种情况下该由后面的断言报错，而不是让测试在 undefined[0] 上炸掉
const fire = (map, name) => { const h = (map[name] || [])[0]; if (h) h(); };
const state = () => call('state:get');

/** 等到所有账户都不在 loading（无网络时走 error，也放行） */
async function settle(timeoutMs = 30000) {
  const t0 = Date.now();
  for (; ;) {
    const s = await state();
    const busy = Object.values(s.providers).some((p) => p.accounts.some((a) => a.status === 'loading'));
    if (!busy) return s;
    if (Date.now() - t0 > timeoutMs) return s;
    await wait(250);
  }
}

/** 把窗口左上角拖到 (x, y) 再松手（真实走 drag-start / 光标移动 / drag-end），
 *  返回松手那一刻的窗口矩形（拖拽按「光标位移」算窗口位置，所以摆光标就是摆窗口）。 */
async function dragWindowTo(x, y) {
  const b = Object.assign({}, windowBounds);
  const g = { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };   // 按下时光标在窗口中心
  cursor = { x: g.x, y: g.y };
  call('win:drag-start', { gx: g.x, gy: g.y });
  await wait(20);   // 越过 3px 死区前的静止拍
  cursor = { x: g.x + (x - b.x), y: g.y + (y - b.y) };
  const t0 = Date.now();
  while ((windowBounds.x !== x || windowBounds.y !== y) && Date.now() - t0 < 800) await wait(10);
  const released = Object.assign({}, windowBounds);
  call('win:drag-end');
  await wait(40);
  return released;
}

/** 落盘的配置（重启时 loadConfig 读的就是它） */
const readCfg = () => JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8'));

/** 模拟重启：另起一个进程、拿给定的 config.json 真跑一遍 main.js，回一行 JSON。
 *  用子进程而不是在本进程里删 require 缓存 —— 旧实例的定时器 / 显示器事件会留在这份
 *  共享的桩上互相干扰，而这里要验的恰恰是「冷启动读盘」这一段。
 *  scenario 可选：在子进程里额外跑一段动作（见 bootOnly），比如「贴边时增 / 停账户」。 */
function bootWith(cfg, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-boot-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  const env = { ...process.env, GLM_TEST_BOOT: dir };
  if (scenario) env.GLM_TEST_BOOT_SCENARIO = scenario;
  else delete env.GLM_TEST_BOOT_SCENARIO;
  const r = spawnSync(process.execPath, [__filename], {
    cwd: CWD, encoding: 'utf8', env,
    timeout: 30000,   // 子进程里挂着定时器：真挂了也得让断言失败，不能把整个套件拖住
  });
  const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop();
  let out = null;
  try { out = JSON.parse(line); } catch { /* 起不来 / 崩了：把退出码和 stderr 带出去 */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  return out || { err: `exit=${r.status} ${String(r.stderr || '').slice(-300)}` };
}

/** 子进程模式：只做「启动 → renderer:ready → 报 state 与窗口矩形」，然后退出。
 *  GLM_TEST_BOOT_SCENARIO=dock-acc：额外在贴边状态下增一个账户、再把它停用，
 *  逐步记下窗口高度 —— 子进程里没有任何渲染层上报，高度变了就只能是主进程自己重排的。 */
async function bootOnly(dir) {
  // writeSync 而不是 console.log：stdout 是管道时 console.log 是异步的，
  // 紧跟其后的 process.exit 会把还没落地的输出截掉
  const out = (o) => fs.writeSync(1, JSON.stringify(o) + '\n');
  try {
    await wait(300);                 // 等 whenReady 那一串把窗口 / IPC 都建好
    await call('renderer:ready');
    await wait(300);
    let accSteps = null;
    if (process.env.GLM_TEST_BOOT_SCENARIO === 'dock-acc') {
      accSteps = { h0: windowBounds.height };
      const acc = await call('acc:add', { provider: 'glm', name: '二号', credentials: { token: FAKE_GLM } });
      await wait(80);
      accSteps.h1 = windowBounds.height;
      const list = ((acc.providers || {}).glm || { accounts: [] }).accounts;
      await call('acc:update', { id: (list[list.length - 1] || {}).id, enabled: false });
      await wait(80);
      accSteps.h2 = windowBounds.height;
      accSteps.err = acc.err || null;
    }
    const s = await call('state:get');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    out({
      view: s.view,
      dockSide: s.config.dockSide,
      accounts: s.config.accounts.map((a) => ({ id: a.id, dock: a.dock })),
      diskView: cfg.view, diskDock: cfg.dock,
      bounds: { x: windowBounds.x, y: windowBounds.y, width: windowBounds.width, height: windowBounds.height },
      accSteps,
    });
    process.exit(0);                 // 主进程里挂着定时器，不显式退出这个进程不会自己结束
  } catch (e) {
    out({ err: String((e && e.stack) || e) });   // 起不来也要给一行可读的结果，别让父进程等超时
    process.exit(1);
  }
}

(async () => {
  if (process.env.GLM_TEST_BOOT) return bootOnly(process.env.GLM_TEST_BOOT);
  console.log('主进程集成测试  (userData=' + USERDATA + ')');
  console.log('\nIPC 与冷启动:');
  await wait(200);
  t('renderer:ready / state:get / cfg:save / tab:set / view:set / refresh:now / clipboard:peek / acc:* 均已注册',
    ['renderer:ready', 'state:get', 'cfg:save', 'tab:set', 'view:set', 'refresh:now', 'clipboard:peek',
      'acc:add', 'acc:update', 'acc:remove', 'acc:activate'].every((k) => typeof handlers[k] === 'function'));

  t('初建窗口位置已夹进主屏工作区（含 y：模拟胶囊留在已拔掉的扩展屏上）',
    winOpts.x >= 0 && winOpts.x + winOpts.width <= 1920 && winOpts.y >= 0 && winOpts.y + winOpts.height <= 1040,
    JSON.stringify(winOpts));

  await call('renderer:ready');
  const st = await settle();

  console.log('\n旧配置迁移 → accounts[]:');
  t('两家 provider 都出现（平铺 token/dsToken 各迁出一个账户）',
    !!(st.providers.glm && st.providers.deepseek), JSON.stringify(Object.keys(st.providers)));
  t('GLM 账户 1 个、DS 账户 1 个',
    st.providers.glm.accounts.length === 1 && st.providers.deepseek.accounts.length === 1);
  t('迁移账户的确定性 id（glm0/ds0）',
    st.providers.glm.accounts[0].id === 'glm0' && st.providers.deepseek.accounts[0].id === 'ds0');
  t('notifyThreshold:75 迁移成 warnThreshold:75', st.config.warnThreshold === 75);

  console.log('\n状态结构:');
  t('顶层有 worstTier', ['low', 'mid', 'high'].includes(st.worstTier), st.worstTier);
  t('账户视图含 id/provider/name/enabled/creds/dock', ['id', 'provider', 'name', 'enabled', 'creds', 'dock']
    .every((k) => k in st.config.accounts[0]));
  t('账户的 dock 口径已规范化（GLM 默认 5h、无预算）',
    st.config.accounts[0].dock.metric === 'five' && st.config.accounts[0].dock.budget === null,
    JSON.stringify(st.config.accounts[0].dock));
  t('凭据只下发 set + 尾号', st.config.accounts[0].creds.token.set === true
    && st.config.accounts[0].creds.token.tail === 'b'.repeat(6));
  t('全局 state 里搜不到明文凭据', !JSON.stringify(st).includes(FAKE_GLM) && !JSON.stringify(st).includes(FAKE_DS));
  t('GLM 快照已挂到迁移账户（重启秒显）',
    st.providers.glm.accounts[0].data && st.providers.glm.accounts[0].data.five.percent === 41,
    JSON.stringify(st.providers.glm.accounts[0].data));
  t('DS 快照已挂到迁移账户',
    st.providers.deepseek.accounts[0].data && st.providers.deepseek.accounts[0].data.balance.total === 128.66);
  t('panelTab / dsRange / dsPollMin 默认值',
    st.config.panelTab === 'glm' && st.config.dsRange === '7d' && st.config.dsPollMin === 2);
  t('active 映射指向迁移账户',
    st.config.active.glm === 'glm0' && st.config.active.deepseek === 'ds0');
  t('托盘文案不为空', typeof trayTip === 'string' && trayTip.length > 0, JSON.stringify(trayTip));
  t('状态已推给渲染层', posted.length > 0);

  console.log('\n磁盘上的 config.json 已迁移:');
  const onDisk = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8'));
  t('accounts 数组已落盘（含 alertState 迁移）', Array.isArray(onDisk.accounts) && onDisk.accounts.length === 2
    && onDisk.accounts[0].alertState.five === 123456, JSON.stringify(onDisk.accounts));
  t('平铺键已删除', !('token' in onDisk) && !('dsToken' in onDisk) && !('lastData' in onDisk) && !('notifyThreshold' in onDisk));
  t('snapshot 按账户分桶', !!(onDisk.snapshot && onDisk.snapshot.glm0 && onDisk.snapshot.ds0));

  console.log('\n窗口尺寸（胶囊按 meta 列宽求和）:');
  await call('view:set', 'capsule');
  await wait(150);
  // glm(96) + sep(10) + deepseek(74) = 180，卡片外再加 2*PAD(24)
  t('双列胶囊 = 204', windowBounds.width === 204 && windowBounds.height === 40 + 24, JSON.stringify(windowBounds));
  await call('view:set', 'panel');
  await wait(150);
  t('面板 = 350×294（每家 1 个账户，无 chips 行）',
    windowBounds.width === 326 + 24 && windowBounds.height === 270 + 24, JSON.stringify(windowBounds));
  await call('tab:set', 'deepseek');
  await wait(150);
  t('切页签窗口零位移', (await state()).config.panelTab === 'deepseek'
    && windowBounds.height === 270 + 24 && windowBounds.width === 326 + 24, JSON.stringify(windowBounds));

  console.log('\n账户 CRUD:');
  const badAdd = await call('acc:add', { provider: 'glm', credentials: { token: '这不是一个 key' } });
  t('缺少必填凭据被拒绝', !!badAdd.err, JSON.stringify(badAdd));
  const junkAdd = await call('acc:add', { provider: 'nope', credentials: {} });
  t('未知 provider 被拒绝', !!junkAdd.err);
  const add = await call('acc:add', { provider: 'glm', name: '二号', credentials: { token: 'c'.repeat(32) + '.' + 'd'.repeat(16) } });
  t('第二个 GLM 账户添加成功', !add.err && add.providers && add.providers.glm.accounts.length === 2, JSON.stringify(add.err));
  t('面板出现 chips 行（有多账户的 provider → 高度 +26）',
    windowBounds.height === 270 + 24 + 26, JSON.stringify(windowBounds));
  await call('tab:set', 'glm');
  await wait(150);
  t('chips 行存在时切页签仍零位移', windowBounds.height === 270 + 24 + 26, JSON.stringify(windowBounds));

  // DeepSeek 家的第二个账户（迁移出来的是 ds0；这条路径以前没有测试覆盖）
  const dsKey2 = 'sk-' + '1'.repeat(32);
  const dsAdd = await call('acc:add', { provider: 'deepseek', name: 'DS 二号', credentials: { apiKey: dsKey2 } });
  t('第二个 DeepSeek 账户添加成功', !dsAdd.err && dsAdd.providers.deepseek.accounts.length === 2, JSON.stringify(dsAdd.err));
  t('新 DS 账户带上了 Key（尾号回显）',
    (dsAdd.config.accounts.find((a) => a.name === 'DS 二号') || {}).creds.apiKey.tail === '1'.repeat(6));
  t('DS 家的 active 指向某个启用账户',
    !!dsAdd.providers.deepseek.activeId
    && dsAdd.providers.deepseek.accounts.some((a) => a.id === dsAdd.providers.deepseek.activeId),
    JSON.stringify(dsAdd.providers.deepseek.activeId));
  // 被拒的两种情形要分得开：「没填」 vs 「填了但识别不出」（后者最容易被当成「加不上」）
  const dsJunk = await call('acc:add', { provider: 'deepseek', name: 'DS 坏 Key', credentials: { apiKey: 'eyJhbGciOiJIUzUxMiJ9.eyJ1c2VyIn0.SIG' } });
  t('粘错字段（平台的 userToken 粘进 Key）→ 报「识别不出」', /识别不出/.test(dsJunk.err || ''), JSON.stringify(dsJunk.err));
  t('被拒时不会留下半个账户', (await state()).providers.deepseek.accounts.length === 2);
  const dsEmpty = await call('acc:add', { provider: 'deepseek', name: 'DS 空 Key', credentials: {} });
  t('没填必填凭据 → 报「缺少必填凭据」', /缺少必填凭据/.test(dsEmpty.err || ''), JSON.stringify(dsEmpty.err));
  const ds0 = (await state()).providers.deepseek.accounts.find((a) => a.name !== 'DS 二号');
  const updJunk = await call('acc:update', { id: ds0.id, credentials: { apiKey: 'garbage-not-a-key' } });
  t('编辑时粘了识别不出的内容 → 报错而不是静默忽略旧值', /识别不出/.test(updJunk.err || ''), JSON.stringify(updJunk.err));
  t('报错时旧凭据原样保留（DS 尾号还是迁移时那把）',
    (await state()).config.accounts.find((a) => a.id === ds0.id).creds.apiKey.tail === '00000f');
  await call('acc:activate', { provider: 'deepseek', id: dsAdd.providers.deepseek.accounts[1].id });
  t('切到第二个 DS 账户成功', (await state()).providers.deepseek.activeId === dsAdd.providers.deepseek.accounts[1].id);
  await call('acc:remove', { id: dsAdd.providers.deepseek.accounts[1].id });
  t('删掉第二个 DS 账户后回到单账户', (await state()).providers.deepseek.accounts.length === 1);

  const upd = await call('acc:update', { id: 'glm0', credentials: { token: '垃圾输入' } });
  t('粘了识别不出的 GLM 凭据 → 明确报错（不再静默忽略）', /识别不出/.test(upd.err || ''), JSON.stringify(upd.err));
  t('报错时旧凭据原样保留（不会被半个脏值写掉）',
    (await state()).config.accounts.find((a) => a.id === 'glm0').creds.token.tail === 'b'.repeat(6));
  const cleared = await call('acc:update', { id: 'glm0', credentials: { token: '' } });
  t('显式清空凭据生效', cleared.config.accounts.find((a) => a.id === 'glm0').creds.token.set === false);
  const tog = await call('acc:update', { id: 'glm0', enabled: false });
  t('停用账户后 active 自动顺延', tog.config.active.glm !== 'glm0'
    && tog.providers.glm.accounts.find((a) => a.id === 'glm0').enabled === false);
  const act = await call('acc:activate', { provider: 'glm', id: 'glm0' });
  t('激活停用账户被拒绝', !!act.err);
  const keptId = tog.providers.glm.accounts.find((a) => a.id !== 'glm0').id;
  const act2 = await call('acc:activate', { provider: 'glm', id: keptId });
  t('激活启用账户成功', !act2.err && act2.providers.glm.activeId === keptId);

  console.log('\n停用 = 整家不出场（胶囊列 / 面板页签 / 托盘一起收）:');
  // 火山是「单账户 provider」的代表：唯一那个账户一停用，这家整家都得从展示面上消失，
  // 只留在设置页的账户清单里（曾经是账号停用了、胶囊列和页签还杵在那儿显示旧读数）
  const volcAdd = await call('acc:add', {
    provider: 'volc', name: '火山一号',
    credentials: { accessKeyId: 'AKLTtestAccessKeyId0000000', accessKeySecret: 's'.repeat(32), plan: 'coding' },
  });
  t('火山账户添加成功', !volcAdd.err && !!volcAdd.providers.volc, JSON.stringify(volcAdd.err));
  const volcId = volcAdd.providers.volc.accounts[0].id;
  t('三家都在场时 providers 有 3 家',
    Object.keys(volcAdd.providers).length === 3, JSON.stringify(Object.keys(volcAdd.providers)));
  await call('tab:set', 'volc');
  t('切到火山页签', (await state()).config.panelTab === 'volc');

  const volcOff = await call('acc:update', { id: volcId, enabled: false });
  t('停用唯一账户后这家从 providers 里消失（胶囊列/页签一起收）',
    !volcOff.providers.volc && Object.keys(volcOff.providers).length === 2, JSON.stringify(Object.keys(volcOff.providers)));
  t('收的只是「展示」不是「配置」：账户仍在设置页的清单里',
    (volcOff.config.accounts.find((a) => a.id === volcId) || {}).enabled === false);
  t('active 映射同步清掉', !volcOff.config.active.volc);
  t('页签顺延到还在场的一家（不留一个点不开的空页签）',
    volcOff.config.panelTab !== 'volc' && !!volcOff.providers[volcOff.config.panelTab], volcOff.config.panelTab);
  t('托盘也不再有这家那一行', !/火山方舟/.test(trayTip), JSON.stringify(trayTip));

  const volcBack = await call('acc:update', { id: volcId, enabled: true });
  t('重新启用后这家回到 providers',
    !!volcBack.providers.volc && Object.keys(volcBack.providers).length === 3);
  await call('acc:remove', { id: volcId });   // 还原现场：后面的「删光账户」用例要数得准
  await call('tab:set', 'glm');

  console.log('\n剪贴板识别（按 provider 声明）:');
  electronStub.clipboard.readText = () => `Cookie: bigmodel_token_production=${FAKE_GLM}; Bearer ${FAKE_DS}`;
  const peek = await call('clipboard:peek');
  t('返回按 provider 分组的结构', typeof peek === 'object' && peek.glm && peek.deepseek, JSON.stringify(peek));
  t('glm 段提出 token / ds 段提出 apiKey', peek.glm && peek.glm.token === FAKE_GLM
    && peek.deepseek && peek.deepseek.apiKey === FAKE_DS, JSON.stringify(peek));
  t('平台令牌字段始终存在（值为空串）', !!(peek.deepseek && 'platformToken' in peek.deepseek));
  electronStub.clipboard.readText = () => '';

  console.log('\n配置写入与钳制:');
  await call('cfg:save', { warnThreshold: 999 });
  t('阈值 999 → 回退 80', (await state()).config.warnThreshold === 80);
  await call('cfg:save', { warnThreshold: 0 });
  t('阈值 0 → 回退 80（不是「关闭」）', (await state()).config.warnThreshold === 80);
  await call('cfg:save', { warnThreshold: 65 });
  t('阈值 65 → 65', (await state()).config.warnThreshold === 65);
  await call('cfg:save', { paceAlert: false });
  t('paceAlert 可关', (await state()).config.paceAlert === false);
  await call('cfg:save', { panelTab: ' 乱七八糟 ' });
  t('非法 panelTab 被忽略', (await state()).config.panelTab === 'glm');
  await call('cfg:save', { dsRange: '30d' });
  t('dsRange 30d 生效', (await state()).config.dsRange === '30d');
  await call('cfg:save', { dsRange: '乱七八糟' });
  t('非法 dsRange 被忽略', (await state()).config.dsRange === '30d');
  await call('cfg:save', { dsRange: '7d' });
  await call('cfg:save', { dsPollMin: 999 });
  t('dsPollMin 越界回退 2', (await state()).config.dsPollMin === 2);
  await call('cfg:save', { dsPollMin: 5 });
  t('dsPollMin 5 → 5', (await state()).config.dsPollMin === 5);

  console.log('\n删除账户（清到空）:');
  const glmIds = () => (state().providers.glm ? state().providers.glm.accounts.map((a) => a.id) : []);
  for (const id of glmIds()) await call('acc:remove', { id });
  await call('acc:remove', { id: 'ds0' });
  const emptied = await state();
  t('删光账户 → providers 为空', Object.keys(emptied.providers).length === 0, JSON.stringify(Object.keys(emptied.providers)));
  t('active 映射清空', Object.keys(emptied.config.active).length === 0);
  await call('view:set', 'capsule');
  await wait(150);
  t('空态胶囊用兜底宽度', windowBounds.width === 150 + 24, JSON.stringify(windowBounds));
  const emptyAdd = await call('acc:add', { provider: 'glm', name: '回填', credentials: { token: FAKE_GLM } });
  t('空态后可重新添加账户', !emptyAdd.err && emptyAdd.providers.glm.accounts.length === 1);
  await wait(150);
  t('重新添加后胶囊回到单列宽（meta 兜底值）', windowBounds.width === 96 + 24, JSON.stringify(windowBounds));

  console.log('\n胶囊尺寸：渲染层实测优先（内容撑不破窗口）:');
  await call('view:set', 'capsule');
  await wait(60);
  const before = Object.assign({}, windowBounds);
  call('capsule:size', { w: 260, h: 44 });
  await wait(60);
  t('按上报尺寸重排窗口', windowBounds.width === 260 + 24 && windowBounds.height === 44 + 24, JSON.stringify(windowBounds));
  t('贴右侧的挂件锚住右边向左长（不向右溢出）',
    windowBounds.x + windowBounds.width === before.x + before.width, JSON.stringify([before, windowBounds]));
  const afterResize = Object.assign({}, windowBounds);
  call('capsule:size', { w: 300, h: 44 });
  await wait(60);
  t('再变宽仍锚右边', windowBounds.x + windowBounds.width === before.x + before.width
    && windowBounds.width === 300 + 24, JSON.stringify(windowBounds));
  call('capsule:size', { w: 0, h: 0 });
  call('capsule:size', { w: 99999, h: 99999 });
  call('capsule:size', null);
  await wait(60);
  t('离谱尺寸被丢弃（渲染层没布局完时的 0×0 / 异常值）',
    windowBounds.width === 300 + 24, JSON.stringify([afterResize, windowBounds]));

  console.log('\n面板尺寸：渲染层实测优先（两页签取高者）:');
  await call('view:set', 'capsule');
  await wait(60);
  const capBefore = Object.assign({}, windowBounds);
  call('panel:size', { h: 300 });   // 不在面板视图时不该动窗口
  await wait(60);
  t('不在面板视图时收到面板高度不动窗口', windowBounds.height === capBefore.height, JSON.stringify(windowBounds));
  await call('view:set', 'panel');
  await wait(60);
  call('panel:size', { h: 300 });
  await wait(60);
  t('按上报高度重排窗口（宽度仍由面板定）',
    windowBounds.height === 300 + 24 && windowBounds.width === 326 + 24, JSON.stringify(windowBounds));
  call('panel:size', { h: 0 });
  call('panel:size', null);
  call('panel:size', { h: 99999 });
  await wait(60);
  t('离谱高度被丢弃（渲染层没布局完时的 0 / 异常值）', windowBounds.height === 300 + 24, JSON.stringify(windowBounds));
  await call('view:set', 'capsule');
  await wait(60);

  console.log('\n账户切换菜单（原生弹出）:');
  const beforeMenuState = await state();
  t('单账户时不弹菜单', (await call('acc:menu', { provider: 'glm' })) === null);
  const acc2Add = await call('acc:add', { provider: 'glm', name: '第二号', credentials: { token: FAKE_GLM } });
  const id2 = acc2Add.providers.glm.accounts.find((a) => a.name === '第二号').id;
  const menuP = call('acc:menu', { provider: 'glm' });       // 菜单「开着」：popup 的 callback 还没回调
  await wait(30);
  const items = lastMenu.filter((i) => i.type === 'radio');
  t('菜单列出该家所有启用账户', items.length === 2, JSON.stringify(lastMenu.map((i) => i.label || i.type)));
  t('当前账户在菜单里打勾', items.filter((i) => i.checked).length === 1
    && items.find((i) => i.checked).label === beforeMenuState.providers.glm.accounts.find((a) => a.id === beforeMenuState.providers.glm.activeId).name);
  t('菜单末尾有「管理账户…」入口', /管理/.test(String(lastMenu[lastMenu.length - 1].label)));
  items.find((i) => i.label === '第二号').click();
  lastMenuClose();
  const afterMenu = await menuP;
  t('选中即切换当前账户（菜单关闭后回包新状态）',
    afterMenu && afterMenu.providers.glm.activeId === id2, JSON.stringify(afterMenu && afterMenu.providers.glm.activeId));

  console.log('\n胶囊布局设置:');
  await call('cfg:save', { capsuleLayout: 'all' });
  t('capsuleLayout=all 生效', (await state()).config.capsuleLayout === 'all');
  await call('cfg:save', { capsuleLayout: '乱写' });
  t('非法 capsuleLayout 被忽略（保留 all）', (await state()).config.capsuleLayout === 'all');
  await call('cfg:save', { capsuleLayout: 'switch' });
  t('capsuleLayout=switch 生效', (await state()).config.capsuleLayout === 'switch');

  console.log('\n显示器热插拔（胶囊所在的扩展屏被拔掉也要能找回）:');
  t('metrics-changed / removed / added 三个事件均已监听',
    ['display-metrics-changed', 'display-removed', 'display-added']
      .every((k) => (screenHandlers[k] || []).length === 1),
    JSON.stringify(Object.keys(screenHandlers)));

  const small = { w: windowBounds.width + 40, h: windowBounds.height + 40 };  // 幸存的屏只剩这么点
  windowBounds = Object.assign({}, windowBounds, { x: 4000, y: 1500 });   // 假装胶囊停在已消失的屏幕上
  primaryWA = { x: 0, y: 0, width: small.w, height: small.h };
  fire(screenHandlers, 'display-removed');                                // 拔屏往往只派发这一发
  fire(screenHandlers, 'display-added');                                  // 同批第二发：该被防抖合并
  await wait(60);
  t('防抖窗口内不抢跑（不拿还没稳定的显示器列表算位置）',
    windowBounds.x === 4000 && windowBounds.y === 1500, JSON.stringify(windowBounds));
  await wait(400);   // 防抖 300ms + applyView 的 setImmediate
  const wb = windowBounds;
  t('display-removed → 窗口收回工作区内',
    wb.x >= 0 && wb.y >= 0 && wb.x + wb.width <= small.w && wb.y + wb.height <= small.h, JSON.stringify(wb));
  t('落点 = 保存位置夹进工作区的角落',
    wb.x === small.w - wb.width && wb.y === small.h - wb.height, JSON.stringify(wb));
  primaryWA = { x: 0, y: 0, width: 1920, height: 1040 };

  console.log('\n睡眠唤醒 / 解锁后的自检:');
  windowBounds = Object.assign({}, windowBounds, { x: 4000, y: 1500 });   // 唤醒后窗口落在屏幕外
  fire(powerHandlers, 'resume');
  await wait(1700);   // 第一拍自检排在 1500ms
  const wr = windowBounds;
  t('resume → 唤醒后自检把窗口收回工作区',
    wr.x >= 0 && wr.y >= 0 && wr.x + wr.width <= 1920 && wr.y + wr.height <= 1040, JSON.stringify(wr));

  windowBounds = Object.assign({}, windowBounds, { x: 4000, y: 1500 });
  fire(powerHandlers, 'unlock-screen');
  await wait(1400);   // 解锁自检排在 1200ms
  const wu = windowBounds;
  t('unlock-screen → 解锁后同样自检',
    wu.x >= 0 && wu.y >= 0 && wu.x + wu.width <= 1920 && wu.y + wu.height <= 1040, JSON.stringify(wu));

  console.log('\n托盘「找回窗口」:');
  const recall = (trayMenu && trayMenu.template || []).find((i) => i.label === '找回窗口');
  t('托盘菜单里有「找回窗口」', !!recall);
  windowBounds = Object.assign({}, windowBounds, { x: 4000, y: 1500 });   // 窗口已经丢在屏幕外
  if (recall) recall.click();   // 没这一项时后面的断言自己报错，别把测试炸掉
  await wait(60);
  t('找回后回到主屏默认位置（右上角，留 20px 边距）',
    windowBounds.x === 1920 - windowBounds.width - 20 && windowBounds.y === 16, JSON.stringify(windowBounds));
  t('位置记忆已清空（回到自动贴边，不再拿失效坐标当真相）',
    JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')).pos === null);

  console.log('\n贴边（dock）：松手吸附 / 展开收起 / 拔屏自检:');
  /** state 里某个账户的 dock（config 与 providers 两份视图都得有，且一致） */
  const dockOf = (s, id) => {
    const cfg = (s.config.accounts.find((x) => x.id === id) || {}).dock;
    const prov = (Object.values(s.providers).flatMap((p) => p.accounts).find((x) => x.id === id) || {}).dock;
    return { cfg, prov };
  };

  // 渲染层先报一个 dock 实测尺寸（此刻还在胶囊视图：尺寸先记下，进 dock 时才用）
  call('dock:size', { w: 60, h: 300 });
  await wait(60);
  t('不在贴边视图时收到 dock:size 不动窗口（尺寸先记下）',
    windowBounds.width !== 60 && windowBounds.height !== 300, JSON.stringify(windowBounds));

  // —— 单屏：胶囊拖到离右缘 10 DIP（≤ SNAP_PX 28）松手 → 贴右
  const capW = windowBounds.width;
  const relDock = await dragWindowTo(1920 - capW - 10, windowBounds.y);
  const stDock = await state();
  t('松手即吸附：view=dock / dockSide=right',
    stDock.view === 'dock' && stDock.config.dockSide === 'right', JSON.stringify([stDock.view, stDock.config.dockSide]));
  t('窗口右边贴住工作区右边（松手时离边还有 10 DIP，被拉正）',
    windowBounds.x + windowBounds.width === 1920 && relDock.x === 1920 - capW - 10, JSON.stringify([relDock, windowBounds]));
  t('窗口尺寸 = 上报的 dock:size（dock 不加 PAD）',
    windowBounds.width === 60 && windowBounds.height === 300, JSON.stringify(windowBounds));
  t('落盘：config.dock 记下贴边侧与校正后的 x',
    !!readCfg().dock && readCfg().dock.side === 'right' && readCfg().dock.x === 1860, JSON.stringify(readCfg().dock));

  // —— 贴边状态下展开 / 收起
  await call('view:set', 'panel');
  await wait(60);
  const stPanel = await state();
  t('贴右时展开面板：面板右边贴工作区右边（y 跟 dock 走）',
    stPanel.view === 'panel' && windowBounds.x + windowBounds.width === 1920 && windowBounds.y === 16,
    JSON.stringify(windowBounds));
  await call('view:set', 'capsule');
  await wait(60);
  const stBack = await state();
  t('收起发的虽是 capsule，贴边时按 dock 处理（回到贴边，不弹回旧位置）',
    stBack.view === 'dock' && stBack.config.dockSide === 'right'
    && windowBounds.x + windowBounds.width === 1920 && windowBounds.width === 60, JSON.stringify([stBack.view, windowBounds]));

  // —— dock 被拖离边缘 → 回胶囊，落在松手处
  const relOff = await dragWindowTo(900, 400);
  const stOff = await state();
  t('dock 拖到屏幕中间松手 → 回胶囊', stOff.view === 'capsule' && stOff.config.dockSide === null, stOff.view);
  t('松手处就是落点（窗口已经在拖到的位置）', relOff.x === 900 && relOff.y === 400
    && windowBounds.x === 900 && windowBounds.y === 400, JSON.stringify([relOff, windowBounds]));
  t('落盘：config.dock 清空、config.pos = 松手位置',
    readCfg().dock === null && readCfg().pos.x === 900 && readCfg().pos.y === 400,
    JSON.stringify([readCfg().dock, readCfg().pos]));

  // —— 双屏并排：接缝不是边缘
  extraDisplays = [mkDisplay(2, 1920, 0, 1920, 1080, { x: 1920, y: 0, width: 1920, height: 1040 })];
  const seamTarget = 1920 - windowBounds.width - 20;   // 右边缘距接缝 20 DIP：数值上 ≤ SNAP_PX，但接缝不算边缘
  const relSeam = await dragWindowTo(seamTarget, windowBounds.y);
  const stSeam = await state();
  t('两屏接缝处松手仍是胶囊（接缝被误判成边缘的话窗口会在半路被吸住）',
    stSeam.view === 'capsule' && stSeam.config.dockSide === null && relSeam.x === seamTarget,
    JSON.stringify([stSeam.view, relSeam]));
  t('接缝处不写 config.dock', readCfg().dock === null, JSON.stringify(readCfg().dock));

  // —— 拔屏：dock 贴在副屏右边，副屏消失后自己贴回主屏
  const capW2 = windowBounds.width;                       // 贴边后窗口会变窄成 dock，目标得按胶囊宽算
  const subTarget = 3840 - capW2 - 10;
  const relSub = await dragWindowTo(subTarget, windowBounds.y);
  const stSub = await state();
  t('拖到副屏最外侧右缘松手 → 贴到副屏右边（跨屏能贴）',
    stSub.view === 'dock' && stSub.config.dockSide === 'right' && windowBounds.x + windowBounds.width === 3840
    && relSub.x === subTarget, JSON.stringify([relSub, windowBounds]));
  extraDisplays = [];                       // 副屏拔了（事件是错峰到的，先来一发）
  fire(screenHandlers, 'display-removed');
  await wait(60);
  t('拔屏防抖窗口内不抢跑（还没稳定的显示器列表算不出落点）',
    windowBounds.x === 3780, JSON.stringify(windowBounds));
  await wait(400);                          // 防抖 300ms + applyView 的 setImmediate
  t('拔屏后 dock 自己贴回主屏右边、仍在工作区内（不会停在看不见的地方）',
    windowBounds.x + windowBounds.width === 1920
    && windowBounds.y >= 0 && windowBounds.y + windowBounds.height <= 1040, JSON.stringify(windowBounds));
  t('落盘同步到新位置', !!readCfg().dock && readCfg().dock.x === 1860, JSON.stringify(readCfg().dock));

  // —— 找回窗口：贴边记忆一并清掉
  const recall2 = (trayMenu && trayMenu.template || []).find((i) => i.label === '找回窗口');
  if (recall2) recall2.click();
  await wait(60);
  const stRecall = await state();
  t('「找回窗口」清空 dock、视图回胶囊',
    stRecall.view === 'capsule' && stRecall.config.dockSide === null && readCfg().dock === null, JSON.stringify(stRecall.view));
  t('找回后回到主屏默认位置（右上角，留 20px 边距）',
    windowBounds.y === 16 && windowBounds.x + windowBounds.width === 1920 - 20, JSON.stringify(windowBounds));

  // —— 取消贴边（右键菜单）：离那条边 20 DIP 的内侧、y 不变
  await dragWindowTo(1920 - windowBounds.width - 8, 300);
  t('（前置）已贴到右边', (await state()).view === 'dock');
  call('ctx:menu');
  await wait(30);
  const undockItem = (lastMenu || []).find((i) => i.label === '取消贴边');
  t('贴边时右键菜单在「设置」下面多出「取消贴边」',
    !!undockItem && lastMenu[0].label === '设置' && lastMenu[1] === undockItem,
    JSON.stringify((lastMenu || []).map((i) => i.label || i.type)));
  if (undockItem) undockItem.click();
  await wait(60);
  const stUndock = await state();
  t('取消贴边 → 胶囊落在离右边 20 DIP 处、y 不变',
    stUndock.view === 'capsule' && stUndock.config.dockSide === null
    && windowBounds.x + windowBounds.width === 1920 - 20 && windowBounds.y === 300, JSON.stringify(windowBounds));
  t('取消贴边落盘：dock 清空、pos = 胶囊位置',
    readCfg().dock === null && readCfg().pos.x === 1576 && readCfg().pos.y === 300,
    JSON.stringify([readCfg().dock, readCfg().pos]));

  console.log('\n账户的圆圈口径（acc:dock）:');
  const dsAdd2 = await call('acc:add', { provider: 'deepseek', name: '口径号', credentials: { apiKey: 'sk-' + '2'.repeat(32) } });
  t('加一个 DeepSeek 账户备用', !dsAdd2.err, JSON.stringify(dsAdd2.err));
  const dsId2 = dsAdd2.providers.deepseek.accounts.slice(-1)[0].id;
  const glmId = (await state()).config.accounts.find((a) => a.provider === 'glm' && a.enabled !== false).id;

  const rDs = await call('acc:dock', { id: dsId2, metric: 'last7', budget: '30' });
  const dDs = dockOf(rDs, dsId2);
  t('DeepSeek 存 {metric:"last7", budget:"30"} → {metric:"last7", budget:30}（字符串预算转数字）',
    JSON.stringify(dDs.cfg) === '{"metric":"last7","budget":30}', JSON.stringify(dDs));
  t('config 与 providers 两份视图口径一致', JSON.stringify(dDs.prov) === JSON.stringify(dDs.cfg));

  const rGlm = await call('acc:dock', { id: glmId, metric: 'bogus', budget: '50' });
  t('GLM 存认不出的 metric → 回默认 five；budget 对 GLM 恒为 null（口径表里没有预算这回事）',
    JSON.stringify(dockOf(rGlm, glmId).cfg) === '{"metric":"five","budget":null}', JSON.stringify(dockOf(rGlm, glmId)));

  const rBad = await call('acc:dock', { id: '不存在的账户', metric: 'five' });
  t('未知 id → {err}', !!rBad.err, JSON.stringify(rBad));

  t('口径已落盘（重启后按它画圆圈）',
    JSON.stringify((readCfg().accounts.find((a) => a.id === dsId2) || {}).dock) === '{"metric":"last7","budget":30}',
    JSON.stringify((readCfg().accounts.find((a) => a.id === dsId2) || {}).dock));

  await call('acc:update', { id: dsId2, name: '改过名的口径号' });
  const stRenamed = await state();
  t('accUpdate 改名后 dock 口径仍在（且仍是落盘的那份）',
    JSON.stringify(dockOf(stRenamed, dsId2).cfg) === '{"metric":"last7","budget":30}'
    && JSON.stringify((readCfg().accounts.find((a) => a.id === dsId2) || {}).dock) === '{"metric":"last7","budget":30}',
    JSON.stringify(dockOf(stRenamed, dsId2)));

  console.log('\n贴边时拖动面板 / 设置：松手那一拍不弹回（尺寸对齐推迟到下一次布局）:');
  await dragWindowTo(1920 - windowBounds.width - 8, 260);   // 胶囊拖到右缘 8 DIP 内 → 贴右
  t('（前置）胶囊贴到右边', (await state()).view === 'dock');
  await call('view:set', 'panel');
  await wait(80);
  t('（前置）贴右时展开面板：面板右边贴工作区右边（y 跟 dock 走）',
    windowBounds.x + windowBounds.width === 1920 && windowBounds.y === 260, JSON.stringify(windowBounds));

  // 把面板拖到屏幕中间；松手前插一次 panel:size 上报（模拟拖拽期间到达的尺寸变化 → dirty）
  const pb0 = Object.assign({}, windowBounds);
  const pc0 = { x: pb0.x + Math.round(pb0.width / 2), y: pb0.y + Math.round(pb0.height / 2) };
  cursor = { x: pc0.x, y: pc0.y };
  call('win:drag-start', { gx: pc0.x, gy: pc0.y });
  await wait(20);
  cursor = { x: pc0.x + (700 - pb0.x), y: pc0.y + (420 - pb0.y) };
  const td0 = Date.now();
  while ((windowBounds.x !== 700 || windowBounds.y !== 420) && Date.now() - td0 < 800) await wait(10);
  call('panel:size', { h: 330 });   // 拖拽中到达的尺寸上报：只记成 dirty，不打断拖动
  await wait(20);
  call('win:drag-end');
  await wait(80);
  t('贴边状态下把面板拖到屏幕中间：松手后停在拖到的位置（不被尺寸上报弹回贴边侧）',
    windowBounds.x === 700 && windowBounds.y === 420 && windowBounds.width === 350,
    JSON.stringify(windowBounds));
  t('松手处落盘 config.pos（这次拖动没被抹掉）',
    readCfg().pos.x === 700 && readCfg().pos.y === 420, JSON.stringify(readCfg().pos));

  // 下一次真正的布局对齐（切页签 → applyView('panel')）才回贴边侧：贴边锚定没被整个废掉
  await call('tab:set', 'deepseek');
  await wait(80);
  t('切页签触发重排：面板回到贴边侧（贴边锚定仍有效）',
    windowBounds.x + windowBounds.width === 1920 && windowBounds.y === 260 && windowBounds.height === 330 + 24,
    JSON.stringify(windowBounds));

  console.log('\n模拟重启（子进程重新读盘启动）:');
  const b1 = bootWith({ accounts: [], view: 'dock', dock: { side: 'right', x: 100, y: 300 } });
  t('view:"dock" + 合法 dock → 启动后仍是 dock，且贴在工作区右边',
    b1.view === 'dock' && b1.dockSide === 'right' && b1.bounds.x + b1.bounds.width === 1920, JSON.stringify(b1));
  t('无实测尺寸时按启用账户数兜底：64 × (1*62+40)，不加 PAD',
    b1.bounds.width === 64 && b1.bounds.height === 102, JSON.stringify(b1.bounds));
  t('启动时把校正过的贴边坐标写回磁盘（下次直接贴对）',
    !!b1.diskDock && b1.diskDock.x === 1856 && b1.diskDock.y === 300, JSON.stringify(b1.diskDock));

  const b2 = bootWith({ accounts: [], view: 'dock', dock: null });
  t('view:"dock" + dock:null → 启动回胶囊', b2.view === 'capsule' && b2.dockSide === null, JSON.stringify(b2));

  const b3 = bootWith({ accounts: [], view: 'dock', dock: { side: 'up', x: '100', y: 3 } });
  t('非法 dock（side 认不出 / x 不是有限数）→ 当作没贴边，不把窗口送去坏坐标',
    b3.view === 'capsule' && b3.dockSide === null, JSON.stringify(b3));

  const b4 = bootWith({
    view: 'capsule',
    accounts: [
      { id: 'g1', provider: 'glm', name: 'G', enabled: false, credentials: {}, dock: { metric: 'bogus' } },
      { id: 'd1', provider: 'deepseek', name: 'D', enabled: false, credentials: {}, dock: { metric: 'month', budget: '12.5' } },
    ],
  });
  t('启动时规范化账户的圆圈口径（认不出的回默认 / 预算转数字）',
    JSON.stringify(b4.accounts) === JSON.stringify([
      { id: 'g1', dock: { metric: 'five', budget: null } },
      { id: 'd1', dock: { metric: 'month', budget: 12.5 } },
    ]), JSON.stringify(b4.accounts));

  // 贴边时增 / 停账户：兜底高度（n*62+40）得由主进程自己跟着重排。
  // 子进程里没有任何渲染层上报 —— 高度变了就只能是主进程自愈的（这正是修复前缺的那条路径）。
  const b5 = bootWith({
    view: 'dock', dock: { side: 'right', x: 100, y: 300 },
    accounts: [{ id: 'g1', provider: 'glm', name: 'G', enabled: true, credentials: { token: FAKE_GLM }, dock: { metric: 'five' } }],
  }, 'dock-acc');
  t('贴边时增 / 停账户 → 窗口按新的兜底高度立即重排（不依赖渲染层上报）',
    b5.accSteps && !b5.accSteps.err
    && b5.accSteps.h0 === 1 * 62 + 40 && b5.accSteps.h1 === 2 * 62 + 40 && b5.accSteps.h2 === 1 * 62 + 40,
    JSON.stringify(b5.accSteps || b5));

  // 凭据只落在本机 userData，测试结束顺手删掉
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : '（临时 userData 已清理）'}`);
  process.exit(fails ? 1 : 0);
})();
