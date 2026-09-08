'use strict';
/**
 * GLM Coding Plan 用量数据层（纯 Node，无 Electron 依赖，便于测试）
 *
 * 端点: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *   （与智谱官方插件 glm-plan-usage 同源，见 zai-org/zai-coding-plugins）
 * 鉴权: Authorization 头直接放 token，无 Bearer 前缀。两种均可：
 *   - API Key（控制台创建，形如 32 位.16 位，长期有效，推荐）
 *   - bigmodel_token_production 的 Cookie JWT（约 3 天失效）
 */
const API_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 从任意粘贴内容中提取 token：整段 Cookie、纯 JWT、API Key、或混排文本 */
function extractToken(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const m = s.match(/bigmodel_token_production=([^;\s]+)/);
  if (m) return m[1];
  // 先试 JWT（三段式），避免其前两段被误判为 API Key（两段式）
  const m2 = s.match(/ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/);
  if (m2) return m2[0];
  // API Key：两段纯字母数字（实测 32.16）；前后界符防误吞文件名等噪声
  const m3 = s.match(/(?<![A-Za-z0-9_.-])[A-Za-z0-9]{16,}\.[A-Za-z0-9]{12,}(?![A-Za-z0-9_.-])/);
  return m3 ? m3[0] : '';
}

/** 窗口时长（ms）：接口 unit 字段 3=小时、6=周；老响应缺字段时返回 null */
function windowMsOf(l) {
  if (l.unit === 3 && Number.isFinite(l.number) && l.number > 0) return l.number * 3600e3;
  if (l.unit === 6 && Number.isFinite(l.number) && l.number > 0) return l.number * WEEK_MS;
  return null;
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
    return { ok: false, kind: 'expired', msg: (body && body.msg) || 'Token 已失效' };
  }
  if (res.status !== 200 || !body || body.success !== true || !body.data || !Array.isArray(body.data.limits)) {
    const raw = (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
    return { ok: false, kind: 'parse', msg: ((body && body.msg) || `响应异常（HTTP ${res.status}）`) + ` · 原文=${raw.slice(0, 300)}` };
  }

  // type 大小写不敏感：服务端存在 "credit_limit"（小写）的响应变体，严格全等会整体解析失败
  const credits = body.data.limits
    .filter((l) => l && String(l.type || '').toUpperCase() === 'CREDIT_LIMIT')
    .map((l) => ({ l, ms: windowMsOf(l) }));
  if (credits.length < 2) {
    // 带上原文：偶发的过渡态响应（如 5h 窗口滚动瞬间）可直接从日志定位
    return { ok: false, kind: 'parse', msg: '额度字段缺失 · limits=' + JSON.stringify(body.data.limits).slice(0, 300) };
  }

  // 优先按 unit/number 推出的窗口时长排序（短窗在前 = 5h 额度）；
  // 老响应缺字段时退回原逻辑：重置时间早的是 5 小时额度
  if (credits.every((c) => c.ms != null)) credits.sort((a, b) => a.ms - b.ms || a.l.nextResetTime - b.l.nextResetTime);
  else credits.sort((a, b) => a.l.nextResetTime - b.l.nextResetTime);

  const pick = (l, windowMs) => {
    const reset = Number.isFinite(l.nextResetTime) ? Number(l.nextResetTime) : null;
    return {
      percent: Math.max(0, Math.min(100, Math.round(l.percentage ?? 0))),
      used: l.currentValue ?? 0,
      total: l.usage ?? 0,
      remaining: l.remaining ?? Math.max(0, (l.usage ?? 0) - (l.currentValue ?? 0)),
      nextResetTime: reset,                    // 缺失时为 null：界面显示 --，不再整体失败
      windowStart: reset != null ? reset - windowMs : null,
    };
  };

  return {
    ok: true,
    data: {
      level: body.data.level || '',
      five: pick(credits[0].l, credits[0].ms ?? FIVE_HOUR_MS),
      week: pick(credits[credits.length - 1].l, credits[credits.length - 1].ms ?? WEEK_MS),
      fetchedAt: Date.now(),
    },
  };
}

module.exports = { API_URL, extractToken, fetchUsage };
