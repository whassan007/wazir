# Rollback Procedure

## Portal Rollback (`wazir.wael.bot`)
1. Identify the previous known-good deployment ID via `wrangler pages deployment list --project-name wazir-portal`.
2. Promote the previous deployment or re-deploy the prior verified git tag (`git checkout v0.3.2` -> `wrangler pages deploy`).
3. Verify `curl -sI https://wazir.wael.bot` returns HTTP 200.

## Git & Binary Rollback
1. `git checkout fix/p0-reliability-recovery` (baseline `998d44b`) or `git checkout main` (`4fef398`).
2. Rebuild CLI & core with `npm run build`.
3. Do not run `git reset --hard` or destructive `git clean` against active worktrees.
