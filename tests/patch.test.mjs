// 针对 lib/patch.js 的功能测试：在临时 profile 上验证受管区域读写。
//
// v1.9 起语义变化（对应 dsh 0.2.1-rc.3）：
//   · 受管区域**只写 connection.trustedHosts**，绝不再写 webserver 绑定
//     （新版拒绝通配地址；改绑具体网卡又会让本机回环监听消失）；
//   · 局域网 IP 以「无端口」形式写入，重启后端口漂移也不会失效；
//   · patch 文件路径优先取宿主 profileContext.patchPath。
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

console.log('--- patchFilePath：宿主 profileContext 优先 ---')
const ctxWithProfile = {
  get: (name) => (name === 'profileContext'
    ? { patchPath: 'C:/somewhere/profiles/desktop/cordis.patch.yml', dir: 'C:/somewhere/profiles/desktop', name: 'desktop' }
    : undefined),
}
check('profileContext.patchPath 生效', P.patchFilePath(ctxWithProfile) === 'C:/somewhere/profiles/desktop/cordis.patch.yml', P.patchFilePath(ctxWithProfile))
check('profileContext.name 生效', P.profileName(ctxWithProfile) === 'desktop')
// 官方桌面端不设 DSH_PROFILE：修复前会误写到 profiles/web
check('无 profileContext 时回退环境变量', P.patchFilePath(null) === patchFile, P.patchFilePath(null))

console.log('--- normalizeAuthority ---')
check("http://1.2.3.4:80/ -> 1.2.3.4", P.normalizeAuthority('http://1.2.3.4:80/') === '1.2.3.4', P.normalizeAuthority('http://1.2.3.4:80/'))
check("192.168.3.119:19387 保留端口", P.normalizeAuthority('192.168.3.119:19387') === '192.168.3.119:19387')
check("大写主机名小写化", P.normalizeAuthority('Example.COM') === 'example.com', P.normalizeAuthority('Example.COM'))
check("拒绝 user@host", P.normalizeAuthority('user@evil.com') === null)
check("带路径只取 authority", P.normalizeAuthority('https://cwj.dsh.cwj666.top/abc?x=1') === 'cwj.dsh.cwj666.top', P.normalizeAuthority('https://cwj.dsh.cwj666.top/abc?x=1'))
check("空串返回 null", P.normalizeAuthority('   ') === null)

console.log('--- collectTrustedAuthorities ---')
const auths = P.collectTrustedAuthorities({ lanAddresses: ['192.168.3.119', '10.0.0.5'], port: 19387, domains: ['cwj.dsh.cwj666.top'] })
check("LAN 写成无端口形式", auths.includes('192.168.3.119') && !auths.includes('192.168.3.119:19387'), JSON.stringify(auths))
check("含第二个 LAN", auths.includes('10.0.0.5'))
check("含外网域名(无端口)", auths.includes('cwj.dsh.cwj666.top'))
check("去重", new Set(auths).size === auths.length)

