# Remaining Blockers

1. **Sandbox Loopback TCP (`EPERM 127.0.0.1`)**: 4 Vitest files (`checkpointTransport.test.ts`, `liquidShellOrchestrator.test.ts` live `llama-server` test, `jobOrchestratorCoordination.test.ts`) require host-side execution outside the terminal sandbox.
2. **Live Ubuntu GNOME VM**: GNOME Search Provider, Nautilus extension, `.deb` `apt install`, and autoinstall ISO require a live Ubuntu 24.04/26.04 GNOME environment.
