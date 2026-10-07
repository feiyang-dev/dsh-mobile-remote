# dsh-mobile-remote v1.8.1

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。移动端提供上传图片入口、底部抽屉式模型选择、发送状态提示等移动优先体验。

## 本版更新（v1.8.1）—— 修复「链接不带密钥、手机/外网打不开」

v1.8.0 引入的自动登录在**新版 dsh（0.1.7 / 0.2.x）上实际是坏的**，本版把整条链路修通并做了端到端验证。

### 修复了什么

| 症状 | 根因 |
| --- | --- |
| 打开链接**不带 `?token=`**，手机扫码即 401 | `withAuthUrl()` 只试严格模式的 `ctx.get('connection')`；cordis 默认 `strict=true`，插件 fiber 未 inject `connection` 时取不到，便静默退回裸地址 |
| 外网经反代打开失败、`/api` 一直 401 | 自动登录原本生成 `http://<host>/?token=…`，被 nginx 301 回 https 时 **token 被丢掉**，握手从未发生 |
| 外网域名 **502 Bad Gateway** | `autoRestoreExternal()` 拿持久化的旧 `localPort`（3080）覆盖当前端口，frpc 转发到无人监听的端口 |
| 页面能打开但**功能全 403 forbidden** | patch 里写的 `...ctx.webRuntime.trustedHosts` —— 该字段在 0.1.7/0.2.x **不存在**，表达式求值成对象，被 `z.array(String)` 拒绝，`trustedHosts` 等于从未生效 |
| 开启开关后连接块凭空消失 | `lanAddresses()` 在 ESM 下残留 `require('node:os')`，`ReferenceError` 被空 `catch` 吞掉，永远返回 `[]` |

### 关键改动

- **密钥稳定携带**：`resolveConnection()` 三级回退（严格 → 非严格 → `ctx.connection`），`resolveBrowserAuth()` 在 `browserAuth` 不可见时直接复用 `HostConnectionService`（它本身就是 `BrowserAuth` 的委托层）。
- **相对地址跳转**：裸地址自动登录改为 `Location: /?token=…`，由浏览器按当前协议解析，http / https / 反代子路径全部正确，且不再重编码 token。
- **端口自适应**：始终以当前真实监听端口为准；写 `frpc.toml` 前校验端口一致（不一致直接中止报错）；运行中端口变化会在 15s 内自动重绑隧道。
- **`trustedHosts` 真正生效**：新增 `lib/patch.js` 统一维护 profile patch 受管区域，开启开关时同时写 `webserver.host='0.0.0.0'` 与 `connection.trustedHosts=['192.168.x.x:port', …]`（经 `normalizeAuthority` 规范化为可通过 `assertTrustedAuthority` 的形式），外网域名增量并入同一区域。
- **修复无限重定向**：取不到 token 时不再 `302` 到自身，改为明确 `401`。

### 验证结果

在 **dsh 0.2.0-rc.2** 上做了端到端验证，**26/26 全部通过**：

- 局域网 `http://192.168.3.119:19387` 与外网 `https://cwj.dsh.cwj666.top` 两条链路均：裸地址 `302` 自动登录（相对地址、带 token）→ `303` + `Set-Cookie`（`dsh-auth-*`，`HttpOnly`）→ 带 cookie 拿到 `200` 完整 UI（含移动端补丁）→ `/api` 通过信任围栏与认证；
- 安全回归：错误 token 拒绝且不发 cookie；无凭证 `/api` 被拒；无 token 访问 `/` 不会直接吐出 UI。

## 安装方式

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

安装完成后**重启 dsh web 服务**，打开 `http://127.0.0.1:3080` → **设置 → 远程控制** 即可使用。

## v1.8.0 功能回顾 —— 裸地址直达（自动登录）

> **配合新版 DeepSeek Harness（dsh ≥ 0.1.2）的浏览器会话认证**，v1.8.0 引入「裸地址直达，自动登录」：手机直接输裸地址就能进，全程无感。

### 裸地址直达（自动登录）

以往访问 `http://192.168.x.x:3080` 会看到官方 401「authentication required」，必须先复制一长串带 `?token=` 的链接。现在：

- 手机 / 远程设备**直接打开裸地址**（`http://192.168.3.119:3080`）→ 插件服务端自动完成官方认证（302 → token → 303 + Set-Cookie）→ **自动进入**，地址栏始终是干净裸地址；
- 已授权设备访问裸地址 → 直接返回完整官方 UI；
- 官方 token → cookie 握手**一步未绕开**，只是把手动重开带 token 链接变成自动化，30 天会话到期后再次访问也会自动授权，依然无感。

### 兼容新版 dsh 浏览器会话认证

dsh `>=0.1.2-rc.1` 对 Web UI 强制浏览器会话认证，本插件已完整适配：

- 插件接管 `GET /`：首次裸地址访问自动完成授权；内部取回官方 index（含全部官方注入），插件卸载时正确清理；
- 手机访问地址 / 二维码 / 局域网地址列表全部展示干净裸地址，并提示「首次访问自动完成连接授权」；
- `/__dsh_remote/status` 的 `url` / `lanUrls` / `external.url` 同时携带官方 token（程序化调用仍可用）；
- **老版 dsh 完全兼容**：无认证 / 无 `connection` 时自动回退为旧行为，升级无风险。

### 安全提示

裸地址自动登录等效于「局域网内能访问到该地址的设备都会自动获得授权」。若需要更强隔离，请在设置中开启**远程访问密码门禁**（对外网隧道生效）并仅在可信网络使用。

## 历史更新摘要

- **v1.8.0**：裸地址直达（自动登录）+ 适配新版 dsh 浏览器会话认证（本版存在的问题见上）
- **v1.7.1**：外网访问面板数据通道状态一目了然（WS 实时推送 / HTTP 兜底徽标）；运行时长本地每秒刷新；远程访问密码界面重做（DeepSeek 官网风格 + 服务信息面板 + 加载动画）；清除 / 修改密码需验证当前密码；修复 WS 双重序列化导致一直「等待推送」
- **v1.7.0**：中转服务器 WS 状态推送客户端（长连接替代每 5s HTTP 轮询，指数退避重连，ws 缺失自动降级 HTTP 兜底）

## 已知事项

- 开启后服务暴露到局域网，**请仅在可信网络使用**；公网 / 外网访问请务必开启远程访问密码
- 外网隧道需确保服务器 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 完全一致，否则面板会明确提示鉴权失败
- 若使用的是 dsh `0.1.2-rc.1` 之前的老版本，本插件的裸地址 / 自动登录行为自动回退，功能不受影响

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
