/**
 * Bilibili web API client.
 *
 * The subtitle chain is the important part, and it is not the legacy
 * `player/v2` route: that field still answers, but under load it returns an
 * unrelated or truncated body. The real source is
 * `/x/v2/subtitle/web/view`, which answers in protobuf, plus the URL rewrite in
 * {@link ./subtitle-url.js} that turns each track path into a fetchable
 * `aisubtitle.hdslb.com` URL. {@link assessSegments} still guards the result,
 * because the service can return a short body under rate limiting.
 *
 * @module dsh-bilibili-summary/api
 */

import { BilibiliError, fetchBilibiliJson, fetchBytes, fetchJson } from './http.js'
import { mixinKey, signQuery } from './wbi.js'
import { parseSubtitleTracks } from './protobuf.js'
import { rebuildSubtitleUrl } from './subtitle-url.js'

/** Video metadata endpoint. */
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'

/** Signed-in account endpoint, also the source of the WBI keys. */
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav'

/** Subtitle track service (protobuf). */
const SUBTITLE_VIEW_API = 'https://api.bilibili.com/x/v2/subtitle/web/view'

/** DASH play info, used for the audio fallback. */
const PLAYURL_API = 'https://api.bilibili.com/x/player/wbi/playurl'

/** AI conclusion endpoint ("视频总结"). */
const CONCLUSION_API = 'https://api.bilibili.com/x/web-interface/view/conclusion/get'

/** Comment section, sorted by likes. */
const REPLY_API = 'https://api.bilibili.com/x/v2/reply'

/** UP uploads listing (WBI-signed). */
const SPACE_ARC_API = 'https://api.bilibili.com/x/space/wbi/arc/search'

/** UP collection directory. */
const SEASON_LIST_API = 'https://api.bilibili.com/x/polymer/web-space/seasons_series_list'

/** Cached WBI mixin key for the current process. */
let wbiCache

/**
 * Pull a video reference out of free text.
 * @param input - a BV id, an `av` id, or any Bilibili URL.
 * @returns the reference kind and value.
 */
export function extractVideoRef(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('a Bilibili video URL or BV id is required')
  }
  const text = input.trim()
  const bv = /BV[0-9A-Za-z]{10}/.exec(text)
  if (bv) return { kind: 'bvid', value: bv[0] }
  const av = /av(\d{1,20})/i.exec(text)
  if (av) return { kind: 'aid', value: av[1] }
  if (/^https?:\/\//i.test(text)) return { kind: 'url', value: text }
  throw new Error(`no BV id found in "${text}"`)
}

/**
 * Resolve any accepted reference to a BV id, following short links.
 * @param input - user-supplied reference.
 * @param options - timeout and cancellation.
 * @returns a BV id.
 */
export async function resolveBvid(input, options = {}) {
  const ref = extractVideoRef(input)
  if (ref.kind === 'bvid') return ref.value
  if (ref.kind === 'aid') {
    const payload = await fetchBilibiliJson(`${VIEW_API}?aid=${ref.value}`, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
    return payload.data.bvid
  }
  if (/b23\.tv|bilibili\.com/i.test(ref.value) === false) {
    throw new Error(`unsupported link: ${ref.value}`)
  }
  const response = await fetch(ref.value, { redirect: 'follow', signal: options.signal }).catch(() => undefined)
  const fromUrl = response ? /BV[0-9A-Za-z]{10}/.exec(response.url) : null
  if (fromUrl) return fromUrl[0]
  const body = response ? await response.text().catch(() => '') : ''
  const fromBody = /BV[0-9A-Za-z]{10}/.exec(body)
  if (fromBody) return fromBody[0]
  throw new Error(`could not resolve a BV id from ${ref.value}`)
}

/**
 * Fetch and normalize one video's metadata.
 * @param options - BV id plus request options.
 * @returns the normalized video record.
 */
export async function fetchVideoInfo(options) {
  const payload = await fetchBilibiliJson(`${VIEW_API}?bvid=${encodeURIComponent(options.bvid)}`, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: `https://www.bilibili.com/video/${options.bvid}/`,
    cookie: options.cookie,
  })
  const data = payload.data
  return {
    bvid: data.bvid,
    aid: data.aid,
    cid: data.cid,
    title: data.title,
    description: data.desc ?? '',
    cover: data.pic,
    duration: data.duration,
    pubdate: data.pubdate,
    owner: { mid: data.owner?.mid, name: data.owner?.name, face: data.owner?.face },
    stats: {
      view: data.stat?.view,
      danmaku: data.stat?.danmaku,
      reply: data.stat?.reply,
      like: data.stat?.like,
      coin: data.stat?.coin,
      favorite: data.stat?.favorite,
      share: data.stat?.share,
    },
    pages: (data.pages ?? []).map((page) => ({
      cid: page.cid,
      page: page.page,
      part: page.part,
      duration: page.duration,
    })),
    url: `https://www.bilibili.com/video/${data.bvid}`,
  }
}

