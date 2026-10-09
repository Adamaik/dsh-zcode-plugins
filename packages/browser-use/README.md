# dsh-zcode-browser-use

English | [中文](README.zh.md)

An unofficial DeepSeek Harness port of the ZCode built-in **browser-use** plugin: Playwright-backed headless browser tools, plus **the plugin's own real browser mounted in DSH's sidebar** — a separate process with its own cookies, drivable by the model and directly usable by the user — and ZCode's `control-browser` and `web-gui-tester` skills.

## Upstream

| Upstream | Value |
| --- | --- |
| ZCode plugin | `browser-use` 0.5.1, license MIT, author Z.ai |
| Transport | `node_repl` MCP server exposing one `js` tool (`mcp__node_repl__js`) over ZCode's `agent.browsers` registry |
| Backends | Desktop in-app browser (IAB), Chrome extension, CLI-managed headless CDP |
| Copied verbatim | [skills/control-browser/SKILL.md](./skills/control-browser/SKILL.md), [skills/web-gui-tester/SKILL.md](./skills/web-gui-tester/SKILL.md), [docs/](./docs), [upstream-README.md](./upstream-README.md) |
| New in this port | [lib/browser.js](./lib/browser.js), [lib/tools.js](./lib/tools.js), [lib/own.js](./lib/own.js), [lib/own-tools.js](./lib/own-tools.js), [lib/live.js](./lib/live.js), [lib/mirror.js](./lib/mirror.js), [lib/client.js](./lib/client.js), [index.js](./index.js) |

The upstream transport does not exist in DSH: there is no Node REPL host, no in-app browser, and no Chrome extension bridge. The port keeps the upstream skills and documentation and replaces the transport with native tools. Each copied skill carries a **DSH port note** that maps the upstream calls onto those tools; [NOTICE](./NOTICE) lists every change.

## Install

```sh
dsh plugin --profile <profile> add dsh-zcode-browser-use
dsh plugin --profile <profile> add ./packages/browser-use
```

A browser is not an npm dependency. The plugin tries, in order: the channel named by `DSH_BROWSER_CHANNEL`, Playwright's bundled Chromium, the installed Google Chrome channel, then the Microsoft Edge channel. A machine with Chrome or Edge needs no download; otherwise install Chromium once:

```sh
npx playwright install chromium
```

The bundled `playwright` dependency is pinned to 1.59.1 because the browser build and the library version must match.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_navigate` | Open a URL and return the settled title and status. |
| `browser_snapshot` | Read visible text plus addressable elements (ref, role, name, value, state). Primary read path. |
| `browser_click` | Click by snapshot ref, CSS selector, or ARIA role and name. |
| `browser_type` | Fill a field, optionally submitting with Enter. |
| `browser_press` | Press one keyboard key. |
| `browser_scroll` | Scroll an element into view and/or wheel the page. |
| `browser_screenshot` | Write a PNG and return its path. |
| `browser_evaluate` | Evaluate a read-only JavaScript expression. |
| `browser_tabs` | List, select, or close tabs. |
| `browser_close` | Close the shared browser process. |

One lazily launched Chromium serves every call.

Those run in a **headless** Chromium: fast, scriptable, and obviously automated. For a site that needs a login, a human check, or a hand from the user, use the group below.

### The plugin's own browser, in the sidebar

| Tool | Purpose |
| --- | --- |
| `own_browser_open` | Open the plugin's own browser in the DSH sidebar (a real Chromium guest, its own cookies). |
| `own_browser_status` | Report whether it is open and which page it is on. Read-only. |
| `own_browser_navigate` | Point it at a URL. |
| `own_browser_snapshot` | Read the page: URL, title, visible text, addressable elements. |
| `own_browser_click` | Click an element with a **real pointer event**, not a synthetic DOM one. |
| `own_browser_type` | Fill a field with real key events, optionally submitting. |
| `own_browser_press` | Press one key, for example Enter, Escape or Control+A. |
| `own_browser_screenshot` | Save its current picture as a PNG. |

## How the own browser reaches the sidebar

It does **not** use DSH's built-in Browser tab type, and it does **not** use that browser. It registers its own sidebar tab type and mounts **its own** `<webview>`:

| Piece | Role |
| --- | --- |
| [lib/own.js](./lib/own.js) | Host half: the command queue and three routes (`/browser-use/own/command`, `/result`, `/status`) on the `webServer` service. |
| [lib/own-tools.js](./lib/own-tools.js) | The `own_browser_*` tools. |
| [lib/client.js](./lib/client.js) | Client half: registers the tab type and body, leases a guest from the desktop bridge before mounting the webview, long-polls for commands and runs them. |

### The webview must lease a guest first

DSH's main process gates **every** webview that tries to attach:

```js
// DesktopBrowserGuests.bind(mainWindow, ...)
owner.on("will-attach-webview", (event, preferences, params) => {
  const lease = this.leases.get(id);
  if (lease === undefined || lease.owner !== owner
      || lease.attached || params.partition !== lease.partition) {
    event.preventDefault();      // no lease → refused, no guest ever appears
    return;
  }
  ...
});
```

`did-attach-webview` then checks the lease id embedded in the URL (`about:blank#<lease>`) and closes the guest when it cannot match. A hand-made `<webview>` therefore **never gets a guest**: the element sits in the DOM while every guest method throws "The WebView must be attached to the DOM and the dom-ready event emitted".

The lease comes from the public desktop bridge, and the mount then follows DSH's own recipe:

```js
const reservation = await window.dshDesktop.browser.acquire(WORKSPACE_KEY);
element.setAttribute("name", reservation.lease);
element.setAttribute("partition", reservation.partition);
element.setAttribute("src", "about:blank#" + reservation.lease);
```

