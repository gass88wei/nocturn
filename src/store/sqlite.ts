import { DatabaseSync } from "node:sqlite";
import type {
  Agent,
  AgentRun,
  AgentSession,
  ExternalTrigger,
  Squad,
  Task,
  TaskInput,
} from "../core/model.ts";

export type EffectKind = "launch_run" | "deliver_input" | "wake_leader";

export interface EffectRow {
  id: string;
  kind: EffectKind;
  dedupKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  status: "pending" | "done" | "failed";
  updatedAt: string;
}

/**
 * Single-file SQLite Store + Durable Transactional Effects Queue
 * (Replaces Multica's heavy PostgreSQL + Redis setup with zero external dependencies)
 */
export class NocturnStore {
  readonly db: DatabaseSync;
  private afterCommitCallbacks: Array<() => void> = [];
  private inTx = false;

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS squads (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(agent_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inputs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        receipt_state TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effects (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at TEXT NOT NULL
      );
    `);
  }

  atomic<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.inTx = false;
      const callbacks = this.afterCommitCallbacks.splice(0);
      for (const cb of callbacks) cb();
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.inTx = false;
      this.afterCommitCallbacks = [];
      throw err;
    }
  }

  afterCommit(cb: () => void): void {
    if (this.inTx) {
      this.afterCommitCallbacks.push(cb);
    } else {
      cb();
    }
  }

  saveSquad(squad: Squad): void {
    this.db
      .prepare("INSERT OR REPLACE INTO squads (id, data) VALUES (?, ?)")
      .run(squad.id, JSON.stringify(squad));
  }

  listSquads(): Squad[] {
    const rows = this.db.prepare("SELECT data FROM squads").all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Squad);
  }

  saveAgent(agent: Agent): void {
    this.db
      .prepare("INSERT OR REPLACE INTO agents (id, data) VALUES (?, ?)")
      .run(agent.id, JSON.stringify(agent));
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT data FROM agents WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Agent) : undefined;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare("SELECT data FROM agents").all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Agent);
  }

  saveTask(task: Task): void {
    this.db
      .prepare("INSERT OR REPLACE INTO tasks (id, identifier, data) VALUES (?, ?, ?)")
      .run(task.id, task.identifier, JSON.stringify(task));
  }

  getTask(idOrIdentifier: string): Task | undefined {
    const row = this.db
      .prepare("SELECT data FROM tasks WHERE id = ? OR identifier = ?")
      .get(idOrIdentifier, idOrIdentifier) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Task) : undefined;
  }

  listTasks(): Task[] {
    const rows = this.db.prepare("SELECT data FROM tasks").all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Task);
  }

  saveSession(session: AgentSession): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sessions (id, agent_id, task_id, data) VALUES (?, ?, ?, ?)"
      )
      .run(session.id, session.agentId, session.taskId, JSON.stringify(session));
  }

  getSessionByPair(agentId: string, taskId: string): AgentSession | undefined {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE agent_id = ? AND task_id = ?")
      .get(agentId, taskId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AgentSession) : undefined;
  }

  getSession(id: string): AgentSession | undefined {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as AgentSession) : undefined;
  }

  listSessions(): AgentSession[] {
    const rows = this.db.prepare("SELECT data FROM sessions").all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as AgentSession);
  }

  saveRun(run: AgentRun): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO runs (id, session_id, task_id, agent_id, data) VALUES (?, ?, ?, ?, ?)"
      )
      .run(run.id, run.sessionId, run.taskId, run.agentId, JSON.stringify(run));
  }

  getRun(id: string): AgentRun | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as AgentRun) : undefined;
  }

  listRunsForTask(taskId: string): AgentRun[] {
    const rows = this.db
      .prepare("SELECT data FROM runs WHERE task_id = ?")
      .all(taskId) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as AgentRun);
  }

  listRunsForAgent(agentId: string): AgentRun[] {
    const rows = this.db
      .prepare("SELECT data FROM runs WHERE agent_id = ?")
      .all(agentId) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as AgentRun);
  }

  saveInput(input: TaskInput): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO inputs (id, task_id, target_agent_id, receipt_state, data) VALUES (?, ?, ?, ?, ?)"
      )
      .run(input.id, input.taskId, input.targetAgentId, input.receiptState, JSON.stringify(input));
  }

  getInput(id: string): TaskInput | undefined {
    const row = this.db.prepare("SELECT data FROM inputs WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as TaskInput) : undefined;
  }

  listInputsForAgentTask(agentId: string, taskId: string): TaskInput[] {
    const rows = this.db
      .prepare("SELECT data FROM inputs WHERE target_agent_id = ? AND task_id = ?")
      .all(agentId, taskId) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as TaskInput);
  }

  saveTrigger(trigger: ExternalTrigger): void {
    this.db
      .prepare("INSERT OR REPLACE INTO triggers (id, thread_key, data) VALUES (?, ?, ?)")
      .run(trigger.id, trigger.threadKey, JSON.stringify(trigger));
  }

  getTrigger(id: string): ExternalTrigger | undefined {
    const row = this.db.prepare("SELECT data FROM triggers WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as ExternalTrigger) : undefined;
  }

  enqueueEffect(kind: EffectKind, dedupKey: string, payload: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const id = `eff_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db
      .prepare(
        `INSERT INTO effects (id, kind, dedup_key, payload, attempts, status, updated_at)
         VALUES (?, ?, ?, ?, 0, 'pending', ?)
         ON CONFLICT(dedup_key) DO UPDATE SET
           payload = excluded.payload,
           status = 'pending',
           updated_at = excluded.updated_at`
      )
      .run(id, kind, dedupKey, JSON.stringify(payload), now);
  }

  listPendingEffects(): EffectRow[] {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE status = 'pending' ORDER BY updated_at ASC")
      .all() as Array<{
      id: string;
      kind: EffectKind;
      dedup_key: string;
      payload: string;
      attempts: number;
      status: "pending" | "done" | "failed";
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      dedupKey: r.dedup_key,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      attempts: r.attempts,
      status: r.status,
      updatedAt: r.updated_at,
    }));
  }

  markEffectDone(id: string): void {
    this.db
      .prepare("UPDATE effects SET status = 'done', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
}
