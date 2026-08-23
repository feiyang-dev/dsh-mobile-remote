# 更新日志 / Changelog

## v1.6.1 (2026-08-23)

### 修复 / Fixed

- **用量插件等宽表在移动端被压成逐字竖排（可靠兜底）**（`lib/index.js` MOBILE_CSS）：`dsh-usage-plugin` 的「消耗表 / 消耗明细 / 每日统计」等 9–11 列宽表依赖其运行时注入的全局样式（`.dsh-usage-table{min-width:720px}` + ≤540px 折叠中间列）来避免列被压到极限宽度；若该样式因 CSP / 加载时序未生效，手机窄屏下每列会被压到约 1 字符宽、内容逐字竖排、无法阅读。本插件（dsh-mobile-remote）的样式是**随 index.html 一起由服务端下发、必定生效**，故在 `<style id="dsh-mobile-remote-css">` 中新增兜底：`html[data-dsh-mobile] .dsh-usage-table { min-width: 720px !important; }`，并在 ≤540px 时对带 `collapse-mobile` 的宽表隐藏第 4 列至倒数第 2 列、只保留前 3 个主标识列与最后合计列。这样即使旧版用量插件未更新或其样式表注入失败，移动端宽表也始终可横向滑动阅读、关键数据一屏看全。价格表等窄表（无 `collapse-mobile`）不折叠，保留横向滚动。

## v1.6.0 (2026-08-23)

### 新增 / New
- **SSE 实时推送端点**（`lib/index.js`）：新增 `GET /__dsh_remote/events` 事件流端点（受远程密码门禁保护），设备心跳上报 / 远程开关切换 / 外网隧道启动停止等状态变化时向订阅者推送 `data: {"type":"changed","at":<时间戳>}`。桌面端数据中心等客户端订阅该流即可即时感知远程设备与隧道状态变化，无需轮询。无订阅者时零开销，插件独立使用不受影响。

## v1.5.4 (2026-08-23)

### 新增 / New
- **移动端「上传中 / 发送中」状态指示**（`lib/index.js` MOBILE_CSS + MOBILE_JS）：选择图片后发送，DSH 要先 `serializeImages`（读取图片转 base64，移动端大图可能数秒）再 `prompt`，期间会话列表不会立刻出现新消息，用户容易误以为没发出去。本版监听 composer textarea 的 `data-phase`，进入 `submitting` / `adjudicating` 阶段时在 composer 上方显示带 spinner 的浮层提示：有附件图片时显示「正在上传图片并发送…」，纯文本时显示「正在发送…」；phase 恢复后自动隐藏。不依赖 DSH 内部 API，只读 DOM 属性。

## v1.5.3 (2026-08-23)

### 修复 / Fixed
- **图片上传从未成功过的根因**（`lib/index.js` MOBILE_JS）：图片类型校验正则写为 `/^image\//i`，但 MOBILE_JS 是注入到 `<script>` 的 JS 模板字符串，模板字符串中 `\/` 属于非转义序列，反斜杠会被丢弃，注入后变成 `/^image//i`，被解析成「正则 `/^image/` 除以 `i.test(...)`」，运行时报 `TypeError: i.test is not a function`，导致从 v1.5.0 起手机端选图后输入框一直没有缩略图。本版改用 `indexOf('image/')` 做类型判断，彻底绕开正则转义问题。

## v1.5.2 (2026-08-23)

### 修复 / Fixed
- **图片 intake 仍失败（React 事件处理器崩溃）**（`lib/index.js` MOBILE_JS）：v1.5.1 的模拟 `clipboardData` 缺少 DSH `onPaste` 会调用的 `getData()`，派发 paste 时抛 `TypeError` 导致 React 事件处理器崩溃、输入框不显示缩略图。本版为模拟 `clipboardData` 补齐 `getData` / `setData` / `clearData`（`getData` 返回空文本，图片走文件分支），paste 链路不再抛错。
- **模型选择弹窗位置**（`lib/index.js` MOBILE_CSS）：底部抽屉底部边距由 8px 上移到 24px，避免贴屏太靠下。

