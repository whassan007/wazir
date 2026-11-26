# GNOME Integration — Ubuntu 24.04 LTS & 26.04 LTS

- **Search Provider**: `os/wazir-os-ubuntu/gnome/wazir-gnome-search.py` implements `org.gnome.Shell.SearchProvider2` backed by `wa route --json` and `wazir-shell`.
- **Nautilus Extension**: `os/wazir-os-ubuntu/nautilus/wazir_nautilus_extension.py` adds 9 governed context-menu actions.
- **Reversible Profile**: `os/wazir-os-ubuntu/profile/wazir-gnome-profile.sh` backs up `dconf /org/gnome/` before applying dock/theme settings and supports `--revert`.
- **Status**: `IMPLEMENTED_NOT_VERIFIED` on live Ubuntu GNOME desktop (macOS host).
