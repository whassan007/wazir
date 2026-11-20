# Wazir OS (Ubuntu 26.04.1 LTS) — Build, Install, Upgrade & Uninstall

## 1. Install on Ubuntu 26.04.1 LTS (`.deb`)
```bash
npm run build
npm run build:deb
sudo apt install ./dist/deb/wazir_*_all.deb
```

## 2. Verify & Use
- `wa shell` — Hybrid Linux + AI terminal (`!` forces shell, `?` forces AI, `/mode shell|ai|auto`)
- `wa backend list|inspect|use|test|status|reset` — Replace execution backend (`wazir-native`, `qwen-code`, `opencode`, `codex`, `user-plugin`)
- `wa engine status|use|map` — Replace inference engine (`liquid-light`, `gemma4-generic`, `qwen-coder`, `super-nemo`, `auto`)
- `wa settings show|set` — CLI parity with Ubuntu Settings UI

## 3. Clean Uninstall (Ubuntu Remains 100% Functional)
```bash
sudo apt remove wazir
```
Default login shell, GNOME 50, APT, Snap/Flatpak, and systemd remain untouched.
