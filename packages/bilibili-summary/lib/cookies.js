/**
 * Bilibili credential storage.
 *
 * A signed-in `SESSDATA` is what unlocks the AI subtitle track. This module
 * resolves credentials from, in order: an explicit value, the process
 * environment, `$DSH_HOME/.env`, then the cookie file the QR sign-in writes.
 * The file holds the whole cookie jar, so `bili_jct`, `DedeUserID`, `buvid3`
 * and friends survive too.
 *
 * @module dsh-bilibili-summary/cookies
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cookie names kept from a sign-in response; anything else is dropped. */
export const KEPT_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4']

/**
 * Resolve the DSH home directory.
 * @returns the configured home, or `~/.dsh`.
 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Default credential location.
 * @returns the absolute cookie-file path.
 */
export function defaultCookieFile() {
  return join(dshHome(), 'bilibili-cookies.json')
}

/**
 * Read one `KEY=value` entry from `$DSH_HOME/.env`.
 * @param key - variable name.
 * @returns the trimmed value, or undefined when absent.
 */
export function readDshEnv(key) {
  let text
  try {
    text = readFileSync(join(dshHome(), '.env'), 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match && match[1] === key) return match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return undefined
}

/**
 * Render a cookie map as one `Cookie` header value.
 * @param cookies - cookie name/value pairs.
 * @returns the header value, or an empty string.
 */
export function cookieHeader(cookies) {
  return Object.entries(cookies ?? {})
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/**
 * Keep only the cookies this plugin cares about.
 * @param cookies - raw cookie map.
 * @returns the filtered map.
 */
export function pickCookies(cookies) {
  const kept = {}
  for (const name of KEPT_COOKIES) {
    const value = cookies?.[name]
    if (typeof value === 'string' && value.length > 0) kept[name] = value
  }
  for (const [name, value] of Object.entries(cookies ?? {})) {
    if (name.startsWith('buvid') && !kept[name]) kept[name] = value
  }
  return kept
}

/**
 * Read the stored credential record.
 * @param file - cookie-file path.
 * @returns the parsed record, or undefined when missing or malformed.
 */
export function readCookieFile(file = defaultCookieFile()) {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const cookies = typeof parsed.cookies === 'object' && parsed.cookies !== null ? parsed.cookies : {}
    return { savedAt: parsed.savedAt, source: parsed.source, user: parsed.user, cookies: pickCookies(cookies) }
  } catch {
    return undefined
  }
}

/**
 * Resolve the credential a request should use.
 * @param options - explicit `sessdata` and `cookieFile` overrides.
 * @returns the cookie map plus where it came from.
 */
export function loadCredentials(options = {}) {
  const file = options.cookieFile || readDshEnv('BILIBILI_COOKIE_FILE') || defaultCookieFile()
  const explicit = options.sessdata || process.env.BILIBILI_SESSDATA || readDshEnv('BILIBILI_SESSDATA')
  const stored = readCookieFile(file)
  if (explicit) {
    return { cookies: { ...(stored?.cookies ?? {}), SESSDATA: explicit }, source: 'config', file, user: stored?.user }
  }
  if (stored && stored.cookies.SESSDATA) {
    return { cookies: stored.cookies, source: stored.source ?? 'file', file, user: stored.user, savedAt: stored.savedAt }
  }
  return { cookies: {}, source: 'none', file }
}

/**
 * Persist a signed-in cookie jar.
 * @param options - cookie map, optional user, and target path.
 * @returns the written path and record.
 */
export function saveCookieFile(options) {
  const file = options.file || defaultCookieFile()
  mkdirSync(dirname(file), { recursive: true })
  const record = {
    savedAt: new Date().toISOString(),
    source: options.source ?? 'qrcode',
    user: options.user,
    cookies: pickCookies(options.cookies),
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  try {
    chmodSync(file, 0o600)
  } catch {
    // Permission tightening is best-effort; the file still works.
  }
  return { file, record }
}

/**
 * Delete the stored credential.
 * @param file - cookie-file path.
 * @returns true when a file was removed.
 */
export function clearCookieFile(file = defaultCookieFile()) {
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}
