/**
 * Nocturn Core Domain Model
 *
 * Strictly separates three lifecycles:
 * 1. Task Lifecycle: Long-horizon goal (todo -> dispatching -> in_progress -> in_review -> blocked -> done)
 * 2. Session Lifecycle: Persistent (agentId, taskId) context bound to a remote sota Pi CLI session & Git worktree
 * 3. Run Lifecycle: One ephemeral CLI process execution that exits upon completion and produces a structured Verdict
 */

export type AgentRole = "chief" | "leader" | "worker";

export interface Agent {
  id: string;
  name: string;
  squadId: string | null;
  role: AgentRole;
  cli: "pi" | "codex" | "claude";
  model: string;
  skills: string[];
  instructions: string;
}

export interface Squad {
  id: string;
  name: string;
  color: string;
  leaderId: string;
  memberIds: string[];
}

export type TaskStatus =
  | "todo"
  | "dispatching"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done";

export type VerdictState =
  | "progress"
  | "ready"
  | "rework"
  | "blocked"
  | "failed"
  | "dropped";

export type RiskLevel = "low" | "high";

export interface VerdictReport {
  state: VerdictState;
  summary: string;
  /** Risk classification: 'low' (routine/covered by tests -> auto-done) vs 'high' (needs human approval) */
  risk?: RiskLevel;
  /** Structured one-sentence question for human decision (can coexist with state='progress') */
  humanAction?: string | null;
  /** Associated GitHub PR number; automatically binds PR thread subscription */
  prNumber?: number | null;
  confidence?: number;
  reportedAt: string;
}

export interface AttentionRequest {
  id: string;
  taskId: string;
  agentId: string;
  question: string;
  options?: string[];
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

/**
 * Two-phase Input delivery receipt (inspired by dsh-superagent-prototype):
 * - waiting: queued in SQLite, not yet sent to a running CLI process
 * - delivered: injected into a running CLI process (--steer), waiting for current turn/step to finish
 * - read: model completed the turn/step that consumed this input (safe against process crash)
 */
export type InputReceiptState = "waiting" | "delivered" | "read";

export type InputDeliveryMode = "steer" | "after_run" | "restart" | "note" | "rework" | "event";

export interface TaskInput {
  id: string;
  taskId: string;
  targetAgentId: string;
  author: string;
  mode: InputDeliveryMode;
  text: string;
  triggerId?: string;
  receiptState: InputReceiptState;
  createdAt: string;
  deliveredRunId?: string | null;
  readAt?: string | null;
}

/**
 * Session Lifecycle: 1-to-1 binding between (agentId, taskId).
 * Survives across multiple ephemeral Runs via native CLI session ID (--session / --resume).
 */
export interface AgentSession {
  id: string;
  agentId: string;
  taskId: string;
  /** Native Pi CLI session ID on remote sota server */
  piSessionId: string | null;
  /** Isolated Git worktree directory on remote sota server */
  worktreePath: string;
  activeRunId: string | null;
  updatedAt: string;
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export interface RunTraceStep {
  badge: "步骤" | "Report" | "Handback" | "Note" | "Input" | "Effects";
  text: string;
  receiptState?: InputReceiptState;
  timestamp: string;
}

/**
 * Run Lifecycle: A single CLI process execution for a Session.
 */
export interface AgentRun {
  id: string;
  sessionId: string;
  taskId: string;
  agentId: string;
  isLeaderTurn: boolean;
  status: RunStatus;
  /** Fencing token to prevent split-brain double execution when a timed-out Run is reclaimed */
  leaseToken: string;
  leaseExpiresAt: string;
  summary: string;
  steps: RunTraceStep[];
  verdict: VerdictReport | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Task {
  id: string;
  identifier: string;
  title: string;
  description: string;
  squadId: string;
  status: TaskStatus;
  leaderAgentId: string;
  assignedWorkerId: string | null;
  parentTaskId: string | null;
  /** Subscribed external threads (e.g. "github:issue:427", "github:pr:112") that fan out directly to worker */
  subscribedThreads: string[];
  latestVerdict: VerdictReport | null;
  pendingAttention: AttentionRequest | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalTrigger {
  id: string;
  /** Idempotency key (e.g. GitHub X-GitHub-Delivery or source:type:id) */
  eventKey: string;
  threadKey: string;
  actor: string;
  text: string;
  createdAt: string;
  handedBackByTaskId?: string | null;
  handbackReason?: string | null;
}
