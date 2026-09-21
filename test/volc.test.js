'use strict';
/**
 * lib/volc.js 测试：签名、归一化、错误路径。全部用注入的 fetchImpl，不发真实请求。
 *
 * 签名那条黄金向量**不是**自己算出来的：是把官方 Python SDK
 * （volcengine/volcengine-python-sdk → volcenginesdkcore/signv4.py）的 SignerV4.sign
 * 原样抄成一段脚本、只把 datetime.utcnow() 换成固定的 20260920T101530Z 后跑出来的。
 * 它是唯一的「独立实现对照」——否则自己写、自己算、自己验，错了也不知道。
 */
const assert = require('assert');
const V = require('../lib/volc');

let pass = 0, fails = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fails++; console.log('  ✗', name, extra === undefined ? '' : `  [${extra}]`); process.exitCode = 1; }
}
const j = (o) => JSON.stringify(o);

/** mock 响应：text() 是 lib/volc.js 读的接口 */
const res = (body, status = 200) => ({
  status, ok: status === 200,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/* ---------------- 签名（官方算法对照） ---------------- */
console.log('签名 V4:');
const GOLDEN_AK = 'AKLTtestAccessKeyId0000000';
const GOLDEN_SK = 'testSecretAccessKey0000000000000000000000';
const GOLDEN_DATE = new Date(Date.UTC(2026, 8, 20, 10, 15, 30));   // 20260920T101530Z
const GOLDEN_SIG = '825595316bf739087ba1846b96060a73a530adb5ddae2d4fffa4b8e272597c2a';
const EMPTY_OBJ_HASH = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

const g = V.signRequest(GOLDEN_AK, GOLDEN_SK, 'GetCodingPlanUsage', GOLDEN_DATE);
t('黄金向量：签名与官方 SDK 一致', g.signature === GOLDEN_SIG, g.signature);
t('参与签名的头就是官方那四个（顺序固定）',
  g.signedHeaders === 'content-type;host;x-content-sha256;x-date', g.signedHeaders);
t('空对象体的哈希正确', g.headers['X-Content-Sha256'] === EMPTY_OBJ_HASH);
t('X-Date 是 UTC 的紧凑格式', g.headers['X-Date'] === '20260920T101530Z', g.headers['X-Date']);
t('Authorization 的 Credential 作用域正确',
  g.headers.Authorization.includes(`Credential=${GOLDEN_AK}/20260920/cn-beijing/ark/request`), g.headers.Authorization);
t('Authorization 三段齐全',
  /^HMAC-SHA256 Credential=.+, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/
    .test(g.headers.Authorization));
t('规范请求逐行正确', g.canonicalRequest === [
  'POST',
  '/',
  'Action=GetCodingPlanUsage&Version=2024-01-01',
  'content-type:application/json',
  'host:open.volcengineapi.com',
  `x-content-sha256:${EMPTY_OBJ_HASH}`,
  'x-date:20260920T101530Z',
  '',
  'content-type;host;x-content-sha256;x-date',
  EMPTY_OBJ_HASH,
].join('\n'), j(g.canonicalRequest));
t('不带 Host 外发（Fetch 规范里它是禁止设置的请求头）', g.headers.Host === undefined);
t('URL 带 Action 与 Version', g.url === 'https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01', g.url);
t('换个 Action 签名就变', V.signRequest(GOLDEN_AK, GOLDEN_SK, 'GetAgentPlanAFPUsage', GOLDEN_DATE).signature !== GOLDEN_SIG);
t('换个密钥签名就变', V.signRequest(GOLDEN_AK, 'other-secret-000000000000000000000000', 'GetCodingPlanUsage', GOLDEN_DATE).signature !== GOLDEN_SIG);

// 与 Python quote(safe='-_.~') 对齐：这几个字符 encodeURIComponent 不转，但官方要转
t('RFC3986 转义覆盖 !*\'() ', V.encodeRfc3986("a!*'()b") === 'a%21%2A%27%28%29b', V.encodeRfc3986("a!*'()b"));
t('保留 -_.~ 不转', V.encodeRfc3986('a-b_c.d~e') === 'a-b_c.d~e');
t('查询串按 (键,值) 字典序', V.canonicalQuery({ Version: '2024-01-01', Action: 'X' }) === 'Action=X&Version=2024-01-01');

/* ---------------- 重置时间归一 ---------------- */
console.log('\n重置时间归一:');
const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const H5 = V.WINDOW_MS.five;
t('秒级时间戳被识别并 ×1000', V.normReset(Math.floor((NOW + H5) / 1000), H5, NOW) === NOW + H5);
t('毫秒级时间戳原样透传', V.normReset(NOW + H5, H5, NOW) === NOW + H5);
t('已经过去的重置时间 → null（否则倒计时永远显示「即将重置」）', V.normReset(NOW - H5 * 2, H5, NOW) === null);
t('远到离谱的未来 → null', V.normReset(NOW + H5 * 10, H5, NOW) === null);
t('零/空/非数 → null', V.normReset(0, H5, NOW) === null && V.normReset(null, H5, NOW) === null && V.normReset('x', H5, NOW) === null);
t('月窗口的容忍范围更宽（30 天外的重置仍算可信）',
  V.normReset(NOW + 29 * 86400e3, 30 * 86400e3, NOW) === NOW + 29 * 86400e3);

/* ---------------- 响应归一 ---------------- */
console.log('\n响应归一:');
const codingPayload = (items) => ({ ResponseMetadata: { RequestId: 'r' }, Result: { QuotaUsage: items } });
const mk = (level, percent, resetSec) => ({ Level: level, Percent: percent, ResetTimestamp: resetSec });
const secIn = (ms) => Math.floor((NOW + ms) / 1000);

/** normalize 收的是 Result（fetchPlan 负责把信封拆到 Result 再交进来） */
const result = (items) => ({ QuotaUsage: items });

{
  const n = V.normalize('coding', result([
    mk('session', 41.6, secIn(H5)), mk('weekly', 23, secIn(7 * 86400e3)), mk('monthly', 7, secIn(20 * 86400e3)),
  ]), NOW).windows;
  t('Coding：session→5h / weekly→周 / monthly→月', n.five.percent === 42 && n.week.percent === 23 && n.month.percent === 7);
  t('Coding：百分比四舍五入取整', n.five.percent === 42, n.five.percent);
  t('Coding：没有绝对值，used/total/remaining 都是 null（不假装有）',
    n.five.used === null && n.five.total === null && n.five.remaining === null);
  t('Coding：窗口开始时间 = 重置时间 − 5 小时', n.five.windowStart === n.five.nextResetTime - H5);
}
{
  const n = V.normalize('coding', result([mk('session', 10, secIn(H5))]), NOW);
  t('Coding：缺的窗口标 known:false，且 percent 仍是数值 0（null 会画成满格）',
    n.windows.week.known === false && n.windows.week.percent === 0 && typeof n.windows.week.percent === 'number');
  t('Coding：缺的窗口没有重置时间', n.windows.week.nextResetTime === null && n.windows.week.windowStart === null);
}
{
  // Level 认不出来时，按「重置越早窗口越短」兜底排进 five/week/month
  const n = V.normalize('coding', result([
    mk('weird-c', 90, secIn(20 * 86400e3)), mk('weird-a', 11, secIn(H5)), mk('weird-b', 55, secIn(7 * 86400e3)),
  ]), NOW).windows;
  t('Coding：Level 未知时按重置时间排序兜底', n.five.percent === 11 && n.week.percent === 55 && n.month.percent === 90);
}
{
  const n = V.normalize('agent', {
    AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: NOW + H5 },
    AFPWeekly: { Quota: 50000, Used: 12500, ResetTime: NOW + 7 * 86400e3 },
    AFPMonthly: { Quota: 200000, Used: 5000, ResetTime: NOW + 20 * 86400e3 },
    Tier: 'medium',
  }, NOW);
  t('Agent：绝对值 / 百分比 / 剩余都对', n.windows.five.percent === 25 && n.windows.five.used === 250
    && n.windows.five.total === 1000 && n.windows.five.remaining === 750);
  t('Agent：档位透传', n.level === 'medium');
  t('Agent：三个窗口都 known', n.windows.five.known && n.windows.week.known && n.windows.month.known);
  t('Agent：月窗口的开始时间按自然月回推（不是固定 30 天）',
    n.windows.month.windowStart < n.windows.month.nextResetTime - 27 * 86400e3
    && n.windows.month.windowStart > n.windows.month.nextResetTime - 32 * 86400e3);
  t('Agent：percent 不会越界', V.normalize('agent', {
    AFPFiveHour: { Quota: 10, Used: 999, ResetTime: NOW + H5 } }, NOW).windows.five.percent === 100);
}
t('没订阅：QuotaUsage 为空 → subscribed:false', V.normalize('coding', { QuotaUsage: [] }, NOW).subscribed === false);
t('没订阅：没有 AFP 字段 → subscribed:false', V.normalize('agent', {}, NOW).subscribed === false);

/* ---------------- 请求与错误路径 ---------------- */
(async () => {
  console.log('\n请求与错误路径:');
  const CREDS = { accessKeyId: GOLDEN_AK, accessKeySecret: GOLDEN_SK };
  const okFetch = (payload) => async () => res(payload);

  const codingOk = codingPayload([mk('session', 40, secIn(H5)), mk('weekly', 20, secIn(7 * 86400e3))]);
  const r1 = await V.fetchPlan('coding', CREDS, okFetch(codingOk), NOW);
  t('成功：拿到 subscribed + 窗口', r1.ok && r1.data.subscribed && r1.data.plan === 'coding' && r1.data.windows.five.percent === 40);

  const r2 = await V.fetchPlan('coding', CREDS, okFetch(codingPayload([])), NOW);
  t('未订阅不算错：ok:true + subscribed:false', r2.ok === true && r2.data.subscribed === false);

  // 鉴权错：报文里的码才是准的（HTTP 200 也可能带错误信封）
  const errBody = (code, message) => ({ ResponseMetadata: { Error: { Code: code, Message: message } } });
  const r3 = await V.fetchPlan('coding', CREDS, okFetch(errBody('InvalidAccessKey', 'bad ak')), NOW);
  t('InvalidAccessKey → expired + 「AK/SK 无效」', r3.ok === false && r3.kind === 'expired' && /AK\/SK 无效/.test(r3.msg), r3.msg);
  const r4 = await V.fetchPlan('coding', CREDS, okFetch(errBody('SignatureDoesNotMatch', 'sig')), NOW);
  t('SignatureDoesNotMatch → expired 且提示签名不匹配', r4.kind === 'expired' && /签名不匹配/.test(r4.msg), r4.msg);
  const r5 = await V.fetchPlan('coding', CREDS, okFetch(errBody('AccessDenied', 'denied')), NOW);
  t('AccessDenied → expired 但提示是「缺权限」并给出策略名',
    r5.kind === 'expired' && /ArkReadOnlyAccess/.test(r5.msg) && /权限/.test(r5.msg), r5.msg);
  t('「密钥错」与「权限不够」的文案不是同一句', r3.msg !== r5.msg);

  // HTTP 200 + 错误信封：不先查它就会把报错当有效数据，进而误判成「未订阅」
  const r6 = await V.fetchPlan('coding', CREDS, okFetch(errBody('InternalError', 'boom')), NOW);
  t('200 上的业务错误被识别为 parse 错而不是「未订阅」', r6.ok === false && r6.kind === 'parse', j(r6));

  const r7 = await V.fetchPlan('coding', CREDS, async () => res({}, 429), NOW);
  t('429 → ratelimit', r7.kind === 'ratelimit');
  const r8 = await V.fetchPlan('coding', CREDS, async () => res('gateway timeout', 502), NOW);
  t('非 JSON 的失败 → parse 且带原文', r8.kind === 'parse' && /gateway timeout/.test(r8.msg), r8.msg);
  const r9 = await V.fetchPlan('coding', CREDS, async () => { const e = new Error('boom'); e.name = 'TypeError'; throw e; }, NOW);
  t('网络异常 → network', r9.kind === 'network' && /boom/.test(r9.msg));
  const r10 = await V.fetchPlan('coding', {}, okFetch(codingOk), NOW);
  t('没配凭据 → expired', r10.kind === 'expired' && /未配置/.test(r10.msg));

  // 请求确实带上了签名头与 body
  let seen = null;
  await V.fetchPlan('coding', CREDS, async (url, opt) => { seen = { url, opt }; return res(codingOk); }, NOW);
  t('发的是 POST 且带 Authorization / X-Date / X-Content-Sha256',
    seen.opt.method === 'POST' && !!seen.opt.headers.Authorization
    && !!seen.opt.headers['X-Date'] && !!seen.opt.headers['X-Content-Sha256']);
  t('签名覆盖的 body 与外发 body 完全一致', seen.opt.body === '{}');
  t('请求带 15 秒超时信号', !!seen.opt.signal);

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
