#!/usr/bin/env bash
# Prints the code-signing identity to use. macOS ties permissions (Microphone, Accessibility, ...)
# to the signature, so a stable identity keeps them across rebuilds; an ad-hoc signature ("-")
# changes every build and macOS asks again. Order: $WATSON_SIGN_IDENTITY, then the first
# "Apple Development" certificate (free with an Apple ID in Xcode), then ad-hoc.
if [[ -n "${WATSON_SIGN_IDENTITY:-}" ]]; then echo "$WATSON_SIGN_IDENTITY"; exit 0; fi
id="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)"
echo "${id:--}"
