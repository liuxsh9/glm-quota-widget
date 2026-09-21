'use strict';
/**
 * 火山方舟（Volcengine Ark）Coding Plan / Agent Plan 的配额查询。
 *
 * 纯 Node（只依赖 crypto），不碰 Electron——对标 lib/usage.js（GLM）与 lib/deepseek.js。
 *
 * 两条链路，各查各的：
 *   Coding Plan → GetCodingPlanUsage   → Result.QuotaUsage[]，**只有百分比**
 *   Agent Plan  → GetAgentPlanAFPUsage → Result.AFPFiveHour/AFPWeekly/AFPMonthly，有绝对值
 *
 * 与 GLM / DeepSeek 最大的不同：这两个是**控制面 OpenAPI**，走 open.volcengineapi.com
 * 统一网关，**强制火山引擎签名 V4（AK/SK）**。复用推理用的 Bearer API Key 会被网关拒，
 * 所以凭据是一对 AccessKey，而不是一个 key。签名算法对齐官方 Python SDK 的
 * volcenginesdkcore/signv4.py（见 test/volc.test.js 里的黄金向量）。
 *
 * 输出统一归一成 GLM 那个窗口形状（five/week/month），好让渲染层的配速、幽灵段、
 * 超支变色以及 lib/format.js 的档位函数原样复用。
 */
const crypto = require('crypto');

const HOST = 'open.volcengineapi.com';
const REGION = 'cn-beijing';
const SERVICE = 'ark';
const VERSION = '2024-01-01';
const API_URL = `https://${HOST}/`;

/** 套餐 → Action 名 */
const ACTIONS = { coding: 'GetCodingPlanUsage', agent: 'GetAgentPlanAFPUsage' };

/** 窗口长度（毫秒）。月窗口不是常量（28–31 天），单独按日历推 */
const WINDOW_MS = {
  five: 5 * 3600e3,
  week: 7 * 86400e3,
};

/* ---------------- 签名 ---------------- */

