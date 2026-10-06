#!/usr/bin/env node
/**
 * Network-free unit checks for dsh-bilibili-summary.
 *
 * Covers the pure parts that are easy to get quietly wrong: WBI signing, BV
 * reference extraction, subtitle track preference, duration-coverage
 * validation, block merging, SRT output, PNG/QR rendering, protobuf subtitle
 * parsing, and the subtitle-URL rewrite (the XOR keys are transcribed from the
 * player bundle, so a single wrong character silently breaks every track).
 *
 * It never talks to Bilibili, so it is safe to run in CI.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const failures = []
let passed = 0

/** Assert one condition. */
function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`ok   ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const pkg = `${ROOT}/packages/bilibili-summary`
const wbi = await import(`${pkg}/lib/wbi.js`)
const api = await import(`${pkg}/lib/api.js`)
const transcript = await import(`${pkg}/lib/transcript.js`)
const qr = await import(`${pkg}/lib/qr.js`)
const cookies = await import(`${pkg}/lib/cookies.js`)
const png = await import(`${pkg}/lib/png.js`)
const protobuf = await import(`${pkg}/lib/protobuf.js`)
const subtitleUrl = await import(`${pkg}/lib/subtitle-url.js`)
const validate = await import(`${pkg}/lib/validate.js`)

// --- WBI signing -----------------------------------------------------------
check(
  'mixinKey is 32 chars',
  wbi.mixinKey(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  ).length === 32,
)
const signed = new URLSearchParams(wbi.signQuery({ bvid: 'BV1puH46qE5x', cid: 123 }, '0123456789abcdef0123456789abcdef', 1_700_000_000_000))
check('signQuery adds wts', signed.get('wts') === '1700000000')
check('signQuery adds a 32-char w_rid', /^[0-9a-f]{32}$/.test(signed.get('w_rid') ?? ''))
const expected = createHash('md5')
  .update(`bvid=BV1puH46qE5x&cid=123&wts=1700000000` + '0123456789abcdef0123456789abcdef')
  .digest('hex')
check('w_rid matches the documented digest', signed.get('w_rid') === expected, `${signed.get('w_rid')} vs ${expected}`)

// --- Reference extraction --------------------------------------------------
check('extracts BV from a full URL', api.extractVideoRef('https://www.bilibili.com/video/BV1puH46qE5x/?spm=x').value === 'BV1puH46qE5x')
check('extracts BV from bare text', api.extractVideoRef('BV1puH46qE5x').value === 'BV1puH46qE5x')
check('extracts av id', api.extractVideoRef('https://www.bilibili.com/video/av170001').kind === 'aid')
check('rejects non-video text', (() => {
  try {
    api.extractVideoRef('hello world')
    return false
  } catch {
    return true
  }
})())

// --- Track preference ------------------------------------------------------
const tracks = [
  { lan: 'ai-en', lan_doc: 'English', subtitle_url: '//x/en.json' },
  { lan: 'ai-zh', lan_doc: '中文', subtitle_url: '//x/zh.json' },
  { lan: 'zh-CN', lan_doc: '中文（中国）', subtitle_url: '//x/zhcn.json' },
]
check('prefers the requested language', api.pickTrack(tracks, 'zh-CN')?.lan === 'zh-CN')
check('defaults to ai-zh', api.pickTrack(tracks, 'ai-zh')?.lan === 'ai-zh')
check('falls back to ai-en for an unknown request', api.pickTrack(tracks.slice(0, 1), 'ai-zh')?.lan === 'ai-en')
check('skips empty subtitle_url', api.pickTrack([{ lan: 'ai-zh', subtitle_url: '' }], 'ai-zh') === undefined)

// --- Coverage validation ---------------------------------------------------
const segments = [
  { from: 0, to: 10, text: 'a' },
  { from: 600, to: 610, text: 'b' },
]
const stats = api.assessSegments(segments, 1000)
check('coverage uses the last segment end', stats.count === 2 && stats.coverage === 0.61, JSON.stringify(stats))
check('zero duration yields zero coverage', api.assessSegments(segments, 0).coverage === 0)

// --- Transcript shaping ----------------------------------------------------
const long = Array.from({ length: 40 }, (_, index) => ({ from: index * 2, to: index * 2 + 2, text: `句子${index}` }))
const blocks = transcript.groupSegments(long, { targetSeconds: 20, maxChars: 40 })
check('groupSegments merges short lines', blocks.length < long.length && blocks.length > 1, `${blocks.length} blocks`)
check('groupSegments keeps bounds ordered', blocks.every((block) => block.from < block.to))
check('groupSegments never drops text', blocks.map((b) => b.text).join('') === long.map((s) => s.text).join(''))
check('formatClock pads', transcript.formatClock(65) === '01:05' && transcript.formatClock(3661) === '1:01:01')
check('momentUrl deep-links the part', transcript.momentUrl('BV1puH46qE5x', 65, 2) === 'https://www.bilibili.com/video/BV1puH46qE5x?t=65&p=2')
const srt = transcript.toSrt([{ from: 0.5, to: 2.25, text: '你好' }])
check('toSrt emits a valid cue', srt.startsWith('1\n00:00:00,500 --> 00:00:02,250\n你好'), srt.split('\n')[1])
check('extensionFor maps formats', transcript.extensionFor('srt') === '.srt' && transcript.extensionFor('json') === '.json')

// --- PNG and QR ------------------------------------------------------------
const tiny = png.encodeGrayPng(2, 2, Buffer.from([0, 255, 255, 0]))
check('PNG signature', tiny.subarray(1, 4).toString('ascii') === 'PNG')
check('PNG has IHDR and IEND', tiny.includes(Buffer.from('IHDR')) && tiny.includes(Buffer.from('IEND')))
const code = qr.renderQrPng('https://example.com/login', { scale: 4 })
check('QR renders a square PNG', code.buffer.length > 100)
check('QR PNG type field is 0', code.buffer[25] === 0)
check('QR rejects a silly scale', (() => {
  try {
    qr.renderQrPng('x', { scale: 1 })
    return false
  } catch {
    return true
  }
})())

// --- Cookie handling -------------------------------------------------------
check('cookieHeader joins pairs', cookies.cookieHeader({ SESSDATA: 'a', bili_jct: 'b' }) === 'SESSDATA=a; bili_jct=b')
check('pickCookies drops unknown names', Object.keys(cookies.pickCookies({ SESSDATA: 'a', tracking: 'x' })).join(',') === 'SESSDATA')
check('pickCookies keeps buvid fingerprints', Boolean(cookies.pickCookies({ SESSDATA: 'a', buvid3: 'z' }).buvid3))

// --- Subtitle URL rewrite --------------------------------------------------
// Captured from the service: the path under subtitle.bilibili.com is XOR-coded.
const SAMPLE_TRACK_URL =
  '//subtitle.bilibili.com/%01%1B%5C=_%04%12%12%049f%2F%07H%08%29~%16$5%0D.%0B%0AL%03%2C%01%1A%00M:%1Ce%00%0F%1FF%03%003%1A6%17%0A%25U%14%16Q%16%2CI%16o%16G_%0EIoBOPQXW%1CFvSl_E%15%7DUPYPV%08Y%0At%13LuE%1A%11%1ARg%13Fp%1FE%0A%0FC%3BEKS%5D%5E%02HArT?auth_key=1700000000-deadbeef-0-cafe'
const rebuilt = subtitleUrl.rebuildSubtitleUrl(SAMPLE_TRACK_URL)
check(
  'rebuildSubtitleUrl decodes the captured path',
  rebuilt ===
    '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/11738234546065342456779594a5c7f29dbbd4954083b22f40680eb273?auth_key=1700000000-deadbeef-0-cafe',
  rebuilt,
)
check('rebuildSubtitleUrl passes through aisubtitle URLs', subtitleUrl.rebuildSubtitleUrl('//aisubtitle.hdslb.com/x.json') === '//aisubtitle.hdslb.com/x.json')
check('rebuildSubtitleUrl rejects unknown hosts', subtitleUrl.rebuildSubtitleUrl('https://example.com/x') === undefined)

// --- Protobuf subtitle parsing --------------------------------------------
const varint = (value) => {
  const bytes = []
  let rest = value
  do {
    const byte = rest & 0x7f
    rest = Math.floor(rest / 128)
    bytes.push(rest > 0 ? byte | 0x80 : byte)
  } while (rest > 0)
  return Buffer.from(bytes)
}
const field = (number, payload, wire = 2) => {
  const tag = Buffer.from([(number << 3) | wire])
  return wire === 2 ? Buffer.concat([tag, varint(payload.length), payload]) : Buffer.concat([tag, varint(payload)])
}
const entry = Buffer.concat([
  field(1, varint(2122002236681812480), 0),
  field(2, Buffer.from('2122002236681812480')),
  field(3, Buffer.from('ai-zh')),
  field(4, Buffer.from('中文')),
  field(5, Buffer.from(SAMPLE_TRACK_URL)),
  field(7, varint(1), 0),
])
const envelope = field(1, field(3, entry))
const parsed = protobuf.parseSubtitleTracks(envelope)
check('protobuf parse finds one track', parsed.length === 1, JSON.stringify(parsed))
check('protobuf parse reads language', parsed[0]?.lan === 'ai-zh' && parsed[0]?.lan_doc === '中文')
check('protobuf parse reads the id string', parsed[0]?.id_str === '2122002236681812480')
check('protobuf parse keeps the raw URL', parsed[0]?.subtitle_url === SAMPLE_TRACK_URL)
check('protobuf parse tolerates an empty response', protobuf.parseSubtitleTracks(Buffer.from([0x0a, 0x00])).length === 0)

// --- Extra transcript formats and bilingual merge ---------------------------
check('toLrc emits a cue', transcript.toLrc([{ from: 65.5, to: 70, text: '你好' }]).startsWith('[01:05.50]你好'))
const ass = transcript.toAss([{ from: 1, to: 2.5, text: '你好\n第二行' }])
check('toAss writes a header and an event', ass.includes('[V4+ Styles]') && ass.includes('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,你好\\N第二行'))
check('extensionFor covers ass and lrc', transcript.extensionFor('ass') === '.ass' && transcript.extensionFor('lrc') === '.lrc')
const merged = transcript.mergeBilingual(
  [{ from: 0, to: 2, text: 'hello' }, { from: 2, to: 4, text: 'world' }],
  [{ from: 0.4, to: 2.2, text: '你好' }, { from: 2.1, to: 4.1, text: '世界' }],
)
check('mergeBilingual aligns by overlap', merged[0].text === 'hello\n你好' && merged[1].text === 'world\n世界', JSON.stringify(merged))
check('mergeBilingual leaves unmatched lines alone', transcript.mergeBilingual([{ from: 10, to: 12, text: 'solo' }], [])[0].text === 'solo')
check(
  'pickCompanionTrack avoids the primary language',
  api.pickCompanionTrack(
    [{ lan: 'ai-zh', subtitle_url: '//x/zh' }, { lan: 'ai-en', subtitle_url: '//x/en' }],
    { lan: 'ai-zh' },
    undefined,
  )?.lan === 'ai-en',
)

// --- Content-vs-video validation -------------------------------------------
const longTitle = 'React 核心成员分享：在 SpaceXAI 一个月发 2000 个 PR'
const goodTranscript = Array.from({ length: 120 }, (_, index) => ({
  from: index * 10,
  to: index * 10 + 9,
  text: 'React 核心成员在 SpaceXAI 讲 PR 流程',
})).join('')
const goodSegments = Array.from({ length: 120 }, (_, index) => ({ from: index * 10, to: index * 10 + 9, text: 'React' }))
const strong = validate.assessMatch({ title: longTitle, segments: goodSegments, duration: 1200 })
check('assessMatch: keyword hit + coverage is strong', strong.verdict === 'strong', JSON.stringify(strong))
const uncovered = validate.assessMatch({ title: longTitle, segments: goodSegments.slice(0, 5), duration: 1200 })
check('assessMatch: short coverage fails', uncovered.verdict === 'fail', JSON.stringify(uncovered))
const wrongVideo = validate.assessMatch({
  title: longTitle,
  segments: Array.from({ length: 300 }, (_, index) => ({ from: index * 10, to: index * 10 + 9, text: '毫不相关' })),
  duration: 1000,
})
check('assessMatch: over-long or keyword-free transcript fails', wrongVideo.verdict === 'fail', JSON.stringify(wrongVideo))
const weak = validate.assessMatch({
  title: '《诡异的她》第一季全集·纯享',
  segments: Array.from({ length: 200 }, (_, index) => ({ from: index * 10, to: index * 10 + 9, text: '毫无关键词' })),
  duration: 2400,
})
check('assessMatch: full coverage without keywords is weak', weak.verdict === 'weak', JSON.stringify(weak))
check('titleKeywords keeps technical latin tokens', validate.titleKeywords(longTitle).latin.some((word) => /React|SpaceXAI/i.test(word)))

// --- Manifest and patch ----------------------------------------------------
const manifest = JSON.parse(readFileSync(`${pkg}/package.json`, 'utf8'))
check('package name', manifest.name === 'dsh-bilibili-summary')
check('bundle patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('qrcode-generator is a runtime dependency', Boolean(manifest.dependencies?.['qrcode-generator']))
check('python fallback ships in the tarball', manifest.files.includes('python'))
const patch = readFileSync(`${pkg}/${manifest.dsh.bundle.patch}`, 'utf8')
check('patch mounts the package', patch.includes(manifest.name))
const skill = readFileSync(`${pkg}/skills/bilibili-summary/SKILL.md`, 'utf8')
check('skill has kebab-case frontmatter', /^---\nname: bilibili-summary\n/.test(skill))

console.log(`\n${passed} check(s) passed, ${failures.length} failed`)
process.exitCode = failures.length === 0 ? 0 : 1
