#!/usr/bin/env bash
# All builds and release writes run on GitHub Actions.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/release-cloud.mjs" "$@"
