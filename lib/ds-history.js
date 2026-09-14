'use strict';
/**
 * DeepSeek 余额差值历史（纯函数，无 IO）
 *
 * 官方没有用量/消费查询接口，未配置平台令牌时靠余额差值推算消费：
 * 每次成功刷新把 (时间戳, 余额) 追加成样本，相邻两点的余额**下降**记为消费、
 * **上升**记为充值（不计入消费，避免把充值误算成负消费）。
 *
 * 口径与局限：
 *  - 消费归到「后一个样本所在的那天」（本机时区，与界面一致）
 *  - 挂件没运行的时段无法回填，整段差额并入下一次采样那天 —— 界面上标注为「本地累计」
 *  - 余额是账号级的：同账号下别的客户端/别的 Key 的消耗也会被算进来（本来就是同一份账单）
 */
const { dayKey, utcDayKey } = require('./format');

const EPS = 0.0001;        // 小于一厘的抖动不算变化
const MAX_SAMPLES = 6000;  // 上限保护（抽稀后 90 天约 3500 条）
const KEEP_DAYS = 90;
const FINE_MS = 48 * 3600e3;   // 近 48 小时保留每一个变化点（小时图靠它）
const COARSE_MS = 3600e3;      // 更早的样本降采样到每小时一个（逐日合计仍然精确）

/**
 * 规模控制：余额高频轮询（默认 2 分钟）下，重度使用一天就能攒上千条。
 * 两天以内原样保留（小时级视图需要细粒度），更早的每小时留一个采样点——
 * 相邻两点的差仍然覆盖整段时间，所以「每天花了多少」不会失真，只是跨日边界的
 * 归集误差从分钟级放宽到小时级。最后一个样本永远保留（下一次差分的基准）。
 */
function thin(list, now) {
  if (list.length <= 1500) return list;
  const cutoff = Number(now) - FINE_MS;
  const out = [];
  let lastKept = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (i === list.length - 1 || s[0] >= cutoff) { out.push(s); lastKept = s[0]; continue; }
    if (s[0] - lastKept >= COARSE_MS) { out.push(s); lastKept = s[0]; }
  }
  return out;
}

/**
 * 追加一个样本，返回新数组（不修改入参）。
 * 抽稀规则：余额与上一条不同、或当天第一条 —— 其余「没变化的轮询」丢掉，
 * 否则 10 分钟一轮 × 90 天会攒下上万条同值样本。
 */
function appendSample(samples, ts, balance) {
  const list = Array.isArray(samples) ? samples.slice() : [];
  const t = Number(ts), b = Number(balance);
  if (!Number.isFinite(t) || !Number.isFinite(b) || b < 0) return list;
  const last = list[list.length - 1];
  if (last && t - last[0] < 1000) {           // 同一毫秒级的重复写入：覆盖
    list[list.length - 1] = [t, b];
    return list;
  }
  const changed = !last || Math.abs(last[1] - b) > EPS;
  const newDay = !last || dayKey(last[0]) !== dayKey(t);
  if (!changed && !newDay) return list;        // 无变化且非当天首条 → 丢弃

  list.push([t, b]);
  // 先按天数裁剪，再做规模抽稀
  const cutoff = t - KEEP_DAYS * 86400e3;
  while (list.length && list[0][0] < cutoff) list.shift();
  return thin(list, t);
}

/** 逐日汇总消费与充值：返回 Map<'YYYY-MM-DD', {spend, topUp}> */
function byDayMap(samples) {
  const out = new Map();
  const list = Array.isArray(samples) ? samples : [];
  const bump = (date, spend, topUp) => {
    if (!date) return;
    const cur = out.get(date) || { spend: 0, topUp: 0 };
    cur.spend += spend; cur.topUp += topUp;
    out.set(date, cur);
  };
  for (let i = 1; i < list.length; i++) {
    const [t0, b0] = list[i - 1], [t1, b1] = list[i];
    if (!(t0 <= t1)) continue;                 // 乱序样本（时钟回拨等）跳过
    const d = b0 - b1;
    if (d > EPS) bump(dayKey(t1), d, 0);
    else if (d < -EPS) bump(dayKey(t1), 0, -d);
  }
  return out;
}

