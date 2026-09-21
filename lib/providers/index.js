'use strict';
/**
 * Provider 注册表：元数据（渲染层共用，见 meta.js）+ 主进程实现（同目录各模块）。
 *
 * 新增一家 provider（如火山云）的完整清单：
 *   1. lib/providers/<id>.js    实现 fetch（可选 pollBalance/tier）
 *   2. meta.js 的 list 里加一条（名称/凭据声明/强调色/胶囊列宽）
 *   3. 这里 IMPLS 加一行
 *   4. **必须**在 renderer/panes.js 加一个渲染器并注册进 window.PANES
 *      （没有「通用视图」兜底：缺了这一条，页签有、设置页有，但胶囊上没有这一列、面板里是空的）
 * 设置页分段、面板页签、账户管理、凭据剪贴板识别全部自动出现。
 *
 * 注意第 4 步不是可选的，而且 meta 与实现要**同一次落地**：渲染层读的是未经 IMPLS 过滤的
 * 元数据，只加 meta 会多出一个「＋ 添加账户」按钮，点了却报「未知 provider」。
 */
const meta = require('./meta');
const glm = require('./glm');
const deepseek = require('./deepseek');
const volc = require('./volc');

const IMPLS = { glm, deepseek, volc };

const list = meta.list
  .map((m) => ({ ...m, ...(IMPLS[m.id] || {}) }))
  .filter((p) => !!IMPLS[p.id] || p.experimental);   // 元数据先行、实现未就绪的不注册

const byId = (id) => list.find((p) => p.id === id) || null;

module.exports = { list, byId };
