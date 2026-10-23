# Cost and Agent Ledger: Goal Studio Operations

## 1. Mandatory Model Cost Policy
- **CHEAP (`flash_lite`)**: Default tier for Git lineage, cleanup, reusable examples, documentation, smoke tests, release engineering, and final reporting.
- **STANDARD (`flash`)**: Default tier for CLI integration, Web UI components, and API wiring.
- **PREMIUM (`pro`)**: Exception-only tier. Requires prior justification and approval, with a strict target of **0 escalations**.

---

## 2. Agent Allocation Table (A1 – A8)

| Agent ID | Role / Scope | Assigned Model Tier | Model Name / Identifier |
| :--- | :--- | :--- | :--- |
| **A1** (`b2be6bd2-9b25-4d14-8c4b-f0f4f2194ce7`) | Git synchronization & safe worktree cleanup | CHEAP | `flash_lite` |
| **A2** | Goal Studio CLI integration | STANDARD | `flash` |
| **A3** | Goal Studio Web UI | STANDARD | `flash` |
| **A4** (`038b7a46-2c4e-4f42-b838-a87dafde1c06`) | Goal lifecycle API wiring | STANDARD | `flash` |
| **A5** (`b3918fbb-b518-4b40-b525-c3bd42df35c0`) | Nobel Goal Graph reusable example | CHEAP | `flash_lite` |
| **A6** | Getting-started documentation | CHEAP | `flash_lite` |
| **A7** | Operational smoke tests | CHEAP | `flash_lite` |
| **A8** | Integration coordination & final reporting | CHEAP | `flash_lite` |

---

## 3. Shared API Contract Summary (A2, A3, A4, A7)

- `POST /api/v1/goal-studio/graphs/create`
- `POST /api/v1/goal-studio/graphs/seed-nobel`
- `POST /api/v1/goal-studio/runs/:runId/cancel`
- `GET /api/v1/goal-studio/runs/:runId/results`
