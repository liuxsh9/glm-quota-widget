'use strict';
/* 渲染层：胶囊（双列）/ 面板（GLM·DeepSeek 两页签）/ 设置 三视图，状态由主进程推送 */
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
const OVERVIEW_URL = 'https://www.bigmodel.cn/coding-plan/personal/overview';
const DS_URL = 'https://platform.deepseek.com/usage';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let st = null;
let tokDirty = false;        // 设置页三个凭据输入框是否被编辑过
let dsTokDirty = false;
let dsPlatDirty = false;
let lastTrayUrl = '';
let refreshing = false;
let shownZoom = 1;
let zoomTipTimer = 0;
let chartSig = '';           // 柱状图的「数据指纹」：没变就不重建 DOM

/* ---------- 小工具 ---------- */
function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
/** 货币符号：CNY→¥、USD→$、其余原样前缀 */
function symOf(currency) {
  return currency === 'USD' ? '$' : currency === 'CNY' || !currency ? '¥' : currency + ' ';
}
const money = (v, currency) => symOf(currency) + F.fmtMoney(v);
const glmOf = () => (st && st.providers && st.providers.glm) || { status: 'boot', data: null };
const dsOf = () => (st && st.providers && st.providers.ds) || { status: 'empty', balance: null, summary: null };

/* ---------- 状态渲染 ---------- */
function statusClass() {
  if (!st) return '';
  return {
    ok: 'st-ok', loading: 'st-loading', expired: 'st-expired',
    ratelimit: 'st-ratelimit', error: 'st-error', empty: 'st-empty', boot: 'st-loading',
  }[glmOf().status] || '';
}

