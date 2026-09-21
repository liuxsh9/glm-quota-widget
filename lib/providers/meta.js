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
 *
 * 凭据声明的字段：
 *   key/label/placeholder  渲染输入框用（placeholder 必填，providers.test.js 会检查）
 *   required               必填校验；留空即拒绝保存
 *   kind: 'select'         渲染成下拉而不是文本框，配 options:[{value,label}] 用。
 *                          这类字段是**枚举而非秘密**：设置页会跳过它的「清除」按钮与
 *                          剪贴板识别，账户行的凭据尾号列表里也不显示（不然会冒出「…auto」）
 *   guide                  可折叠的获取指引 { summary, steps[] }（steps 里可含 HTML）
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
    {
      id: 'volc',
      name: '火山方舟 Coding / Agent Plan',
      tab: '火山',
      accentMode: 'tier',
      capsuleW: 92,
      peak: null,                 // 套餐按调用次数计费，不分峰谷
      site: 'https://console.volcengine.com/ark',
      siteLabel: '打开火山方舟控制台 ›（套餐余量在「开通管理」）',
      domains: ['volces\\.com', 'volcengine\\.com'],
      tabBadge: 'level',
      credentials: [
        {
          key: 'accessKeyId',
          label: 'AccessKey ID',
          required: true,
          placeholder: '粘贴 AccessKey ID，形如 AKLTxxxxxxxxxxxxxxxx',
          guide: {
            summary: '怎么获取？（务必用只读子账号，别用主账号的 AK/SK）',
            steps: [
              '<b>先说风险</b>：火山的用量接口只认 AK/SK 签名（不是推理用的 API Key），而 AK/SK 能签这个身份名下的<b>所有</b>管理接口，远不止查用量。所以',
              '登录火山引擎控制台 → <b>访问控制 IAM</b> → 用户 → <b>新建用户</b>，访问方式只勾「<b>编程访问</b>」（不要给控制台登录密码）',
              '给这个子用户挂两个<b>只读</b>预设策略：<b>ArkReadOnlyAccess</b>（火山方舟全局只读）+ <b>BillingCenterReadOnlyAccess</b>（费用中心只读）',
              '在子用户下创建 <b>AccessKey</b>：<code>console.volcengine.com/iam/keymanage</code>',
              '把 <b>AccessKey ID</b> 与 <b>Secret Access Key</b> 分别粘到下面两个框里（Secret 只在创建时显示一次，丢了只能重建）',
              '接口按<b>调用次数</b>记账，两条额度分别是 5 小时 / 周 / 月三个窗口——跟 GLM 一样会算「预期进度」',
            ],
          },
        },
        {
          key: 'accessKeySecret',
          label: 'Secret Access Key',
          required: true,
          placeholder: '粘贴与上面那个 AK 成对的 Secret Access Key',
          guide: null,
        },
        {
          key: 'plan',
          label: '套餐',
          kind: 'select',
          required: true,
          placeholder: '自动识别',
          options: [
            { value: 'auto', label: '自动识别（默认）' },
            { value: 'coding', label: 'Coding Plan' },
            { value: 'agent', label: 'Agent Plan' },
          ],
          guide: {
            summary: '什么时候需要手动指定？',
            steps: [
              '默认「自动识别」：先查 Coding Plan，没订阅再查 Agent Plan，一个账号只用配一次',
              '同一个账号<b>两种套餐都订阅了</b>时，自动识别只会显示 Coding Plan（面板上会提示）',
              '那种情况就<b>再加一个账户</b>、填同一对 AK/SK，把这里固定成 Agent Plan——一个账户盯一种套餐，互不干扰',
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
