'use strict';
/* 拖拽引擎测试：用缩放感知的模拟器复现「高 DPI 拖不动」，并校验新引擎的光标跟随误差。
   跑法：node test/drag.test.js    （无 Electron 依赖，CI 可直接跑）

   坐标空间（这是整件事的关键）：
     · 光标物理位移        —— 屏幕上真实移动了多少像素
     · 窗口几何(win.*)     —— Electron 的 DIP 空间；scale=200% 时 1 DIP = 2 物理 px
     · 渲染层 screenX/Y    —— CSS 像素，恒等于 DIP
   窗口每帧位移是否等于「光标物理位移 / scale」，决定了窗口跟不跟得上光标。 */
const assert = require('assert');
const drag = require('../lib/drag');

const SIZE = { w: 192, h: 68 };                       // capsule(168×44) + PAD×2
const WA = { x: 0, y: 0, width: 8000, height: 4000 }; // 工作区（DIP）；开得足够大，避免钳制掩盖跟随误差

/* ===================== 旧实现：渲染层增量 + rAF 合帧 ===================== */
/**
 * @param {number} scale      设备缩放（200% → 2）
 * @param {'physical'|'css'} reported screenX 的单位：物理像素 还是 CSS 像素(=DIP)
 */
function simulateLegacy({ scale, reported = 'physical', frameMs = 16, durationMs = 600 }) {
  const physPerDip = scale;                            // 1 DIP = scale 个物理像素
  const toReport = (phys) => (reported === 'physical' ? phys : phys / physPerDip);
  const speed = 1.4;                                   // 光标物理速度 px/ms（约 1400px/s）

  let cursor = { x: 460, y: 420 };                     // 物理像素
  let win = { x: 400, y: 400 };                        // DIP
  const anchorOffset = { x: 60, y: 20 };               // 抓取点相对窗口的偏移（DIP）

  let lastRep = { x: toReport(cursor.x), y: toReport(cursor.y) }; // 渲染层 drag.sx/sy
  let acc = { x: 0, y: 0 };                            // 本帧累积、待 rAF 合帧发出的增量
  let delivered = 0, ticks = 0, deadzoneDrops = 0, firstDeadzoneDrop = null;
  let lostAt = null;

  for (let t = 0; t < durationMs; t += frameMs) {
    ticks++;
    cursor = { x: cursor.x + speed * frameMs, y: cursor.y + speed * frameMs };

    // 指针事件只在窗口矩形内投递：光标物理坐标 → DIP，再与窗口几何比较
    const rel = { x: cursor.x / physPerDip - win.x / physPerDip, y: cursor.y / physPerDip - win.y / physPerDip };
    const inWindow = rel.x >= 0 && rel.x < SIZE.w && rel.y >= 0 && rel.y < SIZE.h;
    if (!inWindow) { if (lostAt === null) lostAt = t; acc = { x: 0, y: 0 }; lastRep = { x: toReport(cursor.x), y: toReport(cursor.y) }; continue; }
    delivered++;

    // 渲染层：screenX 增量 → 累加（rAF 合帧）
    const rep = { x: toReport(cursor.x), y: toReport(cursor.y) };
    const dx = rep.x - lastRep.x, dy = rep.y - lastRep.y;
    lastRep = rep;
    if (Math.abs(dx) + Math.abs(dy) <= 4) continue;    // 死区：小增量被丢弃
    acc = { x: acc.x + dx, y: acc.y + dy };

    // 主进程：读窗口位置（DIP）+ 增量，钳制后写回
    const nx = drag.clamp(Math.round(win.x + acc.x), WA.x, WA.x + WA.width - SIZE.w);
    const ny = drag.clamp(Math.round(win.y + acc.y), WA.y, WA.y + WA.height - SIZE.h);
    acc = { x: 0, y: 0 };
    win = { x: nx, y: ny };
  }

  // 光标已走过的距离（DIP）；稳态下窗口应完全跟上
  const travelled = (cursor.x - 460) / physPerDip;
  // 窗口掉队了多少 DIP —— 正值表示窗口走得比光标慢，光标会逐渐滑出窗口
  const lag = travelled - (win.x - 400);
  return { lag, lostAt, delivered, ticks, travelled };
}

