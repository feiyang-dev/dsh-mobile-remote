<div align="center">

# DeepSeek Harness 移动端远程控制插件（dsh-mobile-remote）📱

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

- **连接二维码**：自动生成 `http://<局域网IP>:<端口>` 的二维码，手机相机 / 浏览器扫码即连；
- **开启 / 关闭开关**：一键切换 webserver 监听地址（`0.0.0.0` ↔ `127.0.0.1`），经 dsh 官方 HMR 热重载**无需重启服务**；
- **当前连接的设备数量**：移动端心跳上报，实时统计在线设备数；
- 局域网地址列表、手机访问地址、配置位置一目了然。

**核心卖点：纯命令行用户无需安装桌面端。** 官方 CLI 出于安全拒绝 `--host 0.0.0.0`，但本插件通过 profile 的 `cordis.patch.yml`（或 `--patch <overlay>`）写入 `webserver.host: 0.0.0.0`——这正是桌面端「移动端远程控制」开关的实现方式。手机与电脑共享同一个 dsh 后端进程与同一份 `~/.dsh` 数据，**会话列表、历史记录、工作区、设置全部天然双向同步，无需任何数据复制**。

---

## 界面预览

### 设置 → 远程控制
![远程控制](./docs/assets/remote-control.png)

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

`remote-control.patch.yml`：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
```

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
| host | `lib/index.js` | `/__dsh_remote/status` / `toggle` / `heartbeat` / `qr` API；patch 文件读写；心跳设备计数；index.html 注入 |
| client | `lib/client.js` | 注册 `settings.section`「远程控制」面板（开关 / 二维码 / 设备数） |
| qrcode | `lib/qrcode.js` | 内联 MIT QR 生成器（`qrcode-generator`），零运行时依赖 |

- **开关**：`POST /__dsh_remote/toggle` → 写入 / 移除 profile `cordis.patch.yml` 的 `webserver` 覆盖块 → dsh `watchUserPatches`（Cordis HMR）热重载 webserver 行重新监听。
- **设备数**：移动端注入 JS 每 30s 心跳上报，host 维护活跃设备表（90s 过期）。
- **二维码**：`GET /__dsh_remote/qr?url=...` 返回 SVG。
- **移动端适配**：`tapIndex` 注入移动端 CSS/JS，composer 输入栏窄屏换行、选择器限宽、iOS 输入框 16px 防缩放；**不破坏 DSH 原生 rail + 汉堡抽屉交互**。

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

> 想用本地 tarball 测试：`dsh plugin --profile web add C:\path\to\feiyang666-dsh-mobile-remote-1.1.0.tgz`

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
| 开启开关后手机还是连不上 | 确认手机与电脑同一 Wi-Fi；确认防火墙放行 3080 端口；确认访问的是局域网 IP 而非 `127.0.0.1` |
| 手机能访问但显示 403 | dsh 的信任围栏：请确认本插件已安装、且以官方支持的方式启动（`--patch` / profile patch 覆盖 `webserver.host`） |
| 设备数为 0 | 手机端页面需打开过才会心跳上报；等待几秒刷新 |
| 二维码扫不出来 | 确认「远程控制」已开启；相机应用需支持扫码 |

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
