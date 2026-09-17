#!/usr/bin/env bash
set -euo pipefail

# Wazir macOS DMG Builder
# Generates a distributable Apple Disk Image (.dmg) for macOS.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
STAGE_DIR="$(mktemp -d -t wazir-dmg-build-XXXXXX)"
VERSION="0.1.0"
DMG_NAME="Wazir-${VERSION}.dmg"
OUTPUT_DMG="$DIST_DIR/$DMG_NAME"

echo "=========================================================="
echo "           Building Wazir macOS DMG ($DMG_NAME)            "
echo "=========================================================="

mkdir -p "$DIST_DIR"

# 1. Ensure ICNS icon is generated
ICON_FILE="$REPO_ROOT/scripts/AppIcon.icns"
if [ ! -f "$ICON_FILE" ]; then
  echo "[1/6] Generating macOS AppIcon.icns..."
  python3 "$REPO_ROOT/scripts/generate-icon.py" "$ICON_FILE"
else
  echo "[1/6] Using existing AppIcon.icns..."
fi

# 2. Verify and build necessary dist files
echo "[2/6] Verifying build artifacts..."
node "$REPO_ROOT/apps/cli/dist/index.js" version >/dev/null 2>&1 || {
  echo "Error: apps/cli/dist/index.js is not functional."
  exit 1
}

# 3. Create Wazir.app bundle structure
echo "[3/6] Constructing Wazir.app bundle..."
APP_BUNDLE="$STAGE_DIR/Wazir.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
APP_TARGET="$RESOURCES/app"

mkdir -p "$MACOS" "$RESOURCES" "$APP_TARGET"

# Info.plist
cat << 'EOF' > "$CONTENTS/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>Wazir</string>
    <key>CFBundleExecutable</key>
    <string>Wazir</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>ai.wazir.meta-harness</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Wazir</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
</dict>
</plist>
EOF

# PkgInfo
printf "APPLWZIR" > "$CONTENTS/PkgInfo"

# Copy Icon
cp "$ICON_FILE" "$RESOURCES/AppIcon.icns"

# Launcher Script (Contents/MacOS/Wazir)
cat << 'EOF' > "$MACOS/Wazir"
#!/usr/bin/env bash
set -euo pipefail

# Wazir macOS Application Launcher
BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$BUNDLE_DIR/Resources/app"

# Export standard macOS paths
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Locate Node.js binary
NODE_BIN=""
for candidate in \
  "$(which node 2>/dev/null || true)" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)/bin/node" \
  "$HOME/.asdf/shims/node" \
  "$HOME/.fnm/current/bin/node" \
  "$HOME/.volta/bin/node" \
  "/opt/local/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  osascript -e 'display dialog "Node.js (v20+) is required to run Wazir.\n\nWould you like to open nodejs.org to download it?" with title "Wazir — Node.js Required" buttons {"Cancel", "Download Node.js"} default button "Download Node.js" with icon caution' >/dev/null 2>&1 && open "https://nodejs.org"
  exit 1
fi

WAZIR_API_PORT="${WAZIR_API_PORT:-4800}"
WAZIR_WEB_PORT="${WAZIR_WEB_PORT:-4801}"
WAZIR_LOG_DIR="$HOME/Library/Logs/Wazir"
mkdir -p "$WAZIR_LOG_DIR"

# Launch API server in background
PORT="$WAZIR_API_PORT" WAZIR_COMPUTER_ID="mac-local" \
  "$NODE_BIN" "$APP_DIR/apps/api/dist/main.js" > "$WAZIR_LOG_DIR/api.log" 2>&1 &
API_PID=$!

# Launch Web dashboard server in background
PORT="$WAZIR_WEB_PORT" WAZIR_API="http://localhost:$WAZIR_API_PORT" \
  "$NODE_BIN" "$APP_DIR/apps/web/server.js" > "$WAZIR_LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

cleanup() {
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for server to respond
for i in {1..20}; do
  if curl -s "http://localhost:$WAZIR_WEB_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Open default browser to Wazir dashboard
open "http://localhost:$WAZIR_WEB_PORT"

# Send macOS notification
osascript -e "display notification \"Wazir Meta-Harness dashboard is running at http://localhost:$WAZIR_WEB_PORT\" with title \"Wazir\" subtitle \"Meta-Harness Active\"" >/dev/null 2>&1 || true

# Interactive status window
while true; do
  CHOICE=$(osascript -e 'button returned of (display dialog "Wazir Meta-Harness is running.\n\n• Web Dashboard: http://localhost:'"$WAZIR_WEB_PORT"'\n• API Server: http://localhost:'"$WAZIR_API_PORT"'\n• Logs: ~/Library/Logs/Wazir/\n\nManage Wazir:" with title "Wazir Meta-Harness" buttons {"Open Dashboard", "View Logs", "Stop Wazir"} default button "Open Dashboard" with icon note)' 2>/dev/null || echo "Stop Wazir")
  case "$CHOICE" in
    "Open Dashboard")
      open "http://localhost:$WAZIR_WEB_PORT"
      ;;
    "View Logs")
      open "$WAZIR_LOG_DIR"
      ;;
    *)
      break
      ;;
  esac
