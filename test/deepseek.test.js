'use strict';
/**
 * DeepSeek 数据层测试：凭据提取 / 余额解析 / 平台信封与账单解析 / 差值历史聚合
 * 真实联测：DS_API_KEY 环境变量存在时打一次真实余额（不打印 Key，不落盘）
 */
const assert = require('assert');
const {
  extractDsToken, extractPlatformToken, fetchBalance, fetchMonthlyCost, fetchMonthlyAmount,
} = require('../lib/deepseek');
const {
  appendSample, byDayMap, summarize, summarizePlatform,
  hourlySeries, minuteSeries, bucketSeries, spentSince, thin,
} = require('../lib/ds-history');
const { dayKey } = require('../lib/format');

let pass = 0, fails = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fails++; console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fails++; console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}
const jsonRes = (status, body) => ({ status, json: async () => body });

/* ---------------- 凭据提取 ---------------- */
console.log('extractDsToken:');
const KEY = 'sk-0123456789abcdef0123456789abcdef';
t('直通', () => assert.strictEqual(extractDsToken(KEY), KEY));
t('混排文本提取', () => assert.strictEqual(extractDsToken(`我的 key：${KEY} 请用`), KEY));
t('嵌在更长的标识符里不误吞', () => assert.strictEqual(extractDsToken(`x${KEY}y`), ''));
t('前后是界符时正常提取', () => assert.strictEqual(extractDsToken(`key=${KEY}&foo=1`), KEY));
t('空/垃圾输入', () => { assert.strictEqual(extractDsToken(''), ''); assert.strictEqual(extractDsToken('sk-短'), ''); assert.strictEqual(extractDsToken('hello'), ''); });
t('GLM 那种 32.16 的 key 不会被当成 DS key', () => assert.strictEqual(extractDsToken('abcdefghijklmnopqrstuvwxyzabcdef.abcdefghijklmnop'), ''));

console.log('\nextractPlatformToken:');
const PT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEyMzQ1fQ.signature_part_here';
t('裸 token', () => assert.strictEqual(extractPlatformToken(PT), PT));
t('localStorage 的 JSON 串', () => assert.strictEqual(extractPlatformToken(JSON.stringify({ value: PT, expireAt: 1 })), PT));
t('双重编码的 JSON 串', () => assert.strictEqual(extractPlatformToken(JSON.stringify(JSON.stringify({ value: PT }))), PT));
t('Bearer 前缀', () => assert.strictEqual(extractPlatformToken('Bearer ' + PT), PT));
t('userToken: 前缀', () => assert.strictEqual(extractPlatformToken('userToken: ' + PT), PT));
t('空/垃圾输入', () => { assert.strictEqual(extractPlatformToken(''), ''); assert.strictEqual(extractPlatformToken('abc'), ''); assert.strictEqual(extractPlatformToken('{"value":""}'), ''); });

