import type {
  AgentRun,
  AgentSession,
  AttentionRequest,
  ExternalTrigger,
  InputDeliveryMode,
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

  constructor(store: NocturnStore) {
    this.store = store;
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
      return task;
    });
  }

  /**
   * Ensure a persistent (agentId, taskId) Session exists with an isolated sota worktree path.
   */
  ensureSession(agentId: string, taskId: string): AgentSession {
    const existing = this.store.getSessionByPair(agentId, taskId);
    if (existing) return existing;

    const task = this.store.getTask(taskId);
    const slug = (task?.identifier ?? taskId).toLowerCase();
    const session: AgentSession = {
      id: uid("sess"),
      agentId,
      taskId,
      piSessionId: null,
      worktreePath: `/root/code/worktrees/${slug}-${agentId}`,
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
  }): { task: Task; workerRun: AgentRun } {
    return this.store.atomic(() => {
      const task = this.store.getTask(params.taskId);
      if (!task) throw new Error(`Task not found: ${params.taskId}`);

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
      return { task, workerRun };
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
      const verdict = {
        state: params.state,
        summary: params.summary,
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

      // Advance Task status & trigger Squad Leader Join Gate wakeup on ready / blocked
      if (params.state === "ready") {
        task.status = "in_review";
        this.store.enqueueEffect("wake_leader", `wake:${task.id}:ready`, {
          taskId: task.id,
          leaderAgentId: task.leaderAgentId,
          reason: `Worker ${params.agentId} reported Verdict=ready: ${params.summary}`,
        });
      } else if (params.state === "blocked") {
        task.status = "blocked";
        this.store.enqueueEffect("wake_leader", `wake:${task.id}:blocked`, {
          taskId: task.id,
          leaderAgentId: task.leaderAgentId,
          reason: `Worker ${params.agentId} reported Verdict=blocked: ${params.summary}`,
        });
      }

      task.updatedAt = now;
      this.store.saveTask(task);
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
        .filter((t) => t.subscribedThreads.includes(params.threadKey) && t.status !== "done");

      const routedToTaskIds: string[] = [];
      for (const t of matchedTasks) {
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