done
EOF

chmod +x "$MACOS/Wazir"

# 4. Copy app files into Resources/app
echo "[4/6] Packaging Wazir codebase into app bundle..."
cd "$REPO_ROOT"

# Copy package.json and config files
cp package.json tsconfig.base.json "$APP_TARGET/"
[ -f .env.example ] && cp .env.example "$APP_TARGET/"

# Copy apps (api, web, cli)
mkdir -p "$APP_TARGET/apps/api" "$APP_TARGET/apps/web" "$APP_TARGET/apps/cli"
cp -a apps/api/dist apps/api/package.json "$APP_TARGET/apps/api/"
cp -a apps/web/public apps/web/server.js apps/web/package.json "$APP_TARGET/apps/web/"
cp -a apps/cli/dist apps/cli/package.json "$APP_TARGET/apps/cli/"

# Copy packages
mkdir -p "$APP_TARGET/packages"
for pkg in packages/*; do
  if [ -d "$pkg" ] && [ "$pkg" != "packages/runtimes" ]; then
    pkg_name="$(basename "$pkg")"
    mkdir -p "$APP_TARGET/packages/$pkg_name"
    [ -d "$pkg/dist" ] && cp -a "$pkg/dist" "$APP_TARGET/packages/$pkg_name/"
    [ -f "$pkg/package.json" ] && cp "$pkg/package.json" "$APP_TARGET/packages/$pkg_name/"
  fi
done

# Copy runtimes
mkdir -p "$APP_TARGET/packages/runtimes"
for rt in packages/runtimes/*; do
  if [ -d "$rt" ]; then
    rt_name="$(basename "$rt")"
    mkdir -p "$APP_TARGET/packages/runtimes/$rt_name"
    [ -d "$rt/dist" ] && cp -a "$rt/dist" "$APP_TARGET/packages/runtimes/$rt_name/"
    [ -f "$rt/package.json" ] && cp "$rt/package.json" "$APP_TARGET/packages/runtimes/$rt_name/"
  fi
done

# Copy node_modules (excluding test/dev caches)
echo "  Copying production node_modules..."
mkdir -p "$APP_TARGET/node_modules"
cp -a node_modules/* "$APP_TARGET/node_modules/"

# Ensure executable permissions on node_modules .bin
find "$APP_TARGET" -type f -name "*.sh" -exec chmod +x {} +
chmod +x "$APP_TARGET/apps/cli/dist/index.js"
chmod +x "$APP_TARGET/apps/web/server.js"

# 5. Add DMG root contents (Applications link, Terminal launcher, CLI installer, README)
echo "[5/6] Adding DMG volume utilities and shortcuts..."

# Symlink to /Applications
ln -s /Applications "$STAGE_DIR/Applications"

# Terminal quick launcher: Wazir Terminal.command
cat << 'EOF' > "$STAGE_DIR/Wazir Terminal.command"
#!/usr/bin/env bash
cd "$(dirname "$0")"
DIR="$(pwd)"

if [ -d "$DIR/Wazir.app/Contents/Resources/app" ]; then
  APP_DIR="$DIR/Wazir.app/Contents/Resources/app"
elif [ -d "/Applications/Wazir.app/Contents/Resources/app" ]; then
  APP_DIR="/Applications/Wazir.app/Contents/Resources/app"
else
  APP_DIR="$DIR"
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

alias wa="node \"$APP_DIR/apps/cli/dist/index.js\""

clear
echo "=========================================================="
echo "                WAZIR META-HARNESS CLI                     "
echo "=========================================================="
echo "  'wa' alias is loaded and ready!"
echo ""
node "$APP_DIR/apps/cli/dist/index.js" --help
echo ""
echo "=========================================================="
echo "Quick Commands:"
echo "  wa discover        - Scan local runtimes (Ollama, LM Studio)"
echo "  wa models list     - List available AI models"
echo "  wa task plan \"...\" - Plan task scheduling"
echo "=========================================================="
echo ""

exec "${SHELL:-/bin/zsh}"
EOF
chmod +x "$STAGE_DIR/Wazir Terminal.command"

# CLI installer: install-cli.sh
cat << 'EOF' > "$STAGE_DIR/install-cli.sh"
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WAZIR_APP_CLI="/Applications/Wazir.app/Contents/Resources/app/apps/cli/dist/index.js"

if [ ! -f "$WAZIR_APP_CLI" ]; then
  if [ -f "$SCRIPT_DIR/Wazir.app/Contents/Resources/app/apps/cli/dist/index.js" ]; then
    WAZIR_APP_CLI="$SCRIPT_DIR/Wazir.app/Contents/Resources/app/apps/cli/dist/index.js"
  else
    echo "Error: Could not find Wazir.app. Please drag Wazir.app to /Applications first."
    exit 1
  fi
fi

INSTALL_DIR="/usr/local/bin"
USE_SUDO=false

if [ ! -w "$INSTALL_DIR" ]; then
  if sudo -n true 2>/dev/null; then
    USE_SUDO=true
  else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
  fi
fi

echo "Installing 'wa' CLI launcher into $INSTALL_DIR..."

WRAPPER="#!/usr/bin/env bash
export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"
NODE_BIN=\"\$(which node 2>/dev/null || echo \"/opt/homebrew/bin/node\")\"
if [ ! -x \"\$NODE_BIN\" ] && [ -x \"/usr/local/bin/node\" ]; then
  NODE_BIN=\"/usr/local/bin/node\"
fi
exec \"\$NODE_BIN\" \"$WAZIR_APP_CLI\" \"\$@\"
"

TMP_FILE="$(mktemp)"
echo "$WRAPPER" > "$TMP_FILE"
chmod +x "$TMP_FILE"

if [ "$USE_SUDO" = true ]; then
  sudo cp "$TMP_FILE" "$INSTALL_DIR/wa"
  sudo chmod +x "$INSTALL_DIR/wa"
else
  cp "$TMP_FILE" "$INSTALL_DIR/wa"
  chmod +x "$INSTALL_DIR/wa"
fi
rm -f "$TMP_FILE"

echo "✓ Successfully installed 'wa' into $INSTALL_DIR"
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo ""
  echo "Note: Ensure $INSTALL_DIR is in your PATH in ~/.zshrc:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi
echo ""
echo "Try running: wa --help"
EOF
chmod +x "$STAGE_DIR/install-cli.sh"

# README.txt
cat << 'EOF' > "$STAGE_DIR/README.txt"
============================================================
              WAZIR META-HARNESS FOR MACOS
============================================================

Welcome to Wazir — the model- and runtime-agnostic meta-harness
that schedules AI agents, models, tools, and compute to execute
tasks across local and distributed environments.

HOW TO INSTALL & RUN:
---------------------
1. Drag 'Wazir.app' to the 'Applications' shortcut folder.
2. Open 'Wazir' from your Applications folder (or Launchpad/Spotlight).
   - Starts the Wazir API server & Web Dashboard.
   - Automatically opens http://localhost:4801 in your browser.
   - Allows monitoring, task execution, and log viewing.

USING THE CLI:
--------------
Option 1: Double-click 'Wazir Terminal.command'
  - Opens a Terminal session with 'wa' ready to run.

Option 2: Install CLI globally
  - In Terminal, run:
      ./install-cli.sh
  - Then run 'wa --help' or 'wa discover' anywhere!

SYSTEM REQUIREMENTS:
--------------------
- macOS 12.0 (Monterey) or later (Apple Silicon M1/M2/M3/M4 & Intel x86_64).
- Node.js v20.0.0 or later (download from https://nodejs.org or run 'brew install node').
- Optional AI runtimes: Ollama (https://ollama.com) or LM Studio (https://lmstudio.ai).

CONTENTS OF THIS DISK IMAGE:
----------------------------
• Wazir.app               : Native macOS Application & Dashboard.
• Applications           : Drag-to-install shortcut to /Applications.
• Wazir Terminal.command  : Clickable Terminal launcher.
• install-cli.sh         : Global CLI installer script.
• README.txt             : This guide.

GitHub Repository: https://github.com/whassan/wazir
============================================================
EOF

# 6. Generate DMG disk image using xorriso
echo "[6/6] Creating Apple DMG disk image using xorriso..."
rm -f "$OUTPUT_DMG" "$REPO_ROOT/$DMG_NAME" "$REPO_ROOT/Wazir.dmg"

xorriso -as mkisofs \
  -R -J \
  -V "Wazir" \
  -o "$OUTPUT_DMG" \
  "$STAGE_DIR"

# Create convenient symlink/copies in repo root
cp "$OUTPUT_DMG" "$REPO_ROOT/$DMG_NAME"
cp "$OUTPUT_DMG" "$REPO_ROOT/Wazir.dmg"

# Clean up staging directory
rm -rf "$STAGE_DIR"

echo "=========================================================="
echo "✓ DMG generation successful!"
echo "  Primary output : $OUTPUT_DMG"
echo "  Root copy      : $REPO_ROOT/$DMG_NAME"
echo "  Size           : $(du -h "$OUTPUT_DMG" | cut -f1)"
echo "=========================================================="
