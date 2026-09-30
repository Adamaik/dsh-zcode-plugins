/**
 * DeepSeek Harness PDF skill provider.
 *
 * The skill body is reimplemented for DSH (see NOTICE): it routes report,
 * creative, academic, and existing-PDF work, and its scripts use the harness
 * Python, the bundled LibreOffice kit, and Playwright rather than the upstream
 * ZCode runtime.
 *
 * @module dsh-zcode-pdf
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'zcode-pdf'

/** Service required to publish the skill. */
export const inject = ['skills']

/** Routing description used when the SKILL.md frontmatter cannot be parsed. */
const FALLBACK_DESCRIPTION =
  'Professional PDF toolkit covering reports, creative visuals, academic LaTeX, and existing-PDF processing. ' +
  'Use for any task whose output is a PDF, or to merge, split, rotate, fill, or extract from an existing one.'

const SKILL_DIR = new URL('./skills/pdf/', import.meta.url)

/**
 * Split one Markdown file into its YAML frontmatter and instruction body.
 * @param text - raw SKILL.md content.
 * @returns the parsed attribute map and the remaining body.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { attributes: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { attributes: {}, body: text }
  const bodyStart = text.indexOf('\n', end + 1)
  const header = text.slice(3, end)
  const attributes = {}
  const match = /^description:\s*("(?:[^"\\]|\\.)*")/m.exec(header)
  if (match) {
    try {
      attributes.description = JSON.parse(match[1])
    } catch {
      attributes.description = undefined
    }
  }
  return { attributes, body: bodyStart === -1 ? '' : text.slice(bodyStart + 1) }
}

/** Register the PDF skill on the skill registry. */
export function apply(ctx) {
  const raw = readFileSync(new URL('SKILL.md', SKILL_DIR), 'utf8')
  const { attributes, body } = parseFrontmatter(raw)
  ctx.skills.register({
    name: 'pdf',
    description: attributes.description || FALLBACK_DESCRIPTION,
    content: body,
    resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
    provider: 'zcode-pdf',
    source: 'bundled',
  })
}
