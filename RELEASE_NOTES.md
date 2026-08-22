# dsh-mobile-remote v1.4.3

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。本版**修复移动端设置页空白 / 无法滚动**，并新增**内网（非安全上下文）远程连接的 `crypto.randomUUID` 兜底**，让内网直连与手机扫码访问不再失败。

## 安装方式

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

安装完成后**重启 dsh web 服务**，打开 `http://127.0.0.1:3080` → **设置 → 远程控制** 即可使用。

## 本版更新（v1.4.3）

### 🖱️ 移动端设置页：内容空白 + 无法上下滚动

上一版已把设置弹窗改为全屏单栏，但面板仍是横向布局，导致内容列被压成 0 宽度、设置内容区整块空白；内容列也无法收缩，设置选项区不能上下滑动。本版：

- 面板强制 `flex-direction: column`，导航栏成为顶部横向标签、内容列独占剩余空间；
- 内容列 `min-height: 0` + `overflow: hidden`，设置选项区在手机端可正常上下滚动。

### 🔐 内网远程连接：`crypto.randomUUID` 兜底

当前 DSH 客户端多处裸调用 `crypto.randomUUID()`，该 Web Crypto API 仅在 HTTPS 或 localhost 存在。内网 http 直连（非安全上下文）下缺失（或存在但调用即抛），导致连接与所有 RPC 失败，模型设置页因此报 `settings are unavailable in this browser`。本版在插件注入 `<head>` 的脚本里，用 `crypto.getRandomValues`（非安全上下文也可用）补一个 RFC 4122 v4 `crypto.randomUUID` 兜底，覆盖应用内全部调用点，内网访问 / 扫码连接恢复正常；DSH 自行修复后该兜底自动失效，无副作用。

## 已知事项

- 开启后服务暴露到公网，**请务必设置远程访问密码**，并仅在可信网络上使用
- 外网隧道需确保服务器 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 完全一致，否则面板会明确提示鉴权失败

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
