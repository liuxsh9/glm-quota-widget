# GLM 用量挂件 · glm-quota-widget

[![Release](https://github.com/liuxsh9/glm-quota-widget/actions/workflows/release.yml/badge.svg)](https://github.com/liuxsh9/glm-quota-widget/actions/workflows/release.yml)
[![Download](https://img.shields.io/github/v/release/liuxsh9/glm-quota-widget?label=%E4%B8%8B%E8%BD%BD)](https://github.com/liuxsh9/glm-quota-widget/releases/latest)

Windows 桌面悬浮挂件，实时显示 [GLM Coding Plan](https://www.bigmodel.cn/coding-plan/personal/overview) 的 **5 小时额度** 与 **周额度**。

- **平时隐身**：屏幕角落一枚 262×58 迷你胶囊（可拖到任意位置、始终置顶）
- **点击展开**：暗夜玻璃风面板，大数字百分比、积分用量、重置倒计时
- **防限流**：默认 10 分钟自动刷新（带 ±20s 随机抖动），托盘/面板可手动刷新（30 秒内去重），429 自动退避
- **Cookie 过期一站式处理**：挂件变红提示 → 点击直达设置 → 粘贴新 Cookie（自动从整段 Cookie 里提取 token，检测到剪贴板有新 token 会提示一键填入）
- **超额提醒**：5 小时用量 ≥ 80%（可调）系统通知，每个窗口周期最多提醒一次
- **托盘常驻**：动态图标（圆环=5h 用量，颜色随水位变化）+ 右键菜单，关窗口不退出
- **背景自适应主题**：截屏采样挂件四周明暗——深色背景用暗夜玻璃，浅色背景（如资源管理器最大化）自动切浅色玻璃；采样时机为启动/拖动后/展开/每轮刷新，可在设置里强制深色或浅色

## 数据来源

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Authorization: <bigmodel_token_production 的 JWT 值>   # 无 Bearer 前缀
```

返回的 `limits[]` 中 `nextResetTime` 较早的一条是 5 小时额度，较晚的一条是周额度。
Token 只保存在本机 `%APPDATA%/glm-usage-widget/config.json`，请求直连官方接口。

## 安装（开箱即用）

到 [Releases](https://github.com/liuxsh9/glm-quota-widget/releases/latest) 下载（推 tag 自动构建），三选一：

| 文件 | 说明 |
|---|---|
| `GLM-Usage-Widget-x.y.z-win64.zip` | **推荐 · 目录版**：解压一次到任意文件夹，双击 `GLM-Usage-Widget.exe`，约 1 秒启动 |
| `GLM-Usage-Widget x.y.z.exe` | 便携版：单文件 ~80MB，即拷即用，但**每次启动都要自解压到临时目录，冷启动需 5~20 秒**，适合 U 盘应急 |

安装版（NSIS Setup，带桌面快捷方式/开机自启）需在 **Windows 机器**上执行 `npm install && npm run dist:win` 生成（Linux 交叉构建安装版需要 wine）。
注意：**便携版不支持开机自启**（每次解压到临时目录，注册路径无效，设置里会自动置灰）；需要自启请用安装版或目录版 + 手动放启动项。

## 使用

1. 首次启动：胶囊显示「◈ 点击设置 Cookie」→ 点击进入设置
2. 浏览器登录 [bigmodel.cn](https://www.bigmodel.cn/coding-plan/personal/overview) → F12 → Application → Cookies → 复制 `bigmodel_token_production` 的值（或整段 Cookie）
3. 粘贴到设置框 → **保存并刷新**。之后 Cookie 失效时挂件会自动变红提醒，同样流程粘贴新值即可

快捷操作：胶囊**单击**=展开面板，**右键**=菜单，**拖动**=换位置（Windows 用系统原生拖拽，顺滑无迟滞）；展开态**拖动任意处**=移动、**点空白处**=收起、**Ctrl+滚轮**=等比缩放（80%–160%，Ctrl+0 复位），`Esc`=收起；托盘左键=展开/收起。设置页内置 5 步 Cookie 获取图文指引（F12 → 应用 → Cookie → 复制值）。

## 开发

```bash
npm install          # 已配置 npmmirror 镜像
npm start            # 本地运行（F12 开 DevTools）
npm run test:usage   # 数据层测试（需 /tmp/glm_token 或 GLM_TOKEN 环境变量放真实 token）
npm run test:renderer# 渲染层交互测试（需 python3 + playwright）
npm run icon         # 重新生成图标
npm run dist:win     # 打包 Windows 安装版 + 便携版
```

### 目录

```
main.js            主进程：窗口/托盘/定时刷新/通知/配置
preload.js         contextBridge 桥
lib/usage.js       API 请求与解析（纯 Node 可独立测试）
lib/format.js      万/千分位/倒计时格式化（主进程与渲染层共用）
renderer/          胶囊 + 面板 + 设置 三视图
tools/             图标生成
```

### 已知边界

- Token 由服务端会话决定有效期（约 3 天），挂件靠接口返回判定失效并提醒
- 多显示器场景以主显示器工作区为定位基准

### 排查日志

数据与日志目录按 productName 命名：`%APPDATA%\GLM 用量挂件\`（托盘/胶囊右键菜单 →「打开日志文件夹」直达）。`main.log` 记录启动链路、每次 IPC 交互、刷新结果、渲染层报错（环形截断 256KB），反馈问题直接贴文件内容。
