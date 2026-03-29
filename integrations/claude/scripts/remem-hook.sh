#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

if command -v remem >/dev/null 2>&1; then
  exec remem hook "$1"
fi

exec node "${PROJECT_DIR}/bin/remem.js" hook "$1"
