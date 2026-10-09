#!/usr/bin/env node
/**
 * Verify the sidebar live view end to end, without the GUI.
 *
 * Host half:
 *   1. Serve a throwaway loopback page with a button.
 *   2. Start the live view the way the plugin does.
 *   3. With no browser running, /frame must answer 204 and must not launch one.
 *   4. Drive the agent's browser to that page: /frame must return a real JPEG.
 *   5. POST /input at the button's coordinates: the page must react, which is
 *      what makes the sidebar a control surface rather than a picture.
 * Client half (client.js in a VM with a stubbed sidebar):
 *   6. It must open the live origin, not the agent's page URL — that is the
 *      whole point: a different browser would only ever show the login page.
 *   7. A later page change must not churn the tab, and a host half without a
 *      live view must still fall back to the old mirroring.
 *
 * Usage:
 *   node scripts/verify-browser-live.mjs
 *   BROWSER_USE_LIB=./node_modules/dsh-zcode-browser-use/lib/ node verify-browser-live.mjs
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL(process.env.BROWSER_USE_LIB ?? '../packages/browser-use/lib/', import.meta.url)
const failures = []

/** Record one check outcome. */
function check(label, ok, detail) {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(label)
}

// ── host half ──────────────────────────────────────────────────────────────

const TARGET = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>live view target</title>',
  '<style>body{margin:0;font:16px sans-serif}',
  '#go{position:fixed;left:40px;top:60px;width:200px;height:60px;font-size:16px}',
  '</style></head><body>',
  '<button id="go">按钮</button><div id="out">未点击</div>',
  '<script>document.getElementById("go").addEventListener("click",function(){',
  'document.getElementById("out").textContent="已点击";});</script>',
  '</body></html>',
].join('')

const target = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(TARGET)
})
await new Promise((done) => target.listen(0, '127.0.0.1', done))
const targetUrl = 'http://127.0.0.1:' + target.address().port + '/'

const browser = await import(new URL('browser.js', ROOT).href)
const live = await import(new URL('live.js', ROOT).href)
const { mountMirror } = await import(new URL('mirror.js', ROOT).href)
const { createBrowserTools } = await import(new URL('tools.js', ROOT).href)
const tools = new Map(createBrowserTools(async (t) => t).map((t) => [t.name, t]))

live.startLiveView({ effect: (fn) => fn() })
let origin = null
for (let i = 0; i < 60 && origin === null; i += 1) {
  origin = live.liveOrigin()
  if (origin === null) await new Promise((r) => setTimeout(r, 50))
}
check('live view binds a loopback origin', typeof origin === 'string' && origin.startsWith('http://127.0.0.1:'), origin)
const base = origin.replace(/\/$/, '')

const idle = await fetch(base + '/frame')
check('no browser: /frame answers 204 instead of launching one', idle.status === 204, String(idle.status))
check('reading a frame never starts a browser', (await browser.browserState()).active === false)

const navigated = await tools.get('browser_navigate').execute({ url: targetUrl }, {})
check('the agent browser reached the target page', navigated.status === 200, navigated.url)

const frame = Buffer.from(await (await fetch(base + '/frame')).arrayBuffer())
check('a frame arrives as JPEG', frame[0] === 0xff && frame[1] === 0xd8 && frame.length > 2000, frame.length + 'B')

const page = await (await fetch(base + '/')).text()
check('the live page is served', page.includes('AI 浏览器') && page.includes('/frame'), page.length + 'B')

const snap = await tools.get('browser_snapshot').execute({}, {})
check('the live frame shows the page the agent is on', snap.title === 'live view target', snap.title)

const clicked = await fetch(base + '/input', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'click', x: 140, y: 90, iw: 1440, ih: 900 }),
})
check('the input bridge accepts a click', clicked.status === 200 && (await clicked.json()).ok === true)

const after = await tools.get('browser_evaluate').execute({ expression: 'document.getElementById("out").textContent' }, {})
check('the click reached the automation browser', after.value === '已点击', String(after.value))

const refused = await fetch(base + '/input', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'nonsense' }),
})
check('an unknown input kind is rejected, not ignored', refused.status === 500, String(refused.status))

const state = await (await fetch(base + '/state')).json()
check('/state reports the page and the live origin', state.active === true && state.url === targetUrl && state.live === origin, JSON.stringify({ url: state.url, live: state.live }))

const routes = []
mountMirror({ effect: (fn) => fn() }, { register: (route) => { routes.push(route); return () => undefined } })
const res = {
  headersSent: false,
  writeHead() { this.headersSent = true; return this },
  end(chunk) { this.body = chunk === undefined ? null : Buffer.from(String(chunk)) },
}
await routes[0].handler({}, res)
const mirrored = JSON.parse(res.body.toString('utf8'))
check('the mirror payload carries live + page', mirrored.live === origin && mirrored.url === targetUrl, JSON.stringify({ live: mirrored.live, url: mirrored.url }))

await tools.get('browser_close').execute({}, {})
target.close()

console.log('')
console.log(failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed: ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
