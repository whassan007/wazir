# Wazir OS: Reproducible Build, Installation, and Rollback Guide

## Prerequisites
- Linux build host with `podman` (or `docker`), `node >= 22.13.0`, and `just` (optional)
- For ISO generation: `bootc-image-builder` (`quay.io/centos-bootc/bootc-image-builder:latest`)

## 1. Build Design Tokens, Spotlight, and OCI Image
```bash
bash os/wazir-os/image/build.sh
```
This builds `@wazir/design-tokens`, regenerates KDE/CSS/Konsole assets, compiles `@wazir/spotlight`, and produces the bootable OCI image `localhost/wazir-os:41`.

## 2. Generate Bootable Installer ISO
```bash
cd os/wazir-os/image
just build-iso
```
The resulting ISO is written to `os/wazir-os/image/output/bootiso/install.iso`.

## 3. Rebase an Existing Fedora Kinoite / Universal Blue System
```bash
sudo rpm-ostree rebase ostree-unverified-image:docker://ghcr.io/<your-org>/wazir-os:41
sudo systemctl reboot
```

## 4. Atomic Updates & Rollback After Update Failure
- **Update:**
  ```bash
  sudo bootc upgrade   # or: sudo rpm-ostree upgrade
  sudo systemctl reboot
  ```
- **Rollback (from running system or GRUB boot menu):**
  ```bash
  sudo bootc rollback  # or: sudo rpm-ostree rollback
  sudo systemctl reboot
  ```
Because Wazir OS Macification lives in `/usr/share` and `/etc/skel` inside the immutable OSTree deployment, OS updates and rollbacks preserve all user workspaces in `/var/home` without re-running theme scripts.
