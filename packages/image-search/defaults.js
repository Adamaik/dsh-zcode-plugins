/**
 * Default connection settings for the ZCode official image-search MCP server.
 *
 * The upstream ZCode plugin declares `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search`
 * with the ZCode-native `zcode_official` / `jwt_token` auth scheme. ZCode
 * resolves that scheme to two request headers: `Authorization` carries the
 * account JWT and `X-Bigmodel-Authorization` carries the coding-plan
 * credential.
 *
 * The origin is copied from ZCode and is not a secret. Both credentials are
 * personal: this package ships none, and each installation supplies its own
 * through the environment or `$DSH_HOME/.env`.
 *
 * @module dsh-zcode-image-search/defaults
 */

/** ZCode origin serving the official MCP endpoints. */
export const DEFAULT_BASE_URL = 'https://zcode.z.ai'

/** ZCode account JWT; empty so every installation supplies its own. */
export const DEFAULT_TOKEN = ''

/** Coding-plan credential sent as `X-Bigmodel-Authorization`; empty by default. */
export const DEFAULT_CODING_PLAN_TOKEN = ''
