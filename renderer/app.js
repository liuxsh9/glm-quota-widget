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
const DOCKM = window.GLMDOCK;     // 百分比口径 + 圆环配色（lib/dock-metric.js，主进程共用同一份）
const LOGOS = window.GLMLOGOS;    // 三家 logo 的内联 SVG（renderer/logos.js）
const { esc, hhmm } = window.GLMPUI;
const $ = (s) => document.querySelector(s);

/* 同一个 index.html 两种身份：主窗（胶囊/贴边/面板/设置）与飞出窗（?flyout=1，只有一张卡片）。
 * 飞出窗是主进程的第二个透明窗口，专门用来画悬停圆圈时的详情卡片 —— 它走自己那套极简渲染，
 * 绝不碰主窗的视图/尺寸上报（那几条 IPC 都是对着主窗的，发过去会改错窗口）。 */
const FLYOUT = location.search.includes('flyout=1');

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
window.GLMPUI.rerender = () => { if (st) applyState(st); };   // 飞出窗里被改指到卡片（见 applyState 的路由）
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

/** pane/capsule 工厂要的上下文。accOverride 给「要看指定账户」的场合用（飞出卡片），
 *  显式传（含 null）就照传的来，不传才用当前激活账户 —— 悬停详情绝不能串成激活账户。 */
function paneCtx(s, pid, isTab, accOverride) {
  const meta = PROV.byId(pid);
  const prov = s.providers[pid];
  const acc = accOverride !== undefined ? accOverride : activeAccOf(s, pid);
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
  // 飞出窗只有一张卡片：任何走到这里的路径（状态推送 / 胶水回调）都改道到卡片渲染，
  // 免得跑到主窗那套里去（那会去量胶囊 / 面板尺寸并上报，把另一个窗口弄乱）
  if (FLYOUT) return applyFlyoutState(s);
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
    c.dockSide === 'left' ? 'dock-left' : c.dockSide === 'right' ? 'dock-right' : '',
    providerIds(s).length ? '' : 'no-providers',
    tabAcc && tabAcc.status === 'expired' ? 'bn-expired'
      : (tabAcc && (tabAcc.status === 'error' || tabAcc.status === 'ratelimit')) ? 'bn-retry' : 'bn-none',
  ].filter(Boolean).join(' ');
  b.dataset.tier = s.worstTier || 'low';

  renderTabs(s);
  renderAccRow(s);
  renderCapsule(s);
  renderDock(s);
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

/** 可切换的账户 = 启用的那些。停用的账户切不过去（主进程会拒），留在环里会把滚轮
 *  卡死：从当前账户往下滚正好撞上它，被拒后当前账户没变，下一次又撞上同一个。 */
function switchableAccs(pid) {
  const prov = st && st.providers[pid];
  return prov ? prov.accounts.filter((a) => a.enabled !== false) : [];
}

