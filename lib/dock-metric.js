'use strict';
/**
 * 贴边模式（dock）圆圈的「百分比口径」与「圆环配色」（纯函数，主进程与渲染层共用同一份逻辑）
 * 浏览器侧通过 <script> 引入，挂在 window.GLMDOCK；Node 侧 require。
 *
 * 只管两件事，不碰界面：
 *   ① 每个账户的圆圈显示什么百分比：口径（metric）可配；DeepSeek 还要一个预算当 100%
 *   ② 百分比 → 圆环颜色：连续渐变，没有档位跳变
 */

/* ==================== 百分比口径 ==================== */

/**
 * 每家可选的圆圈口径。**每家的第一项即默认**——老配置 / 非法值都回落到它。
 * label 是完整说明，short 是圆圈旁 / 下拉里的紧凑写法。
 *
 * 100% 是什么：
 *   glm / volc —— 接口给的 percent（窗口缺失就没数，见 percentOf）
 *   deepseek   —— 用户填的 budget（与余额同币种）；summary.today / last7 / month ÷ budget
 */
const METRICS = {
  glm: [
    { key: 'five', label: '5 小时额度', short: '5h' },
    { key: 'week', label: '周额度', short: '周' },
  ],
  volc: [
    { key: 'five', label: '5 小时额度', short: '5h' },
    { key: 'week', label: '周额度', short: '周' },
    { key: 'month', label: '月额度', short: '月' },
  ],
  deepseek: [
    { key: 'today', label: '今日', short: '今日' },
    { key: 'last7', label: '近 7 天', short: '7天' },
    { key: 'month', label: '本月', short: '本月' },
  ],
};

/** 某个 provider 支持的口径列表；未知 provider → null（不用 METRICS[provider]，免得撞上原型链上的键） */
function metricsOf(provider) {
  return Object.prototype.hasOwnProperty.call(METRICS, provider) ? METRICS[provider] : null;
}

/** 口径定义；provider / metric 任一认不出 → null */
function itemOf(provider, metric) {
  const list = metricsOf(provider);
  if (!list) return null;
  for (const m of list) if (m.key === metric) return m;
  return null;
}

/** 转数字：null / undefined / 空串 / 非数字 → null。0 是合法值，不能被子真值判断吃掉 */
function numOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;   // 布尔 / 对象 / 函数一律不认，避免 true → 1 这种荒唐预算
}

/** 预算：只认正数（0 / 负数 / Infinity / 认不出的字符串 → null，即「没填」） */
function normBudget(v) {
  const n = numOrNull(v);
  return n != null && n > 0 ? n : null;
}

/**
 * 把一份（可能很脏的）账户 dock 配置规范化。
 * @param {string} provider 'glm' | 'volc' | 'deepseek'
 * @param {*} raw 旧配置：可能是 undefined / 字符串 / 缺字段的对象
 * @returns {{metric:string|null, budget:number|null}} 未知 provider → 两个都是 null
 */
function normalize(provider, raw) {
  const list = metricsOf(provider);
  if (!list) return { metric: null, budget: null };
  const src = raw && typeof raw === 'object' ? raw : {};
  const metric = itemOf(provider, src.metric) ? src.metric : list[0].key;
  // budget 只对 DeepSeek 有意义；其余家恒为 null（免得旧配置里混进来的数字被当成预算）
  const budget = provider === 'deepseek' ? normBudget(src.budget) : null;
  return { metric, budget };
}

/** GLM / 火山：窗口里的 percent。窗口缺失、火山标了 known:false、认不出的值 → null */
function windowPercent(data, metric) {
  const w = data[metric];
  if (!w || typeof w !== 'object' || w.known === false) return null;
  if (w.percent == null) return null;   // 不能直接 Number()：Number(null)===0 会把「没数据」画成 0%
  const p = Number(w.percent);
  return Number.isFinite(p) ? p : null;
}

/** DeepSeek：summary[metric] ÷ budget × 100；没填预算 / 没有 summary / 值不是有限数 → null */
function dsPercent(data, setting) {
  if (!setting.budget) return null;
  const sum = data.summary;
  if (!sum || typeof sum !== 'object') return null;
  const raw = sum[setting.metric];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? (n / setting.budget) * 100 : null;
}