/* ---------------- 余额解析 ---------------- */
console.log('\nfetchBalance 解析:');
const OK_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
    { currency: 'CNY', total_balance: '321.89', granted_balance: '2.00', topped_up_balance: '319.89' },
  ],
};
(async () => {
  await ta('有余额的币种优先（USD 为 0 时取 CNY）', async () => {
    const r = await fetchBalance('k', async () => jsonRes(200, OK_BODY));
    assert.ok(r.ok);
    assert.strictEqual(r.data.currency, 'CNY');
    assert.strictEqual(r.data.total, 321.89);
    assert.strictEqual(r.data.granted, 2);
    assert.strictEqual(r.data.toppedUp, 319.89);
    assert.strictEqual(r.data.available, true);
    assert.strictEqual(r.data.all.length, 2);
  });
  await ta('只有 USD 账户也能用', async () => {
    const r = await fetchBalance('k', async () => jsonRes(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.5', granted_balance: '0', topped_up_balance: '12.5' }] }));
    assert.ok(r.ok); assert.strictEqual(r.data.currency, 'USD'); assert.strictEqual(r.data.total, 12.5);
  });
  await ta('全都为零时回退 CNY', async () => {
    const r = await fetchBalance('k', async () => jsonRes(200, { is_available: false, balance_infos: [
      { currency: 'USD', total_balance: '0', granted_balance: '0', topped_up_balance: '0' },
      { currency: 'CNY', total_balance: '0', granted_balance: '0', topped_up_balance: '0' },
    ] }));
    assert.ok(r.ok); assert.strictEqual(r.data.currency, 'CNY'); assert.strictEqual(r.data.available, false);
  });
  await ta('401 → expired', async () => {
    const r = await fetchBalance('k', async () => jsonRes(401, {}));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'expired');
  });
  await ta('429 → ratelimit', async () => {
    const r = await fetchBalance('k', async () => jsonRes(429, {}));
    assert.strictEqual(r.kind, 'ratelimit');
  });
  await ta('缺 balance_infos → parse 且带原文', async () => {
    const r = await fetchBalance('k', async () => jsonRes(200, { is_available: true }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'parse'); assert.ok(r.msg.includes('原文='));
  });
  await ta('网络异常 → network', async () => {
    const r = await fetchBalance('k', async () => { throw new Error('boom'); });
    assert.strictEqual(r.kind, 'network');
  });
  await ta('未配置 Key → expired', async () => {
    const r = await fetchBalance('');
    assert.strictEqual(r.kind, 'expired');
  });

  /* ---------------- 平台信封 ---------------- */
  console.log('\n平台信封与错误码:');
  const wrap = (code, bizCode, bizData) => ({ code, msg: '', data: { biz_code: bizCode, biz_msg: '', biz_data: bizData } });
  await ta('code=0 且 biz_code=0 → 取 biz_data', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, { currency: 'CNY', days: [], total: [] })));
    assert.ok(r.ok);
  });
  await ta('顶层 code=40002 → expired', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(40002, 0, null)));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'expired');
  });
  await ta('biz_code=40003 → expired', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 40003, null)));
    assert.strictEqual(r.kind, 'expired');
  });
  await ta('HTTP 401 → expired（也覆盖平台直接返 401）', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(401, {}));
    assert.strictEqual(r.kind, 'expired');
  });
  await ta('未知错误码 → parse 且带原文', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(500, 0, null)));
    assert.strictEqual(r.kind, 'parse'); assert.ok(r.msg.includes('原文='));
  });

  /* ---------------- 账单解析 ---------------- */
  console.log('\n账单/用量解析:');
  const COST_BIZ = {
    currency: 'CNY',
    total: [{ model: 'deepseek-flash', usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: '0.5' }, { type: 'RESPONSE_TOKEN', amount: '1.5' }] }],
    days: [
      { date: '2026-09-12', data: [{ model: 'deepseek-flash', usage: [{ type: 'RESPONSE_TOKEN', amount: '2.0' }] }] },
      { date: '2026-09-13', data: [
        { model: 'deepseek-flash', usage: [{ type: 'RESPONSE_TOKEN', amount: '1.25' }] },
        { model: 'deepseek-v4-pro', usage: [{ type: 'RESPONSE_TOKEN', amount: '0.75' }] },
      ] },
      { date: 'bad-date', data: [] },
    ],
  };
  await ta('逐日消费求和 + 过滤非法日期', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, COST_BIZ)));
    assert.ok(r.ok);
    assert.deepStrictEqual(r.data.byDay, [{ date: '2026-09-12', cost: 2 }, { date: '2026-09-13', cost: 2 }]);
    assert.strictEqual(Math.round(r.data.total * 100) / 100, 4);
  });
  await ta('biz_data 是单元素数组形态也能解析（历史变体）', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, [COST_BIZ])));
    assert.ok(r.ok); assert.strictEqual(r.data.total, 4);
  });
  await ta('按模型汇总（REQUEST 不计入金额）', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, COST_BIZ)));
    assert.deepStrictEqual(r.data.byModel, [{ model: 'deepseek-flash', cost: 2 }]);
  });
  await ta('days 缺失 → parse', async () => {
    const r = await fetchMonthlyCost('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, { currency: 'CNY' })));
    assert.strictEqual(r.kind, 'parse');
  });

  const AMOUNT_BIZ = {
    total: [
      { model: 'deepseek-flash', usage: [
        { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '100686720' },
        { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '1305432' },
        { type: 'RESPONSE_TOKEN', amount: '656338' },
        { type: 'REQUEST', amount: '1212' },
        { type: 'UNKNOWN_FUTURE_TYPE', amount: '999' },
      ] },
    ],
  };
  await ta('token 分类：hit+miss+response，REQUEST 单列，未知类型忽略', async () => {
    // 断言取自社区测试夹具：三类 token 求和 = 102648490
    const r = await fetchMonthlyAmount('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, AMOUNT_BIZ)));
    assert.ok(r.ok);
    assert.strictEqual(r.data.total.total, 102648490);
    assert.strictEqual(r.data.total.request, 1212);
    assert.strictEqual(r.data.total.cacheHit, 100686720);
    assert.strictEqual(r.data.byModel[0].model, 'deepseek-flash');
  });
  await ta('PROMPT_TOKEN 与 hit/miss 并存时不重复累加', async () => {
    const r = await fetchMonthlyAmount('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, {
      total: [{ model: 'm', usage: [
        { type: 'PROMPT_TOKEN', amount: '1000' },
        { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '600' },
        { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '400' },
      ] }],
    })));
    assert.strictEqual(r.data.total.promptTokens, 1000); // 600+400，而不是 2000
  });
  await ta('只有 PROMPT_TOKEN 时用它兜底', async () => {
    const r = await fetchMonthlyAmount('t', { year: 2026, month: 9 }, async () => jsonRes(200, wrap(0, 0, {
      total: [{ model: 'm', usage: [{ type: 'PROMPT_TOKEN', amount: '700' }] }],
    })));
    assert.strictEqual(r.data.total.promptTokens, 700);
  });

  /* ---------------- 差值历史 ---------------- */
  console.log('\n差值历史聚合:');
  const D = 86400e3;
  const NOW = new Date('2026-09-14T20:00:00+08:00').getTime();
  const at = (daysAgo, hour) => new Date(new Date('2026-09-14T00:00:00+08:00').getTime() - daysAgo * D + (hour || 12) * 3600e3).getTime();
  t('dayKey 按本机时区', () => assert.strictEqual(dayKey(NOW), '2026-09-14'));
  t('样本抽稀：同值轮询不落盘，跨天首条保留', () => {
    let s = [];
    s = appendSample(s, at(1, 10), 100);
    s = appendSample(s, at(1, 11), 100);   // 无变化 → 丢
    s = appendSample(s, at(1, 12), 98);    // 有变化 → 留
    s = appendSample(s, at(0, 9), 98);     // 无变化但跨天 → 留
    assert.strictEqual(s.length, 3);
  });
  t('消费归到后一个样本所在日', () => {
    let s = [];
    s = appendSample(s, at(1, 10), 100);
    s = appendSample(s, at(1, 18), 97);    // 昨天花 3
    s = appendSample(s, at(0, 10), 95);    // 今天花 2
    const m = byDayMap(s);
    assert.strictEqual(m.get('2026-09-13').spend, 3);
    assert.strictEqual(m.get('2026-09-14').spend, 2);
  });
  t('充值（余额上升）不计入消费', () => {
    let s = [];
    s = appendSample(s, at(1, 10), 100);
    s = appendSample(s, at(1, 18), 90);    // 花 10
    s = appendSample(s, at(0, 10), 190);   // 充值 100
    const sum = summarize(s, NOW, { balance: 190 });
    assert.strictEqual(sum.today, 0);
    assert.strictEqual(sum.last7, 10);
  });
  t('今日 / 近7天 / 近30天 / 本月 / 日均 / 可用天数', () => {
    let s = [];
    s = appendSample(s, at(40, 10), 500);  // 08-05，用于验证区间裁剪
    s = appendSample(s, at(10, 10), 480);  // 09-04 ↓20
    s = appendSample(s, at(6, 10), 470);   // 09-08 ↓10
    s = appendSample(s, at(3, 10), 460);   // 09-11 ↓10
    s = appendSample(s, at(0, 10), 452);   // 09-14 ↓8
    const sum = summarize(s, NOW, { balance: 452 });
    assert.strictEqual(sum.today, 8);
    assert.strictEqual(sum.last7, 28);     // 近 7 天含今天：09-14 + 09-11 + 09-08
    assert.strictEqual(sum.last30, 48);    // 再加上 09-04 的 20
    assert.strictEqual(sum.month, 48);     // 该月内即上面全部（08-05 那笔在区间外）
    assert.strictEqual(sum.avg7, 4);
    assert.strictEqual(sum.daysLeft, Math.floor(452 / 4));
    assert.strictEqual(sum.series.length, 30);
    assert.strictEqual(sum.series[29].date, '2026-09-14');
    assert.strictEqual(sum.series[29].spend, 8);
    assert.strictEqual(sum.series[0].date, '2026-08-16'); // 序列首日 = 今天往前 29 天
  });
  t('本月按自然月、近30天按滚动窗口，两者口径不同', () => {
    let s = [];
    s = appendSample(s, at(25, 10), 500);  // 08-20
    s = appendSample(s, at(20, 10), 490);  // 08-25 ↓10 → 上月，但仍在近 30 天内
    s = appendSample(s, at(0, 10), 470);   // 09-14 ↓20
    const sum = summarize(s, NOW, { balance: 470 });
    assert.strictEqual(sum.last30, 30);    // 10 + 20
    assert.strictEqual(sum.month, 20);     // 只算 09-01 之后的
  });
  t('样本不足时 series 补零、since 为最早样本日', () => {
    let s = appendSample([], at(0, 10), 42);
    const sum = summarize(s, NOW, { balance: 42, days: 7 });
    assert.strictEqual(sum.series.length, 7);
    assert.strictEqual(sum.series.filter((d) => d.spend === 0).length, 7); // 只有一个样本 → 全是 0
    assert.strictEqual(sum.since, '2026-09-14');
    assert.strictEqual(sum.daysLeft, null); // 日均≈0 → 不给外推
  });
  t('乱序/非法样本既不炸也不误算', () => {
    // 时间倒流（时钟回拨/手工编辑）与非法元组都不参与差值计算
    const s = [[at(0, 12), 10], [at(0, 11), 20], ['x', 'y'], [at(0, 13), 5]];
    assert.strictEqual(byDayMap(s).size, 0);
    assert.strictEqual(summarize(s, NOW, { balance: 5 }).month, 0);
    assert.strictEqual(summarize([], NOW, {}).month, 0);
    assert.strictEqual(summarize(null, NOW, {}).series.length, 30);
  });

  /* ---------------- 小时级实时读数 ---------------- */
  console.log('\n小时级视图（实时读数的唯一来源）：');
  const H = 3600e3;
  const atHour = (h, m) => new Date(new Date('2026-09-14T00:00:00+08:00').getTime() + h * H + (m || 0) * 60000).getTime();
  t('按小时分桶：每个小时的消费各归各的', () => {
    let s = [];
    s = appendSample(s, atHour(9, 5), 100);
    s = appendSample(s, atHour(9, 55), 98);    // 9 点花 2
    s = appendSample(s, atHour(10, 30), 95);   // 10 点花 3
    const now = atHour(10, 40);
    const h = hourlySeries(s, now, 24);
    assert.strictEqual(h.length, 24);
    assert.strictEqual(h[23].spend, 3);        // 当前小时（进行中）
    assert.strictEqual(h[23].partial, true);
    assert.strictEqual(h[22].spend, 2);        // 上一小时
    assert.strictEqual(h[21].spend, 0);
    assert.strictEqual(h[22].partial, false);
  });
  t('小时桶按绝对时间对齐，不随时区漂移', () => {
    let s = [];
    s = appendSample(s, atHour(0, 10), 50);
    s = appendSample(s, atHour(0, 50), 49.5);  // 0 点花 0.5
    const h = hourlySeries(s, atHour(1, 0), 3);
    assert.deepStrictEqual(h.map((x) => x.spend), [0, 0.5, 0]);  // 23点 / 0点 / 1点
    assert.strictEqual(h[1].partial, false);
    assert.strictEqual(h[2].partial, true);    // now 正好落在 1 点，当前格进行中
  });
  t('5 分钟粒度：近 1 小时 = 12 根柱子', () => {
    let s = [];
    s = appendSample(s, atHour(10, 0), 100);
    s = appendSample(s, atHour(10, 7), 99.9);    // 10:05 桶
    s = appendSample(s, atHour(10, 42), 99.5);   // 10:40 桶
    const now = atHour(10, 50);
    const f = minuteSeries(s, now, 60, 5);
    assert.strictEqual(f.length, 12);
    assert.strictEqual(f[11].ts - f[10].ts, 5 * 60000, '桶宽 5 分钟');
    assert.strictEqual(f[11].partial, true);
    assert.strictEqual(f.filter((x) => x.spend > 0).length, 2);
    // 桶边界落在 :00/:05/:10 这类整点上
    assert.strictEqual(new Date(f[0].ts).getMinutes() % 5, 0);
    assert.strictEqual(Math.round(f.reduce((a, x) => a + x.spend, 0) * 100) / 100, 0.5);  // 0.1 + 0.4
  });
  t('分桶函数通用：跨度 ÷ 桶宽 = 柱子数', () => {
    assert.strictEqual(bucketSeries([], NOW, 15 * 60000, 5 * 60000).length, 3);
    assert.strictEqual(bucketSeries([], NOW, 3600e3, 300e3).length, 12);
    assert.strictEqual(bucketSeries([], NOW, 24 * 3600e3, 3600e3).length, 24);
    assert.strictEqual(bucketSeries([], NOW, 30 * 86400e3, 86400e3).length, 30);
    assert.strictEqual(bucketSeries([], NOW, 999 * 3600e3, 3600e3).length, 240, '上限 240 桶');
  });
  t('spentSince：只算窗口内的消费', () => {
    let s = [];
    s = appendSample(s, atHour(8, 0), 100);
    s = appendSample(s, atHour(9, 0), 97);     // 8-9 点花 3
    s = appendSample(s, atHour(10, 0), 96);    // 9-10 点花 1
    const now = atHour(10, 30);
    assert.strictEqual(spentSince(s, now - H), 1);        // 最近 1 小时只含 9-10 那笔
    assert.strictEqual(spentSince(s, now - 3 * H), 4);
    assert.strictEqual(spentSince(s, now - 10 * H), 4);
  });
  t('充值不计入实时读数', () => {
    let s = [];
    s = appendSample(s, atHour(9, 0), 100);
    s = appendSample(s, atHour(9, 30), 200);   // 充值
    s = appendSample(s, atHour(10, 0), 199);   // 花 1
    const now = atHour(10, 10);
    assert.strictEqual(spentSince(s, now - 2 * H), 1);
    assert.strictEqual(hourlySeries(s, now, 24)[23].spend, 1);
  });
  t('summarize 两种口径都带实时读数', () => {
    let s = [];
    s = appendSample(s, atHour(9, 0), 100);
    s = appendSample(s, atHour(10, 0), 96);
    const now = atHour(10, 30);
    const a = summarize(s, now, { balance: 96 });
    assert.strictEqual(a.hourly.length, 24);
    assert.strictEqual(a.fine.length, 12, '汇总里带 5 分钟序列');
    assert.strictEqual(a.last5m, 0);
    assert.strictEqual(a.last1h, 4);
    assert.ok(a.firstSampleAt > 0);
    const month = { month: '2026-09', currency: 'CNY', total: 1, byDay: [{ date: '2026-09-14', cost: 1 }], byModel: [] };
    const b = summarizePlatform([month], now, { samples: s, days: 7 });
    assert.strictEqual(b.hourly.length, 24);
    assert.strictEqual(b.last1h, 4);           // 平台口径下实时读数仍来自本地样本
    assert.strictEqual(summarizePlatform([month], now, {}).last1h, 0);  // 没样本时不炸
  });
  t('规模抽稀：两天内保细粒度，更早的降到每小时，且逐日合计不变', () => {
    // 30 天 × 每 20 分钟一条 = 2160 条（比 2 分钟轮询温和，但已超过抽稀阈值）
    const raw = [];
    const start = NOW - 30 * 86400e3;
    let bal = 500;
    for (let i = 0; i < 30 * 24 * 3; i++) { bal -= 0.01; raw.push([start + i * 20 * 60000, bal]); }
    const thinned = thin(raw, NOW);
    assert.ok(thinned.length < raw.length, `抽稀生效：${thinned.length} < ${raw.length}`);
    assert.ok(thinned.length < 1200, '抽稀后规模可控：' + thinned.length);
    assert.strictEqual(thinned.filter((x) => x[0] >= NOW - 48 * 3600e3).length, 48 * 3, '近 48 小时原样保留');
    assert.strictEqual(thinned[thinned.length - 1][0], raw[raw.length - 1][0], '最后一个样本必须保留（下次差分的基准）');
    // 关键性质：相邻两点覆盖整段时间，所以逐日合计抽稀前后必须一致
    const sum = (m) => [...m.values()].reduce((a, v) => a + v.spend, 0);
    assert.ok(Math.abs(sum(byDayMap(raw)) - sum(byDayMap(thinned))) < 1e-6);
  });
  t('小规模数据不做任何抽稀（日常用量下无损）', () => {
    let s = [];
    for (let i = 0; i < 200; i++) s = appendSample(s, NOW - (200 - i) * 60000, 100 - i * 0.1);
    assert.strictEqual(s.length, 200);
  });

  /* ---------------- 平台账单口径汇总 ---------------- */
  console.log('\n平台账单口径汇总:');
  const curM = { month: '2026-09', currency: 'CNY', total: 3.5, byDay: [{ date: '2026-09-14', cost: 1.5 }, { date: '2026-09-10', cost: 2.0 }], byModel: [{ model: 'deepseek-flash', cost: 3.5 }] };
  const prevM = { month: '2026-08', currency: 'CNY', total: 3.0, byDay: [{ date: '2026-08-20', cost: 3.0 }], byModel: [] };
  t('今日/近7天/近30天/本月 都按 UTC 日界取数', () => {
    const s = summarizePlatform([curM, prevM], NOW, { days: 7, balance: 100 });
    assert.strictEqual(s.source, 'platform');
    assert.strictEqual(s.today, 1.5);
    assert.strictEqual(s.last7, 3.5);       // 09-14 + 09-10
    assert.strictEqual(s.last30, 6.5);      // 再加 08-20（上月的日子，靠上月数据补全）
    assert.strictEqual(s.month, 3.5);       // 只算 2026-09
    assert.strictEqual(s.monthLabel, '2026-09');
    assert.strictEqual(s.currency, 'CNY');
    assert.strictEqual(s.daysLeft, Math.floor(100 / 0.5));
    assert.strictEqual(s.series.length, 7);
    assert.strictEqual(s.series[6].date, '2026-09-14');
    assert.strictEqual(s.series[6].spend, 1.5);
  });
  t('只给当月时近30天按现有数据算，不报错', () => {
    const s = summarizePlatform([curM], NOW, { days: 30 });
    assert.strictEqual(s.last30, 3.5);
    assert.strictEqual(s.series.length, 30);
  });
  t('UTC 日界与本地日界在凌晨会错开一天', () => {
    const morning = new Date('2026-09-14T07:00:00+08:00').getTime(); // = 09-13 23:00 UTC
    const s = summarizePlatform([curM], morning, { days: 2 });
    assert.strictEqual(s.today, 0);                    // UTC 口径下今天还是 09-13
    assert.strictEqual(s.series[1].date, '2026-09-13');
  });
  t('空/坏输入安全', () => {
    const s = summarizePlatform([], NOW, { days: 7 });
    assert.strictEqual(s.today, 0);
    assert.strictEqual(s.series.length, 7);
    assert.strictEqual(summarizePlatform(null, NOW, {}).month, 0);
  });

  /* ---------------- 真实联测 ---------------- */
  const key = process.env.DS_API_KEY;
  if (!key) {
    console.log('\n(跳过真实余额联测：无 DS_API_KEY env)');
  } else {
    console.log('\n真实余额联测:');
    await ta('余额接口鉴权与解析', async () => {
      const r = await fetchBalance(key);
      if (!r.ok) throw new Error(`${r.kind}: ${r.msg}`);
      assert.ok(Number.isFinite(r.data.total));
      assert.ok(r.data.currency);
      // 只打印口径，不打印凭据
      console.log(`     → ${r.data.currency} ${r.data.total} · 可用=${r.data.available} · 充值=${r.data.toppedUp} 赠送=${r.data.granted}`);
    });
  }

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : ''}`);
})();