/** 胶囊列上的滚轮：多账户时循环切换该 provider 的当前账户（不想开菜单时的快手势） */
function bindCapsuleWheel(s) {
  const cap = $('#capsule');
  cap.querySelectorAll('.cap-grp[data-pid]').forEach((col) => {
    const pid = col.dataset.pid;
    col.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      if (switchableAccs(pid).length < 2) return;   // 没得切就别吃掉滚轮
      e.preventDefault();
      cycleAccount(pid, e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  });
}

async function cycleAccount(pid, dir) {
  const list = switchableAccs(pid);
  if (list.length < 2) return;
  const idx = list.findIndex((a) => a.id === (st.providers[pid] || {}).activeId);
  const next = list[(idx + dir + list.length) % list.length];
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

/* ---------- 贴边列（dock）：每个启用的账户一个圆圈 ----------
   圆圈 = 圆环（百分比弧 + 底环）+ 中心 logo + 环下百分比数字。口径（取哪个百分比）与环色
   全部来自 lib/dock-metric.js（GLMDOCK），渲染层不自己算百分比、也不自己挑颜色。
   账户集合没变时**不重建**列：只更新环与数字 —— 否则状态每次推送（每秒都可能有）圆圈都会闪。 */
const DOCK_R = 18.25;                 // 圆环半径：直径 40 − 环宽 3.5（SVG viewBox 内部单位，跟随 CSS 缩放）
const DOCK_C = 2 * Math.PI * DOCK_R;  // 圆周长：进度弧的 dasharray
const DOCK_CORNER = 15;               // 主体圆角半径（× dockScale）：远端两角与贴边侧两处反向圆角**同一个 r**
const DOCK_SMOOTH = 0.6;              // 连续曲率圆角的平滑度（Figma corner smoothing 同口径）：每个角沿两边
                                      // 各占 (1 + 0.6) × r = 24 —— 也就是贴边侧喇叭口沿屏幕边升起的高度
const DOCK_FLARE = (1 + DOCK_SMOOTH) * DOCK_CORNER;   // = 24，CSS 里 #dock 的上下留白 36 = 它 + 12 间距

/** 这一列画哪些圆圈：provider 注册表序 → 每家的账户原序 → 只留启用的 */
function dockCells(s) {
  const out = [];
  for (const pid of providerIds(s)) {
    const prov = s.providers[pid];
    if (!prov) continue;
    for (const acc of prov.accounts) {
      if (acc.enabled === false) continue;    // 停用的账户不出场
      out.push({ pid, acc });
    }
  }
  return out;
}

/** 圆圈悬停 → 主进程的 dock:hover：cy = 圆心（圆环中心）相对窗口顶部的 CSS px。
 *  这个视图下 body 无 padding、无滚动，rect 相对视口就是这个窗口的坐标。 */
function dockHoverPayload(node) {
  const ring = node.querySelector('.dc-top').getBoundingClientRect();
  return { accId: node.dataset.accId, cy: Math.round(ring.top + ring.height / 2) };
}

function dockCellHtml(pid, acc) {
  // 圆圈上不挂原生 title：悬停详情由飞出卡片承担（两个 tooltip 会同时出现）
  return `<div class="dc" data-pid="${esc(pid)}" data-acc-id="${esc(acc.id)}">`
    + `<div class="dc-top">`
    + `<svg class="dc-ring" viewBox="0 0 40 40" aria-hidden="true">`
    + `<circle class="dc-track" cx="20" cy="20" r="${DOCK_R}"></circle>`
    + `<circle class="dc-arc" cx="20" cy="20" r="${DOCK_R}"`
    + ` stroke-dasharray="${DOCK_C.toFixed(2)}" stroke-dashoffset="${DOCK_C.toFixed(2)}"></circle>`
    + `</svg>`
    + `<span class="dc-logo" aria-hidden="true">${(LOGOS && LOGOS[pid]) || ''}</span>`
    + `<i class="dc-badge">!</i>`
    + `</div>`
    + `<b class="dc-pct">–</b>`
    + `</div>`;
}

/** 只动环与数字（列结构没变时逐个更新，不重建节点） */
function updateDockCell(node, pid, acc) {
  const p = DOCKM.percentOf(pid, acc.data, acc.dock);
  const warn = acc.status === 'expired' || acc.status === 'error';
  const arc = node.querySelector('.dc-arc');
  if (p) {
    arc.setAttribute('stroke', DOCKM.ringColor(p.pct));   // 弧色：连续渐变（0–100 夹过的比例）
    arc.setAttribute('stroke-dashoffset', (DOCK_C * (1 - p.pct / 100)).toFixed(2));
  } else {
    arc.removeAttribute('stroke');                        // 取不到数：不画弧，只留底环
    arc.setAttribute('stroke-dashoffset', DOCK_C.toFixed(2));
  }
  node.classList.toggle('dc-none', !p);
  node.classList.toggle('dc-warn', warn);                 // 过期 / 出错：灰环 + 角标
  // 数字讲真话：用未夹的 raw —— DeepSeek 超预算时是 150% 而不是 100%
  node.querySelector('.dc-pct').textContent = p ? Math.round(p.raw) + '%' : '–';
}

/** 全停用 / 还没配账户时的空态：一个安静的虚线圆 + ⚙。贴边保留、不清配置 —— 重加账户时
 *  不必再贴一次边；点它走「点空白 → 展开设置」那条现成的路（expandTarget 无 provider 时回 settings）。 */
function dockEmptyHtml() {
  return `<div class="dc-empty" title="还没有可显示的账户 · 点击去设置">`
    + `<span class="dc-gear" aria-hidden="true">⚙</span>`
    + `</div>`;
}

/** 圆圈大小落到 #dock 的 --ds 上（CSS 里全部尺寸都 calc 它）+ 立刻重做造型 / 重测上报。
 *  Ctrl+滚轮 / Ctrl+0 先用它「乐观先行」——不等主进程回包，滚轮那一帧圈就变大变小了。 */
function applyDockScale(s) {
  if (st && st.config) st.config.dockScale = s;
  const host = $('#dock');
  if (host) host.style.setProperty('--ds', String(s));
  applyDockShape();
  syncDockSize();
}

/** 贴边列上的 Ctrl+滚轮：步进 0.1、夹在 [0.6, 1.6]（一位小数），本地上立即应用 + 落盘 */
function stepDockScale(dir) {
  const cur = dockScaleOf(st);
  const next = Math.min(1.6, Math.max(0.6, Math.round((cur + dir * 0.1) * 10) / 10));
  if (next === cur) return;      // 到顶 / 到底：不空转、不落盘
  applyDockScale(next);
  api.save({ dockScale: next });
}

function renderDock(s) {
  const host = $('#dock');
  if (!host) return;
  host.style.setProperty('--ds', String(dockScaleOf(s)));   // 圆圈大小：所有尺寸都随它走
  const cells = dockCells(s);
  // 空态也占一档结构指纹：'empty'（真实指纹是 'pid:accId' 的逗号列表，撞不上）
  const sig = cells.length ? cells.map(({ pid, acc }) => pid + ':' + acc.id).join(',') : 'empty';
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.querySelectorAll('.dc, .dc-empty').forEach((el) => el.remove());
    host.insertAdjacentHTML('beforeend',
      cells.length ? cells.map(({ pid, acc }) => dockCellHtml(pid, acc)).join('') : dockEmptyHtml());
    // 悬停圆圈 → 主进程弹出该账户的详情卡片（飞出窗）；节点重建时监听跟着重绑
    host.querySelectorAll('.dc').forEach((el) => {
      el.addEventListener('pointerenter', () => { if (api.dockHover) api.dockHover(dockHoverPayload(el)); });
      el.addEventListener('pointerleave', () => { if (api.dockHover) api.dockHover(null); });
    });
  }
  const nodes = host.querySelectorAll('.dc');
  cells.forEach(({ pid, acc }, i) => { if (nodes[i]) updateDockCell(nodes[i], pid, acc); });
  // 刚进贴边（上一拍还不是）→ 播吸附入场动画（凹弧收口）；其余情形只对齐造型
  const nowDock = s.view === 'dock';
  const entering = nowDock && !dockVisible;
  dockVisible = nowDock;
  if (entering) dockAnimateIn(); else applyDockShape();
  syncDockSize();
}

/* ---------- 贴边造型：流体融合吸附（2026-10-08 用户第三轮反馈）----------
   目标：胶囊像液滴贴上屏幕边 —— 贴边侧整条并入屏幕物理边缘（没有描边、没有缝），外露的上下两端
   以**反向圆角**（喇叭口）切进屏幕边；反向圆角与远端两个凸圆角是**同一个角**（同 r、同平滑度，
   只是转向相反），所以一条轮廓上四个角的曲率完全对称匹配。
   每个角都是「连续曲率圆角」（iOS / Figma 的 squircle 角）：直边 → 三次曲线（端点曲率 0）→ 圆弧
   → 三次曲线 → 直边，沿两边各占 p = (1 + smooth) × r。上一版的问题：凹弧进深 26 却对着远端 15 的
   圆角（大小不配），又把身体顶边压到留白边上（圆圈贴着顶边）；贴边侧还描了一道边（屏幕边上一条亮线）。
   同一个 fill 既当裁剪（clip-path）又是描边的底；描边另走一条**不含贴边侧**的开放路径。 */

/** 一个连续曲率圆角（figma-squircle 的 90° 角算法）：顶点 V，入射方向 u、出射方向 v（单位向量），
 *  从 V − p·u 画到 V + p·v。凸 / 凹由 u×v 的符号自动决定（圆弧 sweep 随之翻转）。 */
function dockCorner(V, u, v, r, sm, n) {
  const rad = (deg) => deg * Math.PI / 180;
  const p = (1 + sm) * r;
  const arcDeg = 90 * (1 - sm);
  const L = Math.sin(rad(arcDeg / 2)) * r * Math.SQRT2;          // 圆弧段沿两边各前进的距离
  const alpha = (90 - arcDeg) / 2;
  const p34 = r * Math.tan(rad(alpha / 2));
  const beta = 45 * sm;
  const c = p34 * Math.cos(rad(beta)), d = c * Math.tan(rad(beta));
  const b = (p - L - c - d) / 3, a = 2 * b;
  const P = (du, dv, o = V) => [o[0] + u[0] * du + v[0] * dv, o[1] + u[1] * du + v[1] * dv];
  const S = P(-p, 0);
  const A0 = P(a + b + c - p, d);                                // 第一段三次曲线终点 = 圆弧起点
  const A1 = P(L, L, A0);                                        // 圆弧终点
  const sweep = u[0] * v[1] - u[1] * v[0] > 0 ? 1 : 0;
  const q = (pt) => `${n(pt[0])} ${n(pt[1])}`;
  return {
    start: S,
    d: ` C ${q(P(a - p, 0))} ${q(P(a + b - p, 0))} ${q(A0)}`
      + ` A ${n(r)} ${n(r)} 0 0 ${sweep} ${q(A1)}`
      + ` C ${q(P(d, c, A1))} ${q(P(d, b + c, A1))} ${q(P(d, a + b + c, A1))}`,
  };
}

/** 贴边列造型：返回 { fill, edge }。fill = 闭合轮廓（clip-path），edge = 去掉贴边侧那条直线的
 *  开放路径（描边用：贴边侧与屏幕边融为一体，不能有线）。
 *  k ∈ [0, 1] 是吸附收口的进度：身体位置不动，贴边侧两处反向圆角的 r 从 0 长到满 —— 材料像液体
 *  一样沿屏幕边「爬」上去形成弯月面（1 = 稳定态）。 */
function dockPathData(w, h, side, s, k = 1) {
  const R = DOCK_CORNER * s, E = DOCK_FLARE * s;                  // E：身体顶 / 底边距窗口上 / 下缘
  const rf = Math.max(0.01, R * k);                              // 反向圆角当前半径
  const n = (v) => Math.round(v * 100) / 100;
  const X = (x) => side === 'left' ? w - x : x;                  // 一律按「贴右」算，贴左水平镜像
  const pt = (x, y) => [X(x), y];
  const dir = (dx, dy) => [side === 'left' ? -dx : dx, dy];
  // 顺着「贴右」时的顺时针：远端上角 → 顶边 → 上喇叭口 → 贴边侧 → 下喇叭口 → 底边 → 远端下角 → 远端边
  const tl = dockCorner(pt(0, E), dir(0, -1), dir(1, 0), R, DOCK_SMOOTH, n);
  const tf = dockCorner(pt(w, E), dir(1, 0), dir(0, -1), rf, DOCK_SMOOTH, n);
  const bf = dockCorner(pt(w, h - E), dir(0, -1), dir(-1, 0), rf, DOCK_SMOOTH, n);
  const bl = dockCorner(pt(0, h - E), dir(-1, 0), dir(0, -1), R, DOCK_SMOOTH, n);
  const q = (p) => `${n(p[0])} ${n(p[1])}`;
  const top = `${tl.d} L ${q(tf.start)}${tf.d}`;                 // 远端上角 + 顶边 + 上喇叭口（止于屏幕边）
  const bottom = `${bf.d} L ${q(bl.start)}${bl.d}`;              // 下喇叭口（起于屏幕边）+ 底边 + 远端下角
  return {
    fill: `M ${q(tl.start)}${top} L ${q(bf.start)}${bottom} Z`,  // 贴边侧直线 + 远端边由 L / Z 补上
    edge: `M ${q(bf.start)}${bottom} L ${q(tl.start)}${top}`,
  };
}

/** 圆圈缩放（config.dockScale）：主进程下发前已按 [0.6, 1.6] 规范化，这里再兜一层，认不出的按 1 */
function dockScaleOf(s) {
  const n = s && s.config ? Number(s.config.dockScale) : NaN;
  return Number.isFinite(n) && n >= 0.6 && n <= 1.6 ? n : 1;
}

/** 把当前实测尺寸 / 贴边侧 / 缩放落到造型上（三者都没变就不重复写 DOM） */
let lastDockShape = '';
let dockVisible = false;   // 上一拍贴边列是否可见（用来判断「刚吸附上」→ 播入场动画）
let dockAnim = 0;          // 入场动画的 rAF 句柄（0 = 不在动画中）
function applyDockShape() {
  if (dockAnim) return;                         // 入场动画进行中：形状归动画循环管
  const el = $('#dock');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;      // 不在贴边视图（display:none）时量不到
  const side = (st && st.config && st.config.dockSide) === 'left' ? 'left' : 'right';
  const s = dockScaleOf(st);
  const w = Math.round(rect.width), h = Math.round(rect.height);
  const key = `${side}:${w}x${h}:${s}`;
  if (key === lastDockShape) return;
  lastDockShape = key;
  commitDockShape(el, dockPathData(w, h, side, s));
}

/** 把一条轮廓落到裁剪与描边上（两者同形） */
function commitDockShape(el, { fill, edge }) {
  el.style.clipPath = `path("${fill}")`;
  const path = el.querySelector('.dock-edge path');
  if (path) { path.setAttribute('d', edge); path.style.d = `path("${edge}")`; }
}

/** 吸附入场动画：反向圆角从 0 长到满 —— 像液滴碰到屏幕边、沿边缘爬出弯月面后稳住。
 *  用 rAF 逐帧重算 k（每帧按当前实测尺寸重新生成路径，缩放/尺寸变化也跟得上）。 */
function dockAnimateIn() {
  const el = $('#dock');
  if (!el) return;
  cancelAnimationFrame(dockAnim);
  const t0 = performance.now(), DUR = 460;
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / DUR);
    const ease = 1 - Math.pow(1 - k, 4);                       // ease-out quart：先「吸」一下，再慢慢铺开稳住
    const rect = el.getBoundingClientRect();
    if (rect.width && rect.height) {
      const side = (st && st.config && st.config.dockSide) === 'left' ? 'left' : 'right';
      const s = dockScaleOf(st);
      commitDockShape(el, dockPathData(Math.round(rect.width), Math.round(rect.height), side, s, ease));
    }
    if (k < 1) { dockAnim = requestAnimationFrame(frame); return; }
    dockAnim = 0;
    lastDockShape = '';                                        // 收尾后重挂缓存（下一次 applyDockShape 对齐到同一形）
    applyDockShape();
  };
  dockAnim = requestAnimationFrame(frame);
}