function applyState(s) {
  st = s;
  const g = glmOf(), d = dsOf();
  const c = s.config || {};
  const b = document.body;
  const active = c.panelTab === 'ds' ? d : g;
  b.className = [
    'view-' + s.view,
    statusClass(),
    'tab-' + (c.panelTab === 'ds' ? 'ds' : 'glm'),
    c.hasToken ? 'has-glm' : '',
    c.dsHasToken ? 'has-ds' : '',
    (!c.hasToken && !c.dsHasToken) ? 'no-providers' : '',
    s.hasAcrylic ? 'acrylic' : '',
    s.theme === 'light' ? 'theme-light' : '',
    active.status === 'expired' ? 'bn-expired'
      : (active.status === 'error' || active.status === 'ratelimit') ? 'bn-retry' : 'bn-none',
  ].filter(Boolean).join(' ');

  // 档位（颜色）：阈值与通知同源；过期时按高档显示红色
  const w = c.warnThreshold;
  b.dataset.tier = (g.data && g.status === 'ok')
    ? F.tierOfPair(g.data.five.percent, g.data.week.percent, w)
    : (g.status === 'expired' ? 'high' : 'low');

  const gd = g.data;
  b.style.setProperty('--p5', gd ? gd.five.percent : 0);
  b.style.setProperty('--pw', gd ? gd.week.percent : 0);

  $$('.pv5').forEach((e) => (e.textContent = gd ? gd.five.percent : '–'));
  $$('.pvw').forEach((e) => (e.textContent = gd ? gd.week.percent : '–'));
  if (gd) {
    $$('.u5').forEach((e) => (e.textContent = F.fmtPoints(gd.five.used)));
    $$('.t5').forEach((e) => (e.textContent = F.fmtPoints(gd.five.total)));
    $$('.uw').forEach((e) => (e.textContent = F.fmtPoints(gd.week.used)));
    $$('.tw').forEach((e) => (e.textContent = F.fmtPoints(gd.week.total)));
    $$('.rt5').forEach((e) => (e.textContent = F.fmtResetTime(gd.five.nextResetTime)));
    $$('.rtw').forEach((e) => (e.textContent = F.fmtResetTime(gd.week.nextResetTime)));
    $$('.lvl').forEach((e) => (e.textContent = gd.level ? F.levelName(gd.level) : ''));
  } else {
    $$('.lvl').forEach((e) => (e.textContent = ''));   // 没数据时页签只留「GLM」，别挂个孤零零的 –
  }
  const isDs = c.panelTab === 'ds';
  $('#tabGlm').classList.toggle('on', !isDs);
  $('#tabDs').classList.toggle('on', isDs);

  renderCapsuleDs();
  renderDsPanel();
  tickCountdowns();

  // 面板头部：时间/状态跟随当前页签
  const upd = $('#upd');
  const warn = { expired: 1, error: 1, ratelimit: 1 };
  upd.classList.toggle('err', !!warn[active.status]);
  upd.textContent = {
    ok: active.lastFetchAt ? hhmm(active.lastFetchAt) + ' 更新' : '',
    loading: '刷新中…',
    expired: '已过期',
    ratelimit: '限流退避中',
    error: '⚠ 更新失败',
    empty: '未配置',
    boot: '…',
  }[active.status] || '';
  $('#errMsg').textContent = (active.msg || '更新失败') + (c.panelTab === 'ds' ? '（DeepSeek）' : '');

  refreshing = active.status === 'loading';
  $('#refBtn2').classList.toggle('spin', refreshing);

  fillSettings();
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

/* ---------- 胶囊右列：DeepSeek 余额 + 今日消费 ---------- */
function renderCapsuleDs() {
  const d = dsOf();
  const col = $('#capsule .cap-ds');
  if (!col) return;
  const bal = d.balance;
  const today = d.summary ? d.summary.today : null;
  const cur = bal ? bal.currency : 'CNY';

  $$('#capsule .dsbal').forEach((e) => (e.textContent = bal ? money(bal.total, cur) : '–'));
  $$('#capsule .dstoday').forEach((e) => {
    if (d.status === 'expired') e.textContent = 'Key 已失效';
    else if (d.status === 'error') e.textContent = '更新失败';
    else if (today != null && today > 0) e.textContent = '今日 ' + F.fmtMoney(today);
    else e.textContent = today != null ? '今日 0.00' : '今日 –';
  });
  col.classList.toggle('warn', d.status === 'expired' || d.status === 'error');
  // 有旧值但当前拉取失败：压暗表示「不是最新的」
  col.classList.toggle('dim', !!bal && d.status !== 'ok');
}

/* ---------- 面板 DeepSeek 视图 ----------
   只有**主余额**默认打码（那是最扎眼的一行）；今日/近 7 天/本月这些照常显示。
   打码状态只在内存里，重启回到打码态。 */
let dsReveal = false;

function renderDsPanel() {
  const d = dsOf();
  const s = d.summary;
  const bal = d.balance;
  const cur = bal ? bal.currency : 'CNY';
  const mon = (v) => (v == null ? '–' : money(v, cur));

  document.body.classList.toggle('ds-masked', !dsReveal);
  const balEl = $('#panel .dstotal');
  if (balEl) balEl.textContent = bal ? (dsReveal ? F.fmtMoney(bal.total) : '••••') : '–';
  const curEl = $('#panel .ds-bal .cur');
  if (curEl) curEl.textContent = symOf(cur);

  // 账户状态与余额同行（省一行高度，两个页签才能等高）
  const sub = $('#dsSub');
  if (sub) {
    if (d.status === 'expired') sub.innerHTML = '<span class="warn">⚠ Key 已失效</span>';
    else if (d.status === 'error') sub.innerHTML = '<span class="warn">⚠ 更新失败</span>';
    else if (d.status === 'ratelimit') sub.innerHTML = '<span class="warn">⚠ 限流退避中</span>';
    else if (bal) sub.textContent = bal.available ? (bal.granted > 0 ? `含赠送 ${money(bal.granted, cur)}` : '全部为充值余额') : '⚠ 余额不足';
    else sub.textContent = '';
  }

  $$('#panel .ds-today').forEach((e) => (e.textContent = s ? mon(s.today) : '–'));
  $$('#panel .ds-wk').forEach((e) => (e.textContent = s ? mon(s.last7) : '–'));
  $$('#panel .ds-mo').forEach((e) => (e.textContent = s ? mon(s.month) : '–'));

  const range = (st && st.config && st.config.dsRange) || '7d';
  $('#dsR1').classList.toggle('on', range === '1h');
  $('#dsR24').classList.toggle('on', range === '24h');
  $('#dsR7').classList.toggle('on', range === '7d');
  $('#dsR30').classList.toggle('on', range === '30d');
  $('#dsRange').textContent = rangeLabel(range, s, mon);

  renderChart(range, cur);

  const left = $('#dsLeft');
  if (left) {
    if (!s) left.textContent = '–';
    else {
      // 1 小时档的标题已经写了「近 1 小时合计」，脚注就换成更细的滚动窗口，别重复
      const recent = range === '1h' ? `最近 5 分钟 ${mon(s.last5m)}` : `近 1 小时 ${mon(s.last1h)}`;
      left.textContent = `${recent} · 日均 ${mon(s.avg7)}`;
    }
  }
  const right = $('#dsRight');
  if (right) right.textContent = (s && s.daysLeft != null) ? `可用 ${s.daysLeft} 天` : '';

  renderDsDetail(d, mon);
}

/** 区间标题顺带给出该区间的合计，省得再挤一行 */
function rangeLabel(range, s, mon) {
  if (!s) return '近 7 天消费';
  if (range === '1h') return `近 1 小时 ${mon(s.last1h)}`;
  if (range === '24h') {
    const sum = (s.hourly || []).reduce((a, h) => a + h.spend, 0);
    return `近 24 小时 ${mon(sum)}`;
  }
  if (range === '30d') return `近 30 天 ${mon(s.last30)}`;
  return `近 7 天 ${mon(s.last7)}`;
}

/** 「?」浮层：数据来源、口径、token 明细。绝对定位，不参与布局（面板高度恒定） */
function renderDsDetail(d, mon) {
  const el = $('#dsSrc');
  if (!el) return;
  const s = d.summary;
  const lines = [];
  const link = (txt, url) => `<a href="#" data-url="${url}">${txt}</a>`;

  // 浮层可用高度只有 ~90px：每行控制在 25 个汉字内，总行数不超过 4 行
  if (!st.config.dsHasToken) {
    lines.push('未配置 API Key · <a href="#" data-view="settings">去配置 ›</a>');
  } else if (s && s.source === 'platform') {
    lines.push('来源：<b>平台账单</b> · UTC 日界');
    const t = d.tokens && d.tokens.total;
    if (t && t.total > 0) {
      const hit = t.promptTokens > 0 ? Math.round((t.cacheHit / t.promptTokens) * 100) : 0;
      lines.push(`本月 ${F.fmtTokens(t.total)} tok · 缓存命中 ${hit}%`);
      lines.push('图表格：1 小时按 5 分钟 · 24 小时按小时 · 7/30 天按天');
    }
    if (s.byModel && s.byModel.length) lines.push(`按模型：${fmtTopModels(s, mon)}`);
  } else {
    const since = s && s.firstSampleAt ? new Date(s.firstSampleAt) : null;
    const when = since ? `${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')} ${hhmm(since)}` : '';
    lines.push(`来源：<b>本地余额差值</b> · 自 ${when || '本次启动'}`);
    lines.push(`余额每 ${st.config.dsPollMin || 2} 分钟一采，实时读数靠它`);
    lines.push('图表格：1 小时按 5 分钟 · 24 小时按小时 · 7/30 天按天');
  }
  if (d.platform && d.platform.status === 'expired') {
    lines.push('<span class="warn">平台会话过期</span> · 重取 userToken 可恢复');
  } else if (d.platform && (d.platform.status === 'error' || d.platform.status === 'ratelimit')) {
    lines.push('<span class="warn">平台接口异常</span> · 已退回本地差值');
  }
  lines.push(`时段：${F.isPeak('ds', Date.now()) ? '<b>高峰</b>' : '<b>空闲（半价）</b>'} · ${F.PERIOD_NOTE.ds}`);
  lines.push(link('打开用量页 ›', DS_URL));
  // 注意别用 class="row"：#panel .row 是 GLM 那两块的 flex 布局，会把说明排成两列
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  el.querySelectorAll('a').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      if (a.dataset.view === 'settings') { setViewLocal('settings'); api.setView('settings'); }
      else if (a.dataset.url) api.openExternal(a.dataset.url);
    };
  });
}

