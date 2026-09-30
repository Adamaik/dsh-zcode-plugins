/**
 * Model-facing browser tools registered by the DSH browser-use plugin.
 *
 * The definitions are plain JSON-Schema tool declarations, not `defineTool`
 * output: a third-party bundle can resolve a different copy of
 * `@deepseek-ai/dsh-tools` than the running harness, so this package imports
 * nothing from the harness and registers only the plain shape the tool registry
 * documents. Tool names use the `browser_*` prefix; the porting note in
 * `skills/control-browser/SKILL.md` maps the upstream ZCode calls onto them.
 *
 * @module dsh-zcode-browser-use/tools
 */

import {
  click,
  closeBrowser,
  evaluate,
  navigate,
  press,
  screenshot,
  scroll,
  snapshot,
  tabs,
  type,
} from './browser.js'

/** Render one canonical browser value as pretty JSON text. */
const renderJson = (_args, value) => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/**
 * Build one registry-ready tool declaration.
 * @param options - name, description, parameter properties, required keys, and body.
 * @returns the plain tool definition the DSH tool registry accepts.
 */
function defineBrowserTool({ name, description, properties, required = [], execute }) {
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
    throw new Error(`${key} is required and must be a non-empty string`)
  }
  return value
}

/** Read one optional string argument. */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

/** Read one optional finite number argument. */
function optionalNumber(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`)
  }
  return value
}

/** Read one optional boolean argument. */
function optionalBoolean(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

/** Read the element target fields shared by click, type, and scroll. */
function elementTarget(args) {
  return {
    ref: optionalString(args, 'ref'),
    selector: optionalString(args, 'selector'),
    role: optionalString(args, 'role'),
    name: optionalString(args, 'name'),
  }
}

/** Reusable element-target parameters. */
const TARGET_PROPERTIES = {
  ref: {
    type: 'string',
    description: 'Element reference from the latest browser_snapshot (for example "r12").',
  },
  selector: {
    type: 'string',
    description: 'CSS selector used when no snapshot reference is available.',
  },
  role: {
    type: 'string',
    description: 'ARIA role used with name as a locator fallback.',
  },
  name: {
    type: 'string',
    description: 'Accessible name used with role as a locator fallback.',
  },
}

/**
 * Build the browser tool definitions.
 * @param resolvePath - harness filesystem path resolution for screenshot output.
 * @returns registry-ready tool declarations.
 */
export function createBrowserTools(resolvePath) {
  return [
    defineBrowserTool({
      name: 'browser_navigate',
      description:
        'Open a URL in the shared browser and return the settled page title and status. ' +
        'Use for every browser task before reading or acting on a page.',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL, or about:blank.',
        },
      },
      required: ['url'],
      execute: ({ url }) => navigate(requiredString({ url }, 'url')),
    }),
    defineBrowserTool({
      name: 'browser_snapshot',
      description:
        'Read the current page as a compact interactive snapshot: visible text plus a list of ' +
        'addressable elements with ref, role, name, value, and state. This is the primary way to ' +
        'understand a page and to obtain refs for browser_click and browser_type.',
      properties: {},
      execute: () => snapshot(),
    }),
    defineBrowserTool({
      name: 'browser_click',
      description:
        'Click one element identified by a snapshot ref, a CSS selector, or an ARIA role and name. ' +
        'Take a fresh browser_snapshot afterwards when the next step needs new ground truth.',
      properties: TARGET_PROPERTIES,
      execute: (args) => click(elementTarget(args)),
    }),
    defineBrowserTool({
      name: 'browser_type',
      description:
        'Fill one input identified by a snapshot ref, selector, or role and name, optionally ' +
        'submitting with Enter.',
      properties: {
        ...TARGET_PROPERTIES,
        text: { type: 'string', description: 'Text to type into the field.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
      },
      required: ['text'],
      execute: (args) =>
        type(elementTarget(args), requiredString(args, 'text'), optionalBoolean(args, 'submit') ?? false),
    }),
    defineBrowserTool({
      name: 'browser_press',
      description: 'Press one keyboard key on the focused element.',
      properties: {
        key: {
          type: 'string',
          description: 'Playwright key name, for example Enter, Tab, Escape, or Control+A.',
        },
      },
      required: ['key'],
      execute: (args) => press(requiredString(args, 'key')),
    }),
    defineBrowserTool({
      name: 'browser_scroll',
      description: 'Scroll one element into view and optionally wheel the page by a pixel delta.',
      properties: {
        ...TARGET_PROPERTIES,
        delta_y: { type: 'number', description: 'Vertical wheel distance in pixels.' },
      },
      execute: (args) => scroll(elementTarget(args), optionalNumber(args, 'delta_y')),
    }),
    defineBrowserTool({
      name: 'browser_screenshot',
      description:
        'Capture the page as a PNG file and return its path. Use only when visual layout, ' +
        'styling, or rendering matters, or when the user asked for a screenshot.',
      properties: {
        path: {
          type: 'string',
          description:
            'Output path; relative paths resolve against the workspace. ' +
            'Defaults to browser-screenshots/screenshot-<timestamp>.png.',
        },
        full_page: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of the viewport.',
        },
      },
      execute: async (args, exec) => {
        const target = optionalString(args, 'path') ?? `browser-screenshots/screenshot-${Date.now()}.png`
        return screenshot(await resolvePath(target, exec), optionalBoolean(args, 'full_page') ?? false)
      },
    }),
    defineBrowserTool({
      name: 'browser_evaluate',
      description:
        'Evaluate a read-only JavaScript expression in the page and return its JSON value. ' +
        'Use only for inspection the snapshot cannot express; never mutate page state with it.',
      properties: {
        expression: {
          type: 'string',
          description: 'A JavaScript expression, for example "document.querySelectorAll(\'a\').length".',
        },
      },
      required: ['expression'],
      execute: (args) => evaluate(requiredString(args, 'expression')),
    }),
    defineBrowserTool({
      name: 'browser_tabs',
      description:
        'List, select, or close the open browser tabs. Select a newly opened popup before reading it.',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'select', 'close'],
          description: 'Tab operation to perform.',
        },
        index: { type: 'number', description: 'Zero-based tab index for select or close.' },
      },
      required: ['action'],
      execute: (args) => {
        const action = requiredString(args, 'action')
        if (!['list', 'select', 'close'].includes(action)) {
          throw new Error('action must be one of: list, select, close')
        }
        return tabs(action, optionalNumber(args, 'index'))
      },
    }),
    defineBrowserTool({
      name: 'browser_close',
      description: 'Close the shared browser and release its process.',
      properties: {},
      execute: () => closeBrowser(),
    }),
  ]
}
