/**
 * DSH port of the ZCode image-search plugin.
 *
 * The upstream ZCode plugin is an MCP server declaration only: an HTTP
 * endpoint plus the ZCode-native `zcode_official` / `jwt_token` auth scheme.
 * DSH's MCP client speaks Streamable HTTP with explicit headers, so this
 * plugin mounts `@deepseek-ai/dsh-mcp-client` against the same endpoint and
 * reproduces the same two headers the ZCode runtime sends.
 *
 * Connection settings resolve in this order: the process environment, then
 * `$DSH_HOME/.env`, then the non-secret origin default. The package ships no
 * credential, so every installation supplies its own account values.
 *
 * @module dsh-zcode-image-search
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { DEFAULT_BASE_URL, DEFAULT_CODING_PLAN_TOKEN, DEFAULT_TOKEN } from './defaults.js'

/** Cordis plugin name. */
export const name = 'zcode-image-search'

/** Upstream path for the image-search MCP server. */
const IMAGE_SEARCH_PATH = '/api/v1/mcp/server/image_search'

/**
 * Read one `KEY=value` setting from the DSH environment file.
 * @param key - variable name to look up.
 * @returns the value, or undefined when the file or key is absent.
 */
function fromEnvFile(key) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  let text
  try {
    text = readFileSync(join(home, '.env'), 'utf8')
  } catch {
    // A missing environment file is valid empty state.
    return undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match && match[1] === key) {
      return match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return undefined
}

/**
 * Resolve one setting from the environment, then the DSH environment file, then its default.
 * @param key - variable name.
 * @param fallback - value used when neither source defines it.
 * @returns the resolved value.
 */
function setting(key, fallback) {
  return process.env[key] || fromEnvFile(key) || fallback
}

/** Mount the upstream MCP server as one DSH MCP client row. */
export function apply(ctx) {
  const baseUrl = setting('ZCODE_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '')
  const token = setting('ZCODE_JWT_TOKEN', DEFAULT_TOKEN)
  const codingPlanToken = setting('ZCODE_CODING_PLAN_TOKEN', DEFAULT_CODING_PLAN_TOKEN)
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (codingPlanToken) headers['X-Bigmodel-Authorization'] = codingPlanToken
  ctx.plugin(mcpClient, {
    serverName: 'image_search',
    transport: 'streamable-http',
    url: `${baseUrl}${IMAGE_SEARCH_PATH}`,
    headers,
    toolCallTimeoutMs: 90000,
    failOnStartupError: false,
  })
}
