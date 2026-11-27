#!/usr/bin/env bash
# Apple Silicon refuses to run unsigned apps. This signs Watson for your own Mac only, with the
# identity from sign-identity.sh (a stable one keeps permissions across rebuilds; ad-hoc doesn't).
set -euo pipefail
APP="release/mac-arm64/Watson.app"
[[ -d "$APP" ]] || { echo "No $APP — run npm run dist first." >&2; exit 1; }
ID="$(bash "$(dirname "$0")/sign-identity.sh")"
codesign --force --sign "$ID" "$APP/Contents/Resources/watson-helper"
codesign --force --deep --sign "$ID" "$APP"
[[ "$ID" == "-" ]] && ID="an ad-hoc signature"
echo "Signed $APP with $ID. Drag it to /Applications, then open it."
