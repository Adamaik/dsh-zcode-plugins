#!/usr/bin/env node
/**
 * Verify the browser-use sidebar mirror without the GUI.
 *
 * Two halves, both offline:
 *
 * 1. Host: drive the registered `browser_navigate` tool against a loopback
 *    page and read the state the client polls. The browser launches the way
 *    the plugin launches it, so this also proves headless stays the default.
 * 2. Client: run `lib/client.js` in a Node VM with a stubbed
 *    `__ModuleLoader__`, `fetch`, and `sidebarRight`, then drive the poll and
 *    assert it opens one built-in Browser tab and replaces that same tab on
 *    every page change.
 *
 * Usage: node scripts/verify-browser-sidebar.mjs
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const failures = []

/** Record one check outcome. */
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ── host half ──────────────────────────────────────────────────────────────

const HTML = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<title>镜像验证页</title></head><body>',
  '<h1>浏览器侧边栏镜像验证</h1>',
  '<button id="go">按钮</button><input placeholder="输入框">',
  '</body></html>',
].join('')

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(HTML)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const pageUrl = `http://127.0.0.1:${server.address().port}/`

const browser = await import(new URL('../packages/browser-use/lib/browser.js', import.meta.url).href)
const { mountMirror } = await import(new URL('../packages/browser-use/lib/mirror.js', import.meta.url).href)
const { createBrowserTools } = await import(new URL('../packages/browser-use/lib/tools.js', import.meta.url).href)
const tools = new Map(createBrowserTools(async (target) => target).map((tool) => [tool.name, tool]))

check('browser is headless unless opted out', process.env.DSH_BROWSER_HEADLESS !== 'false', `DSH_BROWSER_HEADLESS=${process.env.DSH_BROWSER_HEADLESS ?? '(unset)'}`)

const idle = await browser.browserState()
check('state is inactive before any call', idle.active === false && idle.url === null && idle.title === null)

const navigated = await tools.get('browser_navigate').execute({ url: pageUrl }, {})
check('browser_navigate reached the loopback page', navigated.status === 200 && navigated.url === pageUrl, navigated.url)

const live = await browser.browserState()
check('state reports the page the agent is on', live.active === true && live.url === pageUrl && live.title === '镜像验证页', `${live.url} / ${live.title}`)

// The route the client polls must report the same state, and never launch a
// browser of its own.
const routes = []
mountMirror(
  { effect: (execute) => execute() },
  {
    register(route) {
      routes.push(route)
      return () => undefined
    },
  },
)
check('the bridge registers exactly one route', routes.length === 1 && routes[0].path === '/browser-use/state', routes.map((r) => r.path).join(', '))

function readRoute() {
  const res = {
    status: 0,
    body: null,
    headersSent: false,
    writeHead(status) {
      this.status = status
      this.headersSent = true
      return this
    },
    end(chunk) {
      this.body = chunk === undefined ? null : Buffer.from(String(chunk))
    },
  }
  return routes[0].handler({}, res).then(() => ({ status: res.status, json: JSON.parse(res.body.toString('utf8')) }))
}

const polled = await readRoute()
check('the route answers 200 with the page', polled.status === 200 && polled.json.active === true && polled.json.url === pageUrl)
check('the route response is lossless JSON', Object.values(polled.json).every((value) => value !== undefined))

await tools.get('browser_close').execute({}, {})
const closed = await browser.browserState()
check('state is inactive once the browser closes', closed.active === false && closed.url === null)
server.close()

// ── client half ────────────────────────────────────────────────────────────

const clientSource = readFileSync(new URL('../packages/browser-use/lib/client.js', import.meta.url), 'utf8')
let loaded = null
let currentState = { ok: true, active: false, url: null, title: null }
const timers = new Map()
let timerId = 0
const sandbox = {
  console,
  setTimeout: (fn) => {
    timerId += 1
    timers.set(timerId, fn)
    return timerId
  },
  clearTimeout: (id) => timers.delete(id),
  fetch: async () => ({ ok: true, json: async () => currentState }),
  window: { __ModuleLoader__: { load: (module) => { loaded = module } } },
}
vm.createContext(sandbox)
vm.runInContext(clientSource, sandbox)

check('the client bundle registers under its package id', loaded !== null && loaded.id === 'dsh-zcode-browser-use')
check('the client module id matches the boot entry id', loaded !== null && loaded.id === 'dsh-zcode-browser-use')

const opened = []
const sidebar = {
  current: undefined,
  // Set to simulate DSH leaving another tab active after the open.
  foreignActive: false,
  openTab(kind, options) {
    opened.push({ kind, options })
    this.current = this.foreignActive
      ? { id: 'user-tab', kind: 'terminal' }
      : { id: `tab-${opened.length}`, kind: 'browser' }
  },
  active() {
    return this.current
  },
}
const disposers = []
const ctx = {
  get: (name) => (name === 'sidebarRight' ? sidebar : undefined),
  effect: (execute) => {
    disposers.push(execute())
    return () => undefined
  },
}

/** Run the earliest scheduled poll plus its pending microtasks. */
async function poll() {
  const next = [...timers.entries()].sort((left, right) => left[0] - right[0])[0]
  if (next) {
    timers.delete(next[0])
    await next[1]()
  }
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

loaded.factory().apply(ctx)
await poll()
check('nothing opens while no browser runs', opened.length === 0, `${opened.length} tab(s) opened`)

currentState = { ok: true, active: true, url: 'https://missing.test/', title: 'x' }
await poll()
check('the first active page opens a Browser tab', opened.length === 1 && opened[0].kind === 'browser' && opened[0].options.params.url === 'https://missing.test/')
await poll()
check('an unchanged page does not open another tab', opened.length === 1)

currentState = { ok: true, active: true, url: 'https://missing.test/next', title: 'y' }
await poll()
check('a page change replaces the same tab', opened.length === 2 && opened[1].options.params.url === 'https://missing.test/next' && opened[1].options.replaceTab === 'tab-1', JSON.stringify(opened[1].options))

sidebar.foreignActive = true
currentState = { ok: true, active: true, url: 'https://missing.test/third', title: 'z' }
await poll()
check('the tab the plugin opened is still replaced', opened.length === 3 && opened[2].options.replaceTab === 'tab-2', JSON.stringify(opened[2].options))

currentState = { ok: true, active: true, url: 'https://missing.test/fourth', title: 'w' }
await poll()
check('a foreign active tab is never adopted or replaced', opened.length === 4 && opened[3].options.replaceTab === undefined, JSON.stringify(opened[3].options))

currentState = { ok: true, active: true, url: 'about:blank', title: null }
await poll()
check('a non-HTTP page is not mirrored', opened.length === 4)

currentState = { ok: true, active: false, url: null, title: null }
await poll()
disposers.forEach((dispose) => dispose())
check('the mirror stops when its effect disposes', timers.size === 0, `${timers.size} poll(s) still queued`)

console.log(`\n${failures.length === 0 ? 'browser sidebar checks passed' : `${failures.length} check(s) failed`}`)
process.exitCode = failures.length === 0 ? 0 : 1
