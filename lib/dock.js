'use strict';
/* 贴边吸附几何（纯函数，不依赖 Electron）—— 由 test/dock.test.js 覆盖。
 *
 * 口径见 _tickets/DESIGN-dock.md「状态模型」：
 *   · 只在松手时判定一次，只贴左右，不贴上下；
 *   · 「邻接判断用 bounds，贴靠位置用 workArea」——两块屏的接缝是屏幕之间的关系，
 *     与任务栏无关，所以接缝判定只看 bounds；而距离和落点要避开任务栏，
 *     所以按 workArea 算（任务栏在左侧时，贴的是任务栏旁边那条线）；
 *   · 「外缘」：本屏这条边在高度 y 处是外缘 ⇔ 不存在另一块屏的边界与它相接
 *     （±2 DIP）且纵向覆盖 y。y 取窗口纵向中点 —— 因此上下错开的两块屏，
 *     高的那块边缘只有一截是外缘，另一截仍是接缝。
 *
 * 接缝必须判死：跨屏拖胶囊时如果把接缝当成边缘，窗口会在半路被吸住，永远拖不过去。
 */
const SNAP_PX = 28;   // 松手时距外缘多少 DIP 以内算「贴边」
const EDGE_TOL = 2;   // 两块屏边界相接的容差（DIP）

/** 矩形中心点 */
function centerOf(r) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** 两矩形相交面积；只碰到边不算相交（面积 0） */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return (w > 0 && h > 0) ? w * h : 0;
}

/** 矩形落在哪块屏：相交面积最大的那块；都不相交取中心点距离最近的那块。无屏 → null。
 *  面积平分（窗口正好跨在接缝上）时取列表中靠前的那块 —— 此时两侧都不是外缘，
 *  选哪块不影响 snapSide 的结果。 */
function displayFor(rect, displays) {
  if (!displays || displays.length === 0) return null;
  let best = null, bestArea = 0;
  for (const d of displays) {
    const area = overlapArea(rect, d.bounds);
    if (area > bestArea) { best = d; bestArea = area; }
  }
  if (best) return best;

  const c = centerOf(rect);
  let nearest = null, nearestDist = Infinity;
  for (const d of displays) {
    const dc = centerOf(d.bounds);
    const dist = Math.hypot(dc.x - c.x, dc.y - c.y);
    if (dist < nearestDist) { nearestDist = dist; nearest = d; }
  }
  return nearest;
}

/** display 的 side 边（'left'|'right'）在高度 y 处是不是屏幕外缘。
 *  另一块屏 E 的边界与这条边相接（±2 DIP）且 E 的纵向范围覆盖 y ⇒ 是接缝，不是外缘。
 *  纵向覆盖按半开区间 [y, y+height) 算：恰好落在下边界上时那块屏已不覆盖该行。 */
function isOuterEdge(display, side, y, displays) {
  const b = display.bounds;
  for (const e of displays) {
    if (e === display || (display.id != null && e.id === display.id)) continue;
    const eb = e.bounds;
    const touching = side === 'left'
      ? Math.abs(eb.x + eb.width - b.x) <= EDGE_TOL
      : Math.abs(eb.x - (b.x + b.width)) <= EDGE_TOL;
    if (!touching) continue;
    if (y >= eb.y && y < eb.y + eb.height) return false;
  }
  return true;
}

/** 松手时判定该不该贴边。返回 null 或 { side, displayId }。
 *  距离按所在屏的 workArea 算：rect 左边距工作区左边 ≤ snapPx 且该边在 rect 纵向
 *  中点处是外缘 → 'left'；右侧同理。两边都满足（窗口比屏还宽之类）取距离更近的一边。
 *  已经越过工作区边缘（距离为负）也算贴 —— 此时更该把窗口拉回来。 */
function snapSide(rect, displays, snapPx = SNAP_PX) {
  const d = displayFor(rect, displays);
  if (!d) return null;
  const wa = d.workArea;
  const y = rect.y + rect.height / 2;                                   // 外缘判定用的高度：窗口纵向中点
  const distLeft = rect.x - wa.x;
  const distRight = (wa.x + wa.width) - (rect.x + rect.width);

  let side = null;
  if (distLeft <= snapPx && isOuterEdge(d, 'left', y, displays)) side = 'left';
  if (distRight <= snapPx && isOuterEdge(d, 'right', y, displays)
      && (side === null || Math.abs(distRight) < Math.abs(distLeft))) side = 'right';
  return side ? { side, displayId: d.id } : null;
}

/** 贴边后的窗口矩形：x 贴到工作区对应边，y 夹进工作区，宽高原样。 */
function dockRect({ side, y, size, workArea: wa }) {
  return {
    x: side === 'right' ? wa.x + wa.width - size.w : wa.x,
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - size.h),
    width: size.w,
    height: size.h,
  };
}

module.exports = { SNAP_PX, isOuterEdge, snapSide, dockRect, displayFor };
