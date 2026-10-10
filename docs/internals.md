# 数据来源与开发

挂件从哪些接口取数、取到什么、怎么解析；以及仓库结构与二次开发。

## 数据从哪来

### GLM（配额百分比）

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Authorization: <API Key 或 bigmodel_token_production 的 JWT>   # 注意没有 Bearer 前缀
```

与智谱官方插件 [glm-plan-usage](https://github.com/zai-org/zai-coding-plugins) 同源的官方接口。返回两条 `CREDIT_LIMIT`：带 `unit`/`number` 字段时按窗口时长区分（3 = 小时×number → 5 小时额度，6 = 周 → 周额度），老响应缺字段时退回「`nextResetTime` 早的那个是 5 小时额度」。

### DeepSeek（余额 / 消费）

两条**互相独立**的链路，各配各的、各降各的级：

| 链路 | 凭据 | 有效期 | 拿到什么 | 刷新频率 |
|---|---|---|---|---|
| 余额 | `sk-` API Key | 长期 | 账户余额、充值/赠送拆分 | **单独每 2 分钟**（可调 1/2/5/10 分钟或关闭） |
| 精确账单 | 平台 `userToken`（选配） | 短，会过期 | 逐日消费、本月账单、逐模型 token 与缓存命中率 | 跟主刷新频率（默认 10 分钟） |

平台账单最细只到「天」，所以「最近 5 分钟」「近 1 小时」「24 小时按小时」这类实时读数一律由**余额差值**算出——分辨率就等于余额刷新频率（默认 2 分钟）。余额是唯一的实时信号源。

**只配 API Key 也能用**：消费由本机余额差值推算（相邻两次采样余额下降即消费、上升即充值），但挂件没运行的时段补不回来，整段差额会并入下一次采样那天——刚装上时「近 7 天 / 本月」会偏少，跑几天才准。配了平台令牌就改用官方账单口径，立刻有完整历史（含上月，用于补全近 30 天）。

### 火山方舟（Coding Plan / Agent Plan 配额）

两个接口都是**控制面 OpenAPI**（`open.volcengineapi.com`，不是推理域名 `ark.cn-beijing.volces.com`），强制**火山引擎签名 V4（AK/SK）**——复用推理用的 Bearer API Key 会被网关拒。

| 套餐 | Action | 返回 |
|---|---|---|
| Coding Plan | `GetCodingPlanUsage` | **只有百分比**，拿不到「已用 / 总量」 |
| Agent Plan | `GetAgentPlanAFPUsage` | 有绝对值：已用 / 总量 / 重置时间 |

两边都是三条窗口（5 小时 / 周 / 月），额度按**调用次数**计——不是 token，也不是 GLM 那种积分。

**「套餐」那一栏什么时候要改**：默认「自动识别」——先查 Coding Plan，没订阅再退到 Agent Plan，一个账号配一次就不用管了。同一个账号**两种都订阅了**时，自动识别只显示 Coding Plan（面板脚注会提示），这时**再加一个账户**、填同一对 AK/SK，把套餐固定成 Agent Plan——一个账户盯一种套餐，互不干扰。

**两个接口都不给窗口开始时间**，只给下次重置时间，所以进度条上那条「预期进度」的斜纹段是由「重置时间 − 窗口长度」倒推的。网络错误、限流、权限不足时**不会**去试另一种套餐（那会把「查不到」误报成「没订阅」），只有明确返回「未订阅」才会回退。

### OpenAI Codex（ChatGPT 订阅套餐的额度）

数据来自 `GET https://chatgpt.com/backend-api/wham/usage`——Codex CLI 的 `/status` 和网页 Settings → Usage 用的就是它，只读、不调模型、不耗额度。**这是 ChatGPT 的内部接口**，没有公开文档，OpenAI 改版时可能短暂失灵。

**凭据只用 `access_token`**（auth.json 里 `tokens.access_token`，整份粘进来会自动取它；`ChatGPT-Account-Id` 从这个 JWT 里读）。**刻意不用 `refresh_token` 续期**：它是一次性的，用一次就轮换——挂件在你的 PC 上拿复制来的 refresh_token 续期，会让服务器上 Codex 手里那份当场作废、被迫重新 `codex login`。代价是 access_token 约 **10 天**过期：面板脚注显示剩余天数，剩不到 2 天弹一次提醒；到时去那台机器上跑一次 `codex`（它会自己续期），再把 auth.json 粘过来。「读本机」来源每次拉取都重读文件，跟着本机 Codex CLI 的续期走，不用管过期。

**窗口按长度认，不按位置认**：2026 年年中改版后 `primary_window` 从 5 小时变成了周、`secondary_window` 变成 null，免费号还见过 30 天窗口。接口给了哪几条就显示哪几条（Plus 目前只有周），没给的整块藏掉；按模型单列的额外限额（如 GPT-5.3-Codex-Spark）与代码审查额度写在面板脚注里。

PC 上访问 chatgpt.com 要走代理的话不用另配：请求走 Electron 的网络栈，用的是系统代理设置。

**胶囊上那格只有两行**：`5h` 和 `周` 带进度条，`月` 只给数字跟在「周」那一行后面——三条窗口排三行会把行距压扁，还会把整枚胶囊顶高（比 GLM / DeepSeek 那两格高出一截）。月额度涨得慢，条形给不出更多信息，数字够用；万一看得出「月超预期」，那个数字会变琥珀。要看完整的一条去面板。

## 隐私

凭据只存在本机 `%APPDATA%\GLM 用量挂件\config.json`，明文不出主进程（界面只用尾号回显）；请求直连上述官方域名，不经任何第三方。

