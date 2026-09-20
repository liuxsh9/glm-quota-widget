'use strict';
/**
 * Provider 注册表测试：元数据完整性、glm/deepseek 实现的 fetch/提醒策略/高频轮询。
 * 全部用注入的 fetchImpl，不发真实请求。
 */
const assert = require('assert');
const providers = require('../lib/providers');

let pass = 0, fails = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fails++; console.log('  ✗', name, extra === undefined ? '' : `  [${extra}]`); process.exitCode = 1; }
}
const j = (o) => JSON.stringify(o);

/** 造一个 mock fetch 响应 */
const res = (obj, status = 200) => ({ status, ok: status === 200, json: async () => obj });

/* ---------------- 注册表与元数据 ---------------- */
console.log('注册表:');
t('两家 provider 注册', providers.list.map((p) => p.id).join(',') === 'glm,deepseek', j(providers.list.map((p) => p.id)));
for (const p of providers.list) {
  t(`${p.id} 元数据完整`, p.name && p.tab && p.capsuleW > 0 && Array.isArray(p.credentials)
    && p.credentials.length > 0 && Array.isArray(p.domains) && p.domains.length > 0);
  for (const c of p.credentials) {
    t(`${p.id}.${c.key} 凭据声明有 label/placeholder`, !!(c.label && c.placeholder));
  }
}
t('glm 走全局档位（tier 型），deepseek 固定强调色',
  providers.byId('glm').accentMode === 'tier' && providers.byId('deepseek').accentMode === 'fixed');
t('deepseek 声明了高频轮询能力，glm 没有',
  providers.byId('deepseek').pollable === true && !providers.byId('glm').pollable);
t('两家都有凭据提取器', !!providers.byId('glm').extractors.token && !!providers.byId('deepseek').extractors.apiKey
  && !!providers.byId('deepseek').extractors.platformToken);
t('byId 未知 id 返回 null', providers.byId('nope') === null);

/* ---------------- GLM：fetch + 提醒策略 ---------------- */
console.log('\nGLM 实现:');
const GLM_OK = {
  success: true, data: {
    level: 'max', limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 41, currentValue: 11480, usage: 28000, remaining: 16520, nextResetTime: 1000 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 23, currentValue: 32200, usage: 140000, remaining: 107800, nextResetTime: 2000 },
    ],
  },
};

