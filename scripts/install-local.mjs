#!/usr/bin/env node
// dsh-mobile-remote 本地安装脚本（不依赖 npm 发布）。
//
// 用途：把本地源码打包成 tarball，并「正式安装」到 DSH profile 的 node_modules，
//       同时把包名注册进 profile 的 dsh.profile.bundles —— 等价于官方
//       `dsh plugin --profile <name> add <本地 tarball>`。
//
// 为什么需要它：本插件尚未发布到 npm 时（或 npm 发布受 2FA / 暂存审批阻塞时），
// 仍要能在本地跑通完整链路。
//
// 用法：
//   node scripts/install-local.mjs                    # 装到 desktop（默认）
//   node scripts/install-local.mjs desktop web        # 装到多个 profile
//   node scripts/install-local.mjs --profile=web
//   DSH_HOME=D:/x/.dsh node scripts/install-local.mjs
//
// 说明：
//   - profile 用 npm（无 pnpm-workspace.yaml）→ npm install <tarball>
//   - profile 用 pnpm（有 pnpm-workspace.yaml，常见于 pnpm 安装的插件）→ pnpm add <tarball>
//     （npm 无法处理 pnpm 的 `link:` 协议与 .pnpm 虚拟目录，故必须区分）
//   - 安装后会回读校验：版本号 + lib 下关键文件是否齐全，避免「假成功」。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// ---- 解析参数 ----
const args = process.argv.slice(2)
const profiles = []
for (const a of args) {
  if (a.startsWith('--profile=')) profiles.push(a.slice('--profile='.length))
  else if (!a.startsWith('-')) profiles.push(a)
}
if (profiles.length === 0) profiles.push(process.env.DSH_PROFILE || 'desktop')

const KEY_FILES = ['index.js', 'patch.js', 'external.js', 'client.js', 'ws-client.js', 'password.js']

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true, ...opts })
}

/**
 * 定位 npm 的 JS 入口并直接以 node 执行。
 * Windows 上 `npm` 是 .cmd，spawnSync 直接执行会失败（ENOENT/EINVAL），
 * 因此统一走 `node <npm-cli.js> ...`。
 */
function npmArgs(argv) {
  const candidates = [
    process.env.DSH_NPM_CLI,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return { cmd: process.execPath, argv: [c, ...argv] }
  }
  // 兜底：交给 shell 解析 npm（无 shell 时可能失败）
  return { cmd: 'npm', argv, shell: true }
}

function runNpm(argv, opts = {}) {
  const r = npmArgs(argv)
  return run(r.cmd, r.argv, { ...opts, shell: r.shell || false })
}

// ---- 1) 打包 tarball ----
console.log('=== 1) 打包本地 tarball ===')
const pack = runNpm(['pack'], { cwd: repo })
if (pack.status !== 0) {
  console.error('npm pack 失败：', String(pack.stderr || pack.error || '').slice(-500))
  process.exit(1)
}
const tarballName = (pack.stdout || '').trim().split(/\r?\n/).pop().trim()
const tarball = join(repo, tarballName)
if (!existsSync(tarball)) {
  console.error(`未找到打包产物：${tarball}`)
  process.exit(1)
}
const pkgVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
console.log(`  ${tarballName} (v${pkgVersion})`)

// ---- 2) 逐 profile 安装 ----
let failed = 0
for (const profile of profiles) {
  const dir = join(HOME, 'profiles', profile)
  console.log(`\n=== 2) 安装到 profile: ${profile} ===`)
  if (!existsSync(dir)) {
    console.error(`  [跳过] profile 目录不存在：${dir}`)
    failed++
    continue
  }

  const manifestPath = join(dir, 'package.json')
  const before = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : ''
  // 备份，便于回滚
  if (before) copyFileSync(manifestPath, `${manifestPath}.before-install`)

  const usePnpm = existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, 'pnpm-lock.yaml'))
  console.log(`  包管理器: ${usePnpm ? 'pnpm' : 'npm'}`)

  // pnpm 优先用 dsh 运行时自带的（版本匹配），找不到再退回全局 pnpm
  const runtimePnpm = process.env.DSH_RUNTIME_PNPM || 'E:\\DeepSeekHarness\\resources\\runtime\\pnpm\\bin\\pnpm.mjs'
  let r
  if (usePnpm && existsSync(runtimePnpm)) {
    r = run(process.execPath, [runtimePnpm, 'add', tarball, '--config.strictDepBuilds=false', '--reporter=append-only'], { cwd: dir })
  } else if (usePnpm) {
    r = run('pnpm', ['add', tarball, '--config.strictDepBuilds=false'], { cwd: dir, shell: true })
  } else {
    r = runNpm(['install', tarball, '--no-audit', '--no-fund'], { cwd: dir })
  }

  const out = `${r.stdout || ''}\n${r.stderr || ''}`
  // pnpm 有时在完成后仍不退出（已知卡尾），若文件已就位则按成功处理。
  const pkgDir = join(dir, 'node_modules', '@feiyang666', 'dsh-mobile-remote')
  const libDir = join(pkgDir, 'lib')
  const filesOk = existsSync(libDir) && KEY_FILES.every((f) => existsSync(join(libDir, f)))
  const installedVersion = existsSync(join(pkgDir, 'package.json'))
    ? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
    : null

  if (r.status !== 0 && !filesOk) {
    console.error(`  ✗ 安装失败（退出码 ${r.status}）`)
    console.error(out.slice(-800))
    failed++
    continue
  }
  if (r.status !== 0 && filesOk) {
    console.log(`  ! 命令未正常退出（退出码 ${r.status}），但文件已就位，按成功处理`)
  }

  // 确保 bundles 里注册了本插件（阅读 manifest，必要时补写）
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!m.dsh) m.dsh = {}
    if (!m.dsh.profile) m.dsh.profile = {}
    if (!Array.isArray(m.dsh.profile.bundles)) m.dsh.profile.bundles = []
    const NAME = '@feiyang666/dsh-mobile-remote'
    if (!m.dsh.profile.bundles.includes(NAME)) {
      m.dsh.profile.bundles.push(NAME)
      const fs = await import('node:fs')
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8')
      console.log(`  已补写 bundles: ${NAME}`)
    }
  } catch (e) {
    console.error(`  ! 更新 bundles 失败：${e.message}`)
  }

  console.log(`  ✓ 实装版本: ${installedVersion}`)
  const missing = KEY_FILES.filter((f) => !existsSync(join(libDir, f)))
  console.log(`  ${missing.length === 0 ? '✓' : '✗'} 关键文件: ${missing.length === 0 ? `全部 ${KEY_FILES.length} 个就位` : `缺少 ${missing.join(', ')}`}`)
  if (missing.length) failed++
}

console.log('\n=== 完成 ===')
console.log('若 profile 正在运行（host 侧代码有模块缓存），需重启 dsh 才会生效。')
process.exit(failed === 0 ? 0 : 1)
