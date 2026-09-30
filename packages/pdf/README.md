# dsh-zcode-pdf

English | [中文](README.zh.md)

A DeepSeek Harness PDF production skill, reimplemented from the capability set of the ZCode built-in **pdf** plugin. It covers four routes — reports, creative visuals, academic LaTeX, and existing-PDF processing — and converts Office documents through DSH's own LibreOffice engine.

The upstream skill is proprietary, so this package is a clean-room reimplementation: the workflow and capability boundary were used as a specification, and no upstream text, script, template, or asset was copied. See [NOTICE](./NOTICE).

## Routes

| Route | Tool | Dependency |
| --- | --- | --- |
| Report (report, resume, cover) | [`scripts/report.py`](./skills/pdf/scripts/report.py) | `reportlab` |
| Creative (poster, visual) | [`scripts/html2pdf.mjs`](./skills/pdf/scripts/html2pdf.mjs) | Playwright + Chromium |
| Academic (LaTeX) | Tectonic | Tectonic, optional |
| Process (merge, split, extract, fill) | [`scripts/pdf.py`](./skills/pdf/scripts/pdf.py) | `pypdf`; `pdfplumber` / `PyMuPDF` for tables and page images |
| Conversion (Office or HTML to PDF) | [`scripts/office2pdf.mjs`](./skills/pdf/scripts/office2pdf.mjs) | `@deepseek-ai/libreoffice-kit` |

## Install

```sh
dsh plugin --profile <profile> add ./packages/pdf
```

The skill registers as `pdf`. Its core Python packages install on demand into the harness interpreter:

```sh
<python> <skill-directory>/scripts/pdf.py env.check
<python> <skill-directory>/scripts/pdf.py env.fix
```

Office conversion additionally needs the LibreOffice engine, installed on demand as a plain profile dependency (about 150 MB):

```sh
dsh plugin --profile <profile> add @deepseek-ai/libreoffice-kit
```

A deployment that already ships the kit is found automatically, or through `DSH_LIBREOFFICE_KIT` pointing at the kit package directory. Chromium (an installed Google Chrome or Microsoft Edge is reused automatically) and Tectonic stay optional and are installed only when a task needs them.

## Design notes

- `office2pdf.mjs` uses `@deepseek-ai/libreoffice-kit`, so Office conversion needs no system LibreOffice.
- `html2pdf.mjs` prints through Chromium, which keeps real CSS layout and honours `@page`.
- `report.py` accepts a Markdown subset (headings, lists, pipe tables, quotes, fenced code, page breaks, inline emphasis) and switches to a CJK CID font automatically.
- `pdf.py` always writes a new file and re-inspects the result; it never strips encryption and never overwrites the input.
- The core Python packages are pure Python (`reportlab`, `pypdf`) so they install into the harness interpreter. Table extraction and page rendering need native extensions, which a hardened interpreter can refuse to load; `pdf.py env.venv` builds a dedicated environment and prints the interpreter to use.

## Known limitations

- `@deepseek-ai/libreoffice-kit` is an optional peer installed on demand; without it the conversion route reports the exact install command.
- Tectonic is not bundled and is a large first-run download.
- The skill reimplements the upstream routes, so upstream-specific templates and prompts are not available.
