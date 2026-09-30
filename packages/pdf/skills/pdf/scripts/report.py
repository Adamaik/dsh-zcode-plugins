#!/usr/bin/env python3
"""Build a report-style PDF from a Markdown subset with ReportLab.

Supported source syntax:

    # / ## / ###      headings
    paragraph        body text (blank line separates paragraphs)
    - item           unordered list
    1. item          ordered list
    | a | b |        pipe table, with an optional | --- | separator row
    > quote          blockquote
    ```              fenced code block
    ---              page break on its own line

Inline `**bold**`, `*italic*`, and ```code``` are honoured. Chinese,
Japanese, and Korean text uses the built-in STSong-Light CID font unless
`--font` names a TrueType file.

Requires reportlab: install it with
    <python> -m pip install reportlab
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, LETTER
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        HRFlowable,
        ListFlowable,
        ListItem,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
except ImportError:
    raise SystemExit(
        "reportlab is not installed in this interpreter. "
        f"Run: {sys.executable} -m pip install reportlab"
    )

CJK_RE = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")
INLINE_CODE_RE = re.compile(r"`([^`]+)`")
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
ITALIC_RE = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")


def register_font(explicit: str | None, body: str) -> str:
    """Register and return the body font name for this document."""
    if explicit:
        pdfmetrics.registerFont(TTFont("Body", explicit))
        return "Body"
    if CJK_RE.search(body):
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        return "STSong-Light"
    return "Helvetica"


def inline(text: str) -> str:
    """Convert one line of inline Markdown into ReportLab paragraph markup."""
    escaped = html.escape(text, quote=False)
    escaped = INLINE_CODE_RE.sub(r'<font face="Courier">\1</font>', escaped)
    escaped = BOLD_RE.sub(r"<b>\1</b>", escaped)
    escaped = ITALIC_RE.sub(r"<i>\1</i>", escaped)
    return escaped


def parse_blocks(source: str) -> list[dict]:
    blocks: list[dict] = []
    lines = source.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if stripped == "---":
            blocks.append({"kind": "pagebreak"})
            index += 1
            continue
        if stripped.startswith("```"):
            index += 1
            code: list[str] = []
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code.append(lines[index])
                index += 1
            index += 1
            blocks.append({"kind": "code", "text": "\n".join(code)})
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            blocks.append({"kind": "heading", "level": len(heading.group(1)), "text": heading.group(2)})
            index += 1
            continue
        if stripped.startswith("|"):
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", cell or "") for cell in cells):
                    rows.append(cells)
                index += 1
            if rows:
                blocks.append({"kind": "table", "rows": rows})
            continue
        if re.match(r"^[-*]\s+", stripped):
            items: list[str] = []
            while index < len(lines) and re.match(r"^[-*]\s+", lines[index].strip()):
                items.append(re.sub(r"^[-*]\s+", "", lines[index].strip()))
                index += 1
            blocks.append({"kind": "ul", "items": items})
            continue
        if re.match(r"^\d+[.)]\s+", stripped):
            items = []
            while index < len(lines) and re.match(r"^\d+[.)]\s+", lines[index].strip()):
                items.append(re.sub(r"^\d+[.)]\s+", "", lines[index].strip()))
                index += 1
            blocks.append({"kind": "ol", "items": items})
            continue
        if stripped.startswith(">"):
            quote: list[str] = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quote.append(lines[index].strip().lstrip("> ").strip())
                index += 1
            blocks.append({"kind": "quote", "text": " ".join(quote)})
            continue
        paragraph: list[str] = []
        while (
            index < len(lines)
            and lines[index].strip()
            and not lines[index].strip().startswith(("#", "|", ">", "```"))
            and lines[index].strip() != "---"
            and not re.match(r"^[-*]\s+", lines[index].strip())
            and not re.match(r"^\d+[.)]\s+", lines[index].strip())
        ):
            paragraph.append(lines[index].strip())
            index += 1
        blocks.append({"kind": "paragraph", "text": " ".join(paragraph)})
    return blocks


def build_styles(font: str, base_size: float) -> dict:
    styles = getSampleStyleSheet()
    return {
        "body": ParagraphStyle(
            "Body",
            parent=styles["BodyText"],
            fontName=font,
            fontSize=base_size,
            leading=base_size * 1.5,
            spaceAfter=base_size * 0.6,
        ),
        "title": ParagraphStyle(
            "Title",
            parent=styles["Title"],
            fontName=font,
            fontSize=base_size * 2.0,
            leading=base_size * 2.4,
            spaceAfter=base_size,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=styles["BodyText"],
            fontName=font,
            fontSize=base_size * 1.15,
            leading=base_size * 1.6,
            textColor=colors.HexColor("#444444"),
            spaceAfter=base_size * 1.4,
        ),
        "h1": ParagraphStyle(
            "H1",
            parent=styles["Heading1"],
            fontName=font,
            fontSize=base_size * 1.5,
            leading=base_size * 1.8,
            spaceBefore=base_size * 1.2,
            spaceAfter=base_size * 0.6,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=styles["Heading2"],
            fontName=font,
            fontSize=base_size * 1.25,
            leading=base_size * 1.55,
            spaceBefore=base_size,
            spaceAfter=base_size * 0.5,
        ),
        "h3": ParagraphStyle(
            "H3",
            parent=styles["Heading3"],
            fontName=font,
            fontSize=base_size * 1.1,
            leading=base_size * 1.4,
            spaceBefore=base_size * 0.8,
            spaceAfter=base_size * 0.4,
        ),
        "code": ParagraphStyle(
            "Code",
            parent=styles["Code"],
            fontName="Courier",
            fontSize=base_size * 0.85,
            leading=base_size * 1.2,
            backColor=colors.HexColor("#f4f4f4"),
            borderPadding=6,
        ),
        "quote": ParagraphStyle(
            "Quote",
            parent=styles["BodyText"],
            fontName=font,
            fontSize=base_size,
            leading=base_size * 1.5,
            leftIndent=base_size,
            textColor=colors.HexColor("#555555"),
            borderColor=colors.HexColor("#cccccc"),
            borderWidth=0,
        ),
    }


def flow_for(block: dict, styles: dict, base_size: float) -> list:
    kind = block["kind"]
    if kind == "heading":
        style = styles["h1" if block["level"] == 1 else "h2" if block["level"] == 2 else "h3"]
        return [Paragraph(inline(block["text"]), style)]
    if kind == "paragraph":
        return [Paragraph(inline(block["text"]), styles["body"])]
    if kind == "code":
        safe = html.escape(block["text"], quote=False).replace("\n", "<br/>")
        return [Paragraph(safe, styles["code"]), Spacer(1, base_size)]
    if kind == "quote":
        return [Paragraph(inline(block["text"]), styles["quote"]), Spacer(1, base_size * 0.4)]
    if kind in ("ul", "ol"):
        items = [ListItem(Paragraph(inline(item), styles["body"])) for item in block["items"]]
        return [
            ListFlowable(
                items,
                bulletType="bullet" if kind == "ul" else "1",
                leftIndent=base_size * 1.2,
                bulletFontName=styles["body"].fontName,
                bulletFontSize=base_size,
            ),
            Spacer(1, base_size * 0.4),
        ]
    if kind == "table":
        rows = [[Paragraph(inline(cell), styles["body"]) for cell in row] for row in block["rows"]]
        width = None
        table = Table(rows, colWidths=width, hAlign="LEFT")
        table.setStyle(
            TableStyle(
                [
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#bbbbbb")),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        return [table, Spacer(1, base_size)]
    if kind == "pagebreak":
        return [PageBreak()]
    return []


def footer(canvas, doc, font: str) -> None:
    canvas.saveState()
    canvas.setFont(font, 8)
    canvas.setFillColor(colors.HexColor("#666666"))
    canvas.drawRightString(doc.pagesize[0] - 18 * mm, 12 * mm, str(doc.page))
    canvas.restoreState()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", help="Markdown source file")
    parser.add_argument("--out", required=True, help="output PDF path")
    parser.add_argument("--title")
    parser.add_argument("--subtitle")
    parser.add_argument("--author")
    parser.add_argument("--page-size", choices=("A4", "LETTER"), default="A4")
    parser.add_argument("--font", help="TrueType font file to embed for body text")
    parser.add_argument("--base-size", type=float, default=10.5)
    parser.add_argument("--margin", type=float, default=20, help="page margin in millimetres")
    parser.add_argument("--spec", help="JSON block spec instead of Markdown")
    args = parser.parse_args(argv)

    if args.spec:
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        source = spec.get("markdown", "")
        args.title = args.title or spec.get("title")
        args.subtitle = args.subtitle or spec.get("subtitle")
        args.author = args.author or spec.get("author")
    elif args.input:
        source = Path(args.input).read_text(encoding="utf-8")
    else:
        source = sys.stdin.read()

    font = register_font(args.font, source + (args.title or ""))
    styles = build_styles(font, args.base_size)
    page_size = A4 if args.page_size == "A4" else LETTER
    margin = args.margin * mm
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)

    story: list = []
    if args.title:
        story.append(Paragraph(inline(args.title), styles["title"]))
    if args.subtitle:
        story.append(Paragraph(inline(args.subtitle), styles["subtitle"]))
    if args.title or args.subtitle:
        story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#999999")))
        story.append(Spacer(1, args.base_size))
    for block in parse_blocks(source):
        story.extend(flow_for(block, styles, args.base_size))

    block_count = len(story)
    document = SimpleDocTemplate(
        args.out,
        pagesize=page_size,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
        title=args.title or "",
        author=args.author or "",
    )
    document.build(story, onFirstPage=lambda canvas, doc: footer(canvas, doc, font),
                   onLaterPages=lambda canvas, doc: footer(canvas, doc, font))
    print(json.dumps({"out": str(Path(args.out).resolve()), "blocks": block_count}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