/**
 * 圆圈该显示多少。
 * @param {string} provider
 * @param {object} data 该账户的 state 数据（形状见各家 provider；可能缺失 / 脏）
 * @param {object} [setting] 该账户的 dock 配置 { metric, budget }；内部先 normalize，认不出的回默认
 * @returns {{pct:number, raw:number, label:string, short:string}|null}
 *   pct —— **夹进 0–100** 的比例，只用来画弧长
 *   raw —— **未夹**的真实比例 ×100（DeepSeek 超预算时 >100），界面上的数字用它讲真话
 *   取不到（窗口缺失 / 没填预算 / 数据脏 / 未知 provider）→ null，渲染层画灰环
 */
function percentOf(provider, data, setting) {
  const s = normalize(provider, setting);
  const item = s.metric ? itemOf(provider, s.metric) : null;
  if (!item || !data || typeof data !== 'object') return null;
  const raw = provider === 'deepseek' ? dsPercent(data, s) : windowPercent(data, s.metric);
  if (!Number.isFinite(raw)) return null;
  return { pct: Math.max(0, Math.min(100, raw)), raw, label: item.label, short: item.short };
}

/* ==================== 圆环配色 ==================== */

/*
 * 色标之间在 **OKLab** 里插值（Björn Ottosson 的标准矩阵）。
 * 为什么不直接在 sRGB 里插：青→红这条路上，两端的平均值会掉进浑浊的灰褐——
 * 中段看着发灰、像褪了色。OKLab 大致等距于人眼感知，整条渐变都保持鲜艳。
 * 三种情况不必再过 OKLab：色标点本身、≥90（恒红）、null（灰环）。
 */
const STOPS = [
  { at: 0, rgb: [0x2d, 0xd4, 0xbf] },    // 青绿
  { at: 50, rgb: [0xa3, 0xe6, 0x35] },   // 黄绿
  { at: 75, rgb: [0xf5, 0x9e, 0x0b] },   // 琥珀
  { at: 90, rgb: [0xef, 0x44, 0x44] },   // 红（90–100 保持红）
];

/** sRGB 分量（0–255）→ 线性光 */
const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/** 线性光 → sRGB 分量（未夹取整，供出界判断用） */
const linearToSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;

function rgbToOklab(rgb) {
  const r = srgbToLinear(rgb[0]), g = srgbToLinear(rgb[1]), b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** 色标的 OKLab 坐标在模块加载时算一次 */
const LAB_STOPS = STOPS.map((s) => ({ at: s.at, css: cssOf(s.rgb), lab: rgbToOklab(s.rgb) }));

/** 分量取整成 'rgb(r, g, b)' */
function cssOf(rgb) {
  return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
}

/** OKLab → CSS 颜色。OKLab 的直线可能略微越出 sRGB 色域，夹进 0–255 再取整 */
function labToCss(lab) {
  const L = lab[0], A = lab[1], B = lab[2];
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.2914855480 * B;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return cssOf(lin.map((v) => Math.max(0, Math.min(255, linearToSrgb(v)))));
}

/**
 * 百分比 → 圆环颜色（连续渐变，无档位跳变）。
 * @param {number} pct 0–100；<0 按 0、>100 按 100
 * @returns {string|null} 'rgb(r, g, b)'；null / NaN / 认不出的值 → null（渲染层画灰环）
 */
function ringColor(pct) {
  const n = numOrNull(pct);
  if (n == null) return null;
  const p = Math.max(0, Math.min(100, n));
  const last = LAB_STOPS[LAB_STOPS.length - 1];
  if (p >= last.at) return last.css;    // 90–100 同一种红（不做 90→100 的二次插值）
  let i = 0;
  while (i < LAB_STOPS.length - 2 && p > LAB_STOPS[i + 1].at) i++;
  const a = LAB_STOPS[i], b = LAB_STOPS[i + 1];
  const t = (p - a.at) / (b.at - a.at);
  return labToCss([0, 1, 2].map((k) => a.lab[k] + (b.lab[k] - a.lab[k]) * t));
}

(function (factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  if (typeof window !== 'undefined') window.GLMDOCK = factory();
})(function () {
  return { METRICS, normalize, percentOf, ringColor };
});