(async () => {
  const glm = providers.byId('glm');

  const r1 = await glm.fetch({ token: 'k' }, { fetchImpl: async () => res(GLM_OK), mem: { notified: {} } });
  t('fetch 解析出 5h/周窗口', r1.ok && r1.data.five.percent === 41 && r1.data.week.percent === 23);
  t('fetch 无提醒（未跨阈值）', r1.notes.length === 0 && r1.changed !== true);

  // 阈值提醒：5h 跨 80 → 一条合并通知；再刷一次同窗口不重复
  const cfg = { warnThreshold: 80, notifyReset: false };
  const over = {
    success: true, data: { level: 'max', limits: GLM_OK.data.limits.map((l) => ({ ...l, percentage: l.unit === 3 ? 85 : 20 })) },
  };
  const alertState = {};
  const r2 = await glm.fetch({ token: 'k' }, {
    fetchImpl: async () => res(over), accountName: '「备用」', config: cfg,
    alertState, prev: null, prevKind: 'ok', mem: { notified: {} }, now: 0,
  });
  t('跨阈值返回提醒', r2.notes.length === 1 && /「备用」5小时额度已用 85%/.test(r2.notes[0].title), j(r2.notes));
  t('去重状态已写入 alertState', alertState.five != null);
  const r3 = await glm.fetch({ token: 'k' }, {
    fetchImpl: async () => res(over), accountName: '', config: cfg,
    alertState: { five: alertState.five, week: 0 }, prev: null, prevKind: 'ok', mem: { notified: {} }, now: 0,
  });
  t('同一窗口不重复提醒', r3.notes.length === 0, j(r3.notes));

  // 失效提醒只发一次（跨调用共享同一个 mem —— 运行态里它是同一块草稿）
  const sharedMem = { notified: {} };
  const e1 = await glm.fetch({ token: 'k' }, { fetchImpl: async () => res({ code: 1001, msg: 'x' }, 401), accountName: '', config: cfg, alertState: {}, prev: null, prevKind: 'ok', mem: sharedMem, now: 0 });
  t('失效返回 expired + 提醒', e1.ok === false && e1.kind === 'expired' && e1.notes.length === 1);
  const e2 = await glm.fetch({ token: 'k' }, { fetchImpl: async () => res({ code: 1001, msg: 'x' }, 401), accountName: '', config: cfg, alertState: {}, prev: null, prevKind: 'expired', mem: sharedMem, now: 0 });
  t('失效第二次不再提醒（mem 去重）', e2.notes.length === 0);

  // 重置提醒：窗口滚动且此前用量过半
  const rr = await glm.fetch({ token: 'k' }, {
    fetchImpl: async () => res(GLM_OK), accountName: '', config: { warnThreshold: 80, notifyReset: true },
    alertState: {}, prev: { five: { windowStart: 900, percent: 60 } }, prevKind: 'ok', mem: { notified: {} }, now: 0,
  });
  t('重置回满提醒', rr.notes.some((n) => /额度已重置/.test(n.title)), j(rr.notes));

  // tier
  t('tier 取两窗口最差档', glm.tier({ five: { percent: 85 }, week: { percent: 10 } }, 80) === 'mid'
    && glm.tier({ five: { percent: 50 }, week: { percent: 95 } }, 80) === 'high');

  /* ---------------- DeepSeek：双链路 ---------------- */
  console.log('\nDeepSeek 实现:');
  const ds = providers.byId('deepseek');
  const BAL = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '128.66', granted_balance: '0', topped_up_balance: '128.66' }] };
  const COST = (days) => ({
    code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: {
      currency: 'CNY', days: days.map(([date, amounts]) => ({ date, data: [{ usage: amounts.map((a) => ({ type: 'COMPLETION', amount: String(a) })) }] })),
      total: [{ model: 'deepseek-v4', usage: [{ type: 'COMPLETION', amount: '9.9' }] }],
    } },
  });
  const AMT = { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { total: [{ model: 'deepseek-v4', usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: '100' }, { type: 'RESPONSE_TOKEN', amount: '7' }] }] } } };

  /** 按 URL 路由的 mock fetch */
  function dsFetch(routes) {
    return async (url) => {
      for (const [re, fn] of routes) if (re.test(String(url))) return fn();
      throw new Error('意外请求: ' + url);
    };
  }

  let samples = [];
  const mkStore = () => ({ get samples() { return samples; }, setSamples(v) { samples = v; }, save() { saved = true; } });
  let saved = false;
  const now = Date.now();
  const nd = new Date(now);
  const CUR = `month=${nd.getUTCMonth() + 1}&year=${nd.getUTCFullYear()}`;
  const PM = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() - 1, 1));
  const PREV = `month=${PM.getUTCMonth() + 1}&year=${PM.getUTCFullYear()}`;
  const today = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-19`;
  const ctx = {
    fetchImpl: dsFetch([
      [/api\.deepseek\.com\/user\/balance/, () => res(BAL)],
      [new RegExp(`usage\\/cost\\?${CUR}`), () => res(COST([[today, [1.5]]]))],
      [new RegExp(`usage\\/cost\\?${PREV}`), () => res(COST([]))],
      [/usage\/amount/, () => res(AMT)],
    ]),
    accountName: '', config: { dsRange: '7d' }, prev: null, prevKind: 'boot', prevPlatform: 'empty',
    alertState: {}, mem: { notified: {} }, store: mkStore(), now,
  };

  const d1 = await ds.fetch({ apiKey: 'sk-x', platformToken: 'pt' }, ctx);
  t('余额链路成功', d1.ok && d1.data.balance.total === 128.66);
  t('平台账单链路成功', d1.data.platform.status === 'ok');
  t('汇总走平台口径', d1.data.summary && d1.data.summary.source === 'platform');
  t('本月消费 = 1.5', Math.abs(d1.data.summary.month - 1.5) < 1e-9, j(d1.data.summary.month));
  t('token 分类求和', d1.data.tokens.total.promptTokens === 100 && d1.data.tokens.total.response === 7);
  t('样本已记录并触发落盘', samples.length === 1 && saved);

  // 余额失效：整体 expired，但平台链路照常、余额沿用旧值
  const d2ctx = { ...ctx, prev: d1.data, prevKind: 'ok', store: mkStore() };
  samples = [];
  const d2 = await ds.fetch({ apiKey: 'sk-x', platformToken: 'pt' }, {
    ...d2ctx,
    fetchImpl: dsFetch([
      [/api\.deepseek\.com\/user\/balance/, () => res({}, 401)],
      [new RegExp(`usage\\/cost\\?${CUR}`), () => res(COST([]))],
      [new RegExp(`usage\\/cost\\?${PREV}`), () => res(COST([]))],
      [/usage\/amount/, () => res(AMT)],
    ]),
  });
  t('余额失效 → 顶层 expired', d2.ok === false && d2.kind === 'expired');
  t('失效带一次性提醒', d2.notes.length === 1 && /API Key 已失效/.test(d2.notes[0].title));
  t('平台链路不受余额失效影响', d2.data.platform.status === 'ok');
  t('余额沿用上次成功值（UI 不闪空）', d2.data.balance && d2.data.balance.total === 128.66);

  // 平台会话过期：只降级精确账单
  const d3 = await ds.fetch({ apiKey: 'sk-x', platformToken: 'pt' }, {
    ...ctx, prev: d1.data, prevKind: 'ok', prevPlatform: 'ok', store: mkStore(),
    fetchImpl: dsFetch([
      [/api\.deepseek\.com\/user\/balance/, () => res(BAL)],
      [new RegExp(`usage\\/cost\\?(${CUR}|${PREV})`), () => res({ code: 40002, msg: 'login required' })],
      [/usage\/amount/, () => res({ code: 40002, msg: 'login required' })],
    ]),
  });
  t('平台过期 → 整体仍 ok（余额链路正常）', d3.ok === true);
  t('平台子状态 = expired + 提醒', d3.data.platform.status === 'expired' && d3.notes.length === 1);
  t('汇总退回本地差值口径', d3.data.summary.source === 'local');

  // 高频轮询：只拉余额，平台状态沿用
  samples = [];
  const p1 = await ds.pollBalance({ apiKey: 'sk-x' }, {
    ...ctx, prev: d3.data, prevKind: 'ok', store: mkStore(),
    fetchImpl: dsFetch([[/.*/, () => res(BAL)]]),
  });
  t('轮询成功且样本推进', p1.ok && samples.length === 1);
  t('轮询不碰平台账单（状态沿用上次）', p1.data.platform.status === 'expired');

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
