/**
 * Audio fallback: pull a video's DASH audio stream down to a WAV file.
 *
 * Only used when a video has no subtitle track at all. ffmpeg does the
 * downloading and resampling in one pass, because the stream URL is
 * short-lived and the ASR runtime wants 16 kHz mono PCM.
 *
 * @module dsh-bilibili-summary/audio
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BROWSER_UA } from './http.js'

/** Bare and absolute locations tried for the ffmpeg binary. */
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']

/**
 * Find an ffmpeg binary.
 * @param configured - explicit path from configuration.
 * @returns the path to use.
 */
export function resolveFfmpeg(configured) {
  if (configured) return configured
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, 'ffmpeg')
    if (existsSync(candidate)) return candidate
  }
  return 'ffmpeg'
}

/**
 * Run one command and collect its output.
 * @param command - executable.
 * @param args - argument list.
 * @param options - cancellation and timeout.
 * @returns exit code and captured output.
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : undefined
    const onAbort = () => child.kill('SIGKILL')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      options.onStdout?.(String(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      options.onStderr?.(String(chunk))
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(new Error(`failed to run ${command}: ${error.message}`))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Download one audio stream into a 16 kHz mono WAV.
 * @param options - stream URL, referer, output path, and process settings.
 * @returns the written file's path and size.
 */
export async function downloadAudio(options) {
  mkdirSync(dirname(options.outPath), { recursive: true })
  const headers = `Referer: ${options.referer}\r\nUser-Agent: ${BROWSER_UA}\r\n`
  const { code, stderr } = await run(
    options.ffmpegPath ?? resolveFfmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-headers',
      headers,
      '-i',
      options.url,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      options.outPath,
    ],
    { signal: options.signal, timeoutMs: options.timeoutMs },
  )
  if (code !== 0 || !existsSync(options.outPath)) {
    throw new Error(`ffmpeg could not decode the audio stream (exit ${code}): ${stderr.trim().slice(0, 300)}`)
  }
  return { path: options.outPath, bytes: statSync(options.outPath).size }
}