/* ---------- 贴边列尺寸上报 ----------
   同胶囊：卡片是 max-content，窗口尺寸以实测为准。上下反向圆角的延伸区就在这个盒子里，
   所以量出的高度天然含它。api.dockSize 还没合进来（主进程那侧另一张单）时只记不报。 */
let lastDockSize = '';
function syncDockSize() {
  const el = $('#dock');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const w = Math.ceil(r.width), h = Math.ceil(r.height);
  const sig = w + 'x' + h;
  if (sig === lastDockSize) return;
  lastDockSize = sig;
  window.__dockSize = { w, h };        // 供测试读取（仿照 window.__capSize）
  if (api.dockSize) api.dockSize({ w, h });
}

/* ---------- 飞出卡片（?flyout=1）：贴边悬停圆圈的详情窗 ----------
   这是主进程第二个透明窗口里的渲染层：整窗只画一张卡片 —— 头部一行（logo + 账户名 +
   口径与百分比）+ 目标账户的 pane。pane 用 PANES 工厂**新建独立实例**（与主窗面板那份
   没有关系），样式与面板共用同一套（style.css 里 `#panel …` 的规则都放宽到了 `#flyout …`）。
   宽度与面板一致（326）；实测尺寸（= 卡片 + 2×阴影走廊）上报给主进程摆窗口。 */
