// dsh-mobile-remote — DSH 移动端远程控制插件（host 侧）。
//
// 两大职责：
//   1. **移动端呈现层补丁**：向 Web UI index.html 注入移动端 CSS/JS
//      （composer 输入栏窄屏适配 + iOS 触控优化），不破坏 DSH 原生交互。
//   2. **远程控制设置 API**（`/__dsh_remote/*`）：
//      - `GET  /__dsh_remote/status`   返回当前监听 host / port / LAN IP 列表 /
//                                       远程控制开关状态 / 当前活跃设备数；
//      - `POST /__dsh_remote/toggle`   开启或关闭远程控制（写入 / 移除
//                                       profile 的 cordis.patch.yml，经官方 HMR
//                                       watcher 热重载 webserver 行，无需重启）；
//      - `POST /__dsh_remote/heartbeat` 移动端设备心跳上报，用于统计在线设备数；
//      - `GET  /__dsh_remote/qr`       返回连接二维码（SVG，URL 为局域网地址）。
//
// 为什么命令行启动也能远程控制（不需要桌面端）：
//   官方 CLI 出于安全拒绝 `--host 0.0.0.0`（见 dsh-web-app/startup.ts），但
//   官方 `--patch <overlay>` / profile 的 cordis.patch.yml 配置层完整支持
//   `webserver.host: 0.0.0.0`，且 profile patch 由 app-boot 的 watchUserPatches
//   通过 Cordis HMR 热重载。因此本插件在设置页切换开关 = 写入 / 移除 profile
//   patch 的 webserver 行，即可让 dsh 重新监听所有网卡——与桌面端 `--patch`
//   overlay 机制一致，官方 CLI 用户无需安装桌面端。
//
// 零运行时依赖（除 lib/qrcode.js 内联的 MIT QR 生成器）：
//   不 import 任何 dsh-client / dsh-host 内部包，仅使用 Node 内置模块与
//   webServer 服务公开的 tapIndex / register 接口。

import { networkInterfaces } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import qrcode from './qrcode.js'

/** 插件名（loader 诊断用）。 */
export const name = 'dsh-mobile-remote'

/** 依赖 dsh-host-webserver 注入的 webServer 服务，保证 tapIndex / register 可用。 */
export const inject = ['webServer']

/** 移动端断点：与 DSH 原生 SIDEBAR_AUTO_COLLAPSE = 1024 对齐。 */
const MOBILE_MAX_WIDTH = 1024

/** 心跳过期时间（毫秒）：超过该时长未上报的设备视为离线。 */
const HEARTBEAT_TTL = 90_000

/** 心跳清理定时器间隔（毫秒）。 */
const HEARTBEAT_SWEEP = 30_000

/**
 * 插件入口。webServer 服务就绪后被调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // 当前监听地址在服务启动时即确定。
  const remoteEnabled = ctx.webServer.host === '0.0.0.0'
  const port = ctx.webServer.port

  // 活跃设备表：deviceId -> 最近心跳时间戳。
  const devices = new Map()

  ctx.effect(() => {
    const dispose = ctx.webServer.tapIndex((html) => injectIntoIndex(html, remoteEnabled))
    return () => dispose()
  }, 'dsh-mobile-remote: index transform')

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/status', handler: handleStatus(ctx, devices) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/toggle', handler: handleToggle(ctx) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/heartbeat', handler: handleHeartbeat(devices) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/qr', handler: handleQr() }),
    ]
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, seen] of devices) {
        if (now - seen > HEARTBEAT_TTL) devices.delete(id)
      }
    }, HEARTBEAT_SWEEP)
    return () => {
      clearInterval(timer)
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-mobile-remote: api routes')
}

/* ------------------------------------------------------------------ */
/* 远程控制 API                                                         */
/* ------------------------------------------------------------------ */

