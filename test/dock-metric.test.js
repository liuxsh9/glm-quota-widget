'use strict';
/* 贴边圆圈口径与配色测试（纯函数，无 Electron 依赖）。
   跑法：node test/dock-metric.test.js    —— 全过退出码 0，有失败退出码 1

   重点不是「某个数字对上」，而是三条不许退化的性质：
     · 口径认不出时安静回默认，不抛异常（配置可能是旧的、脏的）
     · DeepSeek 超预算时，数字（raw）讲真话、弧长（pct）只画满
     · 颜色连续无跳档，且中段不发灰 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const M = require('../lib/dock-metric');

let pass = 0, fails = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fails++; console.log('  ✗', name, '\n     ', e.message); process.exitCode = 1; }
}

/** 'rgb(r, g, b)' → [r, g, b]；格式不对返回 null */
function parseRgb(s) {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(String(s));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** 与色标的允许误差：取整 ±1 */
const near = (got, want, tol = 1) => got.every((v, i) => Math.abs(v - want[i]) <= tol);
/** 饱和度（RGB 最大最小分量差）——灰 = 小，鲜艳 = 大 */
const sat = (c) => Math.max(...c) - Math.min(...c);
/** 浮点比较（percentOf 的 raw 是除法算出来的，别拿真实等号去卡二进制小数） */
const close = (got, want, eps = 1e-9) => Math.abs(got - want) <= eps;

/* ---------------- METRICS ---------------- */
console.log('METRICS:');
ok('三家都有列表，每项形如 { key, label, short }', () => {
  assert.deepStrictEqual(Object.keys(M.METRICS).sort(), ['deepseek', 'glm', 'volc']);
  for (const [id, list] of Object.entries(M.METRICS)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${id} 列表为空`);
    for (const m of list) {
      assert.ok(m.key && m.label && m.short, `${id} 的 ${JSON.stringify(m)} 缺字段`);
    }
    const keys = list.map((m) => m.key);
    assert.strictEqual(new Set(keys).size, keys.length, `${id} 有重复 key`);
  }
});
ok('口径集合与设计一致（GLM 5h/周/双环、火山多一个月、DS 今日/近7天/本月）', () => {
  assert.deepStrictEqual(M.METRICS.glm.map((m) => m.key), ['five', 'week', 'both']);
  assert.deepStrictEqual(M.METRICS.glm[2].dual, ['five', 'week']);
  assert.deepStrictEqual(M.METRICS.volc.map((m) => m.key), ['five', 'week', 'month']);
  assert.deepStrictEqual(M.METRICS.deepseek.map((m) => m.key), ['today', 'last7', 'month']);
  assert.strictEqual(M.METRICS.glm[0].key, 'five');
  assert.strictEqual(M.METRICS.volc[0].key, 'five');
  assert.strictEqual(M.METRICS.deepseek[0].key, 'today');
});

/* ---------------- normalize ---------------- */
console.log('\nnormalize:');
ok('GLM：合法口径原样保留', () => {
  assert.deepStrictEqual(M.normalize('glm', { metric: 'week' }), { metric: 'week', budget: null, show: null });
});
ok('GLM：非法 / 缺失口径回默认 five', () => {
  assert.strictEqual(M.normalize('glm', { metric: 'month' }).metric, 'five');   // DS 的口径，GLM 没有
  assert.strictEqual(M.normalize('glm', {}).metric, 'five');
  assert.strictEqual(M.normalize('glm', { metric: 5 }).metric, 'five');
  assert.strictEqual(M.normalize('glm', { metric: 'FIVE' }).metric, 'five');
});
ok('GLM：带 budget 也恒为 null', () => {
  assert.strictEqual(M.normalize('glm', { metric: 'five', budget: 50 }).budget, null);
  assert.strictEqual(M.normalize('glm', { metric: 'week', budget: '50' }).budget, null);
});
ok('火山：三项都认，非法回 five，budget 恒为 null', () => {
  assert.strictEqual(M.normalize('volc', { metric: 'month' }).metric, 'month');
  assert.strictEqual(M.normalize('volc', { metric: 'today' }).metric, 'five');
  assert.strictEqual(M.normalize('volc', { metric: 'month', budget: 30 }).budget, null);
});
ok('DeepSeek：budget "50" → 50（数值），非法口径回 today', () => {
  assert.deepStrictEqual(M.normalize('deepseek', { metric: 'month', budget: '50' }), { metric: 'month', budget: 50, show: 'pct' });
  assert.deepStrictEqual(M.normalize('deepseek', { metric: 'last7', budget: 12.5 }), { metric: 'last7', budget: 12.5, show: 'pct' });
  assert.strictEqual(M.normalize('deepseek', { metric: 'five' }).metric, 'today');
});
ok('DeepSeek：0 / -1 / "abc" / Infinity → budget null', () => {
  assert.strictEqual(M.normalize('deepseek', { budget: 0 }).budget, null);
  assert.strictEqual(M.normalize('deepseek', { budget: -1 }).budget, null);
  assert.strictEqual(M.normalize('deepseek', { budget: 'abc' }).budget, null);
  assert.strictEqual(M.normalize('deepseek', { budget: Infinity }).budget, null);
  assert.strictEqual(M.normalize('deepseek', { budget: '' }).budget, null);
  assert.strictEqual(M.normalize('deepseek', { budget: NaN }).budget, null);
});
ok('未知 provider → 全 null', () => {
  assert.deepStrictEqual(M.normalize('nope', { metric: 'five', budget: 50 }), { metric: null, budget: null, show: null });
  assert.deepStrictEqual(M.normalize(undefined, {}), { metric: null, budget: null, show: null });
  // 原型链上的键不能被当成 provider（否则 METRICS['toString'] 会炸）
  assert.deepStrictEqual(M.normalize('toString', {}), { metric: null, budget: null, show: null });
});
ok('raw 是 undefined / 字符串 / 数字 / null 时不抛异常，回默认', () => {
  for (const raw of [undefined, null, 'week', 42, true, [], () => {}]) {
    assert.deepStrictEqual(M.normalize('glm', raw), { metric: 'five', budget: null, show: null });
    assert.deepStrictEqual(M.normalize('deepseek', raw), { metric: 'today', budget: null, show: 'pct' });
  }
});

/* ---------------- percentOf ---------------- */
console.log('\npercentOf:');
const GLM_DATA = {
  level: 'max',
  five: { percent: 41, used: 11480, total: 28000, nextResetTime: 1 },
  week: { percent: 23, used: 32200, total: 140000, nextResetTime: 2 },
};
const VOLC_DATA = {
  plan: 'coding',
  five: { known: true, percent: 62, nextResetTime: 1 },
  week: { known: true, percent: 18, nextResetTime: 2 },
  month: { known: true, percent: 7, nextResetTime: 3 },
};

ok('GLM：five / week 正常取值，带出 label 与 short', () => {
  const a = M.percentOf('glm', GLM_DATA, { metric: 'five' });
  assert.deepStrictEqual(a, { pct: 41, raw: 41, label: '5 小时额度', short: '5h' });
  const b = M.percentOf('glm', GLM_DATA, { metric: 'week' });
  assert.strictEqual(b.raw, 23);
  assert.strictEqual(b.label, '周额度');
});
ok('GLM：缺 week 窗口 → null（不是 0）', () => {
  assert.strictEqual(M.percentOf('glm', { five: { percent: 41 } }, { metric: 'week' }), null);
  assert.strictEqual(M.percentOf('glm', { five: { percent: null }, week: { percent: 23 } }, { metric: 'five' }), null);
  assert.strictEqual(M.percentOf('glm', {}, { metric: 'week' }), null);
});
ok('GLM / 火山：budget 不参与计算（只有 DeepSeek 认）', () => {
  assert.strictEqual(M.percentOf('glm', GLM_DATA, { metric: 'week', budget: 5 }).raw, 23);
  assert.strictEqual(M.percentOf('volc', VOLC_DATA, { metric: 'week', budget: 5 }).raw, 18);
});
ok('火山：five / week / month 都取得到', () => {
  assert.strictEqual(M.percentOf('volc', VOLC_DATA, { metric: 'five' }).raw, 62);
  assert.strictEqual(M.percentOf('volc', VOLC_DATA, { metric: 'week' }).raw, 18);
  const m = M.percentOf('volc', VOLC_DATA, { metric: 'month' });
  assert.deepStrictEqual(m, { pct: 7, raw: 7, label: '月额度', short: '月' });
});
ok('火山：known:false（该套餐没返回这一档）→ null', () => {
  const data = { ...VOLC_DATA, month: { known: false, percent: 0 } };
  assert.strictEqual(M.percentOf('volc', data, { metric: 'month' }), null);
  assert.strictEqual(M.percentOf('volc', { five: { known: true, percent: 62 } }, { metric: 'week' }), null);
});
const DS_DATA = {
  balance: { currency: 'CNY', total: 87.5, granted: 0 },
  summary: { today: 3.2, last7: 21.4, month: 96.8 },
};
ok('DeepSeek：summary ÷ budget × 100，币种不参与运算', () => {
  assert.deepStrictEqual(M.percentOf('deepseek', DS_DATA, { metric: 'today', budget: 10 }),
    { pct: 32, raw: 32, label: '今日', short: '今日' });
  assert.ok(close(M.percentOf('deepseek', DS_DATA, { metric: 'last7', budget: 200 }).raw, 10.7),
    String(M.percentOf('deepseek', DS_DATA, { metric: 'last7', budget: 200 }).raw));
});
ok('DeepSeek：没填 budget → null（灰环）', () => {
  assert.strictEqual(M.percentOf('deepseek', DS_DATA, { metric: 'today' }), null);
  assert.strictEqual(M.percentOf('deepseek', DS_DATA, { metric: 'today', budget: 0 }), null);
  assert.strictEqual(M.percentOf('deepseek', DS_DATA, { metric: 'today', budget: 'abc' }), null);
});
ok('DeepSeek：没有 summary / 值不是有限数 → null', () => {
  assert.strictEqual(M.percentOf('deepseek', { balance: DS_DATA.balance }, { metric: 'today', budget: 10 }), null);
  assert.strictEqual(M.percentOf('deepseek', { summary: null }, { metric: 'today', budget: 10 }), null);
  assert.strictEqual(M.percentOf('deepseek', { summary: { today: null } }, { metric: 'today', budget: 10 }), null);
  assert.strictEqual(M.percentOf('deepseek', { summary: { today: 'abc' } }, { metric: 'today', budget: 10 }), null);
});
ok('DeepSeek 超预算：raw 是真实值 150，pct 只画满 100', () => {
  const r = M.percentOf('deepseek', { summary: { today: 15 } }, { metric: 'today', budget: 10 });
  assert.strictEqual(r.raw, 150, '界面上的数字必须讲真话');
  assert.strictEqual(r.pct, 100, '弧长夹到 100');
});
ok('数据整体缺失 / 认不出的 provider → null，不抛异常', () => {
  assert.strictEqual(M.percentOf('glm', undefined, { metric: 'five' }), null);
  assert.strictEqual(M.percentOf('glm', null, { metric: 'five' }), null);
  assert.strictEqual(M.percentOf('glm', 'boom', { metric: 'five' }), null);
  assert.strictEqual(M.percentOf('nope', GLM_DATA, { metric: 'five' }), null);
});
ok('setting 缺失 / 脏（undefined / 字符串 / 非法口径）→ 按该家默认口径算', () => {
  assert.strictEqual(M.percentOf('glm', GLM_DATA, undefined).raw, 41);          // 默认 five
  assert.strictEqual(M.percentOf('glm', GLM_DATA, 'week').raw, 41);            // 字符串不当口径用
  assert.strictEqual(M.percentOf('glm', GLM_DATA, { metric: 'month' }).raw, 41); // GLM 没有 month → five
  assert.ok(close(M.percentOf('deepseek', DS_DATA, { metric: 'month', budget: 100 }).raw, 96.8));
});

ok('DeepSeek show：认 pct / cost，非法回 pct；GLM / 火山恒为 null', () => {
  assert.strictEqual(M.normalize('deepseek', { show: 'cost' }).show, 'cost');
  assert.strictEqual(M.normalize('deepseek', { show: 'COST' }).show, 'pct');
  assert.strictEqual(M.normalize('deepseek', {}).show, 'pct');
  assert.strictEqual(M.normalize('glm', { show: 'cost' }).show, null);
  assert.strictEqual(M.normalize('volc', { show: 'cost' }).show, null);
});
ok('GLM 双环：外环 = 5h、内环 = 周；周缺失时 inner 为 null', () => {
  const p = M.percentOf('glm', GLM_DATA, { metric: 'both' });
  assert.strictEqual(p.raw, 41);
  assert.deepStrictEqual(p.inner, { pct: 23, raw: 23 });
  assert.strictEqual(M.percentOf('glm', { five: { percent: 41 } }, { metric: 'both' }).inner, null);
  assert.strictEqual(M.percentOf('glm', GLM_DATA, { metric: 'five' }).inner, undefined);   // 单环口径不带 inner
});

/* ---------------- cellOf ---------------- */
console.log('\ncellOf:');
ok('百分比口径：text = 未夹的 raw 取整 + %；取不到 → –、pct null', () => {
  assert.strictEqual(M.cellOf('glm', GLM_DATA, { metric: 'five' }).text, '41%');
  assert.strictEqual(M.cellOf('deepseek', { summary: { today: 15 } }, { metric: 'today', budget: 10 }).text, '150%');
  const none = M.cellOf('deepseek', DS_DATA, { metric: 'today' });
  assert.strictEqual(none.text, '–'); assert.strictEqual(none.pct, null);
});
ok('GLM 双环：cellOf 带 inner，数字跟外环', () => {
  const c = M.cellOf('glm', GLM_DATA, { metric: 'both' });
  assert.strictEqual(c.text, '41%'); assert.strictEqual(c.inner.pct, 23);
});
ok('DeepSeek 金额：不需要预算；有预算时弧仍按占比画', () => {
  const d = { summary: { today: 3.214, last7: 12.34, month: 456.7 }, balance: { currency: 'CNY' } };
  const a = M.cellOf('deepseek', d, { metric: 'today', show: 'cost' });
  assert.strictEqual(a.text, '¥3.21'); assert.strictEqual(a.pct, null);
  const b = M.cellOf('deepseek', d, { metric: 'today', show: 'cost', budget: 10 });
  assert.strictEqual(b.text, '¥3.21'); assert.ok(close(b.pct, 32.14));
  assert.strictEqual(M.cellOf('deepseek', d, { metric: 'last7', show: 'cost' }).text, '¥12.3');
  assert.strictEqual(M.cellOf('deepseek', d, { metric: 'month', show: 'cost' }).text, '¥457');
  assert.strictEqual(M.cellOf('deepseek', { summary: { today: 1234 } }, { metric: 'today', show: 'cost' }).text, '¥1.2k');
  assert.strictEqual(M.cellOf('deepseek', { summary: { today: 0 } }, { metric: 'today', show: 'cost' }).text, '¥0.00');
  assert.strictEqual(M.cellOf('deepseek', { summary: { today: 2 }, balance: { currency: 'USD' } }, { metric: 'today', show: 'cost' }).text, '$2.00');
});
ok('DeepSeek 金额：没有 summary / 值脏 → –', () => {
  for (const d of [undefined, null, {}, { summary: null }, { summary: { today: null } }, { summary: { today: 'abc' } }]) {
    assert.strictEqual(M.cellOf('deepseek', d, { show: 'cost' }).text, '–');
  }
});

/* ---------------- ringColor ---------------- */
console.log('\nringColor:');
ok('输出格式恒为 rgb(r, g, b)，分量是 0–255 整数', () => {
  for (const p of [-5, 0, 1, 33.3, 50, 74.9, 90, 100, 1000]) {
    const c = parseRgb(M.ringColor(p));
    assert.ok(c, `${p} → ${M.ringColor(p)} 不是合法 rgb(...)`);
    assert.ok(c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), `${p} 分量越界`);
  }
});
ok('0% = 青绿 #2dd4bf，90% = 红 #ef4444（±1 取整误差）', () => {
  assert.ok(near(parseRgb(M.ringColor(0)), [0x2d, 0xd4, 0xbf]), M.ringColor(0));
  assert.ok(near(parseRgb(M.ringColor(90)), [0xef, 0x44, 0x44]), M.ringColor(90));
});
ok('50% / 75% 也落在色标上', () => {
  assert.ok(near(parseRgb(M.ringColor(50)), [0xa3, 0xe6, 0x35]), M.ringColor(50));
  assert.ok(near(parseRgb(M.ringColor(75)), [0xf5, 0x9e, 0x0b]), M.ringColor(75));
});
ok('100 与 90 同色（90–100 保持红）', () => {
  assert.strictEqual(M.ringColor(100), M.ringColor(90));
  assert.strictEqual(M.ringColor(95), M.ringColor(90));
});
ok('越界输入：-5 等于 0；>100 等于 100', () => {
  assert.strictEqual(M.ringColor(-5), M.ringColor(0));
  assert.strictEqual(M.ringColor(1000), M.ringColor(100));
});
ok('null / undefined / NaN / 空串 → null（渲染层画灰环）', () => {
  for (const v of [null, undefined, NaN, '', '  ', 'abc', Infinity, -Infinity, {}]) {
    assert.strictEqual(M.ringColor(v), null, `${String(v)} 应为 null`);
  }
});
ok('连续性：0–90 每 1% 采样，相邻颜色每个分量差 ≤ 12（无跳档）', () => {
  let prev = parseRgb(M.ringColor(0));
  let worst = 0, worstAt = null;
  for (let p = 1; p <= 90; p++) {
    const cur = parseRgb(M.ringColor(p));
    const d = Math.max(...[0, 1, 2].map((k) => Math.abs(cur[k] - prev[k])));
    if (d > worst) { worst = d; worstAt = p; }
    assert.ok(d <= 12, `第 ${p}% 与 ${p - 1}% 的分量差 ${d} > 12（跳档）`);
    prev = cur;
  }
  console.log(`     最大相邻步进 ${worst}/通道（在 ${worstAt}%）`);
});
ok('中段不发灰：50% 饱和度 ≥ 80，且 20–80% 全程 ≥ 80', () => {
  const c50 = parseRgb(M.ringColor(50));
  assert.ok(sat(c50) >= 80, `50% 饱和度只有 ${sat(c50)}：${M.ringColor(50)}`);
  let min = Infinity, minAt = null;
  for (let p = 20; p <= 80; p++) {
    const s = sat(parseRgb(M.ringColor(p)));
    if (s < min) { min = s; minAt = p; }
  }
  assert.ok(min >= 80, `${minAt}% 饱和度只有 ${min}`);
  console.log(`     50% 饱和度 ${sat(c50)}，20–80% 最低 ${min}（在 ${minAt}%）`);
});

/* ---------------- 双端加载（UMD） ---------------- */
console.log('\n双端加载:');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dock-metric.js'), 'utf8');
ok('渲染层 <script> 方式：挂到 window.GLMDOCK', () => {
  const win = {};
  vm.runInNewContext(SRC, { window: win });
  assert.ok(win.GLMDOCK, 'window.GLMDOCK 没挂上');
  assert.strictEqual(typeof win.GLMDOCK.ringColor, 'function');
  assert.strictEqual(win.GLMDOCK.ringColor(0), 'rgb(45, 212, 191)');
  assert.strictEqual(win.GLMDOCK.percentOf('glm', GLM_DATA, { metric: 'five' }).raw, 41);
});

console.log(`\n${fails ? '有失败：' : '全部通过（'}${fails ? `${fails} 项失败，` : ''}${pass} 项）\n`);
process.exit(fails ? 1 : 0);
