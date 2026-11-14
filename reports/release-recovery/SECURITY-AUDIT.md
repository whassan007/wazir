# WAZIR v0.2.17 — PACKAGING SECURITY AUDIT

**Auditor:** Anthropic Claude Fleet (CLAUDE-02)  
**Date:** 2026-10-29T06:06:00Z  

---

## 1. Secrets & Private Material Scan
- Scanned 9 patterns across all tarball contents and packaged outputs:
  - Private keys (`BEGIN RSA/EC/DSA PRIVATE KEY`)
  - GitHub Personal Access Tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
  - NPM publish tokens (`npm_`)
  - Anthropic API keys (`sk-ant-`)
  - OpenAI API keys (`sk-proj-`, `sk-`)
  - AWS access keys (`AKIA...`)
  - Slack tokens (`xoxb-`, `xoxp-`, `xoxa-`)
  - Google API keys (`AIza...`)
  - Host developer paths
- **Result:** 0 matches found (`secrets-scan` check: **PASS**).

## 2. Package Lifecycle Scripts
- Audited tarball package manifests:
  - No `preinstall`, `postinstall`, or arbitrary shell lifecycle hooks in npm distribution bundle.
  - Safe for unprivileged global and local installation.

## 3. Filesystem Permissions & User Isolation
- Debian & RPM packages install system binaries to `/usr/bin/wa` with mode `0755`.
- Service daemons (`wazir-api.service`, `wazir-worker.service`) execute under dedicated system user/group `wazir:wazir` with home directory `/var/lib/wazir` (`0750`).
- No world-writable directories or permissive umask configurations.
