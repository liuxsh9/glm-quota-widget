'use strict';
/**
 * GLM Coding Plan 的主进程实现：拉取 + 提醒策略。
 * 纯数据/网络层，不碰 Electron——通知只以 notes 数据返回，由 main.js 统一弹，
 * 这样多账户只是「多调几次 fetch」。
 */
const { fetchUsage, extractToken } = require('../usage');
const { tierOfPair } = require('../format');
const { quotaAlerts } = require('./quota-alerts');

/** GLM 盯的两个窗口。窗口身份默认取 windowStart，翻窗判定用不等号——即原来的行为 */
const WINDOWS = [
  { key: 'five', name: '5小时额度' },
  { key: 'week', name: '周额度' },
];

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
      notes.push(...quotaAlerts(r.data, ctx, WINDOWS));
      changed = ctx.changed === true;
      if (ctx.prevKind === 'expired') notes.push({ title: ctx.accountName + 'Token 已恢复', body: '用量数据恢复正常刷新' });
    } else if (r.kind === 'expired' && !ctx.mem.notified.expired) {
      notes.push({ title: ctx.accountName + 'Token 已失效', body: '点击挂件更新 Token' });
      ctx.mem.notified.expired = true;
      changed = true;
    }
    return { ...r, notes, changed };
  },

  /** 阈值提醒 + 重置回满提醒（策略见 lib/providers/quota-alerts.js） */
  quotaAlerts(data, ctx) {
    return quotaAlerts(data, ctx, WINDOWS);
  },

  /** 该账户的危险档位（胶囊/托盘聚合取各账户最差档） */
  tier(data, warnAt) {
    return data ? tierOfPair(data.five.percent, data.week.percent, warnAt) : 'low';
  },
};