const FX_PAD = 12;             // 与主窗的 PAD 同口径：窗口 = 卡片 + 2×12
/** 圆圈口径要用户先填一份预算的家（lib/dock-metric.js 里 budget 只有 DeepSeek 认）。
 *  没填预算时圆圈是灰的 —— 卡片头部得说清去哪儿补，不然只有一个「–」看不懂。 */
const BUDGET_METRIC = new Set(['deepseek']);

let fxTarget = null;           // 最近一次 flyout:target 载荷 { pid, accId, side }；null = 无目标
let fxKey = '';                // 已渲染目标的指纹（pid:accId）；主进程每次悬停都会推，没变就不重画
let fxReady = false;           // 卡片里有内容（没内容时量出来的尺寸不作数）
const fxPanes = new Map();     // pid → 飞出窗自己的 pane 实例（缓存，换回来不必重建）

/** 头部一行：GLM · 主号 · 5h 41%（百分比与圆圈同一份算法，数字同样用未夹的 raw 讲真话） */
function fxTitle(pid, acc, prov) {
  const norm = DOCKM.normalize(pid, acc.dock);
  const p = DOCKM.percentOf(pid, acc.data, acc.dock);
  const list = Object.prototype.hasOwnProperty.call(DOCKM.METRICS, pid) ? DOCKM.METRICS[pid] : null;
  const item = (norm.metric && list) ? list.find((m) => m.key === norm.metric) : null;
  const parts = [prov.tab || pid, acc.name];
  if (p) parts.push(`${item ? item.short : norm.metric} ${Math.round(p.raw)}%`);
  else if (BUDGET_METRIC.has(pid) && !norm.budget) parts.push('未设预算 · 在设置里填');
  else parts.push(item ? `${item.short} –` : '–');
  return parts.join(' · ');
}

