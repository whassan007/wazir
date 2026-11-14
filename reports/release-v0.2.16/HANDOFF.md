# Release Handoff & Operator Instructions

**Release:** `v0.2.16`  
**Candidate Commit:** `a2f420f1961202455477e0f2c1309faad4319828`  
**Stabilization Branch:** `release/v0.2.16-stabilization`  
**Final Release Decision:** **GO**

### Recommended Publication Steps:
1. Version bump commit from `0.2.15` to `0.2.16`:
   ```bash
   npm version 0.2.16 --no-git-tag-version
   ```
2. Commit on `release/v0.2.16-stabilization`:
   ```bash
   git add -A && git commit -m "chore(release): prepare v0.2.16 stabilization release"
   ```
3. Tag the release:
   ```bash
   git tag -a v0.2.16 -m "Release v0.2.16: Linux PTY, Windows portability, and production stabilization"
   ```
4. Push stabilization branch and tag to origin:
   ```bash
   git push origin release/v0.2.16-stabilization --tags
   ```
5. Trigger GitHub Actions Release workflow for `v0.2.16`.
