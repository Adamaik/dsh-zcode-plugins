/**
 * Model-facing tools.
 *
 * Definitions are plain JSON-Schema declarations, so the package imports
 * nothing from the harness runtime. Four tools cover the workflow:
 * `bilibili_login` (QR sign-in), `bilibili_video_info` (metadata and
 * Bilibili's own AI summary), `bilibili_subtitles` (the real track), and
 * `bilibili_transcribe` (local ASR for videos that have no track at all).
 *
 * @module dsh-bilibili-summary/tools
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { clearCookieFile, cookieHeader, dshHome, loadCredentials } from './cookies.js'
import {
  assessSegments,
  fetchAccount,
  fetchAiConclusion,
  fetchAudioStream,
  fetchCollectionVideos,
  fetchHotComments,
  fetchSubtitleBody,
  fetchSubtitleTracks,
  fetchUserCollections,
  fetchUserVideos,
  fetchVideoInfo,
  pickCompanionTrack,
  pickTrack,
  resolveBvid,
  selectPage,
} from './api.js'
import { downloadAudio, resolveFfmpeg } from './audio.js'
import { defaultModelDir, defaultVenvDir, ensureAsrPython, transcribeAudio } from './asr.js'
import { pollQrLogin, startQrLogin } from './login.js'
import {
  buildTranscriptMarkdown,
  extensionFor,
  formatDuration,
  groupSegments,
  mergeBilingual,
  momentUrl,
  toAss,
  toLrc,
  toPlainText,
  toSrt,
} from './transcript.js'
import { assessMatch } from './validate.js'

/** Default number of subtitle attempts before giving up. */
const DEFAULT_RETRIES = 6

/** Default first backoff in milliseconds. */
const DEFAULT_RETRY_BASE_MS = 8000

/** Extra backoff added per attempt. */
const RETRY_STEP_MS = 3000

/** Fewest segments a usable transcript must have. */
const MIN_SEGMENTS = 20

/** Default fraction of the video a transcript must cover. */
const DEFAULT_MIN_COVERAGE = 0.6

/** Guidance shown whenever the plugin needs a signed-in session. */
const LOGIN_HINT =
  'Bilibili hides AI subtitles from signed-out clients. Run bilibili_login with action "start", ' +
  'show the returned QR image to the user, then run action "poll" once they have scanned it.'

/** Render one canonical value as pretty JSON text. */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Render a Markdown payload as text. */
const renderMarkdown = (_args, value) => [{ type: 'text', text: typeof value?.markdown === 'string' ? value.markdown : JSON.stringify(value, null, 2) }]

/** Render a one-line status summary. */
const renderStatus = (_args, value) => [{ type: 'text', text: value?.markdown ?? JSON.stringify(value, null, 2) }]

/**
 * Build one registry-ready tool declaration.
 * @param options - name, description, parameters, renderer, and body.
 * @returns the plain tool definition the DSH tool registry accepts.
 */
function defineTool({ name, description, properties, required = [], render = renderJson, execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: { schema: {}, render },
    execute,
  }
}

/**
 * Read one optional non-empty string argument.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @returns the value, or undefined.
 */
function optionalString(args, key) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

/**
 * Read one optional integer argument.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @param fallback - value used when absent.
 * @param bounds - inclusive minimum and maximum.
 * @returns the clamped value.
 */
function optionalInteger(args, key, fallback, bounds) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return Math.min(Math.max(value, bounds[0]), bounds[1])
}

/**
 * Read one optional number argument.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @param fallback - value used when absent.
 * @returns the value.
 */
function optionalNumber(args, key, fallback) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`${key} must be a number`)
  return value
}

/**
 * Wait without ignoring cancellation.
 * @param ms - milliseconds to wait.
 * @param signal - caller cancellation.
 * @returns a promise that settles on timeout or abort.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Write a transcript payload in the requested format.
 * @param options - format, resolved path, and transcript data.
 * @returns the written path.
 */
