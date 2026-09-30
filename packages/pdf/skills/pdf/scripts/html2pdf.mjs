#!/usr/bin/env node
/**
 * Render a local HTML file or a remote URL to PDF with Chromium.
 *
 * This is the creative half of the PDF skill: posters, covers, and one-page
 * visuals are authored as HTML/CSS and printed with real browser layout.
 * Chromium comes from Playwright; install it once with
 * `npx playwright install chromium`.
 *
 * Usage:
 *   node html2pdf.mjs --input poster.html --out poster.pdf --format A3
 *   node html2pdf.mjs --url http://localhost:3000 --out page.pdf --wait-selector "#ready"
 */

import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'node:path'

/**
 * Launch candidates in order: the configured channel, Playwright's bundled
 * Chromium, then the installed Chrome and Edge channels, so printing works
 * without Playwright's extra browser download.
 * @returns candidate launch options.
 */
function launchCandidates() {
  const configured = process.env.DSH_BROWSER_CHANNEL
  if (configured) return [{ channel: configured }]
  return [{}, { channel: 'chrome' }, { channel: 'msedge' }]
}

/**
 * Launch a browser, falling back across channels.
 * @param chromium - the Playwright Chromium module.
 * @returns the launched browser.
 */
async function launchBrowser(chromium) {
  const errors = []
  for (const candidate of launchCandidates()) {
    try {
      return await chromium.launch({ headless: true, ...candidate })
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
      errors.push(`${candidate.channel ?? 'bundled chromium'}: ${detail}`)
    }
  }
  throw new Error(
    'No browser could be launched for HTML printing. Install Google Chrome or Microsoft Edge, ' +
      `or run: npx playwright install chromium. Attempts: ${errors.join(' | ')}`,
  )
}

/** Convert a millimetre or CSS length argument into a Playwright margin value. */
function marginValue(value) {
  if (value === undefined) return { top: '0', right: '0', bottom: '0', left: '0' }
  const parts = value.split(',').map((part) => part.trim())
  if (parts.length === 1) {
    return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] }
  }
  const [top, right = top, bottom = top, left = right] = parts
  return { top, right, bottom, left }
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      input: { type: 'string' },
      url: { type: 'string' },
      out: { type: 'string' },
      format: { type: 'string', default: 'A4' },
      landscape: { type: 'boolean', default: false },
      margin: { type: 'string' },
      'wait-ms': { type: 'string', default: '0' },
      'wait-selector': { type: 'string' },
      timeout: { type: 'string', default: '60000' },
    },
  })
  if (!values.out) throw new Error('--out is required')
  if (!values.input && !values.url) throw new Error('provide --input or --url')
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (error) {
    throw new Error(
      'HTML rendering needs the playwright package plus a browser. Install the package, then either ' +
        'use an installed Google Chrome or Microsoft Edge (the default fallback) or run: npx playwright install chromium. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const source = values.url
    ? values.url
    : pathToFileURL(isAbsolute(values.input) ? values.input : resolve(process.cwd(), values.input)).href
  const browser = await launchBrowser(chromium)
  try {
    const page = await browser.newPage()
    await page.goto(source, { waitUntil: 'load', timeout: Number(values.timeout) })
    if (values['wait-selector']) {
      await page.waitForSelector(values['wait-selector'], { timeout: Number(values.timeout) })
    }
    const waitMs = Number(values['wait-ms'])
    if (waitMs > 0) await page.waitForTimeout(waitMs)
    await page.emulateMedia({ media: 'print' })
    const out = isAbsolute(values.out) ? values.out : resolve(process.cwd(), values.out)
    await page.pdf({
      path: out,
      format: values.format,
      landscape: values.landscape,
      printBackground: true,
      margin: marginValue(values.margin),
      preferCSSPageSize: true,
    })
    console.log(JSON.stringify({ source, out, format: values.format }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
