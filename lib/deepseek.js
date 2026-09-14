'use strict';
/**
 * DeepSeek 数据层（纯 Node，无 Electron 依赖，便于测试）
 *
 * 两条**互相独立**的链路，各自鉴权、各自降级：
 *
 * 1) 余额 —— 官方文档化接口，官方 API Key（sk-…）长期有效，一配永逸
 *    GET https://api.deepseek.com/user/balance
 *    Authorization: Bearer sk-xxxxxxxx
 *    → {"is_available":true,"balance_infos":[{currency,total_balance,granted_balance,topped_up_balance}]}
 *    金额是**字符串**；可能同时有 CNY 与 USD 两条，取有余额的那条（无则优先 CNY）。
 *    余额是账号级的：同账号下所有 Key 查到的是同一份。
 *
 * 2) 用量/消费 —— 平台**私有**接口（非官方公开契约，字段可能变），需要 platform.deepseek.com
 *    登录态里的 userToken（短命，几天到几周不等，失效需重新粘贴）。
 *    GET https://platform.deepseek.com/api/v0/usage/cost?month=M&year=Y      → 本月逐日 + 按模型消费
 *    GET https://platform.deepseek.com/api/v0/usage/amount?month=M&year=Y    → 本月逐模型 token
 *    响应是两层信封：{code, msg, data:{biz_code, biz_msg, biz_data}}，code/biz_code 都为 0 才算成功；
 *    认证失败是 40002/40003（也可能落 HTTP 401/403）。
 *    注意：平台按 **UTC 日界**切天，界面上要标明口径。
 *
 * 私有接口一律做「解析失败只降级这一路」：余额链路不因它挂掉。
 */

const { utcDayKey } = require('./format');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const PLATFORM_BASE = 'https://platform.deepseek.com/api/v0';
const TIMEOUT_MS = 15000;

/* ---------------- 凭据提取 ---------------- */

/** 官方 API Key：sk- 开头的固定形态（实测 sk- + 32 位十六进制） */
function extractDsToken(raw) {
  if (!raw) return '';
  const m = String(raw).match(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/);
  return m ? m[0] : '';
}

/**
 * 平台 userToken：兼容四种粘贴形态
 *   1. 裸 token
 *   2. localStorage 里的 JSON 串 {"value":"…"}（真值在 value 字段）
 *   3. 被再包一层的 JSON 字符串 "{\"value\":\"…\"}"
 *   4. 抄自 Network 面板的 `Authorization: Bearer xxx` / `userToken: xxx`
 */
