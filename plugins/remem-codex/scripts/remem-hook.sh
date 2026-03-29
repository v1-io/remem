#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

if command -v remem >/dev/null 2>&1; then
  exec remem hook "$1"
fi

exec node "${REPO_ROOT}/bin/remem.js" hook "$1"
