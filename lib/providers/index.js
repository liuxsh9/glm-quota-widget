'use strict';
/**
 * Provider 注册表：元数据（渲染层共用，见 meta.js）+ 主进程实现（同目录各模块）。
 *
 * 新增一家 provider（如火山云）的完整清单：
 *   1. lib/providers/<id>.js    实现 fetch（可选 pollBalance/tier）
 *   2. meta.js 的 list 里加一条（名称/凭据声明/强调色/胶囊列宽）
 *   3. 这里 IMPLS 加一行
 *   4. renderer 侧若有专属面板视图，在 renderer/panes.js 加一个渲染器（没有则给通用视图）
 * 设置页分段、面板页签、胶囊列、账户管理全部自动出现。
 */
const meta = require('./meta');
const glm = require('./glm');
const deepseek = require('./deepseek');

const IMPLS = { glm, deepseek };

const list = meta.list
  .map((m) => ({ ...m, ...(IMPLS[m.id] || {}) }))
  .filter((p) => !!IMPLS[p.id] || p.experimental);   // 元数据先行、实现未就绪的不注册

const byId = (id) => list.find((p) => p.id === id) || null;

module.exports = { list, byId };
