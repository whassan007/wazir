#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${HOME}/.wazir/backups"
BACKUP_FILE="${BACKUP_DIR}/gnome-profile.dconf.bak"
MODE="${1:---status}"

case "$MODE" in
  --apply)
    mkdir -p "$BACKUP_DIR"
    if command -v dconf >/dev/null 2>&1; then
      if [ ! -f "$BACKUP_FILE" ]; then
        dconf dump /org/gnome/ > "$BACKUP_FILE"
      fi
      gsettings set org.gnome.shell.extensions.dash-to-dock dock-position 'BOTTOM' 2>/dev/null || true
      gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark' 2>/dev/null || true
      gsettings set org.gnome.desktop.interface enable-animations true 2>/dev/null || true
      echo "Applied Wazir GNOME visual profile (backup saved at $BACKUP_FILE)."
    else
      echo "dconf/gsettings not available on this host."
    fi
    ;;
  --revert)
    if [ -f "$BACKUP_FILE" ] && command -v dconf >/dev/null 2>&1; then
      dconf load /org/gnome/ < "$BACKUP_FILE"
      echo "Reverted GNOME settings from $BACKUP_FILE."
    else
      echo "No backup found at $BACKUP_FILE; nothing to revert."
    fi
    ;;
  --status|*)
    echo "Backup file: $BACKUP_FILE ($([ -f "$BACKUP_FILE" ] && echo present || echo absent))"
    ;;
esac
