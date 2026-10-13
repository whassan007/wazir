# Installing Wazir

| Platform | Command | Artifact |
|---|---|---|
| Any (Node.js ≥ 22.13) | `npm install -g wazir` | npm package (bundled CLI; native modules optional) |
| macOS (arm64, x64), Linux | `brew install whassan007/tap/wazir` | the npm package, installed with Homebrew's Node |
| Windows (x64) | `powershell -ExecutionPolicy Bypass -File install.ps1` | `wazir-<v>-windows-x64.zip` (standalone `wa.exe`, no Node needed) |
| Windows | `scoop install <bucket>/wazir` | same zip |
| Windows | `winget install whassan007.Wazir` | same zip (portable) |

Every release asset is listed with its SHA-256 in the release's `SHA256SUMS` and carries a
GitHub build-provenance attestation (`gh attestation verify <file> --repo whassan007/wazir`).

**Data is never part of the installation.** Configuration, the resource ledger, account
mappings, execution history and agent preflight results live in `~/.wazir`
(`%USERPROFILE%\.wazir`, or `$WAZIR_HOME`). Installing, upgrading and uninstalling through any
channel leaves that directory alone, and nothing touches your shell profiles or the external
agents' own logins. Run `wa doctor` after installing.

The standalone Windows executable embeds Node.js; the optional native modules are not available
inside it, so the interactive PTY terminal tool is unavailable and secrets use the encrypted file
store instead of Windows Credential Manager. Install with npm for those.

## Status

Until the first release made with this pipeline is published, the commands that name a remote
repository (`npm install -g wazir`, the tap, the bucket, `winget install`) do not work yet. See
the release-readiness matrix in `docs/distribution/RELEASE_READINESS.md`.

## Maintainer: how a release reaches each channel

1. Bump the version (package.json, package-lock.json, packages/core, apps/cli, the fallback in
   apps/cli/src/index.ts; `canonicalVersion.test.ts` checks them), update CHANGELOG.md, merge.
2. Push an annotated tag `vX.Y.Z` on main. `release.yml` builds, runs `package:check`, builds
   `wa.exe` on Windows, computes `SHA256SUMS`, attests provenance and creates a **draft** release.
3. Review the draft and publish it.
4. `update-manifests.yml` downloads the published assets, verifies checksums and attestation,
   renders `Formula/wazir.rb`, `packaging/scoop/wazir.json` and
   `packaging/winget/manifests/...`, and opens a PR here. Review and merge it.
5. External channels (each needs the owner's authorization; nothing does this automatically):
   - **npm**: run the Release workflow manually with `publish_npm: true`; the `npm-publish`
     environment must require reviewers, and trusted publishing must be configured on npmjs.com.
   - **Homebrew tap**: create `whassan007/homebrew-tap` once, then copy `Formula/wazir.rb` into
     its `Formula/` directory.
   - **Scoop**: create a bucket repository (e.g. `whassan007/scoop-bucket`) and copy
     `packaging/scoop/wazir.json` into it (`scoop bucket add whassan007 <url>`).
   - **WinGet**: open a PR to `microsoft/winget-pkgs` with the directory under
     `packaging/winget/manifests/` (or use `wingetcreate submit`).

## Rollback

Unpublish nothing; publish a fixed patch version instead (npm versions and release assets are
immutable). To pull a bad Homebrew/Scoop/WinGet version, revert the manifest PR (and the tap,
bucket or winget-pkgs change). Users can pin: `npm install -g wazir@<v>`,
`install.ps1 -Version <v>`, `scoop install wazir@<v>`, `winget install whassan007.Wazir -v <v>`.
