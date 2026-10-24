# dsh-mobile-remote v1.9.0

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。

## 本版更新（v1.9.0）—— 让远程控制在 dsh 0.2.1+ 上重新可用

一句话：**不再改 dsh 的监听绑定，改为旁挂一个局域网听众。** 桌面端窗口、端口、会话全都不受影响。

### 为什么之前的版本用不了了

| 症状 | 根因 |
| --- | --- |
| 开启开关后，**电脑上的窗口直接打不开/白屏** | 旧版把 `webserver.host` 改成 `0.0.0.0`。dsh 0.2.1-rc.3 起只接受具体网卡 IP，`0.0.0.0` 会让进程启动即退出；即使是具体 IP，改绑后 `127.0.0.1` 监听消失，桌面端固定连回环 → 白屏 |
| **官方桌面端**里开关点了完全没反应 | 旧版按 `DSH_PROFILE` 环境变量定位 profile，而官方桌面端**不设该变量**（只把 profile 目录作为 argv 传参）→ patch 写进了 `profiles/web`，实际运行的是 `profiles/desktop` |
| 写完 patch 后 **dsh 起不来**，报 `unknown tag !<tag:yaml.org,2002:js>` | `!!js` 在该 YAML schema 里只能作用于**标量**；`trustedHosts: !!js [...]` 会被当成「流式序列 + 标量标签」 |
| 端口莫名变了、二维码/链接失效 | 官方桌面端用 `--port 0` 由系统分配端口，旧 patch 里重述 `port` 会让重载后的端口漂移 |

### 新版怎么做的

- **旁挂 LAN 听众（`lib/lanproxy.js`）**：在 `<局域网IP>:<当前端口>` 再监听一份，反向代理到
  `127.0.0.1:<当前端口>`。HTTP 与 WebSocket 都通，`X-Forwarded-For` 透传真实手机 IP，
  长连接不会被 keep-alive 超时误杀。**开关即时生效，无需重启 dsh、不写任何配置文件。**
- **Host / Origin 改写成回环**：dsh 的 Host/Origin 信任围栏对回环一律放行，
  因此局域网访问**不再需要** `trustedHosts`，也不会再出现「页面能打开、`/api` 全 403」。
- **patch 只写 `connection.trustedHosts`**（外网隧道经 frp 直连真实监听时才需要），
  用 `!!js "[...ctx.webStartup.trustedHosts, '域名']"` 合并启动参数，绝不覆盖 `webserver`。
- **profile 路径校正**：优先 `profileContext.patchPath` —— CLI、官方桌面端、第三方壳全部适用。
- **旧配置自动迁移**：清理历史遗留的 `webserver` 覆盖与 `ctx.webRuntime.trustedHosts` 块，
  迁出的域名并入受管 trustedHosts；若旧绑定正在生效，会在 HMR watcher 就绪后再改写，把监听拉回回环。

### 移动端体验

- **侧栏默认收起**：窄屏下侧栏轨道压到 `0px`，内容区吃满整屏（此前固定的 56px 图标 rail 在
  390px 手机上仍占 14% 宽）。
- **悬浮按钮唤出抽屉**：左上角悬浮汉堡按钮 → 覆盖式抽屉（不再挤压中栏）+ 半透明遮罩；
  点遮罩 / Esc / 选中会话自动收起。开合仍驱动官方 store（复用原生 toggle、aria、快捷键）。
- 端口变化时局域网听众 15s 内自适应重绑；`remoteEnabled` 持久化，重启自动恢复。

### 验证

- `tests/patch.test.mjs`：43 项断言全通过（含「绝不写 webserver」「`!!js` 必须加引号」「旧配置迁移」）。
- 实测环境：dsh 0.2.1-rc.3 + Windows；验证了「本机端口不变 + 局域网同端口可访问 +
  扫码自动登录 + `/api` 不再 403 + WebSocket 升级透传 + 开关即时生效（无需重启）」。
