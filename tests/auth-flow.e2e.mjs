// dsh-mobile-remote 端到端验证（局域网 + 外网 + 安全回归）。
//
// 验证「裸地址自动登录」整条链路：
//   裸地址 302（相对地址 + token）→ 303 + Set-Cookie → 200 完整 UI → /api 通过围栏与认证
// 以及安全回归：错误 token 被拒、无凭证 /api 被拒、无 token 访问 / 不直接吐出 UI。
//
// 用法（需 dsh 已在目标地址上运行，且插件已开启远程控制）：
//   node tests/auth-flow.e2e.mjs
// 如需改目标，直接改下面三个常量。
const LAN = '192.168.3.119'
const LAN_PORT = '19387'
const EXT_HOST = 'cwj.dsh.cwj666.top'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

async function req(url, cookie) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  const res = await fetch(url, { headers, redirect: 'manual' })
  return {
    status: res.status,
    location: res.headers.get('location'),
    setCookie: res.headers.get('set-cookie'),
    contentType: res.headers.get('content-type'),
    body: await res.text(),
  }
}

/** 跑一遍完整握手：裸地址 → 302 相对跳转 → 303 换 cookie → 200 UI。 */
async function flow(label, base) {
  console.log(`\n========== ${label}  (${base}) ==========`)
  const s1 = await req(`${base}/`)
  console.log(`  [1] 裸地址 status=${s1.status} location=${s1.location}`)
  check(`${label}: 裸地址 302 自动登录（非 401）`, s1.status === 302, `实际 ${s1.status}`)
  // 关键：跳转必须是相对地址，才能同时适配 http/https 与反代前缀
  check(`${label}: 跳转是相对地址（以 / 开头）`, typeof s1.location === 'string' && s1.location.startsWith('/'), String(s1.location))
  check(`${label}: 跳转带 token`, typeof s1.location === 'string' && s1.location.includes('token='), String(s1.location))
  if (s1.status !== 302) { console.log(`  正文: ${s1.body.slice(0, 160)}`); return }

  const s2 = await req(new URL(s1.location, `${base}/`).href)
  console.log(`  [2] 带 token status=${s2.status} location=${s2.location} set-cookie=${s2.setCookie ? 'yes' : '(无)'}`)
  check(`${label}: 303 官方握手`, s2.status === 303, `实际 ${s2.status}`)
  check(`${label}: 下发 dsh-auth cookie`, typeof s2.setCookie === 'string' && s2.setCookie.includes('dsh-auth-'), String(s2.setCookie).slice(0, 70))
  check(`${label}: cookie HttpOnly`, typeof s2.setCookie === 'string' && /HttpOnly/i.test(s2.setCookie))
  const cookieVal = s2.setCookie ? s2.setCookie.split(';')[0] : null

  const s3 = await req(`${base}/`, cookieVal)
  console.log(`  [3] 带 cookie status=${s3.status} type=${s3.contentType} len=${s3.body.length}`)
  check(`${label}: 200 完整 UI`, s3.status === 200 && String(s3.contentType).includes('text/html'), `实际 ${s3.status}`)
  check(`${label}: 含移动端补丁 data-dsh-mobile`, s3.body.includes('data-dsh-mobile'))

  const s4 = await req(`${base}/api`, cookieVal)
  console.log(`  [4] 带 cookie /api status=${s4.status} body=${s4.body.slice(0, 60)}`)
  check(`${label}: /api 通过信任围栏(非403)`, s4.status !== 403, `实际 ${s4.status}`)
  check(`${label}: /api 通过认证(非401)`, s4.status !== 401, `实际 ${s4.status}`)
}

async function security(base) {
  console.log(`\n========== 安全回归 (${base}) ==========`)
  const s5 = await req(`${base}/?token=definitely-wrong-token`)
  console.log(`  [5] 错误 token status=${s5.status}`)
  check('错误 token 拒绝且不发 cookie', s5.status === 401 && !s5.setCookie, `status=${s5.status}`)
  const s6 = await req(`${base}/api`)
  console.log(`  [6] 无凭证 /api status=${s6.status}`)
  check('无凭证 /api 被拒', s6.status === 401 || s6.status === 403, `实际 ${s6.status}`)
  const s7 = await req(`${base}/`)
  console.log(`  [7] 无凭证 / (无 token) status=${s7.status}`)
  check('无凭证 / 不直接吐出 UI', s7.status !== 200, `实际 ${s7.status}`)
}

await flow('局域网', `http://${LAN}:${LAN_PORT}`)
await security(`http://${LAN}:${LAN_PORT}`)
await flow('外网', `https://${EXT_HOST}`)
await security(`https://${EXT_HOST}`)

console.log(`\n================ 总计: ${pass} 通过, ${fail} 失败 ================`)
process.exit(fail === 0 ? 0 : 1)
