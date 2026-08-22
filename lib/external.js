// dsh-mobile-remote — 外网隧道管理模块（host 侧）。
//
// 负责把"外网访问"做成一个开关：
//   - 从中转服务（dsh-update-server）通过绑定码换取 frpc 配置 + 外网链接
//   - 下载/定位 frpc 可执行文件，写入 frpc.toml 并启动子进程
//   - 写 profile 的 connection trustedHosts，放行外网域名（通过 /api 信任围栏）
//   - 心跳上报、状态查询、停止
//
// 零运行时依赖：仅 Node 内置模块。frpc 二进制由中转服务提供或用户本地放置。
//
// 稳健性说明（针对"开启难/开了又关"问题）：
//   - 强制给 frpc.toml 追加 loginFailExit=false：连不上 frps 时持续重试，
//     而不是立即自杀退出导致开关被前端刷回"关闭"。
//   - 若后端返回的 serverAddr 是回环地址（127.0.0.1/localhost），用环境变量
//     DSH_FRPS_SERVER 覆写为真正的宝塔 frps 公网地址（防止连到本机）。
//   - 启动后等待短暂时间确认子进程存活再判 online，避免"spawn 成功但秒退"误报。
//   - 期间状态标记为 connecting，前端可据此显示"正在连接…"而不是空转。

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, rmSync,
} from 'node:fs'
import { spawn } from 'node:child_process'

/** 默认中转服务地址（自建 dsh-update-server，Nginx 反代 443→3200，对外无端口）。
 *  可用 DSH_REMOTE_SERVER 覆盖。 */
const DEFAULT_SERVER_BASE = 'https://api.deepseekharness.desktop.cwj666.top'

/** 中转服务基地址：环境变量 > 请求传入 > 默认。 */
function serverBase(body) {
  return (
    (body && typeof body.serverBase === 'string' && body.serverBase.trim())
    || process.env.DSH_REMOTE_SERVER
    || DEFAULT_SERVER_BASE
  )
}

/** 外网状态本地持久化目录。 */
function externalDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-mobile-remote', 'external')
}

/* ------------------------------------------------------------------ */
/* 外网状态持久化：记录已启用的绑定信息，供 dsh 重启后自动恢复           */
/* ------------------------------------------------------------------ */

function stateFilePath() {
  return join(externalDir(), 'state.json')
}

/** 读取持久化的外网访问状态；未启用/损坏时返回 null。 */
function loadPersistedState() {
  try {
    const file = stateFilePath()
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || data.enabled !== true || !data.bindCode) return null
    return {
      bindCode: String(data.bindCode || ''),
      serverBase: String(data.serverBase || ''),
      localPort: Number(data.localPort) || 0,
      domain: String(data.domain || ''),
      url: String(data.url || ''),
      tunnelPort: Number(data.tunnelPort) || 0,
    }
  } catch {
    return null
  }
}

