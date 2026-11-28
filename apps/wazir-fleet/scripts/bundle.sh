#!/bin/bash
# Builds Fleet.app (release) into ./build and ad-hoc signs it.
# Usage: scripts/bundle.sh [--open] [--install]   (--install copies to /Applications)
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release --product Fleet
BIN="$(swift build -c release --show-bin-path)/Fleet"

APP=build/Fleet.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Fleet"
cp Resources/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$APP" >/dev/null
echo "Built $APP"

for arg in "$@"; do
  case "$arg" in
    --install) rm -rf /Applications/Fleet.app && cp -R "$APP" /Applications/ && echo "Installed /Applications/Fleet.app" ;;
    --new)
      open -n "$APP" ;;
    --open)
      # `open` only re-activates an already-running instance, so quit any old build first.
      if pgrep -x Fleet >/dev/null; then
        osascript -e 'quit app id "dev.fleet.Fleet"' >/dev/null 2>&1 || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Fleet >/dev/null || break; sleep 0.5; done
        pkill -x Fleet 2>/dev/null || true
      fi
      open "$APP" ;;
  esac
done
