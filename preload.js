'use strict';
/* 桥接层：任何失败都要能被主进程日志看到，而不是静默白屏 */
try {
  const { contextBridge, ipcRenderer } = require('electron');

  contextBridge.exposeInMainWorld('glm', {
    getState: () => ipcRenderer.invoke('state:get'),
    save: (patch) => ipcRenderer.invoke('cfg:save', patch),
    refreshNow: () => ipcRenderer.invoke('refresh:now'),
    clipboardPeek: () => ipcRenderer.invoke('clipboard:peek'),
    // 账户 CRUD：都直接返回广播用的最新状态（省一次等待）
    accAdd: (p) => ipcRenderer.invoke('acc:add', p),
    accUpdate: (p) => ipcRenderer.invoke('acc:update', p),
    accRemove: (p) => ipcRenderer.invoke('acc:remove', p),
    accActivate: (p) => ipcRenderer.invoke('acc:activate', p),
    accMenu: (p) => ipcRenderer.invoke('acc:menu', p),   // 原生弹出菜单选账户，关闭后返回新状态
    accDock: (p) => ipcRenderer.invoke('acc:dock', p),   // 保存某个账户的圆圈口径（百分比）
    // 胶囊实测尺寸上报：窗口尺寸以渲染层画出来的为准（宽度写死会被内容撑破）
    capsuleSize: (s) => ipcRenderer.send('capsule:size', s),
    dockSize: (s) => ipcRenderer.send('dock:size', s),   // 贴边内容实测尺寸（dock 不含 PAD）
    panelSize: (s) => ipcRenderer.send('panel:size', s),
    // 贴边悬停 → 飞出卡片（主进程的第二个透明窗口，?flyout=1）
    dockHover: (h) => ipcRenderer.send('dock:hover', h),      // { accId, cy } 或 null（离开圆圈）
    flyoutHover: (b) => ipcRenderer.send('flyout:hover', b),  // 鼠标是否在卡片上
    flyoutSize: (s) => ipcRenderer.send('flyout:size', s),    // 卡片实测尺寸（= 飞出窗口尺寸）
    onFlyoutTarget: (cb) => ipcRenderer.on('flyout:target', (_e, t) => cb(t)),   // { pid, accId, side } 或 null
    setView: (v) => ipcRenderer.send('view:set', v),
    setTab: (t) => ipcRenderer.send('tab:set', t),
    setZoom: (z) => ipcRenderer.send('zoom:set', z),
    dragStart: (gx, gy) => ipcRenderer.send('win:drag-start', { gx, gy }),
    dragMove: () => ipcRenderer.send('win:drag-move'),
    dragEnd: () => ipcRenderer.send('win:drag-end'),
    ctxMenu: () => ipcRenderer.send('ctx:menu'),
    trayIcon: (url) => ipcRenderer.send('tray:icon', url),
    openExternal: (u) => ipcRenderer.send('open:external', u),
    quit: () => ipcRenderer.send('app:quit'),
    onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
    ready: () => ipcRenderer.send('renderer:ready'),
  });
} catch (e) {
  try { require('electron').ipcRenderer.send('renderer:boot-error', 'preload: ' + (e && e.message)); } catch { }
  throw e;
}
