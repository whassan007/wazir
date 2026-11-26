#!/usr/bin/env bash
# Container smoke test: real D-Bus SearchProvider2 + real Nautilus 4.0 GI bindings.
# Needs: python3 python3-dbus python3-gi gir1.2-nautilus-4.0 (or python3-nautilus) libglib2.0-bin dbus
# Run under: dbus-run-session -- bash dbus_provider_smoke.sh
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$(mktemp -d)"
LOG="$BIN/launch.log"
cat >"$BIN/wa" <<'WA'
#!/usr/bin/env bash
printf '{"tier":1,"handler":"fake","reason":"argc=%s"}\n' "$#"
WA
cat >"$BIN/wazir-shell" <<WS
#!/usr/bin/env python3
import json, sys
open("$LOG", "a").write(json.dumps(sys.argv[1:]) + "\n")
WS
chmod +x "$BIN/wa" "$BIN/wazir-shell"
export PATH="$BIN:$PATH"

python3 -I "$ROOT/gnome/wazir-gnome-search.py" &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  gdbus introspect --session --dest org.wazir.SearchProvider --object-path /org/wazir/SearchProvider >/dev/null 2>&1 && break
  sleep 0.1
done
call() { gdbus call --session --dest org.wazir.SearchProvider --object-path /org/wazir/SearchProvider --method "org.gnome.Shell.SearchProvider2.$1" "${@:2}"; }

# shellcheck disable=SC2016 # literal payload; must NOT expand
Q='-c "$(touch /tmp/pwned)"'
R="$(call GetInitialResultSet "['-c', '\"\$(touch /tmp/pwned)\"']")"
echo "GetInitialResultSet -> $R"
ID="$(printf '%s' "$R" | sed -E "s/^\(\['([^']+)'.*/\1/")"
case "$ID" in wazir:*) ;; *) echo "FAIL: no result id"; exit 1 ;; esac
M="$(call GetResultMetas "['$ID']")"
echo "GetResultMetas -> $M"
printf '%s' "$M" | grep -q 'argc=3' || { echo "FAIL: wa did not receive query as one argv element"; exit 1; }
call ActivateResult "$ID" "['x']" 0 >/dev/null
LONG="$(head -c 3000 /dev/zero | tr '\0' 'a')"
call LaunchSearch "['$LONG']" 0 >/dev/null
call GetInitialResultSet "['']" | grep -q '(@as \[\],)' || { echo "FAIL: empty query should give []"; exit 1; }
sleep 1
echo "launch.log:"; cat "$LOG"
python3 -I - "$LOG" "$Q" <<'PY'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
assert lines[0] == ["-c", sys.argv[2]], lines[0]
assert lines[1][0] == "-c" and len(lines[1][1]) == 512, len(lines[1][1])
PY
[ ! -e /tmp/pwned ] || { echo "FAIL: injection executed"; exit 1; }
echo "ok: D-Bus provider returns results, activation uses C1 argv, query truncated, no injection"

python3 -I - "$ROOT" <<'PY'
import importlib.util, os, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location("ext", os.path.join(root, "nautilus/wazir_nautilus_extension.py"))
ext = importlib.util.module_from_spec(spec); spec.loader.exec_module(ext)
assert ext._HAVE_NAUTILUS, "Nautilus GI binding not loaded"
from gi.repository import Nautilus
print("Nautilus GI namespace version:", Nautilus._version)
class FI:
    def get_location(self):
        class L:
            def get_path(self): return "/tmp/a\"b.txt"
        return L()
items = ext.WazirNautilusExtension().get_file_items([FI()])
sub = items[0].get_property("menu")
labels = [i.get_property("label") for i in sub.get_items()]
assert len(labels) == 9, labels
print("ok: Nautilus extension builds 9 menu items with real GI:", labels)
PY
