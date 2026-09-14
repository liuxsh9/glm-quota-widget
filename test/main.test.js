'use strict';
/**
 * 主进程集成测试：桩掉 electron，真实加载 main.js，跑通 renderer:ready → refresh 全链路。
 *
 * 渲染层测试用的是手写状态，验不到「主进程到底拼出了什么状态」；这个文件补上那一段：
 * 状态结构、凭据不下发明文、两个 provider 的并行与互不干扰、配置钳制、差值历史落盘、托盘文案。
 *
 * 凭据从环境变量取（GLM_TOKEN / DS_API_KEY 或 /tmp/glm_token），**不写进仓库**；
 * 没有凭据时只验空态与配置链路，不发真实请求。
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
  Menu: { buildFromTemplate: () => ({ popup: noop }) },
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

/* ---------------- 预置配置 ---------------- */
const glmToken = process.env.GLM_TOKEN
  || (fs.existsSync('/tmp/glm_token') ? fs.readFileSync('/tmp/glm_token', 'utf8').trim() : '');
const dsKey = process.env.DS_API_KEY || '';
const hasCreds = !!(glmToken || dsKey);

// 故意写成**旧版本**的配置格式：老用户升级上来的第一条路径就是这段迁移
fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify({
  token: glmToken, dsToken: dsKey, intervalMin: 10, notifyThreshold: 75, paceAlert: true,
}, null, 2));

