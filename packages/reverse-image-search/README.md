# dsh-reverse-image-search

English | [中文](README.zh.md)

**Search by image** for DeepSeek Harness. The query is a picture, not words: give it an avatar, a screenshot, a photo, or a product shot, and it returns what the image shows and where it appears on the web.

This is the opposite direction from a text image search. DSH's `web_search` already covers "find pages by words", and multimodal input already covers "tell me what this image is"; neither can look a picture up. This plugin adds that missing direction.

## Tools

```
image_search({ image_path: "attachments/avatar.png" })
image_search({ image_url: "https://example.com/photo.jpg", limit: 12 })
image_download({ url: "<thumbnailUrl from the result>", path: "assets/match.jpg" })
```

| Result field | Meaning |
| --- | --- |
| `recognition` | The engine's one-line reading, for example "图中可能是戴眼镜男子卡通头像". |
| `images` | Similar images, each with `thumbnailUrl` and usually `pageUrl`. |
| `pages` | External pages referencing the image or a near match, with host. |
| `engine`, `resultUrl` | Which engine ran, plus the live result page. |
| `notes` | What the engine does not guarantee, including a changed-layout warning. |

Exactly one of `image_path` or `image_url` is required; a text query is rejected.

## Engine

**Baidu 识图** (`graph.baidu.com`). It is the only reverse-image engine that answers from the reference network without an API key **and** without an outbound proxy:

| Engine | Direct? | Why not used |
| --- | --- | --- |
| Baidu 识图 | yes | used |
| Yandex images | yes, but captcha | SmartCaptcha on the reference network |
| Bing visual search | upload endpoint gone | `/images/searchbyimage/upload` answers 404 |
| Sogou 识图 | no upload entry | no file input on the page |
| Google Lens, TinEye | unreachable directly | would need the proxy the user does not run |

Baidu publishes no keyless reverse-image API, so the plugin drives the page with a real browser: it opens the entry page, hands the image to the page's file input, and reads the recognition phrase and similar-image grid from the rendered result. Baidu can change its layout, rate-limit, or disable the service; the tool then reports what it actually saw instead of inventing a match.

## Requirements

- `playwright` (installed with the plugin) and a browser: Playwright's bundled Chromium, or an installed Google Chrome / Microsoft Edge. `DSH_IMAGE_SEARCH_BROWSER` pins a channel; `DSH_IMAGE_SEARCH_HEADLESS=false` shows the window.
- Network access to `graph.baidu.com`.

## Install

```sh
dsh plugin --profile <profile> add ./packages/reverse-image-search
```

## Verification

```sh
node scripts/check.mjs
node scripts/verify-plugins.mjs
```

The adapter was exercised against the live page with a real 150×150 avatar: the upload succeeded, the result page carried `图中可能是戴眼镜男子卡通头像`, and the similar-image grid parsed into records.
