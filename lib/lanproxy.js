// dsh-mobile-remote — 局域网旁挂听众（host 侧）。
//
// 为什么需要它（dsh 0.2.1-rc.3 起的现实）：
//   · webserver 的 host 只接受「一块具体网卡的 IP 字面量」，0.0.0.0 直接抛错退出；
//   · 就算改绑到 192.168.x.x，本机 127.0.0.1 的监听也随之消失 —— 桌面端窗口、
//     官方桌面端（固定加载 http://127.0.0.1:<port>）会立刻白屏；
//   · 官方桌面端用 `--port 0` 由系统分配端口，patch 里重述 port 会让端口漂移。
// 因此本模块采用「**本机监听完全不动，旁挂一个 LAN 听众**」的方案：
//   · 在 `<局域网IP>:<当前端口>` 上再监听一份（同端口不同地址，Windows/Linux 都允许）；
//   · 把请求反向代理到 `127.0.0.1:<当前端口>`（TCP 层以上，HTTP 与 WebSocket 都通）；
//   · 代理时把 Host / Origin 改写成回环 authority —— dsh 的 Host/Origin 信任围栏
//     对回环一律放行，于是**局域网访问不需要任何 patch 改动**，也没有重启/CORS 风险；
//   · 真实客户端 IP 通过 X-Forwarded-For 传给宿主（设备列表里仍然显示手机 IP）。
//
// 关闭时释放监听，本机访问自始至终不受影响。

import http from 'node:http'
import net from 'node:net'

/** 回环 authority（dsh 信任围栏自动放行的形式）。 */
function loopbackAuthority(port) {
  return `127.0.0.1:${String(port)}`
}

/**
 * 把 Origin 头的 authority 换成回环 authority（保留协议），
 * 让围栏的「Origin 必须等于 Host」判断通过。
 * @param {string} origin
 * @param {string} authority
 * @returns {string}
 */
function rewriteOrigin(origin, authority) {
  try {
    const url = new URL(origin)
    return `${url.protocol}//${authority}`
  } catch {
    return `http://${authority}`
  }
}

/** 追加一条 X-Forwarded-For（保留上游已有值）。 */
function forwardedFor(headers, socket) {
  const prev = headers['x-forwarded-for']
  const ip = (socket && (socket.remoteAddress || '')) || ''
  const clean = String(ip).replace(/^::ffff:/, '')
  if (!clean) return prev
  return prev ? `${prev}, ${clean}` : clean
}

/**
 * 创建 LAN 旁挂听众。
 * @param {{log?: (msg: string, err?: unknown) => void}} [options]
 */