## v1.5.1 (2026-08-23)

### 修复 / Fixed
- **手机端仍无法选择图片**（`lib/index.js` MOBILE_JS）：v1.5.0 的 intake 依赖 `new DataTransfer()` 构造器，iOS Safari 上构造出的 `DataTransfer` 添加文件后 `files` 返回空 FileList、`item.getAsFile()` 可能返回 null，导致「当前浏览器不支持直接上传 / 图片未添加上」。本版改为**用普通 JS 对象模拟 `clipboardData` / `dataTransfer` 接口**（DSH 的 `onPaste` 只读 `clipboardData.items` 的 `kind` / `getAsFile()`，`onDrop` 只读 `dataTransfer.types` / `.files`，模拟对象即可满足），彻底绕开 DataTransfer / ClipboardEvent 构造器兼容问题；并**优先派发 `paste`**（React 合成事件，兼容性最好）、`drop` 作兜底；隐藏文件选择器改为**等 `document.body` 就绪后再挂载**，避免部分 iOS WebView 拒绝 `.click()` 打开系统相册。
- **移动端模型选择弹窗遮挡左侧工具区**（`lib/index.js` MOBILE_CSS + MOBILE_JS）：ModelSelect 菜单为绝对定位浮层（`right: 0`、宽 240px），在窄屏上从右侧锚点向左展开，把 composer 左侧的 + / 上传图片等按钮盖住。本版将带 `aria-label` 的 `[role=menu]`（模型选择菜单）在移动端改为**底部抽屉（bottom sheet）**：`position: fixed` 贴底、左右留 8px、宽度自适应屏幕、`max-height: 62vh` 内部滚动，不再从锚点向左侧/上方展开遮挡左侧内容；权限选择菜单保持原有浮层 + 水平钳制（`mrClampMenus` 对 fixed 菜单跳过平移）。

## v1.5.0 (2026-08-22)

### 新增 / Added
- **移动端 composer 上传图片入口**（`lib/index.js` MOBILE_JS + MOBILE_CSS）：DSH 桌面端原生支持图片消息（粘贴 / 拖放，含格式 / 数量 / 大小预检查、缩略图 rail、随消息上传），但移动端没有「选择图片」入口（工具行的 + 按钮只打开命令菜单）。本版在移动端 composer 工具行、+ 加号按钮旁注入一个「上传图片」按钮：
  - 点击唤起手机系统相册 / 文件选择器（`<input type="file" accept="image/*" multiple>`）；
  - 选中后把 `File` 装入 `DataTransfer`，向输入框派发 `paste` 事件，DSH 原生 `onPaste` 的 `intakeImages` 自动接管（预检查、缩略图、随消息发送）；浏览器不支持构造 `ClipboardEvent` 时自动回退为向 `document` 派发 `drop` 事件；
  - **不依赖 DSH 内部 API**，harness 升级后只要 paste / drop 链路仍在即可正常工作；
  - 按钮禁用态跟随输入框（session 移除 / 锁定 / 提交中自动置灰），选完文件自动重置可重复选图。
- **移动端图片体验配套优化**（`lib/index.js` MOBILE_CSS）：
  - 缩略图 rail 的删除按钮触控目标从 18px 加大到 24px（结构选择器定位，不依赖哈希类名）；
  - 自备极简提示气泡（`#dsh-mr-toast`，2.4s 淡入淡出），用于选图失败 / 浏览器不支持时的友好提示，不动 DSH 原生 Toast。

