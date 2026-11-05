import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
 * Launches or resumes (`--session-id <uuid>`) Pi 1.5.0 processes on the remote `sota` server
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
   * Uses `pi --mode json --session-id <uuid> -p '<prompt>'` so Run 1 creates the session
   * and Run 2..N automatically resume the exact same native Pi session in that worktree.
   */
  buildSotaPiCommand(params: {
    worktreePath: string;
    piSessionId: string;
    prompt: string;
  }): { bin: string; args: string[] } {
    const escapedPrompt = params.prompt.replace(/'/g, `'\\''`);
    const remoteCmd = `mkdir -p ${params.worktreePath} && cd ${params.worktreePath} && /usr/local/bin/pi --mode json --session-id ${params.piSessionId} -p '${escapedPrompt}'`;

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
   * Drain pending `launch_run` effects from SQLite and bind deterministic UUIDs for `--session-id`.
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
        if (!piSessionId) {
          this.engine.bindNativePiSessionId(sessionId, randomUUID());
        }
      }
      this.engine.store.markEffectDone(eff.id);
      processed++;
    }
    return processed;
  }

  /**
   * Execute a real one-shot Pi command on `sota` and extract the assistant's final reply text.
   */
  runLiveOnSota(params: {
    worktreePath: string;
    piSessionId: string;
    prompt: string;
  }): Promise<{ code: number | null; assistantText: string; rawLines: string[] }> {
    const { bin, args } = this.buildSotaPiCommand(params);
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        const rawLines = stdout.trim().split("\n").filter(Boolean);
        let assistantText = "";
        for (const line of rawLines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === "message_end" && ev.message?.role === "assistant") {
              for (const part of ev.message.content ?? []) {
                if (part.type === "text") assistantText += part.text;
              }
            }
          } catch {
            // ignore non-json lines
          }
        }
        if (code !== 0 && !assistantText) {
          assistantText = stderr.trim();
        }
        resolve({ code, assistantText: assistantText.trim(), rawLines });
      });
    });
  }
}
