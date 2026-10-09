/**
 * DSH port of the ZCode browser-use plugin.
 *
 * Upstream ships a `node_repl` MCP server plus two skills; DSH has no Node REPL
 * host, so this port keeps the upstream skills and documentation and replaces
 * the transport with native `browser_*` tools backed by Playwright.
 *
 * A web GUI host additionally mirrors the run into DSH's own right sidebar:
 * `lib/mirror.js` publishes the current page and `lib/client.js` drives the
 * built-in Browser tab type with it, so the user watches the page the agent is
 * on without a second browser window.
 *
 * @module dsh-zcode-browser-use
 */

import { readFileSync } from 'node:fs'
import { resolve as resolveNodePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLiveView } from './lib/live.js'
import { mountMirror } from './lib/mirror.js'
import { mountOwnBrowser } from './lib/own.js'
import { createOwnBrowserTools } from './lib/own-tools.js'
import { createBrowserTools } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'zcode-browser-use'

/** Services required for registration; the filesystem service is read lazily when present. */
export const inject = ['skills', 'tools']

/** Upstream skills shipped by this bundle, with their routing descriptions. */
const SKILLS = [
  {
    name: 'control-browser',
    dir: 'skills/control-browser/',
    description:
      'Use when opening, navigating, inspecting, testing, clicking, typing, filling, screenshotting, ' +
      'or verifying web pages and local HTTP targets, including browser and web-UI automation, ' +
      'rendered-page scraping, frontend checks, and visible page-state reading.',
  },
  {
    name: 'web-gui-tester',
    dir: 'skills/web-gui-tester/',
    description:
      'Use the browser tools to test web frontends interactively in a GUI-based black-box manner: ' +
      'simulate user clicks, text input, and scrolling; verify with screenshots and read-only DOM ' +
      'inspection; produce a final test report.',
  },
]

/**
 * Strip one leading YAML frontmatter block.
 * @param text - raw SKILL.md content.
 * @returns the instruction body without frontmatter.
 */
function skillBody(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  const bodyStart = text.indexOf('\n', end + 1)
  return bodyStart === -1 ? '' : text.slice(bodyStart + 1)
}

/** Register the upstream skills and the Playwright-backed browser tools. */
export function apply(ctx) {
  for (const skill of SKILLS) {
    const base = new URL(skill.dir, import.meta.url)
    ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: skillBody(readFileSync(new URL('SKILL.md', base), 'utf8')),
      resourceBase: { kind: 'directory', path: fileURLToPath(base) },
      provider: 'zcode-browser-use',
      source: 'bundled',
    })
  }
  const resolveOutput = async (target, exec) => {
    const cwd = exec?.agent?.session?.header?.cwd
    const fs = ctx.get ? ctx.get('fs') : ctx.fs
    if (!fs) return resolveNodePath(cwd ?? process.cwd(), target)
    const options = { ...(cwd ? { cwd } : {}), ...(exec?.signal ? { signal: exec.signal } : {}) }
    return fs.processPath(await fs.resolve(target, options))
  }
  // Registering a tool that already exists throws, and a throwing host entry
  // takes the boot with it. Keep the two groups independent.
  try {
    for (const tool of createBrowserTools(resolveOutput)) ctx.tools.register(tool)
  } catch (error) {
    console.error('[browser-use] headless browser tools not registered:', error)
  }
  // The plugin's own sidebar browser: a real Chromium guest in the right
  // sidebar, for anything behind a login or behind an anti-bot check.
  try {
    for (const tool of createOwnBrowserTools(resolveOutput)) ctx.tools.register(tool)
  } catch (error) {
    console.error('[browser-use] own browser tools not registered:', error)
  }

  // The sidebar needs the web server, which only a web GUI host has.
  // ctx.inject waits for the service instead of making it a required
  // dependency, so headless and CLI hosts still register the tools.
  ctx.inject(['webServer'], (scope) => {
    // Each mount is independent: one broken route must not cost the others, and
    // none of them may fail the entry.
    const mounts = [
      // Command queue for the plugin's own browser; it needs the web GUI's
      // origin because the client half cannot fetch the live view's own port.
      () => mountOwnBrowser(scope, scope.webServer),
      // The live view is a screencast of the headless browser. It is no longer
      // opened automatically — the own browser replaced it — but the page stays
      // reachable for watching a headless run.
      () => mountMirror(scope, scope.webServer),
      () => startLiveView(scope),
    ]
    for (const mount of mounts) {
      try {
        mount()
      } catch (error) {
        console.error('[browser-use] sidebar mount failed:', error)
      }
    }
  })
}
