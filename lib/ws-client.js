// dsh-mobile-remote — 中转服务器 WS 状态推送客户端（host 侧）。
//
// 目标：用 WebSocket 长连接接收中转服务器的隧道状态推送，替代插件端
// 每 5s 轮询 /api/tunnel/stats，把中转服务器的请求压力降为 0。
//
// 说明：
//  - 本插件运行在 Electron 内置 Node（当前 20.x，无原生全局 WebSocket），
//    因此需要 `ws` 第三方库。若依赖缺失（如离线 tgz 安装未装依赖），
//    wsAvailable() 返回 false，调用方自动回退 HTTP 低频查询，功能不中断。
//  - 连接管理：指数退避自动重连（2s→4s→…→60s）；心跳由 external.js 的
//    keepAliveTimer 统一驱动（每 60s），WS 已连上时走 WS、否则走 HTTP。
//  - 收到 tunnel:status 后更新本地缓存并回调 onStatus，前端 /status 直接读缓存。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 尝试加载 ws 库（Node 20 无原生 WebSocket，需要它）。 */
let WsCtor = null
try {
  WsCtor = require('ws')
} catch {
  WsCtor = null
}

/** 当前环境是否可用 WebSocket（ws 依赖是否加载成功）。 */
export function wsAvailable() {
  return !!WsCtor
}

/**
 * 创建成员端 WS 状态推送客户端。
 * @param {object} opts
 * @param {string} opts.serverBase 中转服务基地址（https://… 或 http://…）
 * @param {string} opts.bindCode    绑定码
 * @param {(data: object) => void} [opts.onStatus] 收到 tunnel:status 时的回调
 * @param {(msg: string, ...args: unknown[]) => void} [opts.logger] 日志（默认静默）
 */
export function createWsStatusClient({ serverBase, bindCode, onStatus, logger }) {
  let ws = null
  let manualClose = false
  let retryTimer = null
  let retryDelay = 2000
  let lastStatus = null
  const log = logger || (() => {})

  function wsUrl() {
    // http:// → ws://，https:// → wss://
    const base = String(serverBase || '').replace(/^http/, 'ws').replace(/\/+$/, '')
    return `${base}/api/tunnel/ws?bindCode=${encodeURIComponent(String(bindCode || ''))}`
  }

  function isOpen() {
    return !!(ws && ws.readyState === ws.OPEN)
  }

  function scheduleReconnect() {
    if (manualClose || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, retryDelay)
    if (retryTimer.unref) retryTimer.unref()
    retryDelay = Math.min(retryDelay * 2, 60000)
  }

  function connect() {
    if (!WsCtor) return
    if (manualClose) return
    if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return
    let client
    try {
      client = new WsCtor(wsUrl())
    } catch (e) {
      log('[ws-client] 连接失败:', String((e && e.message) || e))
      scheduleReconnect()
      return
    }
    ws = client

    client.on('open', () => {
      retryDelay = 2000
      log('[ws-client] 已连接（bindCode=****）')
    })

    client.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString())
        if (msg && msg.type === 'tunnel:status' && msg.data) {
          msg.data._at = Date.now() // 缓存新鲜度标记
          lastStatus = msg.data
          try { onStatus && onStatus(msg.data) } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    })

    client.on('close', (code, reason) => {
      log('[ws-client] 连接关闭 code=' + code, String(reason || ''))
      ws = null
      if (!manualClose) scheduleReconnect()
    })

    client.on('error', (err) => {
      log('[ws-client] 错误:', String((err && err.message) || err))
      try { client.terminate() } catch (e) { /* ignore */ }
    })
  }

  /** 主动断开（停止外网 / 插件卸载时调用），之后不再自动重连。 */
  function disconnect() {
    manualClose = true
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    if (ws) {
      try { ws.close() } catch (e) { /* ignore */ }
      try { ws.terminate() } catch (e) { /* ignore */ }
      ws = null
    }
  }

  /** 重置并重连（绑定码 / 中转地址变化后使用）。 */
  function reconnect() {
    manualClose = false
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    retryDelay = 2000
    if (ws) {
      try { ws.terminate() } catch (e) { /* ignore */ }
      ws = null
    }
    connect()
  }

  /**
   * 经 WS 发送心跳（成功返回 true；未连接返回 false，调用方回退 HTTP）。
   * @param {'online'|'offline'} [status]
   */
  function sendHeartbeat(status) {
    if (!isOpen()) return false
    try {
      ws.send(JSON.stringify({ type: 'heartbeat', status: status || 'online' }))
      return true
    } catch (e) {
      return false
    }
  }

  /** 最近一次收到的隧道状态（未收到过为 null）。 */
  function getLastStatus() {
    return lastStatus
  }

  return { connect, disconnect, reconnect, isOpen, sendHeartbeat, getLastStatus }
}