/**
 * Select the `cid` for a requested part.
 * @param video - normalized video record.
 * @param page - one-based part number, when given.
 * @returns the page entry and its `cid`.
 */
export function selectPage(video, page) {
  const pages = video.pages?.length ? video.pages : [{ cid: video.cid, page: 1, part: video.title, duration: video.duration }]
  if (page === undefined || page === null) return { entry: pages[0], cid: pages[0].cid }
  const entry = pages.find((item) => item.page === page)
  if (!entry) throw new Error(`page ${page} does not exist; this video has ${pages.length} part(s)`)
  return { entry, cid: entry.cid }
}

/**
 * Read the signed-in account, if any.
 * @param options - cookie and request options.
 * @returns the account summary, or a signed-out marker.
 */
export async function fetchAccount(options = {}) {
  const payload = await fetchBilibiliJson(NAV_API, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  const data = payload.data ?? {}
  if (!data.isLogin) return { loggedIn: false }
  if (data.wbi_img?.img_url && data.wbi_img?.sub_url) {
    wbiCache = {
      key: mixinKey(data.wbi_img.img_url, data.wbi_img.sub_url),
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    }
  }
  return {
    loggedIn: true,
    mid: data.mid,
    name: data.uname,
    face: data.face,
    vip: Boolean(data.vipStatus),
    wbiKey: wbiCache?.key,
  }
}

/**
 * Resolve the WBI mixin key, caching it for the process.
 * @param options - cookie and request options.
 * @returns the mixin key.
 */
async function resolveWbiKey(options) {
  if (wbiCache && wbiCache.expiresAt > Date.now()) return wbiCache.key
  const payload = await fetchBilibiliJson(NAV_API, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  const keys = payload.data?.wbi_img
  const key = mixinKey(keys?.img_url, keys?.sub_url)
  wbiCache = { key, expiresAt: Date.now() + 6 * 60 * 60 * 1000 }
  return key
}

/**
 * Pick the most useful subtitle track.
 *
 * Preference order: the configured language, `ai-zh`/`zh*`, `ai-en`/`en*`,
 * then whatever the video offers.
 *
 * @param tracks - parsed subtitle tracks.
 * @param preferred - configured language code.
 * @returns the chosen track, or undefined when the list is empty.
 */
export function pickTrack(tracks, preferred) {
  const usable = (tracks ?? []).filter((track) => typeof track?.subtitle_url === 'string' && track.subtitle_url.length > 0)
  if (usable.length === 0) return undefined
  // Creator-uploaded (CC) tracks beat machine-generated ones for the same language.
  const ccFirst = [...usable].sort((left, right) => Number(String(left.lan).startsWith('ai')) - Number(String(right.lan).startsWith('ai')))
  const byLang = (wanted) => ccFirst.find((track) => String(track.lan).toLowerCase() === wanted.toLowerCase())
  const byPrefix = (prefix) => ccFirst.find((track) => String(track.lan).toLowerCase().startsWith(prefix))
  const byDoc = (needle) => ccFirst.find((track) => String(track.lan_doc ?? '').includes(needle))
  return (
    (preferred ? byLang(preferred) : undefined) ??
    (preferred ? byPrefix(preferred.split('-')[0]) : undefined) ??
    byLang('zh-CN') ??
    byDoc('中文') ??
    byLang('ai-zh') ??
    byPrefix('zh') ??
    byLang('ai-en') ??
    byPrefix('en') ??
    ccFirst[0]
  )
}

/**
 * Pick a companion track for a bilingual transcript.
 * @param tracks - parsed subtitle tracks.
 * @param primary - the already chosen primary track.
 * @param wanted - requested secondary language, when given.
 * @returns the secondary track, or undefined when none is usable.
 */
export function pickCompanionTrack(tracks, primary, wanted) {
  const usable = (tracks ?? []).filter(
    (track) =>
      typeof track?.subtitle_url === 'string' &&
      track.subtitle_url.length > 0 &&
      String(track.lan) !== String(primary?.lan),
  )
  if (usable.length === 0) return undefined
  if (wanted) {
    const exact = usable.find((track) => String(track.lan).toLowerCase() === wanted.toLowerCase())
    if (exact) return exact
    const prefix = usable.find((track) => String(track.lan).toLowerCase().startsWith(wanted.split('-')[0].toLowerCase()))
    if (prefix) return prefix
  }
  const primaryFamily = String(primary?.lan ?? '').replace(/^ai-/, '').split('-')[0]
  const opposite = usable.find((track) => !String(track.lan).toLowerCase().startsWith(primaryFamily))
  return opposite ?? usable[0]
}

/**
 * List a video's subtitle tracks through the subtitle service.
 * @param options - video ids, cookie, and request options.
 * @returns the parsed tracks plus which route answered.
 */
export async function fetchSubtitleTracks(options) {
  const key = await resolveWbiKey(options)
  const params = {
    oid: options.cid,
    pid: options.aid,
    context_ext: JSON.stringify({ video_type: 1 }),
    type: 1,
    cur_production_type: 0,
    playlist_switch: 0,
    web_location: 1315873,
    ...(options.language ? { preferred_language: options.language } : {}),
  }
  const url = `${SUBTITLE_VIEW_API}?${signQuery(params, key)}`
  const { buffer } = await fetchBytes(url, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: `https://www.bilibili.com/video/${options.bvid}/`,
    origin: 'https://www.bilibili.com',
  })
  const tracks = parseSubtitleTracks(buffer).map((track) => {
    const rebuilt = rebuildSubtitleUrl(track.subtitle_url)
    return { ...track, subtitle_url: rebuilt ?? track.subtitle_url, url_rewritten: Boolean(rebuilt) }
  })
  return { tracks, route: 'x/v2/subtitle/web/view', rawBytes: buffer.length }
}

/**
 * Download and normalize one subtitle track body.
 * @param options - track URL plus request options.
 * @returns normalized segments.
 */
export async function fetchSubtitleBody(options) {
  const url = options.url.startsWith('//') ? `https:${options.url}` : options.url
  const payload = await fetchJson(url, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: options.referer ?? 'https://www.bilibili.com/',
  })
  const body = Array.isArray(payload?.body) ? payload.body : []
  return body
    .map((segment) => ({
      from: Number(segment.from ?? 0),
      to: Number(segment.to ?? 0),
      text: String(segment.content ?? '').trim(),
    }))
    .filter((segment) => segment.text.length > 0)
}

