# dsh-zcode-browser-use

[English](README.md) | 中文

ZCode 内置 **浏览器操作（browser-use）** 插件的非官方 DeepSeek Harness 移植版：Playwright 驱动的无头浏览器工具，**外加一个插件自己的真浏览器——就挂在 DSH 侧边栏里**，独立进程、独立 Cookie、可被模型驱动作、也可被用户直接接管；再加上 ZCode 的 `control-browser` 与 `web-gui-tester` 技能。

## 上游信息

| 上游 | 值 |
| --- | --- |
| ZCode 插件 | `browser-use` 0.5.1，MIT，作者 Z.ai |
| 传输层 | `node_repl` MCP 服务，暴露一个 `js` 工具（`mcp__node_repl__js`），底层是 ZCode 的 `agent.browsers` 注册表 |
| 后端 | 桌面内置浏览器（IAB）、Chrome 扩展、CLI 托管的无头 CDP |
| 原样照搬 | [skills/control-browser/SKILL.md](./skills/control-browser/SKILL.md)、[skills/web-gui-tester/SKILL.md](./skills/web-gui-tester/SKILL.md)、[docs/](./docs)、[upstream-README.md](./upstream-README.md) |
| 本移植新增 | [lib/browser.js](./lib/browser.js)、[lib/tools.js](./lib/tools.js)、[lib/own.js](./lib/own.js)、[lib/own-tools.js](./lib/own-tools.js)、[lib/live.js](./lib/live.js)、[lib/mirror.js](./lib/mirror.js)、[lib/client.js](./lib/client.js)、[index.js](./index.js) |

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

上面这些跑在**无头** Chromium 里：快、好脚本化，也**一眼就是自动化**。需要登录、需要过人机校验、或者需要用户搭把手的站点，用下面这一组。

### 自有浏览器（侧边栏里那个真浏览器）

| 工具 | 用途 |
| --- | --- |
| `own_browser_open` | 在 DSH 侧边栏打开插件自己的浏览器（真实 Chromium guest，独立 Cookie）。 |
| `own_browser_status` | 看它是否打开、当前在哪个页面。只读。 |
| `own_browser_navigate` | 让它打开一个地址。 |
| `own_browser_snapshot` | 读取页面：地址、标题、可见文本、可寻址元素（ref/role/name/value）。 |
| `own_browser_click` | 点击元素。走**真实指针事件**，不是合成的 DOM 事件。 |
| `own_browser_type` | 填写输入框，可用 Enter 提交。走真实键盘事件。 |
| `own_browser_press` | 按一个键，例如 Enter、Escape、Control+A。 |
| `own_browser_screenshot` | 把它的画面存成 PNG。 |

## 自有浏览器是怎么接上侧边栏的

它**不用** DSH 自带的「浏览器」标签页，也**不用**那个浏览器。它自己注册一个侧边栏标签类型，正文里挂**自己的** `<webview>`：

| 部分 | 作用 |
| --- | --- |
| [lib/own.js](./lib/own.js) | 宿主半：命令队列与三条路由（`/browser-use/own/command`、`/result`、`/status`），注册在 `webServer` 上。 |
| [lib/own-tools.js](./lib/own-tools.js) | `own_browser_*` 这组工具。 |
| [lib/client.js](./lib/client.js) | 网页半：注册标签类型与正文，先向桌面桥租一个 guest 再挂载 webview，长轮询取命令并执行。 |

### 关键：webview 必须先向主进程租一个 guest

DSH 主进程对**每一个**要挂上来的 webview 都设了闸：

```js
// DesktopBrowserGuests.bind(mainWindow, ...)
owner.on("will-attach-webview", (event, preferences, params) => {
  const lease = this.leases.get(id);
  if (lease === undefined || lease.owner !== owner
      || lease.attached || params.partition !== lease.partition) {
    event.preventDefault();      // 没有租约 → 拒绝挂载，guest 永远不会出现
    return;
  }
  ...
});
```

`did-attach-webview` 还会从 URL 里核对租约 id（`about:blank#<lease>`），认不出就把 guest 关掉。所以**裸建一个 `<webview>` 是拿不到 guest 的**：元素在 DOM 里，但每个 guest 方法都报 "The WebView must be attached to the DOM and the dom-ready event emitted"。

租约从公开的桌面桥拿，然后照 DSH 自己的方式挂载：

```js
const reservation = await window.dshDesktop.browser.acquire(WORKSPACE_KEY);
element.setAttribute("name", reservation.lease);
element.setAttribute("partition", reservation.partition);
element.setAttribute("src", "about:blank#" + reservation.lease);
```

这条桥（`dshDesktop.browser`，`protocolVersion: 1`）对 `dsh-app://app` 主框架开放，而插件的 client 代码跑的正是这个 frame——主进程的 `assertProductSender` 校验的是 frame/origin，**不是包身份**。拿到租约后主进程照旧执行 `configureSession()` 全套加固（权限/下载/popup 全禁、应用自身 origin 阻断），所以安全性没有被削弱，走的是同一个闸门。

### 三条关键事实

1. **它是真浏览器，不是无头。** Electron 的 webview guest 是独立的 Chromium 进程，`navigator.webdriver` 为 false，没有 HeadlessChrome 那种指纹。
2. **它能被注入可信输入。** `<webview>.sendInputEvent()` 是官方 API（见 Electron 文档 `webview-tag`），走浏览器真实输入管线；而 `dispatchEvent` 造出来的是 `isTrusted === false` 的合成事件，风控一试就知道。
3. **它有自己的会话。** 分区由主进程按 workspace 分配（`dsh-sidebar-browser-<uuid>`），与 DSH 自带的侧边栏浏览器、与无头浏览器都互不干扰。

