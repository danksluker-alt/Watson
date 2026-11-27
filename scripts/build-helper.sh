#!/usr/bin/env bash
# Builds the native helper (speech, voice, Accessibility) with the Swift compiler
# from Xcode or the Command Line Tools (`xcode-select --install`).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname)" != "Darwin" ]]; then
  echo "watson-helper builds on macOS only; skipping." >&2
  exit 0
fi
mkdir -p helper/build
swiftc -O -swift-version 5 \
  -target arm64-apple-macos13.0 \
  helper/WatsonHelper.swift \
  -o helper/build/watson-helper \
  -framework AppKit -framework AVFoundation -framework Speech -framework EventKit -framework ApplicationServices \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper/Info.plist
codesign --force --sign "$(bash scripts/sign-identity.sh)" helper/build/watson-helper
echo "Built helper/build/watson-helper"