/**
 * 通用分桶序列：把「now 往前 spanMs」切成等宽的桶，每桶统计落在桶内的消费。
 *
 * 余额是唯一的实时信号源——平台账单接口最细只到天，所以「最近 5 分钟/1 小时
 * 花了多少」这类读数只能由余额差值回答，分辨率受限于轮询频率（默认 2 分钟）。
 * 桶边界按绝对时间对齐（epoch 取模），绕开时区与夏令时换算。
 *
 * @param {number} spanMs   覆盖的时间跨度
 * @param {number} bucketMs 每根柱子的宽度
 * @returns [{ ts, spend, partial }]，最后一项是正在进行中的当前桶
 */
function bucketSeries(samples, now, spanMs, bucketMs) {
  const size = Math.max(60000, Math.floor(Number(bucketMs)) || 60000);   // 最小 1 分钟
  const n = Math.max(1, Math.min(240, Math.round((Number(spanMs) || size) / size)));
  const list = Array.isArray(samples) ? samples : [];
  const bucketOf = (ts) => Math.floor(Number(ts) / size);
  const map = new Map();
  for (let i = 1; i < list.length; i++) {
    const [t0, b0] = list[i - 1], [t1, b1] = list[i];
    if (!(t0 <= t1)) continue;
    const d = b0 - b1;
    if (d > EPS) {
      const k = bucketOf(t1);   // 消费归到「后一个样本」所在的桶
      map.set(k, (map.get(k) || 0) + d);
    }
  }
  const cur = bucketOf(now);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = cur - i;
    out.push({ ts: k * size, spend: map.get(k) || 0, partial: i === 0 });
  }
  return out;
}

/** 近 N 小时的**按小时**序列（如 hours=24 → 24 根柱子） */
const hourlySeries = (samples, now, hours) =>
  bucketSeries(samples, now, (Math.max(1, Math.min(72, Math.floor(Number(hours)) || 24))) * 3600e3, 3600e3);

/** 近 N 分钟的**按 bucketMin 分钟**序列（如 60 分钟 / 5 分钟 → 12 根柱子） */
const minuteSeries = (samples, now, minutes, bucketMin) =>
  bucketSeries(samples, now, (Number(minutes) || 60) * 60000, (Number(bucketMin) || 5) * 60000);

/** 某个时刻之后累计发生的消费（滚动窗口，用于「最近 1 小时」这类读数） */
function spentSince(samples, sinceTs) {
  const list = Array.isArray(samples) ? samples : [];
  let sum = 0;
  for (let i = 1; i < list.length; i++) {
    const [t0, b0] = list[i - 1], [t1, b1] = list[i];
    if (!(t0 <= t1)) continue;
    const d = b0 - b1;
    if (d > EPS && t1 >= sinceTs) sum += d;
  }
  return sum;
}

/**
 * 滚动区间口径（本地差值法与平台账单法共用）：
 * 近 N 天含今天，故偏移从 0 到 N-1；日期键由调用方给定（本地 or UTC）。
 */
function rolling(costOn, keyOf, now, opts) {
  const o = opts || {};
  const dayAt = (offset) => keyOf(Number(now) - offset * 86400e3);
  const sumBack = (n) => { let s = 0; for (let i = 0; i < n; i++) s += costOn(dayAt(i)); return s; };
  const last7 = sumBack(7);
  const avg7 = last7 / 7;
  const balance = o.balance != null && Number.isFinite(Number(o.balance)) ? Number(o.balance) : null;
  const n = Number(o.days) > 0 ? Math.min(60, Math.floor(o.days)) : 30;
  const series = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = dayAt(i);
    series.push({ date, spend: costOn(date) });
  }
  return {
    today: costOn(dayAt(0)),
    last7,
    last30: sumBack(30),
    avg7,
    // 预估可用天数：按近 7 天日均线性外推；日均过小（<1 分）视为「几乎不消耗」
    daysLeft: balance != null && avg7 > 0.01 ? Math.floor(balance / avg7) : null,
    series,
    days: n,
  };
}

