---
name: pdf
description: "Professional PDF toolkit covering four production workflows — reports, creative visuals, academic LaTeX, and existing-PDF processing. Use for any task whose output is a PDF: Office to PDF (.docx/.doc/.pptx/.ppt/.xlsx/.xls/.odt/.rtf/.csv/.txt), HTML to PDF, LaTeX/.tex to PDF, and for reading a PDF apart (PDF to images, text, or tables). Trigger when the user asks to convert, export, render, print, or turn a file into a PDF, or to merge, split, rotate, fill, or extract from an existing one — including 'Word转PDF', 'PPT转PDF', 'Excel转PDF', 'html转pdf', '导出为PDF', 'save/export as PDF', and 'PDF转图片/文字'."
metadata:
  author: dsh-zcode-plugins
  version: "0.1.0"
  upstream: "ZCode pdf-plugin 0.1.7 (proprietary); reimplemented for DeepSeek Harness"
---

# PDF — document production workbench

Work in the task workspace. Treat this skill directory and the DSH runtime as read-only resources: copy templates out before editing them, and never write deliverables next to the scripts.

## Pick the route first

| The request | Route | Tool |
| --- | --- | --- |
| Report, resume, cover letter, policy document | Report | `scripts/report.py` (ReportLab) |
| Poster, one-page visual, cover art, infographic | Creative | `scripts/html2pdf.mjs` (Chromium) |
| Paper, thesis, anything already written in LaTeX | Academic | Tectonic, then verify |
| Merge, split, rotate, extract, fill a form, inspect | Process | `scripts/pdf.py` (pypdf; pdfplumber / PyMuPDF optional) |
| Any Office file or HTML that must become PDF | Conversion | `scripts/office2pdf.mjs` (LibreOffice kit) |

When a request spans routes, produce one deliverable per requested artifact rather than merging unrelated documents into one file.

## Environment

1. Call `load_workspace_dependencies` and use the returned Python and Node paths. Do not install or discover another interpreter.
2. Run the dependency check once per task:

   ```sh
   <python> <skill-directory>/scripts/pdf.py env.check
   ```

3. Only when the check reports missing packages, install the **core** set into that interpreter:

   ```sh
   <python> <skill-directory>/scripts/pdf.py env.fix
   ```

   The core set is pure Python — `reportlab` and `pypdf` — and installs safely into the harness interpreter. It covers the Report route and every process operation except tables and page rendering. If the user has forbidden environment changes, stop and report the missing packages instead.

**Optional dependencies.** Install these only on demand, after asking the user:

- **Table extraction and page rendering** need native extensions (`pdfplumber`, `PyMuPDF`). A hardened harness interpreter can refuse to load native wheels, so build the dedicated environment once:

  ```sh
  <python> <skill-directory>/scripts/pdf.py env.venv
  ```

  Its JSON result names the interpreter to use for `extract-tables` and `render-images` from then on. Rendering pages through `office2pdf.mjs --to images` needs no Python extension at all.
- **LibreOffice kit** for the conversion route — `dsh plugin --profile <profile> add @deepseek-ai/libreoffice-kit`, about 150 MB installed. A deployment that already ships the kit is found automatically, or through `DSH_LIBREOFFICE_KIT`.
- **Chromium via Playwright** for the Creative route and HTML to PDF — the plugin falls back to an installed Google Chrome or Microsoft Edge, and only needs `npx playwright install chromium` when neither exists.
- **Tectonic** for the Academic route — a large download with a long first-run package fetch.

Never install an optional tool speculatively, and never claim a route works without its dependency.

## Report route

Author the document as Markdown, then render it:

```sh
<python> <skill-directory>/scripts/report.py --input report.md --out report.pdf \
  --title "Quarterly review" --subtitle "Platform engineering" --author "A. Analyst"
```

