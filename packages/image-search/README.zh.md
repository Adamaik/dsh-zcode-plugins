# dsh-zcode-image-search

[English](README.md) | 中文

ZCode 内置 **搜图** 插件的非官方 DeepSeek Harness 移植版：一个查找插图与参考配图的 MCP 服务。

上游声明原样照搬；只有传输接线改变，因为 DSH 的 MCP 客户端需要显式的 endpoint 与 headers，而不是 ZCode 专有的 `zcode_official` / `jwt_token` 鉴权方案。

## 上游信息

| 上游 | 值 |
| --- | --- |
| ZCode 插件 | `image-search` 0.1.1，许可证 Apache-2.0，作者 Z.ai |
| Endpoint | `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search` |
| 鉴权 | `zcode_official`，provider `jwt_token` |
| 超时 | 90000 ms |

原始文件原样保留：[mcp.json](./mcp.json)、[zcode-plugin.json](./zcode-plugin.json)、[upstream-README.md](./upstream-README.md)。

## 安装

```sh
dsh plugin --profile <profile> add ./packages/image-search
```

## 配置

ZCode 的 `zcode_official` / `jwt_token` 方案最终落到两个请求头。本插件两个都复现，取值顺序为：进程环境变量 → `$DSH_HOME/.env`。

| 变量 | 必填 | 含义 | ZCode 来源 |
| --- | --- | --- | --- |
| `ZCODE_BASE_URL` | 否 | endpoint 源站，默认用照抄过来的 `https://zcode.z.ai`。 | `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` |
| `ZCODE_JWT_TOKEN` | 是 | 账号 JWT，作为 `Authorization: Bearer <token>` 发送。 | 凭据 `zcodejwttoken` |
| `ZCODE_CODING_PLAN_TOKEN` | 是 | coding plan 凭据，作为 `X-Bigmodel-Authorization` 发送。 | `account-provider:coding-plan:...:api-key` |

本包不内置任何凭据，每个安装者填写自己的值。机器上已有 ZCode 时，可以从 `~/.zcode/v2/credentials.json` 拷出来：

```sh
# ZCode 以 enc:v1:<iv>.<tag>.<data>（AES-256-GCM）加密这些值。
# 密钥是 $ZCODE_CREDENTIAL_SECRET 的 SHA-256；未设置时使用
# "zcode-credential-fallback:<platform>:<home>:<username>" 的 SHA-256。
```

把三个变量写进 `$DSH_HOME/.env`（权限 600），或导出到 DSH 环境。没有凭据时该行仍会激活（`failOnStartupError: false`），只是不暴露工具，不会导致启动失败。

## 账号权限

端点会认证照抄过来的 JWT——凭据错误或缺失时返回 `{"code":1006,"message":"no permission"}`；但只有具备 coding plan 的账号才会话成功，否则返回：

```json
{"jsonrpc":"2.0","id":1,"error":{"code":3101,"message":"coding plan is required"}}
```

该响应会让 MCP `initialize` 失败，因此即使 URL 与凭据都正确也不会注册任何工具。会话里期待工具之前，先看 ZCode 的 `~/.zcode/v2/coding-plan-cache.json` 确认权限。

## 工具

服务端工具以 DSH MCP 命名空间出现，例如 `mcp__image_search__<tool>`。上游服务没有公开固定工具清单，连接成功后从会话工具目录里查看。

## 已知限制

- endpoint 是 ZCode 托管服务。本包不在本地实现搜图；没有 ZCode 账号 token **以及** ZCode 用 `X-Bigmodel-Authorization` 校验的 coding plan 权限，就无法使用。
- 两个凭据都是机密：放在 `$DSH_HOME/.env` 或环境变量里，不要写进仓库。
