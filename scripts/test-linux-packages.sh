#!/bin/sh
# Runs inside a clean distribution container with the packages mounted at /pkgs:
#   /pkgs/cur  current version (.deb and .rpm)     /pkgs/up  higher version (upgrade target)
# Install, run as an unprivileged user, upgrade, check user state, remove.
set -eu
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  INSTALL="apt-get install -y -qq"; REMOVE="apt-get remove -y -qq wazir"; EXT=deb
  apt-get update -qq >/dev/null
else
  INSTALL="dnf install -y -q"; REMOVE="dnf remove -y -q wazir"; EXT=rpm
fi
command -v su >/dev/null || dnf install -y -q util-linux >/dev/null  # minimal images (Fedora) lack su
cur=$(ls /pkgs/cur/*.$EXT); up=$(ls /pkgs/up/*.$EXT)
useradd -m tester 2>/dev/null || adduser -D tester
$INSTALL "$cur" >/dev/null
v1=$(su tester -c 'wa --version')
su tester -c 'wa resources validate --json >/dev/null && wa doctor --json >/dev/null 2>&1; echo "{\"version\":1,\"accounts\":[]}" > ~/.wazir/resources.json'
before=$(su tester -c 'cd ~/.wazir && find . -type f ! -name "*-wal" ! -name "*-shm" -exec sha256sum {} + | sort')
$INSTALL "$up" >/dev/null
v2=$(su tester -c 'wa --version')
after=$(su tester -c 'cd ~/.wazir && find . -type f ! -name "*-wal" ! -name "*-shm" -exec sha256sum {} + | sort')
[ "$before" = "$after" ] || { echo "FAIL: upgrade changed user state"; exit 1; }
$REMOVE >/dev/null
if command -v wa >/dev/null; then echo "FAIL: wa still installed"; exit 1; fi
[ -f /home/tester/.wazir/resources.json ] || { echo "FAIL: removal deleted user data"; exit 1; }
. /etc/os-release
echo "PASS $PRETTY_NAME $(uname -m): install $v1, upgrade $v2, state preserved, removed (data kept)"
