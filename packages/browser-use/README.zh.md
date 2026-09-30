# dsh-zcode-browser-use

[English](README.md) | 中文

ZCode 内置 **浏览器操作（browser-use）** 插件的非官方 DeepSeek Harness 移植版：Playwright 驱动的浏览器工具，把智能体所在页面镜像进 DSH 桌面版自带右侧栏浏览器的能力，加上 ZCode 的 `control-browser` 与 `web-gui-tester` 技能。

## 上游信息

| 上游 | 值 |
| --- | --- |
| ZCode 插件 | `browser-use` 0.5.1，MIT，作者 Z.ai |
| 传输层 | `node_repl` MCP 服务，暴露一个 `js` 工具（`mcp__node_repl__js`），底层是 ZCode 的 `agent.browsers` 注册表 |
| 后端 | 桌面内置浏览器（IAB）、Chrome 扩展、CLI 托管的无头 CDP |
| 原样照搬 | [skills/control-browser/SKILL.md](./skills/control-browser/SKILL.md)、[skills/web-gui-tester/SKILL.md](./skills/web-gui-tester/SKILL.md)、[docs/](./docs)、[upstream-README.md](./upstream-README.md) |
| 本移植新增 | [lib/browser.js](./lib/browser.js)、[lib/tools.js](./lib/tools.js)、[lib/mirror.js](./lib/mirror.js)、[lib/client.js](./lib/client.js)、[index.js](./index.js) |

上游传输层在 DSH 中不存在：没有 Node REPL 宿主、没有内置浏览器、没有 Chrome 扩展桥。本移植保留上游技能与文档，把传输层换成原生工具。每个照搬的技能都加了 **DSH port note** 说明上游调用到 DSH 工具的映射；改动清单见 [NOTICE](./NOTICE)。

## 安装

```sh
dsh plugin --profile <profile> add dsh-zcode-browser-use
dsh plugin --profile <profile> add ./packages/browser-use
```

浏览器不在 npm 依赖里。插件按顺序尝试：`DSH_BROWSER_CHANNEL` 指定的 channel、Playwright 自带 Chromium、系统 Google Chrome channel、系统 Microsoft Edge channel。装了 Chrome 或 Edge 的机器无需下载；否则装一次 Chromium：

```sh
npx playwright install chromium
```

`playwright` 依赖锁定 1.59.1：浏览器构建版本与库版本必须一致。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_navigate` | 打开 URL，返回稳定后的标题与状态。 |
| `browser_snapshot` | 读取可见文本与可寻址元素（ref、role、name、value、state），主要读取路径。 |
| `browser_click` | 通过快照 ref、CSS 选择器或 role+name 点击。 |
| `browser_type` | 填写输入框，可用 Enter 提交。 |
| `browser_press` | 按下一个按键。 |
| `browser_scroll` | 元素滚入视野，和/或滚轮滚动页面。 |
| `browser_screenshot` | 输出 PNG 并返回路径。 |
| `browser_evaluate` | 执行只读 JavaScript 表达式。 |
| `browser_tabs` | 列出、切换、关闭标签页。 |
| `browser_close` | 关闭共享浏览器进程。 |

一个懒启动的 Chromium 服务所有调用。

## 侧边栏镜像

DSH 桌面版自带右侧栏的「浏览器」标签（`@deepseek-ai/dsh-client-ui-sidebar-browser`）。本插件把智能体当前所在的页面镜像进去：自动化浏览器保持无头，右侧栏自带的浏览器标签跟着智能体走，于是你不用再多开一个浏览器窗口就能看着它运行。

| 部分 | 作用 |
| --- | --- |
| [lib/browser.js](./lib/browser.js) | 启动无头浏览器，并通过 `browserState()` 发布当前页面。 |
| [lib/mirror.js](./lib/mirror.js) | 在 `webServer` 服务上注册 `POST /browser-use/state`。用 `ctx.inject(['webServer'], …)` 挂载，所以无头宿主只有工具、没有桥。 |
| [lib/client.js](./lib/client.js) | 网页半边（`dsh.client.platform: web`、`exports["./client"]`）：轮询状态，并用 `ctx.sidebarRight.openTab('browser', { params: { url } })` 驱动内置的浏览器标签类型。 |

一次浏览器会话只开一个浏览器标签，之后每次换页都在原位替换，右侧栏始终只有一个跟着智能体走的标签。没有侧边栏浏览器的 profile 只有工具，什么都不镜像。

| 环境变量 | 作用 |
| --- | --- |
| `DSH_BROWSER_HEADLESS=false` | 额外再开一个可见浏览器窗口。默认无头。 |
| `DSH_BROWSER_CHANNEL` | 固定启动 channel（`chrome`、`msedge` 等），不走回退顺序。 |

侧边栏浏览器是**自己加载这个 URL**：它显示智能体在哪里，但不显示自动化浏览器里的输入、滚动和表单填写。它也无法取代自动化浏览器——这个标签类型面向用户，不注册任何工具。

## 已知限制

- 没有面向智能体的内置浏览器：DSH 桌面版的侧边栏浏览器是给用户用的，不注册工具，所以自动化仍然走 Playwright。没有 Chrome 扩展后端，也不能选择 CDP 后端。
- 不支持文件上传、视频录制、坐标点击（`cua`/`dom_cua`）。
- `browser_evaluate` 按文档只做只读检查，插件不做强制，请遵守技能里的规则。
- 没有执行 `npx playwright install chromium` 时，所有浏览器工具都会以可操作的错误信息失败。
- 侧边栏镜像只跟随 URL；自动化浏览器里的页内操作不会反映到侧边栏标签。
- 镜像需要 DSH 桌面版的侧边栏浏览器（普通网页 profile 会禁用），且要等 DSH 重新加载 profile 后才出现。
