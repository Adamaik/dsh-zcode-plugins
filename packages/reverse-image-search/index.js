/**
 * Search-by-image (reverse image search) for DeepSeek Harness.
 *
 * DSH's own web capability is text-only, and multimodal input can describe an
 * image but cannot look it up. This plugin adds the missing direction: an image
 * goes in, matching images and pages come out. It needs no API key and no
 * outbound proxy.
 *
 * @module dsh-reverse-image-search
 */

import { readFileSync } from 'node:fs'
import { resolve as resolveNodePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createImageTools } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'reverse-image-search'

/** Services required for registration; the filesystem service is read lazily when present. */
export const inject = ['skills', 'tools']

/** Skill directory shipped by this package. */
const SKILL_DIR = new URL('./skills/image-search/', import.meta.url)

/** Routing description for the bundled skill. */
const DESCRIPTION =
  'Search by image (reverse image search): identify where a picture comes from and what it shows. ' +
  'Use when the user supplies an image and asks what it is, who it belongs to, or where it came from, ' +
  'or when an avatar, screenshot, photo, or product picture needs a source.'

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

/** Register the skill and the image tools. */
export function apply(ctx) {
  ctx.skills.register({
    name: 'image-search',
    description: DESCRIPTION,
    content: skillBody(readFileSync(new URL('SKILL.md', SKILL_DIR), 'utf8')),
    resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
    provider: 'reverse-image-search',
    source: 'bundled',
  })
  const resolveOutput = async (target, exec) => {
    const cwd = exec?.agent?.session?.header?.cwd
    const fs = ctx.get ? ctx.get('fs') : ctx.fs
    if (!fs) return resolveNodePath(cwd ?? process.cwd(), target)
    const options = { ...(cwd ? { cwd } : {}), ...(exec?.signal ? { signal: exec.signal } : {}) }
    return fs.processPath(await fs.resolve(target, options))
  }
  for (const tool of createImageTools(resolveOutput)) ctx.tools.register(tool)
}