/** 卡片里 pane 的上下文：acc 强制指向悬停的那个账户（不是当前激活账户） */
function flyoutCtx(s, pid, accId) {
  const prov = s.providers[pid];
  const acc = prov ? (prov.accounts.find((a) => a.id === accId) || null) : null;
  return paneCtx(s, pid, true, acc);
}

/** 画卡片：头部 + 该账户的 pane。目标没了（账户被删 / 主进程收起）就清空 */
function renderFlyout(force) {
  const head = $('#fxHead');
  const body = $('#fxBody');
  if (!head || !body) return;
  const prov = (st && fxTarget) ? st.providers[fxTarget.pid] : null;
  const acc = prov ? prov.accounts.find((a) => a.id === fxTarget.accId) : null;
  const ui = acc ? window.PANES[fxTarget.pid] : null;
  if (!acc || !ui) {
    // 目标账户没了（被删 / 停用）或这家根本没有界面渲染器：卡片清空，
    // 并把指纹也清掉 —— 同一个目标再推来时（比如账户又启用了）要能重画
    fxKey = '';
    fxReady = false;
    head.hidden = true;
    body.replaceChildren();
    return;
  }
  head.hidden = false;
  head.querySelector('.fx-logo').innerHTML = (LOGOS && LOGOS[fxTarget.pid]) || '';
  $('#fxTitle').textContent = fxTitle(fxTarget.pid, acc, prov);
  let inst = fxPanes.get(fxTarget.pid);
  if (!inst) {
    inst = ui.pane();
    inst.el.classList.add('on');   // 卡片里永远展示当前这一个 pane（.pane 默认 visibility:hidden）
    fxPanes.set(fxTarget.pid, inst);
  }
  if (body.firstElementChild !== inst.el) body.replaceChildren(inst.el);
  const ctx = flyoutCtx(st, fxTarget.pid, fxTarget.accId);
  inst.update(ctx);
  if (inst.tick) inst.tick(ctx);
  fxReady = true;
  syncFlyoutSize(force);
}

