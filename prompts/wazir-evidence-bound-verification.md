 You are fixing P0 correctness defects in the Wazir coding harness.
  
  The objective is to make Wazir's definition of "success" evidence-bound:
  
      COMPLETE must mean the current workspace state was independently
      built, tested, and verified where required.
  
  It must NEVER mean:
  
      the model said it was done
      files were attempted
      files exist
      a previous revision compiled
      a tool reported success without external state confirmation
      verification logic merely observed agent completion
  
  This work has three P0 requirements:
  
      1. Evidence-bound verification with workspace revision fencing
      2. Filesystem-proven FILE_CHANGED semantics
      3. Workspace-scoped build permissions without interactive approval stalls
  
  Then add mandatory release-gate tests proving these invariants.
  
  Do not redesign Wazir.
  Do not add unrelated features.
  Do not weaken PolicyEngine.
  Do not trust model prose as verification evidence.
  Do not solve this with special cases for C++ or `make`.
  Do not copy another harness architecture wholesale.
  
  Reuse Wazir's existing:
  
      Execution
      Workspace
      ToolExecutor
      PolicyEngine
      Verifier/Evaluator
      Event system
      Audit
      Provenance
      Job
      Agent
      Runtime
      Worker
  
  Extend those abstractions where necessary.
  
  =======================================================================
  OBSERVED PRODUCTION FAILURE
  =======================================================================
  
  A real Wazir coding execution produced this sequence:
  
      Source revision N
          ↓
      make
          ↓
      FAIL
  
      model repairs source
          ↓
      additional source mutations
          ↓
      make requested
          ↓
      blocked waiting for interactive policy approval
          ↓
      direct g++ compilation
          ↓
      FAIL
  
      model edits Calendar.h
          ↓
      NO SUCCESSFUL BUILD AFTER THIS MUTATION
          ↓
      TEST "Verification checks running"
          ↓
      "Verification checks passed"
          ↓
      COMPLETE
  
  This is a false-positive completion.
  
  The same execution also produced:
  
      ERROR edit failed — oldString not found in file
      INFO  files-changed: Calendar.cpp
  
  This is a false-positive mutation event.
  
  Both violate the integrity of Wazir's provenance and verification model.
  
  =======================================================================
  P0 INVARIANT #1
  EVIDENCE-BOUND VERIFICATION
  =======================================================================
  
  Implement the following invariant:
  
      WORKSPACE REVISION R
               │
               ├───────────────┐
               ↓               ↓
        BUILD EVIDENCE     TEST EVIDENCE
        revision = R       revision = R
        exitCode = 0       exitCode = 0
               │               │
               └───────┬───────┘
                       ↓
                    VERIFY
                       ↓
            evidence revision == R?
                       ↓
                      YES
                       ↓
                    COMPLETE
  
  Any relevant workspace mutation creates a new revision.
  
  Example:
  
      Revision 8
          ↓
      BUILD PASS at revision 8
          ↓
      TEST PASS at revision 8
          ↓
      edit Calendar.h
          ↓
      Revision 9
  
  At this point:
  
      Build evidence R8 = STALE
      Test evidence R8  = STALE
  
  Wazir MUST NOT complete revision 9 until the required evidence has been
  regenerated against revision 9.
  
  =======================================================================
  WORKSPACE REVISION
  =======================================================================
  
  Introduce or extend the existing workspace state mechanism with a monotonic
  revision.
  
  Conceptually:
  
      WorkspaceState {
          workspaceId
          revision
          contentFingerprint
          updatedAt
      }
  
  Every verified filesystem mutation relevant to the execution increments:
  
      workspace.revision
  
  Examples:
  
      write changes content        → increment
      edit changes content         → increment
      delete existing file         → increment
      rename/move                  → increment
      patch changes content        → increment
  
  But:
  
      failed edit                  → DO NOT increment
      write identical content      → DO NOT increment
      failed delete                → DO NOT increment
      failed tool invocation       → DO NOT increment
  
  The revision represents actual observed workspace state, not requested
  mutation intent.
  
  =======================================================================
  EVIDENCE MODEL
  =======================================================================
  
  Represent verification evidence explicitly.
  
  Conceptually:
  
      VerificationEvidence {
          id
          type
          executionId
          workspaceId
          revision
          command?
          exitCode
          startedAt
          completedAt
          artifactFingerprint?
          metadata
      }
  
  Minimum evidence types:
  
      BUILD
      TEST
      RUN
      STATIC_CHECK
  
  Do not require every task to use every evidence type.
  
  The task's acceptance contract determines which evidence types are required.
  
  Example coding task:
  
      requiredEvidence:
          BUILD
          TEST
  
  Simple executable task may require:
  
      BUILD
      RUN
  
  Repository repair task may require:
  
      BUILD
      TEST
  
  Verifier must evaluate required evidence against the CURRENT revision.
  
  =======================================================================
  STALE EVIDENCE
  =======================================================================
  
  Do not necessarily delete old evidence when workspace state changes.
  
  Preserve it for provenance.
  
  Instead classify it:
  
      CURRENT
      STALE
      FAILED
  
  Example:
  
      BUILD
        revision: 8
        exitCode: 0
  
      Workspace
        revision: 9
  
  Result:
  
      BUILD evidence exists
      BUILD evidence is STALE
  
  This distinction matters for diagnostics and audit.
  
  =======================================================================
  VERIFIER CONTRACT
  =======================================================================
  
  The verifier must never infer success from:
  
      agent status
      model narration
      filesChanged count
      existence of files
      presence of a Makefile
      previous successful build
      previous successful tests
      tool invocation intent
  
  Instead:
  
      verifier.verify({
          workspaceRevision,
          acceptanceContract,
          evidence
      })
  
  must require evidence satisfying:
  
      evidence.revision === workspace.currentRevision
  
  and:
  
      evidence.exitCode === 0
  
  for every required evidence type.
  
  If not:
  
      VERIFICATION_FAILED
  
  with a precise reason.
  
  Examples:
  
      NO_BUILD_EVIDENCE
  
      BUILD_FAILED
  
      BUILD_EVIDENCE_STALE
  
      TEST_EVIDENCE_MISSING
  
      TEST_EVIDENCE_STALE
  
      TEST_FAILED
  
      RUN_EVIDENCE_STALE
  
  =======================================================================
  REVISION FENCING
  =======================================================================
  
  Completion itself must be revision-fenced.
  
  Conceptually:
  
      CompletionRequest {
          executionId
          targetRevision
      }
  
  Before transitioning:
  
      EXECUTION → COMPLETE
  
  atomically verify:
  
      targetRevision === workspace.currentRevision
  
  If the workspace changes between verification and completion:
  
      reject completion
  
  with:
  
      STALE_WORKSPACE_REVISION
  
  This prevents:
  
      verify revision 12
          ↓
      another mutation creates revision 13
          ↓
      completion request for revision 12
          ↓
      incorrectly completing revision 13
  
  The completion transition must therefore be conditional on the exact
  verified revision.
  
  =======================================================================
  VERIFY THE WORLD, NOT THE MODEL
  =======================================================================
  
  Adopt this principle throughout Wazir:
  
      Model claims are hypotheses.
      External state is evidence.
  
  For filesystem tasks:
  
      inspect filesystem
  
  For builds:
  
      execute build
  
  For tests:
  
      execute tests
  
  For program behavior:
  
      execute program and validate output
  
  For file mutation:
  
      compare filesystem state
  
  Never use:
  
      "I fixed it"
      "tests should pass"
      "implementation complete"
  
  as evidence.
  
  Model narration may be displayed to the user but cannot satisfy an
  acceptance criterion.
  
  =======================================================================
  P0 INVARIANT #2
  FILES_CHANGED MUST REPRESENT PHYSICAL STATE
  =======================================================================
  
  Observed bug:
  
      ERROR edit failed — oldString not found in file
      INFO  files-changed: Calendar.cpp
  
  Fix the source of this bug.
  
  Do not simply suppress the UI event.
  
  Trace:
  
      ToolExecutor
          ↓
      mutation operation
          ↓
      tool result
          ↓
      mutation detection
          ↓
      FILE_CHANGED
          ↓
      Execution.filesChanged
          ↓
      Artifact Provenance
          ↓
      Verifier
  
  FILE_CHANGED must derive from actual filesystem state.
  
  =======================================================================
  MUTATION DETECTION
  =======================================================================
  
  Preferred mechanism:
  
      BEFORE MUTATION
          fingerprint relevant path
  
      TOOL EXECUTION
  
      AFTER MUTATION
          fingerprint relevant path
  
      COMPARE
  
  Conceptually:
  
      FileMutationResult {
          path
          attempted
          toolSucceeded
          existedBefore
          existsAfter
          beforeHash
          afterHash
          changed
      }
  
  Only:
  
      changed === true
  
  may emit:
  
      FILE_CHANGED
  
  Examples:
  
      edit succeeds + bytes differ
          → FILE_CHANGED
  
      edit fails
          → no FILE_CHANGED
  
      write succeeds but bytes identical
          → no FILE_CHANGED
  
      delete succeeds
          → FILE_CHANGED
  
      rename succeeds
          → appropriate mutation events
  
  Do not derive mutation from tool arguments.
  
  Do not assume:
  
      tool = edit
  
  means:
  
      file changed
  
  =======================================================================
  TURN/WORKSPACE DIFF
  =======================================================================
  
  Where practical, add a secondary workspace-level state probe.
  
  For Git workspaces this may use the existing Git integration to capture
  tree/diff state.
  
  For non-Git workspaces use Wazir's filesystem state tracker.
  
  The authoritative question is:
  
      What physically changed?
  
  not:
  
      What did the model ask the tool to change?
  
  Do not make Git mandatory for Wazir workspaces.
  
  =======================================================================
  FAILED MUTATION INVARIANT
  =======================================================================
  
  The following must always hold:
  
      failed mutation
          ↓
      workspace revision unchanged
          ↓
      FILE_CHANGED not emitted
          ↓
      filesChanged unchanged
          ↓
      build/test evidence remains valid IF physical state truly remained
      unchanged
  
  This last condition matters.
  
  Do NOT invalidate verification evidence merely because a mutation was
  attempted.
  
  Invalidate evidence only if workspace state actually changed.
  
  =======================================================================
  P0 INVARIANT #3
  WORKSPACE-SCOPED BUILD CAPABILITY
  =======================================================================
  
  Observed behavior:
  
      make requested
          ↓
      PolicyEngine considers command state modifying
          ↓
      interactive approval
          ↓
      approximately five-minute wait
          ↓
      command denied
  
  This is inappropriate for normal deterministic build operations inside an
  isolated coding workspace.
  
  Do NOT globally allow `make`.
  
  Do NOT create a command-name allowlist as the security model.
  
  Introduce or extend a capability equivalent to:
  
      BUILD_WORKSPACE
  
  Policy decision should depend on:
  
      capability
      workspace scope
      filesystem boundaries
      network policy
      executable provenance
      execution context
  
  not merely:
  
      command mutates state
  
  =======================================================================
  BUILD_WORKSPACE POLICY
  =======================================================================
  
  Conceptually:
  
      capability: BUILD_WORKSPACE
  
      scope:
          current execution workspace
  
      filesystem:
          read/write inside workspace
          deny external writes by default
  
      network:
          inherit execution policy
          preferably denied unless explicitly required
  
      audit:
          required
  
      interactiveApproval:
          false for compliant workspace-local builds
  
  Typical build commands may include:
  
      make
      cmake --build
      ninja
      g++
      clang++
      cargo build
      go build
      npm run build
      pnpm build
      yarn build
  
  But command names alone MUST NOT grant permission.
  
  For example:
  
      make
  
  inside:
  
      /execution/workspace
  
  may be allowed.
  
  But:
  
      make -C /etc/...
  
  must not inherit workspace permission merely because executable == make.
  
  Policy must evaluate effective filesystem scope.
  
  =======================================================================
  EXTERNAL PATH ESCAPE
  =======================================================================
  
  A build operation that attempts to write outside the authorized workspace
  must:
  
      DENY
  
  or:
  
      REQUIRE_APPROVAL
  
  according to Wazir policy.
  
  Examples:
  
      g++ main.cpp -o ./build/app
          → workspace-local
  
      make
          → workspace-local if actual effects remain inside workspace
  
      cp artifact /usr/local/bin
          → external mutation
  
      make install
          → likely external mutation
  
  These are different capabilities.
  
  Do not conflate:
  
      BUILD_WORKSPACE
  
  with:
  
      INSTALL_SYSTEM_ARTIFACT
  
  =======================================================================
  BUILD EVIDENCE
  =======================================================================
  
  A permitted BUILD_WORKSPACE invocation must produce structured evidence.
  
  Example:
  
      {
        type: "BUILD",
        workspaceId: "...",
        revision: 17,
        command: "make",
        exitCode: 0,
        durationMs: 4213
      }
  
  Only exit code 0 produces passing BUILD evidence.
  
  If:
  
      make → exit 2
  
  record failed evidence.
  
  Do not erase it.
  
  If source changes afterward, both passing and failed historical evidence
  remain in provenance but are no longer current.
  
  =======================================================================
  ACCEPTANCE CONTRACT
  =======================================================================
  
  Introduce or reuse an explicit acceptance contract.
  
  Example:
  
      AcceptanceContract {
          taskType: "coding",
          requiredEvidence: [
              "BUILD",
              "TEST"
          ]
      }
  
  The controller, not the model, owns this contract.
  
  The model cannot remove required evidence.
  
  The model cannot declare:
  
      tests unnecessary
  
  and bypass the contract.
  
  For tasks without tests, the planner/controller may create an appropriate
  contract such as:
  
      BUILD
      RUN
  
  But this decision must happen before final verification and be auditable.
  
  =======================================================================
  EXECUTION STATE MACHINE
  =======================================================================
  
  Strengthen the state machine.
  
  Desired flow:
  
      PLAN
        ↓
      IMPLEMENT
        ↓
      BUILD
        ├── FAIL
        │     ↓
        │   REPAIR
        │     ↓
        │   BUILD
        │
        └── PASS
              ↓
            TEST
              ├── FAIL → REPAIR
              └── PASS
                    ↓
                 VERIFY
                    ↓
                 COMPLETE
  
  Any verified source mutation after BUILD PASS:
  
      BUILD PASS
          ↓
      FILE_CHANGED
          ↓
      BUILD evidence becomes stale
          ↓
      state returns to BUILD_REQUIRED
  
  Any source mutation after TEST PASS:
  
      TEST PASS
          ↓
      FILE_CHANGED
          ↓
      BUILD/TEST evidence becomes stale as appropriate
          ↓
      verification impossible until regenerated
  
  Do not allow:
  
      EDIT
        ↓
      COMPLETE
  
  for coding tasks requiring build/test evidence.
  
  =======================================================================
  RELEASE-GATE TEST 1
  NO SUCCESSFUL BUILD FOR CURRENT REVISION
  =======================================================================
  
  Implement a deterministic test equivalent to:
  
      it("P0: rejects verification if no successful build exists for current revision")
  
  Scenario:
  
      write broken main.cpp
          revision = 1
  
      compile
          exit = 1
  
      record:
          BUILD revision 1 exit 1
  
      repair main.cpp
          revision = 2
  
      DO NOT compile
  
      verify revision 2
  
  Expected:
  
      VERIFICATION_FAILED
  
  Reason equivalent to:
  
      No successful build exists for current workspace revision
  
  Expected metadata:
  
      currentRevision = 2
      latestSuccessfulBuildRevision = null
  
  COMPLETE must be impossible.
  
  =======================================================================
  RELEASE-GATE TEST 2
  MUTATION INVALIDATES PASSING EVIDENCE
  =======================================================================
  
  Scenario:
  
      write valid source
          revision = 1
  
      build
          revision = 1
          exit = 0
  
      tests
          revision = 1
          exit = 0
  
      verify revision 1
          → PASS
  
      modify source
          revision = 2
  
      verify revision 2
  
  Expected:
  
      VERIFICATION_FAILED
  
  with:
  
      currentRevision = 2
      latestSuccessfulBuildRevision = 1
  
  Reason:
  
      Build evidence is stale
  
  Then:
  
      build revision 2 → exit 0
      tests revision 2 → exit 0
  
  Verify revision 2:
  
      VERIFICATION_PASSED
  
  =======================================================================
  RELEASE-GATE TEST 3
  FAILED EDIT DOES NOT CHANGE REVISION
  =======================================================================
  
  Scenario:
  
      Calendar.cpp =
          "void setup();"
  
      revision = R
  
  Attempt:
  
      edit:
          oldString = "non_existent_anchor"
          newString = "replacement"
  
  Expected:
  
      editResult.success = false
  
      workspace.currentRevision == R
  
      filesystem bytes unchanged
  
      getFilesChangedSince(R) == []
  
      FILE_CHANGED event count == 0
  
      existing verification evidence remains valid because physical state did
      not change
  
  =======================================================================
  RELEASE-GATE TEST 4
  SUCCESSFUL NO-OP DOES NOT CHANGE REVISION
  =======================================================================
  
  Attempt an operation that reports success but leaves bytes unchanged.
  
  Expected:
  
      workspace revision unchanged
      FILE_CHANGED = 0
  
  This proves Wazir tracks state rather than tool success.
  
  =======================================================================
  RELEASE-GATE TEST 5
  RACE BETWEEN VERIFY AND COMPLETE
  =======================================================================
  
  Scenario:
  
      revision 10
      BUILD PASS R10
      TEST PASS R10
  
      verifier verifies R10
  
  Before completion transition:
  
      mutate workspace
          revision 11
  
  Attempt:
  
      COMPLETE targetRevision=10
  
  Expected:
  
      rejected:
  
          STALE_WORKSPACE_REVISION
  
  Current revision:
  
      11
  
  The execution must return to the appropriate verification/build-required
  state.
  
  =======================================================================
  RELEASE-GATE TEST 6
  WORKSPACE BUILD REQUIRES NO INTERACTIVE APPROVAL
  =======================================================================
  
  Inside isolated execution workspace:
  
      make
  
  with outputs confined to workspace.
  
  Expected:
  
      BUILD_WORKSPACE allowed
      no interactive approval
      no approval timeout
      audit event emitted
      build evidence recorded
  
  =======================================================================
  RELEASE-GATE TEST 7
  BUILD ESCAPING WORKSPACE IS BLOCKED
  =======================================================================
  
  Attempt a build/tool operation that writes outside the authorized workspace.
  
  Expected:
  
      policy deny or explicit approval
  
  depending on configured policy.
  
  It must NOT inherit BUILD_WORKSPACE permission.
  
  =======================================================================
  RELEASE-GATE TEST 8
  MODEL SELF-REPORT CANNOT PASS
  =======================================================================
  
  Model returns:
  
      "Everything compiles and all tests pass."
  
  But no BUILD or TEST evidence exists.
  
  Expected:
  
      VERIFICATION_FAILED
  
  The exact prose must have zero effect on verifier outcome.
  
  =======================================================================
  RELEASE-GATE TEST 9
  FAILED BUILD THEN EDIT THEN COMPLETE
  =======================================================================
  
  Reproduce the real Wazir failure exactly:
  
      compile R1 → FAIL
      edit → R2
      compile R2 → FAIL
      edit → R3
      model says done
      verifier runs
  
  Expected:
  
      VERIFICATION_FAILED
  
  No successful build exists for R3.
  
  This test permanently prevents recurrence of the observed production bug.
  
  =======================================================================
  RELEASE-GATE TEST 10
  FULL GOLDEN PATH
  =======================================================================
  
  Scenario:
  
      implement program
          ↓
      BUILD revision R
          exit 0
          ↓
      TEST revision R
          exit 0
          ↓
      VERIFY revision R
          PASS
          ↓
      COMPLETE revision R
  
  Expected provenance:
  
      Workspace R
         │
         ├── BUILD R PASS
         ├── TEST R PASS
         └── VERIFY R PASS
                  ↓
               COMPLETE R
  
  All evidence must reference the same workspace revision.
  
  =======================================================================
  OBSERVABILITY
  =======================================================================
  
  Expose evidence state in execution diagnostics.
  
  Example:
  
      Workspace revision: 17
  
      Evidence
        BUILD   R17   PASS
        TEST    R17   PASS
        RUN     --    not required
  
      Verification
        R17     PASS
  
  If source changes:
  
      Workspace revision: 18
  
      Evidence
        BUILD   R17   STALE
        TEST    R17   STALE
  
      Required
        BUILD
        TEST
  
  Fleet should make it obvious why completion is blocked.
  
  =======================================================================
  SEMANTIC EVENTS
  =======================================================================
  
  Use or extend Wazir events:
  
      WORKSPACE_REVISION_CHANGED
      FILE_CHANGED
      BUILD_STARTED
      BUILD_COMPLETED
      TEST_STARTED
      TEST_COMPLETED
      VERIFICATION_STARTED
      VERIFICATION_FAILED
      VERIFICATION_PASSED
      EVIDENCE_STALE
      COMPLETION_REJECTED
  
  Events must contain revision IDs where relevant.
  
  Example:
  
      BUILD_COMPLETED
          workspaceRevision: 17
          exitCode: 0
  
  Never emit:
  
      FILE_CHANGED
  
  for a failed/no-op mutation.
  
  =======================================================================
  AUDIT
  =======================================================================
  
  Record enough information to answer:
  
      What exact workspace revision was verified?
  
      What build proved it compiled?
  
      What tests proved it worked?
  
      Did the workspace change after those tests?
  
      Which mutation created the current revision?
  
      Why was completion accepted or rejected?
  
  Do not store secrets or unnecessary model reasoning.
  
  =======================================================================
  IMPLEMENTATION ORDER
  =======================================================================
  
  Implement in this exact order:
  
  1. Trace current FILE_CHANGED emission path.
  
  2. Fix filesystem mutation detection.
  
  3. Add/repair workspace revision tracking.
  
  4. Bind BUILD/TEST/RUN evidence to revisions.
  
  5. Implement stale-evidence semantics.
  
  6. Revision-fence verifier.
  
  7. Revision-fence COMPLETE transition.
  
  8. Add acceptance contracts.
  
  9. Add BUILD_WORKSPACE policy capability.
  
  10. Remove workspace-local build approval stalls.
  
  11. Add all deterministic release-gate tests.
  
  12. Re-run the real clinic reservation task.
  
  Do not start with UI changes.
  
  Correctness first.
  
  =======================================================================
  IMPORTANT ARCHITECTURAL RULE
  =======================================================================
  
  Do not create separate competing notions of:
  
      workspace state
      files changed
      build state
      verification state
  
  There must be one causal chain:
  
      Physical Filesystem
             ↓
      Workspace Revision
             ↓
        Execution Evidence
             ↓
      Acceptance Contract
             ↓
          Verifier
             ↓
      Completion Transition
  
  This should become Wazir's authoritative completion model.
  
  =======================================================================
  REAL-WORLD ACCEPTANCE TEST
  =======================================================================
  
  After deterministic tests pass, rerun:
  
      Build a C++ program implementing a clinic reservation system.
  
  The previous execution consumed approximately:
  
      196,730 input tokens
      7,274 output tokens
      30 model calls
      821 seconds
  
  Do NOT optimize those numbers in this change unless required for correctness.
  
  This patch is primarily about trustworthy completion.
  
  Intentionally introduce or preserve a compilation error during one test run.
  
  Verify Wazir performs:
  
      BUILD R1 → FAIL
  
      REPAIR
          ↓
      FILE_CHANGED
          ↓
      R2
  
      BUILD R2 → PASS
  
      TEST R2 → PASS
  
      VERIFY R2 → PASS
  
      COMPLETE R2
  
  Then perform an additional controlled mutation after BUILD R2.
  
  Expected:
  
      R3
      BUILD R2 → STALE
      TEST R2 → STALE
      COMPLETE → BLOCKED
  
  Only after:
  
      BUILD R3 → PASS
      TEST R3 → PASS
      VERIFY R3 → PASS
  
  may:
  
      COMPLETE R3
  
  occur.
  
  =======================================================================
  FINAL REPORT
  =======================================================================
  
  Do not simply report "fixed."
  
  Return:
  
  ROOT CAUSE 1 — FALSE VERIFICATION
      exact code path
      why stale/missing evidence was accepted
      files changed
      tests proving fix
  
  ROOT CAUSE 2 — FALSE FILE_CHANGED
      exact event path
      why failed edit emitted mutation
      files changed
      tests proving fix
  
  ROOT CAUSE 3 — BUILD POLICY STALL
      exact policy decision
      why workspace-local make required approval
      BUILD_WORKSPACE implementation
      escape-boundary tests
  
  WORKSPACE REVISION MODEL
      revision creation
      mutation detection
      no-op behavior
      concurrency behavior
  
  EVIDENCE MODEL
      BUILD
      TEST
      RUN
      stale/current rules
  
  VERIFICATION MODEL
      acceptance contract
      revision fencing
      completion fencing
  
  TEST RESULTS
      list every new release-gate test
      pass/fail
  
  REAL CLINIC TASK
      workspace revisions
      build evidence
      test evidence
      verification evidence
      final completion revision
  
  REMAINING LIMITATIONS
  
  Do not declare this work complete unless every P0 release-gate test passes.
  
  =======================================================================
  FINAL INVARIANTS
  =======================================================================
  
  Wazir must guarantee:
  
      MODEL CLAIM ≠ EVIDENCE
  
      TOOL SUCCESS ≠ FILE MUTATION
  
      TOOL INTENT ≠ FILE MUTATION
  
      FAILED EDIT → NO REVISION CHANGE
  
      NO-OP WRITE → NO REVISION CHANGE
  
      PHYSICAL MUTATION → NEW REVISION
  
      BUILD PASS(R) + MUTATION(R+1)
          → BUILD PASS(R) IS STALE
  
      TEST PASS(R) + MUTATION(R+1)
          → TEST PASS(R) IS STALE
  
      VERIFY(R) + MUTATION(R+1)
          → COMPLETE(R) MUST FAIL
  
      COMPLETE(R)
          requires
          CURRENT WORKSPACE == R
          AND
          ALL REQUIRED EVIDENCE == PASS(R)
  
  The authoritative success path is:
  
      PHYSICAL WORKSPACE R
              ↓
         BUILD R PASS
              ↓
          TEST R PASS
              ↓
         VERIFY R PASS
              ↓
         COMPLETE R
  
  Anything weaker is not a successful Wazir coding execution.