### 修复 / Fixed
- **选图后输入框看不到图片**（`lib/index.js` MOBILE_JS）：原先依赖「构造 `ClipboardEvent` / `DragEvent` 并携带 `DataTransfer`」派发 paste 事件，不同浏览器对该 API 的支持不一致（尤其 iOS Safari 的 `new DataTransfer()` 及事件构造器）。现改为**最通用的 `new Event()` + 手动挂载 `dataTransfer` / `clipboardData` 属性**派发，且**优先派发 `drop` 到 `document`**（DSH 的 onDrop 是原生监听器，最可靠），`paste` 到 textarea（React 合成事件）作兜底；成功与否以「缩略图是否真的出现在 rail」为准（而非 `defaultPrevented`，锁定 / 提交中 DSH 也会 preventDefault），全部失败才提示，安卓 / 桌面浏览器均可正常选图。
- **权限选择弹窗未出现在按钮正上方**（`lib/index.js` MOBILE_CSS + MOBILE_JS）：DSH 的 `Menu`（PermissionSelect）是绝对定位浮层（`left: 0`）且无 viewport 钳制，锚点在工具行左区时菜单向右展开容易溢出屏幕右侧。移动端新增 `[role="menu"]` 宽度钳制（`max-width: calc(100vw - 16px)`），并在菜单出现时用 `translateX` 把越界的菜单平移回视口内。
- **模型选择弹窗向左偏、信息显示不全**（`lib/index.js` MOBILE_CSS + MOBILE_JS）：ModelSelect 菜单 `right: 0` 对齐锚点右缘，锚点靠左时菜单左端超出屏幕左侧。同上由 `mrClampMenus` 统一钳制水平位置，保证菜单完整落在视口内。


### 修复 / Fixed
- **启用远程控制后写坏 profile 的 `cordis.patch.yml`，服务启动即崩溃**（`lib/index.js` 的 `setPatchEnabled`、`lib/external.js` 的 `ensureTrustedHost`）：官方模板生成的 profile patch 文件内容是 `# user patch layer for this profile\n[]`（空数组占位），插件往文件**末尾追加** `- id: webserver` 等列表块时未先移除该 `[]` 行，导致同一文件出现两个 YAML 文档且无 `---` 分隔符，js-yaml 解析报 `YAMLException: end of the stream or a document separator is expected`，dsh 服务启动即崩溃。本版在写入前过滤掉裸 `[]` 占位行，patch 文件始终是单一文档，已用官方 `entryListSchema` 验证可解析。

## v1.4.5 (2026-08-22)

### 修复 / Fixed
- **客户端插件加载失败**（`lib/client.js`）：`window.__ModuleLoader__.load` 的 `id` 写成了无 scope 的裸包名 `dsh-mobile-remote`，而 client-modules 按 loader entry 的完整包名 `@feiyang666/dsh-mobile-remote` 校验注册，导致报 `loaded without registering "@feiyang666/dsh-mobile-remote"`、客户端插件无法加载。本版改为完整包名，与 `dsh-vault`、`dsh-usage-plugin` 的 client bundle 写法一致。

## v1.4.4 (2026-08-22)

### 修复 / Fixed
- **安装插件后 dsh 服务启动崩溃**（`cordis.patch.yml`）：bundle 补丁层 `insert` 块的 `name` 写成了无 scope 的裸包名 `dsh-mobile-remote`，而实际 npm 包名是 `@feiyang666/dsh-mobile-remote`。Cordis loader 按 `name` 去 profile 的 `node_modules` 中 import 该包时找不到（`Cannot find package 'dsh-mobile-remote'`），导致整个插件树加载失败、dsh 服务 `code=1` 退出。本版改为完整包名 `@feiyang666/dsh-mobile-remote`，与 `dsh-vault`、`dsh-usage-plugin` 等官方插件的写法保持一致。

## v1.4.3 (2026-08-22)