/* ===================== 新引擎：主进程光标锚点 + 绝对增量 ===================== */
function simulateNew({ scale, frameMs = 16, durationMs = 600 }) {
  const physPerDip = scale;
  const speed = 1.4;                                   // DIP/ms

  let cursor = { x: 460, y: 420 };                     // DIP（screenX/Y 就是 CSS 像素 = DIP）
  let win = { x: 400, y: 400 };                        // DIP
  const anchorOffset = { x: 60, y: 20 };

  // drag-start：光标与窗口各取一份锚点（都换算到同一个坐标系 —— 这里统一用物理像素）
  let ctx = drag.begin({ cx: cursor.x, cy: cursor.y, wx: win.x, wy: win.y, wa: WA, size: SIZE });

  let lostAt = null, samples = 0;
  for (let t = 0; t < durationMs; t += frameMs) {
    cursor = { x: cursor.x + speed * frameMs, y: cursor.y + speed * frameMs };

    // 采样只发生在指针仍在窗口内时（外部有看门狗，这里只验证跟随精度）
    // 窗口矩形在物理像素里，光标在 DIP 里，换算后再比
    const rel = { x: cursor.x - win.x, y: cursor.y - win.y };
    const inWindow = rel.x >= 0 && rel.x < SIZE.w && rel.y >= 0 && rel.y < SIZE.h;
    if (!inWindow) { if (lostAt === null) lostAt = t; continue; }

    samples++;
    win = drag.move(ctx, cursor.x, cursor.y);
  }

  const travelled = cursor.x - 460;
  const lag = travelled - (win.x - 400);               // 0 = 窗口完全咬住光标
  return { lag, lostAt, samples, travelled };
}

/* ============ 尺寸稳定性：Windows frameless 窗口每次 setPosition 涨一圈 ============ */
/** 只改原点的移动：模拟 Windows 上每次 setPosition 让窗口涨 inset（高 DPI 更明显） */
function simulateGrow({ scale, moves = 800 }) {
  const inset = 0.5 * scale;                           // 每次移动累计的 DIP
  let size = { ...SIZE }, cursor = { x: 460, y: 420 }, win = { x: 400, y: 400 };
  const ctx = drag.begin({ cx: cursor.x, cy: cursor.y, wx: win.x, wy: win.y, wa: WA, size });
  for (let i = 0; i < moves; i++) {
    cursor.x += 2; cursor.y += 1;
    const p = drag.move(ctx, cursor.x, cursor.y);
    win = { x: p.x, y: p.y };
    size = { w: size.w + inset, h: size.h + inset };   // ← OS 侧悄悄累积
  }
  return { size, start: SIZE };
}
/** 整块下发：尺寸由 begin() 快照钉死，OS 没有漂移的余地 */
function simulatePinned({ scale, moves = 800 }) {
  const inset = 0.5 * scale;
  let size = { ...SIZE }, cursor = { x: 460, y: 420 }, win = { x: 400, y: 400 };
  const ctx = drag.begin({ cx: cursor.x, cy: cursor.y, wx: win.x, wy: win.y, wa: WA, size });
  for (let i = 0; i < moves; i++) {
    cursor.x += 2; cursor.y += 1;
    const b = drag.boundsFor(ctx, cursor.x, cursor.y);
    win = { x: b.x, y: b.y };
    size = { w: b.width, h: b.height };                // ← 每帧显式钉回快照值
    if (size.w !== ctx.size.w || size.h !== ctx.size.h) size.w += inset; // 不该发生
  }
  return { size, start: SIZE };
}

/* ================================ 用例 ================================ */
let pass = 0;
function ok(name, fn) { fn(); console.log('  ✓', name); pass++; }

console.log('\n[复现] 旧实现（渲染层增量 + rAF 合帧）—— 拖动 600ms、光标行走 840 DIP');
for (const scale of [1, 1.25, 1.5, 2]) {
  for (const reported of ['physical', 'css']) {
    const r = simulateLegacy({ scale, reported });
    const broke = r.lostAt !== null;
    console.log(`  ${broke ? '✗' : '·'} scale=${String(scale).padEnd(4)} screenX=${reported.padEnd(8)}` +
      ` 窗口掉队=${r.lag.toFixed(0).padStart(4)}DIP` +
      (broke ? `  光标 ${r.lostAt}ms 起脱离窗口 → 拖不动` : '  全程粘手（仅 100% 缩放且 screenX 走 DIP 时才成立）'));
  }
}

