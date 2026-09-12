'use strict';
/* 拖拽引擎（纯函数，不依赖 Electron）—— 由 test/drag.test.js 覆盖。
 *
 * 为什么不用「渲染层增量」驱动窗口：
 *   MouseEvent.screenX/Y 是 CSS 像素，而 BrowserWindow 的位置是 DIP。两者只有在
 *   100% 缩放时才一一对应；125%/150%/200% 的屏幕上每帧的换算误差都写进窗口坐标，
 *   窗口走得比光标慢，光标很快滑出窗口矩形 —— 而指针事件只在窗口内投递，
 *   于是 pointermove 断流，表现就是「拖不动」。
 *
 * 本模块的做法：主进程在 drag-start 时同时记下「光标点」和「窗口原点」两个锚点，
 * 之后每次移动都用光标相对锚点的**绝对增量**重算窗口位置。
 *   - 光标与窗口在同一坐标系里取样（都是 DIP），不存在换算误差；
 *   - 目标位置只由光标决定，不读回窗口当前位置 → 没有反馈环，不会累积漂移；
 *   - 边界钳制只在最终落点做，回到界内立刻精确还原。
 */

/** 记下拖拽起点：光标锚点 + 窗口锚点 + 可用范围。所有数值单位一致（DIP）。 */
function begin({ cx, cy, wx, wy, wa, size }) {
  return {
    cx, cy,                 // 按下时（或越过死区时）的光标位置
    wx, wy,                 // 同一刻的窗口原点
    size: { w: size.w, h: size.h },
    wa: { x: wa.x, y: wa.y, width: wa.width, height: wa.height },
  };
}

/** 光标移到 (cx, cy) 时窗口应该在的位置。返回 {x,y}，越界钳制在 wa 内。 */
function move(ctx, cx, cy) {
  return {
    x: clamp(Math.round(ctx.wx + (cx - ctx.cx)), ctx.wa.x, ctx.wa.x + ctx.wa.width - ctx.size.w),
    y: clamp(Math.round(ctx.wy + (cy - ctx.cy)), ctx.wa.y, ctx.wa.y + ctx.wa.height - ctx.size.h),
  };
}

/** 光标移到 (cx, cy) 时的完整窗口矩形，尺寸钉死为 begin() 时的快照。
 *
 *  必须整块下发、不能只改原点：frameless 窗口在 Windows 上每次 setPosition 都会
 *  悄悄把窗口撑大一点（约 1 DIP/次，高 DPI 下更明显），表现是内容区块不变、
 *  四周透明留白越来越大。setBounds 带上固定尺寸，OS 就没有累积漂移的余地。 */
function boundsFor(ctx, cx, cy) {
  const p = move(ctx, cx, cy);
  return { x: p.x, y: p.y, width: ctx.size.w, height: ctx.size.h };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

module.exports = { begin, move, boundsFor, clamp };