### 修复 / Fixed
- **移动端设置页空白 + 无法上下滚动**（`lib/index.js` MOBILE_CSS）：v1.4.2 虽把设置弹窗改为全屏单栏，但面板仍是横向 `flex`（row）布局，内容列被压成 0 宽度 → 内容区整块空白；且内容列 `min-height:auto` 无法收缩，`.options` 区拿不到受限高度 → 不能滑动。本版：
  - 面板强制 `flex-direction: column !important`，导航栏成顶部横向标签、内容列独占剩余空间；
  - 内容列 `min-height: 0` + `overflow: hidden`，让设置选项区在手机端可正常上下滚动。
- **内网（非安全上下文）远程连接失败**（`lib/index.js` GATE_JS）：当前 DSH 客户端多处裸调用 `crypto.randomUUID()`（RPC ID / 消息 ID / 实例令牌等），而该 Web Crypto API 仅在 HTTPS 或 localhost 存在。内网 http 直连（非安全上下文）下缺失（或存在但调用抛 `NotSupportedError`），导致连接与所有 RPC 失败，模型设置页因此报 `settings are unavailable in this browser`。本版在插件注入 `<head>` 的脚本里，用 `crypto.getRandomValues`（非安全上下文也可用）补一个 RFC 4122 v4 `crypto.randomUUID` 兜底，覆盖应用内全部调用点，内网访问 / 扫码连接恢复正常；DSH 自行修复后该兜底自动失效，无副作用。

## v1.4.2 (2026-08-21)

### 修复 / Fixed
- **移动端 Tooltip 常驻屏幕**（`lib/index.js` MOBILE_CSS）：DSH 原生 Tooltip 气泡由 hover/focus 触发，触屏设备点击按钮后焦点停留、气泡一直显示在屏幕上（如「停止」「开始」「关闭菜单栏」等按钮的提示文字）。移动端直接隐藏 `[role="tooltip"]` 气泡，按钮仍保留 aria-label 无障碍名。
- **设置页未适配移动端**（`lib/index.js` MOBILE_CSS + MOBILE_JS）：原生设置弹窗为 800px 双栏（188px 导航栏 + 内容列），手机上几乎无法使用。改为全屏单栏：
  - 导航栏 → 顶部横向滚动胶囊标签（加大触控目标）；
  - 内容列独占剩余空间、边距收紧，各设置 section 获得完整宽度；
  - 用 MutationObserver 识别设置弹窗（`role=dialog` 且直子元素为 `<nav>`）打上 `data-dsh-settings` 标记，**不依赖 harness 内部哈希类名**，harness 升级后仍可直接适配。
- **远程控制面板窄屏细节**（`lib/client.js`）：设备详情 / 外网状态行的长文本允许换行（`overflowWrap`），行内放不下时允许换行（`flexWrap`），避免手机端溢出卡片。

## v1.4.1 (2026-08-20)

### 新增 / Added
- **外网隧道真实状态判定**（`lib/external.js` + `lib/client.js`）：
  - 开启外网时不再"进程活着 = 在线"，改为探测 frpc 日志确认隧道真正建立（`start proxy success`）才判 `online`；
  - 新增 `probeTunnelHealth()`：`/status` 轮询时复查日志，发现断线（`connect to server error`）降级为「连接中」、token 不匹配（`token in login doesn't match`）降级为「出错」，重连成功后自动恢复在线；
  - 前端新增红色「出错」徽标 + 错误卡，直接展示 frpc 真实报错与解决指引（服务器 `FRP_TOKEN` 与 `frps.toml` 的 `auth.token` 不一致等），并提供「查看 frpc 日志」按钮；
  - `error` 状态支持一键重试（kill 旧进程重新绑定）。
- **隧道持续心跳保活**（`lib/external.js`）：隧道在线期间每 60s 上报一次心跳，让中转端 `last_seen` 保持新鲜；停止隧道时主动上报 `offline`，配合后端在线判定实时反映真实状态。
- **FRP_TOKEN 占位符检测**（前后端联动）：中转端 `/status`、`/stats` 返回 `frpTokenWarning`；插件面板显示黄色警告条，提示服务器 `.env` 的 `FRP_TOKEN` 仍是占位符导致隧道必然 502。
- **DSH 状态卡默认折叠**（`lib/client.js`）：折叠态只显示摘要行（会话 / 工作区 / 插件 / 模型数），点击标题展开详情，节省面板空间。

