'use strict';
/* 贴边吸附几何测试：重点是「接缝不是边缘」——
   跨屏拖胶囊时，接缝若被误判成屏幕外缘，窗口会在半路被吸住，永远拖不过去；
   而真正的外缘在任何屏幕布局下都得能贴上。所以每个用例都断言具体坐标 / displayId，
   不看「返回了东西」。
   跑法：node test/dock.test.js    （无 Electron 依赖，CI 可直接跑）

   坐标全为 DIP；显示器对象形如 Electron 的 Display：
     { id, bounds:{x,y,width,height}, workArea:{x,y,width,height} }
   邻接（接缝）看 bounds，贴靠位置看 workArea —— 本文件里两者刻意取不同的值，
   用来验证模块没有把两件事混在一起。 */
const assert = require('assert');
const dock = require('../lib/dock');

const SIZE = { w: 192, h: 68 };                        // capsule(168×44) + PAD×2，同 drag.test.js

/** 造一块屏：省略 wa 时工作区 = bounds */
function mkDisp(id, x, y, w, h, wa) {
  return { id, bounds: { x, y, width: w, height: h }, workArea: wa || { x, y, width: w, height: h } };
}
/** 窗口矩形（尺寸固定为 SIZE，只给原点） */
function rect(x, y) { return { x, y, width: SIZE.w, height: SIZE.h }; }

/* ============================ 布局 ============================ */
// 单屏：1080 高、底部任务栏 40
const SOLO = mkDisp(1, 0, 0, 1920, 1080, { x: 0, y: 0, width: 1920, height: 1040 });
// 左右并排、同高：左屏 #1 (0..1920)、右屏 #2 (1920..3840)
const L = mkDisp(1, 0, 0, 1920, 1080, { x: 0, y: 0, width: 1920, height: 1040 });
const R = mkDisp(2, 1920, 0, 1920, 1080, { x: 1920, y: 0, width: 1920, height: 1040 });
// 右屏更高、往下多出一截：左屏 0..1080、右屏 0..1440
const LH = mkDisp(1, 0, 0, 1920, 1080, { x: 0, y: 0, width: 1920, height: 1040 });
const RH = mkDisp(2, 1920, 0, 1920, 1440, { x: 1920, y: 0, width: 1920, height: 1440 });
// 副屏在主屏左侧，坐标为负：副屏 #3 (-1280..0)、主屏 #1 (0..1920)
const P = mkDisp(1, 0, 0, 1920, 1080, { x: 0, y: 0, width: 1920, height: 1040 });
const S = mkDisp(3, -1280, 0, 1280, 1024, { x: -1280, y: 0, width: 1280, height: 1024 });
// 任务栏在左侧（80 DIP）：workArea.x > bounds.x
const TB = mkDisp(1, 0, 0, 1920, 1080, { x: 80, y: 0, width: 1840, height: 1040 });
// 缩放不同的两屏（bounds 数值不同即可）：右屏 2560×1440、屏更高
const A = mkDisp(1, 0, 0, 1920, 1080, { x: 0, y: 0, width: 1920, height: 1040 });
const B = mkDisp(2, 1920, 0, 2560, 1440, { x: 1920, y: 0, width: 2560, height: 1400 });

/* ================================ 用例 ================================ */
let pass = 0;
function ok(name, fn) { fn(); console.log('  ✓', name); pass++; }

console.log('\n[单屏] 贴左 / 贴右 / 离边 29 DIP 不贴 / 正好 28 DIP 贴');
ok('左边距 0 → 贴左（SNAP_PX = 28）', () => {
  assert.strictEqual(dock.SNAP_PX, 28);
  assert.deepStrictEqual(dock.snapSide(rect(0, 200), [SOLO]), { side: 'left', displayId: 1 });
});
ok('右边距 0（x = 1920-192 = 1728）→ 贴右', () => {
  assert.deepStrictEqual(dock.snapSide(rect(1728, 200), [SOLO]), { side: 'right', displayId: 1 });
});
ok('距左缘正好 28（x = 28）→ 贴左', () => {
  assert.deepStrictEqual(dock.snapSide(rect(28, 200), [SOLO]), { side: 'left', displayId: 1 });
});
ok('距右缘正好 28（x = 1700，右边缘 1892）→ 贴右', () => {
  assert.deepStrictEqual(dock.snapSide(rect(1700, 200), [SOLO]), { side: 'right', displayId: 1 });
});
ok('距左缘 29（x = 29）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(29, 200), [SOLO]), null);
});
ok('距右缘 29（x = 1699，右边缘 1891）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(1699, 200), [SOLO]), null);
});

