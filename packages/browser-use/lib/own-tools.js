/**
 * Model-facing tools for the plugin's own sidebar browser.
 *
 * Separate from the \`browser_*\` tools on purpose. Those drive a headless
 * Playwright Chromium: fast, scriptable, and obviously automated. These drive
 * the real browser the plugin mounts in the DSH sidebar — a different process
 * with its own persistent cookies, no headless fingerprint, and a user sitting
 * in front of it who can take over at any moment.
 *
 * Reach for these when a site needs a login, a human, or a browser that does not
 * look automated; keep using \`browser_*\` for everything behind a public URL.
 *
 * @module dsh-zcode-browser-use/own-tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { ownCommand, ownStatus } from './own.js'

/** Render one canonical browser value as pretty JSON text. */
const renderJson = (_args, value) => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/**
 * Build one registry-ready tool declaration.
 * @param options - name, description, parameter properties, required keys, and body.
 * @returns the plain tool definition the DSH tool registry accepts.
 */
function defineOwnTool({ name, description, properties, required = [], execute }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    output: { schema: {}, render: renderJson },
    execute,
  }
}

/** Read one required non-empty string argument. */
function requiredString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(key + ' is required and must be a non-empty string')
  }
  return value
}

/** Read one optional string argument. */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(key + ' must be a string')
  return value
}

/**
 * The element selector shared by click and type.
 * @param args - tool arguments using ref, selector, or role and name.
 * @returns the locator fields the client half understands.
 */
function locator(args) {
  const ref = optionalString(args, 'ref')
  const selector = optionalString(args, 'selector')
  const role = optionalString(args, 'role')
  const name = optionalString(args, 'name')
  if (ref === undefined && selector === undefined && role === undefined && name === undefined) {
    throw new Error('Provide ref, selector, or role/name to identify the target element.')
  }
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(selector === undefined ? {} : { selector }),
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
  }
}

/**
 * Build the own-browser tools.
 * @param resolveOutput - resolves an output path through the harness filesystem.
 * @returns registry-ready tool declarations.
 */
export function createOwnBrowserTools(resolveOutput) {
  return [
    defineOwnTool({
      name: 'own_browser_open',
      description:
        '在 DSH 侧边栏里打开本插件自己的浏览器（真实 Chromium guest，独立 Cookie，不是无头）。用户可以在里面直接操作。' +
        '需要登录、需要过风控、或需要用户接管的场景用这个；公开页面抓取用 browser_* 更快。',
      properties: {
        url: { type: 'string', description: '可选：打开时载入的地址。' },
      },
      execute: async (args) => {
        const url = optionalString(args, 'url')
        return ownCommand('open', url === undefined ? {} : { url }, { timeoutMs: 20_000 })
      },
    }),

    defineOwnTool({
      name: 'own_browser_status',
      description: '查看侧边栏自有浏览器是否打开，以及它当前在哪个页面。不会改动它。',
      properties: {},
      execute: async () => ownStatus(),
    }),

    defineOwnTool({
      name: 'own_browser_navigate',
      description: '让侧边栏自有浏览器打开一个地址，返回稳定后的标题。',
      properties: {
        url: { type: 'string', description: '绝对 http(s) 地址。' },
      },
      required: ['url'],
      execute: async (args) => ownCommand('navigate', { url: requiredString(args, 'url') }, { timeoutMs: 45_000 }),
    }),

    defineOwnTool({
      name: 'own_browser_snapshot',
      description:
        '读取侧边栏自有浏览器的当前页面：地址、标题、可见文本与可寻址元素（ref/role/name/value）。' +
        '这是这条链路上的主要读取路径。',
      properties: {},
      execute: async () => ownCommand('snapshot', {}, { timeoutMs: 30_000 }),
    }),

    defineOwnTool({
      name: 'own_browser_click',
      description:
        '在侧边栏自有浏览器里点击一个元素。输入是真实指针事件（可信），不是合成的 DOM 事件。',
      properties: {
        ref: { type: 'string', description: '快照里的 ref，例如 r12。' },
        selector: { type: 'string', description: '没有 ref 时用的 CSS 选择器。' },
        role: { type: 'string', description: '配合 name 的 ARIA role。' },
        name: { type: 'string', description: '配合 role 的无障碍名称。' },
      },
      execute: async (args) => ownCommand('click', locator(args), { timeoutMs: 30_000 }),
    }),

    defineOwnTool({
      name: 'own_browser_type',
      description: '在侧边栏自有浏览器里填写一个输入框，可用 Enter 提交。走真实键盘事件。',
      properties: {
        ref: { type: 'string', description: '快照里的 ref。' },
        selector: { type: 'string', description: '没有 ref 时用的 CSS 选择器。' },
        role: { type: 'string', description: '配合 name 的 ARIA role。' },
        name: { type: 'string', description: '配合 role 的无障碍名称。' },
        text: { type: 'string', description: '要输入的文字。' },
        submit: { type: 'boolean', description: '输入后是否回车提交，默认 false。' },
      },
      required: ['text'],
      execute: async (args) => ownCommand(
        'type',
        { ...locator(args), text: requiredString(args, 'text'), submit: args.submit === true },
        { timeoutMs: 30_000 },
      ),
    }),

    defineOwnTool({
      name: 'own_browser_press',
      description: '在侧边栏自有浏览器里按一个按键，例如 Enter、Escape、Control+A。',
      properties: {
        key: { type: 'string', description: '按键名。' },
      },
      required: ['key'],
      execute: async (args) => ownCommand('press', { key: requiredString(args, 'key') }, { timeoutMs: 30_000 }),
    }),

    defineOwnTool({
      name: 'own_browser_screenshot',
      description: '把侧边栏自有浏览器的当前画面截成 PNG 文件，返回路径。',
      properties: {
        path: { type: 'string', description: '输出路径；相对路径按工作区解析。' },
      },
      execute: async (args, exec) => {
        const wanted = optionalString(args, 'path') ?? 'own-browser-screenshots/shot-' + Date.now() + '.png'
        const path = await resolveOutput(wanted, exec)
        const result = await ownCommand('screenshot', {}, { timeoutMs: 30_000 })
        const bytes = Buffer.from(String(result.base64 ?? ''), 'base64')
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, bytes)
        return { path, bytes: bytes.length, url: result.url, title: result.title }
      },
    }),
  ]
}
