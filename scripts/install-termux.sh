#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

echo "=== Wazir CLI Installer for Termux (ARM64 Android / GrapheneOS) ==="
pkg update -y
pkg install -y nodejs-lts git openssh

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js installation failed."
  exit 1
fi

INSTALL_DIR="${HOME}/wazir-cli"
mkdir -p "$INSTALL_DIR"
echo "Installing Wazir CLI bundle..."
if [ -f "./bin/wa.js" ]; then
  cp ./bin/wa.js "$INSTALL_DIR/wa.js"
else
  echo "Clone https://github.com/whassan007/wazir and run 'npm run bundle' to generate bin/wa.js."
  exit 1
fi

mkdir -p "${PREFIX}/bin"
cat > "${PREFIX}/bin/wa" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exec node "${HOME}/wazir-cli/wa.js" "$@"
EOF
chmod +x "${PREFIX}/bin/wa"

echo "Installed 'wa' to ${PREFIX}/bin/wa."
echo "Run 'wa about' or 'wa shell --no-ai' to verify."
