# 更新日志 / Changelog

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
