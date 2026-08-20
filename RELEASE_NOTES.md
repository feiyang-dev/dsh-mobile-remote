# dsh-mobile-remote v1.4.1

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。本版聚焦**外网隧道真实状态诊断**：不再"假在线"，token 鉴权失败 / 断线重连一目了然。

## 安装方式

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

安装完成后**重启 dsh web 服务**，打开 `http://127.0.0.1:3080` → **设置 → 远程控制** 即可使用。

## 本版更新（v1.4.1）

### 🚦 外网隧道真实状态判定（核心）

之前插件把「frpc 进程存活」误判为「隧道在线」——frpc 即使登录被拒、隧道从未建立，面板也显示绿色「在线」（打开链接却是 502）。本版彻底修复：

- **启动探测**：开启外网时读 frpc 日志，确认 `start proxy success` 隧道真正建立才算 `online`；
- **轮询复查**：`/status` 每 5s 复查日志——断线降级「连接中」（自动重连中）、token 不匹配降级「出错」，重连成功后自动恢复；
- **明确报错**：前端红色「出错」徽标 + 错误卡直接展示 frpc 真实原因（如 `token in login doesn't match token from configuration`），并附解决指引；
- **一键重试**：出错状态点开关即可 kill 旧进程重新绑定。

### 🔁 隧道持续心跳保活

- 隧道在线期间每 60s 向中转端上报心跳，`last_seen` 保持新鲜；
- 停止隧道时主动上报 `offline`，配合后端在线判定让管理端 / 面板实时反映真实状态。

### ⚠️ FRP_TOKEN 占位符检测

- 中转端新增 `frpTokenWarning` 字段；插件面板检测到服务器 `.env` 的 `FRP_TOKEN` 仍是占位符时，显示黄色警告条并说明会导致隧道 502。

### 🗂 DSH 状态卡默认折叠

- 折叠态只显示摘要行（会话 / 工作区 / 插件 / 模型数），点击标题展开详情，节省面板空间。

### 🐛 修复

- 修复设置页空白崩溃（`status` 首次渲染为 `null` 时的守卫缺失）。

## 后端配套（dsh-update-server）

外网隧道详情、真实在线判定依赖中转端新接口（`/api/tunnel/stats`、`/heartbeat` 离线支持、成员端在线判定）。**旧后端不影响插件使用**：插件自动回退到 `/status` 接口。若要展示流量 / 连接数等丰富信息，请同步升级中转端（见 `dsh-update-server` 的 `DEPLOY_CHECKLIST.md`）。

## 已知事项

- 开启后服务暴露到公网，**请务必设置远程访问密码**，并仅在可信网络上使用
- 外网隧道需确保服务器 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 完全一致，否则面板会明确提示鉴权失败

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
