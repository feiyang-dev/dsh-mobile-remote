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

import {
  networkInterfaces, homedir, hostname, cpus, totalmem, freemem,
  platform, release, arch, loadavg, uptime as osUptime,
} from 'node:os'
import { join, dirname } from 'node:path'
import {
  existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import qrcode from './qrcode.js'
import {
  startExternal, stopExternal, externalView,
  autoRestoreExternal, loadPersistedState, DEFAULT_SERVER_BASE,
  frpcLogTail,
} from './external.js'
import {
  hasPassword, verifyPassword, setPassword,
  isEnabled, login, verifyToken, revokeToken, clearSessions,
} from './password.js'

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

// ---- SSE 实时推送 ----
// 设备心跳 / 远程开关 / 外网隧道状态变化时通知订阅者（订阅端点 /__dsh_remote/events）。
// 无订阅者时是 no-op，插件独立使用不受影响。
const sseClients = new Set()

function notifyChanged() {
  if (sseClients.size === 0) return
  const payload = 'data: {"type":"changed","at":' + Date.now() + '}\n\n'
  for (const res of sseClients) {
    try { res.write(payload) } catch (e) { sseClients.delete(res) }
  }
}

/**
 * 插件入口。webServer 服务就绪后被调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // 当前监听地址在服务启动时即确定。
  const remoteEnabled = ctx.webServer.host === '0.0.0.0'
  const port = ctx.webServer.port

  // 活跃设备表：deviceId -> 详细设备信息（见 handleHeartbeat）。
  const devices = new Map()
  // 累计去重设备数 + 累计心跳数（进程生命周期内的统计，供设置页展示更丰富的数据）。
  const seenEver = new Set()
  let totalBeats = 0
  const tracker = {
    seenEver,
    recordBeat() { totalBeats += 1 },
    beats: () => totalBeats,
  }

  // 外网隧道状态（frpc 子进程 + 配置）。
  const external = { proc: null, status: 'idle', url: null, domain: null, tunnelPort: null }

  ctx.effect(() => {
    const dispose = ctx.webServer.tapIndex((html) => injectIntoIndex(html, remoteEnabled))
    return () => dispose()
  }, 'dsh-mobile-remote: index transform')

  ctx.effect(() => {
    // DSH 应用层状态缓存（版本 / 会话 / 工作区 / 插件 / 模型），后台定时刷新，
    // status 请求直接读缓存，避免 sessionPersistence.list() 拖慢每 5s 的轮询。
    const dshCache = { value: null, at: 0 }
    const refreshDsh = () => { void refreshDshInfo(ctx, dshCache) }
    refreshDsh()
    const dshTimer = setInterval(refreshDsh, 60_000)

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/status', handler: authGate(handleStatus(ctx, devices, external, tracker, dshCache)) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/toggle', handler: authGate(handleToggle(ctx)) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/heartbeat', handler: authGate(handleHeartbeat(devices, tracker)) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/qr', handler: authGate(handleQr()) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/external/start', handler: authGate(handleExternalStart(ctx, external)) }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/external/stop', handler: authGate(handleExternalStop(ctx, external)) }),
      // frpc 运行日志读取（供设置页展示外网隧道详细状态）
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/external/log', handler: authGate(handleExternalLog()) }),
      // —— SSE 实时事件流：设备心跳 / 远程开关 / 外网隧道状态变化时推送 {"type":"changed"} ——
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/events', handler: authGate(handleEvents()) }),
      // —— 远程访问密码门禁相关（auth 系列不套 authGate，需放行）——
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/auth-status', handler: handleAuthStatus() }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/auth', handler: handleAuth() }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/logout', handler: handleLogout() }),
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/set-password', handler: handleSetPassword() }),
      // —— Service Worker：远程访问首屏缓存加速（仅 HTTPS 外网生效）——
      ctx.webServer.register({ kind: 'exact', path: '/__dsh_remote/sw.js', handler: handleServiceWorker() }),
    ]
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, info] of devices) {
        if (now - info.lastSeen > HEARTBEAT_TTL) devices.delete(id)
      }
    }, HEARTBEAT_SWEEP)
    // dsh 重启后自动恢复外网访问：读取持久化的绑定码 / 中转地址重新拉起 frpc，
    // 免去每次手动输入。设置 DSH_DISABLE_AUTO_RESTORE=1 可关闭该行为。
    if (process.env.DSH_DISABLE_AUTO_RESTORE !== '1') {
      const patchFile = patchFilePath(ctx)
      void autoRestoreExternal(external, patchFile, ctx.webServer.port || 3080)
    }
    return () => {
      clearInterval(timer)
      clearInterval(dshTimer)
      stopFrpc(external)
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-mobile-remote: api routes')
}

/** 后台刷新 DSH 应用层状态缓存（失败时保留旧值或置 null）。 */
async function refreshDshInfo(ctx, cache) {
  try {
    cache.value = await collectDshInfo(ctx)
    cache.at = Date.now()
  } catch {
    cache.value = null
  }
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

/** 所有 IPv4 网卡详情（含网卡名 / 掩码 / MAC / CIDR / 是否回环），供设置页展示。 */
function getLanInterfaces() {
  const out = []
  for (const [name, entries] of Object.entries(networkInterfaces() ?? {})) {
    for (const iface of entries ?? []) {
      if (iface.family !== 'IPv4') continue
      out.push({
        name,
        address: iface.address,
        netmask: iface.netmask || null,
        mac: iface.mac || '',
        cidr: iface.cidr || null,
        internal: iface.internal === true,
      })
    }
  }
  return out
}

/** 当前进程运行时信息（诊断用，设置页展示）。 */
function runtimeInfo() {
  const mem = process.memoryUsage()
  const cpu = cpus()
  const load = loadavg()
  const total = totalmem()
  return {
    pid: process.pid,
    hostname: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    cpus: cpu.length,
    cpuModel: (cpu[0] && cpu[0].model) ? cpu[0].model : null,
    cpuSpeed: (cpu[0] && cpu[0].speed) ? cpu[0].speed : null,
    loadavg: Array.isArray(load) ? load.map((n) => Number(n.toFixed(2))) : null,
    sysUptime: Math.floor(osUptime()),
    totalmem: total,
    freemem: freemem(),
    memPct: total > 0 ? Math.round((1 - freemem() / total) * 100) : null,
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    profile: process.env.DSH_PROFILE || 'web',
    dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
  }
}

/** 给异步操作加超时保护，超时返回 fallback（默认 null），避免拖慢 status 响应。 */
function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/** 多位置探测 dsh 版本号（profile 本地 / 桌面版 / 全局安装）。找不到返回 null。 */
function detectDshVersion() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'web'
  const candidates = [
    join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, 'dsh-desktop', 'dsh-local', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    )
  }
  candidates.push(join(dirname(process.execPath), '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const f of candidates) {
    try {
      if (!existsSync(f)) continue
      const pkg = JSON.parse(readFileSync(f, 'utf8'))
      if (pkg && typeof pkg.version === 'string') return pkg.version
    } catch { /* ignore */ }
  }
  return null
}

/**
 * 采集 DSH 应用层状态（尽力而为，任一失败/不可用都降级为 null）：
 * 版本号 / 会话总数 / 工作区列表 / 已安装插件 / LLM 提供方。
 * 通过 ctx.get() 可选获取服务，不注入必选依赖，避免插件在精简启动下起不来。
 */
async function collectDshInfo(ctx) {
  const out = { version: null, sessions: null, workspaces: null, plugins: null, llm: null }
  try { out.version = detectDshVersion() } catch { /* ignore */ }
  try {
    const sp = ctx.get('sessionPersistence')
    if (sp && typeof sp.list === 'function') {
      const headers = await withTimeout(sp.list(), 2000)
      if (Array.isArray(headers)) out.sessions = headers.length
    }
  } catch { /* ignore */ }
  try {
    const wr = ctx.get('workspaceRegistry')
    if (wr && typeof wr.list === 'function') {
      const list = wr.list()
      if (Array.isArray(list)) {
        out.workspaces = list.map((w) => ({
          path: w.path,
          title: w.title || '',
          sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
          updatedAt: w.updatedAt || null,
        }))
      }
    }
  } catch { /* ignore */ }
  try {
    const pi = ctx.get('pluginInventory')
    if (pi && typeof pi.list === 'function') {
      const snap = pi.list()
      if (snap && Array.isArray(snap.entries)) {
        out.plugins = snap.entries.map((e) => ({
          name: e.moduleName || e.entryId,
          enabled: e.enabled === true,
          phase: e.fiberPhase || null,
        }))
      }
    }
  } catch { /* ignore */ }
  try {
    const llm = ctx.get('llm')
    if (llm && typeof llm.listProviders === 'function') {
      const ps = llm.listProviders()
      if (Array.isArray(ps)) {
        out.llm = ps.map((p) => ({ id: p.id, name: p.name || p.id }))
      }
    }
  } catch { /* ignore */ }
  return out
}

/** 从 User-Agent 推断设备名称。 */
function deviceNameFromUA(ua) {
  const s = String(ua || '')
  if (s.includes('iPhone')) return 'iPhone'
  if (s.includes('iPad')) return 'iPad'
  if (s.includes('Android')) return 'Android 设备'
  if (s.includes('Windows')) return 'Windows 电脑'
  if (s.includes('Macintosh') || s.includes('Mac OS')) return 'Mac 电脑'
  if (s.includes('CrOS')) return 'Chromebook'
  if (s.includes('Linux')) return 'Linux 设备'
  if (!s) return '未知设备'
  return '浏览器'
}

/** 从 User-Agent 推断操作系统（用于设备详情展示）。 */
function osFromUA(ua) {
  const s = String(ua || '')
  if (/iPhone|iPad|iPod/i.test(s)) return 'iOS'
  if (/Android/i.test(s)) return 'Android'
  if (/Windows NT 10/i.test(s)) return 'Windows 10/11'
  if (/Windows NT/i.test(s)) return 'Windows'
  if (/Mac OS X/i.test(s)) return 'macOS'
  if (/CrOS/i.test(s)) return 'ChromeOS'
  if (/Linux/i.test(s)) return 'Linux'
  if (!s) return '未知系统'
  return '其他系统'
}

/** 从 User-Agent 推断浏览器内核 / 名称（用于设备详情展示）。 */
function browserFromUA(ua) {
  const s = String(ua || '')
  if (/Edg\//i.test(s)) return 'Edge'
  if (/OPR\/|Opera/i.test(s)) return 'Opera'
  if (/Firefox\//i.test(s)) return 'Firefox'
  if (/Chrome\//i.test(s)) return 'Chrome'
  if (/Safari\//i.test(s)) return 'Safari'
  if (!s) return '未知浏览器'
  return '其他浏览器'
}

/** 从请求中提取客户端 IP：优先代理转发头（frpc/nginx 会加），回退 socket 地址。 */
function clientIpFromReq(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) {
    const first = String(fwd).split(',')[0].trim()
    if (first) return first
  }
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim()
  return (req.socket && req.socket.remoteAddress) || null
}

/* ------------------------------------------------------------------ */
/* 远程访问密码门禁（host 侧）                                           */
/* ------------------------------------------------------------------ */

/** 会话 cookie 名。 */
const AUTH_COOKIE = '__dsh_remote_auth'

/**
 * 判断当前请求是否为“远程访问”（外网隧道 / 经 HTTPS 反代进入）。
 * 依据：外网隧道由 Nginx 反代并设置 X-Forwarded-Proto: https，或 socket 本身
 * 已加密（TLS）。本机 127.0.0.1 与局域网直连（http）不带该头 → 视为内网，
 * 不强制密码。这样管理员在本机/内网总能正常使用与修复。
 * @param {import('node:http').IncomingMessage} req
 */
function isRemoteRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase()
  if (proto === 'https') return true
  if (req.socket && req.socket.encrypted) return true
  return false
}

/** 从请求 Cookie 头解析某个 cookie 的值（未找到返回 null）。 */
function parseCookie(req, name) {
  const raw = String(req.headers.cookie || '')
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    const k = pair.slice(0, idx).trim()
    if (k === name) return pair.slice(idx + 1).trim()
  }
  return null
}

/** 是否满足远程访问鉴权：远程且已设密码时要求有效 token。 */
function authorized(req) {
  if (!isRemoteRequest(req)) return true
  if (!isEnabled()) return true
  return verifyToken(parseCookie(req, AUTH_COOKIE))
}

/** 远程访问鉴权中间件（注册给需要保护的 path 使用）。 */
function authGate(handler) {
  return (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'AUTH_REQUIRED', message: '请先输入远程访问密码' }))
      return
    }
    return handler(req, res)
  }
}