require(path.join(CWD, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (ch, arg) => handlers[ch]({}, arg);
const state = () => call('state:get');

/** 等到两个 provider 都不在 loading（真实网络往返时间不定，别写死 sleep） */
async function settle(timeoutMs = 30000) {
  const t0 = Date.now();
  for (; ;) {
    const s = await state();
    if (s.providers.glm.status !== 'loading' && s.providers.ds.status !== 'loading') return s;
    if (Date.now() - t0 > timeoutMs) return s;
    await wait(250);
  }
}

(async () => {
  console.log('主进程集成测试  (userData=' + USERDATA + ', 真实凭据=' + (hasCreds ? '有' : '无') + ')');
  console.log('\nIPC 与冷启动:');
  await wait(200);
  t('renderer:ready / state:get / cfg:save / tab:set / view:set 均已注册',
    ['renderer:ready', 'state:get', 'cfg:save', 'tab:set', 'view:set', 'refresh:now', 'clipboard:peek']
      .every((k) => typeof handlers[k] === 'function'));

  await call('renderer:ready');
  const st = await settle();

  console.log('\n状态结构:');
  t('顶层只有视图/主题/providers/config 这些', ['view', 'hasAcrylic', 'theme', 'platform', 'providers', 'config'].every((k) => k in st));
  t('providers.glm 与 providers.ds 都在', !!(st.providers && st.providers.glm && st.providers.ds));
  t('config 里没有明文凭据', !('token' in st.config) && !('dsToken' in st.config) && !('dsPlatformToken' in st.config));
  t('只下发尾号', typeof st.config.tokenTail === 'string' && typeof st.config.dsTokenTail === 'string');
  t('旧配置 notifyThreshold:75 迁移成 warnThreshold:75', st.config.warnThreshold === 75);
  t('迁移后不再残留旧键', !('notifyThreshold' in st.config));
  t('paceAlert 下发', st.config.paceAlert === true);
  t('dsRange / dsPollMin / panelTab 有默认值',
    st.config.dsRange === '7d' && st.config.dsPollMin === 2 && st.config.panelTab === 'glm',
    JSON.stringify({ r: st.config.dsRange, p: st.config.dsPollMin }));
  t('isPortable 下发', st.config.isPortable === false);

  console.log('\n平台链路未配置时的降级:');
  t('平台状态 = empty', st.providers.ds.platform.status === 'empty');
  t('托盘文案不为空', typeof trayTip === 'string' && trayTip.length > 0, JSON.stringify(trayTip));

  if (!hasCreds) {
    console.log('\n(无凭据：跳到配置链路与空态验证)');
    t('GLM 空态', st.providers.glm.status === 'empty', st.providers.glm.status);
    t('DS 空态', st.providers.ds.status === 'empty', st.providers.ds.status);
  } else {
    console.log('\n真实网络往返:');
    if (glmToken) {
      t('GLM 拉取成功', st.providers.glm.status === 'ok', st.providers.glm.status + ' ' + st.providers.glm.msg);
      t('GLM 解析出 5h / 周两个窗口', !!(st.providers.glm.data && st.providers.glm.data.five && st.providers.glm.data.week));
    }
    if (dsKey) {
      t('DS 拉取成功', st.providers.ds.status === 'ok', st.providers.ds.status + ' ' + st.providers.ds.msg);
      t('DS 余额已解析且币种已知',
        !!(st.providers.ds.balance && Number.isFinite(st.providers.ds.balance.total) && st.providers.ds.balance.currency),
        JSON.stringify(st.providers.ds.balance));
      t('DS 汇总走本地差值口径（未配平台令牌）',
        !!(st.providers.ds.summary && st.providers.ds.summary.source === 'local'));
      t('汇总带逐日序列', Array.isArray(st.providers.ds.summary.series) && st.providers.ds.summary.series.length === 7);
      t('托盘提示含两家', /GLM/.test(trayTip) && /DeepSeek/.test(trayTip), JSON.stringify(trayTip));

      const histFile = path.join(USERDATA, 'ds-history.json');
      const samples = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : null;
      t('差值历史已落盘', Array.isArray(samples) && samples.length >= 1);
      t('样本形如 [时间戳, 余额] 且与当前余额一致',
        !!(samples && samples[0].length === 2 && samples[samples.length - 1][1] === st.providers.ds.balance.total));
    }
  }

  console.log('\n面板页签与窗口尺寸:');
  await call('view:set', 'panel');   // 窗口尺寸只在面板显示时才跟着页签变
  await wait(150);
  t('展开面板 → 窗口按 GLM 视图尺寸', windowBounds.height === 270 + 24 && windowBounds.width === 326 + 24, JSON.stringify(windowBounds));
  await call('tab:set', 'ds');
  await wait(150);
  const stDs = await state();
  t('panelTab 切到 ds', stDs.config.panelTab === 'ds');
  t('两个页签同高（切页签窗口零位移）',
    windowBounds.height === 270 + 24 && windowBounds.width === 326 + 24, JSON.stringify(windowBounds));
  await call('tab:set', 'glm');
  await wait(150);
  t('切回 GLM 仍是同一尺寸', (await state()).config.panelTab === 'glm' && windowBounds.height === 270 + 24, JSON.stringify(windowBounds));

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
  const r30 = await state();
  t('dsRange 30d → 汇总序列跟着变 30 天',
    r30.config.dsRange === '30d' && r30.providers.ds.summary.series.length === 30,
    r30.providers.ds.summary.series.length);
  await call('cfg:save', { dsRange: '乱七八糟' });
  t('非法 dsRange 被忽略', (await state()).config.dsRange === '30d');
  await call('cfg:save', { dsRange: '7d' });
  await call('cfg:save', { dsPollMin: 999 });
  t('dsPollMin 越界回退 2', (await state()).config.dsPollMin === 2);
  await call('cfg:save', { dsPollMin: 5 });
  t('dsPollMin 5 → 5', (await state()).config.dsPollMin === 5);
  await call('cfg:save', { dsToken: 'sk-0123456789abcdef0123456789abcdef' });
  await call('cfg:save', { dsToken: '这不是一个 key' });
  t('无法识别的凭据输入被忽略，已有值不被冲掉',
    (await state()).config.dsTokenTail === 'abcdef', (await state()).config.dsTokenTail);
  await call('cfg:save', { dsToken: '' });
  t('显式清空仍然生效', (await state()).config.dsHasToken === false);

  console.log('\n剪贴板识别:');
  const peek = await call('clipboard:peek');
  t('返回三种凭据的结构', peek && 'glm' in peek && 'ds' in peek && 'platform' in peek, JSON.stringify(peek));

  console.log('\n清理配置:');
  await call('cfg:save', { token: '', dsToken: '', dsPlatformToken: '' });
  const cleared = await settle(5000);
  t('清空后 GLM 空态', cleared.providers.glm.status === 'empty', cleared.providers.glm.status);
  t('清空后 DS 空态', cleared.providers.ds.status === 'empty', cleared.providers.ds.status);
  t('清空后 hasToken / dsHasToken / dsHasPlatform 全为假',
    !cleared.config.hasToken && !cleared.config.dsHasToken && !cleared.config.dsHasPlatform);
  t('状态一直有推给渲染层', posted.length > 0, posted.length + ' 次');

  // 凭据只落在本机 userData，测试结束顺手删掉
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : '（临时 userData 已清理）'}`);
  process.exit(fails ? 1 : 0);
})();
