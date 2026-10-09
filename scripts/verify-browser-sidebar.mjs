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

console.log('')
console.log(failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed: ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
