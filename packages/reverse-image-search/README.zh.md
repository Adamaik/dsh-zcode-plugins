# dsh-reverse-image-search

[English](README.md) | 中文

DeepSeek Harness 的**以图搜图**能力。查询是一张图，不是文字：给一张头像、截图、照片或商品图，它返回图里是什么、以及这张图在网页上出现在哪里。

这和"文字搜图"是相反的方向。DSH 的 `web_search` 已经覆盖"用文字找网页"，多模态输入已经覆盖"告诉我这图是什么"；两者都做不到"拿图去搜"。本插件补的就是这个方向。

## 工具

```
image_search({ image_path: "attachments/avatar.png" })
image_search({ image_url: "https://example.com/photo.jpg", limit: 12 })
image_download({ url: "<结果里的 thumbnailUrl>", path: "assets/match.jpg" })
```

| 结果字段 | 含义 |
| --- | --- |
| `recognition` | 引擎的一句话识别，例如"图中可能是戴眼镜男子卡通头像"。 |
| `images` | 相似图片，每条带 `thumbnailUrl`，通常还有 `pageUrl`。 |
| `pages` | 引用该图或近似图的外部网页，带 host。 |
| `engine`、`resultUrl` | 用了哪个引擎，以及可点开的结果页。 |
| `notes` | 引擎不保证什么，包含版面变化告警。 |

`image_path` 与 `image_url` 必须且只能传一个；传文字查询会被拒绝。

## 引擎

**百度识图**（`graph.baidu.com`）。它是本机网络下**既不需要 API key、又不需要代理**的唯一可用识图引擎：

| 引擎 | 直连 | 未采用原因 |
| --- | --- | --- |
| 百度识图 | 可以 | 采用 |
| Yandex images | 可以但需过验证 | 本机网络触发 SmartCaptcha |
| Bing 视觉搜索 | 上传接口已失效 | `/images/searchbyimage/upload` 返回 404 |
| 搜狗识图 | 无上传入口 | 页面没有 file input |
| Google Lens、TinEye | 直连不可达 | 需要走用户平时不开的代理 |

百度没有无 key 的反查 API，所以插件用真实浏览器驱动页面：打开入口页，把图片交给页面的 file input，再从渲染结果里读识别语与相似图网格。百度可能改版面、限流或临时停服；那时工具会如实报告看到的内容，而不是编一个匹配结果。

## 依赖

- `playwright`（随插件安装）和一个浏览器：Playwright 自带 Chromium，或系统已装的 Google Chrome / Microsoft Edge。`DSH_IMAGE_SEARCH_BROWSER` 指定 channel；`DSH_IMAGE_SEARCH_HEADLESS=false` 显示窗口。
- 能访问 `graph.baidu.com`。

## 安装

```sh
dsh plugin --profile <profile> add ./packages/reverse-image-search
```

## 验证

```sh
node scripts/check.mjs
node scripts/verify-plugins.mjs
```

适配器用一张真实的 150×150 头像跑过线上页面：上传成功，结果页给出"图中可能是戴眼镜男子卡通头像"，相似图网格成功解析成记录。
