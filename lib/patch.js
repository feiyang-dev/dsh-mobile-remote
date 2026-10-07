// dsh-mobile-remote — profile patch（cordis.patch.yml）受管区域读写（host 侧）。
//
// 背景（对 dsh 0.1.7 / 0.2.x 源码的实际行为）：
//   官方 CLI 出于安全硬编码拒绝 `--host 0.0.0.0`（见 dsh-web-app/lib/startup.js），
//   但 profile 的 patch 层完整支持覆盖 `webserver.host`。因此本插件用 patch 打开
//   局域网监听。而 dsh 的 connection 服务另有一道独立的 **Host/Origin 信任围栏**
//   （isTrustedApiRequest）：非回环 authority 只有在 `connection.trustedHosts`
//   里才会放行，否则手机的 /api 请求一律 403（页面能打开但一直转圈/报错）。
//
// 所以"开启远程控制"必须同时写两块：
//   1) `- id: webserver`  → host: '0.0.0.0'（让手机能连上）
//   2) `- id: connection` → trustedHosts: ['192.168.x.x:port', ...]（让手机能调 API）
//
// 两块写在同一个受管区域内，便于整体增删，也避免多次追加造成互相冲突。
// 依赖零第三方 YAML 库，仅做精确文本匹配。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'

/** 受管区域起始行标记（含 'dsh-mobile-remote managed' 子串）。 */
export const MANAGED_START = '# --- dsh-mobile-remote managed (auto-generated; do not edit) ---'

/** 受管区域结束行标记。 */
export const MANAGED_END = '# --- end dsh-mobile-remote managed ---'

/**
 * 求 profile 的 patch 文件路径。
 * DSH_PROFILE / DSH_PROFILE_DIR 优先，其次 DSH_HOME，最后 ~/.dsh。
 * @param {import('@deepseek-ai/cordis').Context} [ctx]
 * @returns {string}
 */