/**
 * Measure how much of the video a segment list actually covers.
 * @param segments - normalized segments.
 * @param durationSeconds - the video's duration.
 * @returns count, covered seconds, and the coverage ratio.
 */
export function assessSegments(segments, durationSeconds) {
  const count = segments.length
  const covered = count > 0 ? segments[count - 1].to : 0
  const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : 0
  return {
    count,
    coveredSeconds: Number(covered.toFixed(2)),
    coverage: duration > 0 ? Number((covered / duration).toFixed(3)) : 0,
  }
}

/**
 * Resolve the best DASH audio stream for a video.
 *
 * Used by the fallback path when a video has no subtitle track at all.
 *
 * @param options - video ids, cookie, and request options.
 * @returns the chosen stream URL, its codec, and every candidate.
 */
export async function fetchAudioStream(options) {
  const key = await resolveWbiKey(options)
  const query = signQuery(
    {
      avid: options.aid,
      bvid: options.bvid,
      cid: options.cid,
      qn: 0,
      fnver: 0,
      fnval: 4048,
      fourk: 1,
      from_client: 'BROWSER',
    },
    key,
  )
  const payload = await fetchBilibiliJson(`${PLAYURL_API}?${query}`, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: `https://www.bilibili.com/video/${options.bvid}/`,
  })
  const dash = payload.data?.dash
  const candidates = (dash?.audio ?? []).map((stream) => ({
    url: stream.baseUrl ?? stream.base_url,
    codec: stream.codecs,
    bandwidth: stream.bandwidth,
    id: stream.id,
  }))
  const flac = dash?.flac?.audio ? [{ url: dash.flac.audio.baseUrl ?? dash.flac.audio.base_url, codec: 'flac', bandwidth: Number.MAX_SAFE_INTEGER, id: 0 }] : []
  const all = [...flac, ...candidates].filter((stream) => typeof stream.url === 'string' && stream.url.length > 0)
  if (all.length === 0) {
    const durl = payload.data?.durl
    if (Array.isArray(durl) && durl[0]?.url) {
      return { url: durl[0].url, codec: 'durl', bandwidth: 0, candidates: [{ url: durl[0].url, codec: 'durl', bandwidth: 0 }] }
    }
    throw new BilibiliError('Bilibili returned no playable audio stream for this video', {
      code: payload.code,
      detail: 'the video may be region-locked, paid, or unavailable',
    })
  }
  all.sort((left, right) => right.bandwidth - left.bandwidth)
  return { ...all[0], candidates: all }
}

