---
name: bilibili-summary
description: "Summarize a Bilibili video into a Chinese HTML report from its subtitle track, falling back to Bilibili's own AI summary, the comment section, and finally local audio transcription. Annotates proper nouns and background that a reader cannot understand out of context. Use when the user shares a bilibili.com, b23.tv, or BV link and asks for a summary, notes, key points, a transcript, highlights, or a written/HTML report; also use when only the subtitle text is wanted, or when a channel or series must be summarized in batch. Not for other video sites."
metadata:
  author: dsh-zcode-plugins
  version: "0.1.2"
---

# B站视频汇总

把一条 B站视频变成一份可阅读、可点击跳转、**自带背景注释**的 HTML 汇总文档。字幕优先走官方字幕服务；没有字幕就逐级降级。

## 工具

| 工具 | 用途 |
| --- | --- |
| `bilibili_subtitles` | 抽取官方 AI/CC 字幕（protobuf 服务 + 播放器 URL 重签），三级校验后才返回；支持 `bilingual` 双语合并，输出 md/txt/srt/ass/lrc/json |
| `bilibili_video_info` | 元信息、字幕轨道清单、B站 AI 总结；**视频无字幕时默认附带评论区长评**（降级来源） |
| `bilibili_transcribe` | 最后兜底：下载音频（多路候选自动重试）→ faster-whisper 本地转写 |
| `bilibili_series` | 列 UP 的最近投稿 / 合集系列 / 合集内视频，用于批量任务 |
| `bilibili_login` | 扫码登录，Cookie 存到 `$DSH_HOME/bilibili-cookies.json` |

## 取内容：按顺序降级，不要跳步

1. **先探路**：`bilibili_video_info({ url })`，看 `tracks` 与 `aiSummary`。
2. **有字幕轨道** → `bilibili_subtitles({ url, out: "bilibili/<bvid>/transcript.md" })`
   - 未登录会明确报错：`bilibili_login { action: "start" }` → 用 `![登录二维码](<qrPath>)` 展示 → 用户扫码 → `{ action: "poll" }` → 重试。
   - 工具做**三级校验**：标题关键词命中 + 时长覆盖率 + 时长异常检测，返回 `strong / weak / fail`。
     - `strong`：命中关键词且覆盖 ≥ 50%，可直接使用。
     - `weak`：覆盖率 ≥ 70% 但关键词零命中（标题党或纯英文标题常见），可用，但要在文档里标注"弱校验"。
     - `fail`：段数不足、覆盖 < 50% 或 > 200%（多半是别的视频的字幕/被限流截断）→ **绝不采信**，继续降级或稍后重试。
3. **无字幕但 B站 有 AI 总结** → 用 `aiSummary.summary + outline` 写文档，明确标注"依据 B站 AI 总结"。
4. **两者都没有** → 看 `bilibili_video_info` 返回的 `comments`（评论区长评）：长文、高赞的"课代表"评论常是现成的摘要，标注"依据评论区长评"。
5. **以上都没有** → `bilibili_transcribe({ url, out })` 本地 ASR。首次会建 venv + 下模型，可能几分钟；先告知用户预计耗时，不要擅自取消。
6. **写 HTML**：读 `reference/template.html`，填充后写到 `bilibili/<bvid>/<slug>.html`；交付时用 `present` 给出文件卡片。

批量任务：`bilibili_series` 列出视频后，对其中每条重复第 1–6 步；一次只汇总用户点名的那几集，不要默默扩大范围。

## 文档要求

- 语言：中文；术语、命令、代码保留原文。
- 结构（模板已备好槽位）：信息卡 → 一句话总结 → 核心要点（3–6 条）→ 时间轴（8–15 个节点，可点击跳转 `?t=秒`）→ 关键概念 → **背景注释**（角标悬停即显 + 文末完整清单）→ 金句（原文摘录，标时间）→ 行动清单 → 完整文稿（`<details>` 折叠）。
- 时间轴节点必须带真实时间戳与 `?t=` 链接；不要编造时间点。
- **必须区分来源**：官方字幕 / B站 AI 总结 / 评论区长评 / 本地 ASR，写进信息卡与页脚。
- 多分P视频：标题与链接标明第几集（`&p=N`），只汇总所请求的那一集。
- 样式：自包含单文件（内联 CSS、无外部资源、无 CDN）；浅色/深色都清晰；长文稿折叠；打印友好。

## 背景注释（本技能的重点）

视频里大量名词**离开上下文就读不懂**：人名与团队、产品与工具、公司与组织、行业黑话与缩写、当时的事件或梗。必须主动注释，而不是假设读者知道。

- **挑什么**：正文里出现、但普通读者（不了解这个圈子）看不懂的名称。典型是：人名/ID（作者、嘉宾、被点名的人）、产品与库（框架、CLI、SaaS）、组织（公司、社区、会议）、专有流程或缩写、被引用的文章/视频/事件、以及只有圈内人懂的梗。
- **写什么**：每条 1–2 句——① 它是什么（身份/所属/领域）；② **在这条视频里为什么被提到**。不要写百科长传；不要复述视频内容。
- **怎么保证准确**：文稿里没有的信息用 `web_search` 核实（尤其是人名、产品、外链）；仍然无法确认时写「（未能核实）」，**绝不编造**。给出可点的来源链接。
- **标注方式**：正文首次出现处插入**可悬停角标**——鼠标移上去立即展开注释浮层，点击数字跳到文末注释区。角标内联的文本必须与文末注释区**逐字一致**。数量以"确有需要"为准，通常 5–15 条；没有需要注释的内容就写「本视频无需额外背景注释」。
- 角标必须用这个结构（编号、`title`、`#note-N`、浮层文本一一对应）：

  ```html
  <sup class="note-ref" tabindex="0" title="Matt Pocock：英国 TypeScript 教育者、AI Hero 创始人；本视频主讲人。"><a href="#note-1">1</a><span class="note-pop"><b>Matt Pocock</b>：英国 TypeScript 教育者、AI Hero 创始人；本视频主讲人。<span class="src">来源：<a href="https://www.totaltypescript.com/" target="_blank" rel="noreferrer">totaltypescript.com</a></span></span></sup>
  ```

  - 浮层里可以放可点链接；`title` 只放纯文本，作为没有 CSS 时的兜底。
  - 先写完整的注释清单，再把同一条文本原样复制进角标，避免两处措辞不一致。
  - 角标不要写进标题，也不要连续堆叠（同一句最多两个）。
  - 时间轴节点里的角标要放在正文里（`<div>` 内），不要放进 `<time>` 链接，否则会挡点击。
- 术语与注释分工：**关键概念**解释视频里的方法论（spec、task graph、blast radius）；**背景注释**解释视频外的世界（人物、产品、组织、事件）。

## 规则

- 不虚构视频里没有的内容；播放量、点赞数等只取 API 原值。
- 引用的时间戳必须来自工具返回的 `timeline` / 文稿。
- 校验 `fail` 的文稿、或明显不属于本视频的内容，一律不得写入文档。
- 登录二维码是时效凭据：只在回复里展示，不要写进交付文档或任何文件。
- 不确定的信息宁可标注"未能核实"，也不要写得像事实。
