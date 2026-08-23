# dsh-mobile-remote v1.6.1

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。移动端提供上传图片入口、底部抽屉式模型选择、发送状态提示等移动优先体验。

## 安装方式

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

安装完成后**重启 dsh web 服务**，打开 `http://127.0.0.1:3080` → **设置 → 远程控制** 即可使用。

## 本版更新（v1.6.1）

### 🐛 用量插件等宽表在移动端被压成逐字竖排（可靠兜底）

`dsh-usage-plugin` 的「消耗表 / 消耗明细 / 每日统计」等 9–11 列宽表依赖其运行时注入的全局样式（`.dsh-usage-table{min-width:720px}` + ≤540px 折叠中间列）来避免列被压到极限宽度；若该样式因 CSP / 加载时序未生效，手机窄屏下每列会被压到约 1 字符宽、内容逐字竖排、无法阅读。

本插件（dsh-mobile-remote）的样式是**随 index.html 一起由服务端下发、必定生效**，故在 `<style id="dsh-mobile-remote-css">` 中新增兜底：

- `html[data-dsh-mobile] .dsh-usage-table { min-width: 720px !important; }`，宽表强制保持 720px 宽；
- ≤540px 时对带 `collapse-mobile` 的宽表隐藏第 4 列至倒数第 2 列，只保留前 3 个主标识列与最后合计列，关键数据一屏看全；
- 价格表等窄表（无 `collapse-mobile`）不折叠，保留横向滚动。

这样即使旧版用量插件未更新或其样式表注入失败，移动端宽表也始终可横向滑动阅读。

## 历史更新（v1.6.0）

### 🆕 SSE 实时推送端点

新增 `GET /__dsh_remote/events` 事件流端点（受远程密码门禁保护），设备心跳上报 / 远程开关切换 / 外网隧道启动停止等状态变化时向订阅者推送 `data: {"type":"changed","at":<时间戳>}`。桌面端数据中心等客户端订阅该流即可**即时**感知远程设备与隧道状态变化，无需轮询。无订阅者时零开销，插件独立使用不受影响。

## 已知事项

- 开启后服务暴露到公网，**请务必设置远程访问密码**，并仅在可信网络上使用
- 外网隧道需确保服务器 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 完全一致，否则面板会明确提示鉴权失败

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
