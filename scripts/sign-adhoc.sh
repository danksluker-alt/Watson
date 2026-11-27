#!/usr/bin/env bash
# Apple Silicon refuses to run unsigned apps. This signs Watson for your own Mac only
# (an "ad-hoc" signature). macOS may ask for permissions again after each rebuild.
set -euo pipefail
APP="release/mac-arm64/Watson.app"
[[ -d "$APP" ]] || { echo "No $APP — run npm run dist first." >&2; exit 1; }
codesign --force --deep --sign - "$APP"
echo "Signed $APP. Drag it to /Applications, then open it."