/** 卡片实测尺寸上报（含 2×FX_PAD 阴影走廊 = 主进程直接用的窗口尺寸）；
 *  尺寸没变就不重发，目标换了（force）则无条件重发一份 —— 主进程要据此才敢摆位。 */
let lastFxSize = '';
function syncFlyoutSize(force) {
  if (!fxReady || !fxTarget) return;   // 卡片是空的（没目标 / 账户没了）：量出来的尺寸不作数
  const el = $('#flyout');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;    // 没布局完时量不到
  const w = Math.ceil(r.width) + FX_PAD * 2, h = Math.ceil(r.height) + FX_PAD * 2;
  const sig = w + 'x' + h;
  if (!force && sig === lastFxSize) return;
  lastFxSize = sig;
  // 带上「这份量的是谁」：主进程只把与当前目标配对的尺寸拿来摆位（迟到旧目标的不算）
  const payload = { w, h, pid: fxTarget.pid, accId: fxTarget.accId };
  window.__flyoutSize = payload;       // 供测试读取（仿照 window.__dockSize）
  if (api.flyoutSize) api.flyoutSize(payload);
}

/** 主进程推来的目标：{ pid, accId, side } 或 null（收起）。目标没变就不重画 */
function setFlyoutTarget(t) {
  const next = (t && t.pid && t.accId) ? { pid: t.pid, accId: t.accId, side: t.side || null } : null;
  const key = next ? next.pid + ':' + next.accId : '';
  if (key === fxKey) return;
  fxKey = key;
  fxTarget = next;
  renderFlyout(true);   // force：换了目标，尺寸无条件重报一份（主进程据此摆位 / 换位置）
}

/** 卡片里的倒计时 / 配速每秒照走（飞出窗没有主窗那条 tickPanes，自己跑一份） */
function flyoutTick() {
  if (!fxTarget || !st) return;
  const inst = fxPanes.get(fxTarget.pid);
  if (inst && inst.tick) inst.tick(flyoutCtx(st, fxTarget.pid, fxTarget.accId));
}

/** 飞出窗的状态入口：只更新卡片依赖的两样 —— body 的主题类与卡片本身 */
function applyFlyoutState(s) {
  if (!s) return;
  st = s;
  const b = document.body;
  b.className = [
    'view-flyout',
    s.hasAcrylic ? 'acrylic' : '',
    s.theme === 'light' ? 'theme-light' : '',
  ].filter(Boolean).join(' ');
  b.dataset.tier = s.worstTier || 'low';
  renderFlyout();
}

