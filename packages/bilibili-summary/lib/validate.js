/**
 * Content-vs-video validation.
 *
 * Coverage alone cannot tell a real transcript from a plausible-looking one:
 * the legacy subtitle route was observed returning a complete, correctly sized
 * transcript of a completely different video. Borrowing the field-tested shape
 * from similar tools, this scores three signals — title keyword overlap,
 * duration coverage, and duration sanity — and returns `strong`, `weak`, or
 * `fail`. Callers accept the first two and refuse `fail`.
 *
 * @module dsh-bilibili-summary/validate
 */

/** Latin words too generic to prove anything. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your', 'how', 'why', 'what', 'when',
  'video', 'bilibili', 'new', 'best', 'top', 'full', 'part', 'episode',
])

/**
 * Pull comparable keywords out of a video title.
 *
 * CJK fragments are the strongest signal for Chinese titles; Latin tokens
 * catch titles that name a technology (for example `implement-spec`).
 *
 * @param title - video title.
 * @returns CJK fragments and Latin tokens, deduplicated.
 */
export function titleKeywords(title) {
  const text = String(title ?? '')
  const cjk = [...new Set(text.match(/[\u4e00-\u9fff]{2,4}/g) ?? [])]
  const latin = [
    ...new Set(
      (text.match(/[A-Za-z][A-Za-z0-9+#._-]{2,}/g) ?? []).filter((word) => !STOPWORDS.has(word.toLowerCase())),
    ),
  ]
  return { cjk: cjk.slice(0, 24), latin: latin.slice(0, 24) }
}

/**
 * Count how many title keywords appear in a transcript.
 * @param title - video title.
 * @param transcript - joined transcript text.
 * @returns the matched keywords and the hit count.
 */
export function keywordHits(title, transcript) {
  const haystack = String(transcript ?? '')
  const { cjk, latin } = titleKeywords(title)
  const matched = []
  for (const fragment of cjk) if (haystack.includes(fragment)) matched.push(fragment)
  const lower = haystack.toLowerCase()
  for (const word of latin) if (lower.includes(word.toLowerCase())) matched.push(word)
  return { matched, count: matched.length }
}

/**
 * Score a transcript against its video.
 * @param options - title, segments, duration, and thresholds.
 * @returns the verdict, the measurements, and a human-readable reason list.
 */
export function assessMatch(options) {
  const { title, segments, duration } = options
  const minSegments = options.minSegments ?? 20
  const minCoverage = options.minCoverage ?? 0.5
  const count = segments?.length ?? 0
  const covered = count > 0 ? segments[count - 1].to : 0
  const seconds = Number(duration) > 0 ? Number(duration) : 0
  const coverage = seconds > 0 ? covered / seconds : 0
  const transcript = (segments ?? []).map((segment) => segment.text).join('')
  const { matched, count: hits } = keywordHits(title, transcript)
  const reasons = []

  if (count < minSegments) reasons.push(`只有 ${count} 段`)
  if (coverage > 2) reasons.push(`覆盖时长是视频的 ${Math.round(coverage * 100)}%，超出合理范围`)
  if (hits === 0) reasons.push('标题关键词零命中')

  let verdict
  if (count < minSegments || coverage < minCoverage || coverage > 2) verdict = 'fail'
  else if (hits > 0 && coverage >= minCoverage) verdict = 'strong'
  else if (coverage >= 0.7 && count >= Math.max(minSegments, 100)) verdict = 'weak'
  else verdict = 'fail'

  if (verdict === 'strong') reasons.length = 0
  if (verdict === 'weak' && hits === 0) reasons.push('无关键词命中，但覆盖率充足，按弱证据接受')

  return {
    verdict,
    accepted: verdict !== 'fail',
    count,
    coveredSeconds: Number(covered.toFixed(2)),
    coverage: Number(coverage.toFixed(3)),
    keywordHits: hits,
    matchedKeywords: matched,
    reasons,
  }
}