/**
 * Fetch Bilibili's own AI summary of a video, when the platform generated one.
 * @param options - video ids, cookie, and request options.
 * @returns the summary, outline, and whether one exists.
 */
export async function fetchAiConclusion(options) {
  const key = await resolveWbiKey(options)
  const query = signQuery({ bvid: options.bvid, cid: options.cid, up_mid: options.upMid ?? '' }, key)
  const payload = await fetchBilibiliJson(`${CONCLUSION_API}?${query}`, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: `https://www.bilibili.com/video/${options.bvid}/`,
  })
  const data = payload.data ?? {}
  const result = data.model_result ?? {}
  const outline = (result.outline ?? []).map((section) => ({
    title: section.title,
    points: (section.part_outline ?? []).map((point) => ({ timestamp: point.timestamp, content: point.content })),
  }))
  return {
    available: Boolean(result.result_type) || outline.length > 0 || Boolean(result.summary),
    resultType: result.result_type ?? 0,
    summary: result.summary ?? '',
    outline,
    like: data.like_num,
    dislike: data.dislike_num,
  }
}

/**
 * Read the comment section's most useful entries.
 *
 * Used as a fallback source when neither a subtitle track nor an AI summary
 * exists: a long, well-liked comment often carries the summary a viewer wrote
 * by hand.
 *
 * @param options - aid, filters, cookie, and request options.
 * @returns the selected comments plus how many were scanned.
 */