### 修复 / Fixed
- **设置页空白崩溃**：修复 `status` 首次渲染为 `null` 时，`status.external...` 无守卫导致的 `Cannot read properties of null` 崩溃（面板内容区被错误边界吞成空白）；同时加固 `extErrText` 的完整守卫。
- 外网状态不再被 `/status` 覆盖为假在线（`externalView` 直接透传真实状态）。

### 变更 / Changed
- `lib/client.js`：外网隧道卡新增 frpc 进程 PID / 已运行时长 / 脱敏绑定码展示。
- 依赖后端 `dsh-update-server` 同步升级（成员端在线判定 / `/stats` / `heartbeat` 离线支持），旧后端自动回退兼容。

## v1.4.0 (2026-08-20)

### 新增 / Added
- **运行时信息卡扩充**（host `lib/index.js`）：新增 CPU 型号 / 频率、系统负载（1m / 5m / 15m）、系统开机时长、内存使用率（%）。
- **DSH 应用层状态卡**（host + client）：
  - **版本号**：多位置探测 dsh 版本（profile 本地 / 桌面版 `dsh-local` / 全局安装）；
  - **会话总数**：`ctx.sessionPersistence.list()`（带 2s 超时保护）；
  - **工作区列表**：路径 / 标题 / 会话数（`ctx.workspaceRegistry.list()`）；
  - **已安装插件列表**：插件名 / 启用状态 / fiber 阶段（`ctx.pluginInventory.list()`）；
  - **模型提供方**：提供方 id / 名称（`ctx.llm.listProviders()`）。
  - 以上数据由**后台每 60s 缓存刷新**，`/status` 直接读缓存，不拖慢 5s 轮询；任一服务不可用时自动降级隐藏。
- **设备详情补强**（`MOBILE_JS` + host + client）：新增**设备内存（GB）/ CPU 核数 / 电池电量（含是否充电）**。
- **外网隧道详情补强**（host + client）：新增 **frpc 进程 PID / 已运行时长 / 脱敏绑定码**（前 4 位 + `****`）。

### 变更 / Changed
- host 侧通过 `ctx.get()` 可选获取 `sessionPersistence` / `workspaceRegistry` / `pluginInventory` / `llm`，**不新增必选 inject 依赖**，保证精简启动方式下插件仍可正常运行。
- `lib/external.js`：frpc 启动时记录 `startedAt`，停止时清除。

## v1.3.0 (2026-08-20)

### 新增 / Added
- **更丰富的数据展示**（host `lib/index.js` + client `lib/client.js`）：
  - **设备详情可展开**：已连接设备列表改为可点击展开，展示系统 / 浏览器、屏幕 / 视口 / DPR、触屏标记、网络连接（effectiveType / 下行带宽 / RTT）、在线状态、语言 / 平台、当前页面（标题 + 路径）、首次连接 / 最后活跃时间、心跳次数；
  - **心跳元数据补全**：移动端心跳上报由原来的 `id + ua` 扩充为完整设备信息（`platform` / `lang` / `online` / `touch` / `dpr` / `screen` / `viewport` / `connection` / `path` / `title` / `mobile`）；
  - **统计区扩充**：由 2 格变为 4 格 —— 当前连接设备 / 累计设备 / 累计心跳 / 局域网地址；
  - **运行时信息卡**：运行时长、Node.js 版本、进程 PID、主机名、系统（平台 / 版本 / 架构）、CPU 核数、可用内存 / 总内存、RSS、堆内存、当前 Profile、DSH 数据目录；
  - **网络接口卡**：所有 IPv4 网卡的网卡名 / IP / CIDR / 掩码 / MAC / 是否回环；
  - **外网隧道详情**：域名、隧道端口、frpc 版本、中转服务器状态 / 最后心跳 / 服务器时间，以及「查看 frpc 日志」按钮（新 host API `GET /__dsh_remote/external/log`）。

