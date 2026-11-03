#!/usr/bin/env bash
# Compatibility wrapper: the installer is implemented in
# scripts/install-systemd-unit.js so its rendering and its checkout guard can
# be unit-tested. All flags pass straight through (run with --help).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/install-systemd-unit.js" "$@"
