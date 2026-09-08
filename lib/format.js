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

/** 单额度档位：≥90% high，≥80% mid */
function tierOf(p) {
  return p >= 90 ? 'high' : p >= 80 ? 'mid' : 'low';
}

/** 组合档位：任一额度 high 即 high，否则任一 mid 即 mid（各额度阈值相同） */
function tierOfPair(fiveP, weekP) {
  const a = tierOf(fiveP), b = tierOf(weekP);
  if (a === 'high' || b === 'high') return 'high';
  if (a === 'mid' || b === 'mid') return 'mid';
  return 'low';
}

function levelName(l) {
  const map = { lite: 'Lite', pro: 'Pro', max: 'Max', ultra: 'Ultra' };
  const k = String(l || '').toLowerCase();
  return map[k] || String(l || '').toUpperCase();
}

(function (factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  if (typeof window !== 'undefined') window.GLMFMT = factory();
})(function () {
  return { fmtPoints, fmtResetTime, fmtCountdown, tierOf, tierOfPair, levelName };
});
