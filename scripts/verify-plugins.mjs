#!/usr/bin/env node
/**
 * Load the repository's plugins against the real DSH skill registry and a
 * recording tool registry, then report what each package contributes.
 *
 * This is an integration check, not a full boot test: it mounts
 * @deepseek-ai/dsh-skill with @deepseek-ai/cordis and applies each plugin with a
 * context whose `tools` service records registrations. It needs the
 * repository's development `node_modules` (symlinks into an installed DSH) and
 * never touches the network.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const { Context } = await import('@deepseek-ai/cordis')
const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill')

const failures = []
const registeredTools = []

const ctx = new Context()
await ctx.plugin(SkillRegistry)

const registeredRoutes = []

/** A webServer stand-in that records the routes the sidebar mirror registers. */
const fakeWebServer = {
  register(route) {
    registeredRoutes.push(route)
    return () => undefined
  },
}

/** Context passed to plugin `apply`: the real skill registry plus recorded tool and web services. */
const host = {
  skills: ctx.skills,
  tools: {
    register(definition) {
      registeredTools.push(definition)
      return () => undefined
    },
  },
  // The mirror mounts through ctx.inject so a host without a web server keeps
  // its tools; this stand-in resolves the dependency immediately.
  effect(execute) {
    return execute()
  },
  inject(_deps, callback) {
    callback({ webServer: fakeWebServer, effect: (execute) => execute() })
  },
}

const pdfPlugin = await import(new URL('../packages/pdf/index.js', import.meta.url).href)
const browserPlugin = await import(new URL('../packages/browser-use/index.js', import.meta.url).href)
const reverseImageSearchPlugin = await import(new URL('../packages/reverse-image-search/index.js', import.meta.url).href)
pdfPlugin.apply(host)
browserPlugin.apply(host)
reverseImageSearchPlugin.apply(host)

const skills = (await ctx.skills.list()).map((skill) => skill.name).sort()
console.log('skills:', skills.join(', '))
for (const expected of ['pdf', 'control-browser', 'web-gui-tester', 'image-search']) {
  if (!skills.includes(expected)) failures.push(`skill ${expected} was not registered`)
}

const pdf = await ctx.skills.get('pdf')
if (!pdf?.content?.includes('Pick the route first')) failures.push('pdf skill body is missing its route section')
if (!pdf?.resourceBase?.path?.replace(/\/$/, '').endsWith('skills/pdf')) failures.push('pdf skill has no resource base directory')
if (pdf?.provider !== 'zcode-pdf') failures.push(`pdf provider is ${pdf?.provider}`)

const browserSkill = await ctx.skills.get('control-browser')
if (!browserSkill?.content?.includes('DSH port note')) failures.push('control-browser skill lost its DSH port note')

const tools = registeredTools.map((definition) => definition.name)
const expectedTools = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_screenshot',
  'browser_evaluate',
  'browser_tabs',
  'browser_close',
]
console.log('browser tools:', tools.join(', '))
for (const expected of expectedTools) {
  if (!tools.includes(expected)) failures.push(`tool ${expected} was not registered`)
}
for (const definition of registeredTools) {
  if (typeof definition.execute !== 'function') failures.push(`${definition.name} has no execute function`)
}

const imageSearch = await import(new URL('../packages/image-search/index.js', import.meta.url).href)
if (imageSearch.name !== 'zcode-image-search') failures.push('image-search plugin name changed')
if (typeof imageSearch.apply !== 'function') failures.push('image-search plugin is not applicable')

const imageSearchOpenSkill = await ctx.skills.get('image-search')
if (imageSearchOpenSkill?.provider !== 'reverse-image-search') {
  failures.push(`image-search skill provider is ${imageSearchOpenSkill?.provider}`)
}
const { createImageTools } = await import(new URL('../packages/reverse-image-search/lib/tools.js', import.meta.url).href)
const imageTools = createImageTools(async (target) => target)
const imageToolNames = imageTools.map((definition) => definition.name).sort()
console.log('image tools:', imageToolNames.join(', '))
if (imageToolNames.join(',') !== 'image_download,image_search') {
  failures.push(`unexpected image tools: ${imageToolNames.join(', ')}`)
}

const mirrorPaths = registeredRoutes.map((route) => route.path).sort()
console.log('sidebar routes:', mirrorPaths.join(', '))
if (mirrorPaths.join(',') !== '/browser-use/state') {
  failures.push(`unexpected sidebar routes: ${mirrorPaths.join(', ')}`)
}

/** Minimal ServerResponse stand-in: records the status, headers, and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(chunk) {
      this.body = chunk === undefined ? null : Buffer.from(chunk)
      this.ended = true
    },
  }
}

// With no browser open the bridge must answer without launching one.
const stateResponse = fakeResponse()
await registeredRoutes.find((route) => route.path === '/browser-use/state').handler({}, stateResponse)
const idleState = JSON.parse(stateResponse.body.toString('utf8'))
if (idleState.active !== false || idleState.url !== null || idleState.title !== null) {
  failures.push('idle state route reported a browser')
}

for (const failure of failures) console.error(`FAIL ${failure}`)
console.log(`\n${failures.length === 0 ? 'all plugin checks passed' : `${failures.length} check(s) failed`}`)
process.exitCode = failures.length === 0 ? 0 : 1
