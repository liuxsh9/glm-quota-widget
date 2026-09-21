'use strict';
/* 渲染层编排：状态由主进程推送，骨架（胶囊列 / 面板页签 / 账户 chips / 设置分段）
 * 全部按 GLMPROV 元数据动态生成；provider 专属视觉在 panes.js，设置页在 settings.js。
 *
 * 新增一家 provider：meta.js 一条 + 主进程实现 + panes.js 一个工厂（可选）——
 * 本文件不认识任何具体 provider 名，天然可扩展。 */
window.addEventListener('error', (e) => console.error('GLM_APP error:', e.message, `${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => console.error('GLM_APP 未处理的拒绝:', e.reason));

if (!window.glm) {
  // preload 桥未注入：显示可见标记并中止（主进程会把这条 console 记进 main.log）
  console.error('GLM_APP NO_GLM: preload 桥未注入，交互全部不可用');
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.querySelector('.hint-all');
    if (el) { el.style.display = 'flex'; el.innerHTML = '<span class="warn">⚠ 初始化失败 NO_GLM</span>'; }
  });
  throw new Error('GLM_APP aborted: no bridge');
}

const api = window.glm;
const F = window.GLMFMT;
const PROV = window.GLMPROV;
const { esc, hhmm } = window.GLMPUI;
const $ = (s) => document.querySelector(s);

let st = null;
let lastTrayUrl = '';
let refreshing = false;
let shownZoom = 1;
let zoomTipTimer = 0;
let settingsSig = '';        // 设置页结构指纹：账户清单没变就只回填、不重建
let clipCache = null;        // 最近一次剪贴板识别（设置页重建后重放）

/** pid → { pane:{el,update,tick}, capsule:{el,update}, prevIds } 每家一份实例 */
const widgets = new Map();

/* ---------- GLMPUI 胶水：panes.js / settings.js 回调回编排层 ---------- */
window.GLMPUI.applyState = (s) => { if (s && s.providers) applyState(s); };
window.GLMPUI.rerender = () => { if (st) applyState(st); };
window.GLMPUI.invalidateSettings = () => { settingsSig = ''; };
window.GLMPUI.setRange = (r) => {
  if (st && st.config) st.config.dsRange = r;
  applyState(st);              // 乐观先行：不等主进程回包
  api.save({ dsRange: r });
};
/** 把某账户设为当前账户（胶囊 chip 走原生菜单、平铺模式点名字都汇到这里） */
window.GLMPUI.activate = async (pid, id) => {
  const ns = await api.accActivate({ provider: pid, id });
  if (ns && ns.providers) applyState(ns);
};
/** 胶囊账户切换器：原生弹出菜单（自绘弹层会被 40px 高的窗口裁掉） */
window.GLMPUI.accMenu = async (pid) => {
  const ns = await api.accMenu({ provider: pid });
  if (ns && ns.providers) applyState(ns);
};
window.GLMPUIgo = {
  settings: () => { setViewLocal('settings'); api.setView('settings'); },
};

/* ---------- 状态渲染 ---------- */
function providerIds(s) { return Object.keys(s.providers); }

function activeAccOf(s, pid) {
  const prov = s.providers[pid];
  if (!prov) return null;
  return prov.accounts.find((a) => a.id === prov.activeId) || prov.accounts[0] || null;
}

function credsOf(s, accId) {
  const a = s.config.accounts.find((x) => x.id === accId);
  return a ? a.creds : {};
}

/** 胶囊整体是否处于「平铺」：布局选 all，且至少有一家配了多个账户。
 *  这是**全胶囊一个判断**，不是每家各判各的 —— 否则「GLM 两个号 + DeepSeek 一个号」
 *  会出现 GLM 带名字行、DS 不带，左右两列高度和基线都对不齐。 */
function capsuleTile(s) {
  return s.config.capsuleLayout === 'all'
    && providerIds(s).some((pid) => s.providers[pid].accounts.filter((a) => a.enabled !== false).length > 1);
}

/** pane/capsule 工厂要的上下文 */
function paneCtx(s, pid, isTab) {
  const meta = PROV.byId(pid);
  const prov = s.providers[pid];
  const acc = activeAccOf(s, pid);
  return {
    acc,
    accounts: prov ? prov.accounts : [],
    config: s.config,
    tile: capsuleTile(s),   // 平铺布局（全胶囊统一：都带账户名行，或都不带）
    isTab,
    theme: s.theme,
    peak: meta ? meta.peak : null,
    accent: meta ? meta.accent : null,
    site: meta ? meta.site : null,
    siteLabel: meta ? meta.siteLabel : null,
    accCreds: acc ? credsOf(s, acc.id) : {},
  };
}

/** 确保每家 provider 的 pane/capsule 实例存在（provider 集变化时增删） */
function ensureWidgets(s) {
  const ids = providerIds(s);
  for (const pid of ids) {
    if (widgets.has(pid)) continue;
    const ui = window.PANES[pid];
    if (!ui) { console.error('GLM_APP 缺少 provider 界面渲染器:', pid); continue; }
    const w = { pane: ui.pane(), capsule: ui.capsule(), ids: '' };
    w.capsule.el.dataset.pid = pid;   // 胶囊列按 data-pid 认领自己的 provider（滚轮切换用）
    widgets.set(pid, w);
  }
  for (const pid of [...widgets.keys()]) {
    if (!ids.includes(pid)) widgets.delete(pid);
  }
}

function applyState(s) {
  st = s;
  ensureWidgets(s);
  const c = s.config || {};
  const b = document.body;
  const tabPid = c.panelTab;
  const tabProv = s.providers[tabPid] || null;
  const tabAcc = activeAccOf(s, tabPid);

  b.className = [
    'view-' + s.view,
    c.hasAcrylic || s.hasAcrylic ? 'acrylic' : '',
    s.theme === 'light' ? 'theme-light' : '',
    providerIds(s).length ? '' : 'no-providers',
    tabAcc && tabAcc.status === 'expired' ? 'bn-expired'
      : (tabAcc && (tabAcc.status === 'error' || tabAcc.status === 'ratelimit')) ? 'bn-retry' : 'bn-none',
  ].filter(Boolean).join(' ');
  b.dataset.tier = s.worstTier || 'low';

  renderTabs(s);
  renderAccRow(s);
  renderCapsule(s);
  renderPanes(s);

  // 面板头部：时间/状态跟随当前页签的当前账户
  const upd = $('#upd');
  const warn = { expired: 1, error: 1, ratelimit: 1 };
  upd.classList.toggle('err', !!(tabAcc && warn[tabAcc.status]));
  upd.textContent = tabAcc ? ({
    // 只留时间：右边的 ⟳ 已经说明这是「上次更新」，三家页签挤在 290px 里时这 22px 很值钱
    ok: tabAcc.lastFetchAt ? hhmm(tabAcc.lastFetchAt) : '',
    loading: '刷新中…',
    expired: '已过期',
    ratelimit: '限流退避中',
    error: '⚠ 更新失败',
    empty: '未配置',
    boot: '…',
  }[tabAcc.status] || '') : '';
  $('#errMsg').textContent = ((tabAcc && tabAcc.msg) || '更新失败') + (tabProv ? `（${tabProv.name}）` : '');

  refreshing = !!(tabAcc && tabAcc.status === 'loading');
  $('#refBtn2').classList.toggle('spin', refreshing);

  applySettings(s);
  drawTray();

  // 缩放提示：zoom 值变化时短暂显示百分比
  const z = c.zoom || 1;
  if (z !== shownZoom) {
    shownZoom = z;
    const tip = $('#zoomTip');
    tip.hidden = false;
    tip.textContent = Math.round(z * 100) + '%';
    tip.classList.add('show');
    clearTimeout(zoomTipTimer);
    zoomTipTimer = setTimeout(() => tip.classList.remove('show'), 900);
  }

  if (s.view === 'settings') peekClipboard();
}

/* ---------- 面板页签（按 provider 生成） ---------- */
function renderTabs(s) {
  const host = $('#tabs');
  const ids = providerIds(s);
  // 结构（页签集合）没变就不重建，只更新高亮与徽标
  const sig = ids.join(',');
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.innerHTML = ids.map((pid) => {
      const meta = PROV.byId(pid);
      const badge = meta && meta.tabBadge === 'level' ? ' <b class="lvl"></b>' : '';
      const label = meta ? (meta.tabShort || meta.tab) : pid;   // 页签窄，优先用更短的写法
      return `<button class="tab" data-pid="${pid}" role="tab">${esc(label)}${badge}</button>`;
    }).join('');
    host.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        api.setTab(t.dataset.pid);
        if (st && st.config) { st.config.panelTab = t.dataset.pid; applyState(st); }   // 乐观先行
      });
    });
  }
  host.querySelectorAll('.tab').forEach((t) => {
    const pid = t.dataset.pid;
    t.classList.toggle('on', pid === s.config.panelTab);
    const meta = PROV.byId(pid);
    const lvl = t.querySelector('.lvl');
    if (lvl) {
      const acc = activeAccOf(s, pid);
      const d = acc && acc.data;
      lvl.textContent = d && d.level ? F.levelName(d.level) : '';
    }
    // 套餐徽标只在当前页签显示（见 style.css）：悬停任一页签都能看到「哪家 + 什么套餐」
    t.title = (meta ? meta.name : pid) + (lvl && lvl.textContent ? ` · ${lvl.textContent}` : '');
  });
}

/* ---------- 账户 chips 行（某家配了多个账户才出现） ---------- */
function renderAccRow(s) {
  const row = $('#accRow');
  const multi = providerIds(s).some((pid) => s.providers[pid].accounts.length > 1);
  row.hidden = !multi;
  if (!multi) return;
  const pid = s.config.panelTab;
  const prov = s.providers[pid];
  if (!prov) { row.innerHTML = ''; return; }
  const sig = pid + '|' + prov.accounts.map((a) => `${a.id}:${a.name}:${a.enabled ? 1 : 0}`).join(',');
  if (row.dataset.sig !== sig) {
    row.dataset.sig = sig;
    row.innerHTML = prov.accounts.map((a) =>
      `<button class="acc-chip${a.enabled === false ? ' acc-chip-off' : ''}" data-id="${a.id}">${esc(a.name)}</button>`).join('');
    row.querySelectorAll('.acc-chip').forEach((chipEl) => {
      chipEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ns = await api.accActivate({ provider: pid, id: chipEl.dataset.id });
        if (ns && ns.providers) applyState(ns);
      });
    });
  }
  // 高亮跟随 activeId：切账户不重建行，只换 on
  row.querySelectorAll('.acc-chip').forEach((chipEl) => {
    chipEl.classList.toggle('on', chipEl.dataset.id === prov.activeId);
  });
}

/* ---------- 胶囊（按 provider 出列，多列之间竖发丝线） ---------- */
function renderCapsule(s) {
  const cap = $('#capsule');
  const hint = cap.querySelector('.hint');
  const ids = providerIds(s);
  const sig = ids.join(',');
  cap.classList.toggle('cap-tiled', capsuleTile(s));   // 组间分隔线的样式跟着平铺与否走
  if (cap.dataset.sig !== sig) {
    cap.dataset.sig = sig;
    cap.querySelectorAll('.cap-grp, .cap-sep').forEach((e) => e.remove());
    let first = true;
    for (const pid of ids) {
      if (!first) {
        const sep = document.createElement('div');
        sep.className = 'cap-sep';
        cap.insertBefore(sep, hint);
      }
      first = false;
      const w = widgets.get(pid);
      if (w) cap.insertBefore(w.capsule.el, hint);
    }
    bindCapsuleWheel(s);
  }
  for (const pid of ids) {
    const w = widgets.get(pid);
    if (w) w.capsule.update(paneCtx(s, pid, false));
  }
  syncCapsuleSize();
}

/** 胶囊列上的滚轮：多账户时循环切换该 provider 的当前账户（不想开菜单时的快手势） */
function bindCapsuleWheel(s) {
  const cap = $('#capsule');
  cap.querySelectorAll('.cap-grp[data-pid]').forEach((col) => {
    const pid = col.dataset.pid;
    col.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      const prov = st && st.providers[pid];
      if (!prov || prov.accounts.length < 2) return;
      e.preventDefault();
      cycleAccount(pid, e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  });
}

async function cycleAccount(pid, dir) {
  const prov = st && st.providers[pid];
  if (!prov || prov.accounts.length < 2) return;
  const idx = prov.accounts.findIndex((a) => a.id === prov.activeId);
  const next = prov.accounts[(idx + dir + prov.accounts.length) % prov.accounts.length];
  window.GLMPUI.activate(pid, next.id);
}

/* ---------- 胶囊尺寸上报 ----------
   卡片是 max-content（内容多大就多大），窗口尺寸以实测为准：加账户、余额位数变化、
   账户名变长都不会再挤压出边框 —— 主进程那套按 meta.capsuleW 估宽的老办法撑不住这些。
   只在整像素尺寸变化时上报，避免秒循环空转。 */
let lastCapSize = '';
function syncCapsuleSize() {
  const el = $('#capsule');
  if (!el || !api.capsuleSize) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;    // 不在胶囊视图（display:none）时量不到
  const w = Math.ceil(r.width), h = Math.ceil(r.height);
  const sig = w + 'x' + h;
  if (sig === lastCapSize) return;
  lastCapSize = sig;
  api.capsuleSize({ w, h });
}

/* ---------- 面板尺寸上报 ----------
   面板高度不再写死：渲染层量出「页头上两个页签里最高的那个 + 账户 chips 行 + 内边距」，
   上报给主进程当窗口高。写死的高度在换字体/换系统时会差几个像素 —— 不是把 chips 行裁掉，
   就是在最下面多出一截空白。两个页签取高者，所以切页签窗口仍然一个像素都不动。 */
/** 页签区高度 = 两个页签里高的那个（CSS 让它们叠在同一个 grid 格子，容器自动取最大）。
 *  纯读一个容器的尺寸，不碰任何页签的样式。 */
/** 页签区的高度：格子取最高的那批（GLM / DeepSeek 高度相仿，取齐了切页签才不跳）；
 *  跳出格子的那一页（.pane-solo，火山多一个「月」块）量不到，当前页签是它时单独算进来 */
function panesHeight() {
  const el = $('#panes');
  if (!el) return 0;
  const h = el.getBoundingClientRect().height;
  const solo = el.querySelector('.pane-solo.on');
  return solo ? Math.max(h, solo.getBoundingClientRect().height) : h;
}

/** 窗口尺寸变化后重新量一遍：切换视图的那一帧窗口还是旧尺寸（面板宽度会决定文字换行），
 *  量出来的高度不作数 —— 等主进程把窗口调好后再量一次。 */
let sizeReflow = 0;
function onWindowResize() {
  if (sizeReflow) return;
  sizeReflow = requestAnimationFrame(() => {
    sizeReflow = 0;
    syncCapsuleSize();
    syncPanelSize(true);
    verifyPanelFit();
  });
}

let lastPanelH = 0;
/** 自愈补偿：一旦发现「按实测高度报上去、窗口也调好了，内容还是被裁」，就把差额记在这里，
 *  之后每次上报都带上它。**只增不减** —— 减了会和窗口来回抖（报小 → 被裁 → 报大 → 装得下 → 又报小）。 */
let healAsked = 0;

/** 自检：面板内容真的装进卡片了吗？被裁就加码重报。
 *  高度是「量出来再上报」的，这一层是兜底 —— 万一哪台机器上量短了（字体、缩放、极端数据），
 *  用户看到的是「只剩上面几行、下面一片空白」，而不是默默被裁掉。 */
function verifyPanelFit() {
  if (!st || st.view !== 'panel' || !api.panelSize) return;
  const host = $('#panel');
  if (!host || host.getBoundingClientRect().width < 300) return;  // 换视图那一帧窗口还是别的尺寸，不算数
  // 只有「窗口已经变成我上次要的高度」时才判定：否则只是窗口还没跟上，补了白补、还会越补越大
  const pad = parseFloat(getComputedStyle(document.body).paddingTop) || 12;
  if (Math.abs(window.innerHeight - (lastPanelH + pad * 2)) > 4) return;
  const pane = host.querySelector('.pane.on');
  const lastRow = pane && pane.lastElementChild;
  if (!lastRow) return;
  const cs = getComputedStyle(host);
  const innerBottom = host.getBoundingClientRect().bottom
    - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
  const over = lastRow.getBoundingClientRect().bottom - innerBottom;
  if (over <= 1.5) return;    // 装得下：什么都不做
  healAsked += Math.ceil(over) + 2;
  console.info(`GLM_APP panel 内容被裁 ${over.toFixed(1)}px → 高度补偿累计 ${healAsked}px`);
  lastPanelH = 0;
  syncPanelSize(true);
}

function syncPanelSize(force) {
  if (!st || !api.panelSize) return;
  const panel = $('#panel');
  if (!panel) return;
  const head = $('#panel .phead');
  if (!head) return;
  const headH = head.getBoundingClientRect().height;
  if (!headH) return;    // 面板没显示（display:none）时量不到，等切过去再量
  // 换视图那一帧窗口还是胶囊的尺寸：这时候的宽度会让文字换行、高度虚高，
  // 报上去窗口会先跳一下再改回来。宽度不对就不量，等窗口调好（resize）再量。
  if (panel.getBoundingClientRect().width < 300) return;
  const row = $('#accRow');
  const rowH = row && !row.hidden ? row.getBoundingClientRect().height : 0;
  const tallest = panesHeight();
  if (!tallest) return;
  const cs = getComputedStyle($('#panel'));
  const chromeH = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const need = Math.ceil(headH + rowH + tallest + chromeH) + healAsked;
  if (need === lastPanelH && !force) return;
  lastPanelH = need;
  // 这行会进 main.log：出问题时一眼能看出是哪一段量少了（页头/chips/页签/内边距）
  console.info(`GLM_APP panel 高度上报 ${need}px`
    + `（页头 ${Math.round(headH)} + chips ${Math.round(rowH)} + 页签 ${Math.round(tallest)} + 内边距 ${Math.round(chromeH)}`
    + (healAsked ? ` + 自愈补偿 ${healAsked}` : '') + '）');
  api.panelSize({ h: need });
}

/* ---------- 面板视图 ---------- */
function renderPanes(s) {
  const host = $('#panes');
  for (const [pid, w] of widgets) {
    if (!w.pane.el.isConnected) host.appendChild(w.pane.el);
  }
  // 摘掉 provider 已被移除的 pane（删除账户到 0 个时，widgets 里已没有它）
  host.querySelectorAll(':scope > .pane').forEach((p) => {
    if (![...widgets.values()].some((w) => w.pane.el === p)) p.remove();
  });
  host.querySelectorAll(':scope > .pane').forEach((p) => {
    const pidOf = [...widgets.entries()].find(([, w]) => w.pane.el === p);
    p.classList.toggle('on', !!pidOf && pidOf[0] === s.config.panelTab);
  });
  for (const pid of providerIds(s)) {
    const w = widgets.get(pid);
    if (!w) continue;
    const ctx = paneCtx(s, pid, pid === s.config.panelTab);
    w.pane.update(ctx);
    const acc = ctx.acc;
    w.pane.el.classList.toggle('acc-expired', !!(acc && acc.status === 'expired'));
  }
  syncPanelSize();
  verifyPanelFit();
}

/* ---------- 设置页 ---------- */
function settingsStructureSig(s) {
  return JSON.stringify([
    providerIds(s),
    s.config.accounts.map((a) => [a.id, a.provider, a.name, a.enabled, Object.entries(a.creds).map(([k, c]) => [k, c.set, c.tail])]),
    Object.keys(window.GLMPROV.list.map((p) => p.id)).length,
  ]);
}

function applySettings(s) {
  if (s.view !== 'settings') return;
  const host = $('#provSecs');
  // 编辑态：表单开着时不动 DOM；render 内部按 renderRequest 决定「打开/关闭表单」那一拍是否重建
  if (window.GLMPSETTINGS.isEditing()) {
    if (window.GLMPSETTINGS.render(host, s)) {
      bindDynamicControls();
      if (clipCache) window.GLMPSETTINGS.peek(host, clipCache);   // 重建后重放剪贴板提示
    }
    return;
  }
  const sig = settingsStructureSig(s);
  // 结构变了必须重建（优先级高于焦点守卫：关表单后焦点还留在按钮上，不能因此卡住不重绘）
  if (sig !== settingsSig) {
    settingsSig = sig;
    window.GLMPSETTINGS.render(host, s);
    bindDynamicControls();
    if (clipCache) window.GLMPSETTINGS.peek(host, clipCache);
    fillStaticSettings(s);
    return;
  }
  // 正在输入（焦点在设置页）：只回填状态词/勾选，不重建（免得打字被打断）
  if (document.activeElement && $('#settings').contains(document.activeElement)) {
    window.GLMPSETTINGS.fill(host, s);
    return;
  }
  window.GLMPSETTINGS.fill(host, s);
  if (clipCache) window.GLMPSETTINGS.peek(host, clipCache);
  fillStaticSettings(s);
}

/** 设置页动态区里的全局控件（配额提醒 / 高频采样）：change 即落盘 */
function bindDynamicControls() {
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('change', fn); };
  on('#pacealert', () => autoSave({ paceAlert: $('#pacealert').checked }));
  on('#nreset', () => autoSave({ notifyReset: $('#nreset').checked }));
  const poll = () => {
    const fast = $('#dsfast');
    const sel = $('#dspoll');
    if (sel) sel.disabled = !fast.checked;
    const row = $('#dsfastrow');
    if (row) row.classList.toggle('off', !fast.checked);
    autoSave({ dsPollMin: fast.checked ? parseInt(sel.value, 10) : 0 });
  };
  on('#dsfast', poll);
  on('#dspoll', poll);
}

/** 通用段（静态 HTML）：值回填 */
function fillStaticSettings(s) {
  const c = s.config;
  const interval = $('#interval');
  if (interval && document.activeElement !== interval) interval.value = String(c.intervalMin);
  const theme = $('#theme');
  if (theme && document.activeElement !== theme) theme.value = c.theme || 'auto';
  // 胶囊布局：只有「某家配了多个账户」才有意义，单账户用户不必看见这一项
  const layout = $('#caplayout');
  if (layout) {
    if (document.activeElement !== layout) layout.value = c.capsuleLayout === 'all' ? 'all' : 'switch';
    const multi = Object.values(s.providers || {}).some((p) => p.accounts.length > 1);
    $('#caplayoutWrap').hidden = !multi;
    $('#caplayoutHint').hidden = !multi;
  }
  const autostart = $('#autostart');
  autostart.checked = !!c.autoStart && !c.isPortable;
  autostart.disabled = !!c.isPortable;
  autostart.parentElement.title = c.isPortable ? '便携版不支持开机自启，请使用安装版' : '';
  $('#ontop').checked = !!c.alwaysOnTop;
}

/** 即时保存的可见反馈：不提示的话用户不知道已经生效了 */
let saveTipTimer = 0;
function flashSaved() {
  const el = $('#saveTip');
  if (!el) return;
  el.classList.add('show');
  clearTimeout(saveTipTimer);
  saveTipTimer = setTimeout(() => el.classList.remove('show'), 1400);
}
window.GLMPUI.flashSaved = flashSaved;

/** 勾选 / 下拉类：change 即落盘，不用等「保存并刷新」（凭据在各家表单里显式保存） */
async function autoSave(patch, after) {
  const next = await api.save(patch);
  if (after) after();
  if (next) applyState(next);
  flashSaved();
}

function bindAutoSave() {
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('change', fn); };
  on('#autostart', () => autoSave({ autoStart: $('#autostart').checked }));
  on('#ontop', () => autoSave({ alwaysOnTop: $('#ontop').checked }));
  on('#theme', () => autoSave({ theme: $('#theme').value }));
  on('#interval', () => autoSave({ intervalMin: parseInt($('#interval').value, 10) }));
  on('#caplayout', () => autoSave({ capsuleLayout: $('#caplayout').value }));
}

/** 剪贴板里如果有某种凭据，给对应输入框一个「一键填入」提示 */
async function peekClipboard() {
  let r = null;
  try { r = await api.clipboardPeek(); } catch { /* 读剪贴板失败：静默 */ }
  clipCache = r;
  if (!window.GLMPSETTINGS.isEditing()) window.GLMPSETTINGS.peek($('#provSecs'), r);
}

async function saveSettings() {
  const patch = {
    intervalMin: parseInt($('#interval').value, 10),
    warnThreshold: parseInt(($('#threshold') || {}).value ?? 80, 10),
    paceAlert: $('#pacealert') ? $('#pacealert').checked : true,
    notifyReset: $('#nreset') ? $('#nreset').checked : false,
    autoStart: $('#autostart').checked,
    alwaysOnTop: $('#ontop').checked,
    theme: $('#theme').value,
  };
  // 用返回的新状态渲染（别等广播，避免「配完了界面还是旧的」的竞态）
  const next = await api.save(patch);
  if (next) applyState(next);
  flashSaved();
  if (providerIds(next || st).length) api.setView('panel');
}

/* ---------- 托盘动态图标（32px 画布 → dataURL → 主进程） ---------- */
function drawTray() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#14161f';
  g.beginPath();
  g.roundRect ? g.roundRect(1, 1, 30, 30, 8) : g.rect(1, 1, 30, 30);
  g.fill();
  const tier = (st && st.worstTier) || 'low';
  const color = { low: '#22d3ee', mid: '#fbbf24', high: '#f87171' }[tier];
  // 档位型 provider（配额概念）画占用环；只有余额型 provider 时画实心点
  const ringPid = st ? providerIds(st).find((pid) => {
    const meta = PROV.byId(pid);
    return meta && meta.accentMode === 'tier';
  }) : null;
  const ringAcc = ringPid ? activeAccOf(st, ringPid) : null;
  if (ringAcc) {
    const p = ringAcc.status === 'expired' ? 100 : (ringAcc.data ? ringAcc.data.five.percent : 0);
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.lineWidth = 4.5;
    g.beginPath(); g.arc(16, 16, 10.5, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = color;
    g.lineCap = 'round';
    g.beginPath(); g.arc(16, 16, 10.5, -Math.PI / 2, -Math.PI / 2 + (Math.max(2, p) / 100) * Math.PI * 2);
    g.stroke();
  } else {
    g.fillStyle = color;
    g.beginPath(); g.arc(16, 16, 7, 0, Math.PI * 2); g.fill();
  }
  const url = c.toDataURL('image/png');
  if (url !== lastTrayUrl) { lastTrayUrl = url; api.trayIcon(url); }
}

/* ---------- 交互 ---------- */
function refresh() {
  if (refreshing) return;
  api.refreshNow();
}

/* 统一手势：按住拖动 = 移动窗口，原地松开 = onTap。
   窗口位置由主进程按「光标绝对增量」算（lib/drag.js），这里只负责判定点击/拖拽、
   把按下时的光标坐标送过去，并在拖动中持续发心跳 —— 渲染层的 screenX/Y 单位是
   CSS 像素，缩放屏上和 DIP 不是一回事，所以一个字节的坐标都不参与窗口定位。 */
let drag = null;
const pending = { gx: 0, gy: 0, onTap: null };

function dragListeners(on) {
  const fn = on ? window.addEventListener : window.removeEventListener;
  fn('pointermove', onDragMove);
  fn('pointerup', onDragFinish);
  fn('pointercancel', onDragFinish);
  fn('blur', onDragFinish);
}

function makeDraggable(elRoot, onTap) {
  elRoot.addEventListener('pointerdown', (e) => {
    if (!elRoot || e.button !== 0 || e.target.closest('button, a, select, textarea, input, label, summary, .clipchip, .ds-bal, .ds-more, .acc-chip')) return;
    if (drag) return;
    drag = { moved: false };
    pending.gx = e.screenX; pending.gy = e.screenY; pending.onTap = onTap;
    try { elRoot.setPointerCapture(e.pointerId); } catch { }
    e.preventDefault();
    // 把锚点先交给主进程：光标滑出窗口矩形后就收不到 pointermove 了，靠主进程自己采样
    api.dragStart(e.screenX, e.screenY);
    dragListeners(true);
  });
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.moved && Math.abs(e.screenX - pending.gx) + Math.abs(e.screenY - pending.gy) > 3) {
    drag.moved = true;
  }
  if (drag.moved) api.dragMove();   // 心跳：告诉主进程「还在拖，别被看门狗收掉」
}

function onDragFinish() {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  dragListeners(false);
  api.dragEnd();
  if (!moved && pending.onTap) {
    try { pending.onTap(); } catch (err) { console.error('GLM_APP tap handler', err); }
  }
}

/** 乐观先行切换视图：不等主进程回包，点击瞬间内容就变（主进程广播稍后对齐） */
function setViewLocal(v) {
  document.body.classList.remove('view-capsule', 'view-panel', 'view-settings');
  document.body.classList.add('view-' + v);
  // 换视图前先把实测尺寸递过去：主进程 setView 时就能按正确的宽/高重排，省掉可见的尺寸跳变
  if (v === 'capsule') syncCapsuleSize();
  if (v === 'panel') syncPanelSize();
}

function expandTarget() {
  if (!st || !providerIds(st).length) return 'settings';
  // 当前展示的账户里有凭据失效的 → 直达设置（和旧版「Token 失效点胶囊进设置」一致）
  const expired = providerIds(st).some((pid) => {
    const acc = activeAccOf(st, pid);
    return acc && acc.status === 'expired';
  });
  return expired ? 'settings' : 'panel';
}

/* ---------- 每秒：各 pane 的倒计时/配速 ---------- */
function tickPanes() {
  if (!st) return;
  for (const pid of providerIds(st)) {
    const w = widgets.get(pid);
    if (w && w.pane.tick) w.pane.tick(paneCtx(st, pid, pid === st.config.panelTab));
  }
  // 胶囊列的幽灵/亮线也随秒走
  for (const pid of providerIds(st)) {
    const w = widgets.get(pid);
    if (w) w.capsule.update(paneCtx(st, pid, false));
  }
  syncCapsuleSize();
}

function bind() {
  // 三个视图都可拖动；点击（非控件处）：胶囊=展开，面板/设置=收起
  makeDraggable($('#capsule'), () => { const v = expandTarget(); setViewLocal(v); api.setView(v); });
  makeDraggable($('#panel'), () => { setViewLocal('capsule'); api.setView('capsule'); });
  makeDraggable($('#settings'), () => { setViewLocal('capsule'); api.setView('capsule'); });

  $('#capsule').addEventListener('contextmenu', (e) => { e.preventDefault(); api.ctxMenu(); });
  $('#capsule').addEventListener('dblclick', (e) => e.preventDefault());

  $('#refBtn2').addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
  $('#gearBtn').addEventListener('click', (e) => { e.stopPropagation(); setViewLocal('settings'); api.setView('settings'); });
  $('#fixBtn').addEventListener('click', () => { setViewLocal('settings'); api.setView('settings'); });
  $('#retryBtn').addEventListener('click', refresh);
  $('#backBtn').addEventListener('click', () => {
    const v = st && providerIds(st).length ? 'panel' : 'capsule';
    setViewLocal(v); api.setView(v);
  });
  $('#saveBtn').addEventListener('click', saveSettings);
  $('#saveBtn2').addEventListener('click', saveSettings);

  bindAutoSave();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st && st.view !== 'capsule') { setViewLocal('capsule'); api.setView('capsule'); }
    if (e.ctrlKey && (e.key === '0' || e.code === 'Digit0') && st && st.view !== 'capsule') {
      e.preventDefault();
      if ((st.config.zoom || 1) !== 1) api.setZoom(1);
    }
  });
  // Ctrl+滚轮：展开态等比缩放（胶囊保持紧凑不缩放）
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !st || st.view === 'capsule') return;
    e.preventDefault();
    const cur = st.config.zoom || 1;
    const next = Math.min(1.6, Math.max(0.8, Math.round((cur + (e.deltaY < 0 ? 0.05 : -0.05)) * 20) / 20));
    if (next !== cur) api.setZoom(next);
  }, { passive: false });
  setInterval(tickPanes, 1000);
  window.addEventListener('resize', onWindowResize);
}

/* ---------- 启动 ---------- */
(async function init() {
  bind();
  api.onState(applyState); // 先订阅再取状态，避免漏掉推送
  applyState(await api.getState());
  api.ready();
  console.info('GLM_APP booted · view=' + (st && st.view)
    + ' providers=' + (st ? providerIds(st).join('+') : 'none'));
})();
