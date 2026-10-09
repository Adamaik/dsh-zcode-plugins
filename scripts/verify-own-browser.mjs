#!/usr/bin/env node
/**
 * Verify the plugin's own sidebar browser, end to end and offline.
 *
 * The host half's real command routes are wired to the real client bundle,
 * running in a VM. Only the two ends are faked: the transport (calls go
 * straight into the route handlers instead of over HTTP) and the guest (a stub
 * webview that records what it was told). Everything in between — queueing,
 * long polling, dispatch, result reporting — is the shipped code.
 *
 * What it pins down:
 *   1. The client registers its own tab type and body; it never touches DSH's
 *      built-in Browser tab type.
 *   2. own_browser_open opens that tab and mounts the guest.
 *   3. snapshot / click / type / press / screenshot reach the guest, and input
 *      goes through sendInputEvent rather than synthetic DOM events.
 *   4. The host refuses commands before the browser is open.
 *   5. A failing command comes back as an error, not a hang.
 *
 * Usage: node scripts/verify-own-browser.mjs
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL(process.env.BROWSER_USE_LIB ?? '../packages/browser-use/lib/', import.meta.url)
const failures = []

/** Record one check outcome. */
function check(label, ok, detail) {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(label)
}

const { mountOwnBrowser, ownCommand, ownStatus } = await import(new URL('own.js', ROOT).href)

// ── host half: the real routes ──────────────────────────────────────────────

const routes = new Map()
mountOwnBrowser(
  { effect: (fn) => fn() },
  { register: (route) => { routes.set(route.path, route); return () => undefined } },
)
check('the host registers command, result and status routes', routes.size === 3, [...routes.keys()].join(', '))

/** Invoke a route handler the way the web server would. */
function callRoute(path, body) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    const res = {
      headersSent: false,
      writeHead() { return this },
      end(chunk) { resolve(chunk === undefined ? null : JSON.parse(String(chunk))) },
    }
    routes.get(path).handler(req, res)
  })
}

// ── the guest, faked ────────────────────────────────────────────────────────

const SNAPSHOT = {
  url: 'https://example.test/',
  title: '示例页',
  text: '示例页 按钮',
  elements: [{ ref: 'r1', tag: 'button', role: 'button', name: '按钮', disabled: false }],
}

class FakeGuest {
  constructor() {
    this.attrs = {}
    this.dataset = {}
    this.listeners = {}
    this.sent = []
    this.style = {}
    this.url = 'about:blank'
    this.loaded = []
  }
  setAttribute(key, value) { this.attrs[key] = value }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null }
  get isConnected() { return true }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn) }
  removeEventListener(name, fn) {
    const list = this.listeners[name] || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  emit(name) { for (const fn of this.listeners[name] || []) fn() }
  appendChild() {}
  remove() {}
  focus() {}
  loadURL(url) {
    this.url = url
    this.loaded.push(url)
    Promise.resolve().then(() => this.emit('did-stop-loading'))
  }
  // The client navigates through src, which is also what makes the guest emit
  // its first dom-ready — Electron refuses loadURL before that.
  set src(value) {
    this.url = value
    if (value !== 'about:blank') this.loaded.push(value)
    Promise.resolve().then(() => {
      this.emit('dom-ready')
      this.emit('did-stop-loading')
    })
  }
  get src() {
    return this.url
  }
  getURL() { return this.url }
  getTitle() { return SNAPSHOT.title }
  executeJavaScript(code) {
    if (code.indexOf('document.querySelectorAll(selector)') >= 0) return Promise.resolve(SNAPSHOT)
    if (code.indexOf('getBoundingClientRect()') >= 0 && code.indexOf('return { x:') >= 0) {
      return Promise.resolve({ x: 12, y: 34 })
    }
    if (code.indexOf('el.focus()') >= 0) return Promise.resolve(true)
    return Promise.resolve(null)
  }
  sendInputEvent(event) { this.sent.push(event) }
  capturePage() { return Promise.resolve({ toDataURL: () => 'data:image/png;base64,QUJD' }) }
}

let mountedGuest = null
const documentStub = {
  createElement(tag) {
    if (tag === 'webview') {
      mountedGuest = new FakeGuest()
      return mountedGuest
    }
    return { style: {}, setAttribute() {}, appendChild() {} }
  },
  querySelectorAll() { return [] },
  body: { innerText: '' },
  title: '示例页',
}

// ── client half: the real bundle, in a VM ────────────────────────────────────

const source = readFileSync(new URL('client.js', ROOT), 'utf8')
let bundle = null
const opened = []
const registeredTypes = []
const registeredBodies = []
const sidebar = {
  current: undefined,
  openTab(kind, options) {
    opened.push({ kind, options })
    this.current = { id: 'own-1', kind }
    // The sidebar renders the tab body when the tab opens; with the React stub
    // that mounts the guest synchronously.
    if (kind === 'zcode-own-browser' && registeredBodies.length > 0) registeredBodies[0].body({})
  },
  active() { return this.current },
}

