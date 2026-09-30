/**
 * Playwright-backed browser session for the DSH browser-use plugin.
 *
 * One lazily launched Chromium serves every tool call for the life of the
 * plugin. Tabs live in a single browser context; the model addresses page
 * elements through the `data-dsh-ref` attributes that {@link snapshot} writes,
 * so a reference stays valid until the next snapshot.
 *
 * The browser runs headless by default; `DSH_BROWSER_HEADLESS=false` opens a
 * visible window instead. Either way the current page is published through
 * {@link browserState} so the DSH web client can show it in the right
 * sidebar's built-in Browser tab (`lib/client.js`).
 *
 * @module dsh-zcode-browser-use/browser
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Selector for the elements a snapshot exposes as addressable references. */
const SNAPSHOT_SELECTOR =
  'a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],[onclick]'

/** Upper bound on references returned by one snapshot. */
const MAX_REFS = 300

/** Milliseconds allowed for a routine page action. */
const ACTION_TIMEOUT_MS = 10_000

/** Milliseconds allowed for a navigation. */
const NAVIGATION_TIMEOUT_MS = 30_000

let session = null

/** Whether the browser runs headless; set `DSH_BROWSER_HEADLESS=false` to show it. */
function headless() {
  return process.env.DSH_BROWSER_HEADLESS !== 'false'
}

