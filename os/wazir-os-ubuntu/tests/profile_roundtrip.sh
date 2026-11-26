#!/usr/bin/env bash
# Round-trip test for profile/wazir-gnome-profile.sh.
# Run inside a dbus session with dconf-cli installed, e.g.:
#   docker run --rm -v "$PWD/os/wazir-os-ubuntu:/w:ro" ubuntu:24.04 bash -c \
#     'apt-get update -qq && apt-get install -y -qq dconf-cli dconf-service dbus-x11 >/dev/null && dbus-run-session -- bash /w/tests/profile_roundtrip.sh'
set -euo pipefail

SCRIPT="$(cd -- "$(dirname -- "$0")/.." && pwd)/profile/wazir-gnome-profile.sh"

# dconf-service is D-Bus activated and inherits the bus daemon's HOME, so the
# isolated HOME must be set before the session bus starts: re-exec ourselves in
# a fresh session bus once HOME points at a scratch directory.
if [ -z "${WAZIR_PROFILE_TEST_INNER:-}" ]; then
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/home"
  export HOME="$WORK/home" WAZIR_PROFILE_TEST_INNER=1 WAZIR_PROFILE_TEST_WORK="$WORK"
  unset DBUS_SESSION_BUS_ADDRESS
  exec dbus-run-session -- bash "$0" "$@"
fi
WORK="$WAZIR_PROFILE_TEST_WORK"
export WAZIR_PROFILE_BACKUP="$HOME/.wazir/backups/gnome-profile.dconf.bak"
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; pass=$((pass + 1)); }

# Seed a realistic pre-existing user state, including a key the profile changes
# and keys it never touches (with awkward string content).
dconf write /org/gnome/desktop/interface/color-scheme "'default'"
dconf write /org/gnome/desktop/interface/gtk-theme "'Yaru'"
dconf write /org/gnome/desktop/background/picture-uri "'file:///home/u/a \"b\" \$(x).png'"
dconf write /org/gnome/shell/favorite-apps "['firefox.desktop', 'org.gnome.Nautilus.desktop']"
dconf write /org/gnome/mutter/dynamic-workspaces false
dconf write /org/other/untouched "'keep'"

dconf dump /org/gnome/ >"$WORK/before.dconf"
[ -s "$WORK/before.dconf" ] || fail "seed dump empty"

bash "$SCRIPT" --apply
[ -f "$WAZIR_PROFILE_BACKUP" ] || fail "backup not created"
cmp -s "$WORK/before.dconf" "$WAZIR_PROFILE_BACKUP" || fail "backup differs from pre-apply dump"
ok "apply created backup identical to pre-apply dump"

[ "$(dconf read /org/gnome/desktop/interface/color-scheme)" = "'prefer-dark'" ] || fail "color-scheme not applied"
[ "$(dconf read /org/gnome/shell/extensions/dash-to-dock/dock-position)" = "'BOTTOM'" ] || fail "dock-position not applied"
[ "$(dconf read /org/gnome/desktop/interface/enable-animations)" = "true" ] || fail "animations not applied"
dconf dump /org/gnome/ >"$WORK/applied.dconf"
if cmp -s "$WORK/before.dconf" "$WORK/applied.dconf"; then fail "apply changed nothing"; fi
ok "apply changed settings"

if bash "$SCRIPT" --apply 2>"$WORK/err"; then fail "second --apply without --force should refuse"; fi
grep -q "refusing to overwrite" "$WORK/err" || fail "missing refusal message"
cmp -s "$WORK/before.dconf" "$WAZIR_PROFILE_BACKUP" || fail "refused apply modified backup"
ok "second --apply refused, backup untouched"

bash "$SCRIPT" --revert
dconf dump /org/gnome/ >"$WORK/after.dconf"
cmp "$WORK/before.dconf" "$WORK/after.dconf" || { diff -u "$WORK/before.dconf" "$WORK/after.dconf" || true; fail "revert not byte-identical"; }
ok "dump -> apply -> revert -> dump is byte-identical ($(wc -c <"$WORK/after.dconf") bytes, sha256 $(sha256sum <"$WORK/after.dconf" | cut -c1-16))"
[ "$(dconf read /org/other/untouched)" = "'keep'" ] || fail "revert touched keys outside /org/gnome/"
ok "keys outside /org/gnome/ untouched"
[ ! -e "$WAZIR_PROFILE_BACKUP" ] || fail "backup should be moved aside after revert"
ls "$WAZIR_PROFILE_BACKUP".restored-* >/dev/null || fail "restored backup copy missing"
ok "backup archived after revert"

if bash "$SCRIPT" --revert 2>/dev/null; then fail "--revert without backup should fail"; fi
ok "--revert without backup fails"

# --force path: apply, then apply --force (backup now reflects applied state), revert.
bash "$SCRIPT" --apply
dconf write /org/gnome/desktop/interface/gtk-theme "'Adwaita'"
dconf dump /org/gnome/ >"$WORK/forced-before.dconf"
bash "$SCRIPT" --apply --force
cmp -s "$WORK/forced-before.dconf" "$WAZIR_PROFILE_BACKUP" || fail "--force did not refresh backup"
bash "$SCRIPT" --revert
dconf dump /org/gnome/ >"$WORK/forced-after.dconf"
cmp "$WORK/forced-before.dconf" "$WORK/forced-after.dconf" || fail "--force round-trip not identical"
ok "--apply --force refreshes backup and round-trips"
[ "$(find "$(dirname -- "$WAZIR_PROFILE_BACKUP")" -name '*.restored-*' | wc -l)" -eq 2 ] || fail "archived backups were clobbered"
ok "archived backups are never clobbered"

if bash "$SCRIPT" --bogus 2>/dev/null; then fail "unknown arg accepted"; fi
ok "unknown argument rejected"

echo "PROFILE ROUNDTRIP: $pass checks passed"
