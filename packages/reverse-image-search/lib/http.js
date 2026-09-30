/**
 * HTTP helper for materializing a remote query image.
 *
 * A remote URL is downloaded once to a temporary file before the engine sees
 * it, because every engine drives a real file input.
 *
 * @module dsh-reverse-image-search/http
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Identifying User-Agent for outbound requests. */
const USER_AGENT = 'dsh-reverse-image-search/0.1 (DeepSeek Harness plugin)'

/** Largest query image accepted from a URL. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Download one image URL to a local path.
 * @param url - absolute http(s) image URL.
 * @param target - absolute destination path.
 * @returns byte length and content type.
 */
export async function downloadImage(url, target) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
    if (!contentType.startsWith('image/')) {
      throw new Error(`refused: content-type is ${contentType}, not an image`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`refused: ${bytes.byteLength} bytes exceeds the 25 MB limit`)
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    return { bytes: bytes.byteLength, contentType }
  } finally {
    clearTimeout(timer)
  }
}