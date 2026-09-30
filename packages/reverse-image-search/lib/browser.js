/**
 * Minimal Chromium launcher for reverse-image-search engines.
 *
 * Engines are ordinary web pages, so the plugin drives a real browser. The
 * launcher prefers Playwright's bundled Chromium and falls back to an installed
 * Google Chrome or Microsoft Edge, which keeps the plugin working without
 * Playwright's large browser download.
 *
 * @module dsh-reverse-image-search/browser
 */

/**
 * List launch candidates in order: the configured channel, Playwright's
 * bundled Chromium, then the installed Chrome and Edge channels.
 * @returns candidate launch options.
 */
function launchCandidates() {
  const configured = process.env.DSH_IMAGE_SEARCH_BROWSER
  if (configured) return [{ channel: configured }]
  return [{}, { channel: 'chrome' }, { channel: 'msedge' }]
}

/**
 * Load the Playwright entry point, reporting an actionable error when absent.
 * @returns the Playwright Chromium module.
 */
async function loadChromium() {
  try {
    const playwright = await import('playwright')
    return playwright.chromium
  } catch (error) {
    throw new Error(
      'Reverse image search needs the "playwright" package and a browser. ' +
        'Install the package dependency, then install Google Chrome or Microsoft Edge, ' +
        'or run: npx playwright install chromium. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Launch a browser, falling back across channels.
 * @returns the launched browser.
 */
export async function launchBrowser() {
  const chromium = await loadChromium()
  const errors = []
  for (const candidate of launchCandidates()) {
    try {
      return await chromium.launch({ headless: process.env.DSH_IMAGE_SEARCH_HEADLESS !== 'false', ...candidate })
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
      errors.push(`${candidate.channel ?? 'bundled chromium'}: ${detail}`)
    }
  }
  throw new Error(`no browser could be launched. Attempts: ${errors.join(' | ')}`)
}