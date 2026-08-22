# dsh-mobile-remote v1.4.4

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。本版**修复安装插件后 dsh 服务启动崩溃**的问题。

## 安装方式

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

安装完成后**重启 dsh web 服务**，打开 `http://127.0.0.1:3080` → **设置 → 远程控制** 即可使用。

## 本版更新（v1.4.4）

### 🐛 修复安装插件后 dsh 服务启动崩溃（必须升级）

安装本插件后 dsh web 服务启动即崩溃（退出码 1），日志报：

```
Cannot find package 'dsh-mobile-remote' imported from C:\Users\Administrator\.dsh\profiles\web\
```

**根因**：bundle 补丁层 `cordis.patch.yml` 中插件行的 `name` 写成了无 scope 的裸包名 `dsh-mobile-remote`，而实际 npm 包名是 `@feiyang666/dsh-mobile-remote`。Cordis loader 按 `name` 去 profile 的 `node_modules` 中 import 该包时找不到，导致整个插件树加载失败、dsh 进程退出。

**本版修复**：`cordis.patch.yml` 的 `name` 改为完整包名 `@feiyang666/dsh-mobile-remote`，与其它官方插件保持一致。

> 已安装 v1.4.3 及更早版本的用户：请先在桌面端「插件管理」中卸载本插件（或执行 `dsh plugin --profile web remove @feiyang666/dsh-mobile-remote`），服务即可恢复启动，再安装本修复版。

## 已知事项

- 开启后服务暴露到公网，**请务必设置远程访问密码**，并仅在可信网络上使用
- 外网隧道需确保服务器 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 完全一致，否则面板会明确提示鉴权失败

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
