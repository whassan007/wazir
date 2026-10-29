# Linux PTY Verification Report

**Environment:** Linux (x64 / arm64)  
**Binary Under Test:** `node_modules/node-pty/build/Release/pty.node`  
**Test Suite:** `packages/tools/tests/terminalSession.test.ts`

### Results:
```text
 ✓ packages/tools/tests/terminalSession.test.ts (8)
   ✓ TerminalSession (real PTY) (6)
     ✓ runs a command and settles via the prompt marker, not just a timeout
     ✓ reports a non-zero exit code through the marker
     ✓ strips ANSI/control sequences from pending output
     ✓ clears pending output between sends (decoupled from scrollback)
     ✓ persists shell state across sends (it is one session, not one-shot)
     ✓ gracefully disposes and kills the underlying PTY
   ✓ terminal_open / terminal_send / terminal_close tools (2)
     ✓ opens, sends, and closes a session end to end
     ✓ rejects sending to an unknown session

Test Files  1 passed (1)
     Tests  8 passed (8)
```
PTY native compilation and zero-scrollback headless lifecycle are fully functional without mocks.
