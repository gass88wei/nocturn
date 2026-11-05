import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";

const execFileAsync = promisify(execFile);
import { fileURLToPath } from "node:url";
import { NocturnStore } from "../store/sqlite.ts";
import { NocturnEngine } from "../core/engine.ts";
import { SotaPiRunner } from "../daemon/pi-runner.ts";
import { executeAgentCliCommand, type NocturnCliCommand } from "../tools/nocturn-cli.ts";
import { ingestGitHubWebhook, type GitHubWebhookEvent } from "../sources/github.ts";
import type { Agent, TaskStatus } from "../core/model.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createNocturnServer(dbPath = join(__dirname, "../../.nocturn.sqlite")) {
  const store = new NocturnStore(dbPath);
  const engine = new NocturnEngine(store);
  const runner = new SotaPiRunner(engine, { dryRun: false });
  const sseClients = new Set<ServerResponse>();

  function getSnapshot() {
    return {
      squads: store.listSquads(),
      agents: store.listAgents(),
      tasks: store.listTasks(),
      sessions: store.listSessions(),
      runs: store.listAllRuns(),
      inputs: store.listAllInputs(),
      pendingEffects: store.listPendingEffects(),
    };
  }

  engine.onStateChange(() => {
    if (sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(getSnapshot())}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  // Seed ONLY the real squads & agents (NO fake mock tasks!)
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
      model: "Deepseek-V4.1-Flash/gemini-4-argon-high",
      skills: ["dispatch", "handoff", "fanout"],
      instructions: "只负责派单与验收，派单后立即退出进程 (Stop after dispatching)。",
    });
    store.saveAgent({
      id: "pi-coder",
      name: "pi-coder",
      squadId: "dev",
      role: "worker",
      cli: "pi",
      model: "Deepseek-V4.1-Flash/deepseek-v4.1-flash",
      skills: ["fullstack", "worktree", "unit-test"],
      instructions: "在 sota 独立 Git Worktree 执行编码任务并通过 nocturn report 汇报。",
    });
    store.saveAgent({
      id: "codex-reviewer",
      name: "codex-reviewer",
      squadId: "dev",
      role: "worker",
      cli: "pi",
      model: "zgca/deepseek-flash",
      skills: ["review", "regression-test"],
      instructions: "审查 PR 并提交结构化 Verdict。",
    });
    store.saveAgent({
      id: "ops-leader",
      name: "运维小队队长",
      squadId: "ops",
      role: "leader",
      cli: "pi",
      model: "Deepseek-V4.1-Flash/gemini-4-argon-high",
      skills: ["dispatch", "ops"],
      instructions: "协调压测与巡检任务。",
    });
    store.saveAgent({
      id: "bench-worker",
      name: "pi-bench",
      squadId: "ops",
      role: "worker",
      cli: "pi",
      model: "zgca/deepseek-flash",
      skills: ["benchmark"],
      instructions: "在 sota 节点执行长会话稳定性压测。",
    });
  }

  // Enable automatic sota execution for newly created/dispatched tasks when running live server
  if (dbPath !== ":memory:") {
    runner.options.autoSpawnOnSota = true;
  }

  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(payload, null, 2));
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/") {
        const html = readFileSync(join(__dirname, "../ui/index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, getSnapshot());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/pelican.svg") {
        const svgPath = join(__dirname, "../../pelican-bicycle.svg");
        if (existsSync(svgPath)) {
          res.writeHead(200, {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(readFileSync(svgPath, "utf8"));
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/bicycle-pelican.svg") {
        const svgPath = join(__dirname, "../../bicycle-riding-pelican.svg");
        if (existsSync(svgPath)) {
          res.writeHead(200, {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(readFileSync(svgPath, "utf8"));
          return;
        }
      }

      // Live sota worktree file explorer API: returns files and source code for a Task
      if (req.method === "GET" && url.pathname === "/api/worktree-files") {
        const taskCode = String(url.searchParams.get("task") ?? "TASK-451").toLowerCase();
        const pyScript = `
import os, json, glob
base = "/home/qijinyin/multimodal/yangxin/nocturn/worktrees"
dirs = sorted(glob.glob(f"{base}/{taskCode}*"))
out = []
wdir = dirs[0] if dirs else f"{base}/{taskCode}"
for d in dirs:
    for entry in sorted(os.listdir(d)):
        if entry.startswith("."): continue
        fp = os.path.join(d, entry)
        if os.path.isfile(fp) and os.path.getsize(fp) < 200000:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                out.append({"name": entry, "path": fp, "size": os.path.getsize(fp), "content": f.read()})
print(json.dumps({"worktreePath": wdir, "files": out}))
`;
        const { stdout } = await execFileAsync("ssh", [
          "-p",
          String(runner.options.sshPort),
          "-o",
          `ControlPath=${runner.options.sshControlSocket}`,
          runner.options.sshHost,
          `python3 -c '${pyScript.replace(/'/g, "'\\''")}'`,
        ]);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(stdout.trim());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/agents") {
        const body = await readJsonBody(req);
        const agent = engine.upsertAgent({
          id: String(body.id),
          name: String(body.name ?? body.id),
          squadId: body.squadId ? String(body.squadId) : "dev",
          role: (body.role as Agent["role"]) ?? "worker",
          cli: (body.cli as Agent["cli"]) ?? "pi",
          model: String(body.model ?? "Deepseek-V4.1-Flash/deepseek-v4.1-flash"),
          skills: Array.isArray(body.skills) ? body.skills.map(String) : ["coding"],
          instructions: String(body.instructions ?? ""),
        });
        sendJson(res, 200, agent);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJsonBody(req);
        const existingCount = store.listTasks().length;
        const identifier = String(body.identifier ?? `TASK-${101 + existingCount}`);
        const task = engine.createTask({
          identifier,
          title: String(body.title ?? ""),
          description: String(body.description ?? ""),
          squadId: String(body.squadId ?? "dev"),
          parentTaskId: body.parentTaskId ? String(body.parentTaskId) : null,
        });
        await runner.processPendingEffects();
        sendJson(res, 201, task);
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/tasks/")) {
        const targetId = decodeURIComponent(url.pathname.slice("/api/tasks/".length));
        const task = store.getTask(targetId);
        if (task) {
          store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
          store.db.prepare("DELETE FROM runs WHERE task_id = ?").run(task.id);
          store.db.prepare("DELETE FROM sessions WHERE task_id = ?").run(task.id);
          store.db.prepare("DELETE FROM inputs WHERE task_id = ?").run(task.id);
          engine.notifyChange();
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks/status") {
        const body = await readJsonBody(req);
        const task = store.getTask(String(body.taskId));
        if (!task) throw new Error("Task not found");
        task.status = String(body.status) as TaskStatus;
        task.updatedAt = new Date().toISOString();
        store.saveTask(task);
        engine.notifyChange();
        sendJson(res, 200, task);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks/bind-issue") {
        const body = await readJsonBody(req);
        const task = store.getTask(String(body.taskId));
        if (!task) throw new Error("Task not found");
        const issueRef = String(body.issueRef ?? "").trim();
        (task as unknown as { boundIssue?: string }).boundIssue = issueRef;
        const threadKey = `github:issue:${issueRef}`;
        if (issueRef && !task.subscribedThreads.includes(threadKey)) {
          task.subscribedThreads.push(threadKey);
        }
        task.updatedAt = new Date().toISOString();
        store.saveTask(task);
        engine.notifyChange();
        sendJson(res, 200, task);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cli") {
        const body = await readJsonBody(req);
        const cmd = String(body.command) as NocturnCliCommand;
        const out = executeAgentCliCommand(
          engine,
          cmd,
          (body.args ?? {}) as Record<string, unknown>
        );
        await runner.processPendingEffects();
        sendJson(res, 200, { ok: true, result: out });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/input") {
        const body = await readJsonBody(req);
        const task = store.getTask(String(body.taskId));
        if (!task) throw new Error(`Task not found: ${body.taskId}`);
        const inp = engine.sendInput({
          taskId: task.id,
          targetAgentId: String(body.targetAgentId ?? task.assignedWorkerId ?? task.leaderAgentId),
          author: String(body.author ?? "yangxin"),
          mode: (body.mode ?? "steer") as "steer" | "after_run" | "restart" | "note",
          text: String(body.text ?? ""),
        });
        await runner.processPendingEffects();
        sendJson(res, 200, inp);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/runs/stop") {
        const body = await readJsonBody(req);
        const killed = runner.killActiveRun(
          String(body.runId),
          String(body.reason ?? "用户在界面点击 ■ 停止，已终止远端 sota 进程")
        );
        sendJson(res, 200, { ok: killed });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/rework") {
        const body = await readJsonBody(req);
        const task = store.getTask(String(body.taskId));
        if (!task) throw new Error(`Task not found: ${body.taskId}`);
        const updated = engine.reworkTask({
          taskId: task.id,
          reviewer: String(body.reviewer ?? "yangxin"),
          reason: String(body.reason ?? ""),
        });
        await runner.processPendingEffects();
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/webhooks/github") {
        const body = (await readJsonBody(req)) as unknown as GitHubWebhookEvent;
        const result = ingestGitHubWebhook(engine, body);
        await runner.processPendingEffects();
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sweep") {
        const reclaimed = engine.sweepStaleRuns();
        await runner.processPendingEffects();
        sendJson(res, 200, { reclaimedCount: reclaimed.length, reclaimed });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sota/exec") {
        const body = await readJsonBody(req);
        const task = store.getTask(String(body.taskId));
        if (!task) throw new Error("Task not found");
        const agentId = String(body.agentId ?? task.assignedWorkerId ?? task.leaderAgentId);
        const session = engine.ensureSession(agentId, task.id);
        await runner.processPendingEffects();

        const promptText = body.prompt
          ? String(body.prompt)
          : runner.buildBriefingForTaskAgent(task.id, agentId);

        engine.sendInput({
          taskId: task.id,
          targetAgentId: agentId,
          author: "yangxin",
          mode: "steer",
          text: String(body.prompt ?? "执行当前任务回合"),
        });
        await runner.processPendingEffects();

        const refreshedSession = store.getSession(session.id)!;
        const activeRunId = refreshedSession.activeRunId ?? undefined;
        const chosenModel = runner.resolveAgentModel(agentId);

        const sotaRes = await runner.runLiveOnSota({
          runId: activeRunId,
          worktreePath: refreshedSession.worktreePath,
          piSessionId: refreshedSession.piSessionId!,
          model: chosenModel,
          prompt: promptText,
        });

        sendJson(res, 200, {
          ok: true,
          runId: activeRunId,
          model: chosenModel,
          piSessionId: refreshedSession.piSessionId,
          worktreePath: refreshedSession.worktreePath,
          sotaReply: sotaRes.assistantText,
        });
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
