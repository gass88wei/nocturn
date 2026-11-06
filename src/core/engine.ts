import type {
  Agent,
  AgentRun,
  AgentSession,
  AttentionRequest,
  ExternalTrigger,
  InputDeliveryMode,
  RiskLevel,
  RunTraceStep,
  Task,
  TaskInput,
  VerdictState,
} from "./model.ts";
import { NocturnStore } from "../store/sqlite.ts";

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Nocturn Core Orchestration Engine
 *
 * Pure deterministic state machine backed by single-file SQLite + Effects queue.
 */
export class NocturnEngine {
  readonly store: NocturnStore;
  private listeners: Array<() => void> = [];

  constructor(store: NocturnStore) {
    this.store = store;
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  notifyChange(): void {
    this.store.afterCommit(() => {
      for (const l of this.listeners) {
        try {
          l();
        } catch {
          // ignore listener error
        }
      }
    });
  }

  /**
   * Create or update a persistent Agent in the registry (and attach to Squad if needed).
   */
  upsertAgent(agent: Agent): Agent {
    return this.store.atomic(() => {
      this.store.saveAgent(agent);
      if (agent.squadId) {
        const squad = this.store.listSquads().find((s) => s.id === agent.squadId);
        if (squad && !squad.memberIds.includes(agent.id)) {
          squad.memberIds.push(agent.id);
          this.store.saveSquad(squad);
        }
      }
      this.notifyChange();
      return agent;
    });
  }

  /**
   * 1. Create a Task and assign it to a Squad (routes to Squad Leader's pulse session)
   */
  createTask(params: {
    identifier: string;
    title: string;
    description?: string;
    squadId: string;
    parentTaskId?: string | null;
  }): Task {
    return this.store.atomic(() => {
      const squad = this.store.listSquads().find((s) => s.id === params.squadId);
      if (!squad) throw new Error(`Squad not found: ${params.squadId}`);

      const now = new Date().toISOString();
      const task: Task = {
        id: uid("task"),
        identifier: params.identifier,
        title: params.title,
        description: params.description ?? "",
        squadId: squad.id,
        status: "dispatching",
        leaderAgentId: squad.leaderId,
        assignedWorkerId: null,
        parentTaskId: params.parentTaskId ?? null,
        subscribedThreads: [`github:issue:${params.identifier}`],
        latestVerdict: null,
        pendingAttention: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.saveTask(task);

      // Ensure Leader has a Session for this Task and schedule a pulse dispatch Run
      const leaderSession = this.ensureSession(squad.leaderId, task.id);
      this.startRun(leaderSession.id, true, `评估并派发任务 ${task.identifier}`);
      this.notifyChange();
      return task;
    });
  }

  /**
   * Fan-out parallel child tasks under a parent Task and immediately exit the Leader's pulse Run.
   * When all child tasks report Verdict=ready, the Join Gate automatically wakes the Leader on the parent Task.
   */
  fanoutSubtasks(params: {
    parentTaskId: string;
    subtasks: Array<{ identifier: string; title: string; workerAgentId: string; orderText: string }>;
  }): Task[] {
    return this.store.atomic(() => {
      const parent = this.store.getTask(params.parentTaskId);
      if (!parent) throw new Error(`Parent task not found: ${params.parentTaskId}`);

      const now = new Date().toISOString();
      parent.status = "in_progress";
      parent.updatedAt = now;
      this.store.saveTask(parent);

      // End Leader's active pulse Run on the parent task immediately ("Stop after fan-out")
      const leaderSession = this.store.getSessionByPair(parent.leaderAgentId, parent.id);
      if (leaderSession?.activeRunId) {
        const leaderRun = this.store.getRun(leaderSession.activeRunId);
        if (leaderRun && leaderRun.status === "running") {
          leaderRun.steps.push({
            badge: "步骤",
            text: `[Fan-out 并行拆单] 已拆分为 ${params.subtasks.length} 个并行子任务，挂接 Join Gate 等待全部完成自动唤醒`,
            timestamp: now,
          });
          leaderRun.status = "completed";
          leaderRun.endedAt = now;
          leaderSession.activeRunId = null;
          this.store.saveRun(leaderRun);
          this.store.saveSession(leaderSession);
        }
      }

      const createdChildren: Task[] = [];
      for (const item of params.subtasks) {
        this.ensureDynamicWorkerInSquad(parent.squadId, item.workerAgentId, item.orderText);
        const child: Task = {
          id: uid("task"),
          identifier: item.identifier,
          title: item.title,
          description: item.orderText,
          squadId: parent.squadId,
          status: "in_progress",
          leaderAgentId: parent.leaderAgentId,
          assignedWorkerId: item.workerAgentId,
          parentTaskId: parent.id,
          subscribedThreads: [`github:issue:${item.identifier}`],
          latestVerdict: null,
          pendingAttention: null,
          createdAt: now,
          updatedAt: now,
        };
        this.store.saveTask(child);
        const workerSession = this.ensureSession(item.workerAgentId, child.id);
        this.startRun(workerSession.id, false, `执行并行子任务：${item.orderText}`);
        createdChildren.push(child);
      }

      this.notifyChange();
      return createdChildren;
    });
  }

  /**
   * SuperAgent-style Dynamic Specialist / Squad Recruitment:
   * Unlike Multica (which requires manual human pre-configuration of all Agents & Squads),
   * Nocturn allows the Leader (or `dispatch`/`fanout`/`recruit`) to dynamically materialize
   * a new specialist Agent or even a new Squad on the fly when a task demands it.
   */
  recruitSpecialistOrSquad(params: {
    agentId: string;
    name?: string;
    squadId?: string;
    squadName?: string;
    role?: Agent["role"];
    model?: string;
    skills?: string[];
    instructions?: string;
  }): { agent: Agent; squad: Squad } {
    return this.store.atomic(() => {
      const squadId = params.squadId ?? "dev";
      let squad = this.store.listSquads().find((s) => s.id === squadId);
      const role = params.role ?? "worker";
      const model =
        params.model ??
        (role === "leader"
          ? "Deepseek-V4.1-Flash/gemini-4-argon-high"
          : "Deepseek-V4.1-Flash/deepseek-v4.1-flash");

      const agent: Agent = {
        id: params.agentId,
        name: params.name ?? params.agentId,
        squadId,
        role,
        cli: "pi",
        model,
        skills: params.skills?.length ? params.skills : ["specialist", "coding"],
        instructions:
          params.instructions ??
          `由队长按任务需求动态招募的专职组员 (${params.name ?? params.agentId})`,
      };
      this.store.saveAgent(agent);

      if (!squad) {
        squad = {
          id: squadId,
          name: params.squadName ?? `${squadId} 特种小队`,
          leaderId: role === "leader" ? agent.id : "dev-leader",
          memberIds: [role === "leader" ? agent.id : "dev-leader", agent.id],
        };
      } else if (!squad.memberIds.includes(agent.id)) {
        squad.memberIds.push(agent.id);
      }
      this.store.saveSquad(squad);
      this.notifyChange();
      return { agent, squad };
    });
  }

  /**
   * Automatically materialize a Worker Agent into the Squad if the Leader dispatches to a specialist ID not yet in DB.
   */
  private ensureDynamicWorkerInSquad(squadId: string, workerAgentId: string, orderHint?: string): Agent {
    const existing = this.store.getAgent(workerAgentId);
    if (existing) return existing;
    return this.recruitSpecialistOrSquad({
      agentId: workerAgentId,
      name: workerAgentId,
      squadId,
      role: "worker",
      instructions: orderHint
        ? `由队长动态招募的专职组员，核心目标：${orderHint.slice(0, 120)}`
        : "由队长按需动态招募的专职组员",
    }).agent;
  }

  /**
   * Ensure a persistent (agentId, taskId) Session exists with an isolated sota worktree path.
   */
  ensureSession(agentId: string, taskId: string): AgentSession {
    const existing = this.store.getSessionByPair(agentId, taskId);
    if (existing) return existing;

    const task = this.store.getTask(taskId);
    const slug = (task?.identifier ?? taskId).toLowerCase();
    const baseWorkDir =
      process.env.NOCTURN_BASE_DIR ??
      process.env.NOCTURN_SOTA_WORKDIR ??
      "/home/qijinyin/multimodal/yangxin/nocturn";
    const session: AgentSession = {
      id: uid("sess"),
      agentId,
      taskId,
      piSessionId: null,
      worktreePath: `${baseWorkDir}/worktrees/${slug}`,
      activeRunId: null,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveSession(session);
    return session;
  }

  /**
   * Start a new Run on a Session. Enforces single-active-Run mutex per Session.
   */
  startRun(sessionId: string, isLeaderTurn: boolean, summary: string): AgentRun {
    return this.store.atomic(() => {
      const session = this.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      if (session.activeRunId) {
        const activeRun = this.store.getRun(session.activeRunId);
        if (activeRun && activeRun.status === "running") {
          throw new Error(
            `Session ${session.id} already has an active Run (${activeRun.id}); concurrent runs on the same session are forbidden`
          );
        }
      }

      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const leaseExpiresAt = new Date(nowMs + 5 * 60 * 1000).toISOString();
      const run: AgentRun = {
        id: uid("run"),
        sessionId: session.id,
        taskId: session.taskId,
        agentId: session.agentId,
        isLeaderTurn,
        status: "running",
        leaseToken: uid("lease"),
        leaseExpiresAt,
        summary,
        steps: [
          {
            badge: "步骤",
            text: session.piSessionId
              ? `[恢复会话] --session-id ${session.piSessionId} (${session.worktreePath})`
              : `[新建会话] 初始化工作区 ${session.worktreePath}`,
            timestamp: now,
          },
        ],
        verdict: null,
        startedAt: now,
        endedAt: null,
      };
      session.activeRunId = run.id;
      session.updatedAt = now;
      this.store.saveRun(run);
      this.store.saveSession(session);

      this.store.enqueueEffect("launch_run", `launch:${run.id}`, {
        runId: run.id,
        sessionId: session.id,
        piSessionId: session.piSessionId,
        worktreePath: session.worktreePath,
      });

      return run;
    });
  }

  /**
   * Bind the native Pi CLI session ID reported by sota Daemon back onto the persistent Session.
   */
  bindNativePiSessionId(sessionId: string, piSessionId: string): AgentSession {
    return this.store.atomic(() => {
      const session = this.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      session.piSessionId = piSessionId;
      session.updatedAt = new Date().toISOString();
      this.store.saveSession(session);
      return session;
    });
  }

  /**
   * 2. Leader dispatches a Task to a Worker and immediately finishes its own pulse Run
   *    ("Stop after dispatching" — Leader never blocks waiting for Worker).
   */
  dispatchTask(params: {
    taskId: string;
    workerAgentId: string;
    orderText: string;
    workerInstructions?: string;
  }): { task: Task; workerRun: AgentRun } {
    return this.store.atomic(() => {
      const task = this.store.getTask(params.taskId);
      if (!task) throw new Error(`Task not found: ${params.taskId}`);

      // If the Leader dispatches to a brand-new specialist ID, dynamically recruit it on the fly!
      this.ensureDynamicWorkerInSquad(
        task.squadId,
        params.workerAgentId,
        params.workerInstructions ?? params.orderText
      );

      const now = new Date().toISOString();
      task.assignedWorkerId = params.workerAgentId;
      task.status = "in_progress";
      task.updatedAt = now;
      this.store.saveTask(task);

      // End Leader's active pulse Run immediately ("Stop after dispatching")
      const leaderSession = this.store.getSessionByPair(task.leaderAgentId, task.id);
      if (leaderSession?.activeRunId) {
        const leaderRun = this.store.getRun(leaderSession.activeRunId);
        if (leaderRun && leaderRun.status === "running") {
          leaderRun.steps.push({
            badge: "步骤",
            text: `[派单完成] 已委派给 @${params.workerAgentId}：「${params.orderText}」，立即结束派单回合`,
            timestamp: now,
          });
          leaderRun.status = "completed";
          leaderRun.endedAt = now;
          leaderSession.activeRunId = null;
          this.store.saveRun(leaderRun);
          this.store.saveSession(leaderSession);
        }
      }

      // Create/resume Worker's Session and start Worker Run
      const workerSession = this.ensureSession(params.workerAgentId, task.id);
      const workerRun = this.startRun(
        workerSession.id,
        false,
        `执行队长委派：${params.orderText}`
      );
      this.notifyChange();
      return { task, workerRun };
    });
  }

  /**
   * Append a live streaming trace step to an active Run (used by SotaPiRunner JSON stream).
   */
  appendRunStep(runId: string, step: Omit<RunTraceStep, "timestamp">, newSummary?: string): void {
    this.store.atomic(() => {
      const run = this.store.getRun(runId);
      if (!run) return;
      run.steps.push({ ...step, timestamp: new Date().toISOString() });
      if (newSummary) run.summary = newSummary;
      this.store.saveRun(run);
      this.notifyChange();
    });
  }

  /**
   * Explicitly stop an active Run (when user clicks "■ 停止").
   */
  stopRun(runId: string, reason = "用户手动点击停止"): AgentRun | undefined {
    return this.store.atomic(() => {
      const run = this.store.getRun(runId);
      if (!run) return undefined;
      const now = new Date().toISOString();
      run.status = "interrupted";
      run.endedAt = now;
      run.steps.push({
        badge: "步骤",
        text: `[已停止] ${reason}`,
        timestamp: now,
      });
      this.store.saveRun(run);

      const session = this.store.getSession(run.sessionId);
      if (session && session.activeRunId === run.id) {
        session.activeRunId = null;
        session.updatedAt = now;
        this.store.saveSession(session);
      }
      this.notifyChange();
      return run;
    });
  }

  /**
   * 3. Worker calls `nocturn report` (combines Tencent's structured Verdict + SuperAgent's human_action & PR auto-subscription)
   */
  reportVerdict(params: {
    taskId: string;
    agentId: string;
    state: VerdictState;
    summary: string;
    risk?: RiskLevel;
    humanAction?: string | null;
    humanActionOptions?: string[];
    prNumber?: number | null;
    confidence?: number;
    leaseToken?: string;
  }): Task {
    return this.store.atomic(() => {
      const task = this.store.getTask(params.taskId);
      if (!task) throw new Error(`Task not found: ${params.taskId}`);

      const session = this.store.getSessionByPair(params.agentId, task.id);
      if (params.leaseToken && session?.activeRunId) {
        const activeRun = this.store.getRun(session.activeRunId);
        if (activeRun && activeRun.leaseToken !== params.leaseToken) {
          throw new Error(
            `Fenced stale executor: leaseToken ${params.leaseToken} does not match active Run lease ${activeRun.leaseToken}`
          );
        }
      }

      const now = new Date().toISOString();
      const risk: RiskLevel = params.risk ?? "low";
      const verdict = {
        state: params.state,
        summary: params.summary,
        risk,
        humanAction: params.humanAction ?? null,
        prNumber: params.prNumber ?? null,
        confidence: params.confidence,
        reportedAt: now,
      };
      task.latestVerdict = verdict;

      // Auto-bind PR thread subscription when PR number is reported (SuperAgent bindThread)
      if (params.prNumber != null) {
        const prThread = `github:pr:${params.prNumber}`;
        if (!task.subscribedThreads.includes(prThread)) {
          task.subscribedThreads.push(prThread);
        }
      }

      // Manage structured Attention (human_action can coexist with state='progress'!)
      if (params.humanAction !== undefined) {
        if (params.humanAction === null) {
          task.pendingAttention = null;
        } else {
          task.pendingAttention = {
            id: uid("att"),
            taskId: task.id,
            agentId: params.agentId,
            question: params.humanAction,
            options: params.humanActionOptions,
            createdAt: now,
          };
        }
      }

      // Record on active Run and settle turn if terminal state (ready / blocked / failed / dropped)
      if (session?.activeRunId) {
        const run = this.store.getRun(session.activeRunId);
        if (run) {
          run.verdict = verdict;
          run.steps.push({
            badge: "Report",
            text: `[结构化上报] state=${params.state} · ${params.summary}${
              params.humanAction ? ` · 提问: "${params.humanAction}"` : ""
            }`,
            timestamp: now,
          });
          // Any delivered inputs in this Run are now officially read by the model!
          this.markDeliveredInputsReadForRun(run.id);

          if (params.state !== "progress") {
            run.status = params.state === "failed" ? "failed" : "completed";
            run.endedAt = now;
            session.activeRunId = null;
            this.store.saveSession(session);
          }
          this.store.saveRun(run);
        }
      }

      // Advance Task status & trigger Squad Leader Join Gate / Reviewer handoff / Autonomous Rework / Auto-Done
      if (params.state === "rework") {
        // Reviewer found defects -> automatically route back to pi-coder's original Session without bothering human!
        task.status = "in_progress";
        task.assignedWorkerId = "pi-coder";
        task.updatedAt = now;
        this.store.saveTask(task);
        this.sendInput({
          taskId: task.id,
          targetAgentId: "pi-coder",
          author: params.agentId,
          mode: "rework",
          text: `[审查自动打回 Rework] ${params.agentId} 发现问题要求返工：${params.summary}`,
        });
        this.notifyChange();
        return task;
      }

      if (params.state === "ready") {
        const hasReviewerInSquad = this.store
          .listAgents()
          .some((a) => a.squadId === task.squadId && a.id === "codex-reviewer");
        const isCoderSubmission =
          hasReviewerInSquad &&
          params.agentId === "pi-coder" &&
          !task.parentTaskId;

        if (isCoderSubmission) {
          // Coder finished implementation -> wake Squad Leader to hand off to codex-reviewer!
          task.status = "dispatching";
          this.store.enqueueEffect("wake_leader", `wake:${task.id}:coder_ready:${now}`, {
            taskId: task.id,
            leaderAgentId: task.leaderAgentId,
            autoSpawnLeader: true,
            reason: `编码组员 ${params.agentId} 已完成代码编写并上报 Verdict=ready（${params.summary}）。请立即调用 nocturn dispatch --task ${task.identifier} --to codex-reviewer --order "请审查 ${task.identifier} 工作区下的代码与测试：若验证通过且无高风险变更，调用 nocturn report --task ${task.identifier} --agent codex-reviewer --state ready --risk low --summary '<审查结论>' 直接自动结单；若发现缺陷需要修改，调用 nocturn report --task ${task.identifier} --agent codex-reviewer --state rework --summary '<具体修改意见>' 自动打回给 pi-coder 返工；若涉及高风险架构/安全变更需人类确认，传 --risk high" 将任务转交给审查员 codex-reviewer！`,
          });
        } else {
          // Final Reviewer or standalone worker finished:
          // Risk-Stratified Auto-Merge/Close: low-risk & no pending human question -> auto-close (`done`)!
          // High-risk -> pause at `in_review` for human approval.
          const needsHumanReview = risk === "high" || Boolean(task.pendingAttention);
          task.status = needsHumanReview ? "in_review" : "done";
          this.store.enqueueEffect("wake_leader", `wake:${task.id}:ready:${now}`, {
            taskId: task.id,
            leaderAgentId: task.leaderAgentId,
            autoSpawnLeader: false,
            reason: needsHumanReview
              ? `[高风险待人类验收] ${params.agentId} 提交 Verdict=ready (risk=high): ${params.summary}`
              : `[自动验收结单 Auto-Done] ${params.agentId} 独立审查通过 (risk=low)，系统已自动将任务标为已完成 (done)！摘要: ${params.summary}`,
          });
        }

        // If this Task is a child subtask (`parentTaskId`), check the AND Join Gate across all siblings!
        if (task.parentTaskId) {
          const siblings = this.store
            .listTasks()
            .filter((t) => t.parentTaskId === task.parentTaskId);
          const allReady = siblings.every((s) => {
            const st = s.id === task.id ? task.status : s.status;
            return st === "in_review" || st === "done";
          });
          if (allReady) {
            const parentTask = this.store.getTask(task.parentTaskId);
            if (parentTask) {
              parentTask.status = "in_review";
              parentTask.updatedAt = now;
              this.store.saveTask(parentTask);
              this.store.enqueueEffect(
                "wake_leader",
                `wake:join:${parentTask.id}:${now}`,
                {
                  taskId: parentTask.id,
                  leaderAgentId: parentTask.leaderAgentId,
                  reason: `[Join Gate 汇聚完成] 父任务 ${parentTask.identifier} 下属的全部 ${siblings.length} 个并行子任务均已上报 Verdict=ready，自动唤醒队长汇总验收！`,
                }
              );
            }
          }
        }
      } else if (params.state === "blocked") {
        task.status = "blocked";
        this.store.enqueueEffect("wake_leader", `wake:${task.id}:blocked:${now}`, {
          taskId: task.id,
          leaderAgentId: task.leaderAgentId,
          reason: `组员 ${params.agentId} 提交结构化 Verdict=blocked: ${params.summary}`,
        });
      }

      task.updatedAt = now;
      this.store.saveTask(task);
      this.notifyChange();
      return task;
    });
  }

  /**
   * 4. Two-phase Input delivery (`waiting` -> `delivered` -> `read`) & crash-safe replay
   */
  sendInput(params: {
    taskId: string;
    targetAgentId: string;
    author: string;
    mode: InputDeliveryMode;
    text: string;
    triggerId?: string;
  }): TaskInput {
    return this.store.atomic(() => {
      const task = this.store.getTask(params.taskId);
      if (!task) throw new Error(`Task not found: ${params.taskId}`);

      const now = new Date().toISOString();
      const session = this.ensureSession(params.targetAgentId, task.id);

      // If human answers a pending Attention question, clear it automatically
      if (task.pendingAttention && task.pendingAttention.agentId === params.targetAgentId) {
        task.pendingAttention = null;
        this.store.saveTask(task);
      }

      const input: TaskInput = {
        id: uid("inp"),
        taskId: task.id,
        targetAgentId: params.targetAgentId,
        author: params.author,
        mode: params.mode,
        text: params.text,
        triggerId: params.triggerId,
        receiptState: "waiting",
        createdAt: now,
        deliveredRunId: null,
        readAt: null,
      };

      // If mode === 'restart' and there is a running Run, interrupt it and restart fresh
      if (params.mode === "restart" && session.activeRunId) {
        this.interruptAndRecoverSession(session.id, `因收到 Restart 指令重启回合: ${params.text}`);
      }

      const refreshedSession = this.store.getSession(session.id)!;
      if (refreshedSession.activeRunId && (params.mode === "steer" || params.mode === "note")) {
        // Active Run exists: deliver immediately into running process (state = 'delivered', NOT 'read' yet!)
        input.receiptState = "delivered";
        input.deliveredRunId = refreshedSession.activeRunId;
        const activeRun = this.store.getRun(refreshedSession.activeRunId)!;
        activeRun.steps.push({
          badge: params.mode === "note" ? "Note" : "Input",
          text: `${params.author} (${params.mode}): 「${params.text}」`,
          receiptState: "delivered",
          timestamp: now,
        });
        this.store.saveRun(activeRun);
      } else if (!refreshedSession.activeRunId && params.mode !== "after_run") {
        // Session is idle (previous Run exited): automatically resume the original Session!
        const resumedRun = this.startRun(
          refreshedSession.id,
          false,
          `收到新消息唤醒原会话：${params.text}`
        );
        input.receiptState = "delivered";
        input.deliveredRunId = resumedRun.id;
        resumedRun.steps.push({
          badge: "Input",
          text: `${params.author}: 「${params.text}」`,
          receiptState: "delivered",
          timestamp: now,
        });
        this.store.saveRun(resumedRun);
      }

      this.store.saveInput(input);
      this.notifyChange();
      return input;
    });
  }

  /**
   * Mark all `delivered` Inputs for a Run as `read` once the model finishes its step/turn.
   */
  markDeliveredInputsReadForRun(runId: string): number {
    return this.store.atomic(() => {
      const run = this.store.getRun(runId);
      if (!run) return 0;
      const now = new Date().toISOString();
      const inputs = this.store.listInputsForAgentTask(run.agentId, run.taskId);
      let count = 0;
      for (const inp of inputs) {
        if (inp.receiptState === "delivered" && inp.deliveredRunId === runId) {
          inp.receiptState = "read";
          inp.readAt = now;
          this.store.saveInput(inp);
          count++;
        }
      }
      for (const st of run.steps) {
        if (st.receiptState === "delivered") {
          st.receiptState = "read";
        }
      }
      this.store.saveRun(run);
      return count;
    });
  }

  /**
   * Crash/Restart recovery (SuperAgent `assignmentInterrupted` semantics):
   * Any Input that was `delivered` to the interrupted Run but never `read` (because the process crashed
   * before completing its turn) is automatically replayed into the new recovery Run!
   */
  interruptAndRecoverSession(sessionId: string, reason: string): AgentRun {
    return this.store.atomic(() => {
      const session = this.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      const oldRunId = session.activeRunId;
      if (oldRunId) {
        const oldRun = this.store.getRun(oldRunId);
        if (oldRun) {
          oldRun.status = "interrupted";
          oldRun.endedAt = new Date().toISOString();
          this.store.saveRun(oldRun);
        }
        session.activeRunId = null;
        this.store.saveSession(session);
      }

      const recoveryRun = this.startRun(session.id, false, `崩溃/中断恢复: ${reason}`);
      const inputs = this.store.listInputsForAgentTask(session.agentId, session.taskId);
      for (const inp of inputs) {
        if (inp.receiptState === "delivered" && inp.deliveredRunId === oldRunId) {
          // Re-bind unread input to the new recovery Run so it is never lost!
          inp.deliveredRunId = recoveryRun.id;
          this.store.saveInput(inp);
          recoveryRun.steps.push({
            badge: "Input",
            text: `[未读插话自动重放] ${inp.author}: 「${inp.text}」`,
            receiptState: "delivered",
            timestamp: new Date().toISOString(),
          });
        }
      }
      this.store.saveRun(recoveryRun);
      return recoveryRun;
    });
  }

  /**
   * Sweeper self-healing: reclaim any running Run whose heartbeat lease has expired,
   * rotating the leaseToken so a zombie process cannot overwrite state later.
   */
  sweepStaleRuns(nowIso = new Date().toISOString()): AgentRun[] {
    return this.store.atomic(() => {
      const reclaimed: AgentRun[] = [];
      for (const run of this.store.listAllRuns()) {
        if (run.status === "running" && run.leaseExpiresAt < nowIso) {
          const recoveryRun = this.interruptAndRecoverSession(
            run.sessionId,
            `Sweeper 检测到心跳租约超时 (${run.leaseExpiresAt})，自动接管并恢复会话`
          );
          reclaimed.push(recoveryRun);
        }
      }
      return reclaimed;
    });
  }

  /**
   * 5. Subscription green-channel fan-out & `handback` out-of-scope triggers (with idempotency dedup)
   */
  receiveExternalTrigger(params: {
    eventKey?: string;
    threadKey: string;
    actor: string;
    text: string;
  }): { trigger: ExternalTrigger; duplicate: boolean; routedToTaskIds: string[] } {
    return this.store.atomic(() => {
      const eventKey =
        params.eventKey ?? `${params.threadKey}:${params.actor}:${params.text}`;
      const existing = this.store.getTriggerByEventKey(eventKey);
      if (existing) {
        return { trigger: existing, duplicate: true, routedToTaskIds: [] };
      }

      const trigger: ExternalTrigger = {
        id: uid("trig"),
        eventKey,
        threadKey: params.threadKey,
        actor: params.actor,
        text: params.text,
        createdAt: new Date().toISOString(),
      };
      this.store.saveTrigger(trigger);

      const matchedTasks = this.store
        .listTasks()
        .filter((t) => t.subscribedThreads.includes(params.threadKey));

      const routedToTaskIds: string[] = [];
      for (const t of matchedTasks) {
        if (t.status === "done" || t.status === "in_review") {
          t.status = "in_progress";
          t.updatedAt = new Date().toISOString();
          this.store.saveTask(t);
        }
        const targetAgent = t.assignedWorkerId ?? t.leaderAgentId;
        this.sendInput({
          taskId: t.id,
          targetAgentId: targetAgent,
          author: params.actor,
          mode: "event",
          text: params.text,
          triggerId: trigger.id,
        });
        routedToTaskIds.push(t.id);
      }

      return { trigger, duplicate: false, routedToTaskIds };
    });
  }

  /**
   * Worker calls `nocturn handback` when a message on a subscribed thread asks for work outside its Task scope.
   * Automatically routes back to the Squad Leader to spawn a new Task!
   */
  handbackTrigger(params: {
    taskId: string;
    triggerId: string;
    reason: string;
    newIdentifier: string;
  }): Task {
    return this.store.atomic(() => {
      const originTask = this.store.getTask(params.taskId);
      if (!originTask) throw new Error(`Task not found: ${params.taskId}`);
      const trigger = this.store.getTrigger(params.triggerId);
      if (!trigger) throw new Error(`Trigger not found: ${params.triggerId}`);

      trigger.handedBackByTaskId = originTask.id;
      trigger.handbackReason = params.reason;
      this.store.saveTrigger(trigger);

      // Spawn a new Task owned by the Squad Leader for the handed-back trigger
      return this.createTask({
        identifier: params.newIdentifier,
        title: trigger.text,
        description: `由任务 ${originTask.identifier} 退回 (Handback: ${params.reason})`,
        squadId: originTask.squadId,
      });
    });
  }

  /**
   * 6. Targeted Rework: Reject an `in_review` Task and resume the original Worker's Session with full Rework Context.
   */
  reworkTask(params: { taskId: string; reviewer: string; reason: string }): Task {
    return this.store.atomic(() => {
      const task = this.store.getTask(params.taskId);
      if (!task) throw new Error(`Task not found: ${params.taskId}`);
      const workerId = task.assignedWorkerId ?? task.leaderAgentId;

      const prevSummary = task.latestVerdict?.summary ?? "无上次摘要";
      const prevPr = task.latestVerdict?.prNumber ? `PR #${task.latestVerdict.prNumber}` : "";
      task.status = "in_progress";
      task.updatedAt = new Date().toISOString();
      this.store.saveTask(task);

      this.sendInput({
        taskId: task.id,
        targetAgentId: workerId,
        author: params.reviewer,
        mode: "rework",
        text: `[定向返工 Rework] 驳回原因：${params.reason}（上次提交产物 ${prevPr}：${prevSummary}）`,
      });

      return task;
    });
  }
}
