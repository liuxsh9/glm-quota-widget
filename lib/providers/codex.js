'use strict';
/**
 * OpenAI Codex（ChatGPT 订阅套餐）的主进程实现。
 *
 * 纯数据/网络层，不碰 Electron——提醒只以 notes 数据返回，由 main.js 统一弹。
 *
 * 凭据两种来源（select 字段 source）：
 *   paste —— 用户把**另一台机器**上 ~/.codex/auth.json 的内容（或其中的 access_token）粘进来。
 *            这是主场景：Codex 登录在服务器上，挂件跑在自己的 PC 上
 *   local —— 每次拉取都重读本机的 ~/.codex/auth.json（本机 Codex CLI 会自己续期，挂件跟着用新的）
 * 为什么不拿 refresh_token 自己续期：见 lib/codex.js 头注释（会把原机器上的 Codex 登出）。
 */
const { fetchUsage, readLocalAuth, localAuthPath } = require('../codex');
const { tierOf } = require('../format');
const { extractCodexToken } = require('../tokens');
const { quotaAlerts, byResetTime } = require('./quota-alerts');

const WINDOWS = [
  { key: 'five', name: '5小时额度' },
  { key: 'week', name: '周额度' },
  { key: 'month', name: '月额度' },
];

const RANK = { low: 0, mid: 1, high: 2 };
const DAY = 86400e3;
/** 离过期不到这么久就提醒（通知一次 + 面板脚注变色）。access_token 一共约 10 天 */
const EXP_WARN_MS = 2 * DAY;

/** 失效时的「怎么办」：按凭据来源给不同的出路 */
function fixHint(source) {
  return source === 'local'
    ? '在这台电脑上运行一次 codex（会自动续期），或重新 codex login'
    : '到登录了 Codex 的机器上运行一次 codex（会自动续期），再把 ~/.codex/auth.json 重新粘贴过来';
}

module.exports = {
  /** 粘贴内容 → 干净凭据（main 的账户写入与剪贴板识别共用）。source 是枚举，不走提取 */
  extractors: { accessToken: extractCodexToken },

  /**
   * 拉取配额 + 阈值/重置/将过期提醒。
   * @param {object} creds { source: 'paste'|'local', accessToken? }
   * @param {object} ctx  { fetchImpl, accountName, config, prev, prevKind, alertState, mem, now }
   */
  async fetch(creds, ctx) {
    const notes = [];
    const source = creds.source === 'local' ? 'local' : 'paste';
    let token = creds.accessToken;
    if (source === 'local') {
      const file = ctx.authPath || localAuthPath();
      const r = readLocalAuth(file, ctx.readImpl);
      if (r.err) return { ok: false, kind: r.err.kind, msg: r.err.msg, notes };
      token = r.token;
    } else if (!token) {
      return { ok: false, kind: 'empty', msg: '', notes };
    }

    const r = await fetchUsage(token, ctx.fetchImpl, ctx.now);
    if (!r.ok) {
      if (r.kind === 'expired') {
        if (!ctx.mem.notified.expired) {
          notes.push({ title: ctx.accountName + 'Codex 凭据已失效', body: fixHint(source) });
          ctx.mem.notified.expired = true;
        }
        return { ok: false, kind: 'expired', msg: `${r.msg}——${fixHint(source)}`, notes };
      }
      return { ok: false, kind: r.kind, msg: r.msg, notes };
    }

    const data = { ...r.data, source };
    ctx.mem.notified.expired = false;
    // 5 小时窗口不一定有（2026 年年中改版后 Plus 只剩周窗口）：重置提醒盯最短的那个已知窗口
    const resetKey = WINDOWS.map((w) => w.key).find((k) => data[k] && data[k].known) || 'week';
    notes.push(...quotaAlerts(data, ctx, WINDOWS, { ...byResetTime, resetKey }));
    if (ctx.prevKind === 'expired') {
      notes.push({ title: ctx.accountName + 'Codex 凭据已恢复', body: '用量数据恢复正常刷新' });
    }
    // 粘贴来的令牌快过期了：提前说一声（本机来源由 Codex CLI 自己续期，不吵）。
    // 按令牌的过期时间去重——换了新令牌会再提醒一次，同一个只提醒一次
    const left = data.tokenExp ? data.tokenExp - (ctx.now || Date.now()) : Infinity;
    if (source === 'paste' && left < EXP_WARN_MS && ctx.alertState.tokenExp !== data.tokenExp) {
      ctx.alertState.tokenExp = data.tokenExp;
      ctx.changed = true;
      notes.push({
        title: ctx.accountName + `Codex 令牌 ${Math.max(1, Math.ceil(left / 3600e3))} 小时后过期`,
        body: fixHint(source),
      });
    }
    return { ok: true, data, notes };
  },

  /** 跨字段校验（main 的账户增改调用）：返回错误文案，空串 = 通过 */
  validate(creds) {
    return creds.source !== 'local' && !creds.accessToken
      ? '「粘贴 auth.json」模式要粘贴 auth.json 内容或 access_token；Codex 登录在这台电脑上的话，把「凭据来源」改成「读本机」'
      : '';
  },

  /** 该账户的危险档位（已知窗口取最差；撞上限额直接 high） */
  tier(data, warnAt) {
    if (!data) return 'low';
    if (data.reached) return 'high';
    let worst = 'low';
    for (const c of WINDOWS) {
      const w = data[c.key];
      if (!w || !w.known) continue;
      const t = tierOf(w.percent, warnAt);
      if (RANK[t] > RANK[worst]) worst = t;
    }
    return worst;
  },

  EXP_WARN_MS,
};
