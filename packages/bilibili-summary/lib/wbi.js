/**
 * Bilibili WBI request signing.
 *
 * Some `api.bilibili.com` routes reject unsigned requests. The scheme is
 * documented by the community: fetch the two key images from `nav`, interleave
 * their file names through a fixed permutation to obtain a 32-byte mixin key,
 * then append `wts` and `w_rid` to the sorted query.
 *
 * @module dsh-bilibili-summary/wbi
 */

import { createHash } from 'node:crypto'

/** Fixed permutation applied to the concatenated key file names. */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

/**
 * Extract the file-name stem of one WBI key image URL.
 * @param url - `img_url` or `sub_url` from the `nav` response.
 * @returns the stem, or an empty string when the URL is unusable.
 */
function keyStem(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  const name = url.slice(url.lastIndexOf('/') + 1)
  const dot = name.indexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}

/**
 * Derive the WBI mixin key from the two `nav` key URLs.
 * @param imgUrl - `wbi_img.img_url`.
 * @param subUrl - `wbi_img.sub_url`.
 * @returns the 32-character mixin key.
 */
export function mixinKey(imgUrl, subUrl) {
  const source = keyStem(imgUrl) + keyStem(subUrl)
  if (source.length < 64) throw new Error('nav response did not contain usable wbi keys')
  return MIXIN_KEY_ENC_TAB.map((index) => source[index]).join('').slice(0, 32)
}

/**
 * Remove the characters Bilibili excludes before signing.
 * @param value - raw parameter value.
 * @returns the filtered string.
 */
function filterValue(value) {
  return String(value).replace(/[!'()*]/g, '')
}

/**
 * Sign a parameter set and return the encoded query string.
 * @param params - plain parameter values.
 * @param key - mixin key from {@link mixinKey}.
 * @param now - epoch milliseconds used as `wts`; injectable for tests.
 * @returns the URL-encoded query string including `wts` and `w_rid`.
 */
export function signQuery(params, key, now = Date.now()) {
  const signed = { ...params, wts: Math.floor(now / 1000) }
  const filtered = Object.fromEntries(Object.entries(signed).map(([name, value]) => [name, filterValue(value)]))
  const query = new URLSearchParams(Object.entries(filtered).sort(([a], [b]) => (a < b ? -1 : 1))).toString()
  const wRid = createHash('md5').update(query + key).digest('hex')
  const final = new URLSearchParams(Object.entries({ ...filtered, w_rid: wRid }).sort(([a], [b]) => (a < b ? -1 : 1)))
  return final.toString()
}