function writeTranscript(options) {
  const { format, target, video, page, track, stats, segments, markdown } = options
  const payload =
    format === 'json'
      ? `${JSON.stringify({ video, page, track, stats, segments }, null, 2)}\n`
      : format === 'srt'
        ? toSrt(segments)
        : format === 'ass'
          ? toAss(segments)
          : format === 'lrc'
            ? toLrc(segments)
            : format === 'text'
              ? toPlainText(segments)
              : markdown
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, payload.endsWith('\n') ? payload : `${payload}\n`, 'utf8')
  return target
}
/**
 * Build the login tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function loginTool(defaults) {
  return defineTool({
    name: 'bilibili_login',
    description:
      'Sign in to Bilibili for this machine. Action "start" returns a fresh login QR image to show the ' +
      'user (Bilibili hides AI subtitles from signed-out clients); action "poll" waits for the scan and ' +
      'stores the session cookies; "status" reports the stored account; "logout" deletes the cookies.',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'poll', 'status', 'logout'],
        description: 'start: issue a QR code. poll: wait for the scan. status: report the saved account. logout: delete it.',
      },
      qrcode_key: { type: 'string', description: 'Key from a previous "start"; defaults to the last issued code.' },
      timeout_sec: { type: 'integer', description: 'Polling budget for "poll". Defaults to 150 seconds.' },
      out: { type: 'string', description: 'Where to write the QR PNG; relative paths resolve against the workspace.' },
    },
    required: ['action'],
    render: renderStatus,
    execute: async (args, exec) => {
      const action = optionalString(args, 'action') ?? 'start'
      const credentials = loadCredentials(defaults)
      if (action === 'start') {
        const out = await exec.resolvePath(optionalString(args, 'out') ?? 'bilibili-login/bilibili-qr.png')
        const started = await startQrLogin({ outPath: out, timeoutMs: defaults.timeoutMs, signal: exec.signal })
        return {
          status: 'waiting-scan',
          qrPath: started.qrPath,
          qrcodeKey: started.qrcodeKey,
          expiresInSec: started.expiresInSec,
          markdown:
            `已生成登录二维码：\`${started.qrPath}\`（约 ${started.expiresInSec} 秒内有效）。\n` +
            '请用 B站手机 App →「我的」→ 右上角「扫一扫」扫码并在手机上确认，然后调用 bilibili_login { action: "poll" }。',
        }
      }
      if (action === 'poll') {
        const key = optionalString(args, 'qrcode_key')
        const result = await pollQrLogin({
          qrcodeKey: key,
          timeoutSec: optionalInteger(args, 'timeout_sec', 150, [5, 600]),
          cookieFile: defaults.cookieFile || undefined,
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        })
        const markdown =
          result.status === 'success'
            ? `登录成功${result.user ? `：${result.user.name}（mid ${result.user.mid}）` : ''}。Cookie 已保存到 \`${result.cookieFile}\`。`
            : `登录未完成：${result.status} — ${result.message ?? ''}`
        return { ...result, markdown }
      }
      if (action === 'status') {
        if (!credentials.cookies.SESSDATA) {
          return { loggedIn: false, cookieFile: credentials.file, markdown: `未登录，且 ${credentials.file} 中没有 SESSDATA。` }
        }
        const account = await fetchAccount({
          cookie: cookieHeader(credentials.cookies),
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        })
        const markdown = account.loggedIn
          ? `已登录：${account.name}（mid ${account.mid}），凭据来自 ${credentials.source}（${credentials.file}）。`
          : `Cookie 已过期或无效（来源 ${credentials.source}，${credentials.file}）。`
        return { ...account, source: credentials.source, cookieFile: credentials.file, savedAt: credentials.savedAt, markdown }
      }
      const removed = clearCookieFile(credentials.file)
      return { removed, cookieFile: credentials.file, markdown: removed ? `已删除 ${credentials.file}。` : '没有可删除的凭据文件。' }
    },
  })
}

/**
 * Build the video-info tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function infoTool(defaults) {
  return defineTool({
    name: 'bilibili_video_info',
    description:
      'Read one Bilibili video\'s metadata (title, UP, duration, description, stats, parts), the subtitle ' +
      'tracks the platform lists for it, and Bilibili\'s own AI summary when one exists. Works signed out; ' +
      'the AI summary needs the stored sign-in. Use it to check whether a video has a subtitle track at all ' +
      'before falling back to local transcription.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video.' },
      include_ai_summary: { type: 'boolean', description: 'Fetch Bilibili\'s AI summary too. Defaults to true.' },
      include_comments: {
        type: 'boolean',
        description:
          'Fetch the comment section\'s long, well-liked comments as a fallback source. Defaults to true when the ' +
          'video has no subtitle track, false otherwise.',
      },
    },
    required: ['url'],
    render: renderStatus,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      const cookie = cookieHeader(credentials.cookies)
      const bvid = await resolveBvid(optionalString(args, 'url'), { timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const { entry, cid } = selectPage(video, optionalInteger(args, 'page', undefined, [1, 10_000]))
      const trackList = await fetchSubtitleTracks({
        bvid,
        aid: video.aid,
        cid,
        cookie,
        language: defaults.language,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
      }).catch((error) => ({ tracks: [], error: String(error.message ?? error) }))
      let aiSummary
      if (args?.include_ai_summary !== false && credentials.cookies.SESSDATA) {
        aiSummary = await fetchAiConclusion({
          bvid,
          cid,
          upMid: video.owner?.mid,
          cookie,
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        }).catch((error) => ({ available: false, error: String(error.message ?? error) }))
      }
      const tracks = trackList.tracks ?? []
      const wantComments = args?.include_comments === true || (args?.include_comments !== false && tracks.length === 0)
      const commentDigest = wantComments
        ? await fetchHotComments({
            aid: video.aid,
            cookie,
            referer: `${video.url}/`,
            timeoutMs: defaults.timeoutMs,
            signal: exec.signal,
          }).catch((error) => ({ scanned: 0, comments: [], error: String(error.message ?? error) }))
        : undefined
      const markdown = [
        `# ${video.title}`,
        '',
        `- 视频：${video.url}`,
        `- UP 主：${video.owner?.name ?? '未知'}`,
        `- 时长：${formatDuration(video.duration)}（${video.duration}s）`,
        video.pages?.length > 1 ? `- 分P：共 ${video.pages.length} 集，当前第 ${entry.page} 集（cid ${cid}）` : undefined,
        `- 字幕轨道：${tracks.length ? tracks.map((track) => `${track.lan}（${track.lan_doc}）`).join('、') : '无（需回退到本地转写）'}`,
        '',
        '## 简介',
        '',
        video.description || '（无简介）',
        '',
        aiSummary?.available
          ? `## B站 AI 总结\n\n${aiSummary.summary || '（无摘要文本）'}\n\n${(aiSummary.outline ?? [])
              .map((section) => `### ${section.title}\n\n${section.points.map((point) => `- ${point.content}`).join('\n')}`)
              .join('\n\n')}`
          : '## B站 AI 总结\n\n（该视频没有 B站 AI 总结）',
        commentDigest?.comments?.length
          ? `## 评论区长评（降级来源，共扫描 ${commentDigest.scanned} 条）\n\n${commentDigest.comments
              .map((comment) => `### ${comment.author} · ${comment.likes} 赞\n\n${comment.text}`)
              .join('\n\n')}`
          : undefined,
      ]
        .filter((line) => line !== undefined)
        .join('\n')
      return {
        video,
        page: entry,
        cid,
        signedIn: Boolean(credentials.cookies.SESSDATA),
        tracks,
        subtitleRoute: trackList.route,
        aiSummary,
        comments: commentDigest,
        markdown,
      }
    },
  })
}

/**
 * Build the subtitle tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function subtitlesTool(defaults) {
  return defineTool({
    name: 'bilibili_subtitles',
    description:
      'Extract a Bilibili video\'s AI or creator-uploaded subtitle track as a timestamped transcript, ' +
      'through the platform\'s own subtitle service. Requires the stored sign-in: Bilibili returns no ' +
      'tracks to signed-out clients. The service can answer with a truncated body under rate limiting, so ' +
      'the tool validates segment count and duration coverage and retries with growing backoff. When a ' +
      'video simply has no track, it says so plainly — call bilibili_transcribe for those.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video.' },
      lang: { type: 'string', description: 'Preferred track language, for example ai-zh or zh-CN. Defaults to ai-zh.' },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'srt', 'ass', 'lrc', 'json'],
        description: 'Payload written to "out" and returned as the transcript. Defaults to markdown.',
      },
      bilingual: {
        type: ['boolean', 'string'],
        description:
          'Also fetch a second track and merge it under each line (bilingual subtitles). Pass true to pick the ' +
          'best companion automatically, or a language code such as ai-en to name it.',
      },
      out: {
        type: 'string',
        description: 'Optional file to write the transcript to; relative paths resolve against the workspace.',
      },
      strict: {
        type: 'boolean',
        description: 'Fail instead of returning a transcript that did not pass validation. Defaults to true.',
      },
      min_coverage: { type: 'number', description: 'Fraction of the video the transcript must cover. Defaults to 0.6.' },
      retries: { type: 'integer', description: 'Attempts before giving up. Defaults to 6.' },
      min_segments: { type: 'integer', description: 'Fewest segments a valid transcript may have. Defaults to 20.' },
    },
    required: ['url'],
    render: renderMarkdown,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      if (!credentials.cookies.SESSDATA) throw new Error(`not signed in. ${LOGIN_HINT}`)
      const cookie = cookieHeader(credentials.cookies)
      const url = optionalString(args, 'url')
      const lang = optionalString(args, 'lang') ?? defaults.language
      const format = optionalString(args, 'format') ?? 'markdown'
      const strict = args?.strict !== false
      const retries = optionalInteger(args, 'retries', defaults.retries ?? DEFAULT_RETRIES, [1, 20])
      const minCoverage = optionalNumber(args, 'min_coverage', DEFAULT_MIN_COVERAGE)
      const minSegments = optionalInteger(args, 'min_segments', MIN_SEGMENTS, [1, 10_000])

      const bvid = await resolveBvid(url, { timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const { entry, cid } = selectPage(video, optionalInteger(args, 'page', undefined, [1, 10_000]))
      const duration = entry.duration || video.duration
      const attempts = []
      let accepted
      let rejected
      let sawTrack = false
      for (let attempt = 1; attempt <= retries; attempt++) {
        const listed = await fetchSubtitleTracks({
          bvid,
          aid: video.aid,
          cid,
          cookie,
          language: lang,
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        })
        const track = pickTrack(listed.tracks, lang)
        if (track) {
          sawTrack = true
          const segments = await fetchSubtitleBody({
            url: track.subtitle_url,
            timeoutMs: defaults.timeoutMs,
            signal: exec.signal,
            referer: `${video.url}/`,
          }).catch(() => [])
          const stats = assessSegments(segments, duration)
          const assessment = assessMatch({
            title: video.title,
            segments,
            duration,
            minSegments,
            minCoverage,
          })
          attempts.push({ attempt, route: listed.route, lan: track.lan, verdict: assessment.verdict, ...stats })
          const candidate = { track, tracks: listed.tracks, segments, stats, assessment, route: listed.route, attempts: attempt }
          if (assessment.accepted) {
            accepted = candidate
            break
          }
          if (!rejected || stats.count > rejected.stats.count) rejected = candidate
        } else {
          attempts.push({ attempt, route: listed.route, tracks: 0, verdict: 'no-track' })
        }
        if (attempt < retries) {
          await sleep((defaults.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS) + attempt * RETRY_STEP_MS, exec.signal)
        }
      }
      const chosen = accepted ?? (strict ? undefined : rejected)
      if (!chosen) {
        const detail = attempts
          .map((item) =>
            item.lan
              ? `#${item.attempt} ${item.lan} ${item.count}段/${Math.round(item.coverage * 100)}%/${item.verdict}`
              : `#${item.attempt} 无轨道`,
          )
          .join('；')
        throw new Error(
          sawTrack
            ? `subtitle tracks exist for ${video.title} but every attempt failed validation after ${retries} tries ` +
              `(${detail}). Bilibili is rate-limiting, or the returned track belongs to another video. Retry later.`
            : `${video.title}（${video.url}）没有可用的字幕轨道：B站 未给该视频生成 AI 字幕，也没有上传 CC 字幕。` +
              `尝试记录：${detail}。可回退：bilibili_video_info（看 B站 AI 总结与评论区长评），或 bilibili_transcribe（下载音频 + 本地 ASR）。`,
        )
      }

      const stats = { ...chosen.stats, validated: Boolean(accepted), assessment: chosen.assessment }
      const track = {
        lan: chosen.track.lan,
        lan_doc: chosen.track.lan_doc,
        ai: String(chosen.track.lan).startsWith('ai'),
        route: chosen.route,
      }
      let segments = chosen.segments
      let secondary
      const bilingual = args?.bilingual
      if (bilingual) {
        const companion = pickCompanionTrack(chosen.tracks ?? [], chosen.track, typeof bilingual === 'string' ? bilingual : undefined)
        if (companion) {
          const companionSegments = await fetchSubtitleBody({
            url: companion.subtitle_url,
            timeoutMs: defaults.timeoutMs,
            signal: exec.signal,
            referer: `${video.url}/`,
          }).catch(() => [])
          if (companionSegments.length > 0) {
            segments = mergeBilingual(chosen.segments, companionSegments)
            secondary = { lan: companion.lan, lan_doc: companion.lan_doc, segments: companionSegments.length }
          }
        }
      }
      const built = buildTranscriptMarkdown({ video, page: entry.page, track: chosen.track, segments, stats })
      let file
      const out = optionalString(args, 'out')
      if (out) {
        file = writeTranscript({
          format,
          target: await exec.resolvePath(out),
          video,
          page: entry,
          track,
          stats,
          segments,
          markdown: built.markdown,
        })
      }
      return {
        video: { bvid: video.bvid, title: video.title, owner: video.owner, duration: video.duration, url: video.url, description: video.description },
        page: entry,
        track,
        secondary,
        stats: { ...stats, attempts: chosen.attempts, attemptLog: attempts },
        timeline: groupSegments(segments).map((block) => ({ ...block, url: momentUrl(video.bvid, block.from, entry.page) })),
        transcript: toPlainText(segments),
        segments,
        file,
        markdown: built.markdown,
        warning: accepted
          ? chosen.assessment.verdict === 'weak'
            ? `validation is weak (${chosen.assessment.reasons.join('；') || 'no title keyword hit'}); verify before quoting`
            : undefined
          : 'transcript did not pass validation; treat it as unverified',
      }
    },
  })
}

/**
 * Build the local-transcription fallback tool.
 *
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function transcribeTool(defaults) {
  return defineTool({
    name: 'bilibili_transcribe',
    description:
      'Fallback for a Bilibili video that has no subtitle track: download the audio and transcribe it ' +
      'locally with faster-whisper. The first run builds a private virtualenv and downloads the model, so ' +
      'it is slow; later runs only pay the transcription cost. Returns the same transcript shape as ' +
      'bilibili_subtitles, marked as machine transcription.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video.' },
      language: { type: 'string', description: 'Spoken language, for example zh or en. Defaults to auto-detect.' },
      model: { type: 'string', description: 'faster-whisper model size. Defaults to small.' },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'srt', 'json'],
        description: 'Payload written to "out". Defaults to markdown.',
      },
      out: { type: 'string', description: 'Optional file to write the transcript to.' },
      keep_audio: { type: 'boolean', description: 'Keep the extracted WAV after transcription. Defaults to false.' },
    },
    required: ['url'],
    render: renderMarkdown,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      const cookie = cookieHeader(credentials.cookies)
      const format = optionalString(args, 'format') ?? 'markdown'
      const bvid = await resolveBvid(optionalString(args, 'url'), { timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const { entry, cid } = selectPage(video, optionalInteger(args, 'page', undefined, [1, 10_000]))
      const stream = await fetchAudioStream({
        bvid,
        aid: video.aid,
        cid,
        cookie,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
      })
      const wavPath = join(dshHome(), 'bilibili-asr', 'audio', `${bvid}-${cid}.wav`)
      let downloaded
      try {
        const audioAttempts = []
        for (const candidate of stream.candidates ?? [stream]) {
          try {
            downloaded = await downloadAudio({
              url: candidate.url,
              referer: `${video.url}/`,
              outPath: wavPath,
              ffmpegPath: resolveFfmpeg(defaults.ffmpegPath),
              timeoutMs: 20 * 60 * 1000,
              signal: exec.signal,
            })
            audioAttempts.push({ codec: candidate.codec, bandwidth: candidate.bandwidth, ok: true })
            break
          } catch (error) {
            audioAttempts.push({ codec: candidate.codec, bandwidth: candidate.bandwidth, ok: false, error: String(error.message ?? error).slice(0, 160) })
          }
        }
        if (!downloaded) {
          throw new Error(`every audio candidate failed: ${JSON.stringify(audioAttempts)}`)
        }
        const runtime = await ensureAsrPython({
          python: defaults.asrPython,
          venvDir: defaults.asrVenv || defaultVenvDir(),
          signal: exec.signal,
        })
        const asr = await transcribeAudio({
          python: runtime.python,
          audioPath: wavPath,
          model: optionalString(args, 'model') ?? defaults.asrModel ?? 'small',
          modelDir: defaults.asrModelDir || defaultModelDir(),
          language: optionalString(args, 'language') ?? defaults.asrLanguage ?? 'auto',
          signal: exec.signal,
        })
        const stats = assessSegments(asr.segments, entry.duration || video.duration)
        const track = { lan: `asr-${asr.language ?? 'auto'}`, lan_doc: `本地 ASR 转写（${asr.language ?? 'auto'}，${runtime.source}）` }
        const built = buildTranscriptMarkdown({ video, page: entry.page, track, segments: asr.segments, stats })
        let file
        const out = optionalString(args, 'out')
        if (out) {
          file = writeTranscript({
            format,
            target: await exec.resolvePath(out),
            video,
            page: entry,
            track,
            stats,
            segments: asr.segments,
            markdown: built.markdown,
          })
        }
        return {
          video: { bvid: video.bvid, title: video.title, owner: video.owner, duration: video.duration, url: video.url, description: video.description },
          page: entry,
          track,
          source: 'asr',
          asr: {
            model: optionalString(args, 'model') ?? defaults.asrModel ?? 'small',
            language: asr.language,
            probability: asr.probability,
            runtime: runtime.source,
            python: runtime.python,
            audio: { codec: stream.codec, bytes: downloaded.bytes },
          },
          stats,
          timeline: groupSegments(asr.segments).map((block) => ({ ...block, url: momentUrl(video.bvid, block.from, entry.page) })),
          transcript: toPlainText(asr.segments),
          segments: asr.segments,
          file,
          markdown: built.markdown,
          warning: 'machine transcription; expect homophone errors and no punctuation',
        }
      } finally {
        if (args?.keep_audio !== true) {
          rmSync(wavPath, { force: true })
          rmSync(`${wavPath}.json`, { force: true })
        }
      }
    },
  })
}

/**
 * Drop `undefined` members so the result survives the registry's lossless JSON check.
 * @param value - tool result.
 * @returns the same shape without undefined entries.
 */
