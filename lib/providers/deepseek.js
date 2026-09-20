'use strict';
/**
 * DeepSeek 的主进程实现：余额 + 平台账单两条**互相独立**的链路，各自降级。
 * 纯数据/网络层，不碰 Electron；per-account 的样本历史经 ctx.store 读写
 * （store = { samples, setSamples(next), save() }），平台账单的运行态草稿放
 * ctx.mem（不落盘、不广播）。
 *
 * fetch() 返回统一的 { ok, kind, msg, data, notes }：
 *   - ok/kind/msg 只反映**余额链路**（主状态）；平台账单的状态在 data.platform 子对象里
 *   - notes 是该家自己的提醒策略（失效/恢复），main 只负责弹，不理解语义
 */
const { fetchBalance, fetchMonthlyCost, fetchMonthlyAmount, extractDsToken, extractPlatformToken } = require('../deepseek');
const dsHistory = require('../ds-history');

/** 平台账单要拉的月份：当前月 + 上个月（上月补全「近 30 天」跨月的部分） */
function monthsFor(now) {
  const cur = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const pm = new Date(Date.UTC(cur.year, cur.month - 2, 1));
  return [cur, { year: pm.getUTCFullYear(), month: pm.getUTCMonth() + 1 }];
}

/** 汇总（平台账单优先，本地差值兜底）+ 组装广播用的 data */
function assemble(balance, ctx, platformOut) {
  const days = ctx.config.dsRange === '30d' ? 30 : 7;
  const samples = ctx.store.samples;
  const bal = balance ? balance.total : null;
  const summary = (ctx.mem.costMonths && ctx.mem.costMonths.length)
    ? dsHistory.summarizePlatform(ctx.mem.costMonths, ctx.now, { days, balance: bal, samples })
    : dsHistory.summarize(samples, ctx.now, { days, balance: bal });
  return {
    balance,
    summary,
    tokens: ctx.mem.amount || null,   // 本月 token 分类（需平台令牌）
    platform: platformOut,
  };
}

/** 记一个余额样本（内部抽稀；值没变的轮询不落盘） */
function recordSample(ctx, ts, total) {
  const next = dsHistory.appendSample(ctx.store.samples, ts, total);
  if (next === ctx.store.samples) return;
  ctx.store.setSamples(next);
  ctx.store.save();
}

/** 平台账单链路：成功更新 mem，失败只降级这一路（余额与本地差值口径照常工作） */
async function platformChain(creds, ctx, notes) {
  const out = { status: 'loading', msg: '', lastFetchAt: 0 };
  const [cur, prev] = monthsFor(new Date(ctx.now));
  const [c0, c1, amt] = await Promise.all([
    fetchMonthlyCost(creds.platformToken, cur, ctx.fetchImpl),
    fetchMonthlyCost(creds.platformToken, prev, ctx.fetchImpl),
    fetchMonthlyAmount(creds.platformToken, cur, ctx.fetchImpl),
  ]);
  out.lastFetchAt = Date.now();
  if (c0.ok) {
    ctx.mem.costMonths = [c0.data, c1.ok ? c1.data : null].filter(Boolean);
    ctx.mem.amount = amt.ok ? amt.data : null;
    out.status = 'ok'; out.msg = '';
    if (ctx.prevPlatform === 'expired') notes.push({ title: ctx.accountName + 'DeepSeek 账单已恢复', body: '精确用量数据恢复正常刷新' });
    ctx.mem.notified.platformExpired = false;
    return out;
  }
  ctx.mem.costMonths = null; ctx.mem.amount = null;
  if (c0.kind === 'expired') {
    out.status = 'expired'; out.msg = c0.msg;
    if (!ctx.mem.notified.platformExpired) {
      notes.push({
        title: ctx.accountName + 'DeepSeek 平台会话已过期',
        body: '精确账单已退回本地累计，重新获取 userToken 可恢复',
      });
      ctx.mem.notified.platformExpired = true;
    }
    return out;
  }
  out.status = c0.kind === 'ratelimit' ? 'ratelimit' : 'error';
  out.msg = c0.msg;
  return out;
}

/** 余额链路的公共主体（fetch 与高频 poll 共用） */
async function balanceChain(creds, ctx, notes) {
  const r = await fetchBalance(creds.apiKey, ctx.fetchImpl);
  if (r.ok) {
    recordSample(ctx, r.data.fetchedAt, r.data.total);
    if (ctx.prevKind === 'expired') notes.push({ title: ctx.accountName + 'DeepSeek 已恢复', body: '余额数据恢复正常刷新' });
    ctx.mem.notified.expired = false;
    return { ok: true, balance: r.data };
  }
  if (r.kind === 'expired') {
    if (!ctx.mem.notified.expired) {
      notes.push({ title: ctx.accountName + 'DeepSeek API Key 已失效', body: '点击挂件更新 API Key' });
      ctx.mem.notified.expired = true;
    }
  }
  return { ok: false, kind: r.kind, msg: r.msg };
}

module.exports = {
  /** 具备高频余额采样能力：main 据此把该家账户排进 dsPollMin 的快轮询 */
  pollable: true,

  /** 粘贴内容 → 干净凭据（main 的账户写入与剪贴板识别共用；缺键返回空串） */
  extractors: { apiKey: extractDsToken, platformToken: extractPlatformToken },

  /**
   * 主周期完整拉取：余额 + 平台账单（并行）+ 汇总。
   * @param {object} creds { apiKey, platformToken? }
   * @param {object} ctx  { fetchImpl, accountName, config, prev, prevKind, prevPlatform, mem, store, now }
   */
  async fetch(creds, ctx) {
    const notes = [];
    if (!creds.apiKey) {
      ctx.mem.costMonths = null; ctx.mem.amount = null;
      return {
        ok: false, kind: 'empty', msg: '',
        data: assemble(null, ctx, { status: 'empty', msg: '', lastFetchAt: 0 }),
        notes,
      };
    }
    // 平台账单与余额并行；账单挂掉只降级自己
    const [bal, platform] = await Promise.all([
      balanceChain(creds, ctx, notes),
      creds.platformToken ? platformChain(creds, ctx, notes)
        : Promise.resolve({ status: 'empty', msg: '', lastFetchAt: 0 }),
    ]);
    if (!creds.platformToken) { ctx.mem.costMonths = null; ctx.mem.amount = null; }
    const balance = bal.ok ? bal.balance : ((ctx.prev && ctx.prev.balance) || null);
    const data = assemble(balance, ctx, platform);
    return bal.ok
      ? { ok: true, data, notes }
      : { ok: false, kind: bal.kind, msg: bal.msg, data, notes };
  },

  /**
   * 高频轮询：只拉余额、只记样本、只重算汇总（平台账单是私有接口，要克制）。
   * 返回里 data.platform 沿用上次状态，UI 不闪「加载中」。
   */
  async pollBalance(creds, ctx) {
    const notes = [];
    const r = await balanceChain(creds, ctx, notes);
    const balance = r.ok ? r.balance : ((ctx.prev && ctx.prev.balance) || null);
    const platform = (ctx.prev && ctx.prev.platform) || { status: 'empty', msg: '', lastFetchAt: 0 };
    const data = assemble(balance, ctx, platform);
    return r.ok ? { ok: true, data, notes } : { ok: false, kind: r.kind, msg: r.msg, data, notes };
  },
};
