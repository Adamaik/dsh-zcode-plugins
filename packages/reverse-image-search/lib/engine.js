/**
 * Search-by-image engine adapter.
 *
 * The only engine that answers without an API key and without an outbound
 * proxy is Baidu 识图 (`graph.baidu.com`). It is a web page rather than an API,
 * so this adapter drives it with a real browser: open the entry page, hand the
 * query image to its file input, wait for the result page, and read the
 * recognition phrase plus the similar-image grid.
 *
 * Everything the adapter returns comes from the rendered page; when the page
 * shape changes it reports that instead of inventing a result.
 *
 * @module dsh-reverse-image-search/engine
 */

import { launchBrowser } from './browser.js'

/** Entry page hosting Baidu's image-search upload widget. */
const BAIDU_ENTRY_URL = 'https://graph.baidu.com/pcpage/index?tpl_from=pc'

/** Result page URL marker. */
const BAIDU_RESULT_PATTERN = /graph\.baidu\.com\/s\?/

/** Browser identity used for the engine page. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Run one Baidu reverse-image search.
 * @param imagePath - absolute path of the query image.
 * @param limit - maximum records to return.
 * @returns recognition text, similar images, and external page links.
 */
async function baiduSearch(imagePath, limit) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1200 },
      userAgent: USER_AGENT,
    })
    const page = await context.newPage()
    await page.goto(BAIDU_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    const input = page.locator('input[type=file]').first()
    await input.waitFor({ state: 'attached', timeout: 30_000 })
    await input.setInputFiles(imagePath)
    await page.waitForURL(BAIDU_RESULT_PATTERN, { timeout: 60_000 }).catch(() => undefined)
    await page
      .waitForFunction(
        () => Boolean(document.querySelector('.graph-guess-word, .graph-similar, .graph-product-list')),
        { timeout: 30_000 },
      )
      .catch(() => undefined)
    await page.waitForTimeout(1500)

    const scraped = await page.evaluate(() => {
      const clean = (value) => (value ?? '').toString().replace(/\s+/g, ' ').trim()
      const recognition = clean(document.querySelector('.graph-guess-word')?.textContent) || null
      const isBaidu = (href) => {
        try {
          return /(^|\.)baidu\.com$/.test(new URL(href).hostname)
        } catch {
          return false
        }
      }
      const images = []
      let similarUrl = null
      const container = document.querySelector('.graph-similar')
      if (container) {
        for (const image of container.querySelectorAll('img[src]')) {
          const anchor = image.closest('a')
          const href = anchor?.href ?? ''
          const usable = href && !href.startsWith('javascript:')
          if (usable && isBaidu(href) && similarUrl === null) similarUrl = href
          images.push({
            thumbnailUrl: image.currentSrc || image.src,
            pageUrl: usable && !isBaidu(href) ? href : null,
            title: clean(image.alt) || null,
          })
        }
      }
      const pages = []
      for (const anchor of document.querySelectorAll('a[href^="http"]')) {
        let host
        try {
          host = new URL(anchor.href).hostname
        } catch {
          continue
        }
        if (/(^|\.)baidu\.com$|(^|\.)bdstatic\.com$/.test(host)) continue
        pages.push({ url: anchor.href, host, title: clean(anchor.textContent).slice(0, 120) || null })
      }
      return { recognition, images, pages, similarUrl, documentTitle: document.title }
    })

    const seen = new Set()
    const images = []
    for (const image of scraped.images) {
      if (!image.thumbnailUrl || seen.has(image.thumbnailUrl)) continue
      seen.add(image.thumbnailUrl)
      images.push(image)
      if (images.length >= limit) break
    }
    const pageSeen = new Set()
    const pages = []
    for (const entry of scraped.pages) {
      if (pageSeen.has(entry.url)) continue
      pageSeen.add(entry.url)
      pages.push(entry)
      if (pages.length >= limit) break
    }
    return {
      engine: 'baidu',
      resultUrl: page.url(),
      recognition: scraped.recognition,
      similarUrl: scraped.similarUrl,
      images,
      pages,
      notes: [
        'Baidu returns a recognition phrase and similar images, not a guaranteed source page.',
        ...(images.length === 0 && pages.length === 0
          ? ['No similar-image grid was found; the result layout may have changed.']
          : []),
      ],
    }
  } finally {
    await browser.close()
  }
}

/** Engines this plugin can drive, keyed by the value the tool accepts. */
export const ENGINES = {
  baidu: baiduSearch,
}

/** Engine used when the caller does not choose one. */
export const DEFAULT_ENGINE = 'baidu'

/**
 * Run one search-by-image request.
 * @param options - query image path, engine id, and result limit.
 * @returns the engine's result record.
 */
export async function searchByImage({ imagePath, engine, limit }) {
  const id = engine ?? DEFAULT_ENGINE
  const run = ENGINES[id]
  if (!run) {
    throw new Error(`unknown engine "${id}"; available: ${Object.keys(ENGINES).join(', ')}`)
  }
  return run(imagePath, limit)
}