'use strict';
/* 设置页的 provider 段落渲染：账户列表 + 添加/编辑表单 + 该家专属的全局控件。
 * 另有「贴边圆圈」段（不在 #provSecs 里）：每个启用账户的圆圈口径 / DeepSeek 预算（见文末）。
 *
 * 全部由 GLMPROV 元数据驱动：分段标题、凭据输入框（label/占位/指引）、官网链接、
 * 专属控件（配额提醒 / 高频采样）都从 meta 来——新增 provider 时这里零改动。
 *
 * 共享全局控件（quota-alerts、ds-poll）绑定的是同一份全局配置；若未来多家都声明了
 * 同一个控件，只有第一家渲染（控件是全局的，不该出现两份）。
 */
(function () {
  const { esc, build, hhmm, money } = window.GLMPUI;
  const F = window.GLMFMT;
  const DOCKM = window.GLMDOCK;    // 圆圈口径（lib/dock-metric.js，与主进程同一份规范化逻辑）

  const STATE_CLASS = { ok: 'ok', expired: 'bad', error: 'bad', ratelimit: 'bad', empty: 'na', nosub: 'na', loading: 'na', boot: 'na' };
  const STATE_WORD = {
    ok: '有效', expired: '已失效', error: '更新失败', ratelimit: '限流',
    empty: '未配置', nosub: '未开通套餐', loading: '验证中…', boot: '验证中…',
  };

  /** 账户行显示的凭据尾号。枚举类字段（套餐之类）不是秘密，跳过——不然会冒出「…auto」 */
  function tailsOf(pid, creds) {
    return Object.entries(creds || {})
      .filter(([k, c]) => {
        if (!c.set) return false;
        const decl = window.GLMPROV.credOf(pid, k);
        return !(decl && decl.kind === 'select');
      })
      .map(([, c]) => `…${c.tail}`)
      .join(' · ');
  }

  /** 正在编辑的表单：{ pid, id|null }；开着的时候整个设置页不做重建（免得打字被打断）。
   *  renderRequest 标记「刚请求打开/关闭表单」的那一拍：applySettings 只在这一拍重建。 */
  let editing = null;
  let renderRequest = false;

  function isEditing() { return editing != null; }
  function takeRenderRequest() { const r = renderRequest; renderRequest = false; return r; }

  /** 打开添加/编辑表单（先置请求再触发重绘，绕过「焦点在设置页不重绘」守卫） */
  function openEditor(pid, id) {
    editing = { pid, id: id || null };
    renderRequest = true;
    window.GLMPUI.rerender();
  }
  /** 关闭表单：失效结构指纹强制重建（sig 没变也必须把表单摘掉） */
  function closeEditor() {
    editing = null;
    renderRequest = false;
    window.GLMPUI.invalidateSettings();
    window.GLMPUI.rerender();
  }

  /** 账户状态 → 行状态描述 */
  function accStatusText(acc) {
    if (!acc) return '未配置';
    if (acc.enabled === false) return '已停用';
    return STATE_WORD[acc.status] || '验证中…';
  }

  function guideHtml(decl) {
    if (!decl.guide) return '';
    return `<details class="gdwrap"><summary>${esc(decl.guide.summary)}</summary><ol class="guide">` +
      decl.guide.steps.map((s) => `<li>${s}</li>`).join('') + '</ol></details>';
  }

  /** 表单：新增（acc=null）或编辑（acc=账户视图） */
  function formHtml(pid, meta, acc, cfgAccounts) {
    const isEdit = !!acc;
    const nameVal = isEdit ? esc(acc.name) : '';
    const fields = meta.credentials.map((decl) => {
      const c = isEdit ? (acc.creds[decl.key] || {}) : {};
      if (decl.kind === 'select') {
        // 枚举字段（如「套餐」）：下拉呈现。没有「清除」按钮（枚举没有空值语义），
        // 也不参与剪贴板识别——它不是秘密，是选项。
        const cur = String(c.value || (decl.options[0] || {}).value || '');
        return `
        <label class="clab" for="f-${pid}-${decl.key}">${esc(decl.label)}</label>
        <select id="f-${pid}-${decl.key}" data-cred="${decl.key}">
          ${decl.options.map((o) => `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        ${guideHtml(decl)}`;
      }
      const ph = c.set
        ? `已保存 ·…${c.tail}（粘贴新值可替换${decl.required ? '' : '，留空不变'}）`
        : decl.placeholder;
      return `
        <label class="clab" for="f-${pid}-${decl.key}">${esc(decl.label)}${decl.required ? '' : '（选配）'}</label>
        <textarea id="f-${pid}-${decl.key}" data-cred="${decl.key}" spellcheck="false" placeholder="${esc(ph)}"></textarea>
        <span class="clipchip" data-for="f-${pid}-${decl.key}"></span>
        <div class="frow">
          <span class="fstat" id="fs-${pid}-${decl.key}"></span>
          ${c.set ? `<button type="button" class="clr" data-clr="${decl.key}">清除</button>` : ''}
        </div>
        ${guideHtml(decl)}`;
    }).join('');
    return `
      <form class="acc-form" data-pid="${pid}" data-id="${isEdit ? acc.id : ''}">
        <label class="clab" for="fn-${pid}">账户名称</label>
        <input type="text" id="fn-${pid}" class="aname-input" maxlength="12" placeholder="${esc(isEdit ? '' : meta.tab + ' 账户')}" value="${nameVal}">
        ${fields}
        <div class="btns">
          <button type="button" class="btn ghost fcancel">取消</button>
          <button type="submit" class="btn pri">${isEdit ? '保存修改' : '添加并验证'}</button>
        </div>
      </form>`;
  }

  /** 账户行 */
  function rowHtml(pid, a) {
    const tails = tailsOf(pid, a.creds);
    return `
      <div class="acc-row ${a.enabled === false ? 'off' : ''}" data-id="${a.id}">
        <span class="adot ${STATE_CLASS[a.status] || 'na'}" title="${esc(accStatusText(a))}"></span>
        <span class="aname">${esc(a.name)}</span>
        <span class="atail">${esc(tails)}</span>
        <span class="aword ${STATE_CLASS[a.status] || 'na'}">${esc(accStatusText(a))}</span>
        <button type="button" class="arow-btn" data-act="toggle">${a.enabled === false ? '启用' : '停用'}</button>
        <button type="button" class="arow-btn" data-act="edit">编辑</button>
        <button type="button" class="arow-btn warn" data-act="del">删除</button>
      </div>`;
  }

  /** 专属控件（每个 key 全局只渲染一次，由 renderedControls 去重） */
  const CONTROL_RENDERERS = {
    'quota-alerts': () => `
      <div class="subh">配额提醒</div>
      <div class="grid one">
        <label>提醒阈值（%）
          <input type="number" id="threshold" min="1" max="99" step="1" value="80">
        </label>
      </div>
      <p class="hintline">到阈值进度条变琥珀并弹通知；再高 10 个点变红。<b>配额型 provider（GLM、火山方舟）共用这一份阈值。</b></p>
      <label class="tgl"><input type="checkbox" id="nreset">5 小时额度重置时提醒</label>
      <label class="tgl"><input type="checkbox" id="pacealert" checked>用量超过预期进度时变色提醒</label>`,
    'ds-poll': () => `
      <div class="subh">余额高频采样</div>
      <label class="tgl"><input type="checkbox" id="dsfast" checked>高频采样（实时读数的分辨率）</label>
      <div class="grid one" id="dsfastrow">
        <label>采样间隔
          <select id="dspoll">
            <option value="1">每 1 分钟</option>
            <option value="2" selected>每 2 分钟（推荐）</option>
            <option value="5">每 5 分钟</option>
            <option value="10">每 10 分钟</option>
          </select>
        </label>
      </div>
      <p class="hintline">「最近 5 分钟」「1 小时柱图」的分辨率就等于这个间隔。关掉则余额跟全局刷新频率一起走。</p>`,
  };

  /**
   * 重建整个 provider 区块区。
   * @param {HTMLElement} host  #provSecs 容器
   * @param {object} st  完整 state
   */
  /**
   * 重建 provider 区块区。
   * @returns {boolean} 是否真的重建了（调用方据此决定要不要重绑动态控件）
   */
  function render(host, st) {
    if (editing && !renderRequest) return false;   // 表单开着：不动 DOM（打开/关闭请求的那一拍除外）
    renderRequest = false;
    const cfg = st.config;
    const byId = (id) => cfg.accounts.find((a) => a.id === id) || null;
    const renderedControls = new Set();
    const parts = [];

    for (const meta of window.GLMPROV.list) {
      const accounts = cfg.accounts.filter((a) => a.provider === meta.id);
      const provSt = st.providers[meta.id] || null;
      parts.push(`<h4 class="sech">${esc(meta.name)}</h4>`);
      parts.push('<div class="acc-wrap" data-pid="' + meta.id + '">');

      // 账户清单（0 个也要渲染容器：空态提示放这）
      if (accounts.length) {
        parts.push('<div class="acc-list">' +
          accounts.map((a) => {
            const live = provSt ? (provSt.accounts.find((x) => x.id === a.id) || {}) : {};
            return rowHtml(meta.id, { ...a, status: live.status || 'boot' });
          }).join('') + '</div>');
      } else {
        parts.push('<p class="hintline">尚未添加账户。</p>');
      }
      if (!editing || editing.pid !== meta.id) {
        parts.push(`<button type="button" class="acc-add" data-pid="${meta.id}">＋ 添加 ${esc(meta.tab)} 账户</button>`);
      }
      if (editing && editing.pid === meta.id) {
        const acc = editing.id ? (() => {
          const a = byId(editing.id);
          const live = provSt ? provSt.accounts.find((x) => x.id === editing.id) : null;
          return a ? { ...a, status: live ? live.status : 'boot', creds: a.creds } : null;
        })() : null;
        parts.push(formHtml(meta.id, meta, acc, cfg.accounts));
      }

      // 官网链接
      if (meta.site) {
        parts.push(`<p class="linkrow"><a href="#" class="open-site" data-pid="${meta.id}">${esc(meta.siteLabel || '打开官网')} ›</a></p>`);
      }
      // 专属控件（第一次声明者渲染）
      for (const key of meta.controls || []) {
        if (renderedControls.has(key)) continue;
        renderedControls.add(key);
        parts.push(CONTROL_RENDERERS[key] ? CONTROL_RENDERERS[key]() : '');
      }
      parts.push('</div>');
    }
    host.innerHTML = parts.join('');
    renderDock(st);          // 「贴边圆圈」段：与 provider 段同一结构指纹节拍（行集变了才重建）
    bind(host, st);
    fill(host, st);
    return true;
  }

  /* ---------- 交互绑定（重建后重挂） ---------- */
  function bind(host, st) {
    host.querySelectorAll('.acc-add').forEach((btn) => {
      btn.addEventListener('click', () => openEditor(btn.dataset.pid, null));
    });
    host.querySelectorAll('.acc-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-act="edit"]').addEventListener('click', () => {
        openEditor(row.closest('.acc-wrap').dataset.pid, id);
      });
      row.querySelector('[data-act="toggle"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const a = st.config.accounts.find((x) => x.id === id);
        const next = await window.glm.accUpdate({ id, enabled: !(a && a.enabled !== false) });
        window.GLMPUI.applyState(next);
      });
      row.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const a = st.config.accounts.find((x) => x.id === id);
        if (!window.confirm(`删除账户「${(a && a.name) || id}」？\n对应的本地消费历史也会一并删除。`)) return;
        const next = await window.glm.accRemove({ id });
        window.GLMPUI.applyState(next);
      });
    });
    host.querySelectorAll('.open-site').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const meta = window.GLMPROV.byId(a.dataset.pid);
        if (meta && meta.site) window.glm.openExternal(meta.site);
      });
    });
    host.querySelectorAll('form.acc-form').forEach((form) => {
      form.addEventListener('submit', onSubmit);
      form.querySelector('.fcancel').addEventListener('click', closeEditor);
      form.querySelectorAll('[data-clr]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = form.dataset.id;
          if (!id) return;
          await window.glm.accUpdate({ id, credentials: { [btn.dataset.clr]: '' } });
        });
      });
      // 一动手就把上一次的报错收走（用户正在改，别让红字杵着）
      const clearErr = () => { const el = form.querySelector('.formerr'); if (el) el.remove(); };
      // 下拉也要挂：改了套餐就等于改了输入，红字该收走（select 上 input 事件现代浏览器都会发）
      form.querySelectorAll('textarea[data-cred], select[data-cred]').forEach((el) => {
        el.addEventListener('input', () => {
          const chip = form.querySelector(`.clipchip[data-for="${el.id}"]`);
          if (chip) chip.classList.remove('show');
          clearErr();
        });
      });
      form.querySelector('.aname-input').addEventListener('input', clearErr);
    });
  }

  /** 表单里的错误提示：**必须显示出来** —— 静默关表单 + 闪「已保存」会让用户以为账户加上了 */
  function showFormError(form, msg) {
    let el = form.querySelector('.formerr');
    if (!el) {
      el = document.createElement('p');
      el.className = 'formerr';
      form.querySelector('.btns').before(el);
    }
    el.textContent = '⚠ ' + msg;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const pid = form.dataset.pid;
    const id = form.dataset.id;
    const name = form.querySelector('.aname-input').value.trim();
    const credentials = {};
    form.querySelectorAll('textarea[data-cred]').forEach((ta) => {
      credentials[ta.dataset.cred] = ta.value.trim();
    });
    // 下拉（套餐之类）：原值直接提交，不走提取器
    form.querySelectorAll('select[data-cred]').forEach((sel) => {
      credentials[sel.dataset.cred] = sel.value;
    });
    const next = id
      ? await window.glm.accUpdate({ id, name, credentials })
      : await window.glm.accAdd({ provider: pid, name, credentials });
    if (next && next.err) {          // 校验没过：表单留着、错误留在眼前，改完能再提交
      showFormError(form, next.err);
      return;
    }
    editing = null;
    renderRequest = false;
    window.GLMPUI.invalidateSettings();   // 表单要摘掉，强制下一拍重建
    window.GLMPUI.applyState(next);       // CRUD 桥直接返回新状态，不等下一次广播
    window.GLMPUI.flashSaved();
  }

  /* ---------- 值回填（不重建，只在状态变化时同步控件） ---------- */
  function fill(host, st) {
    const cfg = st.config;
    // 账户行的状态词/尾号
    host.querySelectorAll('.acc-row').forEach((row) => {
      const a = cfg.accounts.find((x) => x.id === row.dataset.id);
      if (!a) return;
      const provSt = st.providers[a.provider];
      const live = provSt ? provSt.accounts.find((x) => x.id === a.id) : null;
      const status = live ? live.status : 'boot';
      const word = row.querySelector('.aword');
      const dot = row.querySelector('.adot');
      word.textContent = accStatusText({ ...a, status });
      word.className = 'aword ' + (STATE_CLASS[status] || 'na');
      dot.className = 'adot ' + (STATE_CLASS[status] || 'na');
      row.querySelector('.atail').textContent = tailsOf(a.provider, a.creds);
    });
    // 全局控件（配额提醒 / 高频采样）
    const th = host.querySelector('#threshold');
    if (th && document.activeElement !== th) th.value = String(cfg.warnThreshold);
    const nr = host.querySelector('#nreset');
    if (nr) nr.checked = !!cfg.notifyReset;
    const pa = host.querySelector('#pacealert');
    if (pa) pa.checked = !!cfg.paceAlert;
    const fast = host.querySelector('#dsfast');
    const poll = Number(cfg.dsPollMin) || 0;
    if (fast) {
      fast.checked = poll > 0;
      const sel = host.querySelector('#dspoll');
      const row = host.querySelector('#dsfastrow');
      if (sel) sel.value = String(poll > 0 ? poll : 2);
      if (sel) sel.disabled = !(poll > 0);
      if (row) row.classList.toggle('off', !(poll > 0));
    }
    fillDock(st);
  }

  /* ---------- 贴边圆圈段：每个启用账户的圆圈口径（DeepSeek 另配预算当 100%） ----------
     行不在 #provSecs 里，但跟着它一起走「结构指纹」的节拍：账户集 / 启用状态 / 名字变了才
     重建（render 末尾收尾），口径与预算的变化只回填（fill 末尾收尾）。余额广播每两分钟就
     推一次，重建会把用户正在输入的金额清掉、焦点也丢 —— 所以这两个函数必须分开。 */

  /** 段里要列的行：注册表序 → 账户原序，只留启用的（与圆圈列的出场规则一致） */
  function dockRows(st) {
    const out = [];
    for (const meta of window.GLMPROV.list) {
      for (const acc of st.config.accounts) {
        if (acc.provider === meta.id && acc.enabled !== false) out.push({ pid: meta.id, acc });
      }
    }
    return out;
  }

  /** 该家的口径定义；METRICS 里没有的家（防御）→ null */
  function metricsOf(pid) {
    return DOCKM && Object.prototype.hasOwnProperty.call(DOCKM.METRICS, pid) ? DOCKM.METRICS[pid] : null;
  }

  /* 「圆圈大小」（config.dockScale）：四个预设档 + 滚轮调出来的自定义值。
     主进程下发前已按 [0.6, 1.6] 规范化，这里缺省 / 认不出的按 1。 */
  const DOCK_SCALES = [
    { v: 0.75, label: '小' }, { v: 1, label: '标准' }, { v: 1.25, label: '大' }, { v: 1.5, label: '特大' },
  ];

  function dockScaleOf(st) {
    const n = Number(st && st.config ? st.config.dockScale : 1);
    return Number.isFinite(n) && n >= 0.6 && n <= 1.6 ? n : 1;   // 区间判断与 app.js 同款：越界也按 1，别只认「认得出的数」
  }

  /** 大小下拉的选项：四个预设；当前值在预设外（Ctrl+滚轮调出来的）时补一项「自定义（NN%）」并选中 */
  function scaleOptionsHtml(cur) {
    const opts = DOCK_SCALES.map((o) =>
      `<option value="${o.v}" data-scale="${o.v}"${o.v === cur ? ' selected' : ''}>${o.label}</option>`);
    if (!DOCK_SCALES.some((o) => o.v === cur)) {
      opts.push(`<option value="${cur}" data-scale="${cur}" selected>自定义（${Math.round(cur * 100)}%）</option>`);
    }
    return opts.join('');
  }

  /** 「圆圈大小」行跟随状态：值真变了才重建选项（余额广播那种「值没变」的填充不碰 DOM，
   *  免得用户正拉着下拉时选项被换掉） */
  let scaleSig = '';
  function syncScaleRow(st) {
    const sel = document.getElementById('dockScale');
    if (!sel) return;
    const cur = dockScaleOf(st);
    if (String(cur) === scaleSig) return;
    scaleSig = String(cur);
    sel.innerHTML = scaleOptionsHtml(cur);
  }

  /** 下拉的 change 绑定：元素是 index.html 里的静态节点，只绑一次 */
  let scaleBound = false;
  function bindScaleRow() {
    const sel = document.getElementById('dockScale');
    if (!sel || scaleBound) return;
    scaleBound = true;
    sel.addEventListener('change', async () => {
      const opt = sel.selectedOptions[0];
      const v = opt ? Number(opt.dataset.scale) : NaN;
      if (!Number.isFinite(v)) return;
      const next = await window.glm.save({ dockScale: v });   // 与既有自动保存同一套：change 即落盘
      if (next) window.GLMPUI.applyState(next);
      window.GLMPUI.flashSaved();
    });
  }

  /** 预算框占位：跟着口径走 —— 默认口径（今日）用通用文案，其余把周期写进占位，
   *  免得「这笔钱算哪一段」说不清 */
  function budgetPlaceholder(metric) {
    const list = metricsOf('deepseek') || [];
    const item = list.find((m) => m.key === metric);
    return (!item || item.key === (list[0] || {}).key) ? '预算，如 20' : item.label + '预算';
  }

  /** 一行：logo + 账户名 + 口径下拉；DeepSeek 多一个预算金额框与「未设预算」行内提示 */
  function dockRowHtml(pid, acc) {
    const metrics = metricsOf(pid);
    const cur = DOCKM.normalize(pid, acc.dock);
    const opts = (metrics || []).map((m) =>
      `<option value="${esc(m.key)}"${m.key === cur.metric ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
    const shows = (DOCKM.SHOWS || []).map((x) =>
      `<option value="${esc(x.key)}"${x.key === cur.show ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
    const budget = pid === 'deepseek' ? `
          <select class="dshow" aria-label="圆圈下显示">${shows}</select>
          <label class="dbudget"><span class="dcur" aria-hidden="true">¥</span><input type="text" inputmode="decimal" spellcheck="false" placeholder="${esc(budgetPlaceholder(cur.metric))}" value="${cur.budget == null ? '' : esc(String(cur.budget))}"></label>
          <p class="dhint">未设预算时圆圈不显示百分比，可改为显示金额</p>` : '';
    return `
        <div class="dock-row${pid === 'deepseek' && cur.budget == null && cur.show !== 'cost' ? ' nobudget' : ''}" data-pid="${esc(pid)}" data-id="${esc(acc.id)}">
          <span class="dlogo" aria-hidden="true">${(window.GLMLOGOS && window.GLMLOGOS[pid]) || ''}</span>
          <span class="dname">${esc(acc.name)}</span>
          ${metrics ? `<select class="dmetric" aria-label="圆圈口径">${opts}</select>` : ''}${budget}
        </div>`;
  }

  /** 一行拿到最新状态：口径 / 金额 / 占位 / 未设预算提示。**焦点所在的控件不动**——
   *  广播来了也不能把正在输入的内容与焦点弄丢 */
  function syncDockRow(el, pid, acc) {
    const cur = DOCKM.normalize(pid, acc.dock);
    const sel = el.querySelector('select.dmetric');
    if (sel && document.activeElement !== sel) sel.value = cur.metric;
    const inp = el.querySelector('.dbudget input');
    if (inp) {
      if (document.activeElement !== inp) inp.value = cur.budget == null ? '' : String(cur.budget);
      inp.placeholder = budgetPlaceholder(sel ? sel.value : cur.metric);
    }
    const shw = el.querySelector('select.dshow');
    if (shw && document.activeElement !== shw) shw.value = cur.show;
    // 「未设预算」提示只在要显示百分比时才有意义：选了金额，没预算也照样有数
    el.classList.toggle('nobudget', !!inp && cur.budget == null && (shw ? shw.value : cur.show) !== 'cost');
  }

  /** 重建整段（行集变了才调用）；没有启用账户时整段隐藏（含「圆圈大小」行） */
  function renderDock(st) {
    const host = document.getElementById('dockRows');
    const sec = document.getElementById('dockSec');
    if (!host || !sec) return;
    const rows = dockRows(st);
    sec.hidden = !rows.length;
    syncScaleRow(st);
    bindScaleRow();
    host.innerHTML = rows.map(({ pid, acc }) => dockRowHtml(pid, acc)).join('');
    host.querySelectorAll('.dock-row').forEach((el) => {
      const sel = el.querySelector('select.dmetric');
      if (sel) sel.addEventListener('change', () => {
        const inp = el.querySelector('.dbudget input');
        if (inp) inp.placeholder = budgetPlaceholder(sel.value);   // 立刻换占位，不等主进程回包
        saveDockRow(el);
      });
      // 金额框的 change（失焦 / 回车都会发）也保存；读的是当前下拉，所以改口径不会顺带清预算
      const inp = el.querySelector('.dbudget input');
      if (inp) inp.addEventListener('change', () => saveDockRow(el));
      const shw = el.querySelector('select.dshow');
      if (shw) shw.addEventListener('change', () => saveDockRow(el));
    });
  }

  /** 回填（不重建）：口径 / 金额 / 占位 / 提示 / 圆圈大小跟着状态走 */
  function fillDock(st) {
    const host = document.getElementById('dockRows');
    const sec = document.getElementById('dockSec');
    if (!host || !sec) return;
    const rows = dockRows(st);
    sec.hidden = !rows.length;
    syncScaleRow(st);
    const byId = new Map(rows.map((r) => [r.acc.id, r]));
    host.querySelectorAll('.dock-row').forEach((el) => {
      const hit = byId.get(el.dataset.id);
      if (hit) syncDockRow(el, hit.pid, hit.acc);   // 账户没了 / 停用了：那一行等结构指纹那一拍重建
    });
  }

  /** 保存被拒时的行内提示：跟表单的 showFormError 一个思路（⚠ + 行内一行小字，不弹 alert）。
   *  `.formerr` 的红字样式选择器限定在 `.acc-form` 里，这里再挂 `.hintline` 借设置页的小字呈现。 */
  function showDockError(row, msg) {
    let el = row.querySelector('.formerr');
    if (!el) {
      el = document.createElement('p');
      el.className = 'formerr hintline';
      row.appendChild(el);
    }
    el.textContent = '⚠ ' + msg;
  }

  /** 保存一行的口径（金额框也走这里）。口径与预算先按 lib/dock-metric.js 规范化：
   *  空 / 0 / 负数 / 非数字 → null（未设预算）。清空输入框只能发生在成功分支里 ——
   *  被拒时（如账户恰在保存瞬间被删）输入框原样留着：界面显示的那份，必须还是用户刚输入、
   *  也确实没存上的那份；静默清空会让用户以为存上了。成功才闪「已保存」。 */
  async function saveDockRow(el) {
    const sel = el.querySelector('select.dmetric');
    const inp = el.querySelector('.dbudget input');
    const shw = el.querySelector('select.dshow');
    const cur = DOCKM.normalize(el.dataset.pid, { metric: sel ? sel.value : null, budget: inp ? inp.value : null, show: shw ? shw.value : null });
    const next = await window.glm.accDock({ id: el.dataset.id, metric: cur.metric, budget: cur.budget, show: cur.show });
    if (next && !next.err) {
      const old = el.querySelector('.formerr');
      if (old) old.remove();                         // 这次成功了，上一次留下的报错收走
      if (inp && cur.budget == null) inp.value = ''; // 非法 / 空：输入框清空（存下的就是「未设预算」）
      window.GLMPUI.applyState(next);
      window.GLMPUI.flashSaved();
    } else if (next && next.err) {
      showDockError(el, next.err);
    }
  }

  /** 剪贴板识别：peek = { [pid]: { [credKey]: 值 } }；给匹配的输入框挂一键填入 */
  function peek(host, peekResult) {
    if (!peekResult || typeof peekResult !== 'object') return;
    host.querySelectorAll('form.acc-form textarea[data-cred]').forEach((ta) => {
      const form = ta.closest('form');
      const pid = form.dataset.pid;
      const val = (peekResult[pid] || {})[ta.dataset.cred] || '';
      const chip = form.querySelector(`.clipchip[data-for="${ta.id}"]`);
      if (!chip) return;
      if (val && ta.value.trim() !== val) {
        chip.textContent = '⟳ 检测到剪贴板中的凭据，点击填入';
        chip.classList.add('show');
        chip.onclick = () => {
          ta.value = val;
          chip.classList.remove('show');
          ta.focus();
        };
      } else {
        chip.classList.remove('show');
      }
    });
  }

  window.GLMPSETTINGS = { render, fill, peek, isEditing, takeRenderRequest };
})();
