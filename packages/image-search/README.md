# dsh-zcode-image-search

English | [中文](README.zh.md)

An unofficial DeepSeek Harness port of the ZCode built-in **image search** plugin: an MCP server that finds illustrations and reference images.

The upstream declaration is copied verbatim; only the transport wiring changes, because DSH's MCP client takes an explicit endpoint and headers instead of ZCode's `zcode_official` JWT auth scheme.

## Upstream

| Upstream | Value |
| --- | --- |
| ZCode plugin | `image-search` 0.1.1, license Apache-2.0, author Z.ai |
| Endpoint | `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search` |
| Auth | `zcode_official`, provider `jwt_token` |
| Timeout | 90000 ms |

The original files ship verbatim as [mcp.json](./mcp.json), [zcode-plugin.json](./zcode-plugin.json), and [upstream-README.md](./upstream-README.md).

## Install

```sh
dsh plugin --profile <profile> add ./packages/image-search
```

## Configure

ZCode's `zcode_official` / `jwt_token` scheme resolves to two request headers. This plugin reproduces both, reading each setting from the process environment first, then `$DSH_HOME/.env`:

| Variable | Required | Meaning | ZCode source |
| --- | --- | --- | --- |
| `ZCODE_BASE_URL` | no | Endpoint origin; defaults to the copied `https://zcode.z.ai`. | `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` |
| `ZCODE_JWT_TOKEN` | yes | Account JWT sent as `Authorization: Bearer <token>`. | credential `zcodejwttoken` |
| `ZCODE_CODING_PLAN_TOKEN` | yes | Coding-plan credential sent as `X-Bigmodel-Authorization`. | `account-provider:coding-plan:...:api-key` |

The package ships no credential, so each installation supplies its own values. On a machine that already has ZCode, copy them out of `~/.zcode/v2/credentials.json`:

```sh
# ZCode encrypts these values as enc:v1:<iv>.<tag>.<data> (AES-256-GCM).
# The key is SHA-256 of $ZCODE_CREDENTIAL_SECRET, or of
# "zcode-credential-fallback:<platform>:<home>:<username>" when that is unset.
```

Put the three variables in `$DSH_HOME/.env` (mode 600) or export them in the DSH environment. Without credentials the row still activates (`failOnStartupError: false`) and exposes no tools instead of failing the boot.

## Account entitlement

The endpoint authenticates the copied JWT — a wrong or missing credential answers `{"code":1006,"message":"no permission"}` — but it only opens a session for an account with the coding plan, otherwise it answers:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":3101,"message":"coding plan is required"}}
```

MCP `initialize` fails on that response, so no tools are registered even though the URL and credentials are correct. Check the entitlement in ZCode's `~/.zcode/v2/coding-plan-cache.json` before expecting tools in the session.

## Tools

The server's tools appear with the DSH MCP namespace, for example `mcp__image_search__<tool>`. The upstream server does not document a fixed tool list; discover it from the session tool catalog after the connection succeeds.

## Known limitations

- The endpoint is ZCode's hosted service. This package does not implement image search locally, and it cannot be used without a ZCode account token **and** the coding-plan entitlement that ZCode checks with `X-Bigmodel-Authorization`.
- Both credentials are secrets: keep them in `$DSH_HOME/.env` or the environment, never in a repository.
