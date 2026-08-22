# dsh-mobile-remote v1.4.6

**DeepSeek Harness 移动端远程控制插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网访问并操控电脑上的 DeepSeek Harness。本版**修复启用远程控制后写坏 profile 的 `cordis.patch.yml`（服务启动即崩溃）**，并继承 v1.4.5 / v1.4.4 的完整包名修复。

## 安装方式

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

安装完成后**重启 dsh web 服务**，打开 `http://127.0.0.1:3080` → **设置 → 远程控制** 即可使用。

## 本版更新（v1.4.6）

### 🐛 修复启用远程控制后写坏 profile 的 cordis.patch.yml（服务启动即崩溃）

在设置页开启「远程控制」并重启服务后，dsh 启动即崩溃，日志报：

```
Error: dsh: failed to parse overlay C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml:
YAMLException: end of the stream or a document separator is expected (7:1)
```

**根因**：官方模板生成的 profile patch 文件内容是 `# user patch layer for this profile\n[]`（空数组占位）。插件开启远程控制 / 外网隧道时，往文件**末尾追加** `- id: webserver` 列表块，但未先移除 `[]` 占位行，导致同一文件出现两个 YAML 文档且无 `---` 分隔符，js-yaml 无法解析。

**本版修复**：写入前过滤掉裸 `[]` 占位行（`setPatchEnabled` / `ensureTrustedHost`），patch 文件始终是单一 YAML 数组，已用官方 `entryListSchema` 验证可解析。

### 🐛 修复客户端插件加载失败（client-modules: loaded without registering）

安装本插件后 WebUI 报错：

```
Failed to load plugins
failed to import loader entry 374151e3 (@feiyang666/dsh-mobile-remote):
client-modules: bundle /plugins/@feiyang666/dsh-mobile-remote/client.js?rev=...
loaded without registering "@feiyang666/dsh-mobile-remote" via __ModuleLoader__.load
```

**根因**：client 侧 bundle（`lib/client.js`）中 `window.__ModuleLoader__.load` 的 `id` 写成了无 scope 的裸包名 `dsh-mobile-remote`，而 client-modules 按完整包名 `@feiyang666/dsh-mobile-remote` 校验注册结果，导致校验失败、客户端插件无法加载。

**本版修复**：`__ModuleLoader__.load` 的 `id` 改为完整包名 `@feiyang666/dsh-mobile-remote`，与 `dsh-vault`、`dsh-usage-plugin` 等官方插件的 client bundle 写法一致。

> 本版同时包含 v1.4.4 的修复：`cordis.patch.yml` 的 `name` 改为完整包名（修复 dsh 服务启动崩溃 `Cannot find package 'dsh-mobile-remote'`）。

> 已安装旧版本的用户：请先卸载本插件（桌面端「插件管理」或 `dsh plugin --profile web remove @feiyang666/dsh-mobile-remote`），再重新安装本修复版。

## 已知事项

- 开启后服务暴露到公网，**请务必设置远程访问密码**，并仅在可信网络上使用
- 外网隧道需确保服务器 `.env` 的 `FRP_TOKEN` 与 `/www/server/frps/frps.toml` 的 `auth.token` 完全一致，否则面板会明确提示鉴权失败

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
