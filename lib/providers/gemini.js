'use strict';
/**
 * Google Gemini（Antigravity 套餐）的主进程实现。
 *
 * 纯数据/命令层，不碰 Electron——提醒只以 notes 数据返回，由 main.js 统一弹。
 *
 * 两种来源（select 字段 source）：
 *   local —— 直接运行本机的 `agy -p /usage --output-format json`
 *   ssh   —— 通过本机 ssh 免密执行远程机器上的 `agy -p /usage --output-format json`
 * 均只读、零额度消耗，无需导出/粘贴会过期的 OAuth 凭据。
 */
const { fetchUsage, parseSshTarget, validateAgyPath } = require('../gemini');
const { tierOf } = require('../format');
const { quotaAlerts, byResetTime } = require('./quota-alerts');

const WINDOWS = [
  { key: 'five', name: '5小时额度' },
  { key: 'week', name: '周额度' },
  { key: 'month', name: '月额度' },
];

const RANK = { low: 0, mid: 1, high: 2 };

function fixHint(source, sshHost) {
  return source === 'ssh'
    ? `请确认本机能免密 ssh ${sshHost || '<主机>'}，并在远程机器上运行 agy 完成登录`
    : '请在这台电脑上运行一次 agy 完成登录';
}

module.exports = {
  /** sshTarget / agyPath 在 validate 里做精确校验与报错，不参与剪贴板自动识别 */
  extractors: {},

  /**
   * 拉取配额 + 阈值 / 重置提醒。
   * @param {object} creds { source: 'local'|'ssh', sshTarget?, group?: 'gemini'|'3p', agyPath? }
   * @param {object} ctx   { execImpl, accountName, config, prev, prevKind, alertState, mem, now, platform }
   */
  async fetch(creds, ctx) {
    const notes = [];
    const source = creds.source === 'ssh' ? 'ssh' : 'local';
    if (source === 'ssh' && !String(creds.sshTarget || '').trim()) {
      return { ok: false, kind: 'empty', msg: '', notes };
    }

    const r = await fetchUsage({
      source,
      sshTarget: creds.sshTarget,
      group: creds.group === '3p' ? '3p' : 'gemini',
      agyPath: creds.agyPath,
    }, ctx.execImpl, ctx.now, ctx.platform);

    if (!r.ok) {
      if (r.kind === 'expired') {
        const parsed = source === 'ssh' ? parseSshTarget(creds.sshTarget) : null;
        const hint = fixHint(source, parsed && parsed.ok ? parsed.host : '');
        if (!ctx.mem.notified.expired) {
          notes.push({ title: ctx.accountName + 'Gemini 登录已失效', body: hint });
          ctx.mem.notified.expired = true;
        }
        const msg = r.msg.includes('ssh ') || r.msg.includes('登录') && r.msg.includes('——')
          ? r.msg
          : `${r.msg}——${hint}`;
        return { ok: false, kind: 'expired', msg, notes };
      }
      return { ok: false, kind: r.kind, msg: r.msg, notes };
    }

    const data = r.data;
    ctx.mem.notified.expired = false;
    const resetKey = WINDOWS.map((w) => w.key).find((k) => data[k] && data[k].known) || 'five';
    notes.push(...quotaAlerts(data, ctx, WINDOWS, { ...byResetTime, resetKey }));
    if (ctx.prevKind === 'expired') {
      notes.push({ title: ctx.accountName + 'Gemini 登录已恢复', body: '用量数据恢复正常刷新' });
    }
    return { ok: true, data, notes };
  },

  /** 跨字段校验（main 的账户增改调用）：返回错误文案，空串 = 通过 */
  validate(creds) {
    if (creds.source === 'ssh') {
      const p = parseSshTarget(creds.sshTarget);
      if (!p.ok) return p.msg;
    }
    const ap = validateAgyPath(creds.agyPath);
    if (!ap.ok) return ap.msg;
    return '';
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
};