/** 本地口径下没有按模型的拆分（那是平台账单才有的字段） */
const modelsNeeded = () => false;

function fmtTopModels(s, fmt) {
  const list = (s.byModel || []).slice().sort((a, b) => b.cost - a.cost).slice(0, 3);
  if (!list.length) return '—';
  return list.map((m) => `${m.model} ${fmt(m.cost)}`).join(' · ');
}

function renderChart(range, cur) {
  const host = $('#dsChart');
  if (!host) return;
  const s = dsOf().summary;
  // 越近的区间柱子越细：1 小时 → 5 分钟一根，24 小时 → 1 小时一根，7/30 天 → 一天一根
  const byTime = range === '1h' || range === '24h';
  const series = range === '1h' ? ((s && s.fine) || [])
    : range === '24h' ? ((s && s.hourly) || [])
      : ((s && s.series) || []).slice(-(range === '30d' ? 30 : 7));
  const sig = range + '|' + series.map((x) => (byTime ? (x.ts + ':' + x.spend.toFixed(2)) : (x.date + ':' + x.spend.toFixed(2)))).join(',');
  if (sig === chartSig) return;      // 每秒重算时会走到这里，避免白重建 DOM
  chartSig = sig;
  host.querySelectorAll('i').forEach((b) => b.remove());   // 只清柱子：气泡是常驻的兄弟节点，别一起清掉
  if (!series.length) return;
  const max = Math.max.apply(null, series.map((x) => x.spend).concat([0.01]));
  for (const pt of series) {
    const bar = document.createElement('i');
    // 有消费的最矮也给 3%，不然「有但很少」和「没有」看起来一样
    bar.style.height = (pt.spend > 0 ? Math.max(3, Math.round((pt.spend / max) * 100)) : 2) + '%';
    if (pt.spend <= 0) bar.className = 'zero';
    if (pt.partial) bar.classList.add('partial');
    bar.dataset.tip = byTime
      ? `<b>${bucketRange(pt.ts, range)}</b> · ${money(pt.spend, cur)}${pt.partial ? ' <i>· 进行中</i>' : ''}`
      : `<b>${pt.date}</b> · ${money(pt.spend, cur)}`;
    host.appendChild(bar);
  }
}

