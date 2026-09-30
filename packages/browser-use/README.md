# dsh-zcode-browser-use

English | [中文](README.zh.md)

An unofficial DeepSeek Harness port of the ZCode built-in **browser-use** plugin: Playwright-backed browser tools plus ZCode's `control-browser` and `web-gui-tester` skills.

## Upstream

| Upstream | Value |
| --- | --- |
| ZCode plugin | `browser-use` 0.5.1, license MIT, author Z.ai |
| Transport | `node_repl` MCP server exposing one `js` tool (`mcp__node_repl__js`) over ZCode's `agent.browsers` registry |
| Backends | Desktop in-app browser (IAB), Chrome extension, CLI-managed headless CDP |
| Copied verbatim | [skills/control-browser/SKILL.md](./skills/control-browser/SKILL.md), [skills/web-gui-tester/SKILL.md](./skills/web-gui-tester/SKILL.md), [docs/](./docs), [upstream-README.md](./upstream-README.md) |
| New in this port | [lib/browser.js](./lib/browser.js), [lib/tools.js](./lib/tools.js), [lib/mirror.js](./lib/mirror.js), [lib/client.js](./lib/client.js), [index.js](./index.js) |

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

## Sidebar mirror

DSH Desktop ships a Browser tab in the right sidebar (`@deepseek-ai/dsh-client-ui-sidebar-browser`). This plugin mirrors the agent's page into it, so the user watches the run without a second browser window: the automation browser stays headless, and the sidebar's own Browser tab follows the page the agent is on.

| Piece | Role |
| --- | --- |
| [lib/browser.js](./lib/browser.js) | Launches the headless browser and publishes the current page through `browserState()`. |
| [lib/mirror.js](./lib/mirror.js) | Registers `POST /browser-use/state` on the `webServer` service. Mounted with `ctx.inject(['webServer'], …)`, so a headless host keeps the tools and gets no bridge. |
| [lib/client.js](./lib/client.js) | The browser half (`dsh.client.platform: web`, `exports["./client"]`): polls the state and drives the built-in tab type with `ctx.sidebarRight.openTab('browser', { params: { url } })`. |

One Browser tab is opened per browser session and replaced in place on every page change, so the sidebar keeps a single tab that follows the agent. A profile without the sidebar Browser keeps the tools and mirrors nothing.

| Environment variable | Effect |
| --- | --- |
| `DSH_BROWSER_HEADLESS=false` | Also open a visible browser window. Default: headless. |
| `DSH_BROWSER_CHANNEL` | Pin one launch channel (`chrome`, `msedge`, …) instead of the fallback order. |

The sidebar Browser loads the URL itself: it shows *where* the agent is, not the agent's typing, scrolling, or filled fields inside the automation browser. It also cannot replace the automation browser, because the tab type is user-facing and registers no tools.

## Known limitations

- No agent-facing in-app browser: DSH Desktop's sidebar Browser is user-facing and registers no tools, so automation stays on Playwright. No Chrome extension backend and no CDP backend selection.
- No file upload, no video recording, and no coordinate (`cua`/`dom_cua`) click path.
- `browser_evaluate` is documented as read-only inspection; the plugin does not enforce that, so follow the skill's rule.
- Without `npx playwright install chromium` every browser tool fails with an actionable error message.
- The sidebar mirror follows URLs only; in-page actions in the automation browser are not reflected in the sidebar tab.
- The mirror needs DSH Desktop's sidebar Browser, which a plain Web profile disables; the tab appears after DSH reloads the profile.
