# Visual acceptance reference

Run this after every render, before reporting completion.

## Evidence

Render the pages to PNG (`pdf.py render-images --dpi 120`) and read them with the image tool. Name the pages you inspected and what you saw. A structural check (`info`, ZIP/XML validity, a clean compile log) is supporting evidence, not the visual gate.

## Look for

| Risk | What it looks like |
| --- | --- |
| Clipping | Text or artwork cut off at a page or container edge |
| Overlap | Two elements occupying the same pixels |
| Orphan | A heading alone at the bottom of a page |
| Split table | A table broken without a repeated header |
| Tofu | Empty boxes where glyphs are missing |
| Reflow | A layout that shifts between the HTML preview and the PDF |
| Colour loss | Backgrounds or rules dropped by the print pipeline |

## Verdict

For each inspected page, record pass or fail with the specific evidence. A failed page is repaired and re-rendered; a page you did not inspect is reported as unverified, never as passed.