/** 柱子覆盖的时间区间（5 分钟柱给 10:35–10:40，小时柱给 10:00–11:00） */
function bucketRange(ts, range) {
  const H = 3600e3;
  const p = (x) => String(x).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
  if (range === '1h') return `${hm(ts)}–${hm(ts + 5 * 60000)}`;
  if (range === '24h') return `${hm(ts)}–${hm(ts + H)}`;
  return hm(ts);
}

/** 时间轴标签：跨天时带上月-日，同一天只给时:分 */
function timeLabel(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/* ---------- 倒计时 + 预期进度 + 超预期（每秒本地计算，不打扰网络） ---------- */
function pacePercent(w) {
  if (!w) return null;
  const total = w.nextResetTime - w.windowStart;
  if (!(total > 0)) return null;
  return Math.max(1, Math.min(99, ((Date.now() - w.windowStart) / total) * 100));
}

/** 实际超出预期的幅度（百分点）；没开开关或没有窗口数据时返回 0 */
function overOf(win, pace) {
  if (!st || !st.config.paceAlert || !win || pace == null) return 0;
  const over = win.percent - pace;
  return over > 0.5 ? over : 0;   // 0.5 个百分点以内算噪声：刚开窗就报警会很吵
}

function updatePace() {
  if (!st) return;
  const g = glmOf();
  const d = g.data;
  const on = !!d && g.status === 'ok';
  const p5 = on ? pacePercent(d.five) : null;
  const pw = on ? pacePercent(d.week) : null;
  const body = document.body;
  body.style.setProperty('--pace5', p5 == null ? 0 : p5.toFixed(2));
  body.style.setProperty('--paceW', pw == null ? 0 : pw.toFixed(2));

  const o5 = on ? overOf(d.five, p5) : 0;
  const oW = on ? overOf(d.week, pw) : 0;
  body.style.setProperty('--over5', o5.toFixed(2));
  body.style.setProperty('--overW', oW.toFixed(2));
  body.dataset.pace = (o5 || oW) ? 'over' : 'ok';

  // 「▲ 超预期」标签只挂在真正超支的那个窗口上
  const blk5 = $('#panel .blk-q[data-win="five"]');
  const blkW = $('#panel .blk-q[data-win="week"]');
  if (blk5) blk5.classList.toggle('over', o5 > 0);
  if (blkW) blkW.classList.toggle('over', oW > 0);

  $$('#panel .pbar').forEach((bar) => {
    const tip = bar.querySelector('.ptip');
    if (!tip) return;
    const isFive = !!bar.querySelector('.g5');
    const pace = isFive ? p5 : pw;
    const over = isFive ? o5 : oW;
    const pct = isFive ? d.five.percent : d.week.percent;
    if (pace == null) { tip.classList.remove('show'); return; }
    const line = over > 0
      ? `<span class="warn">超出预期 ${over.toFixed(1)} 个百分点</span>`
      : '节奏正常';
    tip.innerHTML = `预期 ≈ ${Math.round(pace)}% · 实际 ${pct}% · ${line}` +
      '<small>幽灵段 = 按时间均摊，此刻应已用的量</small>' +
      (over > 0 ? '<small>红色段 = 实际超出预期的那部分</small>' : '');
    // 用气泡实际宽度钳制：translateX(-50%) 居中时完整留在 bar 内，左右都不出窗
    const half = tip.offsetWidth / 2 + 2;
    const pos = (pace / 100) * bar.clientWidth;
    const left = Math.max(half, Math.min(bar.clientWidth - half, pos));
    tip.style.left = left + 'px';
  });
}

let shownPeriod = { glm: '', ds: '' };
function updatePeriodChips() {
  if (!st) return;
  for (const prov of ['glm', 'ds']) {
    const peak = F.isPeak(prov, Date.now());
    const key = peak ? 'peak' : 'off';
    if (shownPeriod[prov] === key) continue;      // 每秒都会走到这，状态没变就别动 DOM
    shownPeriod[prov] = key;
    const chip = $(prov === 'glm' ? '#glmChip' : '#dsChip');
    if (!chip) continue;
    chip.className = 'chip ' + key;
    chip.title = F.PERIOD_NOTE[prov] + (peak ? '\n当前：高峰时段' : '\n当前：空闲时段');
    const txt = chip.querySelector('.ctxt');
    if (txt) txt.textContent = peak ? '高峰时段' : (prov === 'ds' ? '空闲 · 半价' : '空闲时段');
  }
}

function tickCountdowns() {
  if (!st) return;
  updatePeriodChips();
  const d = glmOf().data;
  if (!d) return;
  const now = Date.now();
  $$('.cd5').forEach((e) => (e.textContent = F.fmtCountdown((d.five.nextResetTime ?? NaN) - now)));
  $$('.cdw').forEach((e) => (e.textContent = F.fmtCountdown((d.week.nextResetTime ?? NaN) - now)));
  updatePace();
}

/* ---------- 设置页 ---------- */
/** 高频采样关掉时，下面那行间隔置灰不可点（避免「设了 2 分钟却没生效」的困惑） */
function setFastRow(on) {
  const sel = $('#dspoll');
  if (sel) sel.disabled = !on;
  const row = $('#dsfastrow');
  if (row) row.classList.toggle('off', !on);
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

/** 勾选 / 下拉类：change 即落盘，不用等「保存并刷新」（凭据输入框仍然要显式保存） */
async function autoSave(patch, after) {
  const next = await api.save(patch);
  if (after) after();
  if (next) applyState(next);
  flashSaved();
}

function bindAutoSave() {
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('change', fn); };
  on('#pacealert', () => autoSave({ paceAlert: $('#pacealert').checked }));
  on('#nreset', () => autoSave({ notifyReset: $('#nreset').checked }));
  on('#autostart', () => autoSave({ autoStart: $('#autostart').checked }));
  on('#ontop', () => autoSave({ alwaysOnTop: $('#ontop').checked }));
  on('#theme', () => autoSave({ theme: $('#theme').value }));
  on('#interval', () => autoSave({ intervalMin: parseInt($('#interval').value, 10) }));
  const poll = () => autoSave({ dsPollMin: $('#dsfast').checked ? parseInt($('#dspoll').value, 10) : 0 });
  // 勾选框既要落盘，也要立刻把下面那行间隔置灰/解灰
  on('#dsfast', () => { setFastRow($('#dsfast').checked); poll(); });
  on('#dspoll', poll);
}

function setStat(boxSel, txtSel, cls, text) {
  const box = $(boxSel), txt = $(txtSel);
  if (!box || !txt) return;
  box.className = 'tstat ' + cls;
  txt.textContent = text;
}

function fillSettings() {
  if (!st) return;
  const editing = document.activeElement && $('#settings').contains(document.activeElement);
  if (editing) return; // 用户正在填，别覆盖

  const c = st.config;
  if (!tokDirty) {
    $('#tok').value = '';
    $('#tok').placeholder = c.hasToken
      ? `已保存 ·…${c.tokenTail}（粘贴新值可替换）`
      : '粘贴 API Key（推荐，长期有效），或整段 Cookie / bigmodel_token_production 的值';
  }
  if (!dsTokDirty) {
    $('#dstok').value = '';
    $('#dstok').placeholder = c.dsHasToken
      ? `已保存 ·…${c.dsTokenTail}（粘贴新值可替换）`
      : '粘贴 sk- 开头的 API Key，形如 sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  }
  if (!dsPlatDirty) {
    $('#dsplat').value = '';
    $('#dsplat').placeholder = c.dsHasPlatform
      ? `已保存 ·…${c.dsPlatformTail}（粘贴新值可替换）`
      : '粘贴 platform.deepseek.com 的 userToken（整段 JSON 或裸 token 都可以）';
  }
  $('#interval').value = String(c.intervalMin);
  const poll = Number(c.dsPollMin) || 0;
  $('#dsfast').checked = poll > 0;
  $('#dspoll').value = String(poll > 0 ? poll : 2);
  setFastRow(poll > 0);
  $('#threshold').value = String(c.warnThreshold);
  $('#pacealert').checked = !!c.paceAlert;
  $('#theme').value = c.theme || 'auto';
  $('#autostart').checked = !!c.autoStart && !c.isPortable;
  $('#autostart').disabled = !!c.isPortable;
  $('#autostart').parentElement.title = c.isPortable ? '便携版不支持开机自启，请使用安装版' : '';
  $('#ontop').checked = !!c.alwaysOnTop;
  $('#nreset').checked = !!c.notifyReset;

  const g = glmOf(), d = dsOf();
  setStat('#tstat', '#tstatTxt', { ok: 'ok', expired: 'bad', empty: 'na' }[g.status] || 'na', {
    ok: g.lastFetchAt ? `✓ Token 有效 · ${hhmm(g.lastFetchAt)} 验证通过` : '✓ Token 有效',
    expired: '⚠ Token 已失效，粘贴新值后保存',
    empty: '未配置',
  }[g.status] || '待验证…');

  setStat('#dststat', '#dststatTxt', { ok: 'ok', expired: 'bad', empty: 'na' }[d.status] || 'na', {
    ok: d.balance ? `✓ 余额 ${money(d.balance.total, d.balance.currency)}${d.balance.available ? '' : ' · 余额不足'}` : '✓ API Key 有效',
    expired: '⚠ API Key 已失效或已撤销，粘贴新值后保存',
    ratelimit: '⚠ 触发限流，稍后自动重试',
    error: '⚠ 更新失败，稍后自动重试',
    empty: '未配置',
  }[d.status] || '待验证…');

  const ps = d.platform ? d.platform.status : 'empty';
  setStat('#dspstat', '#dspstatTxt', { ok: 'ok', expired: 'bad', empty: 'na' }[ps] || 'bad', {
    ok: '✓ 会话有效 · 精确账单与逐模型用量已启用',
    expired: '⚠ 平台会话已过期，重新获取 userToken 后粘贴保存',
    ratelimit: '⚠ 平台接口限流，稍后自动重试',
    error: '⚠ 平台接口异常，已退回本地余额差值',
    empty: '未配置 · 消费数字走本地余额差值推算',
  }[ps] || '待验证…');
}

/** 剪贴板里如果有某种凭据，给对应的输入框一个「一键填入」提示 */
async function peekClipboard() {
  let r = null;
  try { r = await api.clipboardPeek(); } catch { /* 读剪贴板失败：静默 */ }
  const c = st ? st.config : {};
  const bind = (chipSel, inputSel, val, dirtySetter, differs) => {
    const chip = $(chipSel);
    if (!chip) return;
    if (val && differs) {
      chip.classList.add('show');
      chip.onclick = () => {
        $(inputSel).value = val;
        dirtySetter();
        chip.classList.remove('show');
        $(inputSel).focus();
      };
    } else chip.classList.remove('show');
  };
  const obj = r && typeof r === 'object' ? r : { glm: typeof r === 'string' ? r : '' };
  bind('#clipchip', '#tok', obj.glm, () => { tokDirty = true; }, obj.glm && obj.glm !== c.tokenTail);
  bind('#clipchipDs', '#dstok', obj.ds, () => { dsTokDirty = true; }, obj.ds && obj.ds !== c.dsTokenTail);
}

async function saveSettings() {
  const patch = {
    intervalMin: parseInt($('#interval').value, 10),
    dsPollMin: $('#dsfast').checked ? parseInt($('#dspoll').value, 10) : 0,
    warnThreshold: parseInt($('#threshold').value, 10),
    paceAlert: $('#pacealert').checked,
    notifyReset: $('#nreset').checked,
    autoStart: $('#autostart').checked,
    alwaysOnTop: $('#ontop').checked,
    theme: $('#theme').value,
  };
  if (tokDirty) patch.token = $('#tok').value.trim();
  if (dsTokDirty) patch.dsToken = $('#dstok').value.trim();
  if (dsPlatDirty) patch.dsPlatformToken = $('#dsplat').value.trim();
  // 用返回的新状态渲染（别等广播，避免「配完了界面还是旧的」的竞态）
  const next = await api.save(patch);
  tokDirty = dsTokDirty = dsPlatDirty = false;
  if (next) applyState(next);
  flashSaved();
  const cfg = (next && next.config) || (st && st.config) || {};
  if (cfg.hasToken || cfg.dsHasToken) api.setView('panel');
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
  const glm = glmOf();
  const hasGlm = !!(st && st.config && st.config.hasToken);
  const expired = glm.status === 'expired';
  const tier = (glm.data && glm.status === 'ok')
    ? F.tierOfPair(glm.data.five.percent, glm.data.week.percent, st.config.warnThreshold)
    : expired || (dsOf().status === 'expired') ? 'high' : 'low';
  const color = { low: '#22d3ee', mid: '#fbbf24', high: '#f87171' }[tier];
  // 有 GLM 就画 5h 占用环；只配了 DeepSeek 时画一个实心点，不做无意义的 0% 环
  if (hasGlm) {
    const p = expired ? 100 : (glm.data ? glm.data.five.percent : 0);
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

function makeDraggable(el, onTap) {
  el.addEventListener('pointerdown', (e) => {
    if (!el || e.button !== 0 || e.target.closest('button, a, select, textarea, input, label, summary, .clipchip, .ds-bal, .ds-more')) return;
    if (drag) return;
    drag = { moved: false };
    pending.gx = e.screenX; pending.gy = e.screenY; pending.onTap = onTap;
    try { el.setPointerCapture(e.pointerId); } catch { }
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

function hideDsDetail() {
  const el = $('#dsSrc');
  if (el && !el.hidden) { el.hidden = true; $('#dsInfo').classList.remove('on'); }
}

/** 切换图表区间：本地先切（不卡手），主进程落盘后广播会对齐 */
function setRange(r) {
  if (st && st.config) st.config.dsRange = r;
  chartSig = '';
  renderDsPanel();
  api.save({ dsRange: r });
}

function expandTarget() {
  const g = glmOf();
  if (g.status === 'expired' || (st && !st.config.hasToken && !st.config.dsHasToken)) return 'settings';
  return 'panel';
}

/* 乐观先行切换视图：不等主进程回包，点击瞬间内容就变（主进程广播稍后对齐） */
function setViewLocal(v) {
  document.body.classList.remove('view-capsule', 'view-panel', 'view-settings');
  document.body.classList.add('view-' + v);
}

function setTabLocal(t) {
  document.body.classList.remove('tab-glm', 'tab-ds');
  document.body.classList.add('tab-' + t);
  if (st && st.config) st.config.panelTab = t;
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
    const v = glmOf().data || st.config.dsHasToken ? 'panel' : 'capsule';
    setViewLocal(v); api.setView(v);
  });
  $('#webBtn').addEventListener('click', (e) => { e.preventDefault(); api.openExternal(OVERVIEW_URL); });
  $('#dsWebBtn').addEventListener('click', (e) => { e.preventDefault(); api.openExternal(DS_URL); });
  $('#saveBtn').addEventListener('click', saveSettings);
  $('#saveBtn2').addEventListener('click', saveSettings);

  // 面板页签
  $('#tabGlm').addEventListener('click', (e) => { e.stopPropagation(); hideDsDetail(); setTabLocal('glm'); api.setTab('glm'); });
  $('#tabDs').addEventListener('click', (e) => { e.stopPropagation(); setTabLocal('ds'); api.setTab('ds'); });

  // 金额打码：点一下就显示（只在内存里，重启回到打码态）
  bindAutoSave();
  $('#dsBal').addEventListener('click', (e) => {
    e.stopPropagation();
    dsReveal = !dsReveal;
    renderDsPanel();
  });
  // 图表区间：24 小时 / 7 天 / 30 天
  $('#dsR1').addEventListener('click', (e) => { e.stopPropagation(); setRange('1h'); });
  $('#dsR24').addEventListener('click', (e) => { e.stopPropagation(); setRange('24h'); });
  $('#dsR7').addEventListener('click', (e) => { e.stopPropagation(); setRange('7d'); });
  $('#dsR30').addEventListener('click', (e) => { e.stopPropagation(); setRange('30d'); });
  // 「?」详情浮层
  $('#dsInfo').addEventListener('click', (e) => {
    e.stopPropagation();
    const el = $('#dsSrc');
    el.hidden = !el.hidden;
    $('#dsInfo').classList.toggle('on', !el.hidden);
  });

  $('#clrBtn').addEventListener('click', async () => {
    await api.save({ token: '' });
    tokDirty = false; $('#tok').value = '';
  });
  $('#clrDsBtn').addEventListener('click', async () => {
    await api.save({ dsToken: '' });
    dsTokDirty = false; $('#dstok').value = '';
  });
  $('#clrDsPlatBtn').addEventListener('click', async () => {
    await api.save({ dsPlatformToken: '' });
    dsPlatDirty = false; $('#dsplat').value = '';
  });
  $('#tok').addEventListener('input', () => { tokDirty = true; $('#clipchip').classList.remove('show'); });
  $('#dstok').addEventListener('input', () => { dsTokDirty = true; $('#clipchipDs').classList.remove('show'); });
  $('#dsplat').addEventListener('input', () => { dsPlatDirty = true; });

  // DeepSeek 柱状图悬停：显示该柱覆盖的时间区间与费用（与 GLM 的进度条气泡同一套观感）
  const chart = $('#dsChart');
  const tip = $('#dsTip');
  const hideTip = () => tip && tip.classList.remove('show');
  if (chart && tip) {
    chart.addEventListener('pointermove', (e) => {
      const bar = e.target.closest('i');
      if (!bar || !bar.dataset.tip) { hideTip(); return; }
      tip.innerHTML = bar.dataset.tip;
      // 用气泡实宽钳制：左右都不出面板
      const half = tip.offsetWidth / 2 + 2;
      const pos = bar.offsetLeft + bar.offsetWidth / 2;
      tip.style.left = Math.max(half, Math.min(chart.clientWidth - half, pos)) + 'px';
      tip.classList.add('show');
    });
    chart.addEventListener('pointerleave', hideTip);
  }

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
  console.info('GLM_APP booted · view=' + (st && st.view) + ' glm=' + glmOf().status
    + ' ds=' + dsOf().status + ' data=' + !!(glmOf().data));
})();
