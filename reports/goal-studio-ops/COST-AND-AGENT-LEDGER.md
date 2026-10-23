# Cost and Agent Ledger: Goal Studio Operations (Final)

## 1. Mandatory Model Cost Policy
- **CHEAP (`flash_lite`)**: Default tier for Git lineage, cleanup, reusable examples, documentation, smoke tests, release engineering, and final reporting. (5 agents)
- **STANDARD (`flash`)**: Default tier for CLI integration, Web UI components, and API wiring. (3 agents)
- **PREMIUM (`pro`)**: Exception-only tier. Requires prior justification and approval, with a strict target of **0 escalations**. (0 agents used)

---

## 2. Complete 8-Agent Execution & Allocation Table (A1 – A8)

| Agent ID | Role / Scope | Model Tier | Model Name | Status | Commit SHA | Verification Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A1** (`b2be6bd2-9b25-4d14-8c4b-f0f4f2194ce7`) | Git sync & safe worktree cleanup | CHEAP | `flash_lite` | COMPLETED | `871d1ee28c7904fe911e6afc3480b168a5bfdc43` | Clean baseline published to `origin/main` |
| **A2** | Goal Studio CLI integration | STANDARD | `flash` | COMPLETED | `8e0841099076c13ec5657976443f2ff7db70d437` | 17/17 CLI unit tests passed (`goalCliOps.test.ts`) |
| **A3** | Goal Studio Web UI | STANDARD | `flash` | COMPLETED | `18b79380f4d14523de59ae746656facfd766ab74` | 19/19 UI unit tests passed (`goalStudioUi.test.ts`) |
| **A4** (`038b7a46-2c4e-4f42-b838-a87dafde1c06`) | Goal lifecycle API wiring | STANDARD | `flash` | COMPLETED | `916f83e8d6fcbef34c3713d70a3a61644b01b442` | 3/3 API lifecycle tests passed (`opsLifecycle.goalStudio.test.ts`) |
| **A5** (`b3918fbb-b518-4b40-b525-c3bd42df35c0`) | Nobel Goal Graph reusable example | CHEAP | `flash_lite` | COMPLETED | `c6327b0137c805a2d4836c56038b8c10afb37aee` | Executed successfully (`SUCCESS_WITH_EXTERNAL_GATES`) |
| **A6** | Getting-started documentation | CHEAP | `flash_lite` | COMPLETED | `ed984f786674a100c03017325e87b2e6adea5296` | Verified architecture guides & quickstart docs |
| **A7** | Operational smoke tests | CHEAP | `flash_lite` | COMPLETED | `d4f563d594570cad38e3b3e2414fa6f75a5a5884` | 4/4 operational smoke tests passed (`operationalSmoke.test.ts`) |
| **A8** | Integration coordination & final reporting | CHEAP | `flash_lite` | COMPLETED | *Current* | Octopus merge & targeted verification successful |

---

## 3. Shared API Contract Summary (A2, A3, A4, A7)

- `POST /api/v1/goal-studio/graphs/create`
- `POST /api/v1/goal-studio/graphs/seed-nobel`
- `POST /api/v1/goal-studio/runs/:runId/cancel`
- `GET /api/v1/goal-studio/runs/:runId/results`
