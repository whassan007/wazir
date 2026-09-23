// LspManager.ts – native LSP client integration for Wazir

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import { readFileSync, writeFileSync } from "fs";
import { Logger } from "@wazir/shared/src/logger"; // adjust import as needed

/**
 * Mapping from language identifier to the command used to start the language server.
 * Feel free to extend this map with additional servers.
 */
const SERVER_COMMANDS: Record<string, string[]> = {
  typescript: ["typescript-language-server", "--stdio"],
  python: ["pyright-langserver", "--stdio"],
  go: ["gopls", "serve"],
};

/**
 * LspManager maintains a set of language‑server processes for a given workspace.
 * It starts a server the first time a language is requested and keeps it alive
 * for the lifetime of the workspace (or until `dispose` is called).
 */
export class LspManager extends EventEmitter {
  private readonly root: string;
  private readonly servers = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly logger: Logger;

  constructor(root: string) {
    super();
    this.root = root;
    this.logger = new Logger({ component: "LspManager", workspace: root });
  }

  /**
   * Initialise (or retrieve) a language server for the requested language.
   * Returns the underlying child process so callers can communicate via its
   * stdio streams (JSON‑RPC).
   */
  public getServer(language: string): ChildProcessWithoutNullStreams {
    const normalized = language.toLowerCase();
    if (this.servers.has(normalized)) {
      return this.servers.get(normalized)!;
    }
    const command = SERVER_COMMANDS[normalized];
    if (!command) {
      throw new Error(`No LSP server configured for language: ${language}`);
    }
    const proc = spawn(command[0], command.slice(1), {
      cwd: this.root,
      env: { ...process.env, LANG: "en_US.UTF-8" },
    });
    proc.on("error", (err) => {
      this.logger.error(`LSP server error for ${language}: ${err.message}`);
      this.emit("error", err);
    });
    proc.stderr.on("data", (data) => {
      this.logger.debug(`LSP ${language} stderr: ${data.toString()}`);
    });
    this.servers.set(normalized, proc);
    this.logger.info(`Started LSP server for ${language}`);
    return proc;
  }

  /**
   * Gracefully shut down all running language‑server processes.
   */
  public async dispose(): Promise<void> {
    for (const [lang, proc] of this.servers.entries()) {
      this.logger.info(`Stopping LSP server for ${lang}`);
      proc.kill();
    }
    this.servers.clear();
  }
}

export default LspManager;
