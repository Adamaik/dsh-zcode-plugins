/**
 * Transcript shaping: subtitles in, readable notes out.
 *
 * Bilibili AI subtitles arrive as short, punctuation-free lines, so the raw
 * segment list is a poor summary input and an even worse HTML timeline. The
 * helpers here merge segments into blocks, attach player timestamps, and emit
 * Markdown, plain text, or SRT.
 *
 * @module dsh-bilibili-summary/transcript
 */

/** Format seconds as `mm:ss`, or `h:mm:ss` past an hour. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

/** Format seconds as a short human duration, for example `14 分 34 秒`. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes === 0) return `${rest} 秒`
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/**
 * Deep link to a moment in the video player.
 * @param bvid - video id.
 * @param seconds - start time in seconds.
 * @param page - one-based part number, omitted for single-part videos.
 * @returns the player URL.
 */
export function momentUrl(bvid, seconds, page) {
  const suffix = page && page > 1 ? `&p=${page}` : ''
  return `https://www.bilibili.com/video/${bvid}?t=${Math.max(0, Math.floor(Number(seconds) || 0))}${suffix}`
}

/**
 * Merge short subtitle lines into readable blocks.
 * @param segments - normalized `{ from, to, text }` segments.
 * @param options - target block duration and character budget.
 * @returns one entry per block, each with its own bounds and joined text.
 */
export function groupSegments(segments, options = {}) {
  const targetSeconds = options.targetSeconds ?? 35
  const maxChars = options.maxChars ?? 220
  const blocks = []
  let current
  for (const segment of segments ?? []) {
    if (!current) {
      current = { from: segment.from, to: segment.to, parts: [segment.text] }
      continue
    }
    const projectedChars = current.parts.join('').length + segment.text.length
    const projectedSeconds = segment.to - current.from
    if (projectedSeconds > targetSeconds || projectedChars > maxChars) {
      blocks.push(current)
      current = { from: segment.from, to: segment.to, parts: [segment.text] }
    } else {
      current.to = segment.to
      current.parts.push(segment.text)
    }
  }
  if (current) blocks.push(current)
  return blocks.map((block) => ({
    from: Number(block.from.toFixed(2)),
    to: Number(block.to.toFixed(2)),
    text: block.parts.join(''),
  }))
}

/**
 * Join segments into continuously readable prose.
 * @param segments - normalized segments.
 * @returns the transcript without timestamps.
 */
export function toPlainText(segments) {
  return (segments ?? []).map((segment) => segment.text).join('')
}

/**
 * Render a standard SRT file.
 * @param segments - normalized segments.
 * @returns SRT text.
 */
export function toSrt(segments) {
  const stamp = (seconds) => {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000))
    const hours = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
    const minutes = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')
    const secs = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')
    return `${hours}:${minutes}:${secs},${String(ms % 1000).padStart(3, '0')}`
  }
  return (segments ?? [])
    .map((segment, index) => `${index + 1}\n${stamp(segment.from)} --> ${stamp(segment.to)}\n${segment.text}\n`)
    .join('\n')
}

/**
 * Render an LRC file (one cue per segment).
 * @param segments - normalized segments.
 * @returns LRC text.
 */
export function toLrc(segments) {
  return (segments ?? [])
    .map((segment) => {
      const total = Math.max(0, Number(segment.from) || 0)
      const minutes = String(Math.floor(total / 60)).padStart(2, '0')
      const seconds = String(Math.floor(total % 60)).padStart(2, '0')
      const hundredths = String(Math.round((total % 1) * 100)).padStart(2, '0')
      return `[${minutes}:${seconds}.${hundredths}]${segment.text}`
    })
    .join('\n')
}

/**
 * Render a minimal ASS subtitle file.
 * @param segments - normalized segments.
 * @param options - optional style overrides.
 * @returns ASS text.
 */
