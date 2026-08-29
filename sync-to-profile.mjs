#!/usr/bin/env node
// dsh-mobile-remote 本地热同步脚本（无需发布 NPM）。
//
// 背景：
//   已安装的插件实体在 ~/.dsh/profiles/<profile>/node_modules/@feiyang666/dsh-mobile-remote/。
//   dsh 对已安装插件的加载方式（分析 deepseek-harness 源码结论）：
//     - host 侧（lib/index.js 等）：运行在 dsh 的 Node 进程，Cordis loader 有模块缓存，
//       且 HMR watcher 默认忽略 **/node_modules → 改完需【重启 dsh 服务】才生效。
//     - client 侧（lib/client.js）：由 dsh-client-modules 经 /plugins/<id>/client.js 路由
//       每次实时 readFile 提供（cache-control: no-cache）→ 同步后【浏览器刷新】即生效，
//       无需重启 dsh、无需发布 NPM。
//
// 用法：
//   node sync-to-profile.mjs                 # 同步到默认 profile（web）
//   DSH_PROFILE=myprofile node sync-to-profile.mjs
//   DSH_HOME=D:/some/.dsh node sync-to-profile.mjs
//
// 同步内容：lib/ 全部 JS + cordis.patch.yml + package.json（保留目标目录已装的 ws 依赖）。
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const profile = process.env.DSH_PROFILE || 'web'
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const target = join(home, 'profiles', profile, 'node_modules', '@feiyang666', 'dsh-mobile-remote')

if (!existsSync(target)) {
  console.error(`[同步失败] 未找到已安装的插件目录：${target}`)
  console.error('请先在桌面端「插件管理」或 CLI 安装一次 @feiyang666/dsh-mobile-remote。')
  process.exit(1)
}

// 需要同步的文件：lib 下全部 JS + patch + manifest。
const libFiles = readdirSync(join(here, 'lib')).filter((f) => f.endsWith('.js'))
const FILES = [...libFiles.map((f) => join('lib', f)), 'cordis.patch.yml', 'package.json']

let copied = 0
for (const rel of FILES) {
  const src = join(here, rel)
  if (!existsSync(src)) {
    console.warn(`  [跳过] 本地不存在：${rel}`)
    continue
  }
  const dst = join(target, rel)
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  console.log(`  ✓ ${rel}`)
  copied += 1
}

console.log(`\n已同步 ${copied} 个文件到：${target}`)
console.log('')
console.log('接下来按改动范围处理：')
console.log('  1. 只改了 lib/client.js（前端 UI）→ 直接刷新浏览器页面即可生效，无需重启。')
console.log('     （dsh 的 /plugins/<id>/client.js 每次实时读文件，刷新即拿新代码）')
console.log('  2. 改了 lib/index.js / external.js / ws-client.js 等 host 侧代码')
console.log('     → 需重启 dsh 服务：桌面端点「停止」再「启动」，或 CLI 重启。')
console.log('     （host 侧在 Node 进程内有模块缓存，且 HMR 默认忽略 node_modules，必须重启）')
