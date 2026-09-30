# dsh-zcode-pdf

[English](README.md) | 中文

DeepSeek Harness 的 PDF 制作技能，按 ZCode 内置 **pdf** 插件的能力边界重写实现。覆盖四条路线：报告、创意视觉、学术 LaTeX、既有 PDF 处理；Office 文档转换走 DSH 自带的 LibreOffice 引擎。

上游技能是专有许可，因此本包是净室重写：只把工作流与能力边界当作规格，未复制上游任何文本、脚本、模板或资产。详见 [NOTICE](./NOTICE)。

## 路线

| 路线 | 工具 | 依赖 |
| --- | --- | --- |
| 报告（报告、简历、封面信） | [`scripts/report.py`](./skills/pdf/scripts/report.py) | `reportlab` |
| 创意（海报、视觉稿） | [`scripts/html2pdf.mjs`](./skills/pdf/scripts/html2pdf.mjs) | Playwright + Chromium |
| 学术（LaTeX） | Tectonic | Tectonic（可选） |
| 处理（合并、拆分、提取、填表） | [`scripts/pdf.py`](./skills/pdf/scripts/pdf.py) | `pypdf`；表格与页面图像另需 `pdfplumber` / `PyMuPDF` |
| 转换（Office 或 HTML 转 PDF） | [`scripts/office2pdf.mjs`](./skills/pdf/scripts/office2pdf.mjs) | `@deepseek-ai/libreoffice-kit` |

## 安装

```sh
dsh plugin --profile <profile> add ./packages/pdf
```

技能注册名为 `pdf`。核心 Python 包按需装进 harness 解释器：

```sh
<python> <skill-directory>/scripts/pdf.py env.check
<python> <skill-directory>/scripts/pdf.py env.fix
```

Office 转换还需要 LibreOffice 引擎，按需作为普通 profile 依赖安装（约 150 MB）：

```sh
dsh plugin --profile <profile> add @deepseek-ai/libreoffice-kit
```

部署里已经带该引擎时会自动找到，也可以用 `DSH_LIBREOFFICE_KIT` 指向引擎包目录。Chromium（装了 Google Chrome 或 Microsoft Edge 会自动复用）与 Tectonic 保持可选，只在任务需要时安装。

## 设计说明

- `office2pdf.mjs` 使用 `@deepseek-ai/libreoffice-kit`，Office 转换不需要系统 LibreOffice。
- `html2pdf.mjs` 通过 Chromium 打印，保留真实 CSS 布局并遵循 `@page`。
- `report.py` 接受 Markdown 子集（标题、列表、管道表格、引用、围栏代码、分页、行内强调），中文自动切换到 CJK CID 字体。
- `pdf.py` 一律写新文件并复查结果；不解密、不覆盖输入。
- 核心 Python 包是纯 Python（`reportlab`、`pypdf`），可以装进 harness 解释器。表格提取与页面渲染需要原生扩展，加固过的解释器可能拒绝加载；`pdf.py env.venv` 会建一个专用环境并打印要使用的解释器。

## 已知限制

- `@deepseek-ai/libreoffice-kit` 是由 DSH 部署提供的 peer 依赖；缺失时转换路线会给出可操作的报错。
- Tectonic 未内置，首次运行下载量大。
- 本技能是上游路线的重写实现，上游专有模板与提示词不可用。