export function patchFilePath(_ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = process.env.DSH_PROFILE_DIR
  const profile = process.env.DSH_PROFILE || 'web'
  // 宿主给了 profile 目录就直接用，避免 DSH_PROFILE 与实际运行 profile 不一致。
  if (dir) return join(dir, 'cordis.patch.yml')
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** 读取 patch 文件内容与行数组。 */
export function readPatchFile(ctx) {
  const file = patchFilePath(ctx)
  const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return { file, content, lines: content.split(/\r?\n/) }
}

/**
 * 受管区域的行区间 [start, end)（含分隔注释）。不存在返回 null。
 * @param {string[]} lines
 * @returns {{start: number, end: number}|null}
 */
export function findManagedBlock(lines) {
  const start = lines.findIndex((l) => l.includes('# --- dsh-mobile-remote managed'))
  if (start === -1) return null
  const end = lines.findIndex((l, i) => i > start && l.includes('# --- end dsh-mobile-remote managed'))
  if (end === -1) return { start, end: lines.length }
  return { start, end: end + 1 }
}

/**
 * 归一化成一个「裸 authority」（host 或 host:port），使其能通过 dsh 的
 * assertTrustedAuthority 校验：必须是 WHATWG 解析后保持不变的规范形式。
 * 形如 http://1.2.3.4:80/ 的输入、带路径/大小写/默认端口的输入都会被收敛。
 * @param {string} raw
 * @returns {string|null} 规范 authority，无法解析时返回 null
 */
export function normalizeAuthority(raw) {
  if (typeof raw !== 'string') return null
  let value = raw.trim()
  if (!value) return null
  // 去掉可能出现的协议与路径，只保留 authority 部分。
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  value = value.split('/')[0].split('?')[0].split('#')[0]
  // 用户信息禁止出现在 trustedHosts（会授权内嵌主机名），直接拒绝。
  if (value.includes('@')) return null
  let url
  try {
    url = new URL(`http://${value}`)
  } catch {
    return null
  }
  if (!url.hostname) return null
  const host = url.hostname.toLowerCase()
  const port = url.port
  // 端口只在原始字符串显式写出时才保留（:80/:443 对裸 authority 无意义且易被改写）。
  return port ? `${host}:${port}` : host
}

/**
 * 汇总需要放行的 authority 列表（去重、保持顺序、仅保留规范形式）。
 * @param {{lanAddresses?: string[], port?: number, domains?: string[], extra?: string[]}} input
 * @returns {string[]}
 */
export function collectTrustedAuthorities(input = {}) {
  const { lanAddresses = [], port, domains = [], extra = [] } = input
  const out = []
  const push = (v) => { if (v && !out.includes(v)) out.push(v) }
  // 局域网 IP：DSH 的围栏对回环之外的 authority 要求显式声明。
  for (const ip of lanAddresses) push(normalizeAuthority(port ? `${ip}:${port}` : ip))
  // 外网域名：不带端口（经 frp / 反向代理时浏览器 Host 通常无端口）。
  for (const d of domains) push(normalizeAuthority(d))
  // 显式附加项（用户自定义 / 兼容旧的运行时来源）。
  for (const e of extra) push(normalizeAuthority(e))
  return out
}

/**
 * 生成受管区域的文本行。
 * @param {{enabled: boolean, port: number, authorities?: string[]}} opts
 * @returns {string[]}
 */
export function renderManagedBlock(opts) {
  const { enabled, port, authorities = [] } = opts
  if (!enabled) return []
  const lines = [
    '',
    MANAGED_START,
    '- id: webserver',
    '  config:',
    "    host: '0.0.0.0'",
    `    port: !!js ctx.webStartup.port ?? ${port}`,
  ]
  if (authorities.length) {
    lines.push('- id: connection')
    lines.push('  config:')
    lines.push(`    trustedHosts: [${authorities.map((a) => `'${a}'`).join(', ')}]`)
  }
  lines.push(MANAGED_END, '')
  return lines
}

/** 从受管区域里解析出已有的 trustedHosts authority（供增量更新）。 */
export function readManagedAuthorities(lines, block) {
  if (!block) return []
  const out = []
  for (let i = block.start; i < Math.min(block.end, lines.length); i++) {
    const m = /^\s*trustedHosts:\s*\[(.*)\]\s*$/.exec(lines[i])
    if (!m) continue
    for (const part of m[1].split(',')) {
      const a = normalizeAuthority(part.replace(/['"]/g, '').trim())
      if (a && !out.includes(a)) out.push(a)
    }
  }
  return out
}

/**
 * 写入受管区域（整体替换，幂等）。
 * 关闭时整块移除；开启时写入 webserver 块，并在有 authority 时附带 connection 块。
 *
 * authorities 语义（既避免"探测失败把已放行的域名清掉"，也避免"空数组被误当成沿用"）：
 *   - 未传（undefined）    → 沿用文件中已有的 authority；
 *   - 传了数组（含空数组） → 以传入值为准，但与文件中已有的合并去重。这样开启开关时
 *                            即使局域网探测失败，也不会丢掉外网隧道此前写入的域名。
 * @param {import('@deepseek-ai/cordis').Context} [ctx]
 * @param {{enabled: boolean, port?: number, authorities?: string[]}} opts
 * @returns {{file: string, enabled: boolean, authorities: string[]}}
 */
export function writeManagedPatch(ctx, opts) {
  const { file, lines } = readPatchFile(ctx)
  const block = findManagedBlock(lines)
  const port = opts.port || 3080
  const existing = readManagedAuthorities(lines, block)
  const authorities = Array.isArray(opts.authorities)
    ? [...new Set([...opts.authorities, ...existing])]
    : existing

  let out = lines.slice()
  // 移除官方模板的空数组占位行 `[]`：它单独构成一个 YAML 文档，与追加的列表块
  // 拼接会形成无 `---` 分隔符的多文档流，js-yaml 解析报
  // "end of the stream or a document separator is expected"，导致 dsh 服务启动即崩溃。
  out = out.filter((l) => l.trim() !== '[]')
  // 行号会因上面的过滤而偏移，重新定位受管区域。
  const block2 = findManagedBlock(out)
  if (block2) out.splice(block2.start, block2.end - block2.start)

  if (opts.enabled) {
    out = [...out, ...renderManagedBlock({ enabled: true, port, authorities })]
  }

  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(file, next, 'utf8')
  return { file, enabled: !!opts.enabled, authorities }
}

/**
 * 确保某个 authority（通常是外网域名）加入受管区域的 connection.trustedHosts。
 * 与旧实现不同：不再依赖 `ctx.webRuntime.trustedHosts`（该字段在 dsh 0.1.7/0.2.x
 * 不存在，表达式会求值成对象而被 schema 拒绝），改为写出真实的字符串数组。
 * @param {string} patchFile
 * @param {string} authority - 裸 authority（host 或 host:port）
 * @returns {boolean} 是否已确保存在
 */
export function ensureTrustedAuthority(patchFile, authority) {
  const target = normalizeAuthority(authority)
  if (!target) return false
  const content = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const lines = content.split(/\r?\n/)
  const block = findManagedBlock(lines)
  if (block) {
    const existing = readManagedAuthorities(lines, block)
    if (existing.includes(target)) return true
  }
  const merged = block ? readManagedAuthorities(lines, block) : []
  if (!merged.includes(target)) merged.push(target)
  // 直接整体重写受管区域：保留原 webserver 开关状态（区域内是否存在 host: '0.0.0.0'）。
  const inner = block ? lines.slice(block.start, block.end) : []
  const enabled = inner.some((l) => l.includes("host: '0.0.0.0'"))
  const portMatch = inner.map((l) => /port:\s*!!js[^\d]*(\d+)/.exec(l)).find(Boolean)
  const port = portMatch ? Number(portMatch[1]) : 3080
  let out = lines.slice()
  out = out.filter((l) => l.trim() !== '[]')
  const block2 = findManagedBlock(out)
  if (block2) out.splice(block2.start, block2.end - block2.start)
  out = [...out, ...renderManagedBlock({ enabled, port, authorities: merged })]
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(patchFile, next, 'utf8')
  return true
}

/** 受管区域内是否已开启远程控制（host: '0.0.0.0'）。 */
export function isManagedPatchEnabled(ctx) {
  const { lines } = readPatchFile(ctx)
  const block = findManagedBlock(lines)
  if (!block) return false
  return lines.slice(block.start, block.end).some((l) => l.includes("host: '0.0.0.0'"))
}

/** 读取局域网 IPv4（非回环）地址列表。 */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces() || {})) {
    for (const ni of list || []) {
      if (!ni || ni.internal) continue
      // Node 18+ 的 family 是 'IPv4'，旧版是数字 4，两种都要兼容。
      const family = typeof ni.family === 'string' ? ni.family : `IPv${ni.family}`
      if (family !== 'IPv4') continue
      if (!out.includes(ni.address)) out.push(ni.address)
    }
  }
  return out
}
