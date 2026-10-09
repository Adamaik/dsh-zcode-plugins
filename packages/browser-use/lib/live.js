/**
 * Live view of the agent's browser, served on its own loopback origin.
 *
 * The sidebar mirror used to point DSH's built-in Browser tab at the page the
 * agent is on. That tab is a *different* browser with its own cookie jar, so a
 * site behind a login showed its login page there while the agent browsed the
 * logged-in headless Chromium.
 *
 * Instead this module serves the agent's browser as a page of our own, on a
 * port of our own: DSH's sidebar Browser tab opens that URL, sees a live frame
 * of the automation browser, and can drive it — clicks, wheel and keys are
 * forwarded to the Playwright page. Nothing has to be logged in inside the
 * sidebar, because the sidebar only ever talks to this process.
 *
 * Why a second HTTP server rather than the web GUI's own server: the sidebar
 * address parser rejects "DSH's own origin", so a page served by \`webServer\`
 * could never be opened there.
 *
 * The server binds to 127.0.0.1 only. It exposes the agent's browser to any
 * local process that can reach the port; do not widen the binding.
 *
 * @module dsh-zcode-browser-use/live
 */

import { createServer } from 'node:http'

import { browserState, peekPage } from './browser.js'

/** JPEG quality for one live frame. */
const FRAME_QUALITY = 60

/** Upper bound on an accepted input payload. */
const INPUT_BODY_LIMIT_BYTES = 8 * 1024

/** The live server, or null when it is not running. */
let server = null

/** The loopback origin the sidebar should open, or null when not serving. */
let origin = null

/** Set while the owning plugin effect is being torn down. */
let closing = false

/**
 * The URL the sidebar Browser tab should open for the live view.
 * @returns the loopback origin, or null while the server is down.
 */
export function liveOrigin() {
  return origin
}

/**
 * Start the live view and tie its lifetime to the plugin context.
 * @param ctx - the plugin scope whose effect owns the server.
 */
export function startLiveView(ctx) {
  ctx.effect(
    () => {
      closing = false
      startServer().catch((error) => {
        console.error('[browser-use] live view failed to start:', error)
      })
      return () => {
        closing = true
        stopServer()
      }
    },
    'dsh-zcode-browser-use: live view',
  )
}

/** Bind the live server on an ephemeral loopback port. */
async function startServer() {
  if (server) return origin
  const created = createServer((req, res) => {
    handle(req, res).catch((error) => fail(res, error))
  })
  await new Promise((done, reject) => {
    created.once('error', reject)
    created.listen(0, '127.0.0.1', done)
  })
  if (closing) {
    created.close()
    return null
  }
  server = created
  origin = 'http://127.0.0.1:' + created.address().port + '/'
  return origin
}

/** Close the live server and drop its origin. */
function stopServer() {
  if (!server) return
  server.close()
  server = null
  origin = null
}

/**
 * Route one request.
 * @param req - the incoming HTTP request.
 * @param res - the response to fill.
 */
async function handle(req, res) {
  // Split the query by hand: `new URL('//x', base)` reads as a
  // protocol-relative address, so a doubled slash would misroute the request.
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && path === '/') return sendPage(res)
  if (req.method === 'GET' && path === '/frame') return await sendFrame(res)
  if (req.method === 'GET' && path === '/state') {
    return sendJson(res, { ok: true, ...(await browserState()), live: origin })
  }
  if (req.method === 'POST' && path === '/input') return await acceptInput(req, res)
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

/**
 * Send one frame of the agent's current page.
 *
 * Reading never launches a browser: with no session the response is 204 and
 * the page keeps its placeholder.
 *
 * @param res - the response to fill.
 */
async function sendFrame(res) {
  const page = peekPage()
  if (!page) {
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const jpeg = await page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY })
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
  res.end(jpeg)
}

/**
 * Map one pointer or key event onto the Playwright page.
 *
 * Coordinates arrive in the coordinates of the frame the user saw, which the
 * page reports as \`iw\`/\`ih\`; they are scaled onto the page viewport here, so
 * the viewer can be any size.
 *
 * @param req - the request carrying a JSON body.
 * @param res - the response to fill.
 */
async function acceptInput(req, res) {
  const page = peekPage()
  if (!page) return sendJson(res, { ok: false, reason: 'no-browser' })
  const payload = JSON.parse((await readBody(req)) || '{}')
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
  const width = Number(payload.iw) || viewport.width
  const height = Number(payload.ih) || viewport.height
  const x = ((Number(payload.x) || 0) * viewport.width) / width
  const y = ((Number(payload.y) || 0) * viewport.height) / height
  switch (payload.kind) {
    case 'move':
      await page.mouse.move(x, y)
      break
    case 'click':
      await page.mouse.click(x, y, { button: payload.button === 'right' ? 'right' : 'left' })
      break
    case 'wheel':
      await page.mouse.move(x, y)
      await page.mouse.wheel(0, Number(payload.deltaY) || 0)
      break
    case 'text':
      await page.keyboard.type(String(payload.text ?? ''))
      break
    case 'key':
      await page.keyboard.press(String(payload.key ?? ''))
      break
    default:
      throw new Error('unknown input kind: ' + String(payload.kind))
  }
  return sendJson(res, { ok: true, ...(await browserState()) })
}

