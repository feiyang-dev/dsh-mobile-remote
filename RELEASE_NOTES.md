# dsh-mobile-remote v1.5.4

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。移动端提供上传图片入口、底部抽屉式模型选择、发送状态提示等移动优先体验。

## 安装方式

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

安装完成后**重启 dsh web 服务**，打开 `http://127.0.0.1:3080` → **设置 → 远程控制** 即可使用。

## 本版更新（v1.5.4）

### 🐛 修复移动端无法选择图片（v1.5.0 起就存在的根因）

图片类型校验正则写为 `/^image\//i`，但该代码经 JS **模板字符串**注入 `<script>`，模板字符串中 `\/` 属于非转义序列、反斜杠会被丢弃，注入后变成 `/^image//i`，被解析成「正则 `/^image/` 除以 `i.test(...)`」，运行时报 `TypeError: i.test is not a function`——从 v1.5.0 起手机端选图后输入框一直没有缩略图。本版改用 `indexOf('image/')` 判断图片类型，彻底绕开正则转义问题。

同时配套修复：
- 图片 intake 不再依赖 `new DataTransfer()`（iOS Safari 上 `files` 为空、`getAsFile()` 返回 null），改用普通 JS 对象模拟 `clipboardData` / `dataTransfer` 接口；
- 模拟 `clipboardData` 补齐 DSH `onPaste` 会调用的 `getData()`，避免 React 事件处理器崩溃；
- 隐藏文件选择器改为等 `document.body` 就绪后再挂载，避免部分 iOS WebView 拒绝 `.click()` 打开系统相册。

### 🆕 移动端「上传中 / 发送中」状态指示

发送图片消息时，DSH 会先 `serializeImages`（读取图片转 base64，移动端大图可能持续数秒）再 `prompt`，期间会话列表不会立刻出现新消息，用户容易误以为「没发出去」。本版监听 composer textarea 的 `data-phase`，进入 `submitting` / `adjudicating` 阶段时在 composer 上方显示带 spinner 的浮层提示：

- 有附件图片时显示「正在上传图片并发送…」；
- 纯文本时显示「正在发送…」；
- 发送完成（phase 恢复）后自动隐藏。

### 🐛 模型选择弹窗在移动端改为底部抽屉

ModelSelect 菜单为绝对定位浮层（`right: 0`、宽 240px），窄屏下从右侧锚点向左展开，把 composer 左侧的 + / 上传图片等按钮盖住。本版将带 `aria-label` 的 `[role=menu]`（模型选择菜单）在移动端改为**底部抽屉（bottom sheet）**：贴底、左右留 8px、距底部 24px、宽度自适应屏幕、`max-height: 62vh` 内部滚动，不再遮挡左侧内容；权限选择菜单保持原有浮层 + 水平钳制。

## 历史更新（v1.5.0）

### 🆕 移动端上传图片（composer 加号旁的「上传图片」按钮）

DSH 桌面端原生支持图片消息（粘贴 / 拖放，含格式 / 数量 / 大小预检查、缩略图 rail、随消息上传），但移动端没有「选择图片」的入口——工具行的 + 按钮只打开命令菜单。本版在**移动端 composer 工具行、+ 加号按钮旁**注入一个「上传图片」按钮：

- 点击按钮，直接唤起手机**系统相册 / 文件选择器**（支持一次选多张）；
- 选中后把图片喂给 DSH **原生 intake 链路**（`paste` / `drop` 事件），格式 / 数量 / 大小预检查、缩略图预览、随消息上传全部复用官方实现；
- **不依赖 DSH 内部 API**，harness 升级后只要 paste / drop 链路仍在即可正常工作；
- 按钮禁用态跟随输入框（session 移除 / 锁定 / 提交中自动置灰）；选完文件自动重置，可重复选同一张图；
- 配套优化：缩略图 rail 删除按钮触控目标加大（18px → 24px），选图失败时自备极简提示气泡。

> 仅移动端（`<1024px`）生效，桌面端界面不受任何影响。

### 🐛 修复启用远程控制后写坏 profile 的 cordis.patch.yml（服务启动即崩溃）

在设置页开启「远程控制」并重启服务后，dsh 启动即崩溃。**根因**：官方模板生成的 profile patch 文件内容是 `[]`（空数组占位），插件往文件末尾追加列表块时未先移除占位行，导致同一文件出现两个 YAML 文档且无 `---` 分隔符。**修复**：写入前过滤掉裸 `[]` 占位行（`setPatchEnabled` / `ensureTrustedHost`）。

### 🐛 修复客户端插件加载失败（client-modules: loaded without registering）

client 侧 bundle 中 `__ModuleLoader__.load` 的 `id` 写成了无 scope 的裸包名，改为完整包名 `@feiyang666/dsh-mobile-remote`，与官方插件的 client bundle 写法一致。

> 已安装旧版本的用户：请先卸载本插件（桌面端「插件管理」或 `dsh plugin --profile web remove @feiyang666/dsh-mobile-remote`），再重新安装本修复版。

## 已知事项

- 开启后服务暴露到公网，**请务必设置远程访问密码**，并仅在可信网络上使用
- 外网隧道需确保服务器 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 完全一致，否则面板会明确提示鉴权失败

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
