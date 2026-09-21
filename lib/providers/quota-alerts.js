'use strict';
/**
 * 配额型 provider 共用的提醒策略：阈值跨线 + 窗口重置回满。
 *
 * 从 glm.js 里提出来，因为火山方舟是同一类问题（几个滚动窗口、各自一条线），
 * 但不能原样照搬，有两处差异必须由调用方说清：
 *
 *   1. **窗口身份**（winId）。去重要记「这一轮提醒过哪个窗口」，所以要一个窗口内稳定、
 *      翻窗时必变的身份。GLM 直接用服务端给的 windowStart；火山只有「下次重置时间」，
 *      而且那是推导出来的、会随服务端微调而抖动 —— 抖动一次就弹一次通知（10 分钟一刷
 *      的话一天弹 144 次）。火山的做法是把重置时间按窗口长度分桶取整（见 volc.js）。
 *
 *   2. **是否翻窗**（rolled）。GLM 用 `windowStart !== windowStart`；火山用「重置时间向前
 *      跳了半个窗口」——同样是抗抖动。
 *
 * 两者的默认值就是 GLM 原来的行为，所以 GLM 那边的提醒文案与时机逐字不变
 * （test/providers.test.js 里那批 GLM 用例就是回归网）。
 */
const { normWarn, fmtPoints, fmtResetTime } = require('../format');

/**
 * @param {object} data 当前账户数据（含各窗口）
 * @param {object} ctx  provider fetch 的 ctx（用到 config / prev / accountName / alertState）
 * @param {Array<{key:string,name:string}>} windows 要盯的窗口，name 进通知文案
 * @param {object} [opts] { winId, rolled, resetKey }
 * @returns {Array<{title,body}>} 通知列表
 */
function quotaAlerts(data, ctx, windows, opts) {
  const o = opts || {};
  const winId = o.winId || ((w) => (w ? w.windowStart : null));
  const rolled = o.rolled || ((p, c) => winId(p) !== winId(c));
  const resetKey = o.resetKey || 'five';

  const config = ctx.config || {};
  const prev = ctx.prev;
  const alertState = ctx.alertState || (ctx.alertState = {});
  const who = ctx.accountName || '';
  const out = [];
  const warn = normWarn(config.warnThreshold);

  const hits = [];
  for (const c of windows) {
    const win = data[c.key];
    const id = win ? winId(win) : null;
    if (!win || id == null) continue;
    if (win.percent < warn || alertState[c.key] === id) continue;
    alertState[c.key] = id;
    ctx.changed = true;
    hits.push({ ...c, win });
  }
  if (hits.length) {
    out.push({
      title: who + hits.map((c) => `${c.name}已用 ${c.win.percent}%`).join(' · '),
      // 有绝对值就报绝对剩余；没有（火山 Coding Plan 只返回百分比）退回百分比。
      // 注意不能直接 fmtPoints(remaining)——undefined 会算出 0，通知就成了「剩余 0」。
      body: hits.map((c) => {
        const w = c.win;
        const left = w.remaining != null ? fmtPoints(w.remaining) : `${Math.max(0, 100 - w.percent)}%`;
        return `剩余 ${left} · ${w.nextResetTime ? `${fmtResetTime(w.nextResetTime)} 重置` : '重置时间未知'}`;
      }).join('\n'),
    });
  }

  // 重置回满提醒：窗口滚动且此前用量过半（身份变化天然去重）
  const cur = data[resetKey];
  const old = prev && prev[resetKey];
  if (config.notifyReset && old && cur && rolled(old, cur) && old.percent >= 50) {
    const name = (windows.find((c) => c.key === resetKey) || {}).name || '额度';
    out.push({ title: who + `${name}已重置`, body: '新窗口已开启，额度回满' });
  }
  return out;
}

module.exports = { quotaAlerts };
