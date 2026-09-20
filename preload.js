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
    // 胶囊实测尺寸上报：窗口尺寸以渲染层画出来的为准（宽度写死会被内容撑破）
    capsuleSize: (s) => ipcRenderer.send('capsule:size', s),
    panelSize: (s) => ipcRenderer.send('panel:size', s),
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
