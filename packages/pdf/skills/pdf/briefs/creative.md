# Creative brief

Use for posters, covers, one-page visuals, and infographics. These are laid out in HTML and printed by Chromium, so the browser's own layout engine is the source of truth.

## Authoring

1. One self-contained HTML file. Inline the CSS; reference fonts and images by relative path from the file's directory or embed them.
2. Set the page explicitly:
   - `@page { size: A4; margin: 0 }` for the printed page.
   - A fixed-size root element (`width: 210mm; height: 297mm; position: relative`) so the composition does not reflow.
3. Position with absolute coordinates or CSS grid. Keep a 12 mm safe margin inside the page; anything closer risks printer trimming.
4. Set an explicit font stack. A CJK design needs a CJK family, and the glyphs must exist on this machine — check before finalizing.
5. Prefer vector and CSS for shapes. Raster art must be large enough for the print resolution: at 150 dpi an A4 full-bleed image needs roughly 1750 px of width.

## Print fidelity

- Add `-webkit-print-color-adjust: exact` and `print-color-adjust: exact` so backgrounds survive the print pipeline.
- Avoid `position: fixed` and viewport units; print layout has its own page box.
- Render once, look at the PNG, fix, and re-render. Do not deliver an unviewed poster.

## Check before delivery

- Everything that should be visible is inside the page box: run `render-images` and look.
- No text is clipped by an overflowing container.
- Contrast between text and its background is legible in greyscale as well as colour.
- If a font was requested but is unavailable, report the substitution rather than shipping a different look silently.
