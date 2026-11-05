import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { NocturnEngine } from "../core/engine.ts";
import { buildLeaderBriefing, buildWorkerBriefing } from "../core/briefing.ts";

export interface SotaPiRunnerOptions {
  /** SSH target for remote sota execution (never executes agent sessions on local Mac) */
  sshHost?: string;
  sshPort?: number;
  sshControlSocket?: string;
  dryRun?: boolean;
  /** When true, newly enqueued Runs automatically spawn Pi 1.5.0 on sota in the background */
  autoSpawnOnSota?: boolean;
}

/**
 * Remote sota Pi CLI Adapter (with Live JSON Event Streaming, Briefing Assembly, and Process Kill)
 */
export class SotaPiRunner {
  readonly engine: NocturnEngine;
  readonly options: Required<SotaPiRunnerOptions>;
  private activeProcesses = new Map<string, ChildProcess>();

  constructor(engine: NocturnEngine, options: SotaPiRunnerOptions = {}) {
    this.engine = engine;
    this.options = {
      sshHost: options.sshHost ?? "root@115.190.90.101",
      sshPort: options.sshPort ?? 10780,
      sshControlSocket:
        options.sshControlSocket ??
        "/Users/yangxin/Documents/ChatGPT/multica/.multica/sota-ssh.sock",
      dryRun: options.dryRun ?? false,
      autoSpawnOnSota: options.autoSpawnOnSota ?? false,
    };
  }

  /**
   * Build the exact SSH command that invokes `pi` on `sota` for a given Session & prompt.
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
   * Build the full role-aware briefing prompt (Leader vs Worker) for a Task & Agent.
   */
  buildBriefingForTaskAgent(taskId: string, agentId: string, wakeReason?: string): string {
    const store = this.engine.store;
    const task = store.getTask(taskId);
    const agent = store.getAgent(agentId);
    if (!task || !agent) return wakeReason ?? "请继续推进当前任务。";

    if (agent.role === "leader" || agent.role === "chief") {
      const squad = store.listSquads().find((s) => s.id === task.squadId) ?? store.listSquads()[0];
      const members = store.listAgents().filter((a) => a.squadId === squad.id);
      const childTasks = store.listTasks().filter((t) => t.parentTaskId === task.id);
      return buildLeaderBriefing({
        task,
        squad,
        leader: agent,
        members,
        childTasks,
        wakeReason,
      });
    }

    const unreadInputs = store
      .listInputsForAgentTask(agent.id, task.id)
      .filter((i) => i.receiptState !== "read");
    return buildWorkerBriefing({
      task,
      worker: agent,
      orderText: task.description || task.title,
      unreadInputs,
    });
  }

  /**
   * Drain pending `launch_run` and `wake_leader` effects from SQLite.
   */
  async processPendingEffects(): Promise<number> {
    const effects = this.engine.store.listPendingEffects();
    let processed = 0;

    for (const eff of effects) {
      if (eff.kind === "launch_run") {
        const { runId, sessionId, piSessionId, autoSpawn } = eff.payload as {
          runId: string;
          sessionId: string;
          piSessionId: string | null;
          worktreePath: string;
          autoSpawn?: boolean;
        };
        let resolvedPiSessionId = piSessionId;
        if (!resolvedPiSessionId) {
          resolvedPiSessionId = randomUUID();
          this.engine.bindNativePiSessionId(sessionId, resolvedPiSessionId);
        }
        this.engine.store.markEffectDone(eff.id);
        processed++;

        if (!this.options.dryRun && (this.options.autoSpawnOnSota || autoSpawn)) {
          void this.executeRunOnSota(runId);
        }
        continue;
      } else if (eff.kind === "wake_leader") {
        const { taskId, leaderAgentId, reason } = eff.payload as {
          taskId: string;
          leaderAgentId: string;
          reason: string;
        };
        const leaderSession = this.engine.ensureSession(leaderAgentId, taskId);
        // Record the wakeup pulse on Leader's Session
        if (!leaderSession.activeRunId) {
          const wakeRun = this.engine.startRun(leaderSession.id, true, reason);
          this.engine.appendRunStep(wakeRun.id, {
            badge: "Report",
            text: `[自动唤醒队长] ${reason}`,
          });
          // Leader records verification and completes pulse turn
          this.engine.store.atomic(() => {
            const r = this.engine.store.getRun(wakeRun.id);
            const s = this.engine.store.getSession(leaderSession.id);
            if (r && s) {
              r.status = "completed";
              r.endedAt = new Date().toISOString();
              s.activeRunId = null;
              this.engine.store.saveRun(r);
              this.engine.store.saveSession(s);
            }
          });
        }
      }
      this.engine.store.markEffectDone(eff.id);
      processed++;
    }
    return processed;
  }