console.log('\n[回归] 新引擎（主进程光标锚点 + 绝对增量）');
for (const scale of [1, 1.25, 1.5, 2, 3]) {
  ok(`dpr=${scale}：窗口零掉队，光标始终咬住窗口同一点`, () => {
    const r = simulateNew({ scale });
    assert.strictEqual(r.lostAt, null, `${scale}: 光标不该脱离窗口（${r.lostAt}ms）`);
    assert.ok(Math.abs(r.lag) <= 1, `${scale}: 掉队 ${r.lag}DIP 应 ≤1DIP`);
  });
}

console.log('\n[回归] 拖拽 800 次后窗口尺寸（Windows frameless 涨圈 bug）');
for (const scale of [1, 1.5, 2]) {
  const grow = simulateGrow({ scale });
  console.log(`  · scale=${String(scale).padEnd(4)} 只改原点: ${SIZE.w}×${SIZE.h} → ` +
    `${grow.size.w.toFixed(0)}×${grow.size.h.toFixed(0)}` +
    `  （四周留白涨 ${(grow.size.w - SIZE.w).toFixed(0)}×${(grow.size.h - SIZE.h).toFixed(0)} DIP）`);
}
for (const scale of [1, 1.5, 2]) {
  ok(`scale=${scale}：整块下发后尺寸始终 ${SIZE.w}×${SIZE.h}`, () => {
    const r = simulatePinned({ scale });
    assert.strictEqual(r.size.w, SIZE.w, `宽度漂了 ${r.size.w - SIZE.w} DIP`);
    assert.strictEqual(r.size.h, SIZE.h, `高度漂了 ${r.size.h - SIZE.h} DIP`);
  });
}

console.log('\n[边界] 工作区钳制');
ok('越界后窗口停在工作区内，回到范围内立刻精确还原（无累积误差）', () => {
  const ctx = drag.begin({ cx: 500, cy: 500, wx: 400, wy: 400, wa: { x: 0, y: 0, width: 1920, height: 1080 }, size: SIZE });
  const far = drag.move(ctx, 5000, 5000);
  assert.strictEqual(far.x, 1920 - SIZE.w, '右边界钳制');
  assert.strictEqual(far.y, 1080 - SIZE.h, '下边界钳制');
  const back = drag.move(ctx, 600, 600);
  assert.strictEqual(back.x, 500, '回到界内应精确还原（不残留钳制偏移）');
  assert.strictEqual(back.y, 500, '回到界内应精确还原（不残留钳制偏移）');
});
ok('来回拖动 500 次：光标相对窗口的位置恒定，不累积漂移', () => {
  const home = { x: 320, y: 320 }, origin = { x: 300, y: 300 };
  const grab = { x: home.x - origin.x, y: home.y - origin.y };   // 抓取点（光标相对窗口）
  let win = { ...origin }, cursor = { ...home };
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const ctx = drag.begin({ cx: cursor.x, cy: cursor.y, wx: win.x, wy: win.y, wa: WA, size: SIZE });
    const to = { x: home.x + (i % 2 ? 100 : -100), y: home.y + (i % 2 ? 60 : -60) };
    win = drag.move(ctx, to.x, to.y);
    cursor = { x: to.x, y: to.y };
    worst = Math.max(worst, Math.abs(cursor.x - win.x - grab.x) + Math.abs(cursor.y - win.y - grab.y));
  }
  assert.strictEqual(worst, 0, `抓取点最大偏移 ${worst}px 应为 0`);
  assert.deepStrictEqual(win, { x: origin.x + 100, y: origin.y + 60 }, '末次落点应精确');
});
ok('位置吸附到整数 DIP（避免亚像素抖动）', () => {
  const ctx = drag.begin({ cx: 100.4, cy: 100.6, wx: 50.2, wy: 50.4, wa: { x: 0, y: 0, width: 1920, height: 1080 }, size: SIZE });
  const r = drag.move(ctx, 130.7, 140.9);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y), '应输出整数');
  assert.strictEqual(r.x, 80, 'x = round(50.2 + 30.3)');
  assert.strictEqual(r.y, 91, 'y = round(50.4 + 40.3)');
});

console.log(`\n全部通过（${pass} 项）\n`);