/**
 * 汇总口径，供面板直接消费（本地差值法）。
 * @param {Array} samples  [[ts, 余额], …]
 * @param {number} now     当前时间戳
 * @param {object} opts    { balance 当前余额, days 序列长度（默认 30） }
 */
function summarize(samples, now, opts) {
  const o = opts || {};
  const list = Array.isArray(samples) ? samples : [];
  const map = byDayMap(list);
  const monthPrefix = dayKey(now).slice(0, 7);
  let month = 0, topUpMonth = 0;
  for (const [date, v] of map) {
    if (date.startsWith(monthPrefix)) { month += v.spend; topUpMonth += v.topUp; }
  }
  return {
    source: 'local',
    ...rolling((date) => (map.get(date) || { spend: 0 }).spend, dayKey, now, o),
    month,
    topUpMonth,
    // 实时读数一律来自余额差值：平台账单最细只到天
    hourly: hourlySeries(list, now, 24),      // 24 根 × 1 小时
    fine: minuteSeries(list, now, 60, 5),     // 12 根 × 5 分钟
    last5m: spentSince(list, Number(now) - 5 * 60000),
    last1h: spentSince(list, Number(now) - 3600e3),
    firstSampleAt: list.length ? list[0][0] : null,
    since: list.length ? dayKey(list[0][0]) : null,
    samples: list.length,
  };
}

/**
 * 平台账单口径（权威数据，优先于本地差值）。
 * @param {Array} months  按「当前月在前」排列的 fetchMonthlyCost().data，跨月时带上月以补全近 30 天
 * @param {number} now
 * @param {object} opts   { days 柱状图长度, balance 当前余额 }
 */
function summarizePlatform(months, now, opts) {
  const o = opts || {};
  const list = (Array.isArray(months) ? months : []).filter((m) => m && Array.isArray(m.byDay));
  const cur = list[0] || null;
  const map = new Map();
  for (const m of list) for (const d of m.byDay) map.set(d.date, (map.get(d.date) || 0) + d.cost);
  const monthPrefix = utcDayKey(now).slice(0, 7);
  let month = 0;
  for (const [date, v] of map) if (date.startsWith(monthPrefix)) month += v;
  const dates = [...map.keys()].sort();
  // 平台给的是已结算的日粒度数字；实时读数仍由本地余额样本兜底（o.samples）
  const samples = Array.isArray(o.samples) ? o.samples : [];
  return {
    source: 'platform',
    ...rolling((date) => map.get(date) || 0, utcDayKey, now, o),
    month,
    topUpMonth: 0,
    hourly: hourlySeries(samples, now, 24),      // 24 根 × 1 小时
    fine: minuteSeries(samples, now, 60, 5),     // 12 根 × 5 分钟
    last5m: spentSince(samples, Number(now) - 5 * 60000),
    last1h: spentSince(samples, Number(now) - 3600e3),
    firstSampleAt: samples.length ? samples[0][0] : null,
    currency: (cur && cur.currency) || 'CNY',
    monthLabel: cur ? cur.month : monthPrefix,
    byModel: (cur && cur.byModel) || [],
    since: dates.length ? dates[0] : null,
    samples: map.size,
  };
}

module.exports = {
  appendSample, byDayMap, summarize, summarizePlatform, rolling,
  hourlySeries, minuteSeries, bucketSeries, spentSince, thin, KEEP_DAYS, MAX_SAMPLES,
};
