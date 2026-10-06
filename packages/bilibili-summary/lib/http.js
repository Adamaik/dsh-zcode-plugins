/**
 * HTTP plumbing shared by the Bilibili API client and the sign-in flow.
 *
 * Every request carries a desktop browser user agent and a `bilibili.com`
 * referer: several endpoints answer differently (or not at all) without them.
 * Nothing here retries; callers own their backoff because the subtitle route
 * rate-limits with degraded payloads rather than clean errors.
 *
 * @module dsh-bilibili-summary/http
 */

/** Browser user agent used for every Bilibili request. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Error raised when Bilibili answers with a non-zero business code. */
export class BilibiliError extends Error {
  /**
   * @param message - human-readable failure.
   * @param options - business code and request URL.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'BilibiliError'
    this.code = options.code
    this.url = options.url
    this.detail = options.detail
  }
}

/**
 * Combine a caller signal with a timeout signal.
 * @param timeoutMs - per-request budget.
 * @param signal - caller cancellation, when present.
 * @returns a signal that aborts on either event.
 */
function withTimeout(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Build the header set every Bilibili request shares.
 * @param options - request options.
 * @returns the header map.
 */
function requestHeaders(options) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(options.referer ? { Referer: options.referer } : {}),
    ...(options.origin ? { Origin: options.origin } : {}),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(options.headers ?? {}),
  }
}

/**
 * Perform one HTTP request and return the raw body.
 *
 * `/x/v2/subtitle/web/view` answers with protobuf, so the bytes matter more
 * than any decoded form.
 *
 * @param url - absolute URL.
 * @param options - headers, timeout, and cancellation.
 * @returns the response status, headers, and body bytes.
 */
export async function fetchBytes(url, options = {}) {
  const response = await fetch(url, {
    headers: requestHeaders(options),
    redirect: options.redirect ?? 'follow',
    signal: withTimeout(options.timeoutMs ?? 20_000, options.signal),
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    throw new BilibiliError(`HTTP ${response.status} from ${url}`, {
      url,
      detail: buffer.subarray(0, 300).toString('utf8'),
    })
  }
  return { status: response.status, headers: response.headers, buffer }
}

/**
 * Perform one HTTP request; return the payload, the response, and its cookies.
 *
 * The sign-in poll reads `Set-Cookie` from the response itself, so the raw
 * response has to survive decoding.
 *
 * @param url - absolute URL.
 * @param options - headers, timeout, and cancellation.
 * @returns the parsed JSON payload plus response metadata.
 */
export async function fetchJsonResponse(url, options = {}) {
  const headers = requestHeaders(options)
  const response = await fetch(url, {
    headers,
    redirect: options.redirect ?? 'follow',
    signal: withTimeout(options.timeoutMs ?? 20_000, options.signal),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new BilibiliError(`HTTP ${response.status} from ${url}`, { url, detail: text.slice(0, 300) })
  }
  try {
    return { payload: JSON.parse(text), response, setCookies: collectSetCookies(response.headers) }
  } catch {
    throw new BilibiliError(`response from ${url} was not JSON`, { url, detail: text.slice(0, 300) })
  }
}

/**
 * Perform one HTTP request and decode the JSON body.
 * @param url - absolute URL.
 * @param options - headers, timeout, and cancellation.
 * @returns the parsed JSON payload.
 */
export async function fetchJson(url, options = {}) {
  return (await fetchJsonResponse(url, options)).payload
}

/**
 * Perform one request whose body is JSON, asserting the business code.
 * @param url - absolute URL.
 * @param options - request options.
 * @param expected - business codes accepted as success; defaults to `[0]`.
 * @returns the parsed payload.
 */
export async function fetchBilibiliJson(url, options = {}, expected = [0]) {
  const payload = await fetchJson(url, options)
  if (!expected.includes(payload?.code)) {
    throw new BilibiliError(`Bilibili returned code ${payload?.code}: ${payload?.message ?? 'unknown'}`, {
      code: payload?.code,
      url,
      detail: payload?.message,
    })
  }
  return payload
}

/**
 * Read the `Set-Cookie` names and values from a response's headers.
 * @param headers - fetch response headers.
 * @returns a plain cookie map.
 */
export function collectSetCookies(headers) {
  const jar = {}
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  for (const raw of list) {
    const pair = raw.split(';')[0]
    const index = pair.indexOf('=')
    if (index <= 0) continue
    jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
  }
  return jar
}
