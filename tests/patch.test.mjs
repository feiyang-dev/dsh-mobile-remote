// 针对 lib/patch.js 的功能测试：在临时 profile 上验证受管区域读写。
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-patch-test-'))
const profileDir = join(home, 'profiles', 'testprof')
mkdirSync(profileDir, { recursive: true })
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_PROFILE = 'testprof'

const patchFile = join(profileDir, 'cordis.patch.yml')
// 模拟官方模板：含空数组占位行 + 用户已有配置
writeFileSync(patchFile, [
  '# profile patch layer',
  '[]',
  '- id: ui-chat',
  '  config:',
  '    transcriptView: standard',
  '',
].join('\n'), 'utf8')

const P = await import('../lib/patch.js')

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

console.log('--- normalizeAuthority ---')
check("http://1.2.3.4:80/ -> 1.2.3.4", P.normalizeAuthority('http://1.2.3.4:80/') === '1.2.3.4', P.normalizeAuthority('http://1.2.3.4:80/'))
check("192.168.3.119:19387 保留端口", P.normalizeAuthority('192.168.3.119:19387') === '192.168.3.119:19387')
check("大写主机名小写化", P.normalizeAuthority('Example.COM') === 'example.com', P.normalizeAuthority('Example.COM'))
check("拒绝 user@host", P.normalizeAuthority('user@evil.com') === null)
check("带路径只取 authority", P.normalizeAuthority('https://cwj.dsh.cwj666.top/abc?x=1') === 'cwj.dsh.cwj666.top', P.normalizeAuthority('https://cwj.dsh.cwj666.top/abc?x=1'))
check("空串返回 null", P.normalizeAuthority('   ') === null)

console.log('--- collectTrustedAuthorities ---')
const auths = P.collectTrustedAuthorities({ lanAddresses: ['192.168.3.119', '10.0.0.5'], port: 19387, domains: ['cwj.dsh.cwj666.top'] })
check("含 LAN:端口", auths.includes('192.168.3.119:19387'), JSON.stringify(auths))
check("含第二个 LAN", auths.includes('10.0.0.5:19387'))
check("含外网域名(无端口)", auths.includes('cwj.dsh.cwj666.top'))
check("去重", new Set(auths).size === auths.length)

console.log('--- writeManagedPatch(enabled) ---')
const r1 = P.writeManagedPatch(null, { enabled: true, port: 19387, authorities: auths })
let txt = readFileSync(patchFile, 'utf8')
check("返回 patch 路径", r1.file === patchFile)
check("写入 host 0.0.0.0", txt.includes("host: '0.0.0.0'"))
check("写入 trustedHosts 数组", /trustedHosts: \['192\.168\.3\.119:19387'/.test(txt), txt)
check("保留用户已有配置", txt.includes('transcriptView: standard'))
check("移除空数组占位 []", !/^\s*\[\s*\]\s*$/m.test(txt), txt)
check("含受管标记", txt.includes('# --- dsh-mobile-remote managed') && txt.includes('# --- end dsh-mobile-remote managed'))
check("无 !!js webRuntime 残留", !txt.includes('webRuntime'))
check("isManagedPatchEnabled=true", P.isManagedPatchEnabled(null) === true)
check("从受管区读出 authority", P.readManagedAuthorities(txt.split(/\r?\n/), P.findManagedBlock(txt.split(/\r?\n/))).includes('cwj.dsh.cwj666.top'))

console.log('--- 幂等：再次写入不应重复块 ---')
P.writeManagedPatch(null, { enabled: true, port: 19387, authorities: auths })
txt = readFileSync(patchFile, 'utf8')
const startCount = (txt.match(/# --- dsh-mobile-remote managed/g) || []).length
check("受管块只有一个", startCount === 1, String(startCount))
const cfgCount = (txt.match(/- id: webserver/g) || []).length
check("webserver 块只有一个", cfgCount === 1, String(cfgCount))

console.log('--- ensureTrustedAuthority 增量加域名（模拟外网隧道开启）---')
P.ensureTrustedAuthority(patchFile, 'new.example.com')
txt = readFileSync(patchFile, 'utf8')
check("加入新域名", txt.includes("'new.example.com'"), txt)
check("保留原 LAN", txt.includes("'192.168.3.119:19387'"))
check("保留 host 0.0.0.0", txt.includes("host: '0.0.0.0'"))
check("受管块仍只有一个", (txt.match(/# --- dsh-mobile-remote managed/g) || []).length === 1)
check("无旧 external trusted-host 块", !txt.includes('dsh-mobile-remote external trusted-host'))
check("无 !!js trustedHosts 表达式", !/trustedHosts: !!js/.test(txt))

console.log('--- 关闭：整块移除，用户配置保留 ---')
P.writeManagedPatch(null, { enabled: false, port: 19387 })
txt = readFileSync(patchFile, 'utf8')
check("无 host 0.0.0.0", !txt.includes("host: '0.0.0.0'"))
check("无受管块", !txt.includes('# --- dsh-mobile-remote managed'))
check("无 trustedHosts", !txt.includes('trustedHosts'))
check("用户配置仍在", txt.includes('transcriptView: standard'))
check("isManagedPatchEnabled=false", P.isManagedPatchEnabled(null) === false)

console.log('--- YAML 可解析性（用 js-yaml，仅测试用）---')
try {
  const yaml = await import('js-yaml')
  P.writeManagedPatch(null, { enabled: true, port: 19387, authorities: auths })
  const parsed = yaml.load(readFileSync(patchFile, 'utf8'))
  check("解析为数组", Array.isArray(parsed), JSON.stringify(parsed))
  check("含 webserver 项", parsed.some((e) => e && e.id === 'webserver'))
  const conn = parsed.find((e) => e && e.id === 'connection')
  check("connection.trustedHosts 是数组", conn && Array.isArray(conn.config.trustedHosts), JSON.stringify(conn))
  check("trustedHosts 全为字符串", conn && conn.config.trustedHosts.every((x) => typeof x === 'string'))
} catch (e) {
  console.log(`  SKIP js-yaml 不可用: ${e.message}`)
}

rmSync(home, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