## 开发

```bash
npm install             # 已配 npmmirror 镜像
npm start               # 本地运行（F12 开 DevTools）
npm run test:usage      # GLM 数据层（真实 token 走 GLM_TOKEN 或 /tmp/glm_token）
npm run test:deepseek   # DeepSeek 数据层（真实联测走 DS_API_KEY）
npm run test:volc       # 火山方舟签名与解析（签名对官方 Python SDK 的黄金向量）
npm run test:codex      # OpenAI Codex：auth.json 提取 / 窗口归槽 / 过期提醒（全 mock，不连网）
npm run test:providers  # provider 注册表与各家实现（全 mock，不连网）
npm run test:main       # 主进程集成：桩掉 electron 真实加载 main.js，验迁移/CRUD/窗口尺寸联动
npm run test:renderer   # 渲染层交互（需 python3 + playwright）
npm run test:drag       # 拖拽几何
npm run test:dock       # 贴边吸附几何（多屏接缝 / 任务栏 / 负坐标）
npm run test:dock-metric # 圆圈百分比口径与圆环连续配色
npm run test:artifacts  # 打包钩子：在临时目录真打一份 zip，验里面套了 GLM-Usage-Widget/ 一层
npm run icon            # 重新生成图标
python3 tools/shots.py  # 重新生成 README 主图（假数据）
npm run dist:win        # 打包 Windows 安装版 + 便携版（Linux 上出安装版需要 wine）
```

> 真实凭据一律走环境变量（`GLM_TOKEN` / `DS_API_KEY` / `/tmp/glm_token`），代码与测试里不出现明文。

**目录**

```
main.js               主进程：窗口 / 托盘 / 定时刷新 / 通知 / 配置 + 按账户的刷新与轮询编排
preload.js            contextBridge 桥（含账户 CRUD）
lib/providers/        ★ provider 注册表：meta.js（凭据声明 / 强调色 / 专栏兜底宽度，双端共用）
                        + glm.js / deepseek.js / volc.js / codex.js 实现 + quota-alerts.js（配额型共用提醒）
                        + index.js
lib/usage.js          GLM 配额请求与解析（纯 Node，可独立测试）
lib/volc.js           火山方舟签名 V4 + 两种套餐的请求与归一化（纯 Node，可独立测试）
lib/codex.js          OpenAI Codex 用量接口 + 本机 auth.json 读取 + 窗口按长度归槽（纯 Node）
lib/deepseek.js       DeepSeek 余额 + 平台账单两条链路
lib/tokens.js         各家凭据的提取规则（UMD，主进程与渲染层共用）
lib/ds-history.js     余额差值历史：样本抽稀、逐日 / 逐小时聚合、实时读数（按账户分桶）
lib/format.js         万 / 千分位 / 倒计时 / 金额 / token 格式化（双端共用）
lib/drag.js           拖拽几何（主进程独占光标坐标系）
lib/dock.js           贴边吸附几何（松手判定 / 落点，纯函数）
lib/dock-metric.js    圆圈口径与圆环配色（双端共用；OKLab 连续插值）
renderer/logos.js     各家 provider 的内联 logo（LobeHub Icons，MIT）
renderer/             app.js 编排（贴边列的圆圈由它画）+ panes.js（各 provider 的胶囊列 / 面板视图）+ settings.js（账户管理）
tools/                图标生成 / 主图生成脚本
```

**加一家新 provider**：`meta.js` 加一条元数据 → `lib/providers/<id>.js` 写 fetch 实现 → `index.js` 注册一行 → `lib/dock-metric.js` 的 `METRICS` 里加该家的一条（不配的话，贴边圆圈取不到口径、只画底环；`percentOf` 会返回 null）→ **在 `renderer/panes.js` 加一个工厂并注册进 `window.PANES`**。设置页分段、账户管理、面板页签、阈值提醒（`lib/providers/quota-alerts.js`）、凭据剪贴板识别都自动出现，`main.js` 不用改（只有托盘提示那一处是按 provider 写的 if/else，要补一支）。

> **没有「通用视图」兜底**：`window.PANES` 里缺了这一家，页签和设置页都在，但胶囊上不会出现这一列、面板里是空的。另外元数据与实现要**同一次落地**——渲染层读的是未经注册表过滤的元数据，只加 meta 会多出一个点了报「未知 provider」的「＋ 添加账户」按钮。

现成的四家可以直接抄：`glm.js`（最简：百分比配额）、`volc.js`（AK/SK 签名 + 三个窗口 + 枚举型凭据字段）、`codex.js`（跨字段校验 `validate` + 读本机文件 / 粘贴两种来源）、`deepseek.js`（两条链路各自降级 + 余额高频采样）。

**打包的两个收尾钩子**（`build/`）：`afterPack.js` 裁掉用不到的运行时组件（dxcompiler / dxil / elevate）；`afterArtifacts.js` 把 Windows 的 zip 重打成「解压一层 `GLM-Usage-Widget/` 文件夹」并改名 `-win64.zip`——electron-builder 26 的 zip 目标在 Windows 上写死了不套目录（`ArchiveTarget.js` 里的 `withoutDir = !isMac`），只能在产物出来后用自带的 7za 按同一套参数重打一遍。

**排查**：日志和配置都在 `%APPDATA%\GLM 用量挂件\`（托盘 / 胶囊右键 →「打开日志文件夹」直达）。`main.log` 记了启动链路、每次 IPC、刷新结果和渲染层报错（环形截断 256KB），反馈问题直接贴它就行。