### 修复 / Fixed
- **累计心跳数恒为 0**：`tracker.beats()` 之前只是读取、从不自增，导致 `totalHeartbeats` 永远为 0；改为 `recordBeat()` 每次心跳 +1。
- 累计去重设备数 / 心跳数改为设备粒度统计（每台设备 `beatCount`）。

### 变更 / Changed
- `lib/external.js`：启动时探测并记录 frpc 版本（`state.frpcVersion`），供设置页展示；导出 `frpcLogTail()`。
- `lib/client.js`：设置面板新增多个数据展示区块，布局保持主题 token 自适应深色 / 浅色。

## v1.2.0 (2026-08-20)

### 新增 / Added
- **远程访问密码门禁**（host half `lib/index.js` + `lib/password.js` + client half `lib/client.js`）：
  - 设置页「远程控制 → 远程访问密码」卡片：管理员本机设置 / 修改 / 清除密码；
  - 远程（外网隧道 / HTTPS 反代）访问进入 DSH 页面时，弹出全屏密码验证页，输入正确密码方可使用；本机 / 局域网直连不受影响；
  - 密码仅以 `scrypt` 哈希 + 随机盐存于本地 `~/.dsh/plugins/dsh-mobile-remote/config.json`，绝不落盘明文；`timingSafeEqual` 校验 + 登录失败次数限制防爆破；
  - **完全本地、不依赖任何中转后端**（兼容自建 frp / 中转服务 / 其它中转方案）；
  - 新增 host API：`/__dsh_remote/auth-status`、`auth`、`logout`、`set-password`；`/__dsh_remote/*` 对远程未认证请求返回 401。

### 性能优化 / Performance
- **远程访问加载提速**：`lib/external.js` 为生成的 `frpc.toml` 注入 `poolCount`（默认 20，可用 `DSH_FRPC_POOL_COUNT` 覆盖），缓解 DSH 首屏大量并发请求触发 frpc “work connection pool is full” 导致的转圈/排队；
- 配套：服务端模板 `deploy/frps.toml` 调大 `transport.maxPoolCount` 到 64（部署后生效）。

## v1.1.0 (2026-08-19)

### 新增 / Added
- **设置页「远程控制」面板**（client half：`lib/client.js` 注册 `settings.section`）：
  - 连接二维码（host 端 `GET /__dsh_remote/qr` 生成 SVG）
  - 开启 / 关闭开关（写入 / 移除 profile `cordis.patch.yml` 的 `webserver` 覆盖块，经 dsh HMR 热重载生效，无需重启）
  - 当前连接的设备数量（移动端心跳上报，host 端活跃设备统计）
- **host 侧远程控制 API**（`lib/index.js`）：`/__dsh_remote/status` / `toggle` / `heartbeat` / `qr`
- **命令行远程控制支持**：无需桌面端，官方 `dsh --profile web` 即可通过设置页开关或 `--patch` overlay 开启
- 内联 MIT QR 生成器（`lib/qrcode.js`），零运行时依赖
- 双语 README（README.md / README.zh.md）、RELEASE_NOTES.md

### 变更 / Changed
- `package.json`：新增 `dsh.client` 声明与 `./client` export；版本升至 1.1.0

## v1.0.0 (2026-08-19)

### 新增 / Added
- 初始版本：移动端输入栏窄屏适配（选择器换行分排、限宽防粘连、按钮触控目标 ≥ 40px）+ iOS 触屏优化（输入框 16px 防聚焦缩放）
- host 侧 `tapIndex` 注入移动端 CSS/JS，不破坏 DSH 原生 rail + 汉堡抽屉交互
