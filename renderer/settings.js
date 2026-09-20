'use strict';
/* 设置页的 provider 段落渲染：账户列表 + 添加/编辑表单 + 该家专属的全局控件。
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

  const STATE_CLASS = { ok: 'ok', expired: 'bad', error: 'bad', ratelimit: 'bad', empty: 'na', loading: 'na', boot: 'na' };
  const STATE_WORD = {
    ok: '有效', expired: '已失效', error: '更新失败', ratelimit: '限流',
    empty: '未配置', loading: '验证中…', boot: '验证中…',
  };

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
    const tails = Object.entries(a.creds)
      .filter(([, c]) => c.set)
      .map(([, c]) => `…${c.tail}`)
      .join(' · ');
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
      <p class="hintline">到阈值进度条变琥珀并弹通知；再高 10 个点变红。</p>
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
      form.querySelectorAll('textarea[data-cred]').forEach((ta) => {
        ta.addEventListener('input', () => {
          const chip = form.querySelector(`.clipchip[data-for="${ta.id}"]`);
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
      const tails = Object.entries(a.creds).filter(([, c]) => c.set).map(([, c]) => `…${c.tail}`).join(' · ');
      row.querySelector('.atail').textContent = tails;
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
