import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

  // Seed default squads, agents, and initial tasks into SQLite if empty
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

    // Seed initial tasks into SQLite
    engine.createTask({
      identifier: "TASK-431",
      title: "#431 新增 GitHub Webhook 签名校验",
      description: "由 TASK-427 越界退回 (Handback) 自动创建的独立安全任务",
      squadId: "dev",
    });

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

    const t428 = engine.createTask({
      identifier: "TASK-428",
      title: "#428 会话跨周期 (--session-id) 恢复测试",
      description: "验证 sota 上跨 Run 恢复同一个原生 Pi 会话",
      squadId: "dev",
    });
    engine.dispatchTask({
      taskId: t428.id,
      workerAgentId: "pi-coder",
      orderText: "验证跨 Run 恢复逻辑",
    });

    const t425 = engine.createTask({
      identifier: "TASK-425",
      title: "#425 单用户 Cookie 顺序修复",
      description: "修复同名 Cookie 覆盖隐患",
      squadId: "dev",
    });
    engine.dispatchTask({
      taskId: t425.id,
      workerAgentId: "codex-reviewer",
      orderText: "审查 PR #108 并运行回归测试",
    });
    engine.reportVerdict({
      taskId: t425.id,
      agentId: "codex-reviewer",
      state: "ready",
      summary: "PR #108 的 47 项回归测试全部通过，置信度 0.96",
      prNumber: 108,
    });

    const t430 = engine.createTask({
      identifier: "TASK-430",
      title: "#430 Pi 1.5.0 远端长会话稳定性压测",
      description: "在 sota 节点执行 50 轮连续会话恢复压测",
      squadId: "ops",
    });
    engine.dispatchTask({
      taskId: t430.id,
      workerAgentId: "bench-worker",
      orderText: "运行 50 轮长会话恢复压测",
    });

    void runner.processPendingEffects();
  }

  // Enable automatic sota execution for all newly created/dispatched tasks when running live server
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
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/") {
        const html = readFileSync(join(__dirname, "../ui/index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Live Server-Sent Events (SSE) stream for real-time UI updates
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

      if (req.method === "POST" && url.pathname === "/api/agents") {
        const body = await readJsonBody(req);
        const agent = engine.upsertAgent({
          id: String(body.id),
          name: String(body.name ?? body.id),
          squadId: body.squadId ? String(body.squadId) : "dev",
          role: (body.role as Agent["role"]) ?? "worker",
          cli: (body.cli as Agent["cli"]) ?? "pi",
          model: String(body.model ?? "gemini-4-argon-high"),
          skills: Array.isArray(body.skills) ? body.skills.map(String) : ["coding"],
          instructions: String(body.instructions ?? ""),
        });
        sendJson(res, 200, agent);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJsonBody(req);
        const task = engine.createTask({
          identifier: String(body.identifier ?? `TASK-${430 + store.listTasks().length + 1}`),
          title: String(body.title ?? ""),
          description: String(body.description ?? ""),
          squadId: String(body.squadId ?? "dev"),
          parentTaskId: body.parentTaskId ? String(body.parentTaskId) : null,
        });
        await runner.processPendingEffects();
        sendJson(res, 201, task);
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

      // Execute a real streaming turn on remote sota server using Pi 1.5.0 (--session-id <uuid>)
      if (req.method === "POST" && url.pathname === "/api/sota/exec") {
        const body = await readJsonBody(req);
        const task = store.getTask(String(body.taskId ?? "TASK-427"));
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