function extractPlatformToken(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  s = s.replace(/^userToken\s*[:=]\s*/i, '').trim();
  s = s.replace(/^Bearer\s+/i, '').trim();
  if (s[0] === '{' || s[0] === '"') {
    try {
      let o = JSON.parse(s);
      if (typeof o === 'string') o = JSON.parse(o); // 双重编码的 JSON 串
      const v = o && (o.value || o.token || o.access_token);
      if (typeof v === 'string' && v.trim()) s = v.trim();
    } catch { /* 不是 JSON，按裸 token 处理 */ }
  }
  s = s.replace(/^["']|["']$/g, '').trim();
  // 平台 token 常见为 JWT（含 . ）或长随机串；用宽松字符集 + 长度下限兜底
  return /^[A-Za-z0-9._~+/=-]{16,}$/.test(s) ? s : '';
}

/* ---------------- 通用工具 ---------------- */

/** 金额字段是字符串，且可能带高精度小数（"2.0137344000000000"） */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** 带超时的 GET + JSON 解析（fetch 实现可注入，便于测试） */
async function getJson(url, headers, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, { method: 'GET', headers, signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { res, body };
  } catch (e) {
    return { err: { ok: false, kind: 'network', msg: e && e.name === 'AbortError' ? '请求超时' : String((e && e.message) || e) } };
  } finally {
    clearTimeout(t);
  }
}

const rawSnippet = (body) => {
  try { return JSON.stringify(body).slice(0, 300); } catch { return String(body).slice(0, 300); }
};

/* ---------------- 链路 1：余额（官方 API Key） ---------------- */

function pickBalance(infos) {
  const list = (Array.isArray(infos) ? infos : [])
    .map((b) => ({
      currency: String((b && b.currency) || '').toUpperCase(),
      total: num(b && b.total_balance),
      granted: num(b && b.granted_balance),
      toppedUp: num(b && b.topped_up_balance),
    }))
    .filter((b) => b.currency && b.total != null);
  if (!list.length) return null;
  // 有余额的那条才是用户在意的；都为零时优先 CNY（国内账号主力币种）
  const main = list.find((b) => b.total > 0) || list.find((b) => b.currency === 'CNY') || list[0];
  return { ...main, all: list };
}

/**
 * 拉取账户余额。
 * @returns {Promise<{ok:true,data:{available,currency,total,granted,toppedUp,all,fetchedAt}}|
 *                   {ok:false,kind:'expired'|'ratelimit'|'network'|'parse',msg:string}>}
 */
async function fetchBalance(apiKey, fetchImpl) {
  if (!apiKey) return { ok: false, kind: 'expired', msg: '未配置 DeepSeek API Key' };
  const { res, body, err } = await getJson(BALANCE_URL, {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }, fetchImpl);
  if (err) return err;

  if (res.status === 401 || res.status === 403) return { ok: false, kind: 'expired', msg: 'API Key 无效或已撤销' };
  if (res.status === 429) return { ok: false, kind: 'ratelimit', msg: '触发限流（429），稍后自动重试' };
  if (res.status !== 200 || !body || typeof body !== 'object') {
    return { ok: false, kind: 'parse', msg: `响应异常（HTTP ${res.status}） · 原文=${rawSnippet(body)}` };
  }
  const main = pickBalance(body.balance_infos);
  if (!main) {
    return { ok: false, kind: 'parse', msg: '余额字段缺失 · 原文=' + rawSnippet(body) };
  }
  return {
    ok: true,
    data: {
      available: body.is_available !== false,
      currency: main.currency,
      total: main.total,
      granted: main.granted,
      toppedUp: main.toppedUp,
      all: main.all,
      fetchedAt: Date.now(),
    },
  };
}

/* ---------------- 链路 2：平台账单（userToken，选配） ---------------- */

/**
 * 拆两层信封。返回 {data} 或 {err:{kind,msg}}。
 * code/biz_code 都为 0 才算成功；40002/40003 是会话过期。
 */
function unwrap(body, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return { err: { kind: 'expired', msg: '平台会话已过期，请重新获取 userToken' } };
  if (httpStatus === 429) return { err: { kind: 'ratelimit', msg: '平台接口限流（429），稍后自动重试' } };
  if (httpStatus !== 200 || !body || typeof body !== 'object') {
    return { err: { kind: 'parse', msg: `平台响应异常（HTTP ${httpStatus}） · 原文=${rawSnippet(body)}` } };
  }
  const biz = body.data && typeof body.data === 'object' ? body.data : null;
  const code = num(body.code);
  const bizCode = biz ? num(biz.biz_code) : null;
  const expired = (c) => c === 40002 || c === 40003 || c === 401 || c === 403;
  if (expired(code) || expired(bizCode)) {
    return { err: { kind: 'expired', msg: (biz && biz.biz_msg) || body.msg || '平台会话已过期，请重新获取 userToken' } };
  }
  if (code !== 0 || !biz) {
    return { err: { kind: 'parse', msg: `${body.msg || '平台接口返回异常'}（code=${body.code}） · 原文=${rawSnippet(body)}` } };
  }
  if (bizCode != null && bizCode !== 0) {
    return { err: { kind: 'parse', msg: `${biz.biz_msg || '平台业务异常'}（biz_code=${biz.biz_code}） · 原文=${rawSnippet(body)}` } };
  }
  return { data: biz.biz_data };
}

const PLATFORM_HEADERS = (token) => ({
  Authorization: 'Bearer ' + token,
  Accept: 'application/json',
  Origin: 'https://platform.deepseek.com',
  Referer: 'https://platform.deepseek.com/usage',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
});

/** usage/cost 的 biz_data 历史上出现过对象与单元素数组两种形态 */
const oneOf = (d) => (Array.isArray(d) ? d[0] : d);

/** 一组 {type, amount} 求和；REQUEST 单独计，其余按金额累加（未知类型也计入，防新计费项漏算） */
function sumCost(usage) {
  let total = 0, request = 0;
  for (const u of Array.isArray(usage) ? usage : []) {
    const a = num(u && u.amount);
    if (a == null) continue;
    if (String((u && u.type) || '').toUpperCase() === 'REQUEST') { request += a; continue; }
    total += a;
  }
  return { total, request };
}

/** token 分类求和：hit/miss 与全量 PROMPT_TOKEN 并存时以前者为准，不重复累加 */
function sumTokens(usage) {
  let hit = 0, miss = 0, prompt = 0, response = 0, request = 0;
  for (const u of Array.isArray(usage) ? usage : []) {
    const a = num(u && u.amount);
    if (a == null) continue;
    switch (String((u && u.type) || '').toUpperCase()) {
      case 'PROMPT_CACHE_HIT_TOKEN': hit += a; break;
      case 'PROMPT_CACHE_MISS_TOKEN': miss += a; break;
      case 'PROMPT_TOKEN': prompt += a; break;
      case 'RESPONSE_TOKEN': response += a; break;
      case 'REQUEST': request += a; break;
      default: break; // 未知类型静默忽略
    }
  }
  const promptTokens = (hit || miss) ? hit + miss : prompt;
  return { promptTokens, cacheHit: hit, cacheMiss: miss, response, request, total: promptTokens + response };
}

/**
 * 本月消费账单（逐日 + 按模型）。
 * @returns {Promise<{ok:true,data:{currency,month,total,byDay:[{date,cost}],byModel:[{model,cost}]}}|{ok:false,...}>}
 */
async function fetchMonthlyCost(token, { year, month }, fetchImpl) {
  if (!token) return { ok: false, kind: 'expired', msg: '未配置平台令牌' };
  const url = `${PLATFORM_BASE}/usage/cost?month=${month}&year=${year}`;
  const { res, body, err } = await getJson(url, PLATFORM_HEADERS(token), fetchImpl);
  if (err) return err;
  const u = unwrap(body, res.status);
  if (u.err) return { ok: false, ...u.err };
  const one = oneOf(u.data);
  if (!one || typeof one !== 'object' || !Array.isArray(one.days)) {
    return { ok: false, kind: 'parse', msg: '账单字段缺失 · 原文=' + rawSnippet(u.data) };
  }
  const byDay = one.days
    .map((d) => ({ date: String((d && d.date) || ''), cost: d && Array.isArray(d.data) ? d.data.reduce((s, m) => s + sumCost(m && m.usage).total, 0) : 0 }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  const byModel = (Array.isArray(one.total) ? one.total : [])
    .map((m) => ({ model: String((m && m.model) || ''), cost: sumCost(m && m.usage).total }))
    .filter((m) => m.model);
  return {
    ok: true,
    data: {
      currency: String(one.currency || 'CNY').toUpperCase(),
      month: `${year}-${String(month).padStart(2, '0')}`,
      total: byDay.reduce((s, d) => s + d.cost, 0),
      byDay,
      byModel,
      fetchedAt: Date.now(),
    },
  };
}

/**
 * 本月 token 用量（逐模型分类汇总）。
 * @returns {Promise<{ok:true,data:{total:{...},byModel:[{model,...}]}}|{ok:false,...}>}
 */
async function fetchMonthlyAmount(token, { year, month }, fetchImpl) {
  if (!token) return { ok: false, kind: 'expired', msg: '未配置平台令牌' };
  const url = `${PLATFORM_BASE}/usage/amount?month=${month}&year=${year}`;
  const { res, body, err } = await getJson(url, PLATFORM_HEADERS(token), fetchImpl);
  if (err) return err;
  const u = unwrap(body, res.status);
  if (u.err) return { ok: false, ...u.err };
  const one = oneOf(u.data);
  if (!one || typeof one !== 'object' || !Array.isArray(one.total)) {
    return { ok: false, kind: 'parse', msg: '用量字段缺失 · 原文=' + rawSnippet(u.data) };
  }
  const byModel = one.total
    .map((m) => ({ model: String((m && m.model) || ''), ...sumTokens(m && m.usage) }))
    .filter((m) => m.model);
  const total = byModel.reduce((acc, m) => {
    for (const k of ['promptTokens', 'cacheHit', 'cacheMiss', 'response', 'request', 'total']) acc[k] += m[k];
    return acc;
  }, { promptTokens: 0, cacheHit: 0, cacheMiss: 0, response: 0, request: 0, total: 0 });
  return { ok: true, data: { total, byModel, fetchedAt: Date.now() } };
}

module.exports = {
  BALANCE_URL, PLATFORM_BASE,
  extractDsToken, extractPlatformToken,
  fetchBalance, fetchMonthlyCost, fetchMonthlyAmount,
};
