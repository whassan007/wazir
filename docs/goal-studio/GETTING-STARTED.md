# Wazir Goal Studio — Getting Started Guide

Welcome to **Wazir Goal Studio** (`@wazir/goals`), an evidence-gated strategic goal execution and governance subsystem.

---

## 1. Starting Goal Studio

### Starting the API & Web Dashboard
You can start the Goal Studio API server and Web Dashboard using either npm scripts or the CLI:

```sh
npm run start:dashboard
# or
wa web start
```

### Default URLs & Endpoints
- **API Base URL**: `http://127.0.0.1:4800/api/v1/goal-studio`
- **Web Dashboard**: `http://127.0.0.1:5173/` (click the **◎ Goal Studio** button in the top bar)
- **Direct Goal Studio UI**: `http://127.0.0.1:5173/goal-studio`

---

## 2. Creating a Goal

### Via CLI
- **Create a Custom Goal**:
  ```sh
  wa goal create "Formal Verification Milestone" --objective "Prove bounded safety invariant" --project research
  ```
- **Import YAML Graph**:
  ```sh
  wa goal import examples/goal-studio/nobel_goal_graph.yaml --project nobel
  ```

### Via Web UI
Navigate to `/goal-studio` and use:
- **New Goal** button to create goals interactively.
- **Import YAML** button to upload or paste a goal graph.
- **Load Nobel Example** button to instantly load the reference Nobel prize-winning discovery graph.

---

## 3. Executing & Monitoring Goals

### CLI Operations
- **Inspect Graph & Critical Path**:
  ```sh
  wa goal inspect <graphId>
  ```
- **Start a Run**:
  ```sh
  wa goal start <graphId>
  ```
- **Monitor Run Status**:
  ```sh
  wa goal status <runId>
  ```
- **Live SSE Event Stream**:
  ```sh
  curl -N http://127.0.0.1:4800/api/v1/goal-studio/runs/<runId>/events
  ```
- **Retry Targets**:
  ```sh
  # Retry eligible targets automatically
  wa goal retry <runId> <targetId> --eligible
  
  # Retry a specific target
  wa goal retry <runId> <targetId>
  ```
- **Execution Controls**:
  ```sh
  wa goal pause <runId>
  wa goal resume <runId>
  wa goal stop <runId>
  wa goal cancel <runId>
  ```
- **Scope-Bound Approvals**:
  ```sh
  wa goal approve <approvalId> --run <runId> --target <targetId>
  wa goal reject <approvalId>
  ```

### TUI Mission Control
Launch the interactive terminal UI:
```sh
wa tui
```
Inside `wa tui`:
- Press `7` or `g`, or run `/goals` to access Goal Mission Control.

---

## 4. Running the Nobel Goal Graph Example

You can run the reference Nobel goal graph example through multiple interfaces:

- **Standalone Script**:
  ```sh
  node examples/goal-studio/run-nobel-example.mjs
  # or
  node scripts/goal-studio-demo.mjs
  ```
- **CLI One-Liner**:
  ```sh
  wa goal nobel --start
  ```
- **Web UI**:
  Click **Load Nobel Example** in `/goal-studio`.

---

## 5. Viewing Results & Verified Artifacts

### CLI Results & Evidence
- **View Run Summary & Artifacts**:
  ```sh
  wa goal results <runId>
  wa goal results <runId> --json
  ```

### API Endpoints
- **Run Results**: `GET /api/v1/goal-studio/runs/<runId>/results`
- **Verification Evidence**: `GET /api/v1/goal-studio/runs/<runId>/evidence`

### Web UI Tabs
In the Goal Studio Inspector view, explore:
- **Verification / Evidence** tab
- **Artifacts** tab
- **Execution** tab
