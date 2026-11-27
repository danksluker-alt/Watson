#!/usr/bin/env bash
# In development Watson runs inside node_modules/electron's Electron.app, so macOS
# asks that app's Info.plist why it wants the microphone and speech recognition.
# Electron doesn't ship those strings, and macOS kills the process without them.
set -euo pipefail
[[ "$(uname)" == "Darwin" ]] || exit 0
PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
[[ -f "$PLIST" ]] || exit 0
set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}
set_key NSMicrophoneUsageDescription "Watson (dev) listens when you press the hotkey."
set_key NSSpeechRecognitionUsageDescription "Watson (dev) turns your voice into text on this Mac."
set_key NSCalendarsFullAccessUsageDescription "Watson (dev) shows your schedule."
set_key NSCalendarsUsageDescription "Watson (dev) shows your schedule."
set_key NSRemindersFullAccessUsageDescription "Watson (dev) shows and adds reminders."
set_key NSRemindersUsageDescription "Watson (dev) shows and adds reminders."
set_key NSAppleEventsUsageDescription "Watson (dev) controls Spotify and types into your AI apps."
codesign --force --deep --sign - node_modules/electron/dist/Electron.app >/dev/null 2>&1 || true
echo "Patched Electron.app usage descriptions for development."
