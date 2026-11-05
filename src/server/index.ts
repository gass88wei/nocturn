import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NocturnStore } from "../store/sqlite.ts";
import { NocturnEngine } from "../core/engine.ts";
import { SotaPiRunner } from "../daemon/pi-runner.ts";
import { executeAgentCliCommand } from "../tools/nocturn-cli.ts";
import { ingestGitHubWebhook, type GitHubWebhookEvent } from "../sources/github.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createNocturnServer(dbPath = join(__dirname, "../../.nocturn.sqlite")) {
  const store = new NocturnStore(dbPath);
  const engine = new NocturnEngine(store);
  const runner = new SotaPiRunner(engine, { dryRun: false });

  // Seed default squads, agents, and initial tasks if empty
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
    store.saveAgent({
      id: "ops-leader",
      name: "运维小队队长",
      squadId: "ops",
      role: "leader",
      cli: "pi",
      model: "gemini-4-argon-high",
      skills: ["dispatch", "ops"],
      instructions: "协调压测与巡检任务。",
    });
    store.saveAgent({
      id: "bench-worker",
      name: "pi-bench",
      squadId: "ops",
      role: "worker",
      cli: "pi",
      model: "gemini-4-argon-high",
      skills: ["benchmark"],
      instructions: "在 sota 节点执行长会话稳定性压测。",
    });

    // Seed initial task #427
    const t427 = engine.createTask({
      identifier: "TASK-427",
      title: "#427 仓库页预览与二部图重构",
      description: "在独立 worktree 中完成二部图与右侧抽屉重构",
      squadId: "dev",
    });
    engine.dispatchTask({
      taskId: t427.id,
      workerAgentId: "pi-coder",
      orderText: "完成二部图重构并补充单测",
    });
    engine.reportVerdict({
      taskId: t427.id,
      agentId: "pi-coder",
      state: "progress",
      summary: "已完成 SVG 曲线改造，正在补桌面端单测",
      humanAction: "屏幕宽度小于 960px 时，右侧抽屉用浮层覆盖还是上下分栏折叠？",
      humanActionOptions: ["做成右侧浮层覆盖 (Overlay)", "做成上下分栏折叠"],
      prNumber: 112,
    });
    void runner.processPendingEffects();
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
          runs: store.listAllRuns(),
          inputs: store.listAllInputs(),
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

      // Execute a real turn on remote sota server using Pi 1.5.0 (--session-id <uuid>)
      if (req.method === "POST" && url.pathname === "/api/sota/exec") {
        const body = await readJsonBody(req);
        const task = store.getTask(String(body.taskId ?? "TASK-427"));
        if (!task) throw new Error("Task not found");
        const agentId = String(body.agentId ?? task.assignedWorkerId ?? task.leaderAgentId);
        const session = engine.ensureSession(agentId, task.id);
        await runner.processPendingEffects();
        const refreshedSession = store.getSession(session.id)!;

        const promptText = String(body.prompt ?? "汇报当前工作目录与状态，简短回答。");
        engine.sendInput({
          taskId: task.id,
          targetAgentId: agentId,
          author: "yangxin",
          mode: "steer",
          text: promptText,
        });

        const sotaRes = await runner.runLiveOnSota({
          worktreePath: refreshedSession.worktreePath,
          piSessionId: refreshedSession.piSessionId!,
          prompt: promptText,
        });

        const activeRunId = store.getSession(session.id)?.activeRunId;
        if (activeRunId) {
          engine.markDeliveredInputsReadForRun(activeRunId);
          const run = store.getRun(activeRunId)!;
          run.steps.push({
            badge: "步骤",
            text: `[sota Pi 1.5.0 真实回复] ${sotaRes.assistantText}`,
            timestamp: new Date().toISOString(),
          });
          store.saveRun(run);
        }

        sendJson(res, 200, {
          ok: true,
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
