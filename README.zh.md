<div align="center">

# DeepSeek Harness 移动端远程控制插件（dsh-mobile-remote）

[English](./README.md) | **简体中文**

[GitHub](https://github.com/feiyang-dev/dsh-mobile-remote) · [npm](https://www.npmjs.com/package/@feiyang666/dsh-mobile-remote) · MIT License

**由开发者制作的 DeepSeek Harness 插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness，同时提供移动端界面优化。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Platform](https://img.shields.io/badge/platform-web%20%26%20desktop-4d9fff)

</div>

---

## 简介

`dsh-mobile-remote` 是 DeepSeek Harness 生态的**移动端远程控制插件**（DSH plugin，Host + Client 双面一体包）。装好后在 WebUI **设置 → 远程控制** 出现一个管理面板：

- **移动端上传图片**（v1.5.0）：composer 工具行 **+ 加号旁新增「上传图片」按钮**，手机直接选图（系统相册 / 文件选择器）即可让 DeepSeek 识图模型识别——格式 / 数量 / 大小预检查、缩略图预览、随消息上传全部复用 DSH 原生链路，桌面端不受影响；
- **移动端侧栏默认收起**（v1.9.0）：窄屏下把侧栏轨道压到 0，内容区吃满整屏；左上角悬浮按钮点开为**覆盖式抽屉**（不挤压中栏），点遮罩 / Esc / 选中会话自动收起；
- **连接二维码**：自动生成 `http://<局域网IP>:<端口>` 的二维码，手机相机 / 浏览器扫码即连；
- **裸地址直达，自动登录**（v1.8.0）：直接访问裸地址 `http://192.168.x.x:3080`（不带任何 token）即可自动进入——服务端自动完成新版 dsh 的浏览器会话认证（`≥0.1.2-rc.1`），无需复制带 `?token=` 的长链接；老版 dsh 自动回退，行为不变；
- **开启 / 关闭开关**（v1.9.0 重做）：在局域网网卡上**旁挂一个转发听众**（`<局域网IP>:<端口>` → `127.0.0.1:<端口>`），dsh 自身的监听地址与端口**完全不动**——本机窗口、桌面端、会话都不会被打断，开关**即时生效、无需重启、不写配置**；
- **当前连接的设备数量**：移动端心跳上报，实时统计在线设备数；
- **远程访问密码门禁**（v1.2.0+）：管理员本机设置密码，外网隧道访问进入页面需先输密码，本机/局域网不受影响；
- **远程访问提速**（v1.2.0+）：frpc 连接池调大，缓解外网访问首屏转圈慢；
- **更丰富的数据展示**（v1.4.0）：设备列表可点击展开完整上报信息（系统 / 浏览器 / 屏幕 / 视口 / DPR / 设备内存 / CPU 核数 / 电池 / 网络 / 当前页面 / 首次连接 / 心跳次数）；「运行时信息」卡（运行时长 / 开机时长 / Node 版本 / PID / CPU 型号与核数 / 系统负载 / 内存使用率 / RSS / 堆内存）；**「DSH 状态」卡**（dsh 版本 / 会话总数 / 工作区列表 / 已安装插件 / 模型提供方，后台缓存）；「网络接口」卡（网卡名 / IP / 掩码 / MAC）；外网隧道详情（域名 / 端口 / frpc 版本 / PID / 运行时长 / 脱敏绑定码 / 日志查看）；
- **外网隧道真实状态**（v1.4.1）：不再"假在线"——面板探测 frpc 日志确认隧道真正建立，断线重连降级「连接中」，token 鉴权失败显示红色「出错」+ 精确原因（如 `token in login doesn't match`）+ 一键重试；中转端 `FRP_TOKEN` 占位符时显示黄色警告条；隧道持续心跳保活，让中转端在线状态真实可靠；
- 局域网地址列表、手机访问地址、配置位置一目了然。

**核心卖点：纯命令行用户无需安装桌面端。** 官方 CLI 出于安全拒绝 `--host 0.0.0.0`；而 dsh **0.2.1-rc.3 起连 patch 层也不再接受通配地址**（`host: '0.0.0.0'` 会在配置校验阶段直接让进程退出），改绑具体网卡又会让本机回环监听消失（桌面端窗口白屏）。所以 v1.9.0 改用**旁挂 LAN 听众**：dsh 保持只听回环，插件在局域网网卡上再监听一份并转发过去——手机与电脑仍共享同一个后端进程与同一份 `~/.dsh` 数据，**会话列表、历史记录、工作区、设置全部天然双向同步，无需任何数据复制**。

---

## 远程访问密码（可自定义，通用自托管）

为了让「远程（外网隧道）访问」更安全，插件内置**远程访问密码门禁**：

- 在 **设置 → 远程控制** 面板的「远程访问密码」卡片中，管理员可**在本机设置 / 修改 / 清除**一个密码；
- 设置后，任何**通过外网隧道（`*.dsh.xxx.top`，HTTPS 反代）**访问本机 DSH 的浏览器，进入页面时都会被全屏密码页拦截，**必须输入正确密码**才能使用；本机（`127.0.0.1`）与局域网直连访问不受影响，保证管理员始终能正常管理与修复；
- **密码完全存储在插件本地**（`~/.dsh/plugins/dsh-mobile-remote/config.json`），只保存 `scrypt` 哈希 + 随机盐，**绝不落盘明文**，校验使用 `timingSafeEqual` 防时序攻击，登录带失败次数限制防爆破。

> **关键设计：完全本地、不依赖任何中转后端。** 无论你是否使用本项目自带的 `dsh-update-server` 中转服务，还是自建其它 frp / 中转方案，密码机制都能直接使用——它对任意「远程 HTTPS 访问」生效，与中转服务解耦。

---

## 中转服务端（dsh-update-server）接口

插件外网隧道状态使用中转服务器的**成员端**接口（无需管理员登录）：

- `GET /api/tunnel/status` — 基础成员状态（名称 / 在线 / 端口 / 最后心跳）；
- `GET /api/tunnel/stats` — **成员隧道实时统计**（本次新增，需升级中转服务端）：含基础字段，并带 **frps 实时详情** —— 今日上行 / 下行流量、当前连接数、本地转发端口、隧道启动时间。

插件会**先请求 `/stats`，后端未升级时自动回退到 `/status`**，所以旧后端不会导致面板异常。

> 需将以下文件部署到你的中转服务器并重启服务：`src/routes/tunnel.js`、`src/tunnel-service.js`。

## 远程访问性能优化

远程（外网隧道）访问比内网慢的常见根因是：DSH 首屏会同时发起大量并发请求（JS/CSS / API / WebSocket），而 frp 隧道默认的工作连接池（`poolCount`）过小，导致 frpc 反复报 `work connection pool is full, discarding`，大量连接被丢弃、排队重试，表现为首页一直转圈。

本插件做了以下优化：

- **frpc 连接池调大**：生成的 `frpc.toml` 为每个 `[[proxies]]` 注入 `poolCount = 20`（可用环境变量 `DSH_FRPC_POOL_COUNT` 覆盖）；
- **服务端配套**：`dsh-update-server` 的 `deploy/frps.toml` 模板将 `transport.maxPoolCount` 调大到 `64`（需部署到中转服务器后生效），避免服务端限制客户端连接池。

---

## 界面预览

### 设置 → 远程控制

打开「设置 → 远程控制」可以看到：开关与状态徽标、连接二维码、局域网地址列表、已连接设备
（可展开查看系统 / 浏览器 / 屏幕 / 网络等完整信息）、运行时信息、DSH 状态、网络接口、
远程访问密码、外网隧道（域名 / frpc 版本 / 日志）。

## 推荐安装方式

> 两个方法任选其一，效果等价。**推荐使用桌面端**，全程图形化、无需命令行。

### 方式一（推荐）：桌面端一键安装

安装 [DeepSeek Harness 桌面版](https://github.com/feiyang-dev/DeepSeek-Harness-Desktop)，打开后点击 **「安装插件」→ 推荐插件 → 移动端远程控制 → 一键安装**，完成后点 **「立即重启服务」** 即可生效。

### 方式二：命令行安装

```bash
# 前提：已安装 dsh（npm install -g @deepseek-ai/dsh）
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

装完重启 dsh web 服务即可。

### 方式三：从本地 tarball 安装（未发布 / 离线 / 自测用）

当插件尚未发布到 npm（或 npm 发布受 2FA、暂存审批阻塞），可直接从本地源码安装：

```bash
# 在插件仓库根目录执行：自动 npm pack 并装进指定 profile（默认 desktop）
node scripts/install-local.mjs              # 装到 desktop
node scripts/install-local.mjs desktop web   # 装到多个 profile
```

脚本会：打包 → 按 profile 的包管理器安装（有 `pnpm-workspace.yaml` 用 pnpm，否则用 npm）
→ 把包名注册进 `dsh.profile.bundles` → 回读校验版本与关键文件，避免「假成功」。

> 也可在桌面端「安装插件」里直接选择本地 `.tgz` 文件，效果等价。
>
> 安装后 profile 的 `dependencies` 会写成 `file:...tgz`。这是有意为之：
> 在插件发布到 npm 之前，依赖若写成 `^1.7.1` 之类的范围，后续 `npm install`
> 会从 registry **降级**到旧版本。

### 开发期快速热同步（改代码后免打包）

只改前端 `lib/client.js` 时，可用 `sync-to-profile.mjs` 直接覆盖已装目录，刷新浏览器即生效：

```bash
node sync-to-profile.mjs                 # 默认 profile: web
DSH_PROFILE=desktop node sync-to-profile.mjs
```

注意：`lib/index.js` / `lib/external.js` / `lib/patch.js` 属 host 侧代码，有模块缓存，
**必须重启 dsh 服务**才生效。

---

## 使用步骤

1. 启动 dsh（任意方式：桌面端 / `npx @deepseek-ai/dsh web` / 源码模式）。
2. 电脑浏览器打开 `http://127.0.0.1:3080` → **设置 → 远程控制**。
3. 点击开关**开启**（无需重启，HMR 热重载生效）。
4. 手机与电脑连**同一 Wi-Fi**，用相机 / 浏览器**扫码**或访问局域网地址。
5. 手机端即显示电脑端的会话列表、历史记录、工作区、设置等全部数据，可直接发消息操控电脑端执行。

### 纯命令行启动（无需桌面端）

```bash
# 方式一：直接使用设置页开关（推荐）
dsh --profile web
# 然后打开 http://127.0.0.1:3080 → 设置 → 远程控制 → 开启

# 方式二：手动 overlay（启动时传参）
dsh --profile web --patch remote-control.patch.yml
```

> **注意（dsh ≥ 0.2.1-rc.3）**：**不要**再手写
> `- id: webserver` + `host: '0.0.0.0'` 的 overlay——新版会在配置校验阶段直接报错退出；
> 改成具体网卡 IP 又会顶掉本机 `127.0.0.1` 的监听（桌面端窗口随之打不开）。
> v1.9.0 起「对局域网开放」由插件自己的旁挂听众完成，**不需要任何 overlay**，
> 用方式一（设置页开关）即可。

> **安全提示**：开启后服务暴露到局域网，请仅在可信的家庭 / 办公网络使用，**不要暴露到公网**。

---

## 这个包是什么

一个 npm 包 = **host 半**（Node 侧 Cordis 插件，提供 `/__dsh_remote/*` API、patch 文件管理、心跳设备计数、index.html 注入，见 `lib/index.js`）+ **client 半**（浏览器侧设置面板，见 `lib/client.js`，通过 `/__dsh_remote/status` 等与 host 通信）。

包通过两处声明接入 DSH：

| 声明 | 作用 |
| --- | --- |
| `dsh.bundle.patch`（`cordis.patch.yml`） | 让 DSH 把它识别为**标准 bundle 插件包**：`dsh plugin --profile <名> add <包名>` 一条命令即可安装并自动接线，无需手改任何配置文件 |
| `dsh.client` + `exports["./client"]` | 让 web 客户端在 `/plugins/<包名>/client.js` 自动加载设置页面板 |

所以对使用者来说，**安装就是一条命令**，不用碰 YAML、不用手动复制文件。

---

## 工作原理

| 层 | 文件 | 职责 |
| --- | --- | --- |
| host | `lib/index.js` | `/__dsh_remote/status` / `toggle` / `heartbeat` / `qr` API；心跳设备计数；index.html 注入 |
| lanproxy | `lib/lanproxy.js` | 局域网旁挂听众：`<LAN IP>:<端口>` → `127.0.0.1:<端口>`，HTTP + WebSocket 转发 |
| patch | `lib/patch.js` | profile `cordis.patch.yml` 受管区域（**只写 `connection.trustedHosts`**，绝不写 webserver）与旧配置迁移 |
| client | `lib/client.js` | 注册 `settings.section`「远程控制」面板（开关 / 二维码 / 设备数） |
| qrcode | `lib/qrcode.js` | 内联 MIT QR 生成器（`qrcode-generator`），零运行时依赖 |

- **开关**：`POST /__dsh_remote/toggle` → 在局域网网卡上开启 / 关闭旁挂听众。请求被转发到 `127.0.0.1:<端口>`，并把 `Host` / `Origin` 改写成回环 authority（dsh 的信任围栏对回环一律放行），因此**不需要改 dsh 任何配置、也不需要重启**。
- **设备数**：移动端注入 JS 每 30s 心跳上报，host 维护活跃设备表（90s 过期）。每次心跳会上报完整设备元数据（屏幕 / 视口 / DPR / 网络 / 当前页面 / 语言 / 平台），设置面板的设备行可展开查看。
- **二维码**：`GET /__dsh_remote/qr?url=...` 返回 SVG。
- **移动端适配**：`tapIndex` 注入移动端 CSS/JS，composer 输入栏窄屏换行、选择器限宽、iOS 输入框 16px 防缩放、**加号旁注入「上传图片」按钮**（文件选择器选图 → 复用 DSH 原生 paste/drop intake 链路）；
- **移动端侧栏**（v1.9.0）：窄屏下侧栏轨道压到 `0px`，内容区吃满整屏；左上角悬浮按钮唤出**覆盖式抽屉**（半透明遮罩，点遮罩 / Esc / 选中会话自动收起）。仍复用原生 toggle 按钮驱动官方 store，只把「挤压中栏」改写成「浮层」，因此原生 aria / 快捷键 / 状态一致；框架节点用 `data-dsh-mobile-frame` 标记，不依赖 harness 哈希类名；
- **移动端设置页适配**（v1.4.2+）：原生设置弹窗在手机上自动变为全屏单栏——导航栏变顶部横向滚动标签、内容区占满剩余空间；同时抑制触屏上常驻的原生 Tooltip 气泡（如「停止 / 开始 / 关闭菜单栏」提示文字）。通过结构标记识别设置弹窗，**不依赖 harness 内部哈希类名**，harness 升级后无需修改插件即可直接适配。**v1.4.3** 修复该单栏布局——面板原本仍是横向 `flex`，内容列被压成 0 宽度（内容空白）且无法上下滚动；现强制 `flex-direction: column` + `min-height: 0`，设置选项区在手机上可正常滚动。并新增**内网（非安全上下文）`crypto.randomUUID` 兜底**：当前 DSH 客户端在连接时直接调用 `crypto.randomUUID()`，该 Web Crypto API 仅在 HTTPS / localhost 存在，内网 http 直连会报 `crypto.randomUUID is not a function` / `settings are unavailable in this browser`；插件注入的头部脚本用 `getRandomValues` 补一个 RFC 4122 v4 实现，内网访问 / 扫码连接恢复正常。

---

## 安装（给使用者）

### 0. 前提条件

- 已安装 DeepSeek Harness（`npm install -g @deepseek-ai/dsh` 全局安装，或使用基于它的桌面应用 / `npx @deepseek-ai/dsh web`）。
- 确保 `dsh` 命令在 PATH 里（桌面应用自带环境则在其终端中执行）。

### 1. 一条命令安装

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

这条命令会做三件事（全部自动）：

1. 在 `~/.dsh/profiles/web` 里通过 pnpm 安装本包（首次使用会自动初始化该 profile）；
2. 检测到包的 `dsh.bundle` 声明，自动把包名写进 profile 的 `dsh.profile.bundles` 层列表；
3. 重启后，DSH 启动时会自动读取包内的 `cordis.patch.yml`，把插件行挂进应用树——**不需要**手动编辑任何配置文件。

其它 profile 同理，把 `web` 换成你的 profile 名即可（如 `dsh plugin --profile headless add ...`）。

> 想用本地 tarball 测试：`dsh plugin --profile web add C:\path\to\feiyang666-dsh-mobile-remote-1.4.3.tgz`

### 2. 重启并验证

重启 DeepSeek Harness 的 web 应用（命令行：结束旧进程后重新运行 `dsh web`；桌面应用：完全退出后重新打开）。然后：

- 刷新 http://127.0.0.1:3080 → 设置 → 应出现 **「远程控制」** 面板。

---

## 卸载

```bash
dsh plugin --profile web remove @feiyang666/dsh-mobile-remote
```

然后重启应用即可。

---

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 设置里没有「远程控制」面板 | 插件未激活。确认 `cordis.patch.yml` 里的行存在且 `name` 正确；重启后刷新（清缓存） |
| 手机打开裸地址显示「authentication required / dsh web authentication required」 | 用的是 dsh `0.1.2-rc.1` 之前的老版插件，或服务端未加载本插件的 `/` 接管。确认已安装 v1.8.0+ 并**重启 dsh web 服务**（老版 dsh 无认证时按原行为返回 401 提示，可改用带 token 地址或升级 dsh） |
| 开启开关后手机还是连不上 | 确认手机与电脑同一 Wi-Fi；确认 Windows 防火墙放行 dsh 所用端口（`node.exe` 首次监听局域网时会弹窗）；确认访问的是「设置页显示的那个地址」。开启后 `127.0.0.1` 之外也能连，但 dsh 自身仍只听回环——这是设计如此 |
| 手机能访问但显示 403 | v1.9.0 已不会出现：旁挂听众会把 `Host`/`Origin` 改写成回环，dsh 信任围栏直接放行。若仍 403，说明你用的是旧版插件，或前面还套了一层反代且改写了 Host |
| 开启开关后电脑上的窗口打不开 / 白屏 | 旧版（≤1.8.1）把 `webserver.host` 改成 `0.0.0.0` 或局域网 IP，导致本机回环监听消失。升级到 v1.9.0 后启动会自动清理旧配置并把监听拉回回环 |
| 手动写了 `host: '0.0.0.0'` 的 patch，dsh 起不来 | dsh 0.2.1-rc.3 起拒绝通配地址（配置校验阶段直接退出）。删掉那块覆盖，改用本插件的开关即可 |
| 设备数为 0 | 手机端页面需打开过才会心跳上报；等待几秒刷新 |
| 二维码扫不出来 | 确认「远程控制」已开启；相机应用需支持扫码 |
| 外网访问被全屏密码页拦住 | 这是**远程访问密码门禁**（v1.2.0+）。管理员在本机「设置 → 远程控制 → 远程访问密码」输入正确密码即可进入；忘记密码需在本机重新设置 |
| 远程访问仍转圈很慢 | 确认中转服务器 frps 已应用 `transport.maxPoolCount = 64`（`deploy/frps.toml`），并重启 frps；重新开启一次外网访问以重建隧道（`DSH_FRPC_POOL_COUNT` 默认 20） |
| 面板红色提示「外网隧道鉴权失败」 | frpc 的 `auth.token` 与 frps 服务端不一致。请将中转 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 改成完全相同，重启 frps 与中转服务后，关闭再重新开启外网访问 |
| 外网隧道一直「连接中」不见好 | frpc 在断线后自动重连；点面板上的「查看 frpc 日志」看真实原因（服务器宕机 / 端口被墙 / token 不匹配） |
| 黄色警告条提示「FRP_TOKEN 仍是占位符」 | 中转 `.env` 的 `FRP_TOKEN` 还是占位符，必须改成与 frps.toml 一致的真实值，否则隧道永远起不来（502） |

---

## 相关项目

| 项目 | 说明 | 安装方式 |
| --- | --- | --- |
| [DeepSeek Harness 桌面版](https://github.com/feiyang-dev/DeepSeek-Harness-Desktop) | Windows 桌面控制台：一键安装/启动/停止/重启 dsh web 服务，内置插件管理，**推荐插件区一键安装本插件** | 下载桌面版，点几下即可 |
| [用量与消耗插件（dsh-usage-plugin）](https://github.com/feiyang-dev/dsh-usage-plugin) | 记录每次模型调用的 token 用量与消耗，支持峰谷计费、余额查询、日历热力图与 CSV / JSON / PNG 导出 | 桌面端一键安装，或 `dsh plugin add @feiyang666/dsh-usage-plugin` |
| [数据保险箱（dsh-vault）](https://github.com/feiyang-dev/dsh-vault) | 自动备份 / 清空检测 / 一键恢复，保护聊天记录与工作区数据 | 桌面端一键安装，或 `dsh plugin add @feiyang666/dsh-vault` |
| [DeepSeek-Harness](https://github.com/deepseek-ai/DeepSeek-Harness) | 官方 CLI / Web 服务 | 见下方「运行 DeepSeek Harness」 |

### 运行 DeepSeek Harness

**快速安装（通过 npm）**

安装 Node.js，然后运行：

```bash
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 http://127.0.0.1:3080。详见 [Web UI 指南](https://github.com/deepseek-ai/DeepSeek-Harness)。

**从源码运行**

如需从仓库源码运行：

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 许可

MIT © dsh-mobile-remote
