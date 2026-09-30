# dsh-zcode-plugins

[English](README.md) | 中文

ZCode 内置插件中 DSH 尚未提供的那部分，非官方移植；另含一个原创插件。DSH 已经有 `office-docx`、`office-pptx`、`office-xlsx` 技能，所以本仓库补齐剩下三项能力，并额外提供一个不需要 ZCode 账号的无 key 搜图。

| 包 | 移植对象 | 许可证 | 上游处理方式 |
| --- | --- | --- | --- |
| [`dsh-zcode-pdf`](./packages/pdf) | ZCode `pdf` 插件 | MIT | 净室重写；上游是专有许可 |
| [`dsh-zcode-browser-use`](./packages/browser-use) | ZCode `browser-use` 插件 | MIT | 技能与文档原样照搬；传输层用 Playwright 重写 |
| [`dsh-zcode-image-search`](./packages/image-search) | ZCode `image-search` 插件 | Apache-2.0 | MCP 声明原样照搬；通过 DSH MCP 客户端接线 |
| [`dsh-reverse-image-search`](./packages/reverse-image-search) | —（原创，非移植） | MIT | **以图搜图**（百度识图）；无需 API key 与代理 |

每个包都是标准 DSH bundle：`package.json` 声明 `dsh.bundle.patch`，再加一层 `cordis.patch.yml`。

## 安装

先把每个包打成 tarball 再安装。用 link 方式装目录也可以，但那样 pnpm 不会安装浏览器包的 `playwright` 依赖，所以本地安装以 tarball 为准：

```sh
cd dsh-zcode-plugins
mkdir -p dist
for p in pdf browser-use image-search reverse-image-search; do (cd packages/$p && npm pack --pack-destination ../../dist); done

dsh plugin --profile <profile> add ./dist/dsh-zcode-pdf-0.1.0.tgz
dsh plugin --profile <profile> add ./dist/dsh-zcode-browser-use-0.6.0.tgz
dsh plugin --profile <profile> add ./dist/dsh-zcode-image-search-0.1.1.tgz
dsh plugin --profile <profile> add ./dist/dsh-reverse-image-search-0.1.0.tgz
```

安装后请保留 `dist/`：profile 里记录的是 tarball 路径，删掉会让该 profile 之后的 `pnpm install` 失败。

不启动也能检查合成后的层：

```sh
dsh --profile <profile> --dump-config
```

浏览器包每台机器还需要装一次 Chromium（`npx playwright install chromium`）；搜图包需要 `ZCODE_BASE_URL` 与 `ZCODE_JWT_TOKEN`。

## 来源

三个包都移植自 ZCode 3.14.3 内置插件（`/Applications/ZCode.app/Contents/Resources/glm/packages/`）。每个包都有 `NOTICE`，写明上游版本、许可证与所有为 DSH 做的改动。浏览器与搜图包把上游文件原样随包提供，与 DSH 接线代码并列。

## 验证

```sh
node scripts/check.mjs                   # frontmatter、patch 与目录结构检查
node scripts/verify-plugins.mjs          # 用真实 DSH 注册表加载每个插件
node scripts/verify-browser-sidebar.mjs  # 真实 Chromium + 侧边栏镜像逻辑
```

运行期验证命令写在每个包的 README 里，覆盖 PDF 脚本、真实 Chromium 上的浏览器工具，以及把 bundle 安装进临时 profile。