const acquiredWorkspaces = []
const releasedLeases = []
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  document: documentStub,
  fetch: (url, init) => {
    const path = String(url)
    const payload = init && init.body ? JSON.parse(init.body) : undefined
    if (path === '/browser-use/own/command') {
      return callRoute(path, undefined).then((body) => ({ ok: true, json: async () => body }))
    }
    return callRoute(path, payload).then((body) => ({ ok: true, json: async () => body }))
  },
  window: {
    __ModuleLoader__: { load: (m) => { bundle = m } },
    dshDesktop: {
      browser: {
        acquire: async (workspace) => {
          acquiredWorkspaces.push(workspace)
          return { lease: 'lease-1', partition: 'dsh-sidebar-browser-test' }
        },
        release: async (lease) => {
          releasedLeases.push(lease)
        },
      },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const ctx = {
  get: (name) => (name === 'sidebarRight' ? sidebar : undefined),
  effect: (fn) => fn(),
  sidebarRightTabs: { register: (definition) => { registeredTypes.push(definition); return () => undefined } },
  slots: {
    injected: [],
    register: (slot, body) => { registeredBodies.push({ slot, body }); return () => undefined },
    inject: (name, contribute) => { ctx.slots.injected.push(name); return contribute() },
  },
}

check('the client bundle registers under its package id', bundle !== null && bundle.id === 'dsh-zcode-browser-use', bundle && bundle.id)
bundle.factory((name) => {
  if (name === 'react') {
    // React attaches the ref during commit, before effects run; stand in for
    // the committed container node so the body can mount into it.
    return {
      useRef: () => ({ current: { appendChild() {}, style: {} } }),
      useEffect: (fn) => fn(),
      createElement: (tag, props, ...children) => ({ tag, props, children }),
    }
  }
  throw new Error('unexpected require: ' + name)
}).apply(ctx)

check('it registers exactly one tab type, and it is its own', registeredTypes.length === 1 && registeredTypes[0].kind === 'zcode-own-browser', JSON.stringify(registeredTypes.map((t) => t.kind)))
check('the tab type is not DSH built-in browser kind', registeredTypes[0].kind !== 'browser', registeredTypes[0].kind)
check('it registers the body for its own type', registeredBodies.length === 1 && registeredBodies[0].slot.name === 'sidebar.right.pane.tab' && registeredBodies[0].slot.key === registeredTypes[0].id, JSON.stringify(registeredBodies.map((b) => b.slot)))
check('the body is contributed from inside the slot scope, via inject', ctx.slots.injected.indexOf('sidebar.right.pane.tab') >= 0, JSON.stringify(ctx.slots.injected))

check('no tab is opened before it is asked for', opened.length === 0 && ownStatus().open === false, String(opened.length) + ' open(s)')

let refused = null
try {
  await ownCommand('snapshot', {}, { timeoutMs: 3000 })
} catch (error) {
  refused = String(error.message)
}
check('the host refuses commands before the browser is open', refused !== null && refused.indexOf('own_browser_open') >= 0, refused)

// ── open, then drive ────────────────────────────────────────────────────────

const openedResult = await ownCommand('open', { url: 'https://example.test/' }, { timeoutMs: 8000 })
check('own_browser_open opens the plugin tab type', opened.length === 1 && opened[0].kind === 'zcode-own-browser', JSON.stringify(opened.map((o) => o.kind)))
check('the guest asks the desktop bridge for a lease', acquiredWorkspaces.length === 1 && acquiredWorkspaces[0] === 'zcode-browser-use', JSON.stringify(acquiredWorkspaces))
check('the guest mounts on the leased partition', mountedGuest !== null && mountedGuest.attrs.partition === 'dsh-sidebar-browser-test', mountedGuest && mountedGuest.attrs.partition)
check('the guest carries the lease id the main process checks', mountedGuest !== null && mountedGuest.attrs.name === 'lease-1' && mountedGuest.attrs.src === 'about:blank#lease-1', mountedGuest && JSON.stringify({ name: mountedGuest.attrs.name, src: mountedGuest.attrs.src }))
check('the guest is tagged as a sidebar browser frame', mountedGuest !== null && mountedGuest.dataset.sidebarBrowserFrame === 'webview', mountedGuest && String(mountedGuest.dataset.sidebarBrowserFrame))
check('the guest is navigated to the URL', mountedGuest.loaded.indexOf('https://example.test/') >= 0, JSON.stringify(mountedGuest.loaded))
check('open reports the leased guest back', openedResult.open === true && openedResult.partition === 'dsh-sidebar-browser-test', JSON.stringify(openedResult))
await new Promise((resolve) => setTimeout(resolve, 50))
check('the host now reports the browser as open', ownStatus().open === true && ownStatus().url === 'https://example.test/', JSON.stringify(ownStatus()))

const snap = await ownCommand('snapshot', {}, { timeoutMs: 8000 })
check('snapshot returns the page and its elements', snap.title === '示例页' && snap.elements.length === 1 && snap.elements[0].name === '按钮', JSON.stringify({ title: snap.title, refs: snap.elements.length }))

mountedGuest.sent.length = 0
await ownCommand('click', { ref: 'r1' }, { timeoutMs: 8000 })
const clicks = mountedGuest.sent.filter((e) => e.type === 'mouseDown' || e.type === 'mouseUp')
check('click injects a trusted pointer pair', clicks.length === 2 && clicks[0].button === 'left' && typeof clicks[0].x === 'number', JSON.stringify(mountedGuest.sent))
check('the pointer goes through sendInputEvent, not DOM dispatch', mountedGuest.sent.every((e) => e.type !== 'click'), JSON.stringify(mountedGuest.sent.map((e) => e.type)))

mountedGuest.sent.length = 0
await ownCommand('type', { ref: 'r1', text: 'hi', submit: true }, { timeoutMs: 8000 })
const chars = mountedGuest.sent.filter((e) => e.type === 'char').map((e) => e.keyCode)
check('typing sends one char event per character', chars.join('') === 'hi', JSON.stringify(chars))
check('submit sends Enter', mountedGuest.sent.some((e) => e.type === 'keyDown' && e.keyCode === 'Enter'), JSON.stringify(mountedGuest.sent.map((e) => e.type)))

mountedGuest.sent.length = 0
await ownCommand('press', { key: 'Control+A' }, { timeoutMs: 8000 })
const combo = mountedGuest.sent.find((e) => e.type === 'keyDown')
check('a key combo carries its modifiers', combo !== undefined && combo.keyCode === 'A' && combo.modifiers.indexOf('control') >= 0, JSON.stringify(combo))

const shot = await ownCommand('screenshot', {}, { timeoutMs: 8000 })
check('screenshot returns base64 PNG data', typeof shot.base64 === 'string' && shot.base64.length > 0, String(shot.base64))

// ── failures surface, they do not hang ───────────────────────────────────────

mountedGuest.executeJavaScript = () => Promise.resolve(null)
let clickFailure = null
try {
  await ownCommand('click', { ref: 'r9' }, { timeoutMs: 5000 })
} catch (error) {
  clickFailure = String(error.message)
}
check('a missing element fails the command instead of hanging', clickFailure !== null && clickFailure.indexOf('找不到') >= 0, clickFailure)

let unknown = null
try {
  await ownCommand('nonsense', {}, { timeoutMs: 5000 })
} catch (error) {
  unknown = String(error.message)
}
check('an unknown command fails loudly', unknown !== null && unknown.indexOf('unknown own-browser command') >= 0, unknown)

// ── activation is fail-safe ─────────────────────────────────────────────────
//
// A throwing client entry fails the whole web boot and takes the app with it.
// These stubs are the shapes that did exactly that, so apply() must swallow all
// of them.

/** Load a fresh copy of the bundle with a silent console and a dead transport. */
function loadFresh() {
  let loaded = null
  const sandbox = {
    console: { error() {}, log() {}, warn() {} },
    setTimeout,
    clearTimeout,
    Promise,
    document: documentStub,
    fetch: () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }),
    window: { __ModuleLoader__: { load: (m) => { loaded = m } } },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return loaded.factory(() => { throw new Error('require must stay lazy') })
}

/** Activate once and report whether apply threw. */
function activationError(overrides) {
  try {
    loadFresh().apply({ get: () => undefined, effect: (fn) => fn(), ...overrides })
    return null
  } catch (error) {
    return String((error && error.message) || error)
  }
}

const rejectedTab = activationError({
  sidebarRightTabs: { register() { throw new Error('tab type rejected') } },
  slots: { register() { throw new Error('slot rejected') }, inject: (name, contribute) => contribute() },
})
check('a rejected tab type cannot fail the entry', rejectedTab === null, rejectedTab)

const rejectedSlot = activationError({
  sidebarRightTabs: { register: () => () => undefined },
  slots: { register() { throw new Error('slot rejected') }, inject: (name, contribute) => contribute() },
})
check('a rejected slot cannot fail the entry', rejectedSlot === null, rejectedSlot)

const rejectedInject = activationError({
  sidebarRightTabs: { register: () => () => undefined },
  slots: { register: () => () => undefined, inject() { throw new Error('inject rejected') } },
})
check('a rejected inject cannot fail the entry', rejectedInject === null, rejectedInject)

const noServices = activationError({})
check('a host without the sidebar services cannot fail the entry', noServices === null, noServices)

// The client context does not expose the sidebar services as plain properties;
// reading them that way yields undefined and silently skipped registration once,
// leaving openTab with "no tab type is registered".
const byName = { tabs: [], bodies: [] }
const nameOnly = {
  get: (name) => (name === 'sidebarRightTabs'
    ? { register: (definition) => { byName.tabs.push(definition); return () => undefined } }
    : name === 'slots'
      ? { register: (slot, body) => { byName.bodies.push({ slot, body }); return () => undefined }, inject: (n, contribute) => contribute() }
      : undefined),
  effect: (fn) => fn(),
}
activationError(nameOnly)
check('services are found by name even when the properties are absent', byName.tabs.length === 1 && byName.tabs[0].kind === 'zcode-own-browser' && byName.bodies.length === 1, JSON.stringify({ tabs: byName.tabs.length, bodies: byName.bodies.length }))

console.log('')
console.log(failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed: ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