Supported syntax: `#`/`##`/`###` headings, paragraphs, `-` and `1.` lists, pipe tables, `>` quotes, fenced code, `---` page break, and inline `**bold**`, `*italic*`, `\`code\``. Chinese, Japanese, and Korean text switches to the built-in STSong-Light CID font automatically; pass `--font <file.ttf>` to embed a font the user supplied or asked for.

See [briefs/report.md](briefs/report.md) for the content and layout checklist.

## Creative route

Write a self-contained HTML file with real CSS (absolute positioning or grid, explicit page size via `@page`), load any local font or image by relative path, then print it:

```sh
<node> <skill-directory>/scripts/html2pdf.mjs --input poster.html --out poster.pdf \
  --format A3 --margin 0 --wait-ms 300
```

The renderer loads the page in Chromium, waits for your selector or delay, switches to print media, and honours `@page`. Use `--url` for a running local dev server and `--wait-selector "#ready"` when the layout depends on client-side rendering.

See [briefs/creative.md](briefs/creative.md) for the visual checklist.

## Academic route

LaTeX sources are the user's; do not rewrite their class or bibliography system. Compile with Tectonic when it is present:

```sh
tectonic -X compile main.tex --outdir <dir>
```

Tectonic downloads packages on first use. If it is unavailable and the user has not authorized installing it, report that limit; do not substitute a different engine and do not silently degrade the document. See [briefs/academic.md](briefs/academic.md).

## Conversion route

Any Office document or HTML that must become a PDF goes through the bundled LibreOffice engine:

```sh
<node> <skill-directory>/scripts/office2pdf.mjs --input input.docx --out output.pdf
<node> <skill-directory>/scripts/office2pdf.mjs --input deck.pptx --to images --out-dir pages/
```

Use it instead of a system LibreOffice, and instead of the Report route, whenever the source document already exists. Spreadsheet recalculation before export uses `--recalculate` (xlsx/ods only); a single sheet exports with `--sheet "<name>"`. Conversion is one-way: never edit the source file, and never write the output over the input.

## Process route

Inspect before changing anything:

```sh
<python> <skill-directory>/scripts/pdf.py info input.pdf
<python> <skill-directory>/scripts/pdf.py extract-text input.pdf --out text.txt
<python> <skill-directory>/scripts/pdf.py extract-tables input.pdf --out-dir tables/
<python> <skill-directory>/scripts/pdf.py merge --out merged.pdf a.pdf b.pdf c.pdf
<python> <skill-directory>/scripts/pdf.py split input.pdf --out-dir split/ --pages 1-3
<python> <skill-directory>/scripts/pdf.py rotate input.pdf --out rotated.pdf --angle 90 --pages 1
<python> <skill-directory>/scripts/pdf.py fill-form form.pdf --out filled.pdf --data values.json
```

Write to a new file. Replace the original only when the user explicitly asks, and make a backup beside it first — never in a temporary directory.

See [briefs/process.md](briefs/process.md).

## Visual check and delivery

Routine structural success is not visual success. Render pages to PNG and look at them before delivering anything whose appearance matters:

```sh
<python> <skill-directory>/scripts/pdf.py render-images output.pdf --out-dir qa/ --dpi 120
```

Then read the PNGs with the image tool and check the specific risks for the route: clipping, overlap, orphaned headings, broken tables, missing glyphs (tofu boxes), and page count. A programmatic check that passes does not replace looking. If rendering is impossible, say so and describe what remains unverified instead of claiming the document is clean.

Before finishing:

- Reopen the deliverable with `pdf.py info` and confirm page count and size.
- Confirm every requested artifact exists at the path you report.
- State which checks ran and which could not run.
- Do not represent ordinary edits as tracked changes, and do not claim a PDF is editable Word content.

## Failure handling

- Missing package: report the exact package and the command that installs it; do not silently skip the step.
- Conversion refused (`unsupported-format`, `invalid-document`): report the engine's code and the input type; do not retry a different engine.
- Font problems: report the missing glyph coverage; do not install fonts without the user's confirmation.
- Never fabricate content to make a document look complete. When source material is missing, say which part is stubbed.
