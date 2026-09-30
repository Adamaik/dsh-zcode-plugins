#!/usr/bin/env python3
"""Process existing PDFs: inspect, merge, split, extract, rotate, fill forms.

This is the process half of the DSH PDF skill. The core packages are pure
Python, so they install into the harness interpreter:

    reportlab    Report route rendering (scripts/report.py)
    pypdf        structure operations (info, merge, split, rotate, text
                 extraction, embedded images, form filling)

Two optional packages ship native extensions, which a hardened interpreter may
refuse to load (macOS library validation rejects wheels signed by another team):

    pdfplumber   table extraction
    PyMuPDF      page rendering to PNG

Build the dedicated environment with `env.venv`, which prints the interpreter
to use for those commands. `office2pdf.mjs --to images` renders PDF pages
through the LibreOffice kit and needs no Python extension at all.

Run `env.check` first; run `env.fix` to install the missing core packages into
the interpreter that invoked this script.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CORE_PACKAGES = ("reportlab", "pypdf")
OPTIONAL_PACKAGES = ("pdfplumber", "PyMuPDF")
IMPORT_NAMES = {
    "reportlab": "reportlab",
    "pypdf": "pypdf",
    "pdfplumber": "pdfplumber",
    "PyMuPDF": "pymupdf",
}


def package_status(packages=CORE_PACKAGES) -> dict[str, bool]:
    status: dict[str, bool] = {}
    for package in packages:
        try:
            __import__(IMPORT_NAMES[package])
            status[package] = True
        except (ImportError, OSError):
            status[package] = False
    return status


def require(package: str) -> None:
    try:
        __import__(IMPORT_NAMES[package])
    except (ImportError, OSError):
        if package in OPTIONAL_PACKAGES:
            raise SystemExit(
                f"{package} is not importable in this interpreter. It needs a native extension, "
                "which a hardened harness interpreter may refuse to load. Build the dedicated "
                f"environment and use its interpreter: {sys.executable} {Path(__file__).resolve()} env.venv. "
                "For page images, office2pdf.mjs --to images needs no Python extension."
            )
        raise SystemExit(
            f"{package} is not installed in this interpreter. "
            f"Run: {sys.executable} {Path(__file__).resolve()} env.fix"
        )


def parse_pages(spec: str | None, total: int) -> list[int]:
    """Parse a 1-based page spec such as '1-3,7' into zero-based indices."""
    if not spec:
        return list(range(total))
    pages: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start, _, end = chunk.partition("-")
            first, last = int(start), int(end)
            if first < 1 or last < first or last > total:
                raise SystemExit(f"page range {chunk!r} is outside 1..{total}")
            pages.extend(range(first - 1, last))
        else:
            index = int(chunk)
            if index < 1 or index > total:
                raise SystemExit(f"page {chunk!r} is outside 1..{total}")
            pages.append(index - 1)
    return pages


def venv_dir(explicit: str | None = None) -> Path:
    """Resolve the dedicated environment directory."""
    if explicit:
        return Path(explicit).expanduser()
    configured = os.environ.get("PDF_VENV")
    if configured:
        return Path(configured).expanduser()
    home = Path(os.environ.get("DSH_HOME", str(Path.home() / ".dsh"))).expanduser()
    return home / "pdf-runtime"


def venv_python(directory: Path) -> Path:
    """Return the interpreter path inside a virtual environment."""
    if os.name == "nt":
        return directory / "Scripts" / "python.exe"
    return directory / "bin" / "python"


def base_python() -> str:
    """Pick the interpreter that builds the dedicated environment."""
    configured = os.environ.get("PDF_BASE_PYTHON")
    if configured:
        return configured
    candidate = shutil.which("python3")
    if candidate:
        return candidate
    return sys.executable


def cmd_env_check(args: argparse.Namespace) -> int:
    core = package_status(CORE_PACKAGES)
    optional = package_status(OPTIONAL_PACKAGES)
    payload = {
        "python": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "packages": core,
        "optional": optional,
        "ready": all(core.values()),
        "venv": str(venv_python(venv_dir())),
        "venvExists": venv_python(venv_dir()).exists(),
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"python: {payload['python']} ({payload['pythonVersion']})")
        for package, present in core.items():
            print(f"  core {package}: {'ok' if present else 'MISSING'}")
        for package, present in optional.items():
            print(f"  optional {package}: {'ok' if present else 'absent'}")
        print(f"dedicated env: {payload['venv']} ({'exists' if payload['venvExists'] else 'not built'})")
        print("ready" if payload["ready"] else "run env.fix to install the missing core packages")
    return 0 if payload["ready"] else 1


def cmd_env_fix(_args: argparse.Namespace) -> int:
    missing = [name for name, present in package_status(CORE_PACKAGES).items() if not present]
    if not missing:
        print("all core packages are already installed")
        return 0
    command = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *missing]
    print("running:", " ".join(command), file=sys.stderr)
    return subprocess.call(command)


def cmd_env_venv(args: argparse.Namespace) -> int:
    directory = venv_dir(args.path)
    python = venv_python(directory)
    if not python.exists():
        base = base_python()
        print(f"creating {directory} from {base}", file=sys.stderr)
        result = subprocess.call([base, "-m", "venv", str(directory)])
        if result != 0 or not python.exists():
            raise SystemExit(f"could not create a virtual environment at {directory}")
    packages = list(CORE_PACKAGES) + list(OPTIONAL_PACKAGES)
    command = [str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", *packages]
    print("running:", " ".join(command), file=sys.stderr)
    subprocess.check_call(command)
    status: dict[str, bool] = {}
    for package in packages:
        probe = subprocess.run(
            [str(python), "-c", f"import {IMPORT_NAMES[package]}"],
            capture_output=True,
        )
        status[package] = probe.returncode == 0
    payload = {
        "python": str(python),
        "packages": status,
        "ready": all(status.values()),
        "use": f"<python-from-above> {Path(__file__).resolve()}",
    }
    print(json.dumps(payload, indent=2))
    return 0 if payload["ready"] else 1


def cmd_info(args: argparse.Namespace) -> int:
    require("pypdf")
    from pypdf import PdfReader

    reader = PdfReader(args.file)
    pages = []
    for index, page in enumerate(reader.pages):
        box = page.mediabox
        pages.append(
            {
                "page": index + 1,
                "width": round(float(box.width), 2),
                "height": round(float(box.height), 2),
                "rotation": page.get("/Rotate", 0),
            }
        )
    print(
        json.dumps(
            {
                "file": str(Path(args.file).resolve()),
                "pages": len(reader.pages),
                "encrypted": reader.is_encrypted,
                "metadata": dict(reader.metadata or {}),
                "pageSizes": pages,
            },
            indent=2,
            default=str,
        )
    )
    return 0


def cmd_merge(args: argparse.Namespace) -> int:
    require("pypdf")
    from pypdf import PdfWriter

    writer = PdfWriter()
    for source in args.inputs:
        writer.append(source)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "wb") as handle:
        writer.write(handle)
    print(f"merged {len(args.inputs)} file(s) into {args.out}")
    return 0


def cmd_split(args: argparse.Namespace) -> int:
    require("pypdf")
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(args.file)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = parse_pages(args.pages, len(reader.pages))
    if args.mode == "each":
        written = []
        for index in pages:
            writer = PdfWriter()
            writer.add_page(reader.pages[index])
            target = out_dir / f"{Path(args.file).stem}-p{index + 1}.pdf"
            with open(target, "wb") as handle:
                writer.write(handle)
            written.append(str(target))
        print(json.dumps({"files": written}, indent=2))
    else:
        writer = PdfWriter()
        for index in pages:
            writer.add_page(reader.pages[index])
        target = Path(args.out) if args.out else out_dir / f"{Path(args.file).stem}-selected.pdf"
        with open(target, "wb") as handle:
            writer.write(handle)
        print(str(target))
    return 0


def cmd_rotate(args: argparse.Namespace) -> int:
    require("pypdf")
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(args.file)
    writer = PdfWriter()
    pages = set(parse_pages(args.pages, len(reader.pages)))
    for index, page in enumerate(reader.pages):
        if index in pages:
            page.rotate(args.angle)
        writer.add_page(page)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "wb") as handle:
        writer.write(handle)
    print(f"rotated {len(pages)} page(s) by {args.angle} degrees into {args.out}")
    return 0


def cmd_extract_text(args: argparse.Namespace) -> int:
    require("pypdf")
    from pypdf import PdfReader

    reader = PdfReader(args.file)
    pages = parse_pages(args.pages, len(reader.pages))
    chunks = []
    for index in pages:
        text = reader.pages[index].extract_text() or ""
        chunks.append(f"--- page {index + 1} ---\n{text}")
    body = "\n\n".join(chunks)
    if args.out:
        Path(args.out).write_text(body, encoding="utf-8")
        print(args.out)
    else:
        print(body)
    return 0


def cmd_extract_tables(args: argparse.Namespace) -> int:
    require("pdfplumber")
    import pdfplumber

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    with pdfplumber.open(args.file) as document:
        for index, page in enumerate(document.pages):
            for table_index, table in enumerate(page.extract_tables()):
                target = out_dir / f"page{index + 1}-table{table_index + 1}.json"
                target.write_text(json.dumps(table, ensure_ascii=False, indent=2), encoding="utf-8")
                written.append(str(target))
    print(json.dumps({"tables": written}, indent=2))
    return 0


def cmd_extract_images(args: argparse.Namespace) -> int:
    require("pypdf")
    from pypdf import PdfReader

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    reader = PdfReader(args.file)
    for page_index, page in enumerate(reader.pages, start=1):
        for image_index, image in enumerate(page.images, start=1):
            suffix = Path(image.name).suffix or ".bin"
            target = out_dir / f"page{page_index}-image{image_index}{suffix}"
            target.write_bytes(image.data)
            written.append(str(target))
    print(json.dumps({"images": written}, indent=2))
    return 0


def cmd_render_images(args: argparse.Namespace) -> int:
    require("PyMuPDF")
    import pymupdf as fitz

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    zoom = args.dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    with fitz.open(args.file) as document:
        pages = parse_pages(args.pages, document.page_count)
        for index in pages:
            pixmap = document.load_page(index).get_pixmap(matrix=matrix)
            target = out_dir / f"page-{index + 1:03d}.png"
            pixmap.save(target)
            written.append(str(target))
    print(json.dumps({"pages": written}, indent=2))
    return 0


def cmd_fill_form(args: argparse.Namespace) -> int:
    require("pypdf")
    from pypdf import PdfReader, PdfWriter

    if args.data:
        values = json.loads(Path(args.data).read_text(encoding="utf-8"))
    else:
        values = json.loads(args.values or "{}")
    reader = PdfReader(args.file)
    writer = PdfWriter()
    writer.append(reader)
    fields = writer.get_fields() or {}
    unknown = [name for name in values if name not in fields]
    if unknown:
        raise SystemExit(f"unknown form fields: {', '.join(sorted(unknown))}")
    writer.update_page_form_field_values(None, values, auto_regenerate=False)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "wb") as handle:
        writer.write(handle)
    print(json.dumps({"out": args.out, "filled": sorted(values)}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    env_check = sub.add_parser("env.check", help="report core package availability")
    env_check.add_argument("-j", "--json", action="store_true")
    env_check.set_defaults(func=cmd_env_check)

    env_fix = sub.add_parser("env.fix", help="pip install the missing core packages")
    env_fix.set_defaults(func=cmd_env_fix)

    env_venv = sub.add_parser(
        "env.venv",
        help="build the dedicated environment for the optional native packages",
    )
    env_venv.add_argument("--path", help="environment directory; defaults to $PDF_VENV or $DSH_HOME/pdf-runtime")
    env_venv.set_defaults(func=cmd_env_venv)

    info = sub.add_parser("info", help="page count, sizes, and metadata")
    info.add_argument("file")
    info.set_defaults(func=cmd_info)

    merge = sub.add_parser("merge", help="merge PDFs in argument order")
    merge.add_argument("--out", required=True)
    merge.add_argument("inputs", nargs="+")
    merge.set_defaults(func=cmd_merge)

    split = sub.add_parser("split", help="split into one file per page or one selection")
    split.add_argument("file")
    split.add_argument("--out-dir", required=True)
    split.add_argument("--out")
    split.add_argument("--pages")
    split.add_argument("--mode", choices=("each", "one"), default="each")
    split.set_defaults(func=cmd_split)

    rotate = sub.add_parser("rotate", help="rotate selected pages")
    rotate.add_argument("file")
    rotate.add_argument("--out", required=True)
    rotate.add_argument("--angle", type=int, required=True)
    rotate.add_argument("--pages")
    rotate.set_defaults(func=cmd_rotate)

    text = sub.add_parser("extract-text", help="extract text page by page")
    text.add_argument("file")
    text.add_argument("--out")
    text.add_argument("--pages")
    text.set_defaults(func=cmd_extract_text)

    tables = sub.add_parser("extract-tables", help="extract tables as JSON via pdfplumber")
    tables.add_argument("file")
    tables.add_argument("--out-dir", required=True)
    tables.set_defaults(func=cmd_extract_tables)

    images = sub.add_parser("extract-images", help="extract embedded images as PNG")
    images.add_argument("file")
    images.add_argument("--out-dir", required=True)
    images.set_defaults(func=cmd_extract_images)

    render = sub.add_parser("render-images", help="render pages to PNG for visual checks")
    render.add_argument("file")
    render.add_argument("--out-dir", required=True)
    render.add_argument("--dpi", type=int, default=120)
    render.add_argument("--pages")
    render.set_defaults(func=cmd_render_images)

    form = sub.add_parser("fill-form", help="fill AcroForm fields from JSON")
    form.add_argument("file")
    form.add_argument("--out", required=True)
    form.add_argument("--data", help="path to a JSON object of field values")
    form.add_argument("--values", help="inline JSON object of field values")
    form.set_defaults(func=cmd_fill_form)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
