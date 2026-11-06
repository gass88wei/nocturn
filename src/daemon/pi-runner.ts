import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { NocturnEngine } from "../core/engine.ts";
import { buildLeaderBriefing, buildWorkerBriefing } from "../core/briefing.ts";

export const SOTA_BASE_DIR =
  process.env.NOCTURN_BASE_DIR ??
  process.env.NOCTURN_SOTA_WORKDIR ??
  "/home/qijinyin/multimodal/yangxin/nocturn";
export const LEADER_MODEL =
  process.env.NOCTURN_LEADER_MODEL ?? "Deepseek-V4.1-Flash/gemini-4-argon-high";
export const WORKER_MODELS = [
  "Deepseek-V4.1-Flash/deepseek-v4.1-flash",
  "zgca/deepseek-flash",
] as const;

export interface SotaPiRunnerOptions {
  /** Execution mode: 'ssh' (remote sota box) or 'local' (local machine with `pi` CLI) */
  execMode?: "ssh" | "local";
  /** Base runtime directory containing worktrees/, sessions/, tmp/, bin/ */
  baseDir?: string;
  /** SSH target for remote sota execution */
  sshHost?: string;
  sshPort?: number;
  sshControlSocket?: string;
  dryRun?: boolean;
  /** When true, newly enqueued Runs automatically spawn Pi 1.5.0 in the background */
  autoSpawnOnSota?: boolean;
}

/**
 * Remote sota / Local Pi CLI Adapter (with Git Worktree Branch Isolation, Live JSON Event Streaming, and Process Kill)
 */
export class SotaPiRunner {
  readonly engine: NocturnEngine;
  readonly options: Required<SotaPiRunnerOptions>;
  private activeProcesses = new Map<string, ChildProcess>();
  private workerModelIndex = 0;

  /**
   * Resolve the model for an Agent:
   * - Leaders always use `Deepseek-V4.1-Flash/gemini-4-argon-high`
   * - Workers mix `Deepseek-V4.1-Flash/deepseek-v4.1-flash` and `zgca/deepseek-flash`
   */
  resolveAgentModel(agentId: string): string {
    const agent = this.engine.store.getAgent(agentId);
    if (!agent || agent.role === "leader" || agent.role === "chief") {
      return LEADER_MODEL;
    }
    if (
      agent.model &&
      (agent.model.includes("deepseek-v4.1-flash") || agent.model.includes("zgca/deepseek-flash"))
    ) {
      return agent.model;
    }
    const chosen = WORKER_MODELS[this.workerModelIndex % WORKER_MODELS.length];
    this.workerModelIndex++;
    return chosen;
  }

  constructor(engine: NocturnEngine, options: SotaPiRunnerOptions = {}) {
    this.engine = engine;
    const execMode =
      options.execMode ??
      ((process.env.NOCTURN_EXEC_MODE as "ssh" | "local" | undefined) ?? "ssh");
    const defaultSock = process.env.HOME
      ? `${process.env.HOME}/Documents/ChatGPT/multica/.multica/sota-ssh.sock`
      : "";
    this.options = {
      execMode,
      baseDir:
        options.baseDir ??
        process.env.NOCTURN_BASE_DIR ??
        process.env.NOCTURN_SOTA_WORKDIR ??
        (execMode === "local" ? process.cwd() : SOTA_BASE_DIR),
      sshHost: options.sshHost ?? process.env.NOCTURN_SOTA_HOST ?? "root@115.190.90.101",
      sshPort: options.sshPort ?? Number(process.env.NOCTURN_SOTA_PORT ?? 10780),
      sshControlSocket:
        options.sshControlSocket ?? process.env.NOCTURN_SOTA_SSH_SOCK ?? defaultSock,
      dryRun: options.dryRun ?? false,
      autoSpawnOnSota: options.autoSpawnOnSota ?? false,
    };
  }

  /**
   * Build shell execution command & args for either `local` mode or `ssh` mode.
   */
  buildShellExec(shellCmd: string): { bin: string; args: string[] } {
    if (this.options.execMode === "local") {
      return { bin: "sh", args: ["-c", shellCmd] };
    }
    const sshArgs: string[] = ["-p", String(this.options.sshPort)];
    if (this.options.sshControlSocket && existsSync(this.options.sshControlSocket)) {
      sshArgs.push("-o", `ControlPath=${this.options.sshControlSocket}`);
    }
    sshArgs.push(this.options.sshHost, shellCmd);
    return { bin: "ssh", args: sshArgs };
  }

