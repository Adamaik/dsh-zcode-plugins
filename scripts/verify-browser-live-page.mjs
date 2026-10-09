#!/usr/bin/env node
/**
 * Verify the live view *page* in a real browser.
 *
 * The other suites stub the page away, so the viewer's own JavaScript — the
 * frame pump, the coordinate conversion, the input posts — would go untested.
 * This one drives it for real:
 *
 *   1. Serve a target page with a button.
 *   2. Point the agent's browser at it, then open the live view page in a
 *      second, separate browser (the user's seat).
 *   3. Wait until the viewer's <img> actually holds a captured frame.
 *   4. Click the button *in the viewer* and assert the automation browser's
 *      page reacted — the sidebar is a control surface, not a picture.
 *   5. Assert the viewer's title bar follows the page.
 *
 * Usage: node scripts/verify-browser-live-page.mjs
 */

import { createServer } from 'node:http'

const ROOT = new URL(process.env.BROWSER_USE_LIB ?? '../packages/browser-use/lib/', import.meta.url)
const failures = []

/** Record one check outcome. */
function check(label, ok, detail) {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(label)
}

const TARGET = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>target page</title>',
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
const { chromium } = await import('playwright')

live.startLiveView({ effect: (fn) => fn() })
let origin = null
for (let i = 0; i < 60 && origin === null; i += 1) {
  origin = live.liveOrigin()
  if (origin === null) await new Promise((r) => setTimeout(r, 50))
}
check('live view is up', typeof origin === 'string', origin)

const driven = await browser.getPage()
await driven.goto(targetUrl, { waitUntil: 'domcontentloaded' })
check('the automation browser is on the target page', driven.url() === targetUrl, driven.url())

// The bundled Playwright Chromium may not be installed; the plugin falls back
// to a system channel, so the viewer seat does the same.
let viewer = null
for (const candidate of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
  try {
    viewer = await chromium.launch({ headless: true, ...candidate })
    break
  } catch (error) {
    if (candidate.channel === 'msedge') throw error
  }
}
try {
  const seat = await viewer.newPage()
  await seat.goto(origin, { waitUntil: 'domcontentloaded' })

  let framed = true
  try {
    await seat.waitForFunction(() => {
      const img = document.getElementById('frame')
      return img !== null && img.naturalWidth > 0
    }, null, { timeout: 20000 })
  } catch (error) {
    framed = false
  }
  const size = await seat.evaluate(() => {
    const img = document.getElementById('frame')
    return img ? img.naturalWidth + 'x' + img.naturalHeight : 'none'
  })
  check('the viewer page renders a captured frame', framed, size)

  const shot = await seat.evaluate(() => {
    const img = document.getElementById('frame')
    const r = img.getBoundingClientRect()
    return { w: r.width, h: r.height, nw: img.naturalWidth, nh: img.naturalHeight }
  })
  check('the frame is scaled into the sidebar viewport', shot.nw > 0 && shot.nh > 0, JSON.stringify(shot))

  // Click the button where the viewer sees it: the page converts to frame
  // pixels, the server scales onto the page viewport.
  await seat.evaluate(() => {
    const img = document.getElementById('frame')
    const r = img.getBoundingClientRect()
    const x = r.left + (140 / img.naturalWidth) * r.width
    const y = r.top + (90 / img.naturalHeight) * r.height
    img.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }))
  })

  let reacted = true
  try {
    await driven.waitForFunction(() => document.getElementById('out').textContent === '已点击', null, { timeout: 15000 })
  } catch (error) {
    reacted = false
  }
  const out = await driven.evaluate(() => document.getElementById('out').textContent)
  check('a click in the viewer drives the automation browser', reacted, String(out))

  let titled = true
  try {
    await seat.waitForFunction(() => (document.getElementById('where') || {}).textContent?.includes('target page'), null, { timeout: 10000 })
  } catch (error) {
    titled = false
  }
  const bar = await seat.evaluate(() => document.getElementById('where').textContent)
  check('the viewer title bar follows the page', titled, String(bar))

  // Keyboard: focus the stage and type, then read the page back.
  await driven.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'typed'
    document.body.appendChild(input)
    input.focus()
  })
  await seat.evaluate(() => document.getElementById('stage').focus())
  await seat.evaluate(() => {
    for (const ch of 'ab') {
      document.getElementById('stage').dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
    }
  })
  let typed = true
  try {
    await driven.waitForFunction(() => document.getElementById('typed').value === 'ab', null, { timeout: 15000 })
  } catch (error) {
    typed = false
  }
  const value = await driven.evaluate(() => document.getElementById('typed').value)
  check('typing in the viewer drives the automation browser', typed, JSON.stringify(value))
} finally {
  await viewer.close()
  await browser.closeBrowser()
  target.close()
}

console.log('')
console.log(failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed: ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