console.log('\n[双屏左右并排] 接缝（左屏右边 / 右屏左边）不贴，两个最外侧能贴');
ok('左屏右边缘内侧 20 DIP（x = 1708，右边缘 1900）→ 不贴（接缝不是边缘）', () => {
  assert.strictEqual(dock.snapSide(rect(1708, 200), [L, R]), null);
  // 反例演示：只给一块屏（等于把接缝当成屏幕边缘）时同一位置会被吸住
  console.log('     · 若只看左屏（模拟「接缝被当成外缘」的 bug）：' +
    JSON.stringify(dock.snapSide(rect(1708, 200), [L])) + ' ← 半路吸住，拖不过去');
});
ok('右屏左边缘内侧 20 DIP（x = 1940）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(1940, 200), [L, R]), null);
});
ok('窗口正好跨在接缝上（x = 1824，左右各 96）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(1824, 200), [L, R]), null);
});
ok('左屏最外侧（x = 0）→ 贴左，落左屏', () => {
  assert.deepStrictEqual(dock.snapSide(rect(0, 200), [L, R]), { side: 'left', displayId: 1 });
});
ok('右屏最外侧（x = 3648，右边缘 3840）→ 贴右，落右屏', () => {
  assert.deepStrictEqual(dock.snapSide(rect(3648, 200), [L, R]), { side: 'right', displayId: 2 });
});
ok('接缝判定用 bounds：两屏间 2 DIP 缝隙（缩放不同常见）仍算接缝 → 不贴', () => {
  const R2 = mkDisp(2, 1922, 0, 1920, 1080, { x: 1922, y: 0, width: 1920, height: 1040 });
  assert.strictEqual(dock.snapSide(rect(1708, 200), [L, R2]), null);
});
ok('缝隙 3 DIP 超出 ±2 容差 → 左屏右边算外缘，能贴', () => {
  const R3 = mkDisp(2, 1923, 0, 1920, 1080, { x: 1923, y: 0, width: 1920, height: 1040 });
  assert.deepStrictEqual(dock.snapSide(rect(1708, 200), [L, R3]), { side: 'right', displayId: 1 });
});

console.log('\n[两屏高度不同] 右屏更高、往下多出一截：接缝只有一半');
ok('右屏左边、y = 400（纵向中点 434 落在左屏覆盖范围内 0..1080）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(1920, 400), [LH, RH]), null);
});
ok('右屏左边、y = 1200（纵向中点 1234，左屏够不着）→ 算外缘，贴右屏左边', () => {
  assert.deepStrictEqual(dock.snapSide(rect(1920, 1200), [LH, RH]), { side: 'left', displayId: 2 });
});
ok('右屏最外侧右边在多出来的那一截（x = 3648, y = 1200）→ 仍贴右', () => {
  assert.deepStrictEqual(dock.snapSide(rect(3648, 1200), [LH, RH]), { side: 'right', displayId: 2 });
});

console.log('\n[副屏在主屏左侧] 坐标为负');
ok('副屏最外侧左（x = -1280）→ 贴左，落副屏 #3', () => {
  assert.deepStrictEqual(dock.snapSide(rect(-1280, 100), [P, S]), { side: 'left', displayId: 3 });
});
ok('接缝（副屏右边 = 主屏左边 = 0）副屏一侧（x = -192，右边缘 0）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(-192, 100), [P, S]), null);
});
ok('接缝主屏一侧（x = 0）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(0, 100), [P, S]), null);
});
ok('主屏最外侧右（x = 1728，右边缘 1920）→ 贴右，落主屏 #1', () => {
  assert.deepStrictEqual(dock.snapSide(rect(1728, 100), [P, S]), { side: 'right', displayId: 1 });
});

