'use strict';
/* 每家 provider 的界面件：胶囊列 + 面板视图。
 *
 * 这里是「provider 专属视觉」的唯一住所：骨架（页签/账户 chips/设置页）由 app.js 按
 * GLMPROV 元数据通用渲染，各家的数据长相不同，就各自实现一个工厂：
 *   pane()    → 面板视图  { el, update(ctx), tick(ctx) }
 *   capsule() → 胶囊列    { el, update(ctx) }
 * ctx = { acc(当前账户视图), accounts, config, isTab }；DOM 查询全部 scoped 在
 * 自己的根节点里，切账户/多实例不会互相串数据。
 *
 * 新增一家 provider 的界面 = meta.js 加元数据 + 这里加一个工厂；骨架零改动。
 */
(function () {
  const F = window.GLMFMT;

  /* ---------- 共享小工具（settings.js 也用） ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const build = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  function hhmm(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  /** 货币符号：CNY→¥、USD→$、其余原样前缀 */
  const symOf = (currency) => (currency === 'USD' ? '$' : currency === 'CNY' || !currency ? '¥' : currency + ' ');
  const money = (v, currency) => symOf(currency) + F.fmtMoney(v);

  window.GLMPUI = { esc, build, hhmm, symOf, money };

  /** 配速：按时间均摊，此刻「应该」已用的百分比（1–99 钳制） */
  function pacePercent(w) {
    if (!w) return null;
    const total = w.nextResetTime - w.windowStart;
    if (!(total > 0)) return null;
    return Math.max(1, Math.min(99, ((Date.now() - w.windowStart) / total) * 100));
  }

  /** 实际超出预期的幅度（百分点）；没开开关或没有窗口数据时返回 0 */
  function overOf(win, pace, cfg) {
    if (!cfg.paceAlert || !win || pace == null) return 0;
    const over = win.percent - pace;
    return over > 0.5 ? over : 0;   // 0.5 个百分点以内算噪声：刚开窗就报警会很吵
  }

  /* ---------- 胶囊：账户格骨架（两家共用形状，差异只在数据体） ---------- */

  /** 点账户 chip → 弹原生菜单选账户（窗口只有 40px 高，自绘弹层会被裁掉，见主进程 acc:menu） */
  function openAccMenu(pid) {
    if (window.GLMPUI.accMenu) window.GLMPUI.accMenu(pid);
  }

  /**
   * 胶囊 provider 组：一组里放 1..N 个账户格。
   *   switch 布局 → 只放当前账户一格，数据体右侧挂「账户 chip」（≥2 个账户才有），点它选账户；
   *   all    布局 → 每个启用账户各一格，格顶写账户名（点名字 = 设为当前账户），格间一条浅发丝线。
   * 每格自己的 --pace/--over/data-pace/data-tier 都挂在格上，多格互不串色。
   * @param {string} pid provider id
   * @param {string} dataHtml 数据体内部结构（两家不同），需自带 class 供 fill 取用
   * @param {(cell:HTMLElement, acc:object, ctx:object)=>void} fill 逐格回填
   */
  function capsuleGroup(pid, dataHtml, fill) {
    const root = build('<div class="cap-grp"></div>');
    let sig = '';
    let cells = [];

    function update(ctx) {
      const all = ctx.accounts.filter((a) => a.enabled !== false);
      // 平铺与否由外层统一决定（ctx.tile）：布局选中 + 全胶囊至少有一家是多账户。
      // 只按自己这家判的话，「GLM 多号 + DS 单号」会让 DS 那列退化成不带名字行的样式
      const tile = !!ctx.tile && all.length > 0;
      const shown = tile ? all : [ctx.acc || all[0]].filter(Boolean);
      const chip = !tile && all.length > 1;   // 只有一个账户就不需要切换器
      const s = shown.map((a) => a.id).join(',') + '|' + (tile ? 'all' : 'one') + (chip ? '|chip' : '');

      if (s !== sig) {
        sig = s;
        root.classList.toggle('cap-tile', tile);
        root.innerHTML = shown.map((a) => `
          <div class="cap-acct" data-id="${esc(a.id)}">
            <button class="cap-aname" title="${esc(a.name)}"${tile ? '' : ' hidden'}>${esc(a.name)}</button>
            <div class="cap-data">${dataHtml}</div>
          </div>`).join('');
        cells = [...root.children];
        for (const el of cells) {
          if (chip) {
            const c = document.createElement('button');
            c.className = 'acc-chip';
            c.addEventListener('click', (e) => { e.stopPropagation(); openAccMenu(pid); });
            el.querySelector('.cap-data').appendChild(c);
          }
          // 平铺模式：点账户名 = 把它设为当前账户（面板页签跟着走）
          el.querySelector('.cap-aname').addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.GLMPUI.activate) window.GLMPUI.activate(pid, el.dataset.id);
          });
        }
      }

      for (const el of cells) {
        const acc = ctx.accounts.find((a) => a.id === el.dataset.id) || {};
        fill(el, acc, ctx);
        const c = el.querySelector('.acc-chip');
        if (c) {
          c.textContent = (ctx.acc && ctx.acc.name) || '';
          // 提示里列的账户与菜单一致（只列启用的）：停用的账户不该出现在切换器里
          c.title = '账户：' + all.map((a) => (a.id === (ctx.acc && ctx.acc.id) ? '● ' : '') + a.name).join(' / ')
            + '\n点击切换';
        }
      }
    }

    return { el: root, update };
  }

  /* ================= GLM ================= */

  function makeGlmPane() {
    const root = build(`
      <div class="pane pane-glm">
        <div class="blk blk-q" data-win="five">
          <div class="row">
            <div>
              <div class="pct"><b class="pv5">–</b><i>%</i><span class="overchip">▲ 超预期</span></div>
              <div class="sub">5小时额度 · <span class="cd5">–</span>后重置</div>
            </div>
            <div class="pts">积分<br><b class="u5">–</b> / <span class="t5">–</span><br><span class="rt5">–</span></div>
          </div>
          <div class="pbar"><span class="ghost g5"></span><i class="f5"></i><span class="ovr o5"></span><span class="edge e5"></span><div class="ptip"></div></div>
        </div>
        <div class="blk blk-q" data-win="week">
          <div class="row">
            <div>
              <div class="pct"><b class="pvw">–</b><i>%</i><span class="overchip">▲ 超预期</span></div>
              <div class="sub">周额度 · <span class="cdw">–</span>后重置</div>
            </div>
            <div class="pts">积分<br><b class="uw">–</b> / <span class="tw">–</span><br><span class="rtw">–</span></div>
          </div>
          <div class="pbar"><span class="ghost gW"></span><i class="fw"></i><span class="ovr oW"></span><span class="edge eW"></span><div class="ptip"></div></div>
        </div>
        <div class="blk blk-note"><span class="notetxt"><span class="overtxt">▲ = 实际已超出预期</span></span><span class="chip prov-chip"><i class="pdot"></i><span class="ctxt">—</span></span></div>
      </div>`);
    const $ = (s) => root.querySelector(s);

    function update(ctx) {
      const d = ctx.acc && ctx.acc.data;
      root.style.setProperty('--p5', d ? d.five.percent : 0);
      root.style.setProperty('--pw', d ? d.week.percent : 0);
      $('.pv5').textContent = d ? d.five.percent : '–';
      $('.pvw').textContent = d ? d.week.percent : '–';
      if (d) {
        $('.u5').textContent = F.fmtPoints(d.five.used);
        $('.t5').textContent = F.fmtPoints(d.five.total);
        $('.uw').textContent = F.fmtPoints(d.week.used);
        $('.tw').textContent = F.fmtPoints(d.week.total);
        $('.rt5').textContent = F.fmtResetTime(d.five.nextResetTime);
        $('.rtw').textContent = F.fmtResetTime(d.week.nextResetTime);
      }
      // 档位跟着当前账户走：多账户时别让甲账户的水位把乙账户的视图染红
      // （拿不到档位时保留上次的，不退回全局档位色）
      if (ctx.acc && ctx.acc.tier) root.dataset.tier = ctx.acc.tier;
      tick(ctx);
    }

    function tick(ctx) {
      const d = ctx.acc && ctx.acc.data;
      const on = !!(d && ctx.acc.status === 'ok');
      const p5 = on ? pacePercent(d.five) : null;
      const pw = on ? pacePercent(d.week) : null;
      root.style.setProperty('--pace5', p5 == null ? 0 : p5.toFixed(2));
      root.style.setProperty('--paceW', pw == null ? 0 : pw.toFixed(2));
      const o5 = on ? overOf(d.five, p5, ctx.config) : 0;
      const oW = on ? overOf(d.week, pw, ctx.config) : 0;
      root.style.setProperty('--over5', o5.toFixed(2));
      root.style.setProperty('--overW', oW.toFixed(2));
      root.dataset.pace = (o5 || oW) ? 'over' : 'ok';

      // 「▲ 超预期」标签只挂在真正超支的那个窗口上
      $('[data-win="five"]').classList.toggle('over', o5 > 0);
      $('[data-win="week"]').classList.toggle('over', oW > 0);

      $('.cd5').textContent = F.fmtCountdown((d ? d.five.nextResetTime : NaN) - Date.now());
      $('.cdw').textContent = F.fmtCountdown((d ? d.week.nextResetTime : NaN) - Date.now());

      // 悬停进度条 → 显示预期解释
      root.querySelectorAll('.pbar').forEach((bar) => {
        const tip = bar.querySelector('.ptip');
        if (!tip) return;
        const isFive = !!bar.querySelector('.g5');
        const pace = isFive ? p5 : pw;
        const over = isFive ? o5 : oW;
        if (pace == null) { tip.classList.remove('show'); return; }
        const pct = isFive ? d.five.percent : d.week.percent;
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

      // 峰谷徽标（key 来自 provider meta：glm/ds 各有各的窗口）
      const peak = ctx.peak ? F.isPeak(ctx.peak, Date.now()) : false;
      const chip = $('.prov-chip');
      if (chip) {
        const key = peak ? 'peak' : 'off';
        chip.className = 'chip prov-chip ' + (ctx.peak ? key : 'none');
        chip.title = (ctx.peak && F.PERIOD_NOTE[ctx.peak] ? F.PERIOD_NOTE[ctx.peak] : '') +
          (peak ? '\n当前：高峰时段' : '\n当前：空闲时段');
        chip.querySelector('.ctxt').textContent =
          !ctx.peak ? '—' : peak ? '高峰时段' : '空闲时段';
      }
    }

    // 悬停解释的显隐绑一次
    root.querySelectorAll('.pbar').forEach((bar) => {
      const tip = bar.querySelector('.ptip');
      bar.addEventListener('pointerenter', () => tip.classList.add('show'));
      bar.addEventListener('pointerleave', () => tip.classList.remove('show'));
    });

    return { el: root, update, tick };
  }

  const GLM_CELL = `
    <span class="dot"></span>
    <div class="rows">
      <div class="grp"><span class="lab">5h</span><div class="bar"><span class="ghost g5"></span><i class="f5"></i><span class="ovr o5"></span><span class="edge e5"></span></div><b class="pv5">–</b></div>
      <div class="grp"><span class="lab">周</span><div class="bar"><span class="ghost gW"></span><i class="fw"></i><span class="ovr oW"></span><span class="edge eW"></span></div><b class="pvw">–</b></div>
    </div>
    <span class="glm-warn" hidden>⚠ 已失效</span>`;

  /** 一格 GLM 数据：两条 mini bar + 幽灵/亮线/超支段（配速每秒由 app 的秒循环带上） */
  function fillGlmCell(el, acc, ctx) {
    const d = acc.data;
    const st = acc.status || 'boot';
    el.style.setProperty('--p5', d ? d.five.percent : 0);
    el.style.setProperty('--pw', d ? d.week.percent : 0);
    el.querySelector('.pv5').textContent = d ? d.five.percent : '–';
    el.querySelector('.pvw').textContent = d ? d.week.percent : '–';
    el.classList.toggle('st-expired', st === 'expired');
    el.classList.toggle('st-loading', st === 'loading' || st === 'boot');
    // 每格按自己账户的水位变色（平铺时多个账户各有各的档）。拿不到档位（首次加载中就失败）
    // 就保留上一次的档位色，不退回去继承全局 —— 否则别人家的高水位会把这格染红
    if (acc.tier) el.dataset.tier = acc.tier;

    const on = !!(d && st === 'ok');
    const p5 = on ? pacePercent(d.five) : null;
    const pw = on ? pacePercent(d.week) : null;
    const o5 = on ? overOf(d.five, p5, ctx.config) : 0;
    const oW = on ? overOf(d.week, pw, ctx.config) : 0;
    el.style.setProperty('--pace5', p5 == null ? 0 : p5.toFixed(2));
    el.style.setProperty('--paceW', pw == null ? 0 : pw.toFixed(2));
    el.style.setProperty('--over5', o5.toFixed(2));
    el.style.setProperty('--overW', oW.toFixed(2));
    el.dataset.pace = (o5 || oW) ? 'over' : 'ok';
  }

  function makeGlmCapsule() {
    const g = capsuleGroup('glm', GLM_CELL, fillGlmCell);
    g.el.classList.add('cap-glm');
    return g;
  }

  /* ================= DeepSeek ================= */

  function makeDsPane() {
    const root = build(`
      <div class="pane pane-ds">
        <div class="ds-headwrap">
          <div class="ds-top">
            <div class="ds-bal" title="点击显示 / 隐藏金额"><i class="cur">¥</i><b class="dstotal">–</b><span class="eye">👁</span></div>
            <div class="ds-sub">账户余额</div>
            <button class="qbtn" title="数据来源与口径">?</button>
          </div>
          <div class="ds-more" hidden></div>
        </div>
        <div class="ds-stats">
          <div><span>今日</span><b class="ds-today">–</b></div>
          <div><span>近 7 天</span><b class="ds-wk">–</b></div>
          <div><span>本月</span><b class="ds-mo">–</b></div>
        </div>
        <div class="ds-chart-head">
          <span class="ds-range">近 7 天消费</span>
          <div class="seg">
            <button class="segb" data-r="1h">1时</button>
            <button class="segb" data-r="24h">24时</button>
            <button class="segb" data-r="7d">7天</button>
            <button class="segb" data-r="30d">30天</button>
          </div>
        </div>
        <div class="ds-chart"><div class="dstrip"></div></div>
        <div class="ds-foot"><span class="dsleft ds-left">–</span><span class="dsright ds-right"></span><span class="chip prov-chip"><i class="pdot"></i><span class="ctxt">—</span></span></div>
      </div>`);
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => root.querySelectorAll(s);

    let dsReveal = false;   // 主余额打码：只在内存里，重启回到打码态
    let chartSig = '';      // 柱状图「数据指纹」：没变就不重建 DOM

    const rangeLabel = (range, s, mon) => {
      if (!s) return '近 7 天消费';
      if (range === '1h') return `近 1 小时 ${mon(s.last1h)}`;
      if (range === '24h') {
        const sum = (s.hourly || []).reduce((a, h) => a + h.spend, 0);
        return `近 24 小时 ${mon(sum)}`;
      }
      if (range === '30d') return `近 30 天 ${mon(s.last30)}`;
      return `近 7 天 ${mon(s.last7)}`;
    };

    /** 柱子覆盖的时间区间（5 分钟柱给 10:35–10:40，小时柱给 10:00–11:00） */
    function bucketRange(ts, range) {
      const H = 3600e3;
      const p = (x) => String(x).padStart(2, '0');
      const hm = (t) => { const d = new Date(t); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
      if (range === '1h') return `${hm(ts)}–${hm(ts + 5 * 60000)}`;
      if (range === '24h') return `${hm(ts)}–${hm(ts + H)}`;
      return hm(ts);
    }

    function renderChart(range, cur, s) {
      const host = $('.ds-chart');
      // 越近的区间柱子越细：1 小时 → 5 分钟一根，24 小时 → 1 小时一根，7/30 天 → 一天一根
      const byTime = range === '1h' || range === '24h';
      const series = range === '1h' ? ((s && s.fine) || [])
        : range === '24h' ? ((s && s.hourly) || [])
          : ((s && s.series) || []).slice(-(range === '30d' ? 30 : 7));
      const sig = range + '|' + series.map((x) => (byTime ? (x.ts + ':' + x.spend.toFixed(2)) : (x.date + ':' + x.spend.toFixed(2)))).join(',');
      if (sig === chartSig) return;      // 每秒重算时会走到这里，避免白重建 DOM
      chartSig = sig;
      host.querySelectorAll('i').forEach((b) => b.remove());   // 只清柱子：气泡是常驻的兄弟节点
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

    /** 「?」浮层：数据来源、口径、token 明细。绝对定位，不参与布局（面板高度恒定） */
    function renderDetail(ctx) {
      const el0 = $('.ds-more');
      const acc = ctx.acc || {};
      const creds = (ctx.accCreds) || {};
      const s = acc.data && acc.data.summary;
      const platform = (acc.data && acc.data.platform) || { status: 'empty' };
      const cur = acc.data && acc.data.balance ? acc.data.balance.currency : 'CNY';
      const mon = (v) => (v == null ? '–' : money(v, cur));
      const lines = [];
      if (!creds.apiKey || !creds.apiKey.set) {
        lines.push('未配置 API Key · <a href="#" data-act="settings">去配置 ›</a>');
      } else if (s && s.source === 'platform') {
        lines.push('来源：<b>平台账单</b> · UTC 日界');
        const t = acc.data.tokens && acc.data.tokens.total;
        if (t && t.total > 0) {
          const hit = t.promptTokens > 0 ? Math.round((t.cacheHit / t.promptTokens) * 100) : 0;
          lines.push(`本月 ${F.fmtTokens(t.total)} tok · 缓存命中 ${hit}%`);
          lines.push('图表格：1 小时按 5 分钟 · 24 小时按小时 · 7/30 天按天');
        }
        if (s.byModel && s.byModel.length) {
          const list = s.byModel.slice().sort((a, b) => b.cost - a.cost).slice(0, 3);
          if (list.length) lines.push(`按模型：${list.map((m) => `${m.model} ${mon(m.cost)}`).join(' · ')}`);
        }
      } else {
        const since = s && s.firstSampleAt ? new Date(s.firstSampleAt) : null;
        const when = since ? `${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')} ${hhmm(since)}` : '';
        lines.push(`来源：<b>本地余额差值</b> · 自 ${when || '本次启动'}`);
        lines.push(`余额每 ${ctx.config.dsPollMin || 2} 分钟一采，实时读数靠它`);
        lines.push('图表格：1 小时按 5 分钟 · 24 小时按小时 · 7/30 天按天');
      }
      if (platform.status === 'expired') {
        lines.push('<span class="warn">平台会话过期</span> · 重取 userToken 可恢复');
      } else if (platform.status === 'error' || platform.status === 'ratelimit') {
        lines.push('<span class="warn">平台接口异常</span> · 已退回本地差值');
      }
      if (ctx.peak && F.PERIOD_NOTE[ctx.peak]) {
        lines.push(`时段：${F.isPeak(ctx.peak, Date.now()) ? '<b>高峰</b>' : '<b>空闲（半价）</b>'} · ${F.PERIOD_NOTE[ctx.peak]}`);
      }
      if (ctx.site) lines.push(`<a href="#" data-act="site">${esc(ctx.siteLabel || '打开用量页')} ›</a>`);
      // 注意别用 class="row"：.pane .row 是 GLM 那两块的 flex 布局，会把说明排成两列
      el0.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
      el0.querySelectorAll('a').forEach((a) => {
        a.onclick = (e) => {
          e.preventDefault();
          if (a.dataset.act === 'settings') window.GLMPUIgo.settings();
          else if (a.dataset.act === 'site' && ctx.site) window.glm.openExternal(ctx.site);
        };
      });
    }

    function update(ctx) {
      const acc = ctx.acc || {};
      const d = acc.data || {};
      const s = d.summary;
      const bal = d.balance;
      const cur = bal ? bal.currency : 'CNY';
      const mon = (v) => (v == null ? '–' : money(v, cur));

      // 强调色：fixed 型 provider 自成一套，不吃全局档位的变色
      if (ctx.accent) {
        const a = ctx.accent[ctx.theme] || ctx.accent.dark;
        root.style.setProperty('--g1', a[0]);
        root.style.setProperty('--g2', a[1]);
      }

      root.classList.toggle('ds-masked', !dsReveal);
      $('.dstotal').textContent = bal ? (dsReveal ? F.fmtMoney(bal.total) : '••••') : '–';
      $('.ds-bal .cur').textContent = symOf(cur);

      // 账户状态与余额同行（省一行高度，两个页签才能等高）
      const sub = $('.ds-sub');
      if (acc.status === 'expired') sub.innerHTML = '<span class="warn">⚠ Key 已失效</span>';
      else if (acc.status === 'error') sub.innerHTML = '<span class="warn">⚠ 更新失败</span>';
      else if (acc.status === 'ratelimit') sub.innerHTML = '<span class="warn">⚠ 限流退避中</span>';
      else if (bal) sub.textContent = bal.available ? (bal.granted > 0 ? `含赠送 ${money(bal.granted, cur)}` : '全部为充值余额') : '⚠ 余额不足';
      else sub.textContent = '';

      $('.ds-today').textContent = s ? mon(s.today) : '–';
      $('.ds-wk').textContent = s ? mon(s.last7) : '–';
      $('.ds-mo').textContent = s ? mon(s.month) : '–';

      const range = ctx.config.dsRange || '7d';
      $$('.segb').forEach((b) => b.classList.toggle('on', b.dataset.r === range));
      $('.ds-range').textContent = rangeLabel(range, s, mon);

      renderChart(range, cur, s);

      const left = $('.ds-left');
      if (!s) left.textContent = '–';
      else {
        // 1 小时档的标题已经写了「近 1 小时合计」，脚注就换成更细的滚动窗口，别重复
        const recent = range === '1h' ? `最近 5 分钟 ${mon(s.last5m)}` : `近 1 小时 ${mon(s.last1h)}`;
        left.textContent = `${recent} · 日均 ${mon(s.avg7)}`;
      }
      $('.ds-right').textContent = (s && s.daysLeft != null) ? `可用 ${s.daysLeft} 天` : '';

      // 峰谷徽标
      const chip = $('.prov-chip');
      if (chip) {
        const peak = ctx.peak ? F.isPeak(ctx.peak, Date.now()) : false;
        const key = !ctx.peak ? 'none' : peak ? 'peak' : 'off';
        chip.className = 'chip prov-chip ' + key;
        chip.title = (ctx.peak && F.PERIOD_NOTE[ctx.peak] ? F.PERIOD_NOTE[ctx.peak] : '') +
          (peak ? '\n当前：高峰时段' : '\n当前：空闲时段');
        // 与 GLM 页签同一套文案（半价之类的折扣写在 title / 「?」浮层里，不进标签）
        chip.querySelector('.ctxt').textContent = !ctx.peak ? '—' : peak ? '高峰时段' : '空闲时段';
      }

      renderDetail(ctx);
    }

    const tick = () => { /* DS 面板没有每秒变化的元素；图表指纹已在 update 里防抖 */ };

    /* ---- 交互（绑一次，scoped） ---- */
    $('.ds-bal').addEventListener('click', (e) => {
      e.stopPropagation();
      dsReveal = !dsReveal;
      window.GLMPUI.rerender();
    });
    $$('.segb').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      window.GLMPUI.setRange(b.dataset.r);
    }));
    $('.qbtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const el0 = $('.ds-more');
      el0.hidden = !el0.hidden;
      $('.qbtn').classList.toggle('on', !el0.hidden);
    });
    // 柱状图悬停：显示该柱覆盖的时间区间与费用
    const chart = $('.ds-chart');
    const tip = $('.dstrip');
    const hideTip = () => tip.classList.remove('show');
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

    return { el: root, update, tick };
  }

  const DS_CELL = '<div class="cap-main"><b class="dsbal">–</b><span class="dstoday">–</span></div>';

  /** 一格 DeepSeek 数据：余额 + 今日消费（右对齐两行，与切换器同一行排布） */
  function fillDsCell(el, acc) {
    const bal = acc.data && acc.data.balance;
    const today = acc.data && acc.data.summary ? acc.data.summary.today : null;
    const cur = bal ? bal.currency : 'CNY';
    el.querySelector('.dsbal').textContent = bal ? money(bal.total, cur) : '–';
    const todayEl = el.querySelector('.dstoday');
    if (acc.status === 'expired') todayEl.textContent = 'Key 已失效';
    else if (acc.status === 'error') todayEl.textContent = '更新失败';
    else if (today != null && today > 0) todayEl.textContent = '今日 ' + F.fmtMoney(today);
    else todayEl.textContent = today != null ? '今日 0.00' : '今日 –';
    el.classList.toggle('warn', acc.status === 'expired' || acc.status === 'error');
    // 有旧值但当前拉取失败：压暗表示「不是最新的」
    el.classList.toggle('dim', !!bal && acc.status !== 'ok');
  }

  function makeDsCapsule() {
    const g = capsuleGroup('deepseek', DS_CELL, fillDsCell);
    g.el.classList.add('cap-ds');
    return g;
  }

  window.PANES = {
    glm: { pane: makeGlmPane, capsule: makeGlmCapsule },
    deepseek: { pane: makeDsPane, capsule: makeDsCapsule },
  };
})();