/** 读取响应体的 JSON（仅 POST）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

/** 发送 JSON 响应。 */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** 本机局域网 IPv4 地址列表（不含回环）。 */
function getLanAddresses() {
  const out = []
  for (const entries of Object.values(networkInterfaces() ?? {})) {
    for (const iface of entries ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

/** 当前 profile 的 cordis.patch.yml 绝对路径。 */
function patchFilePath(ctx) {
  // DSH_HOME 环境变量优先，否则 ~/.dsh；profile 名为 DSH_PROFILE 或默认 web。
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'web'
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * 从 profile 的 cordis.patch.yml 中读取补丁列表（YAML 数组）。
 * 不引入 yaml 依赖：远程控制仅需对 webserver 行做增删，采用精确文本匹配。
 * @returns {{ file: string, content: string, lines: string[] }}
 */
function readPatchFile(ctx) {
  const file = patchFilePath(ctx)
  const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return { file, content, lines: content.split(/\r?\n/) }
}

/** webserver 远程控制覆盖块的行区间（含分隔注释）。不存在返回 null。 */
function findRemoteBlock(lines) {
  const start = lines.findIndex((l) => l.includes('# --- dsh-mobile-remote managed'))
  if (start === -1) return null
  const end = lines.findIndex((l, i) => i > start && l.includes('# --- end dsh-mobile-remote managed'))
  if (end === -1) return { start, end: lines.length }
  return { start, end: end + 1 }
}

/** 检查当前 patch 中是否已启用远程控制。 */
function isPatchEnabled(ctx) {
  const { lines } = readPatchFile(ctx)
  const block = findRemoteBlock(lines)
  if (!block) return false
  return lines.slice(block.start, block.end).some((l) => l.includes("host: '0.0.0.0'"))
}

/** 追加 / 移除 webserver host 覆盖块。 */
function setPatchEnabled(ctx, enabled) {
  const { file, content, lines } = readPatchFile(ctx)
  const block = findRemoteBlock(lines)
  let out = lines.slice()

  if (block) {
    out.splice(block.start, block.end - block.start)
  }
  if (enabled) {
    const blockLines = [
      '',
      '# --- dsh-mobile-remote managed (auto-generated; do not edit) ---',
      '- id: webserver',
      '  config:',
      "    host: '0.0.0.0'",
      '    port: !!js ctx.webStartup.port ?? ' + (ctx.webServer.port || 3080),
      '# --- end dsh-mobile-remote managed ---',
      '',
    ]
    out = [...out, ...blockLines]
  }

  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(file, next, 'utf8')
  return { file, enabled }
}

/** GET /__dsh_remote/status */
function handleStatus(ctx, devices) {
  return async (req, res) => {
    const lan = getLanAddresses()
    const remoteEnabled = ctx.webServer.host === '0.0.0.0'
    json(res, 200, {
      host: ctx.webServer.host,
      port: ctx.webServer.port,
      lanAddresses: lan,
      remoteEnabled,
      patchEnabled: isPatchEnabled(ctx),
      deviceCount: devices.size,
      patchFile: patchFilePath(ctx),
      url: lan.length ? `http://${lan[0]}:${ctx.webServer.port}` : null,
      cliHint: remoteEnabled
        ? null
        : 'remote control is off; toggle it in settings or start dsh with --patch',
    })
  }
}

/** POST /__dsh_remote/toggle { enabled: boolean } */
function handleToggle(ctx) {
  return async (req, res) => {
    const body = await readBody(req)
    const enabled = body.enabled === true
    try {
      const result = setPatchEnabled(ctx, enabled)
      json(res, 200, {
        ok: true,
        enabled,
        note: enabled
          ? 'patch written; dsh HMR will re-listen on 0.0.0.0'
          : 'patch removed; dsh HMR will re-listen on 127.0.0.1',
        patchFile: result.file,
      })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }
}

/** POST /__dsh_remote/heartbeat { id?: string, ua?: string } */
function handleHeartbeat(devices) {
  return async (req, res) => {
    const body = await readBody(req)
    const id = typeof body.id === 'string' && body.id ? body.id : 'anonymous'
    devices.set(id, Date.now())
    json(res, 200, { ok: true, deviceCount: devices.size })
  }
}

/** GET /__dsh_remote/qr?url=... */
function handleQr() {
  return async (req, res) => {
    const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('url')
    const url = raw && /^https?:\/\//i.test(raw) ? raw : null
    if (!url) {
      json(res, 400, { ok: false, error: 'missing or invalid url param' })
      return
    }
    try {
      const qr = qrcode(0, 'M')
      qr.addData(url, 'Byte')
      qr.make()
      const svg = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true })
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
      res.end(svg)
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }
}

/* ------------------------------------------------------------------ */
/* 移动端呈现层补丁                                                     */
/* ------------------------------------------------------------------ */

/**
 * 把移动端 CSS/JS 注入到 index.html。优先注入到 </head> 之前，
 * 找不到则退化为追加到文档末尾。
 */
function injectIntoIndex(html, remoteEnabled) {
  const bootConfig =
    '<script id="dsh-mobile-remote-config">window.__DSH_MOBILE_REMOTE__ = ' +
    JSON.stringify({ lanEnabled: remoteEnabled, mobileMaxWidth: MOBILE_MAX_WIDTH }) +
    ';</script>'
  const style = `<style id="dsh-mobile-remote-css">${MOBILE_CSS}</style>`
  const script = `<script id="dsh-mobile-remote-js">${MOBILE_JS}</script>`
  const injection = bootConfig + style + script

  if (html.includes('</head>')) {
    return html.replace('</head>', `${injection}\n</head>`)
  }
  return html + injection
}

/* ------------------------------------------------------------------ */
/* 移动端响应式 CSS                                                     */
/* 作用：仅修补 composer 输入栏在窄屏下的挤压/粘连，并做 iOS 触屏优化。   */
/* 不动 sidebar / details / frame / 任何 React 渲染结构。                 */
/* ------------------------------------------------------------------ */

const MOBILE_CSS = `
/* === dsh-mobile-remote 移动端输入栏补丁 ===
 * 作用范围：仅在移动设备（<1024px）下生效。DSH 原生已经在 <1024px 时把侧边栏
 * 折叠为 rail 并提供原生汉堡按钮，本补丁不碰那一套，只修 composer。
 *
 * 选择器结构（packages/client/ui-conversation/src/client/skeleton/InputBar.tsx）：
 *   [data-composer-card]  ← composer 卡片根
 *     ├ [data-input-scroll]  ← 文本输入滚动区
 *     └ div:last-child       ← 工具行 .row
 *         ├ div:first-child  ← .tools（+ 按钮、访问模式、安全模式 select）
 *         └ div:last-child   ← .trailing（模型 select、上下文计量、发送按钮）
 */

html[data-dsh-mobile] {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

html[data-dsh-mobile] body {
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  overscroll-behavior-y: contain;
}

/* ----- 输入栏工具行：窄屏下允许换行，避免左右两侧的选择器互相挤压粘连 ----- */
html[data-dsh-mobile] [data-composer-card] > div:last-child {
  flex-wrap: wrap;
  row-gap: 6px;
}

/* 左半区（+ 按钮 + 访问模式 + 安全模式）可收缩 */
html[data-dsh-mobile] [data-composer-card] > div:last-child > div:first-child {
  flex: 1 1 auto;
  min-width: 0;
}

/* 右半区（模型选择 + 上下文 + 发送）换到第二行右对齐，与左半区彻底分开 */
html[data-dsh-mobile] [data-composer-card] > div:last-child > div:last-child {
  flex: none !important;
  width: 100% !important;
  justify-content: flex-end !important;
}

/* 工具行内的所有 <select>（选择模型 / 选择安全模式等）限宽防溢出 + 加大触控目标 */
html[data-dsh-mobile] [data-composer-card] select {
  max-width: min(46vw, 200px) !important;
  min-height: 36px;
  font-size: 14px;
}

/* 工具行内的按钮加大触控目标（44px 苹果 HIG 推荐） */
html[data-dsh-mobile] [data-composer-card] > div:last-child button {
  min-width: 40px;
  min-height: 40px;
}

/* ----- iOS 触屏优化：输入框字号 >= 16px 防止聚焦自动缩放 ----- */
html[data-dsh-mobile] textarea,
html[data-dsh-mobile] input[type='text'],
html[data-dsh-mobile] input[type='search'] {
  font-size: 16px !important;
}
`

/* ------------------------------------------------------------------ */
/* 移动端设备检测 + 心跳上报：仅设置 html[data-dsh-mobile] 标记，并定时向  */
/* host 上报设备在线状态（供设置页“当前连接的设备数量”统计）。              */
/* 不注入任何 UI、不修改任何 React 状态、不动任何 DOM 节点。              */
/* ------------------------------------------------------------------ */

const MOBILE_JS = `
(function () {
  'use strict';

  var cfg = window.__DSH_MOBILE_REMOTE__ || { lanEnabled: false, mobileMaxWidth: 1024 };
  var MAX_WIDTH = cfg.mobileMaxWidth || 1024;

  /* 设备检测：移动 UA，或触屏 + 窄视口。与 DSH 原生 SIDEBAR_AUTO_COLLAPSE 同界。 */
  function isMobile() {
    var ua = navigator.userAgent || '';
    var mobileUA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
    var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    var narrow = Math.min(window.innerWidth, (window.screen && window.screen.width) || Infinity) <= MAX_WIDTH;
    return mobileUA || (touch && narrow);
  }

  if (!isMobile()) return;

  document.documentElement.setAttribute('data-dsh-mobile', '');

  // 设备心跳：稳定标识 + 30s 间隔上报，host 统计在线设备数。
  try {
    var KEY = '__dsh_mobile_remote_device';
    var id = localStorage.getItem(KEY);
    if (!id) {
      id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, id);
    }
    function beat() {
      try {
        fetch('/__dsh_remote/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, ua: navigator.userAgent }),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    }
    beat();
    setInterval(beat, 30000);
  } catch (e) {}

  // 调试钩子：在控制台暴露状态，便于移动端远程排查。
  window.__DSH_MOBILE_REMOTE_READY__ = {
    mobile: true,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio || 1,
    lanEnabled: cfg.lanEnabled === true,
  };
})();
`

// 注意：不要添加 `export default apply`。cordis 的 Loader.unwrapExports 会优先取
// default 导出，若 default 是 apply 函数，会丢失 `name` / `inject` 命名导出
// （详见 vendor/loader/src/index.ts 的 unwrapExports 与 vendor/cordis/src/registry.ts
// 的 plugin()）。保持仅命名导出，loader 才能拿到完整的 { name, inject, apply }。
