'use strict';
/**
 * GLM Coding Plan 的主进程实现：拉取 + 提醒策略。
 * 纯数据/网络层，不碰 Electron——通知只以 notes 数据返回，由 main.js 统一弹，
 * 这样多账户只是「多调几次 fetch」。
 */
const { fetchUsage, extractToken } = require('../usage');
const { normWarn, fmtPoints, fmtResetTime, tierOfPair } = require('../format');

module.exports = {
  /** 粘贴内容 → 干净凭据（main 的账户写入与剪贴板识别共用） */
  extractors: { token: extractToken },
  /**
   * 主周期拉取 + 阈值/重置提醒。
   * 两个窗口共用同一阈值，各自跨线各提醒一次，按 windowStart 去重
   * （写入 ctx.alertState，随配置持久化，重启不重复提醒）。
   * @param {object} creds { token }
   * @param {object} ctx  { fetchImpl, accountName, config, prev, prevKind, alertState, now }
   * @returns {{ok:true,data}|{ok:false,kind,msg}, notes:{title,body}[], changed:boolean}
   */
  async fetch(creds, ctx) {
    const r = await fetchUsage(creds.token, ctx.fetchImpl);
    const notes = [];
    let changed = false;
    if (r.ok) {
      notes.push(...this.quotaAlerts(r.data, ctx));
      changed = ctx.changed === true;
      if (ctx.prevKind === 'expired') notes.push({ title: ctx.accountName + 'Token 已恢复', body: '用量数据恢复正常刷新' });
    } else if (r.kind === 'expired' && !ctx.mem.notified.expired) {
      notes.push({ title: ctx.accountName + 'Token 已失效', body: '点击挂件更新 Token' });
      ctx.mem.notified.expired = true;
      changed = true;
    }
    return { ...r, notes, changed };
  },

  /** 阈值提醒 + 重置回满提醒（从数据推导，fetch 成功后调用） */
  quotaAlerts(data, ctx) {
    const config = ctx.config || {};
    const prev = ctx.prev;
    const alertState = ctx.alertState || (ctx.alertState = {});
    const who = ctx.accountName || '';
    const out = [];
    const w = normWarn(config.warnThreshold);
    const checks = [
      { key: 'five', win: data.five, name: '5小时额度' },
      { key: 'week', win: data.week, name: '周额度' },
    ];
    const hits = [];
    for (const c of checks) {
      if (!c.win || c.win.windowStart == null) continue;
      if (c.win.percent < w || alertState[c.key] === c.win.windowStart) continue;
      alertState[c.key] = c.win.windowStart;
      ctx.changed = true;
      hits.push(c);
    }
    if (hits.length) {
      const reset = (win) => (win.nextResetTime ? `${fmtResetTime(win.nextResetTime)} 重置` : '重置时间未知');
      out.push({
        title: who + hits.map((c) => `${c.name}已用 ${c.win.percent}%`).join(' · '),
        body: hits.map((c) => `剩余 ${fmtPoints(c.win.remaining)} · ${reset(c.win)}`).join('\n'),
      });
    }
    // 重置回满提醒：窗口滚动且此前用量过半（windowStart 天然去重）
    if (config.notifyReset && prev && prev.five &&
        prev.five.windowStart !== data.five.windowStart && prev.five.percent >= 50) {
      out.push({ title: who + '5小时额度已重置', body: '新窗口已开启，额度回满' });
    }
    return out;
  },

  /** 该账户的危险档位（胶囊/托盘聚合取各账户最差档） */
  tier(data, warnAt) {
    return data ? tierOfPair(data.five.percent, data.week.percent, warnAt) : 'low';
  },
};
