# Process brief

Use when the PDF already exists and the task is to inspect, extract, combine, or modify it.

## Order of operations

1. `info` first: page count, page sizes, rotation, and metadata. A surprising page size or rotation explains most later layout problems.
2. `extract-text` when the user needs content; `extract-tables` when the user needs structure. Scanned pages return no text — report that the page is image-only instead of returning an empty file.
3. Modify last, into a new path.
4. Re-run `info` on the result and compare page count and sizes to the request.

## Rules

- Original files are read-only unless the user explicitly asks for an in-place edit; then write a sibling backup named `<stem>_backup.pdf` first.
- `merge` preserves argument order. Never reorder the user's files.
- `split --mode each` writes one file per page; `--mode one --pages 1-3,7` writes one selection. Page numbers are 1-based.
- `fill-form` rejects unknown field names: read the form's fields first and report a mismatch instead of writing a partially filled file.
- Encrypted files: report the encryption state and ask for the password; do not attempt to strip protection.
