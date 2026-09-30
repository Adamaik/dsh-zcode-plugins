#!/usr/bin/env node
/**
 * Repository self-check for the DSH plugin bundles.
 *
 * Verifies the pieces a loader depends on before packaging: every package
 * declares an existing bundle patch, every skill has valid kebab-case
 * frontmatter, every referenced skill directory exists, and every JavaScript
 * and Python source parses. It does not boot DSH or execute plugin code.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const failures = []
const checks = []

/** Record one passing check. */
function pass(message) {
  checks.push(message)
}

/** Record one failed check. */
function fail(message) {
  failures.push(message)
}

/** Walk every regular file under a directory. */
function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found
}

/** Parse the leading frontmatter block of a SKILL.md. */
function frontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const header = text.slice(3, end)
  const name = /^name:\s*(\S+)\s*$/m.exec(header)
  const description = /^description:\s*(?:"((?:[^"\\]|\\.)*)"|(.+?))\s*$/m.exec(header)
  return {
    name: name ? name[1] : null,
    description: description ? (description[1] ?? description[2]) : null,
    raw: header,
  }
}

const packagesDir = join(ROOT, 'packages')
for (const entry of readdirSync(packagesDir)) {
  const dir = join(packagesDir, entry)
  if (!statSync(dir).isDirectory()) continue
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    fail(`${entry}: missing package.json`)
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const patch = manifest.dsh?.bundle?.patch
  if (!patch) {
    fail(`${entry}: package.json has no dsh.bundle.patch`)
  } else if (!existsSync(resolve(dir, patch))) {
    fail(`${entry}: bundle patch ${patch} does not exist`)
  } else {
    pass(`${entry}: bundle patch ${patch}`)
    const patchText = readFileSync(resolve(dir, patch), 'utf8')
    if (!patchText.includes('- insert:')) fail(`${entry}: patch has no insert list`)
    if (!patchText.includes(manifest.name)) fail(`${entry}: patch does not mount ${manifest.name}`)
  }
  for (const file of walk(dir)) {
    if (file.includes(`${'node_modules'}`)) continue
    if (file.endsWith('.mjs') || (file.endsWith('.js') && !file.includes('node_modules'))) {
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
      } catch (error) {
        fail(`${relative(ROOT, file)}: node --check failed: ${error.stderr?.toString().trim()}`)
      }
    }
    if (file.endsWith('.py')) {
      const python = process.env.PDF_PYTHON ?? 'python3'
      try {
        execFileSync(python, ['-m', 'py_compile', file], { stdio: 'pipe' })
      } catch (error) {
        fail(`${relative(ROOT, file)}: py_compile failed: ${error.stderr?.toString().trim()}`)
      }
    }
    if (file.endsWith('SKILL.md')) {
      const parsed = frontmatter(readFileSync(file, 'utf8'))
      if (!parsed?.name) fail(`${relative(ROOT, file)}: missing frontmatter name`)
      else if (!parsed.description) fail(`${relative(ROOT, file)}: missing frontmatter description`)
      else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(parsed.name)) {
        fail(`${relative(ROOT, file)}: name ${parsed.name} is not kebab-case`)
      } else pass(`${relative(ROOT, file)}: skill ${parsed.name}`)
    }
  }
  const client = manifest.dsh?.client
  if (client !== undefined) {
    if (typeof client.platform !== 'string') fail(`${entry}: dsh.client.platform is missing`)
    const declared = manifest.exports?.['./client']
    const clientPath = typeof declared === 'string' ? declared : declared?.default
    if (typeof clientPath !== 'string') fail(`${entry}: dsh.client needs exports["./client"]`)
    else if (!existsSync(resolve(dir, clientPath))) {
      fail(`${entry}: client bundle ${clientPath} does not exist`)
    } else {
      const clientText = readFileSync(resolve(dir, clientPath), 'utf8')
      const moduleId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientText)
      if (moduleId === null) fail(`${entry}: client bundle is not a __ModuleLoader__ module`)
      else if (moduleId[1] !== manifest.name) {
        fail(`${entry}: client module id ${moduleId[1]} does not match ${manifest.name}`)
      } else pass(`${entry}: client module ${moduleId[1]} (${clientPath})`)
    }
  }
  const entryFile = join(dir, manifest.main ?? 'index.js')
  if (existsSync(entryFile)) {
    const source = readFileSync(entryFile, 'utf8')
    for (const match of source.matchAll(/new URL\('(\.\/skills\/[^']+)'/g)) {
      const skillDir = resolve(dir, match[1])
      if (!existsSync(skillDir)) fail(`${entry}: referenced skill dir ${match[1]} does not exist`)
      else pass(`${entry}: skill dir ${match[1]}`)
    }
  }
}

for (const message of checks) console.log(`ok   ${message}`)
for (const message of failures) console.error(`FAIL ${message}`)
console.log(`\n${checks.length} check(s) passed, ${failures.length} failed`)
process.exitCode = failures.length === 0 ? 0 : 1
