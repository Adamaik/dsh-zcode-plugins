/**
 * Bridge from the automation browser to the DSH web client.
 *
 * The client half (`lib/client.js`) polls one route to learn which page the
 * agent is on and mirrors it into the right sidebar's built-in Browser tab
 * (`@deepseek-ai/dsh-client-ui-sidebar-browser`):
 *
 *   POST /browser-use/state — whether a browser is open, the page URL and title,
 *                              and the loopback origin of the live frame view
 *
 * The route is served by the webServer service, so this module is mounted only
 * where a web GUI exists; a headless host keeps the tools without the bridge.
 *
 * @module dsh-zcode-browser-use/mirror
 */

import { browserState } from './browser.js'
import { liveOrigin } from './live.js'

/** URL prefix the browser half polls. */
export const MIRROR_PREFIX = '/browser-use'

/** Write one JSON response. */
function sendJson(res, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * Register the bridge route on a web server service.
 * @param ctx - the plugin context whose fiber owns the route effect.
 * @param webServer - the webServer service with `register({kind, path, handler})`.
 */
export function mountMirror(ctx, webServer) {
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: `${MIRROR_PREFIX}/state`,
        handler: (_req, res) =>
          Promise.resolve(browserState())
            .then((state) => sendJson(res, { ok: true, ...state, live: liveOrigin() }))
            .catch(() => {
              if (res.headersSent) {
                res.end()
                return
              }
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end('{"ok":false}')
            }),
      }),
    `dsh-zcode-browser-use: ${MIRROR_PREFIX}/state`,
  )
}
