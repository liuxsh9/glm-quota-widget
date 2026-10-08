'use strict';
/* 贴边吸附几何（纯函数，不依赖 Electron）—— 由 test/dock.test.js 覆盖。
 *
 * 口径见 _tickets/DESIGN-dock.md「状态模型」：
 *   · 只在松手时判定一次，只贴左右，不贴上下；
 *   · 任意显示器的左 / 右边缘都可贴 —— **两块屏之间的接缝同样算边**
 *     （2026-10-08 用户实测反馈「接缝上不易触发吸附」后反转；原口径把接缝判死）。
 *     跨屏拖拽不受影响：吸附只在松手时判一次，拖动过程从不中断，不会被半路吸住；
 *   · 距离与落点按所在屏的 workArea 算（任务栏在左侧时，贴的是任务栏旁边那条线）；
 *   · 负距离下界 -rect.width：与所在屏在这条边上已无重叠余地时不算贴 ——
 *     displayFor 的中心点兜底会把零相交的矩形领到最近屏，那种矩形不该被吸进来。
 */
const SNAP_PX = 28;   // 松手时距所在屏（工作区）左 / 右边多少 DIP 以内算「贴边」（接缝也算边）

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
 *  面积并列（窗口正好跨在接缝上）时取列表中靠前的那块 —— 这是与列表顺序有关的 tie：
 *  接缝两侧都能贴之后，并列时选中哪块就决定贴哪块屏的哪一侧（落点挂在接缝两边；两屏
 *  工作区边在这条缝上重合时，贴住的那条线相同）；同一列表下结果确定。 */
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

/** 松手时判定该不该贴边。返回 null 或 { side, displayId }。
 *  距离按所在屏的 workArea 算：rect 左边距工作区左边 ≤ snapPx → 'left'；右侧同理。
 *  不再看「这条边是不是屏幕外缘」—— 接缝也照贴，判定与列表里别的屏无关。
 *  两边都满足（窗口比屏还宽之类）取距离更近的一边。
 *  已经越过工作区边缘（距离为负）也算贴 —— 此时更该把窗口拉回来；
 *  但下界是 -rect.width：越出自身宽度意味着与工作区在这条边上已无重叠余地
 *  （矩形与屏零相交时 displayFor 的中心点兜底会把人领到这里），不再算贴。 */
function snapSide(rect, displays, snapPx = SNAP_PX) {
  const d = displayFor(rect, displays);
  if (!d) return null;
  const wa = d.workArea;
  const distLeft = rect.x - wa.x;
  const distRight = (wa.x + wa.width) - (rect.x + rect.width);
  const floor = -rect.width;                                            // 负距离下界：与工作区在这条边上还有重叠余地才算贴

  let side = null;
  if (distLeft <= snapPx && distLeft >= floor) side = 'left';
  if (distRight <= snapPx && distRight >= floor
      && (side === null || Math.abs(distRight) < Math.abs(distLeft))) side = 'right';
  return side ? { side, displayId: d.id } : null;
}

/** 贴边后的窗口矩形：x 贴到工作区对应边，y 夹进工作区（窗口高过工作区时顶对齐，不冒出上界），宽高原样。 */
function dockRect({ side, y, size, workArea: wa }) {
  return {
    x: side === 'right' ? wa.x + wa.width - size.w : wa.x,
    y: Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - size.h)),
    width: size.w,
    height: size.h,
  };
}

module.exports = { SNAP_PX, snapSide, dockRect, displayFor };
