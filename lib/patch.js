// dsh-mobile-remote — profile patch（cordis.patch.yml）受管区域读写（host 侧）。
//
// 背景（对 dsh 0.2.1-rc.x 源码的实际行为）：
//   1) webserver 的 host 配置自 0.2.1-rc.3 起**只接受一块具体网卡的 IP 字面量**，
//      `0.0.0.0` / `::` 这类通配地址会在配置校验阶段直接抛错、进程 code=1 退出。
//      因此「把 webserver 改绑到局域网 IP」这条路在新版是**不可用且破坏性的**：
//      一旦改绑，本机回环监听消失，桌面端窗口（固定连 127.0.0.1）立刻打不开；
//      官方桌面端还用 `--port 0`（系统分配端口），patch 里重述 port 会让端口在
//      重载后漂移，二维码/链接全部失效。
//   2) 所以新版插件**不再改 webserver 的绑定**：局域网访问由插件自己旁挂一个
//      LAN 听众（见 lib/lanproxy.js）转发到回环监听，本机链路完全不动。
//   3) dsh 的 connection 服务另有一道 Host/Origin 信任围栏（isTrustedApiRequest）：
//      非回环 authority 只有出现在 `connection.trustedHosts` 里才放行。
//      LAN 听众会把 Host 改写成回环，因此局域网不需要放行；**外网隧道（frp/反代）
//      是直连真实监听**，Host 是外网域名，必须写进 trustedHosts，否则页面能开、
//      /api 一律 403。
//
// 因此受管区域**只写 connection.trustedHosts 一块**，绝不写 webserver。
// 依赖零第三方 YAML 库，仅做精确文本匹配。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 受管区域起始行标记（含 'dsh-mobile-remote managed' 子串）。 */
export const MANAGED_START = '# --- dsh-mobile-remote managed (auto-generated; do not edit) ---'

/** 受管区域结束行标记。 */
export const MANAGED_END = '# --- end dsh-mobile-remote managed ---'

/**
 * 求 profile 的 patch 文件路径。
 *
 * 优先级（从最可靠到兜底）：
 *   1) `ctx.get('profileContext').patchPath` —— 官方 app-boot 在启动时 provide 的
 *      真实路径，CLI / 官方桌面端（--profile desktop）/ 第三方壳全部适用；
 *   2) `ctx.baseUrl`（cordis.yml 所在目录）—— profileContext 不可用时的等价来源；
 *   3) 环境变量 DSH_PROFILE_DIR / DSH_PROFILE + DSH_HOME；
 *   4) ~/.dsh/profiles/web。
 *
 * 为什么不能只靠环境变量：官方桌面端启动 dsh 时**不设置 DSH_PROFILE**，
 * 它只把 profile 目录作为 argv 传给 dsh-desktop-host。旧实现因此把 patch 写到
 * `profiles/web`，而真正运行的是 `profiles/desktop` —— 开关点了等于没点。
 * @param {import('@deepseek-ai/cordis').Context} [ctx]
 * @returns {string}
 */
export function patchFilePath(ctx) {
  try {
    const pc = typeof ctx?.get === 'function' ? ctx.get('profileContext') : ctx?.profileContext
    if (pc && typeof pc.patchPath === 'string' && pc.patchPath) return pc.patchPath
  } catch { /* 继续回退 */ }
  try {
    if (ctx && typeof ctx.baseUrl === 'string' && ctx.baseUrl) {
      return join(fileURLToPath(ctx.baseUrl), 'cordis.patch.yml')
    }
  } catch { /* 继续回退 */ }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = process.env.DSH_PROFILE_DIR
  const profile = process.env.DSH_PROFILE || 'web'
  if (dir) return join(dir, 'cordis.patch.yml')
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** 当前运行的 profile 名（诊断展示用）。 */
export function profileName(ctx) {
  try {
    const pc = typeof ctx?.get === 'function' ? ctx.get('profileContext') : ctx?.profileContext
    if (pc && typeof pc.name === 'string' && pc.name) return pc.name
  } catch { /* 忽略 */ }
  return process.env.DSH_PROFILE || 'web'
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
  // 局域网 IP：写成「无端口」形式，任何端口都匹配，重启后端口漂移也不会失效。
  for (const ip of lanAddresses) push(normalizeAuthority(ip))
  // 外网域名：不带端口（经 frp / 反向代理时浏览器 Host 通常无端口）。
  for (const d of domains) push(normalizeAuthority(d))
  // 显式附加项（用户自定义 / 兼容旧的运行时来源）。
  for (const e of extra) push(normalizeAuthority(e))
  return out
}

/** 绑定地址是否为回环（空值按回环处理）。 */
export function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  return !h || h === '::1' || h === 'localhost' || h === '::ffff:127.0.0.1' || /^127\./.test(h)
}

