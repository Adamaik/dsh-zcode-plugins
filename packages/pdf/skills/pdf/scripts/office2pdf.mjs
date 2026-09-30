#!/usr/bin/env node
/**
 * Convert Office documents and HTML to PDF, or render any supported document's
 * pages to PNG, using the bundled LibreOffice engine.
 *
 * This is the DSH-native conversion path: the office half of the PDF skill does
 * not shell out to a system LibreOffice. The engine comes from
 * `@deepseek-ai/libreoffice-kit`, which DSH also uses for its office skills.
 *
 * Usage:
 *   node office2pdf.mjs --input report.docx --out report.pdf
 *   node office2pdf.mjs --input deck.pptx --to images --out-dir pages/
 */

import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Candidate module specifiers for the LibreOffice kit, most explicit first. */
function kitCandidates() {
  const candidates = ['@deepseek-ai/libreoffice-kit']
  const explicit = process.env.DSH_LIBREOFFICE_KIT
  if (explicit) {
    const entry = explicit.endsWith('.js') ? explicit : join(explicit, 'lib', 'index.js')
    candidates.unshift(pathToFileURL(entry).href)
  }
  return candidates
}

/**
 * Load the LibreOffice kit, reporting an actionable error when absent.
 * @returns the kit's `createConverter` function.
 */
async function loadKit() {
  const errors = []
  for (const candidate of kitCandidates()) {
    try {
      const kit = await import(candidate)
      if (typeof kit.createConverter === 'function') return kit.createConverter
      errors.push(`${candidate}: no createConverter export`)
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  throw new Error(
    'Office conversion needs @deepseek-ai/libreoffice-kit (about 150 MB installed). ' +
      'Install it into the profile on demand: ' +
      'dsh plugin --profile <profile> add @deepseek-ai/libreoffice-kit. ' +
      'A deployment that already ships the kit can point DSH_LIBREOFFICE_KIT at its package directory. ' +
      `Attempts: ${errors.join(' | ')}`,
  )
}

/** Resolve one user path against the current working directory. */
function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      input: { type: 'string' },
      out: { type: 'string' },
      'out-dir': { type: 'string' },
      to: { type: 'string', default: 'pdf' },
      'timeout-ms': { type: 'string', default: '120000' },
      recalculate: { type: 'boolean', default: false },
      sheet: { type: 'string' },
    },
  })
  if (!values.input) throw new Error('--input is required')
  const inputPath = absolutePath(values.input)
  const inputExtension = extname(inputPath).slice(1).toLowerCase() || '(none)'
  const createConverter = await loadKit()
  const converter = await createConverter({ timeoutMs: Number(values['timeout-ms']) })
  try {
    if (values.to === 'images') {
      const outDir = absolutePath(values['out-dir'] ?? 'pdf-pages')
      await mkdir(outDir, { recursive: true })
      const result = await converter.renderImages({ inputPath, outputDir: outDir })
      console.log(JSON.stringify({ input: inputPath, outDir, ...result }, null, 2))
      return
    }
    const outputPath = absolutePath(values.out ?? inputPath.replace(/\.\w+$/, '') + '.pdf')
    await mkdir(dirname(outputPath), { recursive: true })
    const operation = values.recalculate ? 'recalculate' : outputPath.toLowerCase().endsWith('.pdf') ? 'render' : 'convert'
    const request = { inputPath, outputPath }
    if (values.sheet) request.sheet = values.sheet
    const result =
      operation === 'render'
        ? await converter.render(request)
        : operation === 'recalculate'
          ? await converter.recalculate(request)
          : await converter.convert(request)
    console.log(
      JSON.stringify(
        {
          input: inputPath,
          inputExtension,
          output: outputPath,
          operation,
          ...result,
        },
        null,
        2,
      ),
    )
  } finally {
    await converter.dispose()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
