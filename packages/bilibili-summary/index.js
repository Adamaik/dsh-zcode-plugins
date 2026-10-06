/**
 * Bilibili video understanding for DeepSeek Harness.
 *
 * This bundle registers one skill and three tools: a QR sign-in that stores the
 * session cookies, a metadata reader that also surfaces Bilibili's own AI
 * summary, and the subtitle extractor. The extractor is deliberately defensive:
 * the player route rate-limits by returning empty, unrelated, or truncated
 * bodies, so it validates coverage and retries instead of handing the model
 * someone else's transcript.
 *
 * The skill on top turns a transcript into a self-contained HTML report.
 *
 * @module dsh-bilibili-summary
 */

import { readFileSync } from 'node:fs'
import { resolve as resolveNodePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { createBilibiliTools } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'bilibili-summary'

/** Services required for registration; the filesystem service is read lazily when present. */
export const inject = ['skills', 'tools']

/** Plugin configuration. Every field has a default, so an empty config is valid. */
export const Config = Schema.object({
  sessdata: Schema.string().default(''),
  cookieFile: Schema.string().default(''),
  language: Schema.string().default('ai-zh'),
  retries: Schema.natural().default(6),
  retryBaseDelayMs: Schema.natural().default(8000),
  timeoutMs: Schema.natural().default(20000),
  ffmpegPath: Schema.string().default(''),
  asrPython: Schema.string().default(''),
  asrVenv: Schema.string().default(''),
  asrModel: Schema.string().default('small'),
  asrModelDir: Schema.string().default(''),
  asrLanguage: Schema.string().default('auto'),
})

/** Skill directory shipped by this package. */
const SKILL_DIR = new URL('./skills/bilibili-summary/', import.meta.url)

/** Routing description for the bundled skill. */
const DESCRIPTION =
  'Summarize a Bilibili video into a Chinese HTML report from its AI/CC subtitle track. Use when the user ' +
  'shares a bilibili.com or b23.tv video link and asks for a summary, notes, transcript, highlights, or a ' +
  'written report; also use to pull just the subtitle text. Not for other video sites.'

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

/**
 * Register the skill and the Bilibili tools.
 * @param ctx - Cordis context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config = {}) {
  ctx.skills.register({
    name: 'bilibili-summary',
    description: DESCRIPTION,
    content: skillBody(readFileSync(new URL('SKILL.md', SKILL_DIR), 'utf8')),
    resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
    provider: 'bilibili-summary',
    source: 'bundled',
  })
  const resolveOutput = async (target, exec) => {
    const cwd = exec?.agent?.session?.header?.cwd
    const fs = ctx.get ? ctx.get('fs') : ctx.fs
    if (!fs) return resolveNodePath(cwd ?? process.cwd(), target)
    const options = { ...(cwd ? { cwd } : {}), ...(exec?.signal ? { signal: exec.signal } : {}) }
    return fs.processPath(await fs.resolve(target, options))
  }
  const defaults = {
    sessdata: config.sessdata ?? '',
    cookieFile: config.cookieFile ?? '',
    language: config.language ?? 'ai-zh',
    retries: config.retries ?? 6,
    retryBaseDelayMs: config.retryBaseDelayMs ?? 8000,
    timeoutMs: config.timeoutMs ?? 20000,
    ffmpegPath: config.ffmpegPath ?? '',
    asrPython: config.asrPython ?? '',
    asrVenv: config.asrVenv ?? '',
    asrModel: config.asrModel ?? 'small',
    asrModelDir: config.asrModelDir ?? '',
    asrLanguage: config.asrLanguage ?? 'auto',
  }
  for (const tool of createBilibiliTools({ resolvePath: resolveOutput, defaults })) ctx.tools.register(tool)
}