/** 飞出窗的交互：指针进出（主进程据此判断鼠标在路上还是走了）+ 点卡片空白 = 展开完整面板 */
function bindFlyout() {
  const card = $('#flyout');
  card.addEventListener('pointerenter', () => { if (api.flyoutHover) api.flyoutHover(true); });
  card.addEventListener('pointerleave', () => { if (api.flyoutHover) api.flyoutHover(false); });
  card.addEventListener('click', (e) => {
    // 与主窗的点击判定同一套白名单：控件自己处理（点余额、切区间、翻详情），其余都算「点空白」
    if (e.target.closest('button, a, select, textarea, input, label, summary, .clipchip, .ds-bal, .ds-more, .acc-chip')) return;
    if (!st || !fxTarget) return;
    const v = expandTarget();   // 同圆圈的点击行为：该账户失效时直达设置
    api.setTab(fxTarget.pid);
    const prov = st.providers[fxTarget.pid];
    if (prov && prov.activeId !== fxTarget.accId) {
      api.accActivate({ provider: fxTarget.pid, id: fxTarget.accId });
    }
    api.setView(v);             // 主进程收到视图变化会立即收起飞出窗
  });
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
    applyDockShape();
    syncDockSize();
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
    pending.target = e.target;   // 按下的位置：贴边列要按圆圈分派（点圆圈 = 切账户 + 展开）
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
    try { pending.onTap(pending.target); } catch (err) { console.error('GLM_APP tap handler', err); }
  }
}

/** 收起态是哪个视图：配了贴边（dockSide 非空）就回贴边列，否则回胶囊。
 *  面板 / 设置收起时都走它 —— 本地乐观切换与发给主进程的是同一个值。 */
function collapsedView() {
  return (st && st.config && st.config.dockSide) ? 'dock' : 'capsule';
}

/** 胶囊与贴边列保持原始大小：视图缩放（Ctrl+滚轮 / Ctrl+0）在这两个视图下不生效。
 *  （贴边列上那两个手势改的是圆圈大小 dockScale，见 bind() 里的分支 —— 那是「圈多大」，不是缩放。） */
function noZoom() {
  return !st || st.view === 'capsule' || st.view === 'dock';
}

/** 乐观先行切换视图：不等主进程回包，点击瞬间内容就变（主进程广播稍后对齐） */
function setViewLocal(v) {
  document.body.classList.remove('view-capsule', 'view-panel', 'view-settings', 'view-dock');
  document.body.classList.add('view-' + v);
  // 换视图前先把实测尺寸递过去：主进程 setView 时就能按正确的宽/高重排，省掉可见的尺寸跳变
  if (v === 'capsule') syncCapsuleSize();
  if (v === 'panel') syncPanelSize();
  if (v === 'dock') { applyDockShape(); syncDockSize(); }
}

