# dsh-zcode-plugins

English | [中文](README.zh.md)

Unofficial DeepSeek Harness ports of the ZCode built-in plugins that DSH does not already ship, plus one original plugin. DSH already provides `office-docx`, `office-pptx`, and `office-xlsx` skills, so this repo covers the three remaining capabilities and adds a keyless image search that needs no ZCode account.

| Package | Ports | License | Upstream handling |
| --- | --- | --- | --- |
| [`dsh-zcode-pdf`](./packages/pdf) | ZCode `pdf` plugin | MIT | Clean-room reimplementation; upstream is proprietary |
| [`dsh-zcode-browser-use`](./packages/browser-use) | ZCode `browser-use` plugin | MIT | Skills and docs copied verbatim; transport reimplemented with Playwright |
| [`dsh-zcode-image-search`](./packages/image-search) | ZCode `image-search` plugin | Apache-2.0 | MCP declaration copied verbatim; wired through the DSH MCP client |
| [`dsh-reverse-image-search`](./packages/reverse-image-search) | — (original, not a port) | MIT | Search **by image** (reverse image search) through Baidu 识图; no API key and no proxy |

Each package is an ordinary DSH bundle: a `package.json` declaring `dsh.bundle.patch` plus a `cordis.patch.yml` layer.

## Install

Pack each package and install the tarball. Installing the package directory with a link works too, but then pnpm does not install the browser package's `playwright` dependency, so a tarball is the supported local path:

```sh
cd dsh-zcode-plugins
mkdir -p dist
for p in pdf browser-use image-search reverse-image-search; do (cd packages/$p && npm pack --pack-destination ../../dist); done

dsh plugin --profile <profile> add ./dist/dsh-zcode-pdf-0.1.0.tgz
dsh plugin --profile <profile> add ./dist/dsh-zcode-browser-use-0.6.0.tgz
dsh plugin --profile <profile> add ./dist/dsh-zcode-image-search-0.1.1.tgz
dsh plugin --profile <profile> add ./dist/dsh-reverse-image-search-0.1.0.tgz
```

Keep `dist/` after installing: the profile records the tarball paths, so deleting them breaks a later `pnpm install` in that profile.

Verify the composed layers without booting:

```sh
dsh --profile <profile> --dump-config
```

The browser package additionally needs Chromium once per machine (`npx playwright install chromium`); the image-search package needs `ZCODE_BASE_URL` and `ZCODE_JWT_TOKEN`.

## Provenance

All three packages port plugins shipped inside ZCode 3.14.3 at `/Applications/ZCode.app/Contents/Resources/glm/packages/`. Each package carries a `NOTICE` naming the upstream version, license, and every change made for DSH. The browser and image-search packages ship the upstream files verbatim alongside the DSH wiring.

## Verification

```sh
node scripts/check.mjs           # frontmatter, patch, layout, syntax checks
node scripts/verify-plugins.mjs  # load every plugin against the real DSH registries
node scripts/verify-browser-sidebar.mjs  # real Chromium + the sidebar mirror logic
```

Runtime verification commands live in each package README; they cover the PDF scripts, the browser tools against a real Chromium, and bundle installation into a scratch profile.
