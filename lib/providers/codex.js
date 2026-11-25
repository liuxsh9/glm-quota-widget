'use strict';
/**
 * OpenAI Codex（ChatGPT 订阅套餐）的主进程实现。
 *
 * 纯数据/网络层，不碰 Electron——提醒只以 notes 数据返回，由 main.js 统一弹。
 *
 * 凭据三种来源（select 字段 source）：
 *   paste —— 用户把另一台机器上 ~/.codex/auth.json 的内容（或其中的 access_token）粘进来
 *   ssh   —— 每次拉取通过本机 ssh 免密重读远程的 ~/.codex/auth.json（免复制、自动跟远程续期）
 *   local —— 每次拉取都重读本机的 ~/.codex/auth.json（本机 Codex CLI 会自己续期，挂件跟着用新的）
 * 为什么不拿 refresh_token 自己续期：见 lib/codex.js 头注释（会把原机器上的 Codex 登出）。
 */
const { fetchUsage, readLocalAuth, readSshAuth, localAuthPath } = require('../codex');
const { parseSshTarget } = require('../ssh');
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
function fixHint(source, sshHost) {
  if (source === 'local') return '在这台电脑上运行一次 codex（会自动续期），或重新 codex login';
  if (source === 'ssh') return `到远程主机 ${sshHost || ''} 上运行一次 codex（会自动续期，无需重新复制），或确认本机能免密 ssh ${sshHost || '<主机>'}`;
  return '到登录了 Codex 的机器上运行一次 codex（会自动续期），再把 ~/.codex/auth.json 重新粘贴过来';
}

module.exports = {
  /** 粘贴内容 → 干净凭据（main 的账户写入与剪贴板识别共用）。source 是枚举，sshTarget 走 validate */
  extractors: { accessToken: extractCodexToken },

  /**
   * 拉取配额 + 阈值/重置/将过期提醒。
   * @param {object} creds { source: 'paste'|'ssh'|'local', sshTarget?, accessToken? }
   * @param {object} ctx  { fetchImpl, readImpl, execImpl, accountName, config, prev, prevKind, alertState, mem, now }
   */
  async fetch(creds, ctx) {
    const notes = [];
    const source = creds.source === 'local' ? 'local' : creds.source === 'ssh' ? 'ssh' : 'paste';
    let token = creds.accessToken;
    let sshHost = null;
    if (source === 'local') {
      const file = ctx.authPath || localAuthPath();
      const r = readLocalAuth(file, ctx.readImpl);
      if (r.err) return { ok: false, kind: r.err.kind, msg: r.err.msg, notes };
      token = r.token;
    } else if (source === 'ssh') {
      if (!String(creds.sshTarget || '').trim()) return { ok: false, kind: 'empty', msg: '', notes };
      const r = await readSshAuth(creds.sshTarget, ctx.execImpl);
      if (r.err) {
        if (r.err.kind === 'expired' && !ctx.mem.notified.expired) {
          notes.push({ title: ctx.accountName + 'Codex 凭据已失效', body: r.err.msg });
          ctx.mem.notified.expired = true;
        }
        return { ok: false, kind: r.err.kind, msg: r.err.msg, notes };
      }
      token = r.token;
      sshHost = r.host;
    } else if (!token) {
      return { ok: false, kind: 'empty', msg: '', notes };
    }

    const r = await fetchUsage(token, ctx.fetchImpl, ctx.now);
    if (!r.ok) {
      if (r.kind === 'expired') {
        if (!ctx.mem.notified.expired) {
          notes.push({ title: ctx.accountName + 'Codex 凭据已失效', body: fixHint(source, sshHost) });
          ctx.mem.notified.expired = true;
        }
        return { ok: false, kind: 'expired', msg: `${r.msg}——${fixHint(source, sshHost)}`, notes };
      }
      return { ok: false, kind: r.kind, msg: r.msg, notes };
    }

    const data = { ...r.data, source, ...(sshHost ? { sshHost } : {}) };
    ctx.mem.notified.expired = false;
    // 5 小时窗口不一定有（2026 年年中改版后 Plus 只剩周窗口）：重置提醒盯最短的那个已知窗口
    const resetKey = WINDOWS.map((w) => w.key).find((k) => data[k] && data[k].known) || 'week';
    notes.push(...quotaAlerts(data, ctx, WINDOWS, { ...byResetTime, resetKey }));
    if (ctx.prevKind === 'expired') {
      notes.push({ title: ctx.accountName + 'Codex 凭据已恢复', body: '用量数据恢复正常刷新' });
    }
    // 粘贴来的令牌快过期了：提前说一声（本机 / SSH 来源每次都读远程或本机最新文件，不吵）。
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
    if (creds.source === 'ssh') {
      const p = parseSshTarget(creds.sshTarget);
      return p.ok ? '' : p.msg;
    }
    if (creds.source === 'local') return '';
    return !creds.accessToken
      ? '「粘贴 auth.json」模式要粘贴 auth.json 内容或 access_token；也可以把「凭据来源」改成「SSH 远程」或「读本机」'
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