console.log('\n[任务栏在左侧] 距离按 workArea 算（bounds.x = 0，workArea.x = 80）');
ok('x = 80（贴工作区左缘，不是屏幕左缘）→ 贴左', () => {
  assert.deepStrictEqual(dock.snapSide(rect(80, 200), [TB]), { side: 'left', displayId: 1 });
});
ok('x = 108（距工作区左缘正好 28；按 bounds 是 108，不会贴）→ 贴左', () => {
  assert.deepStrictEqual(dock.snapSide(rect(108, 200), [TB]), { side: 'left', displayId: 1 });
});
ok('x = 109（距工作区左缘 29）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(109, 200), [TB]), null);
});
ok('窗口压在任务栏上（x = 0，越过工作区左缘）→ 仍贴左，会被拉回来', () => {
  assert.deepStrictEqual(dock.snapSide(rect(0, 200), [TB]), { side: 'left', displayId: 1 });
});
ok('dockRect 贴到工作区边：左 x = 80，右 x = 1728（= 80+1840-192）', () => {
  assert.deepStrictEqual(dock.dockRect({ side: 'left', y: 200, size: SIZE, workArea: TB.workArea }),
    { x: 80, y: 200, width: 192, height: 68 });
  assert.deepStrictEqual(dock.dockRect({ side: 'right', y: 200, size: SIZE, workArea: TB.workArea }),
    { x: 1728, y: 200, width: 192, height: 68 });
});

console.log('\n[缩放不同的两屏] 右屏 2560×1440，左屏 1920×1080');
ok('接缝（右屏左边，x = 1940）→ 不贴', () => {
  assert.strictEqual(dock.snapSide(rect(1940, 200), [A, B]), null);
});
ok('左屏最外侧（x = 0）→ 贴左，落左屏 #1', () => {
  assert.deepStrictEqual(dock.snapSide(rect(0, 200), [A, B]), { side: 'left', displayId: 1 });
});
ok('右屏最外侧（x = 4288，右边缘 4480）→ 贴右，落右屏 #2', () => {
  assert.deepStrictEqual(dock.snapSide(rect(4288, 200), [A, B]), { side: 'right', displayId: 2 });
});
ok('右屏左边在大屏多出来的下段（y = 1300，中点 1334）→ 贴左，落右屏 #2', () => {
  assert.deepStrictEqual(dock.snapSide(rect(1920, 1300), [A, B]), { side: 'left', displayId: 2 });
});

console.log('\n[所在屏 displayFor] 相交面积最大；都不相交取中心点最近');
ok('跨过接缝但有偏向（x = 1700，在左屏 220、右屏 80）→ 左屏 #1', () => {
  assert.strictEqual(dock.displayFor({ x: 1700, y: 200, width: 300, height: 68 }, [L, R]).id, 1);
});
ok('面积平分（x = 1824）→ 取列表中靠前的那块 #1', () => {
  assert.strictEqual(dock.displayFor(rect(1824, 200), [L, R]).id, 1);
});
ok('与两块屏都不相交（x = 4000）→ 中心点最近的右屏 #2', () => {
  assert.strictEqual(dock.displayFor(rect(4000, 200), [L, R]).id, 2);
});
ok('显示器列表为空 → null', () => {
  assert.strictEqual(dock.displayFor(rect(0, 0), []), null);
  assert.strictEqual(dock.snapSide(rect(0, 0), []), null);
});

console.log('\n[零相交兜底] 窗口完全脱离所有屏：displayFor 仍选最近的屏，snapSide 不再跟着吸');
ok('唯一屏在 1920..3840，窗口 x = 0..192 与它零相交 → displayFor 兜底 #2，snapSide 返回 null', () => {
  const RX = mkDisp(2, 1920, 0, 1920, 1080, { x: 1920, y: 0, width: 1920, height: 1040 });
  assert.strictEqual(dock.displayFor(rect(0, 200), [RX]).id, 2);
  assert.strictEqual(dock.snapSide(rect(0, 200), [RX]), null);
});

