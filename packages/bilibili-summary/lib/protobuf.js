/**
 * Minimal protobuf wire reader for the subtitle service.
 *
 * `/x/v2/subtitle/web/view` answers with `application/octet-stream`, not JSON.
 * Rather than vendor a generated schema and a protobuf runtime, this walks the
 * wire format generically and picks out the messages that carry a
 * `subtitle_url` string next to `lan`, `lan_doc`, and an id. That survives
 * Bilibili adding fields, which a hard-coded schema would not.
 *
 * @module dsh-bilibili-summary/protobuf
 */

/** Longest message nesting the reader follows before giving up. */
const MAX_DEPTH = 6

/**
 * Read one base-128 varint.
 * @param bytes - enclosing buffer.
 * @param offset - first byte index.
 * @returns the value and the next offset, or undefined when truncated.
 */
function readVarint(bytes, offset) {
  let value = 0
  let shift = 0
  let index = offset
  while (index < bytes.length) {
    const byte = bytes[index]
    index += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, offset: index }
    shift += 7
    if (shift > 63) return undefined
  }
  return undefined
}

/**
 * Decode a payload as printable UTF-8 text.
 * @param bytes - candidate bytes.
 * @returns the text, or undefined when the payload is binary.
 */
function decodeText(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  return /[\u0000-\u0008\u000b-\u001f]/.test(text) ? undefined : text
}

/**
 * Split one message into its fields.
 * @param bytes - message bytes.
 * @returns the parsed fields, in wire order.
 */
function readFields(bytes) {
  const fields = []
  let offset = 0
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset)
    if (!tag) break
    offset = tag.offset
    const field = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (field === 0) break
    if (wire === 0) {
      const value = readVarint(bytes, offset)
      if (!value) break
      offset = value.offset
      fields.push({ field, wire, value: value.value })
    } else if (wire === 2) {
      const length = readVarint(bytes, offset)
      if (!length) break
      offset = length.offset
      fields.push({ field, wire, value: bytes.subarray(offset, offset + length.value) })
      offset += length.value
    } else if (wire === 5) {
      fields.push({ field, wire, value: bytes.subarray(offset, offset + 4) })
      offset += 4
    } else if (wire === 1) {
      fields.push({ field, wire, value: bytes.subarray(offset, offset + 8) })
      offset += 8
    } else {
      break
    }
  }
  return fields
}

/** Subtitle-URL shapes the service has used. */
const URL_PATTERN = /^\/\/(subtitle\.bilibili\.com|aisubtitle\.hdslb\.com)\//

/**
 * Extract every subtitle track from a `/x/v2/subtitle/web/view` response.
 * @param input - response bytes (Buffer or Uint8Array).
 * @returns tracks with `lan`, `lan_doc`, `subtitle_url`, and numeric ids.
 */
export function parseSubtitleTracks(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const tracks = []
  const visit = (buffer, depth) => {
    if (depth > MAX_DEPTH) return
    const strings = {}
    const numbers = {}
    let url
    for (const entry of readFields(buffer)) {
      if (entry.wire === 2) {
        const text = decodeText(entry.value)
        if (text === undefined) {
          visit(entry.value, depth + 1)
          continue
        }
        strings[entry.field] = text
        if (URL_PATTERN.test(text)) url = text
      } else if (entry.wire === 0) {
        numbers[entry.field] = entry.value
      }
    }
    if (url) {
      tracks.push({
        id: numbers[1],
        id_str: strings[2],
        lan: strings[3] ?? strings[8] ?? '',
        lan_doc: strings[4] ?? strings[8] ?? '',
        subtitle_url: url,
        role: numbers[6],
        type: numbers[7],
        ai_type: numbers[10],
      })
    }
  }
  visit(bytes, 0)
  return tracks
}