/**
 * Read a bounded request body.
 * @param req - the request to read.
 * @returns the body as UTF-8 text.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > INPUT_BODY_LIMIT_BYTES) throw new Error('input body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param res - the response to fill.
 * @param body - the JSON-serializable value.
 */
function sendJson(res, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Write the live view page.
 * @param res - the response to fill.
 */
function sendPage(res) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(PAGE)
}

/**
 * Report a failed request without taking the server down.
 * @param res - the response to fill.
 * @param error - the failure to report.
 */
function fail(res, error) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
}

/**
 * The live view page.
 *
 * Frames are pulled one at a time: the next request starts only after the
 * previous image loaded, so a slow page throttles itself instead of piling up.
 * Pointer coordinates are converted to frame pixels here and scaled onto the
 * page viewport by the server.
 */
const PAGE = [
  '<!doctype html>',
  '<html lang="zh"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>AI 浏览器</title>',
  '<style>',
  ':root{color-scheme:light}',
  'html,body{margin:0;height:100%;overflow:hidden;background:#1f1f1f;',
  'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6e6e6}',
  'body{display:flex;flex-direction:column}',
  '#bar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 8px;',
  'background:#2b2b2b;border-bottom:1px solid #3a3a3a}',
  '#dot{flex:none;width:8px;height:8px;border-radius:50%;background:#6b6b6b}',
  '#dot.on{background:#3fb950}',
  '#where{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9b9b9}',
  '#where b{color:#e6e6e6;font-weight:600}',
  'button{flex:none;background:#3a3a3a;color:#e6e6e6;border:0;border-radius:4px;',
  'padding:4px 10px;cursor:pointer;font:inherit}',
  'button:hover{background:#4a4a4a}',
  '#stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;',
  'overflow:hidden;outline:none;position:relative}',
  '#frame{max-width:100%;max-height:100%;object-fit:contain;display:block;',
  'cursor:crosshair;background:#fff}',
  '#hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
  'color:#8a8a8a;text-align:center;padding:24px;pointer-events:none}',
  '</style></head><body>',
  '<div id="bar"><span id="dot"></span><span id="where">连接中…</span>',
  '<button id="reload" title="刷新画面">刷新</button></div>',
  '<div id="stage" tabindex="0"><img id="frame" alt=""><div id="hint">等待智能体打开浏览器…</div></div>',
  '<script>',
  '(function(){',
  'var img=document.getElementById("frame"),dot=document.getElementById("dot");',
  'var where=document.getElementById("where"),hint=document.getElementById("hint");',
  'var stage=document.getElementById("stage"),live=false;',
  'function post(body){',
  'return fetch("/input",{method:"POST",headers:{"content-type":"application/json"},',
  'body:JSON.stringify(body),cache:"no-store"}).catch(function(){});}',
  'function point(e){var r=img.getBoundingClientRect();',
  'return{x:(e.clientX-r.left)*img.naturalWidth/r.width,',
  'y:(e.clientY-r.top)*img.naturalHeight/r.height,iw:img.naturalWidth,ih:img.naturalHeight};}',
  'function pump(){var probe=new Image();',
  'probe.onload=function(){live=true;img.src=probe.src;hint.style.display="none";',
  'dot.className="on";setTimeout(pump,80);};',
  'probe.onerror=function(){live=false;dot.className="";',
  'hint.style.display="flex";hint.textContent="智能体尚未打开浏览器…";setTimeout(pump,600);};',
  'probe.src="/frame?t="+Date.now();}',
  'function poll(){fetch("/state",{method:"GET",cache:"no-store"}).then(function(r){return r.json()})',
  '.then(function(s){dot.className=s.active&&live?"on":"";',
  'where.innerHTML=s.active?"<b>"+(s.title||"")+"</b> "+(s.url||""):"智能体尚未打开浏览器";})',
  '.catch(function(){}).then(function(){setTimeout(poll,1000)});}',
  'img.addEventListener("click",function(e){if(live)post(Object.assign({kind:"click"},point(e),',
  '{button:e.button===2?"right":"left"}));stage.focus();});',
  'img.addEventListener("mousemove",function(e){if(!live)return;',
  'if(!img._last||Date.now()-img._last>120){img._last=Date.now();post(Object.assign({kind:"move"},point(e)));}});',
  'img.addEventListener("contextmenu",function(e){e.preventDefault()});',
  'img.addEventListener("wheel",function(e){if(!live)return;e.preventDefault();',
  'post(Object.assign({kind:"wheel",deltaY:e.deltaY},point(e)));},{passive:false});',
  'stage.addEventListener("keydown",function(e){',
  'if(!live)return;',
  'if(e.ctrlKey||e.metaKey||e.altKey){e.preventDefault();',
  'post({kind:"key",key:(e.ctrlKey?"Control+":e.metaKey?"Meta+":"Alt+")+e.key});return;}',
  'if(e.key.length===1){e.preventDefault();post({kind:"text",text:e.key});return;}',
  'if(e.key==="Shift"||e.key==="Control"||e.key==="Alt"||e.key==="Meta")return;',
  'e.preventDefault();post({kind:"key",key:e.key});});',
  'stage.addEventListener("mousedown",function(){stage.focus()});',
  'document.getElementById("reload").addEventListener("click",function(){img.src="";pump()});',
  'pump();poll();})();',
  '</script></body></html>',
].join('\n')
