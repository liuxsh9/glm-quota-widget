'use strict';
/**
 * 火山方舟 Coding Plan / Agent Plan 的主进程实现。
 *
 * 纯数据/网络层，不碰 Electron——提醒只以 notes 数据返回，由 main.js 统一弹。
 *
 * 与 glm.js 的差别集中在两处：
 *   ① 凭据是 AK/SK 一对（走火山签名 V4），不是单个 key
 *   ② 一个 AK/SK 下面可能同时订了两种套餐，所以要「探测 + 可固定」
 */
const { fetchPlan } = require('../volc');
const { tierOf } = require('../format');
const { extractVolcAk, extractVolcSecret } = require('../tokens');
const { quotaAlerts } = require('./quota-alerts');

const WINDOWS = [
  { key: 'five', name: '5小时额度' },
  { key: 'week', name: '周额度' },
  { key: 'month', name: '月额度' },
];

const RANK = { low: 0, mid: 1, high: 2 };

/**
 * 窗口身份：把重置时间按窗口长度分桶。
 *
 * 不能拿推导出来的 windowStart 当身份——服务端每次把重置时间微调几秒，身份就变一次，
 * 于是每次刷新都判成「新窗口」：跨阈值提醒反复弹、重置提醒也反复弹（10 分钟一刷 = 一天 144 次）。
 * 分桶后窗口内恒定，翻窗时正好 +1。
 */
const winIdOf = (w) => (w && w.nextResetTime != null && w.windowMs > 0
  ? Math.floor(w.nextResetTime / w.windowMs)
  : null);

/**
 * 是否翻窗：重置时间**向前跳了半个窗口以上**。
 * 固定档期的窗口翻窗时正好跳一整个窗口 ✓；滑动窗口只会跳一个轮询间隔，被正确抑制 ✗。
 */
const rolledOf = (p, c) => (p && c && p.nextResetTime != null && c.nextResetTime != null
  ? (c.nextResetTime - p.nextResetTime) >= 0.5 * (c.windowMs || p.windowMs || 0)
  : false);

module.exports = {
  /** 粘贴内容 → 干净凭据（main 的账户写入与剪贴板识别共用） */
  extractors: { accessKeyId: extractVolcAk, accessKeySecret: extractVolcSecret },

  /**
   * 拉取配额 + 阈值/重置提醒。
   * @param {object} creds { accessKeyId, accessKeySecret, plan?: 'auto'|'coding'|'agent' }
   * @param {object} ctx  { fetchImpl, accountName, config, prev, prevKind, alertState, mem, now }
   */
  async fetch(creds, ctx) {
    const notes = [];
    if (!creds.accessKeyId || !creds.accessKeySecret) {
      return { ok: false, kind: 'empty', msg: '', notes };
    }

    // 套餐：固定了就只查这一种；自动则两种都查。
    // 自动模式下**必须两种都查**才能发现「两种都订阅了」——那是要提示用户去固定的场景。
    // 两个都是便宜的控制面只读接口，多一次 RPC 换一个准确判断，划算。
    const pin = creds.plan === 'coding' || creds.plan === 'agent' ? creds.plan : null;
    const kinds = pin ? [pin] : ['coding', 'agent'];
    const results = await Promise.all(kinds.map((k) => fetchPlan(k, creds, ctx.fetchImpl, ctx.now)));
    const good = results.filter((r) => r.ok && r.data.subscribed);

    if (!good.length) {
      // 一个都没订上。但若其中有**真错误**（网络/鉴权/限流），要报错误而不是「未订阅」——
      // 把「查不到」说成「没买」会让人去翻订单，白折腾一场。
      const bad = results.find((r) => !r.ok);
      if (bad) return { ok: false, kind: bad.kind, msg: bad.msg, notes };
      return {
        ok: false, kind: 'nosub', notes,
        msg: pin
          ? `这个账号没有开通 ${pin === 'coding' ? 'Coding' : 'Agent'} Plan——检查套餐类型是否选错，或换一个账号`
          : '这个账号没有开通 Coding Plan 或 Agent Plan',
      };
    }

    // 自动模式优先 Coding（kinds 的顺序），并把「另一种也订了」带出去提示用户
    const pick = good[0];
    const failed = results.find((r) => !r.ok);
    const data = {
      plan: pick.data.plan,
      level: pick.data.level || null,
      five: pick.data.windows.five,
      week: pick.data.windows.week,
      month: pick.data.windows.month,
      fetchedAt: pick.data.fetchedAt,
      bothSubscribed: !pin && good.length > 1,
      warn: failed ? failed.msg : '',
    };

    notes.push(...quotaAlerts(data, ctx, WINDOWS, { winId: winIdOf, rolled: rolledOf }));
    if (ctx.prevKind === 'expired') {
      notes.push({ title: ctx.accountName + '火山方舟凭据已恢复', body: '用量数据恢复正常刷新' });
    }
    return { ok: true, data, notes };
  },

  /** 该账户的危险档位（三个窗口取最差；缺数据的窗口不参与） */
  tier(data, warnAt) {
    if (!data) return 'low';
    let worst = 'low';
    for (const c of WINDOWS) {
      const w = data[c.key];
      if (!w || !w.known) continue;
      const t = tierOf(w.percent, warnAt);
      if (RANK[t] > RANK[worst]) worst = t;
    }
    return worst;
  },
};