That bridge (`dshDesktop.browser`, `protocolVersion: 1`) is exposed to the `dsh-app://app` main frame — which is exactly the frame plugin client code runs in, because the main process's `assertProductSender` checks the frame and origin, **not the package identity**. A granted lease still goes through `configureSession()` and its full hardening (permissions, downloads and popups denied; the application's own origin blocked), so nothing is weakened — it is the same gate.

### Three facts that matter

1. **It is a real browser, not a headless one.** An Electron webview guest is a separate Chromium process; `navigator.webdriver` is false and there is no HeadlessChrome fingerprint.
2. **Trusted input can be injected.** `<webview>.sendInputEvent()` is a documented API (Electron's `webview-tag` docs) and goes through the browser's real input pipeline, where `dispatchEvent` produces `isTrusted === false` synthetics that bot checks spot immediately.
3. **It keeps its own session.** The partition is allocated per workspace by the main process (`dsh-sidebar-browser-<uuid>`), sharing nothing with DSH's built-in sidebar browser or with the headless one.

The user can still click and type in it directly — real human input — so a slider or a QR login is theirs to do, and the model carries on in the same browser afterwards.

> ⚠️ The lease lives for one run only: the main process allocates a fresh random partition on every start, so **a login does not survive a DSH restart** — the same is true of DSH's built-in sidebar browser.

## Sidebar live view (optional, no longer opened automatically)

DSH Desktop ships a Browser tab in the right sidebar (`@deepseek-ai/dsh-client-ui-sidebar-browser`). This plugin opens **its own** page in that tab, showing the automation browser live — it does **not** point the tab at the page the agent is on.

| Piece | Role |
| --- | --- |
| [lib/browser.js](./lib/browser.js) | Launches the headless browser; `getPage()` serves the tools, `peekPage()` serves the read-only view and **never** launches anything. |
| [lib/live.js](./lib/live.js) | Serves the live view on its **own loopback port**: `/` is the viewer page, `/frame` returns one JPEG, `/input` replays pointer and key events into the Playwright page, `/state` reports the current page. |
| [lib/mirror.js](./lib/mirror.js) | Registers `POST /browser-use/state` on the `webServer` service, returning the page plus the live view origin. Mounted with `ctx.inject(['webServer'], …)`, so a headless host keeps the tools and gets no bridge. |
| [lib/client.js](./lib/client.js) | The browser half (`dsh.client.platform: web`, `exports["./client"]`): polls the state and opens the **live view origin** with `ctx.sidebarRight.openTab('browser', { params: { url } })`. |

**Why not point the tab at the agent's URL**: that tab is a *different* browser with its own cookie jar. Pointed at anything behind a login it shows the login page, while the agent is signed in inside the headless Chromium — the two can never agree. A page on our own port has no such problem: the sidebar only ever talks to this process, so nothing has to be signed in there.

**Why not serve it from `webServer`**: the sidebar's address parser rejects DSH's own origin, so a page served by `webServer` could never be opened in that tab.

**Why a separate HTTP server rather than a `<webview>`**: the view is one `<img>`, which both carriers (iframe on Web, webview on Desktop) can draw without extra privileges.

The live view binds `127.0.0.1`. It exposes the agent's browser to any local process that can reach the port — **do not widen the binding**.

One tab per browser session, and it is **no longer replaced on every page change**: the live view URL is stable, so the tab opens once and stays. A profile without the sidebar Browser keeps the tools and mirrors nothing.

| Environment variable | Effect |
| --- | --- |
| `DSH_BROWSER_HEADLESS=false` | Also open a visible browser window. Default: headless. |
| `DSH_BROWSER_CHANNEL` | Pin one launch channel (`chrome`, `msedge`, …) instead of the fallback order. |
| `BROWSER_USE_LIB` | Only for `scripts/verify-browser-live.mjs`: which `lib/` to test. |

The picture comes from the automation browser itself, so the agent's typing, scrolling and filled fields **are** visible; and a click, a keystroke or a wheel event in that picture is replayed into the same browser, so **the user can take over at any moment**. Frames are pulled one at a time — the next request starts only after the previous image loaded — so a slow page throttles itself instead of piling up.

## Known limitations

- No agent-facing in-app browser: DSH Desktop's sidebar Browser is user-facing and registers no tools, so automation stays on Playwright. No Chrome extension backend and no CDP backend selection.
- No file upload, no video recording, and no coordinate (`cua`/`dom_cua`) click path.
- `browser_evaluate` is documented as read-only inspection; the plugin does not enforce that, so follow the skill's rule.
- Without `npx playwright install chromium` every browser tool fails with an actionable error message.
- **Streaming does not change the fingerprint.** Whatever anti-bot or slider check the headless Chromium fails, it still fails once streamed — the check reads the browser fingerprint, not whether a human is watching. Passing it needs a **visible real Chrome** (`channel: "chrome"` with `DSH_BROWSER_HEADLESS=false`), at the cost of a real window.
- **Frame rate** is roughly 5–15 fps over loopback: fine for reading pages, sluggish for drag interactions (sliders, drag-select).
- **The live view port is reachable from the machine.** It binds `127.0.0.1` only, but any local process can connect. It is not an authentication boundary.
- The live view needs DSH Desktop's sidebar Browser, which a plain Web profile disables; the tab appears after DSH reloads the profile.
- **A login does not survive a restart**: the main process allocates a random partition per run (`dsh-sidebar-browser-<uuid>`). Keeping one across restarts needs upstream support for a fixed partition name.