console.log('--- writeManagedPatch(enabled) ---')
const r1 = P.writeManagedPatch(null, { enabled: true, authorities: auths })
let txt = readFileSync(patchFile, 'utf8')
check("返回 patch 路径", r1.file === patchFile)
check("绝不写 webserver 绑定", !/- id: webserver/.test(txt), txt)
check("绝不写 0.0.0.0", !txt.includes('0.0.0.0'))
check("写入 connection 行", /- id: connection/.test(txt))
// !!js 只能标量：表达式必须整体加引号，否则 js-yaml 报 unknown tag 并让 dsh 启动失败
check("trustedHosts 合并启动参数（标量表达式）", /trustedHosts: !!js "\[\.\.\.ctx\.webStartup\.trustedHosts,/.test(txt), txt)
check("绝无未加引号的 !!js [", !/!!js\s+\[/.test(txt), txt)
check("写入 LAN authority", txt.includes("'192.168.3.119'"))
check("保留用户已有配置", txt.includes('transcriptView: standard'))
check("移除空数组占位 []", !/^\s*\[\s*\]\s*$/m.test(txt), txt)
check("含受管标记", txt.includes('# --- dsh-mobile-remote managed') && txt.includes('# --- end dsh-mobile-remote managed'))
check("无 !!js webRuntime 残留", !txt.includes('webRuntime'))
check("isManagedPatchEnabled=true", P.isManagedPatchEnabled(null) === true)
check("从受管区读出 authority", P.readManagedAuthorities(txt.split(/\r?\n/), P.findManagedBlock(txt.split(/\r?\n/))).includes('cwj.dsh.cwj666.top'))
check("读出时不会被 !!js 表达式污染", !P.readManagedAuthorities(txt.split(/\r?\n/), P.findManagedBlock(txt.split(/\r?\n/))).some((a) => a.includes('ctx')), JSON.stringify(P.readManagedAuthorities(txt.split(/\r?\n/), P.findManagedBlock(txt.split(/\r?\n/)))))

console.log('--- 幂等：再次写入不应重复块 ---')
P.writeManagedPatch(null, { enabled: true, authorities: auths })
txt = readFileSync(patchFile, 'utf8')
const startCount = (txt.match(/# --- dsh-mobile-remote managed/g) || []).length
check("受管块只有一个", startCount === 1, String(startCount))
check("connection 行只有一个", (txt.match(/- id: connection/g) || []).length === 1)

console.log('--- ensureTrustedAuthority 增量加域名（模拟外网隧道开启）---')
P.ensureTrustedAuthority(patchFile, 'new.example.com')
txt = readFileSync(patchFile, 'utf8')
check("加入新域名", txt.includes("'new.example.com'"), txt)
check("保留原 LAN", txt.includes("'192.168.3.119'"))
check("受管块仍只有一个", (txt.match(/# --- dsh-mobile-remote managed/g) || []).length === 1)
check("无旧 external trusted-host 块", !txt.includes('dsh-mobile-remote external trusted-host'))
check("语义上仍是 connection 覆盖", /- id: connection/.test(txt))

console.log('--- 迁移：旧版本写入的 webserver 绑定必须被清掉 ---')
writeFileSync(patchFile, [
  '- id: ui-chat',
  '  config:',
  '    transcriptView: standard',
  '',
  '# --- dsh-mobile-remote managed (auto-generated; do not edit) ---',
  '- id: webserver',
  '  config:',
  "    host: '0.0.0.0'",
  '    port: !!js ctx.webStartup.port ?? 3080',
  '- id: connection',
  '  config:',
  "    trustedHosts: ['192.168.3.119:3080', 'cwj.dsh.cwj666.top']",
  '# --- end dsh-mobile-remote managed ---',
  '',
].join('\n'), 'utf8')
const migrated = P.stripLegacyWebserverBinding(null)
txt = readFileSync(patchFile, 'utf8')
check("检测到并清理", migrated === true)
check("webserver 块已移除", !/- id: webserver/.test(txt), txt)
check("旧 authority 保留", txt.includes("'192.168.3.119:3080'") && txt.includes("'cwj.dsh.cwj666.top'"))
check("用户配置仍在", txt.includes('transcriptView: standard'))
check("再次调用不再改动", P.stripLegacyWebserverBinding(null) === false)

console.log('--- 关闭：整块移除，用户配置保留 ---')
P.writeManagedPatch(null, { enabled: false })
txt = readFileSync(patchFile, 'utf8')
check("无受管块", !txt.includes('# --- dsh-mobile-remote managed'))
check("无 trustedHosts", !txt.includes('trustedHosts'))
check("用户配置仍在", txt.includes('transcriptView: standard'))
check("isManagedPatchEnabled=false", P.isManagedPatchEnabled(null) === false)

console.log('--- YAML 可解析性（!!js 用自定义标签近似官方 schema）---')
try {
  const yaml = await import('js-yaml')
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({ __js: String(data) }),
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  P.writeManagedPatch(null, { enabled: true, authorities: auths })
  const parsed = yaml.load(readFileSync(patchFile, 'utf8'), { schema })
  check("解析为数组", Array.isArray(parsed), JSON.stringify(parsed))
  const conn = parsed.find((e) => e && e.id === 'connection')
  check("connection 项存在", !!conn)
  check("trustedHosts 是 !!js 表达式", !!(conn && conn.config.trustedHosts && conn.config.trustedHosts.__js), JSON.stringify(conn))
  check("表达式里带上了 authority", String(conn.config.trustedHosts.__js).includes("'cwj.dsh.cwj666.top'"))
} catch (e) {
  console.log(`  SKIP js-yaml 不可用: ${e.message}`)
}

rmSync(home, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