  /**
   * Execute an active Run on `sota` using its assembled role-aware Briefing prompt.
   */
  async executeRunOnSota(runId: string): Promise<void> {
    const run = this.engine.store.getRun(runId);
    if (!run || run.status !== "running") return;
    const session = this.engine.store.getSession(run.sessionId);
    if (!session) return;
    if (!session.piSessionId) {
      this.engine.bindNativePiSessionId(session.id, randomUUID());
    }
    const refreshed = this.engine.store.getSession(session.id)!;
    const prompt = this.buildBriefingForTaskAgent(run.taskId, run.agentId, run.summary);

    try {
      await this.runLiveOnSota({
        runId: run.id,
        worktreePath: refreshed.worktreePath,
        piSessionId: refreshed.piSessionId!,
        prompt,
      });
    } catch (err) {
      this.engine.appendRunStep(run.id, {
        badge: "步骤",
        text: `[sota 执行异常] ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Terminate a running SSH / Pi process on `sota` when the user clicks "■ 停止".
   */
  killActiveRun(runId: string, reason = "用户点击 ■ 停止，已终止远端 sota Pi 进程"): boolean {
    const child = this.activeProcesses.get(runId);
    if (child) {
      child.kill("SIGTERM");
      this.activeProcesses.delete(runId);
    }
    const stopped = this.engine.stopRun(runId, reason);
    return Boolean(stopped);
  }

  /**
   * Execute a real streaming Pi 1.5.0 turn on `sota`, parsing JSON lines in real time
   * into `run.steps` and broadcasting every tool call / reply via `engine.notifyChange()`.
   */
  runLiveOnSota(params: {
    runId?: string;
    worktreePath: string;
    piSessionId: string;
    prompt: string;
  }): Promise<{ code: number | null; assistantText: string; rawLines: string[] }> {
    const { bin, args } = this.buildSotaPiCommand(params);
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      if (params.runId) {
        this.activeProcesses.set(params.runId, child);
      }

      let stdoutBuf = "";
      let stderr = "";
      const rawLines: string[] = [];
      let assistantText = "";

      const handleJsonLine = (line: string) => {
        rawLines.push(line);
        try {
          const ev = JSON.parse(line);
          if (ev.type === "tool_execution_start" && params.runId) {
            const toolName = ev.toolName ?? "tool";
            const argSummary = ev.args?.command
              ? String(ev.args.command)
              : ev.args?.path
              ? String(ev.args.path)
              : JSON.stringify(ev.args ?? {}).slice(0, 80);
            this.engine.appendRunStep(
              params.runId,
              {
                badge: "步骤",
                text: `[sota 工具调用 · ${toolName}] ${argSummary}`,
              },
              `正在执行 ${toolName}: ${argSummary}`
            );
          } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
            for (const part of ev.message.content ?? []) {
              if (part.type === "text") assistantText += part.text;
            }
            if (params.runId && assistantText.trim()) {
              this.engine.markDeliveredInputsReadForRun(params.runId);
              this.engine.appendRunStep(
                params.runId,
                {
                  badge: "步骤",
                  text: `[sota Pi 1.5.0 回复] ${assistantText.trim()}`,
                },
                `已完成回复：${assistantText.trim().slice(0, 50)}`
              );
            }
          }
        } catch {
          // ignore non-json lines
        }
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuf += String(chunk);
        const parts = stdoutBuf.split("\n");
        stdoutBuf = parts.pop() ?? "";
        for (const line of parts) {
          if (line.trim()) handleJsonLine(line.trim());
        }
      });

      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (err) => {
        if (params.runId) this.activeProcesses.delete(params.runId);
        reject(err);
      });
      child.on("close", (code) => {
        if (stdoutBuf.trim()) handleJsonLine(stdoutBuf.trim());
        if (params.runId) this.activeProcesses.delete(params.runId);
        if (code !== 0 && !assistantText) {
          assistantText = stderr.trim();
        }
        resolve({ code, assistantText: assistantText.trim(), rawLines });
      });
    });
  }
}
