# Typesetting reference

Defaults that are safe without a stated design requirement.

| Element | Value |
| --- | --- |
| Body size | 10–11 pt, 1.4–1.6 line height |
| Measure | 60–80 characters per line; widen margins before shrinking type |
| Margins | 18–25 mm; never below 12 mm |
| Heading scale | 1.5× / 1.25× / 1.1× of body size, tighter leading than body |
| Paragraph spacing | 0.5–0.8 of the body size, and either spacing or indent — not both |
| Table cell padding | 4–6 pt vertical, 6 pt horizontal, top-aligned |
| Accent colour | one accent plus neutrals; body text stays near-black |

## Emphasis with CID fonts

The built-in CJK CID font is a single-weight face: `**bold**` and `*italic*` render with no visual change. When emphasis must be visible, pass `--font <family.ttf>` with a real weight or state the emphasis in words instead of relying on weight.

## CJK text

- CJK needs an explicitly registered font. The renderer's STSong-Light CID default covers Simplified Chinese; pass a TrueType file for other languages or a specific family.
- Latin and CJK mixed in one run may need separate font assignment; check the rendered page rather than assuming the fallback is correct.
- CJK line breaking differs from Latin: avoid justified text in narrow columns, and check that no line overflows after rendering.

## Overflow

Overflow is a content problem before it is a styling problem. Shorten text or split the element; do not shrink type below 9 pt to force a fit, and do not let a table run past the margin.
