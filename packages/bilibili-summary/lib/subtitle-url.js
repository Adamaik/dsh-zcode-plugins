/**
 * Subtitle URL reconstruction.
 *
 * The subtitle service hands back paths under `subtitle.bilibili.com` that are
 * not directly fetchable: the web player XOR-decodes the path and rewrites the
 * host to `aisubtitle.hdslb.com`, keeping the time-limited `auth_key` query.
 * The two key pairs below are lifted verbatim from the player bundle
 * (`bfs/static/player/main/core.*.js`, the `F`/`U` helpers), because the
 * transform is otherwise undocumented.
 *
 * @module dsh-bilibili-summary/subtitle-url
 */

/** XOR key pairs, in the order the player tries them: [prefix, key]. */
const KEY_PAIRS = [
  ['nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`', '=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`'],
  ['Bn"q~|albg@]Go~ACgyDvKnd+)_D}^&J?', "Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"],
]

/** Host that actually serves the subtitle JSON. */
const CDN_ORIGIN = '//aisubtitle.hdslb.com'

/** Salt appended to every XOR key. */
const SALT = 'bilibili'

/**
 * XOR one string against a repeating key.
 * @param text - decoded path.
 * @param key - repeating key.
 * @returns the transformed string.
 */
function xor(text, key) {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    out += String.fromCharCode(text.charCodeAt(index) ^ key.charCodeAt(index % key.length))
  }
  return out
}

/**
 * Rewrite one subtitle URL into its fetchable form.
 * @param rawUrl - `subtitle_url` exactly as the service returned it.
 * @returns the fetchable URL, or undefined when the input is already final or unknown.
 */
export function rebuildSubtitleUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return undefined
  if (rawUrl.startsWith(CDN_ORIGIN)) return rawUrl
  const match = /\/\/subtitle\.bilibili\.com\/([^?]+)/.exec(rawUrl)
  if (!match) return undefined
  const query = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : ''
  let path
  try {
    path = decodeURIComponent(match[1])
  } catch {
    return undefined
  }
  for (const [prefix, key] of KEY_PAIRS) {
    const decoded = xor(path, `${key}${SALT}`)
    if (decoded.startsWith(prefix)) {
      return `${CDN_ORIGIN}${decoded.slice(prefix.length)}?${query}`
    }
  }
  return undefined
}
