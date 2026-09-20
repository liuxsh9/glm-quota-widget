'use strict';
/**
 * Provider 元数据：挂件能监控哪些云、每家要配什么凭据、长什么强调色。
 *
 * 这份文件是**纯数据**（无 IO、无 DOM、无 Node API），按 lib/format.js 的同款 UMD 模式
 * 双端加载：主进程 require，渲染层 <script> 引入挂到 window.GLMPROV。
 * 设置页的输入框/指引、面板页签、胶囊列宽全部由它驱动——新增一家 provider
 * （如火山云）只需要在这里加一条 + 一个主进程实现模块，界面自动出现新分段。
 *
 * 字段约定：
 *   id          稳定标识，config.accounts[].provider / state.providers 的键
 *   name        展示名（设置页分段标题）
 *   tab         面板页签短名
 *   accent      固定强调色 [起,止]；accentMode='tier' 表示跟随全局档位变色（配额型 provider）
 *   capsuleW    胶囊单列宽度（px）：**首帧兜底估值**。真实宽高由渲染层实测（capsule:size）
 *               回传 —— 卡片的宽度是 max-content，多账户/数字位数/账户名长短都由它兜住
 *   peak        lib/format.js 里 PEAK_WINDOWS / PERIOD_NOTE 的键；null 表示无峰谷概念
 *   credentials 凭据字段声明（渲染层照此生成输入框；required=false 的字段选配）
 */
(function (factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  if (typeof window !== 'undefined') window.GLMPROV = factory();
})(function () {
  const list = [
    {
      id: 'glm',
      name: 'GLM Coding Plan',
      tab: 'GLM',
      accentMode: 'tier',
      capsuleW: 96,
      peak: 'glm',
      site: 'https://www.bigmodel.cn/coding-plan/personal/overview',
      siteLabel: '打开 bigmodel.cn 官网',
      domains: ['bigmodel\\.cn'],   // open:external 的放行名单（正则片段）
      controls: ['quota-alerts'],   // 设置页本段要渲染的专属全局控件（key 见 settings.js）
      tabBadge: 'level',            // 页签上带套餐名徽标（GLM 的 level 字段）
      credentials: [
        {
          key: 'token',
          label: 'API Key / 登录 Cookie',
          required: true,
          placeholder: '粘贴 API Key（推荐，长期有效），或整段 Cookie / bigmodel_token_production 的值',
          guide: {
            summary: '怎么获取？（API Key 一劳永逸，Cookie 约 3 天失效）',
            steps: [
              '推荐 <b>API Key</b>：登录 bigmodel.cn → 控制台「<b>API Keys</b>」→ 创建/复制 Key',
              '粘贴后保存，长期有效无需再管',
              '也可用登录 Cookie：官网按 <b>F12</b> → 「<b>应用 / Application</b>」→ 存储 → <b>Cookie</b> → bigmodel.cn',
              '找 <b>bigmodel_token_production</b> → 双击「值」列全选 → <b>Ctrl+C</b> 复制（整段 Cookie 也可，自动提取）',
              'Cookie 约 3 天失效，挂件会变红提醒，届时同流程粘贴新值即可',
            ],
          },
        },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek 官方 API',
      tab: 'DeepSeek',
      accentMode: 'fixed',
      accent: { dark: ['#22d3ee', '#8b5cf6'], light: ['#4f7dff', '#8b5cf6'] },
      capsuleW: 74,
      peak: 'ds',
      site: 'https://platform.deepseek.com/usage',
      siteLabel: '打开 platform.deepseek.com 用量页',
      domains: ['deepseek\\.com'],
      controls: ['ds-poll'],
      credentials: [
        {
          key: 'apiKey',
          label: 'API Key（余额，长期有效）',
          required: true,
          placeholder: '粘贴 sk- 开头的 API Key，形如 sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          guide: null,
        },
        {
          key: 'platformToken',
          label: '平台令牌（选配，用于精确账单与逐模型用量）',
          required: false,
          placeholder: '粘贴 platform.deepseek.com 的 userToken（整段 JSON 或裸 token 都可以）',
          guide: {
            summary: '怎么获取？（不配也能用：只配 API Key 即可看余额）',
            steps: [
              '登录 platform.deepseek.com → <b>F12</b> → 「<b>应用 / Application</b>」→ <b>Local Storage</b> → platform.deepseek.com',
              '找到 <b>userToken</b> 键 → 复制整段值（形如 <code>{"value":"…"}</code>，自动提取其中的 token）',
              '粘贴保存后即可看到精确的每日消费、本月账单与逐模型 token',
              '该令牌是<b>平台登录态</b>，会过期（比 GLM 的 Cookie 还不稳定），过期后挂件会提示',
              '不配置时，消费数字由<b>本机余额差值</b>推算：挂件没运行的时段补不回来，头几天数字会偏少',
            ],
          },
        },
      ],
    },
  ];

  const byId = (id) => list.find((p) => p.id === id) || null;
  /** 某家 provider 的某个凭据字段声明 */
  const credOf = (pid, key) => { const p = byId(pid); return p ? p.credentials.find((c) => c.key === key) || null : null; };

  return { list, byId, credOf };
});