/** GET /__dsh_remote/events：SSE 实时事件流。设备心跳 / 远程开关 / 外网隧道状态变化时推送。 */
function handleEvents() {
  return (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(':ok\n\n')
    sseClients.add(res)
    req.on('close', () => { sseClients.delete(res) })
  }
}

/** GET /__dsh_remote/auth-status：返回远程访问密码的启用状态与本次请求是否需鉴权。 */
function handleAuthStatus() {
  return async (req, res) => {
    json(res, 200, {
      ok: true,
      enabled: isEnabled(),
      // 仅当是远程访问且已设密码时才需要输入
      required: isRemoteRequest(req) && isEnabled(),
      authenticated: authorized(req),
      remote: isRemoteRequest(req),
    })
  }
}

/** POST /__dsh_remote/auth { password }：校验远程访问密码并签发会话 token（写入 cookie）。 */
function handleAuth() {
  return async (req, res) => {
    // 仅远程访问才允许（本机内网无需走这步，但仍可被调用）
    const body = await readBody(req)
    const password = typeof body.password === 'string' ? body.password : ''
    const ip = clientIpFromReq(req)
    const result = login(password, ip)
    if (!result.ok) {
      json(res, 401, { ok: false, code: 'BAD_PASSWORD', message: result.error || '密码错误' })
      return
    }
    const cookie = `${AUTH_COOKIE}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` + (isRemoteRequest(req) ? '; Secure' : '')
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': cookie,
    })
    res.end(JSON.stringify({ ok: true, authenticated: true }))
  }
}

/** POST /__dsh_remote/logout：撤销当前会话。 */
function handleLogout() {
  return async (req, res) => {
    revokeToken(parseCookie(req, AUTH_COOKIE))
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    })
    res.end(JSON.stringify({ ok: true }))
  }
}

/**
 * POST /__dsh_remote/set-password { password }（仅本机/内网来源可用）：
 * 设置或修改远程访问密码。远程来源被拒绝，防止外部任意篡改。空密码=清除。
 */
function handleSetPassword() {
  return async (req, res) => {
    if (isRemoteRequest(req)) {
      json(res, 403, { ok: false, code: 'LOCAL_ONLY', message: '仅限在本机设置远程访问密码' })
      return
    }
    const body = await readBody(req)
    const password = typeof body.password === 'string' ? body.password : ''
    // 密码强度检查
    if (password && password.length < 4) {
      json(res, 400, { ok: false, code: 'WEAK_PASSWORD', message: '密码至少 4 位' })
      return
    }
    if (password && password.length > 128) {
      json(res, 400, { ok: false, code: 'BAD_PASSWORD', message: '密码过长（最多 128 位）' })
      return
    }
    const result = setPassword(password)
    json(res, 200, Object.assign({ ok: true }, result))
  }
}