你仍然可以直接在侧边栏里点它、在它里面打字——那是真人的真输入，**滑块、扫码登录这类必须由人做的事，你自己做**，做完模型接着用同一个浏览器往下跑。

> ⚠️ 租约只在该次运行内有效：主进程每次启动都会重新分配随机分区，**登录态不跨 DSH 重启保留**——这一点与 DSH 自带的侧边栏浏览器一致。

## 侧边栏实时视图（可选，默认不自动打开）

DSH 桌面版自带右侧栏的「浏览器」标签（`@deepseek-ai/dsh-client-ui-sidebar-browser`）。本插件在那个标签里打开**自己的**页面，实时显示自动化浏览器——**不是**把标签指到智能体所在的 URL。

| 部分 | 作用 |
| --- | --- |
| [lib/browser.js](./lib/browser.js) | 启动无头浏览器；`getPage()` 供工具使用，`peekPage()` 供只读视图使用（**绝不**启动浏览器）。 |
| [lib/live.js](./lib/live.js) | 在**独立 loopback 端口**上提供实时视图：`/` 是投屏页，`/frame` 出一帧 JPEG，`/input` 把鼠标/键盘回放到 Playwright 页面，`/state` 报告当前页。 |
| [lib/mirror.js](./lib/mirror.js) | 在 `webServer` 服务上注册 `POST /browser-use/state`，返回页面信息与实时视图地址。用 `ctx.inject(['webServer'], …)` 挂载，所以无头宿主只有工具、没有桥。 |
| [lib/client.js](./lib/client.js) | 网页半边（`dsh.client.platform: web`、`exports["./client"]`）：轮询状态，并用 `ctx.sidebarRight.openTab('browser', { params: { url } })` 打开**实时视图地址**。 |

**为什么不把标签直接指到智能体所在的 URL**：那个标签是**另一个浏览器**，有自己的 Cookie。指到一个需要登录的站点，它只会显示登录页——而智能体在无头 Chromium 里已经是登录态，两边永远对不上。打开我们自己端口上的页面就没这个问题：侧边栏只跟本进程说话，不需要在侧边栏里登录任何东西。

**为什么不用 `webServer` 自己的端口**：侧边栏的地址校验会拒绝「DSH 应用自身 origin」，所以挂在 `webServer` 上的页面在侧边栏里永远打不开。

**为什么单开一个 HTTP 服务而不是塞进 `<webview>`**：投屏只需要一张 `<img>`，Web（iframe）与 Desktop（webview）两种载体都能画，不需要额外权限。

实时视图绑定 `127.0.0.1`。它把智能体的浏览器暴露给任何能访问该端口的本机进程——**不要扩大绑定范围**。

一次浏览器会话只开一个标签，且**不再随换页替换**：实时视图地址是稳定的，标签打开一次就一直在。没有侧边栏浏览器的 profile 只有工具，什么都不镜像。

| 环境变量 | 作用 |
| --- | --- |
| `DSH_BROWSER_HEADLESS=false` | 额外再开一个可见浏览器窗口。默认无头。 |
| `DSH_BROWSER_CHANNEL` | 固定启动 channel（`chrome`、`msedge` 等），不走回退顺序。 |
| `BROWSER_USE_LIB` | 只给 `scripts/verify-browser-live.mjs` 用：指定被测的 `lib/` 位置。 |

画面来自自动化浏览器本身，所以智能体的输入、滚动、表单填写**都看得见**；反过来，你在画面上点一下、打个字、滚一下滚轮，事件会回放到同一个浏览器——**你可以随时接管**。帧是逐张拉的（上一张加载完才请求下一张），页面慢时自动降速，不会堆积。

## 已知限制

- DSH 桌面版自带的侧边栏浏览器**不注册工具**，所以插件不复用它；自有浏览器是自己注册标签类型 + 自渲染 webview 实现的。没有 Chrome 扩展后端，也不能选择 CDP 后端。
- **自有浏览器只在本机 Electron 上存在**：Web profile 是 iframe 载体，挂不了 webview，此时 `own_browser_*` 会明确报错。
- **登录态不跨重启保留**：主进程按次运行分配随机分区（`dsh-sidebar-browser-<uuid>`），DSH 重启后需要重新登录。要跨重启保持，得让 DSH 上游支持固定分区名。
- 自有浏览器的 `own_browser_snapshot` 走 `executeJavaScript` 读 DOM，拿不到跨域 iframe 内部的内容；`click`/`type` 先要能在页面里找到那个元素。
- 不支持文件上传、视频录制、坐标点击（`cua`/`dom_cua`）。
- `browser_evaluate` 按文档只做只读检查，插件不做强制，请遵守技能里的规则。
- 没有执行 `npx playwright install chromium` 时，所有浏览器工具都会以可操作的错误信息失败。
- **投屏不改变指纹。** 无头 Chromium 过不了的反爬/滑块验证，投屏之后照样过不了——反爬看的是浏览器指纹，不是「有没有人看着」。要过滑块只能让 Playwright 起**有头的真 Chrome**（`channel: "chrome"` 且 `DSH_BROWSER_HEADLESS=false`），代价是多一个真窗口。
- **帧率**：loopback 上大约 5~15fps，看页面够用，拖拽类操作（滑块、拖选）会有点顿。
- **实时视图端口对本机可见**：它只绑 `127.0.0.1`，但本机上的任何进程都能连。别把它当成鉴权边界。
- 侧边栏投屏需要 DSH 桌面版的侧边栏浏览器（普通网页 profile 会禁用），且要等 DSH 重新加载 profile 后才出现。
