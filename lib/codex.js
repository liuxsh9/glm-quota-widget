'use strict';
/**
 * OpenAI Codex（ChatGPT 订阅套餐：Plus / Pro / Team …）的配额查询。
 *
 * 纯 Node（只依赖 fs / os / path），不碰 Electron——对标 lib/volc.js。
 *
 * 接口：GET https://chatgpt.com/backend-api/wham/usage
 *   Codex CLI 的 /status 与网页 Settings → Usage 用的是同一个，**只读、不调模型、不耗额度**。
 *   这是 ChatGPT 的**内部接口**，没有公开文档，格式改过（2026 年年中）——见下面 normalize 的取舍。
 *
 * 鉴权：Codex CLI 登录后 ~/.codex/auth.json 里的 tokens.access_token（OpenAI 签发的 JWT），
 *   请求头带 Authorization: Bearer <access_token> + ChatGPT-Account-Id。
 *   account_id 就写在 JWT 的 https://api.openai.com/auth.chatgpt_account_id 里，所以凭据只需要一个 access_token。
 *
 * **不做 refresh_token 续期**（这是刻意的）：OpenAI 的 refresh_token 是一次性的，用一次就轮换。
 *   挂件在另一台机器上拿复制来的 refresh_token 续期，会让原机器上 Codex 手里那份当场作废
 *   （被迫重新 codex login），反之亦然。所以这里只读 access_token（有效期约 10 天），
 *   过期前在面板上提醒、过期后让用户重新复制——不去抢 Codex CLI 的登录态。
 *
 * 输出归一成 GLM / 火山同款的窗口形状（five/week/month），渲染层的配速、幽灵段、超支变色原样复用。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { jwtPayload, extractCodexToken } = require('./tokens');

const API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const AUTH_CLAIM = 'https://api.openai.com/auth';

/** 三个槽位的标称长度（秒）。实际按 limit_window_seconds 归槽，见 slotOf */
const SLOT_SECONDS = { five: 5 * 3600, week: 7 * 86400, month: 30 * 86400 };
const SLOTS = ['five', 'week', 'month'];

/* ---------------- 凭据 ---------------- */

/** 本机 Codex 的 auth.json 路径：与 Codex CLI 一致，CODEX_HOME 优先 */
function localAuthPath(env, home) {
  const e = env || process.env;
  const base = e.CODEX_HOME ? e.CODEX_HOME : path.join(home || os.homedir(), '.codex');
  return path.join(base, 'auth.json');
}

/**
 * 读本机 auth.json → { token } 或 { err: {kind,msg} }。
 * 每次拉取都重读：本机的 Codex CLI 会自己续期并改写这个文件，挂件跟着用最新的就行。
 */
function readLocalAuth(file, readImpl) {
  const read = readImpl || ((f) => fs.readFileSync(f, 'utf8'));
  let text;
  try {
    text = read(file);
  } catch {
    return { err: { kind: 'empty', msg: `本机没找到 ${file}——先在这台电脑上运行 codex 登录 ChatGPT 账号，或改用「粘贴 auth.json」` } };
  }
  let o = null;
  try { o = JSON.parse(text); } catch { /* 下面统一报 */ }
  if (o && !o.tokens && o.OPENAI_API_KEY) {
    return { err: { kind: 'expired', msg: '本机 Codex 是用 API Key 登录的，没有 ChatGPT 套餐额度——运行 codex login 改用 ChatGPT 账号登录' } };
  }
  const token = extractCodexToken(text);
  if (!token) return { err: { kind: 'expired', msg: `${file} 里没有可用的 access_token——重新运行 codex login` } };
  return { token };
}

/** JWT 里的账户信息：{ accountId, plan, exp(ms) }；不是 OpenAI 的 JWT → null */
function tokenInfo(token) {
  const p = jwtPayload(token);
  if (!p) return null;
  const a = p[AUTH_CLAIM] || {};
  return {
    accountId: a.chatgpt_account_id || null,
    plan: a.chatgpt_plan_type || null,
    exp: Number.isFinite(Number(p.exp)) ? Number(p.exp) * 1000 : null,
  };
}

/* ---------------- 响应解析 ---------------- */

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

/**
 * 按窗口长度归槽——**不能按 primary/secondary 的位置认**：2026 年年中改版后 primary 从 5 小时
 * 变成了周，secondary 变成 null；免费号还见过 30 天窗口。长度认不准的（将来再改版）就近归槽
 * （按对数距离：5h 与周差 33 倍，线性距离会把 2 天的窗口判成 5h）。
 */
