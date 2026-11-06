// 绑定形态自适应（direct / loopback）的回归测试。
//
// 背景：dsh 0.2.1+ 的 webserver.host 只接受具体网卡字面量，官方桌面端/第三方壳
// 会用 `--host 192.168.x.x` 启动 —— 此时 127.0.0.1 上没有任何监听。
// 旧版插件假设宿主永远绑回环，于是：
//   · 旁挂 LAN 听众去绑同一块网卡 → EADDRINUSE → 设置页显示「未开启」且没有二维码；
//   · frpc 仍然转发到 127.0.0.1:port → 中转服务器对外 502。
// 本文件锁住这两条修复：转发上游可定制、已占用地址自动跳过、frpc localIP 跟随宿主。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createLanProxy } from '../lib/lanproxy.js'
import { finalizeFrpcConfig } from '../lib/external.js'

/** 起一个只回固定文本的上游 HTTP 服务。 */
function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-ok')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
}

test('旁挂听众按 upstreamHost 转发（宿主只绑网卡时仍可用）', async () => {
  const { server, port } = await startUpstream()
  const proxy = createLanProxy()
  try {
    // 上游在 127.0.0.1:port；旁挂听众绑在另一块回环地址上，模拟「宿主已占用网卡地址」
    const result = await proxy.start(['127.0.0.2'], port, { upstreamHost: '127.0.0.1' })
    assert.equal(result.running, true)
    assert.deepEqual(result.hosts, ['127.0.0.2'])
    assert.equal(result.upstream, `127.0.0.1:${port}`)

    const res = await get(`http://127.0.0.2:${port}/`)
    assert.equal(res.status, 200)
    assert.equal(res.body, 'upstream-ok')
  } finally {
    await proxy.stop()
    await new Promise((r) => server.close(r))
  }
})

test('skipHosts 里的地址不会重复绑定（避免 EADDRINUSE）', async () => {
  const { server, port } = await startUpstream()
  const proxy = createLanProxy()
  try {
    // 127.0.0.1:port 已被上游占用，等价于宿主自己绑在这块网卡上的情形
    const result = await proxy.start(['127.0.0.1', '127.0.0.3'], port, {
      upstreamHost: '127.0.0.1',
      skipHosts: ['127.0.0.1'],
    })
    assert.equal(result.running, true)
    assert.deepEqual(result.hosts, ['127.0.0.3'])
  } finally {
    await proxy.stop()
    await new Promise((r) => server.close(r))
  }
})

test('全部地址都被宿主占用时不报失败，交由 direct 逻辑判可达', async () => {
  const { server, port } = await startUpstream()
  const proxy = createLanProxy()
  try {
    const result = await proxy.start(['127.0.0.1'], port, {
      upstreamHost: '127.0.0.1',
      skipHosts: ['127.0.0.1'],
    })
    assert.equal(result.running, false)
    assert.deepEqual(result.hosts, [])
    assert.deepEqual(result.failures, [])
  } finally {
    await proxy.stop()
    await new Promise((r) => server.close(r))
  }
})

test('frpc 配置：localIP 跟随宿主真实监听地址', () => {
  const cfg = [
    'serverAddr = "203.0.113.10"',
    '[[proxies]]',
    'name = "dsh-18081"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 3080',
    'remotePort = 18081',
  ].join('\n')

  // 宿主只绑网卡：必须改写，否则外网 502
  const direct = finalizeFrpcConfig(cfg, '192.168.3.119')
  assert.match(direct, /localIP = "192\.168\.3\.119"/)
  assert.doesNotMatch(direct, /localIP = "127\.0\.0\.1"/)

  // 宿主绑回环：保持原样
  const loopback = finalizeFrpcConfig(cfg, '127.0.0.1')
  assert.match(loopback, /localIP = "127\.0\.0\.1"/)

  // 没有 localIP 行时补在 localPort 之前
  const noLocalIp = cfg.replace('localIP = "127.0.0.1"\n', '')
  const injected = finalizeFrpcConfig(noLocalIp, '10.0.0.5')
  assert.match(injected, /localIP = "10\.0\.0\.5"\s*\n\s*localPort = 3080/)
})
