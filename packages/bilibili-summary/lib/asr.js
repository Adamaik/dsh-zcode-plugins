/**
 * Local ASR fallback.
 *
 * A video whose subtitles are burned into the picture has no track to extract,
 * so the last resort is transcription. The harness Python runtime cannot load
 * pip-installed native extensions on macOS (their signatures do not match the
 * signed runtime), so this module uses a dedicated virtualenv built from the
 * system Python instead, created lazily on first use.
 *
 * @module dsh-bilibili-summary/asr
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './cookies.js'

/** Bundled transcription script. */
export const TRANSCRIBE_SCRIPT = fileURLToPath(new URL('../python/transcribe.py', import.meta.url))

/** System Python candidates used to build the assistant virtualenv. */
const VENV_PYTHONS = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']

/**
 * Default virtualenv location.
 * @returns the absolute path.
 */
export function defaultVenvDir() {
  return join(dshHome(), 'bilibili-asr', 'venv')
}

/**
 * Default model cache location.
 * @returns the absolute path.
 */
export function defaultModelDir() {
  return join(dshHome(), 'bilibili-asr', 'models')
}

/**
 * Run one command, streaming nothing but capturing output.
 * @param command - executable.
 * @param args - argument list.
 * @param options - cancellation.
 * @returns exit code and output.
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    options.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => reject(new Error(`failed to run ${command}: ${error.message}`)))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Probe whether a Python interpreter can import faster-whisper.
 * @param python - interpreter path.
 * @returns true when the runtime is usable.
 */
export async function hasFasterWhisper(python) {
  if (!python || !existsSync(python)) return false
  const { code } = await run(python, ['-c', 'import faster_whisper'])
  return code === 0
}

/**
 * Resolve a usable ASR interpreter, building one when asked.
 * @param options - configured interpreter, venv location, and bootstrap consent.
 * @returns the interpreter path, plus how it was obtained.
 */
export async function ensureAsrPython(options = {}) {
  const configured = options.python
  if (configured && (await hasFasterWhisper(configured))) return { python: configured, source: 'configured' }
  const venvDir = options.venvDir ?? defaultVenvDir()
  const venvPython = join(venvDir, 'bin', 'python')
  if (await hasFasterWhisper(venvPython)) return { python: venvPython, source: 'venv' }
  if (options.bootstrap === false) {
    throw new Error(
      `no ASR runtime found. Set asrPython in the plugin config, or create one with: ` +
        `/usr/bin/python3 -m venv ${venvDir} && ${venvDir}/bin/pip install faster-whisper`,
    )
  }
  const base = VENV_PYTHONS.find((candidate) => existsSync(candidate))
  if (!base) throw new Error('no system Python found to build the ASR virtualenv')
  mkdirSync(venvDir, { recursive: true })
  const created = await run(base, ['-m', 'venv', venvDir], { signal: options.signal })
  if (created.code !== 0) {
    throw new Error(`could not create the ASR virtualenv: ${created.stderr.trim().slice(0, 300)}`)
  }
  const pip = join(venvDir, 'bin', 'pip')
  const installed = await run(pip, ['install', '--quiet', 'faster-whisper'], { signal: options.signal })
  if (installed.code !== 0) {
    throw new Error(`could not install faster-whisper: ${installed.stderr.trim().slice(0, 300)}`)
  }
  if (!(await hasFasterWhisper(venvPython))) {
    throw new Error('faster-whisper installed but cannot be imported by the virtualenv')
  }
  return { python: venvPython, source: 'bootstrap' }
}

/**
 * Transcribe a WAV file with faster-whisper.
 * @param options - interpreter, audio path, model, and language.
 * @returns detected language and timestamped segments.
 */
export async function transcribeAudio(options) {
  const outPath = `${options.audioPath}.json`
  const args = [
    TRANSCRIBE_SCRIPT,
    '--audio',
    options.audioPath,
    '--out',
    outPath,
    '--model',
    options.model ?? 'small',
    '--model-dir',
    options.modelDir ?? defaultModelDir(),
  ]
  if (options.language && options.language !== 'auto') args.push('--language', options.language)
  const { code, stdout, stderr } = await run(options.python, args, { signal: options.signal })
  if (code !== 0 || !existsSync(outPath)) {
    throw new Error(`faster-whisper failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 400)}`)
  }
  const parsed = JSON.parse(readFileSync(outPath, 'utf8'))
  const segments = (parsed.segments ?? []).filter((segment) => segment.text)
  return {
    language: parsed.language,
    probability: parsed.probability,
    segments,
    scriptBytes: statSync(outPath).size,
  }
}
