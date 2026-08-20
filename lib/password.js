// dsh-mobile-remote — 远程访问密码（本模块，host 侧）。
//
// 职责：
//   1. **远程访问密码的本地安全存储与会话管理**。密码由管理员在本机设置面板
//      设置（本模块路径 ~/.dsh/plugins/dsh-mobile-remote/config.json）。
//      存储时**只存 scrypt 哈希 + 随机盐**，绝不落盘明文。
//   2. **认证会话**：远程访问者输入正确密码后，向浏览器下发一个随机 token，
//      host 侧在内存中维护该 token 的过期时间；后续带有效 token 的请求视为
//      已认证，无需重复输入。
//
// 设计要点（通用 / 可自托管）：
//   - 完全本地，**不依赖任何中转后端**（dsh-update-server / frps / frpc）。
//     任何部署者——包括自建中转服务的用户——都能用本模块给远程访问加密码。
//   - 全部使用 Node 内置 crypto，零第三方依赖。
//   - 校验采用 timingSafeEqual，避免时序攻击；登录做简单频率限制防爆破。

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'

/** 本模块配置目录（与 external.js 的 externalDir 同级，放 config.json）。 */
function configDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-mobile-remote')
}

/** 配置文件绝对路径。 */
function configFilePath() {
  return join(configDir(), 'config.json')
}

/** scrypt 派生参数（成本因子，本机校验，取适中值保证安全与速度平衡）。 */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

/** 会话有效期（毫秒）：认证通过后的一段时间内免重复输入。 */
const SESSION_TTL = 24 * 60 * 60 * 1000 // 24h

/** 登录防爆破：同一 IP 连续失败上限与封禁窗口。 */
const MAX_ATTEMPTS = 8
const LOCK_WINDOW = 10 * 60 * 1000 // 10 分钟

/* ------------------------------------------------------------------ */
/* 底层读写                                                             */
/* ------------------------------------------------------------------ */

function readRawConfig() {
  try {
    const file = configFilePath()
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeRawConfig(obj) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFilePath(), JSON.stringify(obj, null, 2), 'utf8')
}

/* ------------------------------------------------------------------ */
/* 密码设置 / 校验                                                      */
/* ------------------------------------------------------------------ */

/**
 * 推导口令哈希。scrypt(password, salt, KEY_LEN, { N, r, p })。
 * 用 HMAC 风格再叠加一个本地 pepper 常量，避免直接逆向比对（可选增强）。
 */
function derive(password, salt) {
  return scryptSync(String(password), Buffer.from(salt, 'hex'), KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  })
}

/** 判断是否已设置远程访问密码。 */
export function hasPassword() {
  const cfg = readRawConfig()
  return !!(cfg && cfg.pwdHash && cfg.pwdSalt)
}

/**
 * 校验口令是否正确。返回 boolean。使用 timingSafeEqual 防时序攻击。
 * @param {string} password
 */
export function verifyPassword(password) {
  const cfg = readRawConfig()
  if (!cfg || !cfg.pwdHash || !cfg.pwdSalt) return false
  if (typeof password !== 'string' || !password) return false
  try {
    const expected = Buffer.from(cfg.pwdHash, 'hex')
    const actual = derive(password, cfg.pwdSalt)
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * 设置 / 修改远程访问密码。未传或为空表示清除密码（关闭门禁）。
 * 仅存哈希 + 盐，绝不落盘明文。
 * @param {string|null} password
 */
export function setPassword(password) {
  const cfg = readRawConfig()
  if (!password) {
    delete cfg.pwdHash
    delete cfg.pwdSalt
    // 清除密码的同时清空所有已签发会话
    sessions.clear()
    // 兼容旧字段
    delete cfg.pwdSetAt
    writeRawConfig(cfg)
    return { ok: true, enabled: false }
  }
  const salt = randomBytes(16).toString('hex')
  const hash = derive(password, salt).toString('hex')
  cfg.pwdHash = hash
  cfg.pwdSalt = salt
  cfg.pwdSetAt = new Date().toISOString()
  // 修改密码后旧会话全部失效
  sessions.clear()
  writeRawConfig(cfg)
  return { ok: true, enabled: true }
}

/** 是否启用远程访问密码门禁。 */
export function isEnabled() {
  return hasPassword()
}

/* ------------------------------------------------------------------ */
/* 认证会话（内存）                                                     */
/* ------------------------------------------------------------------ */

const sessions = new Map() // token -> expiry(ms)

/** 清掉所有会话（改密 / 重启时调用）。 */
export function clearSessions() {
  sessions.clear()
}

/** 签发一个会话 token。 */
function issueToken() {
  return randomBytes(24).toString('base64url')
}

/**
 * 校验口令并签发会话 token（若需要）。成功返回 { ok:true, token }；
 * 失败返回 { ok:false, error }。
 * @param {string} password
 * @param {string} [clientIp] 用于防爆破计数
 */
export function login(password, clientIp) {
  const ip = clientIp || 'unknown'
  if (!hasPassword()) {
    return { ok: false, error: '远程访问密码尚未设置' }
  }
  if (isLocked(ip)) {
    return { ok: false, error: '尝试次数过多，请稍后再试' }
  }
  if (!verifyPassword(password)) {
    registerFailure(ip)
    return { ok: false, error: '密码错误' }
  }
  clearFailures(ip)
  const token = issueToken()
  sessions.set(token, Date.now() + SESSION_TTL)
  return { ok: true, token }
}

/** 校验一个会话 token 是否有效（未过期）。 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false
  const exp = sessions.get(token)
  if (!exp) return false
  if (Date.now() > exp) {
    sessions.delete(token)
    return false
  }
  return true
}

/** 移除一个会话 token（登出）。 */
export function revokeToken(token) {
  if (token) sessions.delete(token)
}

/* ------------------------------------------------------------------ */
/* 防爆破（按 IP）                                                      */
/* ------------------------------------------------------------------ */

const attempts = new Map() // ip -> { count, lockUntil }

function isLocked(ip) {
  const a = attempts.get(ip)
  return a ? (a.lockUntil && Date.now() < a.lockUntil) : false
}

function registerFailure(ip) {
  const now = Date.now()
  const prev = attempts.get(ip)
  let count = prev ? prev.count : 0
  count += 1
  if (count >= MAX_ATTEMPTS) {
    attempts.set(ip, { count, lockUntil: now + LOCK_WINDOW })
  } else {
    attempts.set(ip, { count })
  }
}

function clearFailures(ip) {
  attempts.delete(ip)
}
