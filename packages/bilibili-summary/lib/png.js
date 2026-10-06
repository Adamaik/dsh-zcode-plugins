/**
 * Minimal grayscale PNG encoder.
 *
 * The QR code has to reach the user as an image the harness can display, and a
 * plugin should not need an image library for one black-and-white bitmap. This
 * writes an 8-bit greyscale PNG with `node:zlib` only.
 *
 * @module dsh-bilibili-summary/png
 */

import { deflateSync } from 'node:zlib'

/** PNG signature. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Precomputed CRC-32 table (the PNG polynomial). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/**
 * Compute the CRC-32 of a buffer.
 * @param buffer - bytes to checksum.
 * @returns the unsigned checksum.
 */
function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * Build one length-prefixed, CRC-suffixed PNG chunk.
 * @param type - four-character chunk type.
 * @param data - chunk payload.
 * @returns the encoded chunk.
 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Encode one 8-bit greyscale image as PNG.
 * @param width - pixel width.
 * @param height - pixel height.
 * @param pixels - `width * height` luminance bytes, row-major from the top.
 * @returns the PNG file bytes.
 */
export function encodeGrayPng(width, height, pixels) {
  if (pixels.length !== width * height) {
    throw new Error(`encoder expected ${width * height} pixels, received ${pixels.length}`)
  }
  const stride = width + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    pixels.copy(raw, y * stride + 1, y * width, y * width + width)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 0
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
