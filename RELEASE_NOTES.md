# dsh-mobile-remote v2.0.1

> v2.0.1 仅修正外网入口探测：本机证书链不可信（网络加速器中间人 TLS）时不再误报不可达，
> 会降级跳过校验重试一次并记录 `verify:false`。功能与 v2.0.0 一致。

**（v2.0.0 说明如下）**

**DeepSeek Harness 远程访问插件** —— 在 Web UI 设置页内置「远程控制」：连接二维码、一键开关、在线设备数，让手机通过局域网 / 外网访问并操控电脑上的 DeepSeek Harness。移动端界面从 v2.0.0 起**完全交给官方 dsh**（0.2.2 已自带）。

## 本版更新（v2.0.0）

一句话：**适配「dsh 自己就绑在网卡上」的启动方式，并把外网 502 从"假在线"里揪出来；同时删掉所有自研移动端 UI 补丁。**

### 修掉的两个真实故障

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| 局域网明明能访问，插件却显示**未开启**、**不显示二维码** | dsh 用 `--host 192.168.x.x` 启动时只监听那块网卡，`127.0.0.1` 上没有任何监听。旧版旁挂听众去绑**同一个** `<网卡IP>:<端口>` → `EADDRINUSE` → `running=false` | 新增 `bindInfo()`：`direct` 形态直接认定「局域网已可达」，只补其余网卡并跳过宿主已占用的地址；二维码/地址列表把宿主绑定地址排第一 |
| 外网域名打开就是 **502 Bad Gateway**，面板却显示「在线」 | frpc 配置里的 `localIP = "127.0.0.1"` 转发到一个没人监听的端口，frps 与 nginx 侧只能回 502 | frpc 的 `localIP` 跟随宿主真实监听地址（非回环时改成网卡 IP）；并新增**外网入口 30s HTTP 可达性探测**，502 直接在面板标红 |

### 移动端适配全部移除

官方 dsh 0.2.2 起自带移动端适配（`<768px` 侧栏浮层抽屉 + 遮罩、`1024px` 自动塌缩、移动 UA 不抢焦点、iOS 软键盘光标修正、PWA 清单），继续注入自己的 CSS 只会和官方改动互相打架：

- 删除全部移动端 CSS（composer 换行 / 选择器限宽 / 16px 防缩放 / Tooltip 抑制 / 设置页单栏 / 菜单钳制 / 抽屉样式）；
- 删除「上传图片」按钮与模拟 paste/drop 的图片 intake 逻辑（官方 `+ → 文件` 与粘贴/拖放链路已有）；
- 删除自研 Toast、发送状态浮层、侧栏悬浮按钮与抽屉、设置弹窗结构打标；
- 保留：设备心跳脚本（设置页「已连接设备」需要）、`crypto.randomUUID` 内网兜底（在门禁脚本里）、远程访问密码门禁。

### 其它

- `lib/lanproxy.js`：`start(hosts, port, { upstreamHost, skipHosts })`，转发上游可定制、已占用地址自动跳过；`status()` 增加 `upstream`。
- `lib/index.js`：`/status` 新增 `direct`（宿主直连形态）与 `lan.upstream`；`toggle` 在直连形态返回 `direct: true` 并说明需要改启动参数才能关闭；`external` 新增 `localHost` / `probe`。
- `lib/client.js`：直连形态下开关置灰并显示「局域网直连 · 由 dsh 提供」说明卡；外网卡片展示入口探测结果。
- 版本号提升到 **2.0.0**（移除移动端 UI 属于行为变更）。

### 验证

- `node --test tests/patch.test.mjs`：43 项断言通过。
- 新增 `tests/bind-aware.test.mjs`：4 项断言通过（上游可定制、`skipHosts` 不重复绑、全部被占用时不误报失败、frpc `localIP` 跟随宿主）。
- 实测环境：Windows + dsh 0.2.2（`--host 192.168.3.119 --port 3080`）。修复前：`127.0.0.1:3080` = `ECONNREFUSED`，`/status` 返回 `remoteEnabled:false`，公网域名 nginx 502；修复后 `direct` 形态下 `remoteEnabled:true`、二维码正常，frpc `localIP` 改为宿主网卡地址。