/** RFC3986 转义：encodeURIComponent 不转 !*'()，而官方用的是 Python quote(safe='-_.~')，会转 */
function encodeRfc3986(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 规范查询串：各键值先转义、再按 (key,value) 字典序排——与官方 SDK 的 `sorted(res)` 一致 */
function canonicalQuery(params) {
  return Object.keys(params)
    .map((k) => [encodeRfc3986(k), encodeRfc3986(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 官方要求的 X-Date：UTC 的 yyyyMMdd'T'HHmmss'Z'。服务端容忍偏差约 15 分钟 */
function formatXDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * 火山签名 V4。返回签名结果与**可外发的请求头**。
 *
 * 关于 Host：签名里必须包含 host，但 Fetch 规范把 Host 列为禁止设置的请求头，
 * 浏览器/undici 会静默丢掉它。所以这里按已知域名签，**发出时不带 Host**
 * （实际发出的 Host 由 URL 决定，必然等于签的那个值）。
 *
 * @returns {{url, headers, canonicalRequest, signedHeaders, signature}}
 */
function signRequest(ak, sk, action, now) {
  const xDate = formatXDate(now || new Date());
  const query = { Action: action, Version: VERSION };
  const body = '{}';
  const bodyHash = sha256hex(body);

  // 参与签名的头：Content-Type / Content-Md5 / Host / 所有 X-*（大小写按官方 SDK 的原始写法判定）
  const raw = {
    'Content-Type': 'application/json',
    'Host': HOST,
    'X-Content-Sha256': bodyHash,
    'X-Date': xDate,
  };
  const signed = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'Content-Type' || k === 'Content-Md5' || k === 'Host' || k.startsWith('X-')) {
      signed[k.toLowerCase()] = v;
    }
  }
  // host 带 80/443 端口时去掉（官方 SDK 行为；这里用的是裸域名，等于空操作）
  if (signed.host && signed.host.includes(':')) {
    const [h, port] = signed.host.split(':');
    if (port === '80' || port === '443') signed.host = h;
  }

  const keys = Object.keys(signed).sort();
  const signedHeaders = keys.join(';');
  const canonicalHeaders = keys.map((k) => `${k}:${signed[k]}\n`).join('');
  const canonicalRequest = ['POST', '/', canonicalQuery(query), canonicalHeaders, signedHeaders, bodyHash].join('\n');

  const scope = `${xDate.slice(0, 8)}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256hex(canonicalRequest)].join('\n');

  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  const kSigning = hmac(hmac(hmac(hmac(sk, xDate.slice(0, 8)), REGION), SERVICE), 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    url: `${API_URL}?${canonicalQuery(query)}`,
    // 外发头不带 Host：它由 URL 决定，且 Fetch 不允许显式设置
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Sha256': bodyHash,
      'X-Date': xDate,
      'Authorization': `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signedHeaders,
    signature,
    body,
  };
}

/* ---------------- 数值归一 ---------------- */

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

/**
 * 时间戳统一成毫秒。
 * Coding Plan 的 ResetTimestamp 是**秒**、Agent Plan 的 ResetTime 是**毫秒**，搞反不会报错——
 * 只会让倒计时显示 1970 年、幽灵段钉在 99%。所以按数量级判，不靠调用方记得。
 */
function toMs(v) {
  const t = Number(v);
  if (!Number.isFinite(t) || t <= 0) return null;
  return t < 1e11 ? t * 1000 : t;   // 秒级现在约 1e9、毫秒级约 1e12，1e11 是干净的分界
}

/**
 * 带可信度门控的重置时间。
 *
 * 账号长时间没用时，服务端可能返回一个**已经过去**的重置时间。留着它会让倒计时永远显示
 * 「即将重置」、配速钉在 99%。所以只认落在 (now − 半个窗口, now + 1.5 个窗口) 里的值，
 * 越界一律当「未知」（返回 null），由界面显示「--」。
 */
function normReset(v, windowMs, now) {
  const t = toMs(v);
  if (t == null) return null;
  if (t < now - windowMs / 2 || t > now + windowMs * 1.5) return null;
  return t;
}

/** 往前推 n 个自然月（月窗口长度不是常量），按本机时区近似——月窗口里差几小时对配速无影响 */
function subMonths(ms, n) {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.getTime();
}

/**
 * 造一个窗口。**percent 恒为数值**——渲染层把它写进 CSS 变量，
 * 若是 null 会变成字符串 "null"，calc("null" * 1%) 失效后条宽退回 auto，直接画成满格。
 * 窗口缺数据时用 known:false 表达「未知」，界面据此显示「–」。
 */
function mkWindow(percent, used, total, resetMs, windowMs) {
  const known = percent != null;
  const hasAbs = used != null && total != null;
  const pct = known ? clampPct(percent) : 0;
  return {
    known,
    percent: pct,
    used: hasAbs ? Number(used) : null,
    total: hasAbs ? Number(total) : null,
    // 有绝对值才给 remaining（GLM 的提醒文案优先用它；没有时退回百分比，见 quota-alerts.js）
    remaining: hasAbs ? Math.max(0, Number(total) - Number(used)) : null,
    nextResetTime: resetMs,
    windowStart: resetMs != null ? resetMs - windowMs : null,
    windowMs,
  };
}

/** 空窗口（该套餐没返回这一档） */
const emptyWindow = (windowMs) => mkWindow(null, null, null, null, windowMs);

/* ---------------- 响应解析 ---------------- */

/**
 * 把两种套餐的响应都归一成 {level, plan, five, week, month}。
 * @returns {{ok:true, data}} 或抛错（由调用方转成 kind/msg）
 */
function normalize(kind, result, now) {
  const monthMs = 30 * 86400e3;   // 仅用于门控与兜底；真实窗口长度按重置时间反推
  if (kind === 'coding') {
    // Result.QuotaUsage[]：{ Level: session|weekly|monthly, Percent, ResetTimestamp }
    const arr = Array.isArray(result && result.QuotaUsage) ? result.QuotaUsage : [];
    const usable = arr.filter((x) => x && typeof x === 'object');
    if (!usable.length) return { subscribed: false };

    const SLOT = { session: 'five', weekly: 'week', monthly: 'month' };
    const ORDER = ['five', 'week', 'month'];
    const w = { five: emptyWindow(WINDOW_MS.five), week: emptyWindow(WINDOW_MS.week), month: emptyWindow(monthMs) };

    if (usable.every((it) => SLOT[String(it.Level || '').toLowerCase()])) {
      for (const item of usable) {
        const slot = SLOT[String(item.Level).toLowerCase()];
        w[slot] = codingWindow(item, slot, now);
      }
    } else {
      // Level 认不出来（后端改版 / 字段缺失）：整份按「重置越早 = 窗口越短」升序填。
      // 排序必须用**未过门控**的原始时间戳——拿 5 小时窗口去门控 20 天后的重置，
      // 会把长窗口的重置判成过期丢掉，排序直接乱套。
      usable
        .map((item) => ({ item, at: toMs(item.ResetTimestamp) }))
        .sort((a, b) => (a.at == null ? Infinity : a.at) - (b.at == null ? Infinity : b.at))
        .slice(0, ORDER.length)
        .forEach(({ item }, i) => { w[ORDER[i]] = codingWindow(item, ORDER[i], now); });
    }
    return { subscribed: true, plan: 'coding', level: null, windows: w };
  }

  // Result.AFPFiveHour / AFPWeekly / AFPMonthly：{ Quota, Used, ResetTime(ms) }
  const AFP = [['five', 'AFPFiveHour'], ['week', 'AFPWeekly'], ['month', 'AFPMonthly']];
  const any = AFP.some(([, k]) => result && result[k] && typeof result[k] === 'object');
  if (!any) return { subscribed: false };
  const w = {};
  for (const [slot, key] of AFP) {
    const item = (result && result[key]) || null;
    const len = slot === 'month' ? monthMs : WINDOW_MS[slot];
    if (!item) { w[slot] = emptyWindow(len); continue; }
    const quota = Number(item.Quota);
    const used = Number(item.Used);
    const reset = normReset(item.ResetTime, len, now);
    const hasAbs = Number.isFinite(quota) && quota > 0 && Number.isFinite(used);
    const win = mkWindow(hasAbs ? (used / quota) * 100 : null, hasAbs ? used : null, hasAbs ? quota : null, reset, len);
    if (slot === 'month' && win.nextResetTime != null) {
      win.windowStart = subMonths(win.nextResetTime, 1);
      win.windowMs = win.nextResetTime - win.windowStart;
    }
    w[slot] = win;
  }
  // 档位字段名没在文档里写死（items[].tier 是 ark-cli 的输出层命名），两种写法都认，认不到就当没有
  const tier = result && (result.Tier || result.tier);
  return { subscribed: true, plan: 'agent', level: tier || null, windows: w };
}

/** Coding Plan 的单条：秒级 ResetTimestamp + 只有百分比 */
function codingWindow(item, slot, now) {
  const len = slot === 'month' ? 30 * 86400e3 : WINDOW_MS[slot];
  const reset = normReset(item.ResetTimestamp, len, now);
  const win = mkWindow(item.Percent, null, null, reset, len);
  if (slot === 'month' && win.nextResetTime != null) {
    win.windowStart = subMonths(win.nextResetTime, 1);
    win.windowMs = win.nextResetTime - win.windowStart;
  }
  return win;
}

/* ---------------- 请求 ---------------- */

/**
 * 火山统一错误信封：**HTTP 200 也可能带 ResponseMetadata.Error**（业务错误走 200）。
 * 不先查它就会把报错当成有效数据，进而把「未订阅」判断成真。
 */
function envelopeError(body) {
  const e = body && body.ResponseMetadata && body.ResponseMetadata.Error;
  return e && e.Code ? { code: String(e.Code), message: String(e.Message || '') } : null;
}

/**
 * 查一种套餐。
 * @param {'coding'|'agent'} kind
 * @param {{accessKeyId, accessKeySecret}} creds
 * @param {Function} [fetchImpl] 注入用（测试）；默认全局 fetch
 * @param {number} [now]
 * @returns {Promise<{ok:true,data}|{ok:false,kind,msg}>} data 含 subscribed/plan/level/windows
 */
async function fetchPlan(kind, creds, fetchImpl, now) {
  const ts = now || Date.now();
  if (!creds || !creds.accessKeyId || !creds.accessKeySecret) {
    return { ok: false, kind: 'expired', msg: '未配置 AK/SK' };
  }
  const action = ACTIONS[kind];
  const doFetch = fetchImpl || fetch;
  const { url, headers, body, canonicalRequest } = signRequest(creds.accessKeyId, creds.accessKeySecret, action, new Date(ts));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res, text;
  try {
    res = await doFetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    return { ok: false, kind: 'network', msg: e && e.name === 'AbortError' ? '请求超时' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON：下面按 parse 错报，带上原文 */ }

  const err = envelopeError(parsed);
  // 鉴权/权限错：401 与 AccessDenied 都算凭据路不通，但**原因不同**，文案要分开写
  const code = err ? err.code : '';
  if (res.status === 429) return { ok: false, kind: 'ratelimit', msg: '触发限流（429），稍后自动重试' };
  if (code === 'AccessDenied' || res.status === 403) {
    return {
      ok: false, kind: 'expired',
      msg: 'AK/SK 有效但缺少权限——给这个子账号挂上 ArkReadOnlyAccess（火山方舟只读）'
        + '与 BillingCenterReadOnlyAccess（费用中心只读）后重试'
        + (err && err.message ? ` · ${err.message}` : ''),
    };
  }
  if (code === 'InvalidAccessKey' || code === 'SignatureDoesNotMatch' || code === 'MissingAuthenticationToken'
      || res.status === 401) {
    return {
      ok: false, kind: 'expired',
      msg: (code === 'SignatureDoesNotMatch' ? '签名不匹配' : 'AK/SK 无效')
        + '——确认 AccessKey ID 与 Secret AccessKey 是一对、没粘多余空格，且本机时间准确'
        + (err && err.message ? ` · ${err.message}` : ''),
    };
  }
  if (err) return { ok: false, kind: 'parse', msg: `火山方舟返回错误 ${code}：${err.message}` };
  if (res.status !== 200 || !parsed) {
    // 403 之外的失败把签名输入带出来一点：签名错和密钥错在日志里长得一样，不然后面没法查
    const raw = String(text || '').slice(0, 300);
    return { ok: false, kind: 'parse', msg: `响应异常（HTTP ${res.status}）· 原文=${raw}` };
  }

  const result = parsed.Result || parsed;
  let norm;
  try {
    norm = normalize(kind, result, ts);
  } catch (e) {
    return { ok: false, kind: 'parse', msg: `解析失败：${String((e && e.message) || e)}` };
  }
  if (!norm.subscribed) return { ok: true, data: { subscribed: false, plan: kind } };
  return {
    ok: true,
    data: {
      subscribed: true,
      plan: norm.plan,
      level: norm.level,
      windows: norm.windows,
      fetchedAt: ts,
    },
  };
}

module.exports = {
  API_URL, HOST, REGION, SERVICE, VERSION, ACTIONS, WINDOW_MS,
  signRequest, canonicalQuery, encodeRfc3986, formatXDate,
  normReset, normalize, fetchPlan,
};