/** 点贴边列上的圆圈：切到那家的页签 + （不是当前账户时）设为当前账户 + 展开面板 */
function tapDockCell(cell) {
  if (!st || !cell || !cell.dataset) return;
  const pid = cell.dataset.pid, id = cell.dataset.accId;
  api.setTab(pid);
  if (st.config) st.config.panelTab = pid;     // 乐观先行：面板一开就是这家
  const prov = st.providers[pid];
  if (prov && prov.activeId !== id) {
    api.accActivate({ provider: pid, id }).then((ns) => { if (ns && ns.providers) applyState(ns); });
  }
  const v = expandTarget();
  setViewLocal(v); api.setView(v);
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
  // 四个视图都可拖动；点击（非控件处）：胶囊=展开，面板/设置=收起，贴边列=点圆圈切账户 / 点空白展开
  makeDraggable($('#capsule'), () => { const v = expandTarget(); setViewLocal(v); api.setView(v); });
  makeDraggable($('#panel'), () => { const v = collapsedView(); setViewLocal(v); api.setView(v); });
  makeDraggable($('#settings'), () => { const v = collapsedView(); setViewLocal(v); api.setView(v); });
  makeDraggable($('#dock'), (t) => {
    const cell = (t && t.closest) ? t.closest('.dc') : null;   // 拖整条列都能拖；点哪个圆圈就开哪个账户
    if (cell) { tapDockCell(cell); return; }
    const v = expandTarget(); setViewLocal(v); api.setView(v);
  });
  // 按下即算「拖拽开始」（拖动与点击共用同一条手势）：先把悬停目标清掉，
  // 详情卡片不跟着窗口跑；真点了圆圈的话，主进程也会因展开面板立即收起它
  $('#dock').addEventListener('pointerdown', () => { if (api.dockHover) api.dockHover(null); });

  $('#capsule').addEventListener('contextmenu', (e) => { e.preventDefault(); api.ctxMenu(); });
  $('#capsule').addEventListener('dblclick', (e) => e.preventDefault());
  $('#dock').addEventListener('contextmenu', (e) => { e.preventDefault(); api.ctxMenu(); });

  $('#refBtn2').addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
  $('#gearBtn').addEventListener('click', (e) => { e.stopPropagation(); setViewLocal('settings'); api.setView('settings'); });
  $('#fixBtn').addEventListener('click', () => { setViewLocal('settings'); api.setView('settings'); });
  $('#retryBtn').addEventListener('click', refresh);
  $('#backBtn').addEventListener('click', () => {
    // 没有账户可展示时回到收起态（配了贴边就回贴边列，否则回胶囊）
    const v = st && providerIds(st).length ? 'panel' : collapsedView();
    setViewLocal(v); api.setView(v);
  });
  $('#saveBtn').addEventListener('click', saveSettings);
  $('#saveBtn2').addEventListener('click', saveSettings);

  bindAutoSave();

  window.addEventListener('keydown', (e) => {
    // Esc 收起：面板 / 设置 → 收起态（贴边配了就回贴边列，否则回胶囊）；已是收起态就不空转
    if (e.key === 'Escape' && st && st.view !== 'capsule' && st.view !== 'dock') {
      const v = collapsedView(); setViewLocal(v); api.setView(v);
    }
    if (e.ctrlKey && (e.key === '0' || e.code === 'Digit0')) {
      if (st && st.view === 'dock') {          // 贴边列上 = 圆圈大小复位（视图缩放在这儿本来就不生效）
        if (dockScaleOf(st) !== 1) { e.preventDefault(); applyDockScale(1); api.save({ dockScale: 1 }); }
        return;
      }
      if (!noZoom()) {
        e.preventDefault();
        if ((st.config.zoom || 1) !== 1) api.setZoom(1);
      }
    }
  });
  // Ctrl+滚轮：展开态等比缩放（胶囊保持原始大小不缩放）；贴边列上改的是圆圈大小（dockScale），
  // 不是视图缩放 —— 面板 / 设置里的缩放手势一字未动
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    if (st && st.view === 'dock') {
      e.preventDefault();
      stepDockScale(e.deltaY < 0 ? 1 : -1);
      return;
    }
    if (noZoom()) return;
    e.preventDefault();
    const cur = st.config.zoom || 1;
    const next = Math.min(1.6, Math.max(0.8, Math.round((cur + (e.deltaY < 0 ? 0.05 : -0.05)) * 20) / 20));
    if (next !== cur) api.setZoom(next);
  }, { passive: false });
  setInterval(tickPanes, 1000);
  window.addEventListener('resize', onWindowResize);
}

/* ---------- 启动 ---------- */
/** 飞出窗的启动：不 bind 主窗那套（胶囊/面板/设置的手势与滚轮缩放都只属于主窗），
 *  只订阅状态与悬停目标、画卡片、每秒走 tick */
async function initFlyout() {
  // 这几个胶水函数改指到卡片：pane 里的交互（点余额、切区间、去设置）不该跑主窗那套渲染
  window.GLMPUI.rerender = () => { if (st) applyFlyoutState(st); };
  window.GLMPUI.setRange = (r) => {
    if (st && st.config) st.config.dsRange = r;
    applyFlyoutState(st);   // 乐观先行：不等主进程回包
    api.save({ dsRange: r });
  };
  window.GLMPUIgo = { settings: () => { api.setView('settings'); } };   // 去设置 = 让主窗展开设置页
  bindFlyout();
  api.onState(applyState);   // 先订阅再取状态，避免漏掉推送（applyState 会路由到卡片）
  applyState(await api.getState());
  if (api.onFlyoutTarget) api.onFlyoutTarget(setFlyoutTarget);
  api.ready();
  setInterval(flyoutTick, 1000);
  console.info('GLM_APP flyout booted');
}

(async function init() {
  if (FLYOUT) return initFlyout();
  bind();
  api.onState(applyState); // 先订阅再取状态，避免漏掉推送
  applyState(await api.getState());
  api.ready();
  console.info('GLM_APP booted · view=' + (st && st.view)
    + ' providers=' + (st ? providerIds(st).join('+') : 'none'));
})();