export async function fetchHotComments(options = {}) {
  const minLength = options.minLength ?? 200
  const minLikes = options.minLikes ?? 3
  const limit = options.limit ?? 5
  const payload = await fetchBilibiliJson(`${REPLY_API}?type=1&oid=${options.aid}&sort=2&pn=1&ps=20`, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: options.referer ?? 'https://www.bilibili.com/',
  })
  const replies = payload.data?.replies ?? []
  const comments = replies
    .map((reply) => ({
      author: reply.member?.uname,
      likes: reply.like ?? 0,
      replies: reply.rcount ?? 0,
      text: String(reply.content?.message ?? '').trim(),
      ctime: reply.ctime,
    }))
    .filter((comment) => comment.text.length >= minLength && comment.likes >= minLikes)
    .sort((left, right) => right.likes - left.likes)
    .slice(0, limit)
  return { scanned: replies.length, comments, thresholds: { minLength, minLikes } }
}

/**
 * List one UP's recent uploads, so a batch run can iterate videos.
 * @param options - mid, page size, and request options.
 * @returns the listed videos.
 */
export async function fetchUserVideos(options) {
  const key = await resolveWbiKey(options)
  const query = signQuery(
    { mid: options.mid, ps: Math.min(options.limit ?? 30, 50), pn: options.page ?? 1, order: 'pubdate', platform: 'web' },
    key,
  )
  const payload = await fetchBilibiliJson(`${SPACE_ARC_API}?${query}`, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: `https://space.bilibili.com/${options.mid}/video`,
  })
  const list = payload.data?.list?.vlist ?? []
  return {
    total: payload.data?.page?.count ?? list.length,
    videos: list.map((video) => ({
      bvid: video.bvid,
      aid: video.aid,
      title: video.title,
      duration: video.length,
      created: video.created,
      url: `https://www.bilibili.com/video/${video.bvid}`,
    })),
  }
}

/**
 * List the collections (合集/系列) one UP maintains.
 * @param options - mid and request options.
 * @returns seasons and series with their ids.
 */
export async function fetchUserCollections(options) {
  const payload = await fetchBilibiliJson(
    `${SEASON_LIST_API}?mid=${options.mid}&page_num=1&page_size=20`,
    {
      cookie: options.cookie,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      referer: `https://space.bilibili.com/${options.mid}/`,
    },
  )
  const lists = payload.data?.items_lists ?? {}
  const map = (entries, kind) =>
    (entries ?? []).map((entry) => ({
      kind,
      id: entry.meta?.season_id ?? entry.meta?.series_id,
      title: entry.meta?.name,
      count: entry.total ?? entry.meta?.total,
      url: entry.meta?.season_id
        ? `https://space.bilibili.com/${options.mid}/lists/${entry.meta.season_id}`
        : `https://space.bilibili.com/${options.mid}/channel/seriesdetail?sid=${entry.meta?.series_id}`,
    }))
  return { collections: [...map(lists.seasons_list, 'season'), ...map(lists.series_list, 'series')] }
}

/**
 * List the videos inside one collection.
 * @param options - mid, collection id and kind, and request options.
 * @returns the member videos.
 */
export async function fetchCollectionVideos(options) {
  const query =
    options.kind === 'series'
      ? `mid=${options.mid}&series_id=${options.id}&only_normal=true&sort=desc&pn=1&ps=${Math.min(options.limit ?? 30, 50)}`
      : `mid=${options.mid}&season_id=${options.id}&sort_reverse=false&page_num=1&page_size=${Math.min(options.limit ?? 30, 30)}`
  const endpoint =
    options.kind === 'series'
      ? 'https://api.bilibili.com/x/series/archives'
      : 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list'
  const payload = await fetchBilibiliJson(`${endpoint}?${query}`, {
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    referer: `https://space.bilibili.com/${options.mid}/`,
  })
  const items = options.kind === 'series' ? payload.data?.archives ?? [] : payload.data?.archives ?? []
  return {
    videos: items.map((video) => ({
      bvid: video.bvid,
      aid: video.aid,
      title: video.title,
      duration: video.duration ?? video.length,
      url: `https://www.bilibili.com/video/${video.bvid}`,
    })),
  }
}
