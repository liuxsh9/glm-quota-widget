# GLM 用量挂件 · glm-quota-widget

[![Release](https://github.com/liuxsh9/glm-quota-widget/actions/workflows/release.yml/badge.svg)](https://github.com/liuxsh9/glm-quota-widget/actions/workflows/release.yml)
[![Download](https://img.shields.io/github/v/release/liuxsh9/glm-quota-widget?label=%E4%B8%8B%E8%BD%BD)](https://github.com/liuxsh9/glm-quota-widget/releases/latest)

Windows 桌面悬浮挂件：一屏盯住 **GLM Coding Plan 的 5 小时/周额度** 与 **DeepSeek 官方 API 的余额/消费**。

- **平时隐身**：屏幕角落一枚 188×40 双列迷你胶囊（左 GLM 两条进度条、右 DeepSeek 余额+今日消费；只配一家时自动收窄到 152），可拖到任意位置、始终置顶
- **点击展开**：暗夜玻璃风面板，顶部 **GLM / DeepSeek 页签**切换
  - GLM：大数字百分比、积分用量、重置倒计时
  - DeepSeek：账户余额、今日/近 7 天/本月消费、消费柱状图（**1 小时按 5 分钟** / 24 小时按小时 / 7 天 / 30 天，四档）、近 1 小时消费、日均与预估可用天数、本月 token 与缓存命中率（后两项收在「?」里）
  - **两个页签同高**：切换时窗口尺寸一个像素都不动，不跳
  - **金额默认打码**：屏幕上过一眼看不到价格，点余额才显示（不写盘，重启回到打码态）
- **峰谷时段徽标**：两个视图各有一枚低饱和小徽标，一眼看出当前是**高峰**还是**空闲**（两家规则不同，见下）；具体时段与折扣在悬停提示里，不加动效、不抢注意力
- **预期进度 + 超预期提醒**：进度条上的斜纹「幽灵段」= 按时间均摊此刻应已用的量；实际用量一旦**超过**它，超出那一段直接标红、整机转琥珀，可关
- **阈值可配置**：提醒阈值默认 80%（1–99 任填），同时决定「变琥珀」和系统通知；再高 10 个点变红
- **防限流**：默认 10 分钟自动刷新（带 ±20s 随机抖动），托盘/面板可手动刷新（30 秒内去重），429 自动退避
- **托盘常驻**：动态图标（圆环=5h 用量，颜色随水位变化）+ 右键菜单，关窗口不退出
- **背景自适应主题**：截屏采样挂件四周明暗——深色背景用暗夜玻璃，浅色背景（如资源管理器最大化）自动切浅色玻璃；可在设置里强制深色或浅色

## 数据来源

### GLM（配额百分比）

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Authorization: <API Key 或 bigmodel_token_production 的 JWT>   # 无 Bearer 前缀
```

与智谱官方插件 [glm-plan-usage](https://github.com/zai-org/zai-coding-plugins) 同源的官方接口。推荐用控制台创建的 **API Key**（形如 `xxxx.xxxx`，长期有效）；Cookie JWT 约 3 天失效。

返回 `limits[]` 两条 `CREDIT_LIMIT`：有 `unit`/`number` 字段时按窗口时长区分（3=小时×number → 5h 额度，6=周 → 周额度），老响应缺字段时退回「`nextResetTime` 早的是 5 小时额度」。

### DeepSeek（余额 / 消费）

两条**互相独立**的链路，各配各的、各降各的级：

| 链路 | 凭据 | 有效期 | 拿到什么 | 刷新频率 |
|---|---|---|---|---|
| 余额（`GET api.deepseek.com/user/balance`） | 官方 **API Key**（`sk-…`） | 长期 | 账户余额、充值/赠送拆分、账户可用性 | **单独每 2 分钟**（可在设置里调 1/2/5/10 分钟或关闭） |
| 精确账单（`platform.deepseek.com/api/v0/usage/*`） | 平台 **userToken**（选配） | 短，会过期 | 逐日消费、本月账单、逐模型 token 与缓存命中率 | 跟随主刷新频率（默认 10 分钟） |

**实时性**：平台账单最细只到「天」，所以「近 1 小时」「最近 5 分钟」「24 小时按小时」这类读数一律由**余额差值**算出——
分辨率就等于余额刷新频率（默认 2 分钟）。余额是唯一的实时信号源。

图表四档对应四种粒度：**1 小时 → 5 分钟一根**（12 根）、24 小时 → 1 小时一根、7/30 天 → 一天一根。
把「余额刷新频率」调到 5 分钟以上时，最细那档的点会变稀（每根柱子要至少一次采样才画得出来）。

**只配 API Key 也能用**：消费数字由本机**余额差值**推算——每次刷新记一条 `(时间, 余额)`，
相邻两点余额下降即消费、上升即充值（不计入消费）。局限：挂件没运行的时段补不回来，
整段差额会并入下一次采样那天，所以刚装上时「近 7 天/本月」会偏少，跑几天才准。

**配了平台 userToken** 则改用官方账单口径，立刻有完整历史（含上月，用于补全近 30 天），
但该令牌是平台登录态，随时可能失效——失效只降级这一路，余额与差值口径照常工作。

- 账单接口是平台**私有**接口（非官方公开契约），字段可能随官网改版变化；解析失败时挂件只降级、不崩
- 平台按 **UTC 日界**切天，界面已标注；请求频率跟随刷新间隔（默认 10 分钟），远低于社区建议的 60 秒下限
- 两个 provider 的错误状态互不影响：GLM 的 Token 失效不会挡住 DeepSeek，反之亦然

### 峰谷时段（两家规则不同，均以北京时间 UTC+8 为准）

| | 高峰时段 | 空闲时段的优惠 |
|---|---|---|
| **DeepSeek** | 周一至周五 **09:00–12:00、14:00–18:00** | 价格 = 高峰的**一半**（官方文档原文：空闲时段价格为高峰时段价格的一半；周末全天按低谷价） |
| **GLM Coding Plan** | 周一至周五 **14:00–18:00** | 按**更低的积分系数**抵扣；具体倍率随模型而变（官方文档：GLM-5.3「非高峰 1 倍 / 高峰 3 倍」，GLM-5.3-Flash「0.4 倍 / 1.2 倍」），因此界面上只报时段、不写死折扣 |

其余时间（含两家各自的周末全天）都是空闲时段。注意 **GLM 的高峰是 DeepSeek 的子集**：工作日上午 9–12 点只有 DeepSeek 贵。

### 隐私

所有凭据只保存在本机 `%APPDATA%\GLM 用量挂件\config.json`，明文不下发给渲染层（界面只用尾号回显）；
请求直连上述官方域名，不经任何第三方。

## 安装（开箱即用）

到 [Releases](https://github.com/liuxsh9/glm-quota-widget/releases/latest) 下载（推 tag 自动构建），三选一：

| 文件 | 说明 |
|---|---|
| `GLM-Usage-Widget-x.y.z-win64.zip` | **推荐 · 目录版**：解压一次到任意文件夹，双击 `GLM-Usage-Widget.exe`，约 1 秒启动 |
| `GLM-Usage-Widget x.y.z.exe` | 便携版：单文件 ~80MB，即拷即用，但**每次启动都要自解压到临时目录，冷启动需 5~20 秒**，适合 U 盘应急 |

安装版（NSIS Setup，带桌面快捷方式/开机自启）需在 **Windows 机器**上执行 `npm install && npm run dist:win` 生成（Linux 交叉构建安装版需要 wine）。
注意：**便携版不支持开机自启**（每次解压到临时目录，注册路径无效，设置里会自动置灰）；需要自启请用安装版或目录版 + 手动放启动项。

## 使用

1. 首次启动：胶囊显示「◈ 点击设置 Token」→ 点击进入设置
2. **GLM（推荐）**：登录 [bigmodel.cn](https://www.bigmodel.cn/coding-plan/personal/overview) → 控制台「API Keys」→ 创建/复制 API Key（长期有效，一劳永逸）
3. **GLM（备选）**：F12 → Application → Cookies → 复制 `bigmodel_token_production` 的值（或整段 Cookie，约 3 天失效）
4. **DeepSeek（余额）**：[platform.deepseek.com](https://platform.deepseek.com) → 「API Keys」→ 创建/复制 `sk-` 开头的 Key
5. **DeepSeek（精确账单，选配）**：同一站点 F12 → Application → Local Storage → 找到 `userToken` → 复制整段值
6. 粘贴到设置页对应输入框 → **保存并刷新**（剪贴板里有凭据时会自动提示一键填入）

设置页按归属分三段，内容可滚动，每段内部再按小节分组：

| 段 | 放什么 |
|---|---|
| **GLM Coding Plan** | 凭据、状态、获取指引；**配额提醒**（阈值 / 重置提醒 / 超预期变色）；官网入口 |
| **DeepSeek 官方 API** | 两个凭据与各自状态、获取指引、用量页入口 |
| **通用** | 刷新频率 + DeepSeek 余额高频采样、界面主题、开机自启、窗口置顶 |

**保存行为**：开关和下拉**改完立即生效并保存**（右上角会闪一下「✓ 已保存」）；
只有凭据输入框需要显式点「保存并刷新」——按钮在**设置页右上角**和**页面底部**各有一个，改完凭据不用翻到底。

**关于「两个刷新频率」**：主频率（默认 10 分钟）伺候 GLM 配额与 DeepSeek 平台账单——这两个接口一个有限流、一个是私有接口，不适合更快；
DeepSeek **余额**是官方公开接口，可以单独高频采（默认 2 分钟），界面上的「最近 5 分钟」「1 小时柱图」靠它。
所以它做成主频率下的一个**从属开关**，关掉就跟随主频率（此时细粒度柱图会变稀）。

快捷操作：胶囊**单击**=展开面板，**右键**=菜单，**拖动**=换位置（主进程按光标锚点定位，缩放屏上同样跟手）；展开态**拖动任意处**=移动、**点空白处**=收起、**Ctrl+滚轮**=等比缩放（80%–160%，Ctrl+0 复位），`Esc`=收起；托盘左键=展开/收起；面板顶部页签切换 GLM / DeepSeek 视图。

## 开发

```bash
npm install          # 已配置 npmmirror 镜像
npm start            # 本地运行（F12 开 DevTools）
npm run test:usage   # GLM 数据层（需 /tmp/glm_token 或 GLM_TOKEN 放真实 token；有 ANTHROPIC_AUTH_TOKEN 时附带 API Key 鉴权联测）
npm run test:deepseek# DeepSeek 数据层：凭据提取/余额解析/账单信封/差值聚合 + 真实余额联测（DS_API_KEY）
npm run test:main    # 主进程集成测试：桩掉 electron 真实加载 main.js，验状态结构、双 provider 并行、配置钳制
npm run test:renderer# 渲染层交互测试（需 python3 + playwright）
npm run test:drag    # 拖拽引擎测试（模拟缩放屏下的光标跟随与窗口尺寸漂移）
npm run icon         # 重新生成图标
npm run dist:win     # 打包 Windows 安装版 + 便携版
```

真实凭据一律走环境变量注入（`GLM_TOKEN` / `DS_API_KEY` / `/tmp/glm_token`），代码与测试里不出现明文。

### 目录

```
main.js             主进程：窗口/托盘/定时刷新/通知/配置/多 provider 编排
preload.js          contextBridge 桥
lib/usage.js        GLM 配额请求与解析（纯 Node 可独立测试）
lib/deepseek.js     DeepSeek 余额 + 平台账单两条链路（同上）
lib/ds-history.js   余额差值历史：样本抽稀、逐日/逐小时聚合、实时读数（纯函数）
lib/format.js       万/千分位/倒计时/金额/token 格式化（主进程与渲染层共用）
lib/drag.js         拖拽几何（主进程独占光标坐标系）
renderer/           胶囊（双列）+ 面板（GLM/DeepSeek 两页签）+ 设置
tools/              图标生成
```

### 已知边界

- GLM：API Key 长期有效；Cookie JWT 由服务端会话决定有效期（约 3 天），挂件靠接口返回判定失效并提醒
- DeepSeek 余额是**账号级**的：同账号下所有 Key、所有客户端的消耗都算在同一份余额里
- DeepSeek 平台账单是**私有接口**（非官方公开契约），字段可能随官网改版变化；解析失败只降级这一路，
  且按 UTC 日界切天（与官网一致），「今日」在北京时间 08:00 前后会有一次跳变
- 未配平台令牌时消费靠余额差值推算，**挂件没运行的时段补不回来**（并入下一次采样那天）；
  历史样本保留 90 天，存在 `%APPDATA%\GLM 用量挂件\ds-history.json`
- 多显示器场景以主显示器工作区为定位基准；面板两个页签同高（326×270），切换不动窗口
- 「近 1 小时」「5 分钟柱」的分辨率 = 余额刷新频率（默认 2 分钟）；调到「关闭」或「跟主刷新（10 分钟）」时最细那档基本画不出东西

### 排查日志

数据与日志目录按 productName 命名：`%APPDATA%\GLM 用量挂件\`（托盘/胶囊右键菜单 →「打开日志文件夹」直达）。`main.log` 记录启动链路、每次 IPC 交互、刷新结果、渲染层报错（环形截断 256KB），反馈问题直接贴文件内容。
