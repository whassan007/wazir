#!/usr/bin/env bash
# Wazir reversible GNOME visual profile.
#
#   wazir-gnome-profile.sh --apply [--force]   back up /org/gnome/ then apply profile
#   wazir-gnome-profile.sh --revert            restore /org/gnome/ exactly from backup
#   wazir-gnome-profile.sh --status            show backup state (default)
#
# --apply refuses to run if a backup already exists (it would otherwise lose the
# user's original settings); pass --force to overwrite it with a fresh dump.
# --revert resets /org/gnome/ and loads the backup, so keys added by --apply are
# removed and `dconf dump /org/gnome/` afterwards is byte-identical to the
# backup. On success the backup is moved aside to "<backup>.restored-<UTC time>".
#
# WAZIR_PROFILE_BACKUP overrides the backup file location.
set -euo pipefail

DCONF_DIR="/org/gnome/"
BACKUP_FILE="${WAZIR_PROFILE_BACKUP:-${HOME}/.wazir/backups/gnome-profile.dconf.bak}"
BACKUP_DIR="$(dirname -- "$BACKUP_FILE")"

usage() {
  echo "usage: $(basename -- "$0") --apply [--force] | --revert | --status" >&2
}

die() {
  echo "wazir-gnome-profile: $*" >&2
  exit 1
}

require_dconf() {
  command -v dconf >/dev/null 2>&1 || die "dconf not found (install dconf-cli)"
}

apply_profile() {
  local force="$1"
  require_dconf
  if [ -e "$BACKUP_FILE" ] && [ "$force" != "1" ]; then
    die "backup already exists at $BACKUP_FILE; refusing to overwrite (use --revert first, or --apply --force)"
  fi
  mkdir -p -- "$BACKUP_DIR"
  chmod 700 -- "$BACKUP_DIR"
  local tmp
  tmp="$(mktemp -- "${BACKUP_FILE}.tmp.XXXXXX")"
  if ! dconf dump "$DCONF_DIR" >"$tmp"; then
    rm -f -- "$tmp"
    die "dconf dump $DCONF_DIR failed; nothing applied"
  fi
  mv -f -- "$tmp" "$BACKUP_FILE"

  # dconf write stores typed GVariant values and does not require the schema
  # (e.g. dash-to-dock) to be installed; GSettings reads the same database.
  dconf write /org/gnome/shell/extensions/dash-to-dock/dock-position "'BOTTOM'"
  dconf write /org/gnome/desktop/interface/color-scheme "'prefer-dark'"
  dconf write /org/gnome/desktop/interface/enable-animations true
  echo "Applied Wazir GNOME visual profile (backup saved at $BACKUP_FILE)."
}

revert_profile() {
  require_dconf
  [ -f "$BACKUP_FILE" ] || die "no backup found at $BACKUP_FILE; nothing to revert"
  dconf reset -f "$DCONF_DIR"
  dconf load "$DCONF_DIR" <"$BACKUP_FILE"
  local base dest n=1
  base="${BACKUP_FILE}.restored-$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$base"
  while [ -e "$dest" ]; do
    dest="${base}-${n}"
    n=$((n + 1))
  done
  mv -- "$BACKUP_FILE" "$dest"
  echo "Reverted GNOME settings from backup (kept as $dest)."
}

status_profile() {
  if [ -f "$BACKUP_FILE" ]; then
    echo "Backup file: $BACKUP_FILE (present)"
  else
    echo "Backup file: $BACKUP_FILE (absent)"
  fi
}

MODE="--status"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply|--revert|--status) MODE="$arg" ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

case "$MODE" in
  --apply) apply_profile "$FORCE" ;;
  --revert) revert_profile ;;
  --status) status_profile ;;
esac
