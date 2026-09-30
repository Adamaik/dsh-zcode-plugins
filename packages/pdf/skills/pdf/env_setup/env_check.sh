#!/usr/bin/env bash
# Report the PDF skill's Python dependencies through the selected interpreter.
#
# Prefer the interpreter returned by the harness's load_workspace_dependencies
# call. Set PDF_PYTHON to that absolute path; otherwise this falls back to the
# first python3 on PATH.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PDF_PYTHON:-python3}"

echo "skill directory: ${SKILL_DIR}"
echo "interpreter:     ${PY}"
exec "${PY}" "${SKILL_DIR}/scripts/pdf.py" env.check "$@"