  /**
   * Ensure the task's worktree directory is initialized as an isolated Git branch (`nocturn/<slug>`).
   */
  buildGitWorktreeInitCmd(worktreePath: string): string {
    return (
      `mkdir -p ${worktreePath} && ` +
      `if [ ! -e ${worktreePath}/.git ]; then ` +
      `b="nocturn/$(basename ${worktreePath})"; ` +
      `git -C ${worktreePath} init -b "$b" >/dev/null 2>&1 && ` +
      `git -C ${worktreePath} config user.name "nocturn-agent" && ` +
      `git -C ${worktreePath} config user.email "agent@nocturn.local" && ` +
      `git -C ${worktreePath} add -A >/dev/null 2>&1 && ` +
      `git -C ${worktreePath} commit --allow-empty -m "chore(worktree): init isolated branch $b" >/dev/null 2>&1 || true; ` +
      `fi`
    );
  }

  /**
   * Build the exact command that invokes `pi` (on `sota` via SSH or locally) for a given Session & prompt.
   */
  buildSotaPiCommand(params: {
    worktreePath: string;
    piSessionId: string;
    model?: string;
    prompt: string;
  }): { bin: string; args: string[]; model: string } {
    const model = params.model ?? LEADER_MODEL;
    const escapedPrompt = params.prompt.replace(/'/g, `'\\''`);
    const baseDir = this.options.baseDir;
    const piBin = this.options.execMode === "local" ? "pi" : `${baseDir}/bin/pi`;
    const envExport =
      this.options.execMode === "local"
        ? `export PATH=${baseDir}/bin:$PATH`
        : `export HOME=${baseDir} PI_CODING_AGENT_DIR=${baseDir}/.pi/agent TMPDIR=${baseDir}/tmp PATH=${baseDir}/bin:$PATH`;
    const gitInit = this.buildGitWorktreeInitCmd(params.worktreePath);
    const fullCmd = `${envExport} && mkdir -p ${baseDir}/sessions ${baseDir}/tmp && ${gitInit} && cd ${params.worktreePath} && ${piBin} --mode json --session-dir ${baseDir}/sessions --model ${model} --session-id ${params.piSessionId} -p '${escapedPrompt}'`;

    const execSpec = this.buildShellExec(fullCmd);
    return {
      bin: execSpec.bin,
      args: execSpec.args,
      model,
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
        const { taskId, leaderAgentId, reason, autoSpawnLeader } = eff.payload as {
          taskId: string;
          leaderAgentId: string;
          reason: string;
          autoSpawnLeader?: boolean;
        };
        const leaderSession = this.engine.ensureSession(leaderAgentId, taskId);
        if (!leaderSession.activeRunId) {
          const wakeRun = this.engine.startRun(leaderSession.id, true, reason);
          this.engine.appendRunStep(wakeRun.id, {
            badge: "Report",
            text: `[自动唤醒队长] ${reason}`,
          });

          if (!this.options.dryRun && this.options.autoSpawnOnSota && autoSpawnLeader) {
            this.engine.store.markEffectDone(eff.id);
            processed++;
            // Process the launch_run effect created by startRun and spawn Leader on sota
            for (const subEff of this.engine.store.listPendingEffects()) {
              if (subEff.kind === "launch_run" && subEff.payload.runId === wakeRun.id) {
                if (!leaderSession.piSessionId) {
                  this.engine.bindNativePiSessionId(leaderSession.id, randomUUID());
                }
                this.engine.store.markEffectDone(subEff.id);
              }
            }
            void this.executeRunOnSota(wakeRun.id);
            continue;
          }

          // Otherwise settle Leader verification pulse turn immediately
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
    const model = this.resolveAgentModel(run.agentId);
    const prompt = this.buildBriefingForTaskAgent(run.taskId, run.agentId, run.summary);
    this.engine.appendRunStep(run.id, {
      badge: "步骤",
      text: `[模型路由] ${run.agentId} 使用模型 ${model}`,
    });

    try {
      await this.runLiveOnSota({
        runId: run.id,
        worktreePath: refreshed.worktreePath,
        piSessionId: refreshed.piSessionId!,
        model,
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
    model?: string;
    prompt: string;
  }): Promise<{ code: number | null; assistantText: string; model: string; rawLines: string[] }> {
    const { bin, args, model } = this.buildSotaPiCommand(params);
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
            let stepText = "";
            for (const part of ev.message.content ?? []) {
              if (part.type === "text") stepText += part.text;
            }
            if (stepText.trim()) {
              assistantText = stepText.trim();
              if (params.runId) {
                this.engine.markDeliveredInputsReadForRun(params.runId);
                this.engine.appendRunStep(
                  params.runId,
                  {
                    badge: "步骤",
                    text: `[sota Pi 1.5.0 回复] ${assistantText}`,
                  },
                  `已完成回复：${assistantText.slice(0, 50)}`
                );
              }
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
        resolve({ code, assistantText: assistantText.trim(), model, rawLines });
      });
    });
  }
}