/* ------------------------------------------------------------------ */
/* Service Worker：远程访问首屏加速                                      */
/* ------------------------------------------------------------------ */

/**
 * 处理 GET /__dsh_remote/sw.js —— 返回 Service Worker 脚本。
 *
 * 背景：dsh 的静态服务（frontend-static）响应头只有 content-type，没有
 * Cache-Control / gzip。远程（外网 HTTPS）访问时，浏览器每次都要全量重新
 * 下载 ~1.25MB 的前端资源，经 frp 隧道每个文件要 1~2 秒，导致首屏
 * "Loading plugins…" 转圈很久。
 *
 * 方案：注册一个 Service Worker（SW 只在 HTTPS 下生效，正好覆盖外网访问；
 * 内网 http 不启用，但内网直连本来就快）。SW 对 `/assets/*.js|css`（文件名
 * 带内容哈希，内容不可变）做 cache-first 缓存——首次访问后，后续访问直接
 * 命中浏览器缓存秒开；DSH 更新后资源文件名哈希变化，浏览器自动加载新文件，
 * 不会出现旧版本。
 *
 * 响应头必须带 `Service-Worker-Allowed: /`，否则浏览器不允许把 SW 的 scope
 * 扩展到根路径（SW 脚本位于 /__dsh_remote/ 下，默认 scope 只覆盖该子路径）。
 */
function handleServiceWorker() {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      // SW 本身不缓存或短缓存：保证 DSH 更新后 SW 能及时拿到新版本
      'Cache-Control': 'no-cache',
    })
    res.end(SERVICE_WORKER_JS)
  }
}

/** Service Worker 脚本体（cache-first 缓存 /assets/ 下的 js/css）。 */
const SERVICE_WORKER_JS = `
'use strict';
/* dsh-mobile-remote 远程访问加速 SW：缓存 /assets/ 下带内容哈希的静态资源。
 * 文件名带哈希（如 index-C-1AiF3k.js）→ 内容不变则文件名不变 → 可安全
 * cache-first；DSH 更新后文件名哈希变化 → 自动回源加载新文件。 */
var CACHE_NAME = 'dsh-remote-static-v1';
var CACHE_PATTERN = /^\\/assets\\/.*\\.(js|css)$/;

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (!CACHE_PATTERN.test(url.pathname)) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(event.request).then(function (hit) {
        if (hit) return hit;
        return fetch(event.request).then(function (resp) {
          if (resp && resp.ok) cache.put(event.request, resp.clone());
          return resp;
        });
      });
    }).catch(function () {
      return fetch(event.request);
    })
  );
});
`

/**
 * 从中转服务器查询本成员隧道状态与统计；失败时返回 null（不影响整体 status）。
 * 优先调用 /api/tunnel/stats（含 frps 实时流量/连接数等），接口不可用则回退到
 * /api/tunnel/status（旧版后端）。任一失败返回 null。
 */