/**
 * 选择要绑定的局域网 IPv4：私有网段优先（192.168 > 10 > 172.16-31），
 * 跳过虚拟网卡与 APIPA；没有可用地址时返回 null。
 * @returns {string|null}
 */
export function pickBindAddress() {
  const VIRTUAL = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|Loopback|Npcap|Bluetooth|Tailscale|ZeroTier/i
  let best = null
  for (const [name, list] of Object.entries(networkInterfaces() || {})) {
    if (VIRTUAL.test(name)) continue
    for (const ni of list || []) {
      if (!ni || ni.internal) continue
      const family = typeof ni.family === 'string' ? ni.family : `IPv${ni.family}`
      if (family !== 'IPv4') continue
      const addr = String(ni.address || '')
      if (!addr || addr.startsWith('169.254.')) continue
      const score = /^192\.168\./.test(addr) ? 3
        : /^10\./.test(addr) ? 2
          : /^172\.(1[6-9]|2\d|3[01])\./.test(addr) ? 1 : 0
      if (!best || score > best.score) best = { addr, score }
    }
  }
  return best ? best.addr : null
}

/**
 * 生成受管区域的文本行。
 *
 * **只写 connection.trustedHosts**：webserver 的 host/port 一律不碰（新版禁止通配，
 * 且改绑会让本机回环监听消失、端口漂移）。信任列表用 `!!js` 表达式把官方
 * webStartup 里的 --trusted-host 与我们的值合并，避免覆盖启动参数。
 * @param {{enabled: boolean, authorities?: string[]}} opts
 * @returns {string[]}
 */
export function renderManagedBlock(opts) {
  const { enabled, authorities = [] } = opts || {}
  if (!enabled || authorities.length === 0) return []
  const list = authorities.map((a) => `'${a}'`).join(', ')
  // 关键：`!!js` 在这个 YAML schema 里只能作用于**标量**。写成 `!!js [...]` 会让
  // js-yaml 把 `[...]` 解析成流式序列、再套标量标签，于是报
  // "unknown tag !<tag:yaml.org,2002:js>" 并让 dsh 启动直接失败。
  // 因此表达式必须整体加引号，作为标量交给 Loader 求值。
  const expression = `[...ctx.webStartup.trustedHosts, ${list}]`
  return [
    '',
    MANAGED_START,
    '- id: connection',
    '  config:',
    `    trustedHosts: !!js "${expression}"`,
    MANAGED_END,
    '',
  ]
}