export function createLanProxy(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  /** @type {Array<{server: import('node:http').Server, host: string}>} */
  let listeners = []
  /** 当前实际监听端口（等于宿主端口）。 */
  let listenPort = 0
  /** 转发目标端口（宿主端口；监听建立前就已确定，避免启动窗口内 503）。 */
  let targetPort = 0
  /** 当前对外提供的局域网地址列表。 */
  let hosts = []
  /** 每次 start/stop 递增，用于丢弃过期的启动结果。 */
  let generation = 0

  const state = () => ({
    running: listeners.length > 0,
    hosts: hosts.slice(),
    port: listenPort,
  })

  function targetPortOf() {
    const n = Number(targetPort)
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  /** 普通 HTTP 请求转发。 */
  function handleRequest(req, res) {
    const port = targetPortOf()
    if (!port) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('dsh is starting, please retry in a moment.\n')
      return
    }
    const authority = loopbackAuthority(port)
    const headers = { ...req.headers }
    const realHost = headers.host || ''
    headers.host = authority
    if (headers.origin) headers.origin = rewriteOrigin(headers.origin, authority)
    headers['x-forwarded-for'] = forwardedFor(headers, req.socket)
    headers['x-forwarded-proto'] = 'http'
    if (realHost) headers['x-forwarded-host'] = realHost
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', (error) => {
      log('lan proxy upstream error', error)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      try { res.end('dsh upstream unavailable\n') } catch { /* ignore */ }
    })
    req.on('error', () => { try { upstream.destroy() } catch { /* ignore */ } })
    req.pipe(upstream)
  }

  /** WebSocket / 其它 Upgrade 请求：按原始字节隧道转发。 */
  function handleUpgrade(req, socket, head) {
    const port = targetPortOf()
    if (!port) { try { socket.destroy() } catch { /* ignore */ } return }
    const authority = loopbackAuthority(port)
    const headers = { ...req.headers }
    const realHost = headers.host || ''
    headers.host = authority
    if (headers.origin) headers.origin = rewriteOrigin(headers.origin, authority)
    headers['x-forwarded-for'] = forwardedFor(headers, req.socket)
    headers['x-forwarded-proto'] = 'http'
    if (realHost) headers['x-forwarded-host'] = realHost

    const upstream = net.connect(port, '127.0.0.1', () => {
      const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else lines.push(`${key}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', (error) => {
      log('lan proxy upgrade error', error)
      try { socket.destroy() } catch { /* ignore */ }
    })
    socket.on('error', () => { try { upstream.destroy() } catch { /* ignore */ } })
  }

  /** 在一个 host 上开监听，失败时抛出。 */
  function listenOne(host, port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handleRequest)
      server.on('upgrade', handleUpgrade)
      const onError = (error) => {
        server.removeListener('listening', onListening)
        try { server.close() } catch { /* ignore */ }
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        server.on('error', (error) => log(`lan proxy ${host} error`, error))
        // 长连接（SSE / WebSocket）不能因为 keep-alive 超时被误杀
        server.keepAliveTimeout = 65_000
        server.headersTimeout = 70_000
        resolve(server)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  /**
   * 在给定局域网地址上开启监听。
   * @param {string[]} lanHosts - 局域网 IPv4 列表（按优先级排序）
   * @param {number} port - 宿主当前监听端口
   * @returns {Promise<{running: boolean, hosts: string[], port: number, failures: Array<{host: string, error: string}>}>}
   */
  async function start(lanHosts, port) {
    const wanted = [...new Set((lanHosts || []).filter(Boolean))]
    if (!wanted.length) {
      return { running: false, hosts: [], port: 0, failures: [{ host: '', error: '没有可用的局域网 IPv4 地址' }] }
    }
    if (listeners.length > 0 && listenPort === port && hosts.join(',') === wanted.join(',')) {
      return { running: true, hosts: hosts.slice(), port: listenPort, failures: [] }
    }
    await stop()
    // stop() 已推进代次；此刻记录本轮的代次，后续任何 stop() 都会让它过期
    const mark = generation
    // 先确定转发目标：监听建立期间到达的请求也能正确转发
    targetPort = port
    const opened = []
    const failures = []
    for (const host of wanted) {
      try {
        opened.push({ server: await listenOne(host, port), host })
      } catch (error) {
        failures.push({ host, error: String((error && error.message) || error) })
      }
    }
    if (mark !== generation) {
      // 期间被 stop() 抢先：本次结果作废
      for (const item of opened) { try { item.server.close() } catch { /* ignore */ } }
      return state().running
        ? { ...state(), failures }
        : { running: false, hosts: [], port: 0, failures }
    }
    listeners = opened
    listenPort = opened.length > 0 ? port : 0
    hosts = opened.map((item) => item.host)
    if (!opened.length) log('lan proxy: no listener could bind', failures)
    return { running: opened.length > 0, hosts: hosts.slice(), port: listenPort, failures }
  }

  /** 关闭全部监听。 */
  async function stop() {
    generation += 1
    const closing = listeners
    listeners = []
    listenPort = 0
    targetPort = 0
    hosts = []
    await Promise.all(closing.map(({ server }) => new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
    })))
    return state()
  }

  return { start, stop, status: state }
}
