/**
 * The plugin's own browser, hosted in the sidebar.
 *
 * DSH's built-in sidebar Browser tab owns a different browser with a different
 * cookie jar, and it registers no tools, so pointing it at a page can only ever
 * show the login screen. This module instead drives a browser the plugin owns:
 * the client half mounts its own \`<webview>\` — a real Chromium guest with its
 * own persistent partition, not the built-in tab, not its session — and this
 * half feeds it commands.
 *
 * Why a webview and not Playwright: the guest is a real browser, so it is not
 * headless and \`navigator.webdriver\` is false, while \`<webview>.sendInputEvent\`
 * injects *trusted* input, which synthetic DOM events cannot. The user can also
 * click and type inside it directly, so a slider or a login is theirs to do.
 *
 * The two halves talk over two routes the client polls, both same-origin with
 * the DSH web GUI: the client cannot fetch the live view's own port.
 *
 *   GET  /browser-use/own/command -> the next command, held open until one exists
 *   POST /browser-use/own/result  <- its outcome
 *   POST /browser-use/own/status  <- the guest's current URL and title
 *
 * @module dsh-zcode-browser-use/own
 */

/** URL prefix the client half polls for its browser. */
export const OWN_PREFIX = '/browser-use/own'

/** How long one long poll is held before answering "nothing yet". */
const POLL_HOLD_MS = 15_000

/** Default ceiling on one command, from queueing to result. */
const COMMAND_TIMEOUT_MS = 60_000

/** Largest screenshot accepted from the client, base64. */
const RESULT_BODY_LIMIT_BYTES = 24 * 1024 * 1024

/** Next command id. */
let sequence = 0

/** Commands accepted and not yet taken by a poll. */
const pending = []

/** Long polls waiting for a command. */
const waiters = []

/** Results of commands the client has finished, keyed by id. */
const results = new Map()

/** What the client last reported about its guest. */
const status = { open: false, url: null, title: null, partition: null, registration: null, identityError: null }

/**
 * The plugin's browser as the client last reported it.
 * @returns whether a tab hosts it, plus its URL, title, storage partition and
 *          what the client managed to register on activation.
 */
export function ownStatus() {
  return { ...status }
}

/**
 * Register the browser's routes on the web GUI's server.
 * @param ctx - the plugin scope whose effect owns the routes.
 * @param webServer - the service with \`register({kind, path, handler})\`.
 */
export function mountOwnBrowser(ctx, webServer) {
  const routes = [
    { kind: 'exact', path: OWN_PREFIX + '/command', handler: (_req, res) => serveCommand(res) },
    { kind: 'exact', path: OWN_PREFIX + '/result', handler: (req, res) => acceptResult(req, res) },
    {
      kind: 'exact',
      path: OWN_PREFIX + '/status',
      handler: (req, res) => (req.method === 'POST' ? acceptStatus(req, res) : readStatus(res)),
    },
  ]
  for (const route of routes) {
    ctx.effect(() => webServer.register(route), 'dsh-zcode-browser-use: ' + route.path)
  }
}

/**
 * Run one command in the plugin's browser and wait for its outcome.
 *
 * @param kind - command name understood by the client half.
 * @param args - command arguments; must be JSON-serializable.
 * @param options - optional timeout override and an abort signal.
 * @returns the client's value.
 * @throws when no tab hosts the browser, the client fails, or the command times out.
 */
export async function ownCommand(kind, args = {}, options = {}) {
  if (!status.open && kind !== 'open') {
    throw new Error(
      '自有浏览器还没打开。先在侧边栏里打开它：调用 own_browser_open。',
    )
  }
  sequence += 1
  const id = sequence
  const command = { id, kind, ...args }
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      results.delete(id)
      reject(new Error('自有浏览器没有在 ' + timeoutMs + 'ms 内回应命令 ' + kind + '；它可能已关闭或页面卡住了。'))
    }, timeoutMs)
    results.set(id, {
      settle: (payload) => {
        clearTimeout(timer)
        if (payload.ok === false) reject(new Error(String(payload.error ?? '自有浏览器执行失败')))
        else resolve(payload)
      },
    })
  })
  const waiter = waiters.shift()
  if (waiter) waiter(command)
  else pending.push(command)
  for (const entry of [...results.values()]) void entry
  return answer
}

/** Answer one long poll with the next command, or nothing after the hold. */
function serveCommand(res) {
  let done = false
  const finish = (command) => {
    if (done) return
    done = true
    clearTimeout(timer)
    const index = waiters.indexOf(deliver)
    if (index >= 0) waiters.splice(index, 1)
    sendJson(res, { command: command ?? null })
  }
  const deliver = (command) => finish(command)
  const timer = setTimeout(() => finish(null), POLL_HOLD_MS)
  const command = pending.shift()
  if (command) finish(command)
  else waiters.push(deliver)
}

/** Resolve one command from the client's report. */
async function acceptResult(req, res) {
  const payload = JSON.parse((await readBody(req)) || '{}')
  const entry = results.get(payload.id)
  if (entry === undefined) {
    sendJson(res, { ok: false, reason: 'unknown-command' })
    return
  }
  results.delete(payload.id)
  entry.settle(payload)
  sendJson(res, { ok: true })
}

/** Answer a read-only status read without touching the reported state. */
function readStatus(res) {
  sendJson(res, { ok: true, ...ownStatus() })
}

/** Record what the client reports about its guest. */
async function acceptStatus(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}')
  status.open = body.open === true
  status.url = typeof body.url === 'string' ? body.url : null
  status.title = typeof body.title === 'string' ? body.title : null
  status.partition = typeof body.partition === 'string' ? body.partition : null
  // Activation diagnostics: whether the client managed to register its tab type
  // and slot body, so a missing tab type is inspectable without the console.
  status.registration = body.registration ?? null
  status.identityError = body.identityError ?? null
  sendJson(res, { ok: true })
}

/** Read a bounded request body. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > RESULT_BODY_LIMIT_BYTES) throw new Error('result body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Write one JSON response. */
function sendJson(res, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