function toLossless(value) {
  if (Array.isArray(value)) return value.map(toLossless)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = toLossless(entry)
    }
    return out
  }
  return value
}

/**
 * Build the listing tool used to plan batch work.
 *
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function seriesTool(defaults) {
  return defineTool({
    name: 'bilibili_series',
    description:
      'List the videos that belong together on Bilibili: one UP\'s recent uploads, their collections ' +
      '(合集/系列), or the videos inside one collection. Use it to plan batch work — summarize several videos ' +
      'in a row — when the user asks about a channel, a series, or "all of these".',
    properties: {
      url: {
        type: 'string',
        description: 'A space URL (space.bilibili.com/<mid>), any video URL (its UP is used), or a bare mid.',
      },
      kind: {
        type: 'string',
        enum: ['uploads', 'collections', 'videos'],
        description: 'uploads: recent videos of the UP. collections: their 合集/系列 directory. videos: members of one collection.',
      },
      collection_id: { type: 'string', description: 'Collection id, required for kind "videos".' },
      collection_kind: {
        type: 'string',
        enum: ['season', 'series'],
        description: 'Which directory the collection id came from. Defaults to season (合集).',
      },
      limit: { type: 'integer', description: 'Maximum entries to return. Defaults to 30.' },
    },
    required: ['url'],
    render: renderStatus,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      const cookie = cookieHeader(credentials.cookies)
      const kind = optionalString(args, 'kind') ?? 'uploads'
      const limit = optionalInteger(args, 'limit', 30, [1, 50])
      const raw = optionalString(args, 'url')
      const spaceMatch = /space\.bilibili\.com\/(\d+)/.exec(raw)
      let mid = spaceMatch?.[1]
      if (!mid && /^\d+$/.test(raw.trim())) mid = raw.trim()
      if (!mid) {
        const bvid = await resolveBvid(raw, { timeoutMs: defaults.timeoutMs, signal: exec.signal })
        const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
        mid = String(video.owner?.mid ?? '')
      }
      if (!mid) throw new Error(`could not determine the UP mid from "${raw}"`)
      const common = { mid, cookie, limit, timeoutMs: defaults.timeoutMs, signal: exec.signal }
      if (kind === 'uploads') {
        const listed = await fetchUserVideos(common)
        const markdown = [`# UP ${mid} 的最近投稿（共 ${listed.total} 条）`, '', ...listed.videos.map((video, index) => `${index + 1}. [${video.title}](${video.url}) · ${formatDuration(video.duration)}`)].join('\n')
        return { kind, mid, total: listed.total, videos: listed.videos, markdown }
      }
      if (kind === 'collections') {
        const listed = await fetchUserCollections(common)
        const markdown = [`# UP ${mid} 的合集/系列`, '', ...listed.collections.map((item) => `- [${item.kind}] ${item.title} · ${item.count} 个视频 · id=${item.id}`)].join('\n')
        return { kind, mid, collections: listed.collections, markdown }
      }
      const id = optionalString(args, 'collection_id')
      if (!id) throw new Error('collection_id is required when kind is "videos"')
      const listed = await fetchCollectionVideos({
        ...common,
        id,
        kind: optionalString(args, 'collection_kind') ?? 'season',
      })
      const markdown = [`# 合集 ${id} 的视频`, '', ...listed.videos.map((video, index) => `${index + 1}. [${video.title}](${video.url}) · ${formatDuration(video.duration)}`)].join('\n')
      return { kind, mid, collectionId: id, videos: listed.videos, markdown }
    },
  })
}

/**
 * Build every tool this plugin registers.
 * @param options - harness path resolution and resolved configuration.
 * @returns registry-ready tool declarations.
 */
export function createBilibiliTools(options) {
  const defaults = options.defaults ?? {}
  const tools = [
    loginTool(defaults),
    infoTool(defaults),
    subtitlesTool(defaults),
    transcribeTool(defaults),
    seriesTool(defaults),
  ]
  return tools.map((tool) => ({
    ...tool,
    execute: async (args, exec) =>
      toLossless(await tool.execute(args, { ...exec, resolvePath: (target) => options.resolvePath(target, exec) })),
  }))
}

/**
 * Default output path for a transcript.
 * @param bvid - video id.
 * @param format - transcript format.
 * @returns a workspace-relative path.
 */
export function defaultTranscriptPath(bvid, format = 'markdown') {
  return join('bilibili', bvid, `transcript${extensionFor(format)}`)
}