function slotOf(seconds) {
  const s = Number(seconds);
  if (!(s > 0)) return null;
  let best = null, bestD = Infinity;
  for (const k of SLOTS) {
    const d = Math.abs(Math.log(s / SLOT_SECONDS[k]));
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}

/** 空窗口（percent 恒为数值，见 lib/volc.js 的 mkWindow 注释：null 进 CSS 变量会画成满格） */
function emptyWindow(slot) {
  const ms = SLOT_SECONDS[slot] * 1000;
  return { known: false, percent: 0, used: null, total: null, remaining: null, nextResetTime: null, windowStart: null, windowMs: ms };
}

/** 单个窗口：{ used_percent, limit_window_seconds, reset_after_seconds, reset_at(秒) } */
function mkWindow(w, now) {
  const ms = Number(w.limit_window_seconds) * 1000;
  let reset = Number(w.reset_at) > 0 ? Number(w.reset_at) * 1000
    : Number(w.reset_after_seconds) >= 0 ? now + Number(w.reset_after_seconds) * 1000 : null;
  // 门控：落在 (now − 半个窗口, now + 1.5 个窗口) 之外的重置时间当未知（与火山同一条规则）
  if (reset != null && (reset < now - ms / 2 || reset > now + ms * 1.5)) reset = null;
  return {
    known: w.used_percent != null && Number.isFinite(Number(w.used_percent)),
    percent: clampPct(w.used_percent),
    used: null,
    total: null,
    remaining: null,
    nextResetTime: reset,
    windowStart: reset != null ? reset - ms : null,
    windowMs: ms,
  };
}

/** 一个限额桶（rate_limit / additional_rate_limits[i]）→ { five, week, month, reached } */
function bucketWindows(bucket, now) {
  const out = { five: emptyWindow('five'), week: emptyWindow('week'), month: emptyWindow('month') };
  if (!bucket || typeof bucket !== 'object') return null;
  let any = false;
  for (const k of ['primary_window', 'secondary_window']) {
    const w = bucket[k];
    if (!w || typeof w !== 'object') continue;
    const slot = slotOf(w.limit_window_seconds);
    if (!slot) continue;
    const win = mkWindow(w, now);
    // 同一槽位撞了两个窗口（理论上不会）：留用量更高的那个——宁可早报警
    if (!out[slot].known || win.percent > out[slot].percent) out[slot] = win;
    any = true;
  }
  if (!any) return null;
  out.reached = bucket.limit_reached === true || bucket.allowed === false;
  return out;
}

/** 额外限额（按模型单列的，如 GPT-5.3-Codex-Spark）的名字：字段名没有文档，几种写法都认 */
function extraName(x, i) {
  const n = x && (x.limit_name || x.name || x.model || x.metered_feature || x.feature);
  return n ? String(n) : `额外限额 ${i + 1}`;
}

/**
 * 整份响应 → { plan, five, week, month, reached, extras[], credits }（plan 由 fetchUsage 改名成 level）。
 * @returns {object} 主额度一个窗口都没有时 windows 全是 known:false（不抛错——免费号可能就是这样）
 */
function normalize(body, now) {
  const main = bucketWindows(body && body.rate_limit, now)
    || { five: emptyWindow('five'), week: emptyWindow('week'), month: emptyWindow('month'), reached: false };
  const extras = [];
  const add = Array.isArray(body && body.additional_rate_limits) ? body.additional_rate_limits : [];
  add.forEach((x, i) => {
    const b = bucketWindows(x && (x.rate_limit || x), now);
    if (b) extras.push({ name: extraName(x, i), five: b.five, week: b.week, month: b.month, reached: b.reached });
  });
  const cr = bucketWindows(body && body.code_review_rate_limit, now);
  if (cr) extras.push({ name: '代码审查', five: cr.five, week: cr.week, month: cr.month, reached: cr.reached });
  const c = body && body.credits;
  return {
    plan: (body && body.plan_type) || null,
    five: main.five,
    week: main.week,
    month: main.month,
    reached: main.reached,
    extras,
    credits: c && c.has_credits ? { balance: c.balance, unlimited: !!c.unlimited } : null,
  };
}

/* ---------------- 请求 ---------------- */

/**
 * 查一次。
 * @param {string} token access_token（已经过 extractCodexToken 清洗）
 * @param {Function} [fetchImpl] 注入用（测试 / 主进程的 net.fetch 走系统代理）
 * @param {number} [now]
 * @returns {Promise<{ok:true,data}|{ok:false,kind,msg}>}
 */
async function fetchUsage(token, fetchImpl, now) {
  const ts = now || Date.now();
  const info = tokenInfo(token);
  if (!info) return { ok: false, kind: 'expired', msg: 'access_token 不是 OpenAI 签发的 JWT——确认复制的是 auth.json 里 tokens.access_token' };
  if (info.exp && info.exp <= ts) {
    return { ok: false, kind: 'expired', msg: 'access_token 已过期', tokenExp: info.exp };
  }
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'User-Agent': 'codex_cli_rs',
  };
  if (info.accountId) headers['ChatGPT-Account-Id'] = info.accountId;

  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res, text;
  try {
    res = await doFetch(API_URL, { method: 'GET', headers, signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    return { ok: false, kind: 'network', msg: e && e.name === 'AbortError' ? '请求超时' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: 'expired', msg: `access_token 无效或已被注销（HTTP ${res.status}）`, tokenExp: info.exp };
  }
  if (res.status === 429) return { ok: false, kind: 'ratelimit', msg: '触发限流（429），稍后自动重试' };
  let body = null;
  try { body = JSON.parse(text); } catch { /* 下面报 */ }
  if (res.status !== 200 || !body || typeof body !== 'object') {
    // Cloudflare 的拦截页是 HTML：截一段原文进日志，别把整页塞进去
    return { ok: false, kind: 'parse', msg: `响应异常（HTTP ${res.status}）· 原文=${String(text || '').slice(0, 200)}` };
  }
  let norm;
  try {
    norm = normalize(body, ts);
  } catch (e) {
    return { ok: false, kind: 'parse', msg: `解析失败：${String((e && e.message) || e)}` };
  }
  const { plan, ...rest } = norm;
  return {
    ok: true,
    // 套餐名（plus / pro …）改叫 level：页签徽标与托盘按 GLM 的 level 字段读
    data: { ...rest, level: plan || info.plan, tokenExp: info.exp, fetchedAt: ts },
  };
}

module.exports = {
  API_URL, SLOT_SECONDS,
  localAuthPath, readLocalAuth, tokenInfo, slotOf, normalize, fetchUsage,
};
