/**
 * QR sign-in.
 *
 * Bilibili's official passport flow is a two-step API: `qrcode/generate`
 * returns a login URL plus a key, and `qrcode/poll` reports scan progress and,
 * on success, sets the session cookies. The plugin renders the URL as a PNG
 * itself, so no browser is involved and the user only has to scan the code with
 * the Bilibili mobile app.
 *
 * @module dsh-bilibili-summary/login
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchJsonResponse } from './http.js'
import { dshHome, saveCookieFile } from './cookies.js'
import { renderQrPng } from './qr.js'
import { fetchAccount } from './api.js'

/** QR generation endpoint. */
const GENERATE_API = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'

/** QR polling endpoint. */
const POLL_API = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'

/** Seconds a freshly generated code stays valid. */
export const QR_TTL_SECONDS = 180

/** Poll status codes returned in `data.code`. */
const POLL_STATUS = {
  0: 'success',
  86038: 'expired',
  86090: 'scanned',
  86101: 'waiting',
}

/**
 * Where the pending QR key is remembered between tool calls.
 * @returns the absolute path of the sign-in state file.
 */
export function loginStateFile() {
  return join(dshHome(), 'bilibili-login.json')
}

/**
 * Ask for a fresh login QR code and render it as a PNG.
 * @param options - output path, scale, timeout, and cancellation.
 * @returns the key, the encoded URL, and the written image.
 */
export async function startQrLogin(options = {}) {
  const { payload } = await fetchJsonResponse(GENERATE_API, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
  })
  if (payload?.code !== 0 || !payload?.data?.qrcode_key) {
    throw new Error(`Bilibili refused to issue a login QR code (code ${payload?.code}: ${payload?.message ?? 'unknown'})`)
  }
  const { url, qrcode_key: qrcodeKey } = payload.data
  const image = renderQrPng(url, { scale: options.scale ?? 8 })
  const outPath = options.outPath ?? join(process.cwd(), 'bilibili-login', 'bilibili-qr.png')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, image.buffer)
  const state = {
    qrcodeKey,
    loginUrl: url,
    qrPath: outPath,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + QR_TTL_SECONDS * 1000).toISOString(),
  }
  try {
    writeFileSync(loginStateFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // The state file is only a convenience; the caller may pass the key back.
  }
  return { ...state, size: image.size, modules: image.modules, bytes: image.buffer.length, expiresInSec: QR_TTL_SECONDS }
}

/**
 * Poll until the user scans, the code expires, or the budget runs out.
 * @param options - QR key, wait budget, cookie-file target, and cancellation.
 * @returns a status record; `success` includes the saved account.
 */
export async function pollQrLogin(options = {}) {
  const qrcodeKey = options.qrcodeKey
  if (typeof qrcodeKey !== 'string' || qrcodeKey.length === 0) {
    throw new Error('a qrcodeKey from bilibili_login { action: "start" } is required')
  }
  const timeoutSec = options.timeoutSec ?? 150
  const intervalMs = options.intervalMs ?? 2000
  const deadline = Date.now() + timeoutSec * 1000
  let lastStatus
  while (Date.now() < deadline) {
    const { payload, setCookies } = await fetchJsonResponse(
      `${POLL_API}?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`,
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        referer: 'https://www.bilibili.com/',
        origin: 'https://www.bilibili.com',
      },
    )
    const data = payload?.data ?? {}
    const status = POLL_STATUS[data.code] ?? `code-${data.code}`
    lastStatus = status
    if (status === 'success') {
      const account = await fetchAccount({ cookie: Object.entries(setCookies).map(([k, v]) => `${k}=${v}`).join('; ') })
      const saved = saveCookieFile({
        cookies: setCookies,
        user: account.loggedIn ? { mid: account.mid, name: account.name } : undefined,
        file: options.cookieFile,
      })
      return {
        status: 'success',
        message: data.message || '登录成功',
        cookieFile: saved.file,
        cookieNames: Object.keys(saved.record.cookies),
        user: account.loggedIn ? { mid: account.mid, name: account.name } : undefined,
      }
    }
    if (status === 'expired') return { status: 'expired', message: data.message || '二维码已过期' }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { status: 'timeout', message: `still ${lastStatus ?? 'waiting'} after ${timeoutSec}s; the QR code may have expired` }
}
