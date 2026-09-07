'use strict';
/**
 * GLM Coding Plan 用量数据层（纯 Node，无 Electron 依赖，便于测试）
 *
 * 端点: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 * 鉴权: Authorization 头直接放 bigmodel_token_production 的 JWT，无 Bearer 前缀
 */
const API_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** 从任意粘贴内容中提取 token：整段 Cookie、纯 JWT、或混排文本 */
function extractToken(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const m = s.match(/bigmodel_token_production=([^;\s]+)/);
  if (m) return m[1];
  const JWT = /ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/;
  const m2 = s.match(JWT);
  return m2 ? m2[0] : '';
}

/**
 * 拉取并解析用量。
 * @returns {Promise<{ok:true,data:object}|{ok:false,kind:'expired'|'ratelimit'|'network'|'parse',msg:string}>}
 *  data: { level, five:{percent,used,total,remaining,nextResetTime,windowStart}, week:{...}, fetchedAt }
 */
async function fetchUsage(token, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  if (!token) return { ok: false, kind: 'expired', msg: '未配置 Token' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let res, body;
  try {
    res = await doFetch(API_URL, {
      method: 'GET',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    body = await res.json();
  } catch (e) {
    return { ok: false, kind: 'network', msg: e && e.name === 'AbortError' ? '请求超时' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }

  if (res.status === 429) return { ok: false, kind: 'ratelimit', msg: '触发限流（429），稍后自动重试' };
  // 未登录/鉴权失败: 401/403，或业务码 1001（Header中未收到Authorization…）/401
  const code = typeof body.code === 'number' ? body.code : res.status;
  if (res.status === 401 || res.status === 403 || code === 1001) {
    return { ok: false, kind: 'expired', msg: (body && body.msg) || 'Cookie 已失效' };
  }
  if (res.status !== 200 || !body || body.success !== true || !body.data || !Array.isArray(body.data.limits)) {
    return { ok: false, kind: 'parse', msg: (body && body.msg) || `响应异常（HTTP ${res.status}）` };
  }

  const credits = body.data.limits
    .filter((l) => l && l.type === 'CREDIT_LIMIT' && Number.isFinite(l.nextResetTime))
    .sort((a, b) => a.nextResetTime - b.nextResetTime);
  if (credits.length < 2) return { ok: false, kind: 'parse', msg: '额度字段缺失' };

  const pick = (l, windowMs) => ({
    percent: Math.max(0, Math.min(100, Math.round(l.percentage ?? 0))),
    used: l.currentValue ?? 0,
    total: l.usage ?? 0,
    remaining: l.remaining ?? Math.max(0, (l.usage ?? 0) - (l.currentValue ?? 0)),
    nextResetTime: Number(l.nextResetTime),
    windowStart: Number(l.nextResetTime) - windowMs,
  });

  return {
    ok: true,
    data: {
      level: body.data.level || '',
      five: pick(credits[0], FIVE_HOUR_MS), // 较早重置的 = 5 小时额度
      week: pick(credits[credits.length - 1], 7 * 24 * 60 * 60 * 1000),
      fetchedAt: Date.now(),
    },
  };
}

module.exports = { API_URL, extractToken, fetchUsage };