console.log('\n[dockRect] y 夹进工作区，宽高原样');
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
ok('y = 200 → 原样保留，宽高不变', () => {
  assert.deepStrictEqual(dock.dockRect({ side: 'left', y: 200, size: SIZE, workArea: WA }),
    { x: 0, y: 200, width: 192, height: 68 });
});
ok('y = -50（越上界）→ 夹到 0', () => {
  assert.deepStrictEqual(dock.dockRect({ side: 'left', y: -50, size: SIZE, workArea: WA }),
    { x: 0, y: 0, width: 192, height: 68 });
});
ok('y = 5000（越下界）→ 夹到 1040-68 = 972', () => {
  assert.deepStrictEqual(dock.dockRect({ side: 'right', y: 5000, size: SIZE, workArea: WA }),
    { x: 1728, y: 972, width: 192, height: 68 });
});
ok('尺寸不等于胶囊（60×300）→ 宽高原样，x / 夹取按该尺寸算', () => {
  assert.deepStrictEqual(dock.dockRect({ side: 'right', y: 5000, size: { w: 60, h: 300 }, workArea: WA }),
    { x: 1860, y: 740, width: 60, height: 300 });
});
ok('尺寸高过工作区（64×2000 > 1040）→ 顶对齐 y = 0、不冒出上界，x 仍贴边、宽高原样', () => {
  assert.deepStrictEqual(dock.dockRect({ side: 'left', y: 0, size: { w: 64, h: 2000 }, workArea: WA }),
    { x: 0, y: 0, width: 64, height: 2000 });
  assert.deepStrictEqual(dock.dockRect({ side: 'right', y: 500, size: { w: 64, h: 2000 }, workArea: WA }),
    { x: 1856, y: 0, width: 64, height: 2000 });
});
ok('工作区不在原点（副屏负坐标 + 顶部任务栏）→ 按工作区原点算', () => {
  const wa = { x: -1280, y: -40, width: 1280, height: 1024 };
  assert.deepStrictEqual(dock.dockRect({ side: 'left', y: -100, size: SIZE, workArea: wa }),
    { x: -1280, y: -40, width: 192, height: 68 });
  assert.deepStrictEqual(dock.dockRect({ side: 'right', y: 100, size: SIZE, workArea: wa }),
    { x: -192, y: 100, width: 192, height: 68 });
});

console.log('\n[snapPx 参数] 默认 28，可覆盖');
ok('距左缘 10 DIP，snapPx = 4 → 不贴；snapPx = 10 → 贴', () => {
  assert.strictEqual(dock.snapSide(rect(10, 200), [SOLO], 4), null);
  assert.deepStrictEqual(dock.snapSide(rect(10, 200), [SOLO], 10), { side: 'left', displayId: 1 });
  assert.deepStrictEqual(dock.snapSide(rect(10, 200), [SOLO]), { side: 'left', displayId: 1 });
});

console.log('\n[isOuterEdge] 直接校验（side / y 的作用）');
ok('单屏两侧都是外缘，与 y 无关', () => {
  assert.strictEqual(dock.isOuterEdge(SOLO, 'left', 0, [SOLO]), true);
  assert.strictEqual(dock.isOuterEdge(SOLO, 'right', 1039, [SOLO]), true);
});
ok('并排两屏：左屏右边、右屏左边不是外缘；两个最外侧是', () => {
  assert.strictEqual(dock.isOuterEdge(L, 'right', 200, [L, R]), false);
  assert.strictEqual(dock.isOuterEdge(R, 'left', 200, [L, R]), false);
  assert.strictEqual(dock.isOuterEdge(L, 'left', 200, [L, R]), true);
  assert.strictEqual(dock.isOuterEdge(R, 'right', 200, [L, R]), true);
});
ok('右屏左边在低于左屏的那一截算外缘，在左屏覆盖的高度不算', () => {
  assert.strictEqual(dock.isOuterEdge(RH, 'right', 1200, [LH, RH]), true);
  assert.strictEqual(dock.isOuterEdge(RH, 'left', 1200, [LH, RH]), true);   // 左屏覆盖不到这一行
  assert.strictEqual(dock.isOuterEdge(RH, 'left', 434, [LH, RH]), false);   // 左屏覆盖得到
});

console.log(`\n全部通过（${pass} 项）\n`);
