'use strict';
/* 渲染层：胶囊/面板/设置 三视图，状态由主进程推送 */
window.addEventListener('error', (e) => console.error('GLM_APP error:', e.message, `${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => console.error('GLM_APP 未处理的拒绝:', e.reason));

if (!window.glm) {
  // preload 桥未注入：显示可见标记并中止（主进程会把这条 console 记进 main.log）
  console.error('GLM_APP NO_GLM: preload 桥未注入，交互全部不可用');
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.querySelector('.hint-empty');
    if (el) { el.style.display = 'flex'; el.innerHTML = '<span class="warn">⚠ 初始化失败 NO_GLM</span>'; }
  });
  throw new Error('GLM_APP aborted: no bridge');
}

const api = window.glm;
const F = window.GLMFMT;
const OVERVIEW_URL = 'https://www.bigmodel.cn/coding-plan/personal/overview';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let st = null;
let tokDirty = false;        // 设置页 token 输入框是否被编辑过
let lastTrayUrl = '';
let refreshing = false;
let shownZoom = 1;
let zoomTipTimer = 0;

/* ---------- 状态渲染 ---------- */
function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function statusClass() {
  if (!st) return '';
  return {
    ok: '', loading: 'st-loading', expired: 'st-expired',
    ratelimit: 'st-ratelimit', error: 'st-error', empty: 'st-empty', boot: 'st-loading',
  }[st.status] || '';
}

function applyState(s) {
  st = s;
  const b = document.body;
  b.className = 'view-' + s.view + ' ' + statusClass() + (s.hasAcrylic ? ' acrylic' : '') + (s.theme === 'light' ? ' theme-light' : '');
  // 组合档位：5h/周各自按 ≥80% mid、≥90% high，任一命中取最高
  b.dataset.tier = (s.data && s.status === 'ok')
    ? F.tierOfPair(s.data.five.percent, s.data.week.percent)
    : (s.status === 'expired' ? 'high' : 'low');

  const d = s.data;
  b.style.setProperty('--p5', d ? d.five.percent : 0);
  b.style.setProperty('--pw', d ? d.week.percent : 0);

  $$('.pv5').forEach((e) => (e.textContent = d ? d.five.percent : '–'));
  $$('.pvw').forEach((e) => (e.textContent = d ? d.week.percent : '–'));
  if (d) {
    $$('.u5').forEach((e) => (e.textContent = F.fmtPoints(d.five.used)));
    $$('.t5').forEach((e) => (e.textContent = F.fmtPoints(d.five.total)));
    $$('.uw').forEach((e) => (e.textContent = F.fmtPoints(d.week.used)));
    $$('.tw').forEach((e) => (e.textContent = F.fmtPoints(d.week.total)));
    $$('.rt5').forEach((e) => (e.textContent = F.fmtResetTime(d.five.nextResetTime)));
    $$('.rtw').forEach((e) => (e.textContent = F.fmtResetTime(d.week.nextResetTime)));
    $$('.lvl').forEach((e) => (e.textContent = F.levelName(d.level)));
  }
  tickCountdowns();

  // 面板头部状态
  const upd = $('#upd');
  const warn = { expired: 1, error: 1, ratelimit: 1 };
  upd.classList.toggle('err', !!warn[s.status]);
  upd.textContent = {
    ok: s.lastFetchAt ? hhmm(s.lastFetchAt) + ' 更新' : '',
    loading: '刷新中…',
    expired: '已过期',
    ratelimit: '限流退避中',
    error: '⚠ 更新失败',
    empty: '未配置',
    boot: '…',
  }[s.status] || '';
  $('#errMsg').textContent = s.msg || '更新失败';

  refreshing = s.status === 'loading';
  $('#refBtn').classList.toggle('spin', refreshing);
  $('#refBtn2').classList.toggle('spin', refreshing);

  fillSettings();
  drawTray();

  // 缩放提示：zoom 值变化时短暂显示百分比
  const z = s.config.zoom || 1;
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

/* ---------- 倒计时 + 预期进度（每秒本地计算，不打扰网络） ---------- */
function pacePercent(w) {
  const total = w.nextResetTime - w.windowStart;
  if (!(total > 0)) return null;
  return Math.max(1, Math.min(99, ((Date.now() - w.windowStart) / total) * 100));
}

function updatePace() {
  if (!st || !st.data) return;
  const p5 = pacePercent(st.data.five);
  const pw = pacePercent(st.data.week);
  document.body.style.setProperty('--pace5', p5 == null ? 0 : p5.toFixed(2));
  document.body.style.setProperty('--paceW', pw == null ? 0 : pw.toFixed(2));
  $$('#panel .pbar').forEach((bar) => {
    const tip = bar.querySelector('.ptip');
    if (!tip) return;
    const isFive = !!bar.querySelector('.g5');
    const pace = isFive ? p5 : pw;
    const pct = isFive ? st.data.five.percent : st.data.week.percent;
    if (pace == null) { tip.classList.remove('show'); return; }
    tip.innerHTML = `预期 ≈ ${Math.round(pace)}% · 实际 ${pct}%` +
      '<small>幽灵段 = 按时间均摊，此刻应已用的量</small>';
    // 用气泡实际宽度钳制：translateX(-50%) 居中时完整留在 bar 内，左右都不出窗
    const half = tip.offsetWidth / 2 + 2;
    const pos = (pace / 100) * bar.clientWidth;
    const left = Math.max(half, Math.min(bar.clientWidth - half, pos));
    tip.style.left = left + 'px';
  });
}

function tickCountdowns() {
  if (!st || !st.data) return;
  const now = Date.now();
  $$('.cd5').forEach((e) => (e.textContent = F.fmtCountdown(st.data.five.nextResetTime - now)));
  $$('.cdw').forEach((e) => (e.textContent = F.fmtCountdown(st.data.week.nextResetTime - now)));
  updatePace();
}

/* ---------- 设置页 ---------- */
function fillSettings() {
  if (!st) return;
  const editing = document.activeElement && $('#settings').contains(document.activeElement);
  if (editing) return; // 用户正在填，别覆盖

  const c = st.config;
  if (!tokDirty) {
    const tok = $('#tok');
    tok.value = '';
    tok.placeholder = c.hasToken
      ? `已保存 ·…${c.token.slice(-10)}（粘贴新值可替换）`
      : '粘贴浏览器里的整段 Cookie，或只粘贴 bigmodel_token_production 的值';
  }
  $('#interval').value = String(c.intervalMin);
  $('#threshold').value = String(c.notifyThreshold);
  $('#theme').value = c.theme || 'auto';
  $('#autostart').checked = !!c.autoStart && !c.isPortable;
  $('#autostart').disabled = !!c.isPortable;
  $('#autostart').parentElement.title = c.isPortable ? '便携版不支持开机自启，请使用安装版' : '';
  $('#ontop').checked = !!c.alwaysOnTop;
  $('#nreset').checked = !!c.notifyReset;

  const el = $('#tstat'), tx = $('#tstatTxt');
  el.className = 'tstat ' + ({ ok: 'ok', expired: 'bad', empty: 'na' }[st.status] || 'na');
  tx.textContent = {
    ok: st.lastFetchAt ? `✓ Token 有效 · ${hhmm(st.lastFetchAt)} 验证通过` : '✓ Token 有效',
    expired: '⚠ Token 已失效，粘贴新值后保存',
    empty: '未配置',
  }[st.status] || '待验证…';
}

async function peekClipboard() {
  try {
    const jwt = await api.clipboardPeek();
    if (jwt && (!st || !st.config.token || jwt !== st.config.token)) {
      $('#clipchip').classList.add('show');
      $('#clipchip').onclick = () => {
        $('#tok').value = jwt;
        tokDirty = true;
        $('#clipchip').classList.remove('show');
        $('#tok').focus();
      };
      return;
    }
  } catch { }
  $('#clipchip').classList.remove('show');
}

async function saveSettings() {
  const patch = {
    intervalMin: parseInt($('#interval').value, 10),
    notifyThreshold: parseInt($('#threshold').value, 10),
    notifyReset: $('#nreset').checked,
    autoStart: $('#autostart').checked,
    alwaysOnTop: $('#ontop').checked,
    theme: $('#theme').value,
  };
  if (tokDirty) patch.token = $('#tok').value.trim();
  await api.save(patch);
  tokDirty = false;
  if (st && st.data) api.setView('panel');
}

/* ---------- 托盘动态图标（32px 画布 → dataURL → 主进程） ---------- */
function drawTray() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#14161f';
  // 圆角底
  g.beginPath();
  g.roundRect ? g.roundRect(1, 1, 30, 30, 8) : g.rect(1, 1, 30, 30);
  g.fill();
  const expired = st && st.status === 'expired';
  const tier = (st && st.data && st.status === 'ok')
    ? F.tierOfPair(st.data.five.percent, st.data.week.percent)
    : expired ? 'high' : 'low';
  const color = { low: '#22d3ee', mid: '#fbbf24', high: '#f87171' }[tier];
  const p = expired ? 100 : (st && st.data ? st.data.five.percent : 0);
  g.strokeStyle = 'rgba(255,255,255,.12)';
  g.lineWidth = 4.5;
  g.beginPath(); g.arc(16, 16, 10.5, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.beginPath(); g.arc(16, 16, 10.5, -Math.PI / 2, -Math.PI / 2 + (Math.max(2, p) / 100) * Math.PI * 2);
  g.stroke();
  const url = c.toDataURL('image/png');
  if (url !== lastTrayUrl) { lastTrayUrl = url; api.trayIcon(url); }
}

/* ---------- 交互 ---------- */
function refresh() {
  if (refreshing) return;
  api.refreshNow();
}

/* 统一手势：按住拖动 = 移动窗口（带指针捕获 + rAF 合帧），原地松开 = onTap */
let drag = null;
const pending = { dx: 0, dy: 0, raf: 0 };
function makeDraggable(el, onTap) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, a, select, textarea, input, label, .clipchip')) return;
    drag = { onTap, sx: e.screenX, sy: e.screenY, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch { }
    e.preventDefault();
  });
}
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) {
    drag.sx = e.screenX; drag.sy = e.screenY;
    // rAF 合帧：高回报率鼠标（125–500Hz）也只按刷新率发 IPC，消除消息风暴
    pending.dx += dx; pending.dy += dy;
    if (!pending.raf) {
      pending.raf = requestAnimationFrame(() => {
        pending.raf = 0;
        api.dragBy(pending.dx, pending.dy);
        pending.dx = pending.dy = 0;
      });
    }
  }
});
window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.moved) {
    if (pending.raf) { // 把最后一帧补齐再收尾
      cancelAnimationFrame(pending.raf);
      pending.raf = 0;
      api.dragBy(pending.dx, pending.dy);
      pending.dx = pending.dy = 0;
    }
    api.dragEnd();
    return;
  }
  if (d.onTap) d.onTap();
});

function expandTarget() {
  return st && (st.status === 'expired' || st.status === 'empty') ? 'settings' : 'panel';
}

/* 乐观先行切换视图：不等主进程回包，点击瞬间内容就变（主进程广播稍后对齐） */
function setViewLocal(v) {
  document.body.classList.remove('view-capsule', 'view-panel', 'view-settings');
  document.body.classList.add('view-' + v);
}

function bind() {
  // 三个视图都可拖动；点击（非控件处）：胶囊=展开，面板/设置=收起
  makeDraggable($('#capsule'), () => { setViewLocal(expandTarget()); api.setView(expandTarget()); });
  makeDraggable($('#panel'), () => { setViewLocal('capsule'); api.setView('capsule'); });
  makeDraggable($('#settings'), () => { setViewLocal('capsule'); api.setView('capsule'); });

  $('#capsule').addEventListener('contextmenu', (e) => { e.preventDefault(); api.ctxMenu(); });
  $('#capsule').addEventListener('dblclick', (e) => e.preventDefault());

  $('#refBtn').addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
  $('#refBtn2').addEventListener('click', refresh);
  $('#gearBtn').addEventListener('click', () => { setViewLocal('settings'); api.setView('settings'); });
  $('#fixBtn').addEventListener('click', () => { setViewLocal('settings'); api.setView('settings'); });
  $('#retryBtn').addEventListener('click', refresh);
  $('#backBtn').addEventListener('click', () => {
    const v = st && st.data ? 'panel' : 'capsule';
    setViewLocal(v); api.setView(v);
  });
  $('#webBtn').addEventListener('click', () => api.openExternal(OVERVIEW_URL));
  $('#saveBtn').addEventListener('click', saveSettings);
  $('#clrBtn').addEventListener('click', async () => {
    await api.save({ token: '' });
    tokDirty = false;
    $('#tok').value = '';
  });
  $('#tok').addEventListener('input', () => { tokDirty = true; $('#clipchip').classList.remove('show'); });

  // 悬停进度条 → 显示预期解释（绑在整根 bar 上：用量条盖住幽灵时幽灵收不到事件）
  $$('#panel .pbar').forEach((bar) => {
    const tip = bar.querySelector('.ptip');
    if (!tip) return;
    bar.addEventListener('pointerenter', () => tip.classList.add('show'));
    bar.addEventListener('pointerleave', () => tip.classList.remove('show'));
  });

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
  setInterval(tickCountdowns, 1000);
}

/* ---------- 启动 ---------- */
(async function init() {
  bind();
  api.onState(applyState); // 先订阅再取状态，避免漏掉推送
  applyState(await api.getState());
  api.ready();
  console.info('GLM_APP booted · view=' + (st && st.view) + ' status=' + (st && st.status) + ' data=' + !!(st && st.data));
})();