/** 从受管区域里解析出已有的 trustedHosts authority（供增量更新）。 */
export function readManagedAuthorities(lines, block) {
  if (!block) return []
  const out = []
  for (let i = block.start; i < Math.min(block.end, lines.length); i++) {
    const line = lines[i]
    // 新写法：trustedHosts: !!js "[...ctx.webStartup.trustedHosts, 'a', 'b']"
    // 旧写法：trustedHosts: ['a', 'b']
    const m = /^\s*trustedHosts\s*:\s*(?:!!js\s*)?["']?\[(.*?)\]["']?\s*$/.exec(line)
    if (!m) continue
    for (const part of m[1].split(',')) {
      const text = part
        .replace(/\.\.\.\s*ctx\.webStartup\.trustedHosts/g, '')
        .replace(/['"]/g, '')
        .trim()
      if (!text) continue
      const a = normalizeAuthority(text)
      if (a && !out.includes(a)) out.push(a)
    }
  }
  return out
}

/**
 * 写入受管区域（整体替换，幂等）。
 * 关闭时整块移除；开启时写入 connection.trustedHosts 块。
 * 无论开关，受管区域里**遗留的 webserver 覆盖**都会被清掉（旧版本写进去的
 * 0.0.0.0 / 局域网 IP 绑定在新版会毁掉本机访问）。
 *
 * authorities 语义（既避免"探测失败把已放行的域名清掉"，也避免"空数组被误当成沿用"）：
 *   - 未传（undefined）    → 沿用文件中已有的 authority；
 *   - 传了数组（含空数组） → 以传入值为准，但与文件中已有的合并去重。
 * @param {import('@deepseek-ai/cordis').Context} [ctx]
 * @param {{enabled: boolean, authorities?: string[]}} opts
 * @returns {{file: string, enabled: boolean, authorities: string[]}}
 */
export function writeManagedPatch(ctx, opts) {
  const { file, lines } = readPatchFile(ctx)
  const block = findManagedBlock(lines)
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
    out = [...out, ...renderManagedBlock({ enabled: true, authorities })]
  }

  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(file, next, 'utf8')
  return { file, enabled: !!opts.enabled, authorities }
}

/**
 * 确保某个 authority（通常是外网域名）加入受管区域的 connection.trustedHosts。
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
  const merged = block ? readManagedAuthorities(lines, block) : []
  if (merged.includes(target)) return true
  merged.push(target)
  let out = lines.slice()
  out = out.filter((l) => l.trim() !== '[]')
  const block2 = findManagedBlock(out)
  if (block2) out.splice(block2.start, block2.end - block2.start)
  out = [...out, ...renderManagedBlock({ enabled: true, authorities: merged })]
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(patchFile, next, 'utf8')
  return true
}

/** 受管区域里是否存在（trustedHosts 放行块）。 */
export function isManagedPatchEnabled(ctx) {
  const { lines } = readPatchFile(ctx)
  const block = findManagedBlock(lines)
  if (!block) return false
  return readManagedAuthorities(lines, block).length > 0
}

/**
 * 清理旧版本遗留的 webserver 绑定覆盖（受管区域内）。
 * 旧版本会写 `- id: webserver / host: 0.0.0.0|192.168.x.x`，新版这样写会让
 * dsh 启动失败或让本机回环监听消失。这里只在**受管区域**内删除 webserver 条目，
 * 用户自己手写的配置一律不动。
 * @param {import('@deepseek-ai/cordis').Context} [ctx]
 * @returns {boolean} 是否真的清理了内容
 */
export function stripLegacyWebserverBinding(ctx) {
  const { file, lines } = readPatchFile(ctx)
  const block = findManagedBlock(lines)
  if (!block) return false
  const inner = lines.slice(block.start, block.end)
  if (!inner.some((l) => /^\s*-?\s*id:\s*['"]?webserver['"]?\s*$/.test(l))) return false
  const authorities = readManagedAuthorities(lines, block)
  let out = lines.slice()
  out = out.filter((l) => l.trim() !== '[]')
  const block2 = findManagedBlock(out)
  if (block2) out.splice(block2.start, block2.end - block2.start)
  out = [...out, ...renderManagedBlock({ enabled: authorities.length > 0, authorities })]
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(file, next, 'utf8')
  return true
}

/**
 * 清理旧版本遗留的「external trusted-host」块。
 * 旧实现写入的是 `trustedHosts: !!js "['dom', ...ctx.webRuntime.trustedHosts]"`，
 * 而 `ctx.webRuntime` 在 0.2.x 根本不存在 —— 表达式求值时会抛错。现在改成
 * 受管区域里的真实字符串数组，因此这段必须清掉（其中的域名会迁移过去）。
 * @param {import('@deepseek-ai/cordis').Context} [ctx]
 * @returns {{changed: boolean, domains: string[]}}
 */
export function stripLegacyExternalHostBlock(ctx) {
  const { file, lines } = readPatchFile(ctx)
  const start = lines.findIndex((l) => l.includes('# --- dsh-mobile-remote external trusted-host ---'))
  if (start === -1) return { changed: false, domains: [] }
  const end = lines.findIndex((l, i) => i > start && l.includes('# --- end dsh-mobile-remote external trusted-host ---'))
  const inner = lines.slice(start, end === -1 ? start + 1 : end + 1)
  const domains = []
  for (const line of inner) {
    const m = /trustedHosts\s*:\s*(?:!!js\s*)?["']?\[(.*?)\]/i.exec(line)
    const scope = m ? m[1] : line
    for (const quoted of scope.match(/'([^']+)'|"([^"]+)"/g) || []) {
      const value = quoted.slice(1, -1)
      if (!value || value.includes('ctx.')) continue
      const a = normalizeAuthority(value)
      if (a && !domains.includes(a)) domains.push(a)
    }
  }
  const out = [...lines.slice(0, start), ...lines.slice(end === -1 ? start + 1 : end + 1)]
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  writeFileSync(file, next, 'utf8')
  return { changed: true, domains }
}

/**
 * 一次性迁移所有旧版本遗留结构：
 *   1) `webserver` 绑定覆盖（会让本机回环监听消失 / 新版直接启动失败）；
 *   2) `ctx.webRuntime.trustedHosts` 表达式块（0.2.x 无此字段，求值即抛错）；
 *   3) 把迁移出来的域名并入受管 trustedHosts。
 * @param {import('@deepseek-ai/cordis').Context} [ctx]
 * @returns {{changed: boolean, domains: string[]}}
 */
export function migrateLegacyPatch(ctx) {
  const legacy = stripLegacyExternalHostBlock(ctx)
  const removedBind = stripLegacyWebserverBinding(ctx)
  for (const domain of legacy.domains) {
    try { ensureTrustedAuthority(patchFilePath(ctx), domain) } catch { /* 忽略 */ }
  }
  return { changed: legacy.changed || removedBind, domains: legacy.domains }
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
