'use strict';
/* 桥接层：任何失败都要能被主进程日志看到，而不是静默白屏 */
try {
  const { contextBridge, ipcRenderer } = require('electron');

  contextBridge.exposeInMainWorld('glm', {
    getState: () => ipcRenderer.invoke('state:get'),
    save: (patch) => ipcRenderer.invoke('cfg:save', patch),
    refreshNow: () => ipcRenderer.invoke('refresh:now'),
    clipboardPeek: () => ipcRenderer.invoke('clipboard:peek'),
    setView: (v) => ipcRenderer.send('view:set', v),
    setZoom: (z) => ipcRenderer.send('zoom:set', z),
    dragBy: (dx, dy) => ipcRenderer.send('win:drag', { dx, dy }),
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