async function queryServerStatus(base, bindCode) {
  if (!bindCode) return null
  const server = String(base || DEFAULT_SERVER_BASE).replace(/\/$/, '')
  const call = (path) => fetch(`${server}${path}`, {
    headers: { Accept: 'application/json' },
    // 避免无限期挂起，5 秒超时
    signal: AbortSignal.timeout(5000),
  }).then(async (res) => {
    if (!res.ok) return null
    const body = await res.json()
    return body && body.success ? body.data : null
  }).catch(() => null)
  const q = `?bindCode=${encodeURIComponent(bindCode)}`
  const stats = await call(`/api/tunnel/stats${q}`)
  if (stats) return stats
  return call(`/api/tunnel/status${q}`)
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
  // 移除官方模板的空数组占位行 `[]`：它单独构成一个 YAML 文档，与追加的
  // 列表块拼接会形成无 `---` 分隔符的多文档流，js-yaml 解析报
  // "end of the stream or a document separator is expected"，导致 dsh 服务启动即崩溃。
  out = out.filter((l) => l.trim() !== '[]')

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
function handleStatus(ctx, devices, external, tracker, dshCache) {
  return async (req, res) => {
    const lan = getLanAddresses()
    const remoteEnabled = ctx.webServer.host === '0.0.0.0'
    // 外网 frpc 是否仍在运行
    const extRunning = !!external.proc && external.proc.exitCode === null
    // 已持久化的绑定信息（重启后自动恢复用，前端据此回填表单）
    const persisted = loadPersistedState()
    // 活跃设备详情列表（按最近活跃倒序）
    const deviceList = []
    for (const [id, info] of devices) {
      deviceList.push({
        id,
        ip: info.ip || null,
        name: info.name || '未知设备',
        os: info.os || '未知系统',
        browser: info.browser || '未知浏览器',
        ua: info.ua || '',
        platform: info.platform || '',
        lang: info.lang || '',
        online: info.online === true,
        touch: info.touch === true,
        dpr: info.dpr || null,
        screen: info.screen || '',
        viewport: info.viewport || '',
        connection: info.connection || null,
        path: info.path || '',
        title: info.title || '',
        mobile: info.mobile === true,
        beatCount: info.beatCount || 1,
        battery: info.battery || null,
        deviceMemory: info.deviceMemory || null,
        hardwareConcurrency: info.hardwareConcurrency || null,
        firstSeen: info.firstSeen,
        lastSeen: info.lastSeen,
      })
    }
    deviceList.sort((a, b) => b.lastSeen - a.lastSeen)
    // 外网隧道在线时，向中转服务器查询成员真实状态（成员名 / frps 在线 / 最后心跳）
    let server = null
    if (extRunning && persisted) {
      server = await queryServerStatus(persisted.serverBase || undefined, persisted.bindCode)
    }
    json(res, 200, {
      host: ctx.webServer.host,
      port: ctx.webServer.port,
      lanAddresses: lan,
      lanInterfaces: getLanInterfaces(),
      remoteEnabled,
      patchEnabled: isPatchEnabled(ctx),
      deviceCount: devices.size,
      devices: deviceList,
      patchFile: patchFilePath(ctx),
      url: lan.length ? `http://${lan[0]}:${ctx.webServer.port}` : null,
      // 本机运行时信息（诊断用，设置页展示更详细的数据）
      runtime: runtimeInfo(),
      uptime: Math.floor(process.uptime()),
      nodeVersion: process.version,
      totalDevicesEver: tracker.seenEver.size,
      totalHeartbeats: tracker.beats(),
      // DSH 应用层状态（版本 / 会话 / 工作区 / 插件 / 模型；后台缓存，可能为 null）
      dsh: dshCache ? dshCache.value : null,
      // 外网隧道字段（status 直接透传 externalView 的真实状态：
      // online=隧道已建立 / connecting / error=鉴权失败等 / stopped / idle）
      external: {
        enabled: extRunning,
        running: extRunning,
        status: external.status || 'idle',
        url: extRunning ? external.url : null,
        domain: external.domain,
        tunnelPort: external.tunnelPort,
        frpcVersion: external.frpcVersion || null,
        pid: extRunning && external.proc ? external.proc.pid : null,
        startedAt: external.startedAt || null,
        bindCodeShort: persisted && persisted.bindCode
          ? String(persisted.bindCode).slice(0, 4) + '****'
          : '',
        error: external.error || null,
        defaultServerBase: DEFAULT_SERVER_BASE,
        persisted: persisted
          ? { bindCode: persisted.bindCode || '', serverBase: persisted.serverBase || '' }
          : null,
        // 中转服务器返回的成员状态（外网在线时才有）
        server,
      },
      // 远程访问密码门禁状态（供设置面板展示）
      auth: {
        enabled: isEnabled(),
        requiredHere: isRemoteRequest(req) && isEnabled(),
        authenticated: authorized(req),
      },
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
      notifyChanged() // 远程开关变化：通知 SSE 订阅者
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

/** POST /__dsh_remote/heartbeat（移动端上报的详细设备元数据，见下方 MOBILE_JS）。 */
function handleHeartbeat(devices, tracker) {
  return async (req, res) => {
    const body = await readBody(req)
    const id = typeof body.id === 'string' && body.id ? body.id : 'anonymous'
    const now = Date.now()
    const prev = devices.get(id)
    tracker.seenEver.add(id)
    tracker.recordBeat()
    const conn = (body.connection && typeof body.connection === 'object') ? body.connection : null
    const battery = (body.battery && typeof body.battery === 'object')
      ? { level: Number(body.battery.level) || null, charging: body.battery.charging === true }
      : null
    devices.set(id, {
      ip: clientIpFromReq(req),
      ua: String(body.ua || ''),
      name: deviceNameFromUA(body.ua),
      os: osFromUA(body.ua),
      browser: browserFromUA(body.ua),
      platform: String(body.platform || ''),
      lang: String(body.lang || ''),
      online: body.online === true,
      touch: body.touch === true,
      dpr: Number(body.dpr) || null,
      screen: String(body.screen || ''),
      viewport: String(body.viewport || ''),
      connection: conn,
      battery,
      deviceMemory: Number(body.deviceMemory) || null,
      hardwareConcurrency: Number(body.hardwareConcurrency) || null,
      path: String(body.path || ''),
      title: String(body.title || ''),
      mobile: body.mobile === true,
      beatCount: prev ? prev.beatCount + 1 : 1,
      firstSeen: prev ? prev.firstSeen : now,
      lastSeen: now,
    })
    notifyChanged() // 设备状态更新：通知 SSE 订阅者
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
/* ------------------------------------------------------------------ */
/* 外网隧道管理（中转服务 + frpc）—— 见 lib/external.js                  */
/* ------------------------------------------------------------------ */

/** POST /__dsh_remote/external/start { bindCode?, serverBase?, localPort? } */
function handleExternalStart(ctx, external) {
  return async (req, res) => {
    let body = {}
    try { body = await readBody(req) } catch { /* ignore */ }
    try {
      const patchFile = patchFilePath(ctx)
      const result = await startExternal(external, body, patchFile, ctx.webServer.port || 3080)
      notifyChanged() // 外网隧道启动：通知 SSE 订阅者
      json(res, 200, Object.assign({ ok: true }, result))
    } catch (error) {
      external.error = String(error?.message || error)
      notifyChanged() // 启动失败也通知（前端可感知错误状态）
      json(res, 500, { ok: false, error: external.error })
    }
  }
}

/** POST /__dsh_remote/external/stop */
function handleExternalStop(ctx, external) {
  return async (req, res) => {
    stopExternal(external)
    notifyChanged() // 外网隧道停止：通知 SSE 订阅者
    json(res, 200, { ok: true, enabled: false })
  }
}

/** GET /__dsh_remote/external/log：返回 frpc 运行日志尾部，供设置页排查外网隧道问题。 */
function handleExternalLog() {
  return async (req, res) => {
    json(res, 200, { ok: true, log: frpcLogTail() })
  }
}

/** 停止 frpc（apply 清理时调用）。keepState 保留持久化，重启后自动恢复。 */
function stopFrpc(external) {
  stopExternal(external, { keepState: true })
}
function injectIntoIndex(html, remoteEnabled) {
  const bootConfig =
    '<script id="dsh-mobile-remote-config">window.__DSH_MOBILE_REMOTE__ = ' +
    JSON.stringify({ lanEnabled: remoteEnabled, mobileMaxWidth: MOBILE_MAX_WIDTH }) +
    ';</script>'
  const gateStyle = `<style id="dsh-mobile-remote-gate-css">${GATE_CSS}</style>`
  const gateScript = `<script id="dsh-mobile-remote-gate-js">${GATE_JS}</script>`
  const style = `<style id="dsh-mobile-remote-css">${MOBILE_CSS}</style>`
  const script = `<script id="dsh-mobile-remote-js">${MOBILE_JS}</script>`
  // 门禁脚本注入在 head 最前，确保在 DSH 界面渲染前就绪
  const injection = bootConfig + gateStyle + gateScript + style + script

  if (html.includes('</head>')) {
    return html.replace('</head>', `${injection}\n</head>`)
  }
  return html + injection
}

/* ------------------------------------------------------------------ */
/* 远程访问密码门禁：样式 + 前端脚本                                      */
/* 作用：当本次访问是“远程”（外网隧道 / HTTPS 反代）且管理员已设置密码时，  */
/* 在 DSH 界面加载前弹出全屏密码验证遮罩。输对密码后种会话 cookie 并重载。  */
/* 不输密码无法操作 DSH（遮罩拦截所有交互）。                              */
/* ------------------------------------------------------------------ */

const GATE_CSS = `
#dsh-remote-gate {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(15, 17, 26, 0.92);
  backdrop-filter: blur(6px);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #e8e8ea;
}
#dsh-remote-gate .gate-card {
  width: min(360px, 88vw); box-sizing: border-box;
  background: #1d2030; border: 1px solid rgba(255,255,255,.12);
  border-radius: 14px; padding: 24px 22px;
  box-shadow: 0 18px 50px rgba(0,0,0,.45);
}
#dsh-remote-gate .gate-title {
  font-size: 17px; font-weight: 700; margin: 0 0 6px;
}
#dsh-remote-gate .gate-sub {
  font-size: 13px; color: #9aa0b5; margin: 0 0 16px; line-height: 1.5;
}
#dsh-remote-gate .gate-input {
  width: 100%; box-sizing: border-box;
  padding: 10px 12px; font-size: 14px; color: #e8e8ea;
  background: #14171f; border: 1px solid rgba(255,255,255,.18);
  border-radius: 9px; outline: none;
}
#dsh-remote-gate .gate-input:focus { border-color: #4c8dff; }
#dsh-remote-gate .gate-btn {
  width: 100%; margin-top: 12px; padding: 10px 12px;
  font-size: 14px; font-weight: 600; color: #fff;
  background: #2a7de1; border: none; border-radius: 9px; cursor: pointer;
}
#dsh-remote-gate .gate-btn:hover { background: #3a8df0; }
#dsh-remote-gate .gate-btn:disabled { opacity: .6; cursor: default; }
#dsh-remote-gate .gate-err {
  font-size: 12px; color: #ff6b6b; margin-top: 10px; min-height: 16px;
}
#dsh-remote-gate .gate-loading { opacity: .6; }
`

const GATE_JS = `
(function () {
  'use strict';

  /* 内网 http（非安全上下文）兜底：crypto.randomUUID 仅在 HTTPS / localhost 存在，
     而 DSH 客户端连接时会直接调用 crypto.randomUUID()（dsh-client-connection 的
     createMessage / mintRpcId），非安全上下文下缺失会抛 "crypto.randomUUID is not
     a function"，导致内网远程连接失败（外网 https 正常）。此处用 getRandomValues
     （非安全上下文也可用）补一个 RFC 4122 v4 实现，让内网访问/扫码连接恢复正常。
     本脚本注入于 <head>，先于 DSH 应用 bundle 执行，故对应用内所有调用点生效。 */
  var __cryptoShim = globalThis.crypto;
  if (__cryptoShim) {
    /* 部分浏览器非安全上下文里 randomUUID 不是 undefined，而是存在但调用即抛
       NotSupportedError；此处试调一次并校验返回字符串，两种情况都判定为不可用。 */
    var __uuidUsable = false;
    try {
      __uuidUsable = typeof __cryptoShim.randomUUID === 'function'
        && typeof __cryptoShim.randomUUID() === 'string';
    } catch (e) { __uuidUsable = false; }
    if (!__uuidUsable) {
      try {
        __cryptoShim.randomUUID = function () {
          var b = __cryptoShim.getRandomValues(new Uint8Array(16));
          b[6] = (b[6] & 0x0f) | 0x40;
          b[8] = (b[8] & 0x3f) | 0x80;
          var h = '';
          for (var i = 0; i < b.length; i++) {
            var x = b[i].toString(16);
            if (x.length === 1) x = '0' + x;
            h += x;
          }
          return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
        };
      } catch (e) { /* 写入 crypto 失败则放弃，交由 DSH 自身逻辑处理 */ }
    }
  }

  function canCover() {
    try { return document.getElementById('dsh-remote-gate') === null; } catch (e) { return true; }
  }
  function createGate() {
    if (!canCover()) return;
    var g = document.createElement('div');
    g.id = 'dsh-remote-gate';
    g.innerHTML =
      '<div class="gate-card">' +
        '<p class="gate-title">远程访问已锁定</p>' +
        '<p class="gate-sub">请输入管理员设置的远程访问密码以继续使用。</p>' +
        '<input class="gate-input" type="password" autocomplete="current-password" placeholder="远程访问密码" />' +
        '<button class="gate-btn" type="button">进入</button>' +
        '<p class="gate-err"></p>' +
      '</div>';
    document.documentElement.appendChild(g);
    return g;
  }
  function hideGate(g) { try { g.parentNode && g.parentNode.removeChild(g); } catch (e) {} }
  function submit(g, input, btn) {
    var pwd = input.value;
    if (!pwd) { g.querySelector('.gate-err').textContent = '请输入密码'; return; }
    btn.disabled = true; btn.classList.add('gate-loading');
    fetch('/__dsh_remote/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    }).then(function (r) {
      if (!r.ok) throw new Error('密码错误');
      return r.json();
    }).then(function () {
      window.location.reload();
    }).catch(function (e) {
      btn.disabled = false; btn.classList.remove('gate-loading');
      g.querySelector('.gate-err').textContent = String(e && e.message || e);
      input.select();
    });
  }
  function init() {
    if (!canCover()) return;
    fetch('/__dsh_remote/auth-status', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        if (!st || !st.required || st.authenticated) return;
        var g = createGate();
        if (!g) return;
        var input = g.querySelector('.gate-input');
        var btn = g.querySelector('.gate-btn');
        var doSubmit = function () { submit(g, input, btn); };
        btn.addEventListener('click', doSubmit);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSubmit(); });
        input.focus();
      })
      .catch(function () { /* auth-status 不可达（本机直连等）时不遮罩 */ });
  }

  /* 远程访问首屏加速：注册 Service Worker，缓存 /assets/ 下带哈希的静态资源。
   * 仅 HTTPS（外网隧道）下浏览器才允许注册 SW；内网 http 自动跳过。 */
  function registerSw() {
    try {
      if (!('serviceWorker' in navigator)) return;
      if (location.protocol !== 'https:') return;
      navigator.serviceWorker.register('/__dsh_remote/sw.js', { scope: '/' })
        .catch(function () { /* 注册失败不阻塞页面 */ });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); registerSw(); });
  } else {
    init();
    registerSw();
  }
})();
`

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

/* ----- 移动端 Tooltip 抑制 -----
 * DSH 原生 Tooltip 气泡由 hover / focus 触发（<span role="tooltip">）。
 * 触屏设备上没有 hover，点击按钮后焦点停留在按钮上，气泡会一直显示在屏幕上
 * （点击空白 / 滚动也不会消失）——即“停止 / 开始 / 关闭菜单栏等按钮的提示文字
 * 常驻屏幕”问题。移动端直接隐藏气泡，按钮仍保留 aria-label 无障碍名。
 */
html[data-dsh-mobile] [role='tooltip'] {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ----- 移动端设置页适配 -----
 * 原生设置弹窗是 800px 双栏布局（188px 导航栏 + 内容列），手机上内容被挤得
 * 几乎没有空间。由 MOBILE_JS 的 MutationObserver 把设置弹窗打上
 * data-dsh-settings 标记（结构：role=dialog 且首个子元素为 <nav>），这里改为
 * 全屏单栏：导航栏变顶部横向滚动标签，内容区独占剩余空间。
 * 不依赖 harness 内部哈希类名，harness 升级后仍能直接适配。
 */
html[data-dsh-mobile] [data-dsh-settings] {
  display: flex !important;
  flex-direction: column !important;
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100vh !important;
  height: 100dvh !important;
  max-height: 100vh !important;
  max-height: 100dvh !important;
  border-radius: 0 !important;
}

/* 导航栏：横向标签条，可横向滚动 */
html[data-dsh-mobile] [data-dsh-settings] > nav {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  width: 100% !important;
  flex: none !important;
  padding: 8px 10px !important;
  gap: 6px !important;
  overflow-x: auto !important;
  -webkit-overflow-scrolling: touch;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18)) !important;
}

/* 导航标题（设置面板的标题文案）在移动端隐藏，省出空间给标签 */
html[data-dsh-mobile] [data-dsh-settings] > nav > div:first-child {
  display: none !important;
}

/* 导航列表：横向排列、宽度自适应内容 */
html[data-dsh-mobile] [data-dsh-settings] > nav > div + div {
  display: flex !important;
  flex-direction: row !important;
  width: max-content !important;
  gap: 6px !important;
}

/* 导航项：胶囊标签，加大触控目标 */
html[data-dsh-mobile] [data-dsh-settings] nav button {
  flex: none !important;
  height: 36px !important;
  padding: 0 14px !important;
  gap: 6px !important;
  border-radius: 999px !important;
  white-space: nowrap !important;
}

/* 内容列：占满剩余空间。
 * min-height:0 是关键——flex 子项默认 min-height:auto，内容列无法收缩到
 * 比自身内容更矮，导致内容撑高后被面板 overflow:hidden 裁掉、内部 .options
 * 区永远拿不到受限高度而不能滚动。设为 0 后内容列可收缩，把高度让给
 * .options（其自身 overflow-y:auto）去内部滚动。 */
html[data-dsh-mobile] [data-dsh-settings] > div {
  width: 100% !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
}

/* 顶部 header 的按钮（关闭等）加大触控目标 */
html[data-dsh-mobile] [data-dsh-settings] > div > div:first-child button {
  min-width: 36px !important;
  min-height: 36px !important;
}

/* 内容区边距收紧，让 section 内容有更多可用宽度 */
html[data-dsh-mobile] [data-dsh-settings] > div > div:last-child {
  padding: 0 12px 16px !important;
}

/* ----- 移动端上传图片按钮（composer 工具行，+ 加号旁）-----
 * 由 MOBILE_JS 注入到 [data-composer-card] 工具行。视觉上与 DSH 原生
 * 加号按钮同款（28px 圆、selector 填充），保证窄屏下排在一起不突兀。
 */
html[data-dsh-mobile] [data-composer-card] .dsh-mr-attach {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--dsw-specific-selector, #ececee);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 100ms ease;
}
html[data-dsh-mobile] [data-composer-card] .dsh-mr-attach:active {
  background: var(--dsw-alias-interactive-bg-hover-solid, #e0e0e3);
}
html[data-dsh-mobile] [data-composer-card] .dsh-mr-attach:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 发送状态指示：composer 上方的「上传中 / 发送中」小浮层（含旋转 spinner）。
 * 位置：absolute 相对 [data-composer-card]（其 position:relative 且无
 * overflow 裁剪），贴在卡片上沿外侧。 */
html[data-dsh-mobile] [data-composer-card] .dsh-mr-sending {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-surface-solid, #ffffff);
  border: 1px solid var(--dsw-alias-divider, rgba(0, 0, 0, 0.08));
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  line-height: 1.4;
  color: var(--dsw-alias-text-tertiary, #666);
}
html[data-dsh-mobile] [data-composer-card] .dsh-mr-sending .dsh-mr-spinner {
  width: 14px;
  height: 14px;
  flex: none;
  border: 2px solid var(--dsw-alias-divider, rgba(0, 0, 0, 0.12));
  border-top-color: currentColor;
  border-radius: 50%;
  animation: dsh-mr-spin 0.8s linear infinite;
}
@keyframes dsh-mr-spin {
  to { transform: rotate(360deg); }
}

/* ----- 移动端上传轻提示气泡（自备极简 Toast）----- */
#dsh-mr-toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 2147483000;
  max-width: min(86vw, 340px);
  padding: 9px 16px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  color: var(--dsw-alias-label-primary-inverted, #fff);
  background: var(--dsw-alias-button-contrast-fill, rgba(0, 0, 0, 0.82));
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  pointer-events: none;
  opacity: 0;
  animation: dsh-mr-toast-in 2.4s ease forwards;
}
@keyframes dsh-mr-toast-in {
  0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
  8% { opacity: 1; transform: translateX(-50%) translateY(0); }
  86% { opacity: 1; }
  100% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
}

/* ----- 移动端图片缩略图 rail：删除按钮触控目标加大 -----
 * DSH 原生 AttachmentRail 的删除按钮只有 18px，触屏上太小。
 * 结构：rail([role=group]) > item(div) > button(缩略图) + button(删除)。
 */
html[data-dsh-mobile] [data-composer-card] [role='group'] > div > button:last-child {
  width: 24px !important;
  height: 24px !important;
}

/* ----- 移动端弹窗（权限选择 / 模型选择菜单）适配 -----
 * DSH 的 Menu（PermissionSelect 权限选择）与 ModelSelect（模型选择）都是
 * 绝对定位浮层且不含 viewport 水平钳制：
 *   - 权限菜单 .list：left:0 + min-width:218px / max-width:360px——锚点在
 *     左区时菜单向右展开，容易超出屏幕右侧；
 *   - 模型菜单 .menu：right:0 + width:min(240px, calc(100vw-32px))——锚点
 *     在右区时向左展开，容易向左偏/遮挡左侧工具区。
 * 这里：
 *   - 权限菜单（无 aria-label）统一限制宽度不超屏；水平位置由 MOBILE_JS
 *     在菜单出现时用 translateX 钳制到视口内（无 transform 动画，可安全平移）；
 *   - 模型菜单（带 aria-label 的 [role=menu]）在移动端改为「底部抽屉」
 *     （bottom sheet）：贴底、宽度自适应屏幕、高度受限内部滚动，不再从
 *     锚点向左侧/上方展开遮挡 composer 左侧的 + / 上传图片等按钮。
 */
html[data-dsh-mobile] [data-composer-card] [role='menu'] {
  max-width: calc(100vw - 16px) !important;
}

/* 模型选择菜单（ModelSelect 的 .menu 带 aria-label，可据此与权限菜单区分；
 * 不依赖 harness 内部哈希类名）——移动端底部抽屉样式 */
html[data-dsh-mobile] [data-composer-card] [role='menu'][aria-label] {
  position: fixed !important;
  top: auto !important;
  left: 8px !important;
  right: 8px !important;
  bottom: 24px; /* fallback：不支持 max()/env() 的旧浏览器也保持上移 */
  bottom: max(24px, env(safe-area-inset-bottom, 24px)) !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  max-height: 62vh !important;
  z-index: 1000 !important;
  border-radius: 16px !important;
  overflow: hidden !important;
  overscroll-behavior: contain !important;
}

/* ----- 移动端插件宽表兜底：防止被压成逐字竖排 -----
 * dsh-usage-plugin 的「消耗表 / 消耗明细 / 每日统计」等 9–11 列宽表依赖其
 * 自身在运行时注入的全局样式（.dsh-usage-table{min-width:720px} + ≤540px
 * 折叠中间列）来避免列被压到极限宽度。若该样式因 CSP 或加载时序未生效，
 * 手机窄屏下每列会被压到约 1 字符宽、内容逐字竖排、数据无法阅读。
 * 本插件（dsh-mobile-remote）的样式是随 index.html 一起由服务端下发的，
 * 必定生效，因此作为可靠兜底：
 *   - 宽表强制 min-width:720px，配合其外层 overflow-x 容器横向滑动，始终可读；
 *   - ≤540px 时对带 collapse-mobile 的宽表隐藏第 4 列至倒数第 2 列，只保留
 *     前 3 个主标识列 + 最后合计列，手机上一屏即可看全关键数据；
 *   - 价格表等窄表（无 collapse-mobile）不折叠，保留横向滚动。
 */
html[data-dsh-mobile] .dsh-usage-table {
  min-width: 720px !important;
}
@media (max-width: 540px) {
  html[data-dsh-mobile] .dsh-usage-table.collapse-mobile tr > *:not(:nth-child(-n+3)):not(:last-child) {
    display: none !important;
  }
  html[data-dsh-mobile] .dsh-usage-table.collapse-mobile {
    min-width: 320px !important;
  }
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

  // 设备心跳：稳定标识 + 30s 间隔上报，host 统计并展示"已连接设备"。
  // 所有访问本 DSH 的浏览器（PC + 手机）都上报，仅移动端才打 data-dsh-mobile 标记。
  try {
    var KEY = '__dsh_mobile_remote_device';
    var id = localStorage.getItem(KEY);
    if (!id) {
      id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, id);
    }
    // 采集当前设备元数据，随心跳上报，host 在设置页展示详细设备信息。
    // 电池信息为异步获取，首次拿到后缓存在变量中，后续心跳一并上报。
    var batteryLevel = null;
    var batteryCharging = null;
    try {
      if (navigator.getBattery) {
        navigator.getBattery().then(function (b) {
          batteryLevel = Math.round((b && b.level) * 100);
          batteryCharging = !!(b && b.charging);
        }).catch(function () {});
      }
    } catch (e) {}
    function deviceMeta() {
      var scr = window.screen || {};
      var scrStr = (scr.width && scr.height)
        ? (scr.width + '\u00d7' + scr.height + (scr.colorDepth ? ' @ ' + scr.colorDepth + 'bit' : ''))
        : '';
      var conn = navigator.connection || null;
      var langs = navigator.languages || [];
      var title = '';
      try { title = document.title || ''; } catch (e) {}
      return {
        id: id,
        ua: navigator.userAgent,
        platform: navigator.platform || '',
        lang: navigator.language || (langs.length ? langs[0] : '') || '',
        online: navigator.onLine === true,
        touch: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0),
        dpr: window.devicePixelRatio || 1,
        screen: scrStr,
        viewport: window.innerWidth + '\u00d7' + window.innerHeight,
        deviceMemory: navigator.deviceMemory || null,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        battery: (batteryLevel === null) ? null : { level: batteryLevel, charging: batteryCharging },
        connection: conn ? {
          effectiveType: conn.effectiveType || null,
          downlink: (typeof conn.downlink === 'number') ? conn.downlink : null,
          rtt: (typeof conn.rtt === 'number') ? conn.rtt : null,
          saveData: conn.saveData === true,
        } : null,
        path: (location.pathname || '/') + (location.search || ''),
        title: title,
        mobile: isMobile(),
      };
    }
    function beat() {
      try {
        fetch('/__dsh_remote/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(deviceMeta()),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    }
    beat();
    setInterval(beat, 30000);
  } catch (e) {}

  if (!isMobile()) return;

  document.documentElement.setAttribute('data-dsh-mobile', '');

  // 标记设置弹窗：原生设置页 = role="dialog" 且首个子元素为 <nav>（双栏弹窗）。
  // 打上 data-dsh-settings 标记后，上面的移动端 CSS 可精确适配，无需依赖
  // harness 内部的哈希类名——harness 升级后只要弹窗结构仍是
  // “dialog 直下 nav + 内容列”，本插件无需修改即可直接适配。
  function tagSettingsPanel() {
    var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    for (var i = 0; i < dialogs.length; i++) {
      var dlg = dialogs[i];
      if (dlg.getAttribute('data-dsh-settings') === '1') continue;
      var kids = dlg.children;
      var hasNav = false;
      for (var j = 0; j < kids.length; j++) {
        if (kids[j].tagName === 'NAV') { hasNav = true; break; }
      }
      if (hasNav) dlg.setAttribute('data-dsh-settings', '1');
    }
  }
  tagSettingsPanel();
  if (typeof MutationObserver !== 'undefined') {
    // 设置弹窗是动态挂载/卸载的，用 MutationObserver 监听其出现并打标。
    var obs = new MutationObserver(function () { tagSettingsPanel(); });
    try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    window.__DSH_MOBILE_REMOTE_SETTINGS_OBSERVER__ = obs;
  }

  // 调试钩子：在控制台暴露状态，便于移动端远程排查。
  window.__DSH_MOBILE_REMOTE_READY__ = {
    mobile: true,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio || 1,
    lanEnabled: cfg.lanEnabled === true,
  };

  /* ==================================================================
   * 移动端上传图片（composer 加号旁的「上传图片」入口）
   * ----------------------------------------------------------------
   * DSH 桌面端原生支持图片消息（粘贴 / 拖放均可，格式/数量/大小预检查、
   * 缩略图 rail、随消息上传全部由官方链路完成），但移动端没有「选择图片」
   * 的入口：工具行的 + 按钮只打开命令菜单。
   *
   * 此处注入一个图片按钮 + 隐藏的 <input type=file>。用户在手机上通过
   * 系统相册 / 文件选择器选图后，用普通对象模拟 clipboardData / dataTransfer
   * （不依赖 new DataTransfer()，iOS Safari 兼容性差）派发 paste 事件——
   * DSH 的 onPaste 原生 intakeImages 自动接管；若 paste 未生效，再回退向
   * document 派发 drop 事件（DSH 的文档级 onDrop 同样走 intakeImages）。
   * 全程不依赖 DSH 内部 API，harness 升级后只要 paste / drop 链路还在即可
   * 正常工作。
   * ================================================================== */

  // 轻提示：DSH 的 Toast 是内部组件，这里自备一个极简气泡。
  var mrToastTimer = null;
  function mrToast(text) {
    var old = document.getElementById('dsh-mr-toast');
    if (old) { try { old.parentNode.removeChild(old); } catch (e) {} }
    var t = document.createElement('div');
    t.id = 'dsh-mr-toast';
    t.textContent = text;
    (document.body || document.documentElement).appendChild(t);
    if (mrToastTimer) clearTimeout(mrToastTimer);
    mrToastTimer = setTimeout(function () {
      try { t.parentNode && t.parentNode.removeChild(t); } catch (e) {}
    }, 2400);
  }

  // 隐藏的文件选择器（全局唯一，选完即重置，可重复选同一张图）。
  // 注意：本脚本注入在 <head>，此时 document.body 可能尚未创建；若直接
  // 挂到 documentElement，部分 iOS WebView 会拒绝 .click() 打开选择器，
  // 因此等 body 就绪后再挂载（change 监听与挂载时机无关）。
  var mrFileInput = document.createElement('input');
  mrFileInput.type = 'file';
  mrFileInput.accept = 'image/*';
  mrFileInput.multiple = true;
  mrFileInput.tabIndex = -1;
  mrFileInput.setAttribute('aria-hidden', 'true');
  mrFileInput.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  mrFileInput.addEventListener('change', function () {
    var files = [];
    try { files = Array.prototype.slice.call(mrFileInput.files || []); } catch (e) {}
    if (files.length > 0) mrIntakeFiles(files);
    try { mrFileInput.value = ''; } catch (e) {}
  });
  function mrMountFileInput() {
    var host = document.body || document.documentElement;
    if (host && !mrFileInput.parentNode) host.appendChild(mrFileInput);
  }
  if (document.body) mrMountFileInput();
  else document.addEventListener('DOMContentLoaded', mrMountFileInput, { once: true });

  // ===== 图片 intake：兼容各种浏览器的事件派发 =====
  // DSH 原生 intake 读两个事件：
  //   - onPaste（React 合成事件）：e.clipboardData.items —— 只要求 items
  //     可迭代、每项 kind==='file' 且 getAsFile() 返回真实 File；
  //   - onDrop（document 原生监听器）：e.dataTransfer.types / .files。
  // 我们不构造 DataTransfer / ClipboardEvent（iOS Safari 上
  // new DataTransfer() + items.add() 之后 files 返回空 FileList、
  // item.getAsFile() 可能返回 null，兼容性差），而是用普通 JS 对象
  // 模拟这两个接口——任何浏览器都可靠。结果用「缩略图是否真的出现」
  // 判断（不依赖 defaultPrevented——locked/machineBusy 时 DSH 也会
  // preventDefault）。

  // 当前 composer 附件缩略图数量（rail 渲染后计数）。
  function mrCountRailImages() {
    try { return document.querySelectorAll('[data-composer-card] [role="group"] img').length; } catch (e) { return 0; }
  }

  // 构造模拟 clipboardData（供 onPaste 使用）：items 是普通数组，每项
  // 的 kind='file'、getAsFile() 返回真实 File；getData/setData/clearData
  // 补齐 DSH onPaste 会调用的接口（缺 getData 会抛 TypeError 导致 React
  // 事件处理器崩溃）。绕开 DataTransfer 构造器在 iOS Safari 上的 files
  // 为空 / getAsFile 返回 null 等兼容问题。
  function mrBuildClipboardData(images) {
    var items = [];
    for (var j = 0; j < images.length; j++) {
      (function (file) {
        items.push({
          kind: 'file',
          type: file.type || '',
          getAsFile: function () { return file; },
        });
      })(images[j]);
    }
    return {
      items: items,
      files: images,
      types: ['Files'],
      getData: function () { return ''; },
      setData: function () {},
      clearData: function () {},
    };
  }

  // 构造模拟 dataTransfer（供 onDrop 使用）：只读 .types / .files。
  function mrBuildDataTransfer(images) {
    return { files: images, types: ['Files'] };
  }

  // 向 document 派发 drop（DSH 的原生 onDrop 监听器会 intakeImages）。
  function mrDispatchDrop(dt) {
    try {
      var evt = new Event('drop', { bubbles: true, cancelable: true });
      try { evt.dataTransfer = dt; } catch (e) {}
      document.dispatchEvent(evt);
      return true;
    } catch (e) { return false; }
  }

  // 向 textarea 派发 paste（React 合成 onPaste 会 intakeImages）。
  function mrDispatchPaste(cd, textarea) {
    try {
      var evt = new Event('paste', { bubbles: true, cancelable: true });
      try { evt.clipboardData = cd; } catch (e) {}
      textarea.dispatchEvent(evt);
      return true;
    } catch (e) { return false; }
  }

  // 把选中的图片喂给 DSH 原生 intake。
  function mrIntakeFiles(files) {
    var textarea = document.querySelector('[data-composer-card] [data-input-scroll] textarea');
    if (!textarea) { mrToast('未找到输入框，请重试'); return; }
    if (textarea.disabled || textarea.readOnly) { mrToast('当前输入框不可用'); return; }
    var images = [];
    for (var i = 0; i < files.length; i++) {
      // 注意：本函数经模板字符串注入 <script>，正则里的反斜杠转义（\/）
      // 会被当作非转义序列丢弃（/^image\//i 变成 /^image//i，解析成除法，
      // 运行时抛 i.test is not a function）。因此这里用 indexOf 判断类型。
      if ((files[i].type || '').indexOf('image/') === 0) images.push(files[i]);
    }
    if (images.length === 0) { mrToast('请选择图片文件'); return; }
    var before = mrCountRailImages();
    // 方式一：paste（React onPaste 读 clipboardData.items，模拟对象对
    // iOS Safari / 安卓 / 桌面全兼容）。
    mrDispatchPaste(mrBuildClipboardData(images), textarea);
    setTimeout(function () {
      if (mrCountRailImages() > before) return;
      // 方式二：drop 到 document（原生监听器兜底）。
      mrDispatchDrop(mrBuildDataTransfer(images));
      setTimeout(function () {
        if (mrCountRailImages() > before) return;
        mrToast('图片未添加上，请长按输入框粘贴图片');
      }, 300);
    }, 300);
  }

  // 图片按钮：与 DSH 原生 + 按钮同风格的小圆钮（SVG 图片图标）。
  function mrMakeAttachBtn() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dsh-mr-attach';
    btn.setAttribute('aria-label', '上传图片');
    btn.title = '上传图片';
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">' +
        '<rect x="1.6" y="2.7" width="12.8" height="10.6" rx="2.3" stroke="currentColor" stroke-width="1.35"/>' +
        '<circle cx="5.4" cy="6.1" r="1.3" fill="currentColor"/>' +
        '<path d="M2.4 12.4L6.3 8.3a1.05 1.05 0 0 1 1.5 0l1.15 1.2 2.2-2.35a1.05 1.05 0 0 1 1.55 0l1.9 2.1" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (btn.disabled) return;
      try { mrFileInput.value = ''; } catch (err) {}
      mrFileInput.click();
    });
    return btn;
  }

  // 同步按钮禁用态：跟随 composer 的 textarea（session 移除 / 锁定 / 提交中）。
  function mrSyncAttachState(btn) {
    if (!btn) return;
    var textarea = document.querySelector('[data-composer-card] [data-input-scroll] textarea');
    btn.disabled = !textarea || textarea.disabled || textarea.readOnly;
  }

  // 把上传按钮插到工具行（+ 加号按钮之后）。
  function mrInjectAttach() {
    var card = document.querySelector('[data-composer-card]');
    if (!card || card.querySelector('.dsh-mr-attach')) return;
    var tools = card.querySelector(':scope > div:last-child > div:first-child');
    if (!tools) return;
    var btn = mrMakeAttachBtn();
    tools.insertBefore(btn, tools.children[1] || null);
    mrSyncAttachState(btn);
  }

  // ===== 移动端弹窗水平钳制 =====
  // 权限选择菜单是绝对定位浮层，不含 viewport 钳制，窄屏下容易向右溢出
  // 或向左偏（模型选择菜单在移动端已改为底部抽屉，由 CSS 定位并自带
  // 钳制，见 mrClampMenus 内的 fixed 跳过）。菜单出现/布局变化时读取
  // rect，用 translateX 把它平移回视口内（菜单无 transform 动画，平移
  // 安全；每次覆盖式设置，不会累积偏移）。隐藏中的菜单 rect 为 0，跳过。
  function mrClampMenus() {
    var menus = document.querySelectorAll('[data-composer-card] [role="menu"]');
    for (var i = 0; i < menus.length; i++) {
      var menu = menus[i];
      try {
        // 模型选择菜单在移动端已改为固定底部抽屉（bottom sheet），
        // 位置由 CSS 决定且自带视口钳制，跳过平移。
        if (window.getComputedStyle(menu).position === 'fixed') continue;
        var r = menu.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        var vw = window.innerWidth;
        var dx = 0;
        if (r.left < 8) dx = 8 - r.left;
        else if (r.right > vw - 8) dx = (vw - 8) - r.right;
        if (dx !== 0) menu.style.transform = 'translateX(' + dx + 'px)';
      } catch (e) { /* ignore */ }
    }
  }

  // ===== 发送状态指示 =====
  // DSH 点击发送后，machine 进入 'submitting'（消息）/ 'adjudicating'（命令
  // 裁决）phase：发送前要先把附件图片 serializeImages 成 base64 再 prompt，
  // 移动端大图这一步可能持续数秒，而会话列表要等发送成功才出现新消息，
  // 用户容易误以为「没发出去」而重发或离开。这里在 composer 上方显示
  // 「上传中 / 发送中」提示，phase 恢复后自动隐藏。只读 textarea 的
  // data-phase，不依赖 DSH 内部 API。
  var mrSendingEl = null;

  function mrMakeSendingEl() {
    var el = document.createElement('div');
    el.className = 'dsh-mr-sending';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    return el;
  }

  function mrShowSending() {
    var card = document.querySelector('[data-composer-card]');
    if (!card) return;
    // 会话切换时 composer 卡片会被重建，旧浮层节点会脱离 DOM，需重建挂载。
    if (!mrSendingEl || !mrSendingEl.isConnected) {
      mrSendingEl = mrMakeSendingEl();
      card.appendChild(mrSendingEl);
    }
    var hasImages = mrCountRailImages() > 0;
    mrSendingEl.innerHTML = '<span class="dsh-mr-spinner"></span>' +
      (hasImages ? '正在上传图片并发送…' : '正在发送…');
    mrSendingEl.style.display = '';
  }

  function mrHideSending() {
    if (mrSendingEl) mrSendingEl.style.display = 'none';
  }

  function mrSyncSending() {
    var textarea = document.querySelector('[data-composer-card] [data-input-scroll] textarea');
    if (!textarea) { mrHideSending(); return; }
    var phase = textarea.getAttribute('data-phase') || '';
    if (phase === 'submitting' || phase === 'adjudicating') mrShowSending();
    else mrHideSending();
  }

  function mrScan() {
    mrInjectAttach();
    var btn = document.querySelector('[data-composer-card] .dsh-mr-attach');
    mrSyncAttachState(btn);
    mrClampMenus();
    mrSyncSending();
  }

  // composer 是动态挂载/重建的（会话切换），用 MutationObserver 跟踪挂载
  // 与 textarea 锁定态变化；requestAnimationFrame 合并高频回调。
  mrScan();
  var mrScanPending = false;
  if (typeof MutationObserver !== 'undefined') {
    var mrObs = new MutationObserver(function () {
      if (mrScanPending) return;
      mrScanPending = true;
      requestAnimationFrame(function () {
        mrScanPending = false;
        mrScan();
      });
    });
    try {
      mrObs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'readonly', 'data-phase'],
      });
    } catch (e) {}
  }
})();
`

// 注意：不要添加 `export default apply`。cordis 的 Loader.unwrapExports 会优先取
// default 导出，若 default 是 apply 函数，会丢失 `name` / `inject` 命名导出
// （详见 vendor/loader/src/index.ts 的 unwrapExports 与 vendor/cordis/src/registry.ts
// 的 plugin()）。保持仅命名导出，loader 才能拿到完整的 { name, inject, apply }。
