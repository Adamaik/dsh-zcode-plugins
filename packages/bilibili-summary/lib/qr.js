/**
 * QR rendering for the sign-in flow.
 *
 * `qrcode-generator` supplies the module matrix (the reference QR encoder, MIT);
 * {@link ./png.js} turns it into a PNG so the harness can display the code
 * inline without any network round trip to an image service.
 *
 * @module dsh-bilibili-summary/qr
 */

import qrcode from 'qrcode-generator'
import { encodeGrayPng } from './png.js'

/** Quiet-zone width in modules, matching the QR specification. */
const DEFAULT_BORDER = 4

/**
 * Render text as a PNG-sized QR code.
 * @param text - content to encode.
 * @param options - pixel scale per module and quiet-zone width.
 * @returns the pixel size, module count, and PNG bytes.
 */
export function renderQrPng(text, options = {}) {
  const scale = options.scale ?? 8
  const border = options.border ?? DEFAULT_BORDER
  if (!Number.isInteger(scale) || scale < 2 || scale > 64) {
    throw new Error('qr scale must be an integer between 2 and 64')
  }
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  const modules = code.getModuleCount()
  const size = (modules + border * 2) * scale
  const pixels = Buffer.alloc(size * size, 0xff)
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (!code.isDark(row, column)) continue
      const top = (row + border) * scale
      const left = (column + border) * scale
      for (let y = 0; y < scale; y++) {
        pixels.fill(0x00, (top + y) * size + left, (top + y) * size + left + scale)
      }
    }
  }
  return { buffer: encodeGrayPng(size, size, pixels), size, modules }
}
