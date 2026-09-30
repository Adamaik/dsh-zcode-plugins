# Environment setup

The PDF skill runs against the interpreter the harness reports for this workspace. Call `load_workspace_dependencies` and use its Python and Node paths; they already carry LibreOffice-free base libraries and are the supported runtime.

## Core Python packages

```sh
<python> <skill-directory>/scripts/pdf.py env.check
<python> <skill-directory>/scripts/pdf.py env.fix
```

`env.check` reports each package and exits non-zero when a core package is missing. `env.fix` pip-installs only the missing core packages:

| Package | Used by | Kind |
| --- | --- | --- |
| `reportlab` | Report route (`report.py`) | pure Python |
| `pypdf` | info, merge, split, rotate, text extraction, embedded images, form filling | pure Python |

Installing packages changes the shared runtime. Do that only when the check fails and the user has not forbidden environment changes.

## Optional native packages

`pdfplumber` (tables) and `PyMuPDF` (page rendering to PNG) ship native extensions. A hardened interpreter can refuse to load a wheel signed by another team, which surfaces as an `ImportError` mentioning code signature or Team ID. Build the dedicated environment instead:

```sh
<python> <skill-directory>/scripts/pdf.py env.venv
```

It creates `$PDF_VENV` (default `$DSH_HOME/pdf-runtime`) from `PDF_BASE_PYTHON`, `python3` on PATH, or the invoking interpreter, installs all four packages, and prints the interpreter to use for `extract-tables` and `render-images`. Rendering pages through `office2pdf.mjs --to images` avoids Python extensions entirely.

## Optional, install on demand only

| Tool | Enables | Install |
| --- | --- | --- |
| `@deepseek-ai/libreoffice-kit` | Conversion route (`office2pdf.mjs`): Office and HTML to PDF, page images | `dsh plugin --profile <profile> add @deepseek-ai/libreoffice-kit` (about 150 MB) |
| Chromium via Playwright | Creative route and HTML to PDF (`html2pdf.mjs`) | An installed Google Chrome or Microsoft Edge is used automatically; otherwise `npx playwright install chromium` |
| `DSH_BROWSER_CHANNEL` | Pins the browser channel for both printing and the browser-use plugin | Environment variable, not an install |
| Tectonic | Academic LaTeX route | Platform package manager, or the official installer |

All are large downloads. Ask first, and never install them speculatively.

`office2pdf.mjs` resolves the LibreOffice kit in this order: `DSH_LIBREOFFICE_KIT` (a path to the kit package directory or its `lib/index.js`), then the normal `@deepseek-ai/libreoffice-kit` import. Point the variable at a kit the deployment already ships instead of installing a second copy.

## Node-based scripts

`office2pdf.mjs` needs the plugin's `@deepseek-ai/libreoffice-kit` dependency, which installs with the plugin; the bundled engine is the only supported LibreOffice. `html2pdf.mjs` needs `playwright` plus the Chromium build above.