export function toAss(segments, options = {}) {
  const font = options.font ?? 'Microsoft YaHei'
  const fontSize = options.fontSize ?? 48
  const stamp = (seconds) => {
    const cs = Math.max(0, Math.round((Number(seconds) || 0) * 100))
    const hours = Math.floor(cs / 360_000)
    const minutes = String(Math.floor((cs % 360_000) / 6000)).padStart(2, '0')
    const secs = String(Math.floor((cs % 6000) / 100)).padStart(2, '0')
    return `${hours}:${minutes}:${secs}.${String(cs % 100).padStart(2, '0')}`
  }
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,60,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
  const events = (segments ?? [])
    .map((segment) => `Dialogue: 0,${stamp(segment.from)},${stamp(segment.to)},Default,,0,0,0,,${String(segment.text).replace(/\n/g, '\\N')}`)
    .join('\n')
  return `${header}\n${events}\n`
}

/**
 * Merge a second track into the first, aligning by greatest time overlap.
 *
 * Mirrors what bilingual subtitle tools do: the primary language keeps its own
 * segmentation and each line gains the secondary text underneath it.
 *
 * @param primary - segments of the main language.
 * @param secondary - segments of the second language.
 * @returns primary segments with both languages in `text` and `secondary`.
 */
export function mergeBilingual(primary, secondary) {
  const other = [...(secondary ?? [])].sort((left, right) => left.from - right.from)
  const merged = []
  let cursor = 0
  for (const segment of primary ?? []) {
    while (cursor < other.length && other[cursor].to <= segment.from) cursor += 1
    const candidates = []
    for (let index = cursor; index < other.length && other[index].from < segment.to; index++) {
      const overlap = Math.min(segment.to, other[index].to) - Math.max(segment.from, other[index].from)
      if (overlap > 0) candidates.push({ overlap, text: other[index].text })
    }
    candidates.sort((left, right) => right.overlap - left.overlap)
    const secondaryText = candidates[0]?.text ?? ''
    merged.push({
      from: segment.from,
      to: segment.to,
      text: secondaryText ? `${segment.text}\n${secondaryText}` : segment.text,
      secondary: secondaryText || undefined,
    })
  }
  return merged
}

/**
 * Build the Markdown the model reads and the user keeps.
 * @param context - video, page, chosen track, segments, and coverage stats.
 * @returns a Markdown document with a timestamped script.
 */
export function buildTranscriptMarkdown(context) {
  const { video, track, segments, stats, page } = context
  const blocks = groupSegments(segments)
  const pageNote = page && page > 1 ? `（第 ${page} 集）` : ''
  const trackNote = track ? `${track.lan} · ${track.lan_doc ?? ''}`.trim() : '未知'
  const lines = [
    `# ${video.title}${pageNote}`,
    '',
    `- 视频：${video.url}${page && page > 1 ? `?p=${page}` : ''}`,
    `- UP 主：${video.owner?.name ?? '未知'}`,
    `- 时长：${formatDuration(video.duration)}（${video.duration}s）`,
    `- 字幕轨道：${trackNote}`,
    `- 字幕规模：${stats.count} 段 → ${blocks.length} 个语义块，覆盖 ${formatClock(stats.coveredSeconds)} / ${formatClock(video.duration)}（${Math.round(stats.coverage * 100)}%）`,
    '',
    '## 时间轴文稿',
    '',
  ]
  for (const block of blocks) {
    lines.push(`- [${formatClock(block.from)}](${momentUrl(video.bvid, block.from, page)}) ${block.text}`)
  }
  return { markdown: lines.join('\n'), blocks }
}

/**
 * Pick the file extension for a requested transcript format.
 * @param format - one of `markdown`, `text`, `srt`, `json`.
 * @returns the extension including the dot.
 */
export function extensionFor(format) {
  switch (format) {
    case 'json':
      return '.json'
    case 'srt':
      return '.srt'
    case 'ass':
      return '.ass'
    case 'lrc':
      return '.lrc'
    case 'text':
      return '.txt'
    default:
      return '.md'
  }
}
