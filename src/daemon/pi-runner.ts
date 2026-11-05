import { spawn } from "node:child_process";
import type { NocturnEngine } from "../core/engine.ts";

export interface SotaPiRunnerOptions {
  /** SSH target for remote sota execution (never executes agent sessions on local Mac) */
  sshHost?: string;
  sshPort?: number;
  sshControlSocket?: string;
  dryRun?: boolean;
}

/**
 * Remote sota Pi CLI Adapter
 *
 * Launches or resumes (`--session <piSessionId>`) Pi 1.5.0 processes on the remote `sota` server
 * inside isolated Git worktrees, streaming step events back to NocturnEngine.
 */
export class SotaPiRunner {
  readonly engine: NocturnEngine;
  readonly options: Required<SotaPiRunnerOptions>;

  constructor(engine: NocturnEngine, options: SotaPiRunnerOptions = {}) {
    this.engine = engine;
    this.options = {
      sshHost: options.sshHost ?? "root@115.190.90.101",
      sshPort: options.sshPort ?? 10780,
      sshControlSocket:
        options.sshControlSocket ??
        "/Users/yangxin/Documents/ChatGPT/multica/.multica/sota-ssh.sock",
      dryRun: options.dryRun ?? false,
    };
  }

  /**
   * Build the exact SSH command that invokes `pi` on `sota` for a given Session & prompt.
   */
  buildSotaPiCommand(params: {
    worktreePath: string;
    piSessionId: string | null;
    prompt: string;
  }): { bin: string; args: string[] } {
    const resumeFlag = params.piSessionId ? `--session ${params.piSessionId}` : "";
    const escapedPrompt = params.prompt.replace(/'/g, `'\\''`);
    const remoteCmd = `mkdir -p ${params.worktreePath} && cd ${params.worktreePath} && /usr/local/bin/pi --mode json ${resumeFlag} -p '${escapedPrompt}'`;

    return {
      bin: "ssh",
      args: [
        "-p",
        String(this.options.sshPort),
        "-o",
        `ControlPath=${this.options.sshControlSocket}`,
        this.options.sshHost,
        remoteCmd,
      ],
    };
  }

  /**
   * Drain pending `launch_run` effects from SQLite and execute on sota (or simulate in dryRun/test mode).
   */
  async processPendingEffects(): Promise<number> {
    const effects = this.engine.store.listPendingEffects();
    let processed = 0;

    for (const eff of effects) {
      if (eff.kind === "launch_run") {
        const { sessionId, piSessionId } = eff.payload as {
          runId: string;
          sessionId: string;
          piSessionId: string | null;
          worktreePath: string;
        };
        // If no native Pi session ID exists yet, bind a deterministic sota session ID
        if (!piSessionId) {
          this.engine.bindNativePiSessionId(sessionId, `pi_sota_${sessionId}`);
        }
      }
      this.engine.store.markEffectDone(eff.id);
      processed++;
    }
    return processed;
  }

  /**
   * Execute a real one-shot Pi command on `sota` when live execution is requested.
   */
  runLiveOnSota(params: {
    worktreePath: string;
    piSessionId: string | null;
    prompt: string;
  }): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { bin, args } = this.buildSotaPiCommand(params);
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }
}
