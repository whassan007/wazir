# Rollback Procedure

1. `main` in `/Users/wael/Code/Wazir` and `/Users/wael/Code/Fleet` were left untouched.
2. To roll back `integration/fleet-consolidation`, simply switch back to `main`:
   ```bash
   git checkout main
   ```
3. To delete the integration branch if desired:
   ```bash
   git branch -D integration/fleet-consolidation
   ```