/** 保存当前启用的外网访问状态。 */
function savePersistedState(state) {
  try {
    mkdirSync(externalDir(), { recursive: true })
    writeFileSync(stateFilePath(), JSON.stringify({
      enabled: true,
      bindCode: state.bindCode || '',
      serverBase: state.serverBase || '',
      localPort: state.localPort || 0,
      domain: state.domain || '',
      url: state.url || '',
      tunnelPort: state.tunnelPort || 0,
      savedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch { /* 持久化失败不致命，仅无法自动恢复 */ }
}

/** 清除持久化的外网访问状态（用户主动关闭时调用）。 */
function clearPersistedState() {
  try { rmSync(stateFilePath(), { force: true }) } catch { /* ignore */ }
}

/** frpc 可执行文件路径。 */
function frpcBinaryPath() {
  return join(externalDir(), process.platform === 'win32' ? 'frpc.exe' : 'frpc')
}

/** frpc 配置文件路径。 */
function frpcConfigPath() {
  return join(externalDir(), 'frpc.toml')
}

/** 回环地址判断。 */
function isLoopback(addr) {
  const a = String(addr || '').trim().toLowerCase()
  return a === '127.0.0.1' || a === 'localhost' || a === '::1'
}

/** 匹配 frpc 配置里的 poolCount 字段（frp v0.59+ 已移除该客户端字段，
 *  残留会导致 "unmarshal ProxyConfig error: json: unknown field poolCount" → frpc 解析失败秒退）。
 *  既匹配顶层 transport.poolCount，也匹配裸 poolCount，统一剥离。 */
const POOL_COUNT_RE = /^\s*(transport\.)?poolCount\s*=.*(\r?\n|$)/gm

/**
 * 修正 frpc 配置文本：
 *   1) 若 serverAddr 是回环地址，用 DSH_FRPS_SERVER 覆写（如需连宝塔 frps）；
 *   2) 强制追加 loginFailExit = false，避免连不上就退出；
 *   3) 剥离 frp 客户端已不支持的 poolCount 字段（frp v0.59+ 已移除，改由
 *      连接复用 tcpMux 自动管理；服务端可能仍在下发该字段，本地一律剥离，
 *      否则 frpc 解析配置失败、启动即退出）。
 * @param {string} cfg - 后端返回的原始 frpc 配置
 * @returns {string} 修正后的配置
 */
function finalizeFrpcConfig(cfg) {
  let text = String(cfg || '')
  // 3) 先剥离 client 端已不支持的 poolCount 字段（放最前，保证后续注入干净）
  text = text.replace(POOL_COUNT_RE, '')
  // 1) serverAddr 回环地址覆写：优先 DSH_FRPS_SERVER，其次回退到提取到的非回环地址
  const override = process.env.DSH_FRPS_SERVER
  const addr = extractServerAddr(text)
  if (isLoopback(addr)) {
    if (!override) {
      // 没有可用的 frps 公网地址：抛出明确错误，避免连本机白耗
      throw new Error('中转配置里的 frps 地址是本机回环(127.0.0.1)。请在宝塔后端 .env 配 FRPS_SERVER=宝塔公网IP，或用环境变量 DSH_FRPS_SERVER 指定。')
    }
    text = text.replace(/^(\s*serverAddr\s*=\s*)[^\n]+/m, `$1"${override.trim()}"`)
  }
  // 2) loginFailExit 必须放顶层（第一个 [[proxies]] 之前），否则 frpc 解析报错
  if (!/loginFailExit\s*=/.test(text)) {
    const injectLine = '# 由 dsh-mobile-remote 注入：连不上 frps 时持续重试不退出\nloginFailExit = false\n'
    const proxiesIdx = text.indexOf('[[proxies]]')
    if (proxiesIdx >= 0) {
      // 在 [[proxies]] 之前插入（顶层全局配置）
      text = text.slice(0, proxiesIdx) + injectLine + '\n' + text.slice(proxiesIdx)
    } else {
      text = text.replace(/\s*$/, '\n') + '\n' + injectLine
    }
  }
  return text
}

/** 从 frpc 配置文本提取 serverAddr 的值。 */
function extractServerAddr(text) {
  const m = /^\s*serverAddr\s*=\s*["']([^"']+)["']/m.exec(text || '')
  return m ? m[1] : ''
}

/** 调中转服务 /api/tunnel/bind 换取配置。 */
async function bindToServer(body, localPort) {
  const base = serverBase(body)
  const res = await fetch(`${base.replace(/\/$/, '')}/api/tunnel/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bindCode: body && body.bindCode,
      localPort,
    }),
  })
  if (!res.ok) {
    let msg = `绑定失败 (HTTP ${res.status})`
    try { const j = await res.json(); if (j && j.message) msg = j.message } catch { /* ignore */ }
    throw new Error(msg)
  }
  const j = await res.json()
  if (!j || j.success !== true || !j.data) throw new Error('绑定响应无效')
  return j.data
}

/** 下载 frpc 可执行文件（从中转服务 /api/tunnel/frpc）。 */
async function downloadFrpc(base) {
  mkdirSync(externalDir(), { recursive: true })
  const bin = frpcBinaryPath()
  const res = await fetch(`${base.replace(/\/$/, '')}/api/tunnel/frpc`)
  if (!res.ok) throw new Error(`frpc 下载失败 (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(bin, buf, { mode: 0o755 })
  return bin
}

/**
 * 写 profile 的 connection trustedHosts，放行外网域名。
 * @param {string} patchFile - profile 的 cordis.patch.yml 绝对路径
 * @param {string} domain - 外网域名（不带端口）
 * @returns {boolean}
 */
/**
 * 写 profile 的 connection trustedHosts，放行外网域名。
 * 必须使用 loader 中的正确插件 id `connection`，并用 !!js 表达式保留
 * webRuntime 自动推导的 LAN/CLI trusted hosts，否则 patch 不生效 / 覆盖损坏。
 */
function ensureTrustedHost(patchFile, domain) {
  let content = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  // 移除官方模板的空数组占位行 `[]`（与 index.js setPatchEnabled 同理）：
  // 它单独构成一个 YAML 文档，与追加的列表块拼接会形成无分隔符的多文档流，
  // js-yaml 解析报 "end of the stream or a document separator is expected"。
  content = content.replace(/^\s*\[\s*\]\s*$/gm, '')
  // 1) 清理旧的错误块（id: client-connection 或旧格式的纯数组），避免堆积/语法冲突
  content = content.replace(/\n*(# --- dsh-mobile-remote external trusted-host ---)\n[\s\S]*?(# --- end dsh-mobile-remote external trusted-host ---)\n*/g, '\n')
  content = content.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  // 2) 若已含目标域名的正确配置则直接返回
  if (content.includes(`'${domain}'`)) return true
  // 3) 追加正确块：id=connection + !!js 表达式（保留 webRuntime.trustedHosts）
  // 注意：dsh-app-boot 的 entryListSchema（js-yaml JSON_SCHEMA + JsExpr）中 !!js 为
  // scalar kind，只能修饰标量字符串。若直接写在 flow sequence 前（!!js [...]），
  // js-yaml 会报 `unknown tag !<tag:yaml.org,2002:js>`，导致 profile 无法启动。
  // 因此表达式必须用双引号包成 YAML 标量，loader 求值时再还原为数组。
  const block = [
    '',
    '# --- dsh-mobile-remote external trusted-host ---',
    '- id: connection',
    '  config:',
    `    trustedHosts: !!js "['${domain}', ...ctx.webRuntime.trustedHosts]"`,
    '# --- end dsh-mobile-remote external trusted-host ---',
    '',
  ]
  const next = (content + '\n' + block.join('\n')).replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(patchFile, next, 'utf8')
  return true
}

/** frpc 进程 pid 文件路径（用于清理残留实例，避免多进程抢同一代理名）。 */
function frpcPidPath() {
  return join(externalDir(), 'frpc.pid')
}

/** 读取 pid 文件里的进程号；缺失 / 损坏返回 0。 */
function readFrpcPid() {
  try {
    const pid = parseInt(readFileSync(frpcPidPath(), 'utf8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

/** 记录当前 frpc 子进程 pid。 */
function writeFrpcPid(pid) {
  try { writeFileSync(frpcPidPath(), String(pid), 'utf8') } catch { /* 记录失败不致命 */ }
}

/** 清理残留的旧 frpc 实例（dsh 崩溃 / 重复点击导致的多实例）。
 *  仅处理由本插件 pid 文件记录的进程，避免误杀无关进程。 */
function killStaleFrpc() {
  const pid = readFrpcPid()
  try { rmSync(frpcPidPath(), { force: true }) } catch { /* ignore */ }
  if (!pid) return
  try {
    // Windows 下 SIGTERM 对子进程同样生效；进程已退出时抛 ESRCH，忽略
    process.kill(pid, 'SIGTERM')
  } catch { /* 进程不存在 */ }
}

/**
 * 启动一个 frpc 子进程并返回 { child, logPath }。stdout/stderr 重定向到日志文件，
 * 避免受限环境下 pipe stdio 被拒（spawn UNKNOWN）。
 * 启动前先截断日志（本次运行从干净日志开始，避免旧错误污染 probe 探测）。
 */
function spawnFrpc(bin, cfgPath, dir) {
  const logPath = join(dir, 'frpc.log')
  let logFd
  try {
    // 先清空本轮日志，保证 probe 读到的是本次启动的真实事件
    writeFileSync(logPath, '', 'utf8')
    logFd = openSync(logPath, 'a')
  } catch (e) { logFd = undefined }
  const child = spawn(bin, ['-c', cfgPath], {
    cwd: dir,
    stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
    windowsHide: true,
  })
  return { child, logFd }
}

/**
 * 读取 frpc.log 末尾若干字节，用于把 frpc 的真实报错回传给前端 / 用户。
 * frpc 启动即退出的根因（配置解析失败、token 不符、版本不兼容、被系统拦截等）
 * 都写在日志里，不读取就只会看到一句"启动后退出"而无法定位。
 */
function tryReadFrpcLog(dir, bytes = 3000) {
  try {
    const logPath = join(dir, 'frpc.log')
    if (!existsSync(logPath)) return ''
    const buf = readFileSync(logPath)
    return buf.slice(Math.max(0, buf.length - bytes)).toString('utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 尽力探测 frpc 二进制版本（frpc --version）。
 * 解析失败 / 无法运行均返回 null（非致命，交给后续存活检测兜底）。
 * @returns {Promise<string|null>} 如 "0.62.1"
 */
function frpcVersion(bin) {
  return new Promise((resolve) => {
    let c
    try {
      c = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    if (c.stdout) c.stdout.on('data', (d) => { out += d })
    if (c.stderr) c.stderr.on('data', (d) => { out += d })
    const done = () => {
      const m = /\d+\.\d+\.\d+/.exec(out)
      resolve(m ? m[0] : null)
    }
    c.on('error', () => resolve(null))
    c.on('close', done)
    setTimeout(done, 3000)
  })
}

/** 判断 frp 版本是否 >= 0.52（TOML 配置自此版本才支持；更早版本只能解析 INI）。 */
function isFrpcTomlCapable(version) {
  if (!version) return true // 探测不到就乐观放行，交给存活检测
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) return true
  const major = +m[1]
  const minor = +m[2]
  if (major > 0) return true
  return minor >= 52
}

/**
 * 确保 frpc 二进制存在且版本可用（支持 TOML）。
 *  - 缺失则下载；
 *  - 已存在但版本过旧（<0.52，无法解析本插件生成的 TOML 配置 → 启动即退出）则
 *    删除并重下；若重下后仍过旧，抛出明确错误，避免用户卡在"frpc 启动后退出"。
 * @param {string} base - 中转服务基地址（下载用）
 * @returns {Promise<string>} 可用的二进制路径
 */
async function ensureFrpcBinary(base) {
  let bin = frpcBinaryPath()
  if (!existsSync(bin)) {
    bin = await downloadFrpc(base)
  } else {
    const v = await frpcVersion(bin)
    if (!isFrpcTomlCapable(v)) {
      try { rmSync(bin, { force: true }) } catch { /* ignore */ }
      bin = await downloadFrpc(base)
      const v2 = await frpcVersion(bin)
      if (!isFrpcTomlCapable(v2)) {
        throw new Error(
          `frpc 版本过旧（${v2 || v || '未知'}），不支持 TOML 配置（需 >= 0.52）。` +
          `请更新中转服务器 public/frpc/ 下的 frpc 二进制。`,
        )
      }
    }
  }
  return bin
}

/**
 * 启动外网隧道。做了稳健性处理，避免"反复点/开了又关"。
 * @returns {Promise<{ok:boolean, url?:string, status?:string, error?:string, message?:string, log?:string}>}
 */
async function startExternal(state, body, patchFile, defaultLocalPort) {
  // 已运行则直接返回，避免重复点重复启动；
  // 但状态为 error（如鉴权失败）时允许重试：kill 旧进程并重新绑定。
  if (state.proc && state.proc.exitCode === null && state.status !== 'error') {
    if (state.status === 'online') startKeepAlive(state)
    return { ok: true, already: true, url: state.url, status: state.status || 'online' }
  }
  // 清理可能残留的旧进程
  if (state.proc) { try { state.proc.kill() } catch { /* ignore */ } state.proc = null }

  state.status = 'connecting'
  state.error = null
  try {
    return await startExternalInner(state, body, patchFile, defaultLocalPort)
  } catch (error) {
    // 启动失败必须复位状态，否则前端会一直卡在"连接中"且无法关闭
    state.status = 'error'
    state.error = String((error && error.message) || error)
    throw error
  }
}

async function startExternalInner(state, body, patchFile, defaultLocalPort) {
  const data = await bindToServer(body, Number((body && body.localPort) || defaultLocalPort))
  const base = serverBase(body)
  const domain = data.externalDomain
    || String(data.externalUrl || '').replace(/^https?:\/\//, '').split(':')[0]
    || ''
  const tunnelPort = data.tunnelPort
  const url = data.externalUrl

  // 1) 确保 frpc 可执行文件存在且版本可用（缺失 / 过旧则下载 / 重下）
  mkdirSync(externalDir(), { recursive: true })
  let bin
  try {
    bin = await ensureFrpcBinary(base)
  } catch (e) {
    throw new Error(`frpc 准备失败：${e.message}`)
  }
  // 记录 frpc 版本，供设置页展示（探测失败不影响启动）
  try {
    const ver = await frpcVersion(bin)
    if (ver) state.frpcVersion = ver
  } catch { /* ignore */ }

  // 2) 写 frpc.toml（含 loginFailExit=false 与回环地址覆写）
  const cfgPath = frpcConfigPath()
  writeFileSync(cfgPath, finalizeFrpcConfig(data.frpcConfig), 'utf8')

  // 2.5) 清理残留旧 frpc 实例，避免多个进程抢同一代理名（proxy already exists）
  killStaleFrpc()

  // 3) 启动 frpc
  const { child, logFd } = spawnFrpc(bin, cfgPath, externalDir())

  // 记录状态 + pid（供下次启动前清理残留）
  state.proc = child
  state.url = url
  state.domain = domain
  state.tunnelPort = tunnelPort
  state.status = 'connecting'
  state.error = null
  writeFrpcPid(child.pid)

  child.on('error', (e) => {
    state.error = String(e?.message || e)
    state.status = 'error'
  })
  const onExit = () => {
    state.proc = null
    // 退出不一定要报错：loginFailExit=false 时通常不会立刻退；若退了说明配置/网络有误
    if (state.status !== 'stopped') state.status = 'stopped'
    try { if (logFd !== undefined) closeSync(logFd) } catch { /* ignore */ }
    // 清理 pid 记录（仅当仍是当前进程时；新进程可能已写入新 pid）
    try {
      if (readFrpcPid() === child.pid) rmSync(frpcPidPath(), { force: true })
    } catch { /* ignore */ }
  }
  child.on('exit', onExit)

  // 4) 放行外网域名（trusted-host）
  if (domain && patchFile) {
    try { ensureTrustedHost(patchFile, domain) } catch (e) { state.lastLog = String(e?.message || e) }
  }

  // 5) 上报在线（尽力而为）
  try {
    await fetch(`${base.replace(/\/$/, '')}/api/tunnel/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindCode: body && body.bindCode }),
    })
  } catch { /* ignore */ }

  // 6) 探测 frpc 日志确认隧道真正建立，再判 online（不再只看进程存活——
  //    因为 loginFailExit=false 时进程活着并不代表隧道建立成功）。
  //    检测到 token 不匹配 / 连接被拒等明确失败时，直接报出真实原因。
  return await new Promise((resolve) => {
    // 最多探测 5 次，每次间隔 1.2s（合计约 6s）
    const MAX_TRIES = 5
    let tries = 0

    const confirmOnline = () => {
      state.status = 'online'
      state.startedAt = Date.now()
      // 记录实际生效的绑定参数并持久化，dsh 重启后由 autoRestoreExternal 自动恢复
      state.bindCode = (body && body.bindCode) || state.bindCode || ''
      state.serverBase = base
      state.localPort = Number((body && body.localPort) || defaultLocalPort)
      savePersistedState(state)
      // 隧道确认建立后启动持续心跳，让后端 last_seen 保持新鲜（管理端在线判定依赖它）
      startKeepAlive(state)
    }

    const probe = () => {
      tries += 1
      const logTail = tryReadFrpcLog(externalDir())

      // ① 明确失败：token 与 frps 服务端不一致（隧道不可能建立）
      if (/token in login doesn't match|doesn't match token from configuration/i.test(logTail)) {
        state.status = 'error'
        state.startedAt = null
        state.error = '外网隧道鉴权失败：frpc 配置的 token 与 frps 服务端不一致。请在宝塔服务器上同步 /www/wwwroot/…/.env 的 FRP_TOKEN 与 /www/server/frps/frps.toml 的 auth.token，重启 frps 与中转服务后重新开启外网。'
        resolve({ ok: false, status: 'error', url, message: state.error, log: logTail || null })
        return
      }

      // ② 明确成功：frps 已接受并建立隧道
      if (/start proxy success|login to server success/i.test(logTail)) {
        confirmOnline()
        resolve({ ok: true, url, status: 'online', note: '隧道已建立' })
        return
      }

      // ②' 明确连接失败（DNS 解析失败 / 超时 / 拒绝 / 路由不可达）：
      //    隧道不可能建立，且 loginFailExit=false 会让 frpc 一直静默重试，
      //    若不识别，探测耗尽后会走"乐观判在线"而误报。这里继续探测到耗尽，
      //    仍连不上就报出真实原因，而不是假在线。
      if (/connect to server error|no such host|i\/o timeout|connection refused|dial tcp/i.test(logTail)) {
        const addrInfo = extractServerAddr(
          existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '',
        )
        if (tries < MAX_TRIES) {
          setTimeout(probe, 1200)
          return
        }
        state.status = 'error'
        state.startedAt = null
        state.error = `无法连接到 frps 中转服务器（${addrInfo || '未知地址'}）。请检查：中转服务是否运行、服务器防火墙是否放行 7000 端口、frps 公网地址是否正确。`
        resolve({ ok: false, status: 'error', url, message: state.error, log: logTail || null })
        return
      }

      // ③ 进程仍存活但暂无结论：继续探测
      if (state.proc && state.proc.exitCode === null && !state.error && tries < MAX_TRIES) {
        setTimeout(probe, 1200)
        return
      }

      // ④ 探测耗尽但进程存活且无明确结论（日志为空 / 写入延迟）：
      //    保守判 connecting（真实状态），不乐观判 online，避免"假在线"；
      //    由后续 /status 轮询的 probeTunnelHealth 依据日志判定真实状态。
      if (state.proc && state.proc.exitCode === null && !state.error) {
        state.status = 'connecting'
        resolve({ ok: true, url, status: 'connecting', note: 'frpc 已启动，隧道状态待确认' })
        return
      }

      // ⑤ 进程已退出：给出明确错误
      const addrInfo = extractServerAddr(
        existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '',
      )
      const exitCode = state.proc ? state.proc.exitCode : null
      resolve({
        ok: false,
        status: 'failed',
        url,
        message: state.error
          ? `frpc 无法启动：${state.error}`
          : `frpc 启动后退出（exitCode=${exitCode === null ? '未知' : exitCode}）。请检查：中转服务地址、frps 公网IP(${addrInfo || '未知'}):端口、token 是否一致、防火墙是否放行`,
        exitCode: exitCode,
        spawnError: state.error || null,
        log: logTail || null,
      })
    }

    probe()
  })
}

/**
 * 停止 frpc 子进程。
 * @param {object} state
 * @param {{keepState?: boolean}} [opts] keepState=true 时保留持久化状态
 *   （dsh 进程退出清理用，这样重启后能自动恢复）；用户主动关闭则清除。
 */
function stopExternal(state, opts = {}) {
  stopKeepAlive(state)
  // 停止前上报离线，让管理端/成员端立即反映（后端支持 status 字段才生效）
  if (!opts.keepState) {
    state.status = 'offline'
    void sendHeartbeat(state)
  }
  if (state.proc && state.proc.exitCode === null) {
    try { state.proc.kill() } catch { /* ignore */ }
  }
  state.proc = null
  state.status = 'idle'
  state.error = null
  state.startedAt = null
  if (!opts.keepState) clearPersistedState()
}

/**
 * dsh 重启后自动恢复外网访问：读取本地持久化的绑定信息（bindCode / serverBase），
 * 重新绑定并拉起 frpc，免去每次手动输入验证码与中转服务地址。
 * 失败时把状态置为 error 并保留持久化，供用户手动处理或下次重启重试。
 */
async function autoRestoreExternal(state, patchFile, defaultLocalPort) {
  const saved = loadPersistedState()
  if (!saved) return
  try {
    const body = {
      bindCode: saved.bindCode,
      serverBase: saved.serverBase || undefined,
      localPort: saved.localPort,
    }
    await startExternal(state, body, patchFile, defaultLocalPort)
  } catch (e) {
    state.status = 'error'
    state.error = `自动恢复外网访问失败：${String((e && e.message) || e)}`
  }
}

/** 读取 frpc 运行日志尾部（供设置页展示，默认 6KB）。 */
function frpcLogTail(bytes = 6000) {
  return tryReadFrpcLog(externalDir(), bytes)
}

/** 持续心跳间隔（毫秒）：后端据此维持 last_seen，并做离线超时判定。 */
const HEARTBEAT_INTERVAL = 60_000

/** 上报一次在线/离线心跳（尽力而为，失败静默）。 */
async function sendHeartbeat(state) {
  const base = state.serverBase || process.env.DSH_REMOTE_SERVER || DEFAULT_SERVER_BASE
  const bindCode = state.bindCode
  if (!bindCode) return
  try {
    await fetch(`${base.replace(/\/$/, '')}/api/tunnel/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bindCode,
        // offline 表示隧道已停止，让管理端立即标记离线（后端支持时才生效）
        status: state.status === 'online' ? 'online' : 'offline',
      }),
    })
  } catch { /* ignore */ }
}

/** 启动隧道在线保活心跳（幂等：已有定时器则复用）。 */
function startKeepAlive(state) {
  if (state.keepAliveTimer) return
  state.keepAliveTimer = setInterval(() => { void sendHeartbeat(state) }, HEARTBEAT_INTERVAL)
  if (state.keepAliveTimer.unref) state.keepAliveTimer.unref()
}

/** 停止保活心跳并清空定时器。 */
function stopKeepAlive(state) {
  if (state.keepAliveTimer) {
    clearInterval(state.keepAliveTimer)
    state.keepAliveTimer = null
  }
}

/** 健康复查缓存：3 秒内不重复读盘，避免每 5s 的 status 轮询频繁读 frpc.log。 */
let healthProbeCache = { at: 0, value: 'unknown' }

/**
 * 探测 frpc 隧道的真实健康状态（供 /status 轮询时复查，避免"一次 online 永久 online"）。
 * 读取日志尾部，从后往前找最近一条关键事件：
 *   - token 不匹配 → 'error'（隧道不可能建立）
 *   - 连接失败（login/connect error）→ 'connecting'（frpc 正在自动重连）
 *   - 建连成功（start proxy success）→ 'online'
 * 无日志 / 无法判定时保持 'unknown'（调用方沿用原状态，不误伤正常隧道）。
 */
function probeTunnelHealth(state) {
  const now = Date.now()
  if (healthProbeCache.at && now - healthProbeCache.at < 3000) return healthProbeCache.value
  let logTail = ''
  try { logTail = tryReadFrpcLog(externalDir(), 20000) } catch { logTail = '' }
  const lines = String(logTail || '').split('\n').filter(Boolean)
  let verdict = 'unknown'
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]
    if (/token in login doesn't match|doesn't match token from configuration/i.test(ln)) {
      verdict = 'error'
      break
    }
    if (/login to server error|connect to server error|start error/i.test(ln)) {
      verdict = 'connecting'
      break
    }
    if (/start proxy success|login to server success/i.test(ln)) {
      verdict = 'online'
      break
    }
  }
  healthProbeCache.at = now
  healthProbeCache.value = verdict
  return verdict
}

/** 当前外网状态摘要（供 /status 使用）。 */
function externalView(state) {
  const running = !!state.proc && state.proc.exitCode === null
  let status = state.status || (running ? 'online' : 'idle')
  let error = state.error || null
  // 进程存活且宣称在线时，做健康复查：中途断线 / frps 更换 token 等都能及时发现
  if (running && status === 'online') {
    const h = probeTunnelHealth(state)
    if (h === 'error') {
      status = 'error'
      error = error || '外网隧道鉴权失败：frpc 的 token 与 frps 服务端不一致，隧道已断开。请同步服务器 FRP_TOKEN 与 frps.toml 的 auth.token 后，重新开启外网访问。'
    } else if (h === 'connecting') {
      // 隧道中途断开，frpc 正在自动重连：降级为连接中（重连成功后会恢复 online）
      status = 'connecting'
    }
  }
  return {
    enabled: running,
    running,
    // 真实状态：online（隧道已建立）/ connecting（含断线重连）/ error / stopped / idle
    status,
    url: running ? state.url : null,
    domain: state.domain,
    tunnelPort: state.tunnelPort,
    frpcVersion: state.frpcVersion || null,
    pid: running && state.proc ? state.proc.pid : null,
    startedAt: state.startedAt || null,
    lastLog: state.lastLog || null,
    error,
  }
}

export {
  serverBase,
  externalDir,
  frpcBinaryPath,
  frpcConfigPath,
  startExternal,
  stopExternal,
  externalView,
  ensureTrustedHost,
  loadPersistedState,
  savePersistedState,
  clearPersistedState,
  autoRestoreExternal,
  frpcLogTail,
  DEFAULT_SERVER_BASE,
}
