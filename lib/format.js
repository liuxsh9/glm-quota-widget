'use strict';
/**
 * 展示格式化（主进程托盘提示与渲染层共用同一份逻辑）
 * 浏览器侧通过 <script> 引入；Node 侧 require。
 */
function fmtPoints(n) {
  n = Number(n) || 0;
  if (n >= 10000) {
    const w = n / 10000;
    return (Math.round(w * 10) / 10).toFixed(1).replace(/\.0$/, '') + '万';
  }
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtResetTime(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime()) || Number(ms) <= 0) return '--';
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? hm : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
}

function fmtCountdown(msLeft) {
  const s = Math.floor(Number(msLeft) / 1000);
  if (!Number.isFinite(s)) return '--';
  if (s <= 0) return '即将重置';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return d + '天' + h + '小时';
  if (h >= 1) return h + '小时' + m + '分';
  return Math.max(1, m) + '分钟';
}

/** 提醒阈值默认值；用户可在设置页改成 1–99 的任意整数 */
const WARN_DEFAULT = 80;

/** 阈值归一化：取整到 1–99，非法值（空串/越界/NaN）回退默认 80 */
function normWarn(w) {
  const n = Math.round(Number(w));
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : WARN_DEFAULT;
}

/** 单额度档位：≥ 阈值 mid，≥ 阈值+10（封顶 100）high */
function tierOf(p, warnAt) {
  const w = normWarn(warnAt);
  return p >= Math.min(100, w + 10) ? 'high' : p >= w ? 'mid' : 'low';
}

/** 组合档位：任一额度 high 即 high，否则任一 mid 即 mid（各额度共用同一阈值） */
function tierOfPair(fiveP, weekP, warnAt) {
  const a = tierOf(fiveP, warnAt), b = tierOf(weekP, warnAt);
  if (a === 'high' || b === 'high') return 'high';
  if (a === 'mid' || b === 'mid') return 'mid';
  return 'low';
}

/* ---------------- DeepSeek 数值展示 ---------------- */

/** 金额：默认两位小数、千分位（不带货币符号，符号由界面自己拼） */
function fmtMoney(n, digits) {
  // null/'' 都按「无数据」处理：Number(null)===0 会被误显示成 ¥0.00
  const v = n === null || n === undefined || n === '' ? NaN : Number(n);
  if (!Number.isFinite(v)) return '--';
  const d = digits == null ? 2 : digits;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 带符号金额：正数补 +，用于「今日消费」这类增量 */
function fmtMoneyDelta(n, digits) {
  const v = n === null || n === undefined || n === '' ? NaN : Number(n);
  if (!Number.isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + fmtMoney(v, digits);
}

/** token 数：1,234 / 12.3万 / 1.23亿 */
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (Math.round((v / 1e8) * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + '亿';
  if (v >= 1e4) return (Math.round((v / 1e4) * 10) / 10).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 本地日期键 YYYY-MM-DD（按本机时区，与 DS 差值历史同口径） */
function dayKey(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------------- 峰谷时段（两家都以**北京时间**为准，与机器时区无关） ----------------
   DeepSeek 官方文档：高峰 = 周一至周五 09:00–12:00、14:00–18:00，其余（含周末全天）空闲，
                    空闲价 = 高峰价的一半。
   GLM Coding Plan 官方文档：高峰 = 周一至周五 14:00–18:00，周末全天按非高峰计；
                    非高峰的折扣按**模型系数**算（GLM-5.3 为「非高峰 1 倍 / 高峰 3 倍」，
                    GLM-5.3-Flash 为「0.4 / 1.2 倍」），所以界面上只报时段、不写具体折扣。 */
const PEAK_WINDOWS = {
  ds: [[9, 12], [14, 18]],
  glm: [[14, 18]],
};

/** 北京时间（UTC+8）的星期与「当天第几分钟」——不用本机时区，避免跨时区判断错 */
function beijingClock(ts) {
  const d = new Date(Number(ts) + 8 * 3600e3);
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** 当前是否处于该 provider 的高峰时段（周末恒为非高峰） */
function isPeak(provider, ts) {
  const { day, minutes } = beijingClock(ts == null ? Date.now() : ts);
  if (day === 0 || day === 6) return false;
  return (PEAK_WINDOWS[provider] || []).some(([a, b]) => minutes >= a * 60 && minutes < b * 60);
}

/** 时段说明文案（给 title 用） */
const PERIOD_NOTE = {
  ds: '高峰：周一至周五 09:00–12:00、14:00–18:00（北京时间）· 空闲时段价格为高峰的一半',
  glm: '高峰：周一至周五 14:00–18:00（北京时间）· 非高峰按更低的积分系数抵扣，模型不同倍率不同',
};

/** UTC 日期键：DeepSeek 平台账单按 UTC 日界切天，查表要用同一口径 */
function utcDayKey(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function levelName(l) {
  // GLM 用 lite/pro/max/ultra；火山方舟的 Agent Plan 用 small/medium/large/max
  const map = {
    lite: 'Lite', pro: 'Pro', max: 'Max', ultra: 'Ultra',
    small: 'Small', medium: 'Medium', large: 'Large',
  };
  const k = String(l || '').toLowerCase();
  return map[k] || String(l || '').toUpperCase();
}

(function (factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  if (typeof window !== 'undefined') window.GLMFMT = factory();
})(function () {
  return {
    fmtPoints, fmtResetTime, fmtCountdown, tierOf, tierOfPair, levelName,
    WARN_DEFAULT, normWarn, fmtMoney, fmtMoneyDelta, fmtTokens, dayKey, utcDayKey,
    isPeak, beijingClock, PEAK_WINDOWS, PERIOD_NOTE,
  };
});