/** Load the Playwright entry point, reporting an actionable error when absent. */
async function loadChromium() {
  try {
    const playwright = await import('playwright')
    return playwright.chromium
  } catch (error) {
    throw new Error(
      'The browser-use plugin needs the "playwright" package and a Chromium build. ' +
        'Install the package dependency, then run: npx playwright install chromium. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Launch candidates in order: the configured channel, Playwright's bundled
 * Chromium, then the installed Google Chrome and Microsoft Edge channels.
 * A missing bundled browser is the common case, so falling back to a system
 * browser avoids requiring Playwright's large Chromium download.
 */
function launchCandidates() {
  const configured = process.env.DSH_BROWSER_CHANNEL
  if (configured) return [{ channel: configured }]
  return [{}, { channel: 'chrome' }, { channel: 'msedge' }]
}

/** Launch a browser and create its single shared context. */
async function launch() {
  const chromium = await loadChromium()
  const errors = []
  for (const candidate of launchCandidates()) {
    try {
      const browser = await chromium.launch({ headless: headless(), ...candidate })
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: false,
      })
      session = { browser, context, page: null }
      browser.on('disconnected', () => {
        session = null
      })
      return session
    } catch (error) {
      errors.push(`${candidate.channel ?? 'bundled chromium'}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  throw new Error(
    'No browser could be launched. Install Google Chrome or Microsoft Edge, or run: ' +
      'npx playwright install chromium. Attempts: ' +
      errors.join(' | '),
  )
}

/** Return the live session, launching Chromium on first use. */
async function getSession() {
  if (session) return session
  return launch()
}

/** Return the current page, creating one when the context has none. */
export async function getPage() {
  const current = await getSession()
  if (current.page && !current.page.isClosed()) return current.page
  current.page = await current.context.newPage()
  await current.page.bringToFront().catch(() => undefined)
  return current.page
}

/**
 * Resolve one addressable element from a snapshot reference or a CSS selector.
 * @param page - the active Playwright page.
 * @param target - the reference, selector, and role/name pair to match.
 * @returns the Playwright locator for the first matching element.
 */
export function locatorFor(page, target) {
  if (target.ref) return page.locator(`[data-dsh-ref="${target.ref}"]`).first()
  if (target.selector) return page.locator(target.selector).first()
  if (target.role || target.name) {
    return page.getByRole(target.role ?? 'button', { name: target.name ?? undefined }).first()
  }
  throw new Error('Provide ref, selector, or role/name to identify the target element.')
}

/** Wait briefly for a navigation an action may have started. */
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined)
}

/** Read the page identity used by every tool result. */
async function describe(page) {
  return { url: page.url(), title: await page.title() }
}

/**
 * Open a URL in the shared page.
 * @param url - absolute http(s), or `about:blank`.
 * @returns page identity and the response status when one exists.
 */
export async function navigate(url) {
  const page = await getPage()
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  })
  return { ...(await describe(page)), status: response ? response.status() : null }
}

/**
 * Read the current page as a compact interactive snapshot with references.
 * @returns page identity, visible text, and the addressable elements.
 */
export async function snapshot() {
  const page = await getPage()
  const value = await page.evaluate(
    ({ selector, maxRefs }) => {
      const implicitRole = (element) => {
        const tag = element.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button') return 'button'
        if (tag === 'select') return 'combobox'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'summary') return 'button'
        if (tag !== 'input') return tag
        const type = (element.getAttribute('type') ?? 'text').toLowerCase()
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
        return 'textbox'
      }
      const elements = []
      let index = 0
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
        if (rect.width < 1 && rect.height < 1) continue
        index += 1
        const ref = `r${index}`
        element.setAttribute('data-dsh-ref', ref)
        const label = (
          element.getAttribute('aria-label') ??
          element.getAttribute('placeholder') ??
          element.innerText ??
          element.value ??
          element.getAttribute('title') ??
          ''
        )
          .toString()
          .trim()
          .replace(/\s+/g, ' ')
        const tag = element.tagName.toLowerCase()
        const type = element.getAttribute('type')
        const entry = {
          ref,
          tag,
          role: element.getAttribute('role') ?? implicitRole(element),
          name: label.slice(0, 160),
          disabled: element.disabled === true,
        }
        if (type) entry.type = type
        if (tag === 'input' || tag === 'select' || tag === 'textarea') {
          entry.value = typeof element.value === 'string' ? element.value.slice(0, 80) : ''
        }
        if (tag === 'input' && (type === 'checkbox' || type === 'radio')) entry.checked = element.checked === true
        const href = element.getAttribute('href')
        if (href) entry.href = href
        elements.push(entry)
        if (elements.length >= maxRefs) break
      }
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText ?? '').slice(0, 4000),
        elements,
      }
    },
    { selector: SNAPSHOT_SELECTOR, maxRefs: MAX_REFS },
  )
  return value
}

/**
 * Click one addressable element.
 * @param target - ref, selector, or role/name identifying the element.
 * @returns page identity after the action settles.
 */
export async function click(target) {
  const page = await getPage()
  await locatorFor(page, target).click({ timeout: ACTION_TIMEOUT_MS })
  await settle(page)
  return describe(page)
}

/**
 * Fill one addressable element and optionally submit it.
 * @param target - ref, selector, or role/name identifying the field.
 * @param text - the text to type.
 * @param submit - whether to press Enter after typing.
 * @returns page identity after the action settles.
 */
export async function type(target, text, submit) {
  const page = await getPage()
  const locator = locatorFor(page, target)
  await locator.fill(text, { timeout: ACTION_TIMEOUT_MS })
  if (submit) await locator.press('Enter', { timeout: ACTION_TIMEOUT_MS })
  await settle(page)
  return describe(page)
}

/**
 * Press a keyboard key on the focused element.
 * @param key - a Playwright key name, for example `Enter` or `Control+A`.
 * @returns page identity after the action settles.
 */
export async function press(key) {
  const page = await getPage()
  await page.keyboard.press(key)
  await settle(page)
  return describe(page)
}

/**
 * Scroll the page or one addressable element.
 * @param target - optional ref, selector, or role/name to scroll into view.
 * @param deltaY - additional vertical wheel distance in pixels.
 * @returns page identity after the action settles.
 */
export async function scroll(target, deltaY) {
  const page = await getPage()
  if (target.ref || target.selector || target.role || target.name) {
    await locatorFor(page, target).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
  }
  if (deltaY) await page.mouse.wheel(0, deltaY)
  await settle(page)
  return describe(page)
}

/**
 * Capture the page as a PNG file.
 * @param path - absolute output path resolved by the harness filesystem.
 * @param fullPage - whether to capture the full scrollable page.
 * @returns the written path and PNG byte length.
 */
export async function screenshot(path, fullPage) {
  const page = await getPage()
  const bytes = await page.screenshot({ fullPage, type: 'png' })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return { path, bytes: bytes.length, ...(await describe(page)) }
}

/**
 * Evaluate a read-only expression in the page and return its JSON value.
 * @param expression - a JavaScript expression evaluated in the page context.
 * @returns the JSON-serializable evaluation result.
 */
export async function evaluate(expression) {
  const page = await getPage()
  const value = await page.evaluate(expression)
  return { value: value === undefined ? null : value, ...(await describe(page)) }
}

/**
 * List, select, or close the open tabs of the shared context.
 * @param action - `list`, `select`, or `close`.
 * @param index - zero-based tab index for `select` and `close`; defaults to the active tab.
 * @returns the remaining tab identities and the active index.
 */
export async function tabs(action, index) {
  const current = await getSession()
  const pages = current.context.pages()
  if (action === 'select') {
    const target = pages[index ?? 0]
    if (!target) throw new Error(`No tab at index ${index ?? 0}; ${pages.length} tab(s) open.`)
    current.page = target
    await target.bringToFront()
  }
  if (action === 'close') {
    const target = pages[index ?? pages.length - 1]
    if (!target) throw new Error(`No tab at index ${index ?? 0}; ${pages.length} tab(s) open.`)
    await target.close()
    if (current.page === target) current.page = null
  }
  const remaining = current.context.pages()
  const listed = []
  for (let i = 0; i < remaining.length; i += 1) {
    listed.push({
      index: i,
      url: remaining[i].url(),
      title: await remaining[i].title(),
      active: remaining[i] === (current.page ?? remaining[remaining.length - 1]),
    })
  }
  return { tabs: listed }
}

/** Close the browser and drop the session. */
export async function closeBrowser() {
  if (!session) return { closed: false }
  const closing = session.browser
  session = null
  await closing.close()
  return { closed: true }
}

/**
 * The page of the running session without creating one.
 * @returns the active page, or undefined when no browser or tab is open.
 */
function livePage() {
  if (!session) return undefined
  const current =
    session.page && !session.page.isClosed() ? session.page : session.context.pages().at(-1)
  if (!current || current.isClosed()) return undefined
  return current
}

/**
 * The page the agent is on, for the DSH web client's right-sidebar Browser tab.
 * Reading it never launches a browser: with no session the state is inactive.
 * @returns whether a browser runs, and the current page's URL and title.
 */
export async function browserState() {
  const page = livePage()
  let url = null
  let title = null
  if (page) {
    url = page.url()
    title = await page.title().catch(() => null)
  }
  return { active: session !== null, url, title }
}
