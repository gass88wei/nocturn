import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NocturnStore } from "../store/sqlite.ts";
import { NocturnEngine } from "../core/engine.ts";
import { SotaPiRunner } from "../daemon/pi-runner.ts";
import { executeAgentCliCommand } from "../tools/nocturn-cli.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createNocturnServer(dbPath = join(__dirname, "../../.nocturn.sqlite")) {
  const store = new NocturnStore(dbPath);
  const engine = new NocturnEngine(store);
  const runner = new SotaPiRunner(engine, { dryRun: true });

  // Seed default squads & agents if empty
  if (store.listSquads().length === 0) {
    store.saveSquad({
      id: "dev",
      name: "研发小队",
      color: "#4f46e5",
      leaderId: "dev-leader",
      memberIds: ["dev-leader", "pi-coder", "codex-reviewer"],
    });
    store.saveSquad({
      id: "ops",
      name: "实验与运维小队",
      color: "#7c3aed",
      leaderId: "ops-leader",
      memberIds: ["ops-leader", "bench-worker"],
    });
    store.saveAgent({
      id: "dev-leader",
      name: "研发小队队长",
      squadId: "dev",
      role: "leader",
      cli: "pi",
      model: "gemini-4-argon-high",
      skills: ["dispatch", "handoff"],
      instructions: "只负责派单与验收，派单后立即退出进程 (Stop after dispatching)。",
    });
    store.saveAgent({
      id: "pi-coder",
      name: "pi-coder",
      squadId: "dev",
      role: "worker",
      cli: "pi",
      model: "gemini-4-argon-high",
      skills: ["fullstack", "worktree"],
      instructions: "在 sota 独立 Git Worktree 执行编码任务并通过 nocturn report 汇报。",
    });
    store.saveAgent({
      id: "codex-reviewer",
      name: "codex-reviewer",
      squadId: "dev",
      role: "worker",
      cli: "pi",
      model: "deepseek-v4.1-flash",
      skills: ["review", "regression-test"],
      instructions: "审查 PR 并提交结构化 Verdict。",
    });
  }

  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload, null, 2));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/") {
        const html = readFileSync(join(__dirname, "../ui/index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, {
          squads: store.listSquads(),
          agents: store.listAgents(),
          tasks: store.listTasks(),
          sessions: store.listSessions(),
          pendingEffects: store.listPendingEffects(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJsonBody(req);
        const task = engine.createTask({
          identifier: String(body.identifier ?? `TASK-${Date.now()}`),
          title: String(body.title ?? ""),
          description: String(body.description ?? ""),
          squadId: String(body.squadId ?? "dev"),
        });
        await runner.processPendingEffects();
        sendJson(res, 201, task);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cli") {
        const body = await readJsonBody(req);
        const cmd = String(body.command) as "report" | "handback" | "dispatch" | "note";
        const out = executeAgentCliCommand(
          engine,
          cmd,
          (body.args ?? {}) as Record<string, string | number | undefined>
        );
        await runner.processPendingEffects();
        sendJson(res, 200, { ok: true, result: out });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/input") {
        const body = await readJsonBody(req);
        const inp = engine.sendInput({
          taskId: String(body.taskId),
          targetAgentId: String(body.targetAgentId),
          author: String(body.author ?? "yangxin"),
          mode: (body.mode ?? "steer") as "steer" | "after_run" | "restart" | "note",
          text: String(body.text ?? ""),
        });
        await runner.processPendingEffects();
        sendJson(res, 200, inp);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/rework") {
        const body = await readJsonBody(req);
        const task = engine.reworkTask({
          taskId: String(body.taskId),
          reviewer: String(body.reviewer ?? "yangxin"),
          reason: String(body.reason ?? ""),
        });
        await runner.processPendingEffects();
        sendJson(res, 200, task);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return { server, store, engine, runner };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4100);
  const { server } = createNocturnServer();
  server.listen(port, () => {
    console.log(`Nocturn Server running on http://localhost:${port}`);
  });
}
