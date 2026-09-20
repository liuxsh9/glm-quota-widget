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

const CWD = path.join(__dirname, '..');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-main-test-'));
const posted = [];        // 主进程推给渲染层的状态
const handlers = {};      // 注册过的 IPC
let trayTip = '';
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
const ev = { on: noop, once: noop, removeAllListeners: noop };

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
  BrowserWindow: function () { return mkWindow(); },
  Tray: function () { return { setContextMenu: noop, setToolTip: (v) => { trayTip = v; }, setImage: noop, on: noop }; },
  // 菜单：记下模板，popup 只登记「关闭回调」——测试自己决定何时关（真实原生菜单是异步的）
  Menu: {
    buildFromTemplate: (tpl) => ({
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
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getDisplayNearestPoint: () => ({ scaleFactor: 1 }),
    on: noop,
  },
  powerMonitor: ev,
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
const hasRealCreds = !!(process.env.GLM_TOKEN || process.env.DS_API_KEY);
if (!hasRealCreds) {
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

fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify({
  // 旧版平铺格式 + notifyThreshold 时代的键（迁移链路全覆盖）
  token: FAKE_GLM, dsToken: FAKE_DS, dsPlatformToken: '', intervalMin: 10,
  notifyThreshold: 75, paceAlert: true,
  lastData: SNAP, lastDs: DS_SNAP,
  lastNotifiedWindowStart: 123456, lastNotifiedWeekStart: 654321,
}, null, 2));
// 旧版平铺差值历史 → 应挂到迁移出来的 ds0 账户上
fs.writeFileSync(path.join(USERDATA, 'ds-history.json'), JSON.stringify([[Date.now() - 600e3, 130.02], [Date.now() - 300e3, 128.66]]));

require(path.join(CWD, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (ch, arg) => handlers[ch]({}, arg);
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

(async () => {
  console.log('主进程集成测试  (userData=' + USERDATA + ')');
  console.log('\nIPC 与冷启动:');
  await wait(200);
  t('renderer:ready / state:get / cfg:save / tab:set / view:set / refresh:now / clipboard:peek / acc:* 均已注册',
    ['renderer:ready', 'state:get', 'cfg:save', 'tab:set', 'view:set', 'refresh:now', 'clipboard:peek',
      'acc:add', 'acc:update', 'acc:remove', 'acc:activate'].every((k) => typeof handlers[k] === 'function'));

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
  t('账户视图只含 id/provider/name/enabled/creds', ['id', 'provider', 'name', 'enabled', 'creds']
    .every((k) => k in st.config.accounts[0]));
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

  // 凭据只落在本机 userData，测试结束顺手删掉
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : '（临时 userData 已清理）'}`);
  process.exit(fails ? 1 : 0);
})();
