import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NocturnStore } from "../src/store/sqlite.ts";
import { NocturnEngine } from "../src/core/engine.ts";
import { SotaPiRunner } from "../src/daemon/pi-runner.ts";
import { executeAgentCliCommand } from "../src/tools/nocturn-cli.ts";
import { ingestGitHubWebhook } from "../src/sources/github.ts";
import { buildLeaderBriefing, buildWorkerBriefing } from "../src/core/briefing.ts";

function setupSeededEngine() {
  const store = new NocturnStore(":memory:");
  store.saveSquad({
    id: "dev",
    name: "研发小队",
    color: "#4f46e5",
    leaderId: "dev-leader",
    memberIds: ["dev-leader", "pi-coder", "codex-reviewer"],
  });
  store.saveAgent({
    id: "dev-leader",
    name: "研发小队队长",
    squadId: "dev",
    role: "leader",
    cli: "pi",
    model: "gemini-4-argon-high",
    skills: ["dispatch"],
    instructions: "只负责派单并立即退出",
  });
  store.saveAgent({
    id: "pi-coder",
    name: "pi-coder",
    squadId: "dev",
    role: "worker",
    cli: "pi",
    model: "gemini-4-argon-high",
    skills: ["coding"],
    instructions: "在 sota worktree 执行编码",
  });
  const engine = new NocturnEngine(store);
  const runner = new SotaPiRunner(engine, { dryRun: true });
  return { store, engine, runner };
}

describe("Nocturn Core Engine & Distilled Mechanisms", () => {
  it("V0 & V1: separates Task/Session/Run lifecycles, exits Leader after pulse dispatch, and preserves native piSessionId across Runs", async () => {
    const { store, engine, runner } = setupSeededEngine();

    // 1. Create Task -> starts Leader pulse Run
    const task = engine.createTask({
      identifier: "TASK-427",
      title: "仓库页预览与二部图重构",
      squadId: "dev",
    });
    assert.equal(task.status, "dispatching");

    // 2. Leader dispatches to pi-coder -> Leader Run immediately completes ("Stop after dispatching")
    const { workerRun } = engine.dispatchTask({
      taskId: task.id,
      workerAgentId: "pi-coder",
      orderText: "在独立 worktree 完成重构并提 PR",
    });
    await runner.processPendingEffects();

    const leaderSession = store.getSessionByPair("dev-leader", task.id)!;
    assert.equal(leaderSession.activeRunId, null, "Leader must not stay running after dispatching");

    const workerSession = store.getSessionByPair("pi-coder", task.id)!;
    assert.ok(workerSession.piSessionId && workerSession.piSessionId.length >= 32, "Worker native Pi session UUID bound");
    const firstPiSessionId = workerSession.piSessionId;
    assert.equal(workerSession.activeRunId, workerRun.id);

    // 3. Worker reports progress + human_action (Attention while continuing work!)
    executeAgentCliCommand(engine, "report", {
      task: task.id,
      agent: "pi-coder",
      state: "progress",
      summary: "已完成 SVG 曲线，正在写单测",
      human_action: "移动端小于 960px 用浮层还是上下折叠？",
      pr: 112,
    });

    const updatedTask = store.getTask(task.id)!;
    assert.equal(updatedTask.pendingAttention?.question, "移动端小于 960px 用浮层还是上下折叠？");
    assert.ok(
      updatedTask.subscribedThreads.includes("github:pr:112"),
      "Reporting PR number automatically subscribes task to github:pr:112"
    );

    // 4. Worker finishes Run 1 with Verdict=ready (no reviewer in squad -> auto-closes as done when risk=low; high-risk enters in_review)
    executeAgentCliCommand(engine, "report", {
      task: task.id,
      agent: "pi-coder",
      state: "ready",
      risk: "high",
      summary: "单测全部通过，PR #112 就绪（架构变更请人类确认）",
      human_action: "null",
    });

    const afterReadyTask = store.getTask(task.id)!;
    assert.equal(afterReadyTask.status, "in_review");
    assert.equal(afterReadyTask.pendingAttention, null);
    assert.equal(store.getSession(workerSession.id)!.activeRunId, null, "Worker Run 1 exited cleanly");

    // 5. Targeted Rework wakes the EXACT SAME Session (piSessionId preserved!) in Run 2
    engine.reworkTask({
      taskId: task.id,
      reviewer: "yangxin",
      reason: "补充一个窄屏 resize 单测",
    });

    const resumedSession = store.getSession(workerSession.id)!;
    assert.equal(resumedSession.piSessionId, firstPiSessionId, "Native Pi session ID preserved across Runs");
    assert.notEqual(resumedSession.activeRunId, null);
    assert.notEqual(resumedSession.activeRunId, workerRun.id);
    const run2 = store.getRun(resumedSession.activeRunId!)!;
    assert.ok(
      run2.steps[0].text.includes(`--session-id ${firstPiSessionId}`),
      "Run 2 explicitly resumes native Pi session ID"
    );
  });

  it("V2 & V3: GitHub Webhook idempotency, CI failure auto-wakeup, and Lease Fencing / Sweeper self-healing", () => {
    const { store, engine } = setupSeededEngine();

    // 1. GitHub Issue opened webhook creates GH-501; duplicate deliveryId is idempotent
    const firstDelivery = ingestGitHubWebhook(engine, {
      deliveryId: "deliv-1001",
      event: "issues",
      action: "opened",
      sender: "yangxin",
      issueNumber: 501,
      title: "修复并发 Cookie 覆盖问题",
      body: "高并发下存在覆盖",
    });
    assert.equal(firstDelivery.status, "created_task");

    const dupDelivery = ingestGitHubWebhook(engine, {
      deliveryId: "deliv-1001",
      event: "issues",
      action: "opened",
      sender: "yangxin",
      issueNumber: 501,
      title: "修复并发 Cookie 覆盖问题",
    });
    assert.equal(dupDelivery.status, "duplicate");
    assert.equal(store.listTasks().length, 1, "Duplicate webhook must not create duplicate tasks");

    // 2. Dispatch to pi-coder, report ready with PR #202 (Run 1 exits)
    const task = store.getTask("GH-501")!;
    engine.dispatchTask({
      taskId: task.id,
      workerAgentId: "pi-coder",
      orderText: "修复并提 PR",
    });
    engine.reportVerdict({
      taskId: task.id,
      agentId: "pi-coder",
      state: "ready",
      summary: "已提交 PR #202",
      prNumber: 202,
    });
    const workerSession = store.getSessionByPair("pi-coder", task.id)!;
    assert.equal(workerSession.activeRunId, null, "Worker exited after Run 1");

    // 3. Hours later, GitHub CI fails on PR #202 -> automatically wakes pi-coder Session!
    const ciWebhook = ingestGitHubWebhook(engine, {
      deliveryId: "deliv-ci-202",
      event: "check_suite",
      sender: "github-actions",
      prNumber: 202,
      checkConclusion: "failure",
      body: "TestCookieRace failed",
    });
    assert.equal(ciWebhook.status, "fanned_out");
    const wokenSession = store.getSession(workerSession.id)!;
    assert.notEqual(wokenSession.activeRunId, null, "CI failure webhook automatically resumed Worker session");

    // 4. Simulate Run lease expiration & Sweeper self-healing + Fencing stale executor
    const stalledRun = store.getRun(wokenSession.activeRunId!)!;
    const staleLeaseToken = stalledRun.leaseToken;
    stalledRun.leaseExpiresAt = "2020-01-01T00:00:00.000Z";
    store.saveRun(stalledRun);

    const reclaimedRuns = engine.sweepStaleRuns("2026-01-01T00:00:00.000Z");
    assert.equal(reclaimedRuns.length, 1);
    assert.notEqual(reclaimedRuns[0].leaseToken, staleLeaseToken, "New recovery Run rotates leaseToken");

    // Old zombie executor tries to report with expired leaseToken -> fenced!
    assert.throws(
      () =>
        engine.reportVerdict({
          taskId: task.id,
          agentId: "pi-coder",
          state: "ready",
          summary: "Zombie report",
          leaseToken: staleLeaseToken,
        }),
      /Fenced stale executor/
    );
  });

  it("SuperAgent Two-Phase Input Receipt: replays delivered-but-unread steer inputs when a Run crashes/restarts", () => {
    const { store, engine } = setupSeededEngine();
    const task = engine.createTask({
      identifier: "TASK-428",
      title: "跨周期恢复测试",
      squadId: "dev",
    });
    engine.dispatchTask({
      taskId: task.id,
      workerAgentId: "pi-coder",
      orderText: "执行恢复测试",
    });

    // Human sends a live --steer input while Run 1 is running
    const steerInput = engine.sendInput({
      taskId: task.id,
      targetAgentId: "pi-coder",
      author: "yangxin",
      mode: "steer",
      text: "所有下拉菜单统一使用中文文案",
    });

    // Input is now `delivered` to the process, but NOT yet `read` (turn hasn't finished)
    assert.equal(steerInput.receiptState, "delivered");

    // Simulate process crash / interruption BEFORE the turn finishes!
    const workerSession = store.getSessionByPair("pi-coder", task.id)!;
    const recoveryRun = engine.interruptAndRecoverSession(
      workerSession.id,
      "模拟 sota 网络闪断重启"
    );

    // Verify the unread input was automatically re-bound and replayed into recoveryRun!
    const replayedStep = recoveryRun.steps.find((s) =>
      s.text.includes("[未读插话自动重放]")
    );
    assert.ok(replayedStep, "Delivered-but-unread input must be automatically replayed on crash recovery");

    // Once recoveryRun finishes a report/step, the input transitions to `read`
    engine.markDeliveredInputsReadForRun(recoveryRun.id);
    const settledInput = store.getInput(steerInput.id)!;
    assert.equal(settledInput.receiptState, "read");
  });

  it("SuperAgent Subscription Fan-out & Handback: routes PR events directly to Worker, and hands back out-of-scope triggers to Leader", () => {
    const { store, engine } = setupSeededEngine();
    const task = engine.createTask({
      identifier: "TASK-427",
      title: "二部图重构",
      squadId: "dev",
    });
    engine.dispatchTask({
      taskId: task.id,
      workerAgentId: "pi-coder",
      orderText: "重构二部图",
    });
    engine.reportVerdict({
      taskId: task.id,
      agentId: "pi-coder",
      state: "progress",
      summary: "已提 PR #112",
      prNumber: 112,
    });

    // External comment arrives on github:pr:112 -> goes straight to pi-coder via green-channel subscription
    const { trigger, routedToTaskIds } = engine.receiveExternalTrigger({
      threadKey: "github:pr:112",
      actor: "yangxin",
      text: "顺便把 GitHub Webhook 签名校验也加上",
    });
    assert.deepEqual(routedToTaskIds, [task.id]);

    // Worker sees it's out of scope for #427 and calls `nocturn handback` -> spawns TASK-431 for Squad Leader
    const newTask = executeAgentCliCommand(engine, "handback", {
      task: task.id,
      trigger: trigger.id,
      reason: "Webhook 签名属独立安全模块，超出 #427 范围",
      new_id: "TASK-431",
    }) as { identifier: string; status: string };

    assert.equal(newTask.identifier, "TASK-431");
    assert.equal(newTask.status, "dispatching");
    const savedTrigger = store.getTrigger(trigger.id)!;
    assert.equal(savedTrigger.handedBackByTaskId, task.id);
  });

  it("Fan-out & Join Gate + BriefingBuilder + Leader Auto-Wakeup: wakes parent Leader only when ALL parallel subtasks report Verdict=ready", async () => {
    const { store, engine, runner } = setupSeededEngine();

    // Register a second worker via upsertAgent
    engine.upsertAgent({
      id: "codex-reviewer",
      name: "codex-reviewer",
      squadId: "dev",
      role: "worker",
      cli: "pi",
      model: "deepseek-v4.1-flash",
      skills: ["review"],
      instructions: "负责测试与代码审查",
    });

    const parent = engine.createTask({
      identifier: "TASK-500",
      title: "全栈重构（前后端并行）",
      squadId: "dev",
    });

    // Leader splits parent into 2 parallel subtasks via `nocturn fanout`
    const children = executeAgentCliCommand(engine, "fanout", {
      parent: parent.id,
      subtasks: [
        { id: "TASK-500-FE", title: "前端二部图改造", to: "pi-coder", order: "改前端" },
        { id: "TASK-500-BE", title: "后端 SQLite 接口", to: "codex-reviewer", order: "改后端" },
      ],
    }) as Array<{ id: string; identifier: string }>;
    assert.equal(children.length, 2);

    // Subtask 1 reports ready -> Parent must still be in_progress (Join Gate waiting for Subtask 2)
    engine.reportVerdict({
      taskId: children[0].id,
      agentId: "pi-coder",
      state: "ready",
      summary: "前端完成",
    });
    assert.equal(store.getTask(parent.id)!.status, "in_progress");

    // Subtask 2 reports ready -> Join Gate satisfied! Parent advances & wakes Leader!
    engine.reportVerdict({
      taskId: children[1].id,
      agentId: "codex-reviewer",
      state: "ready",
      summary: "后端完成",
    });
    assert.equal(store.getTask(parent.id)!.status, "in_review");

    await runner.processPendingEffects();
    const leaderRuns = store.listAllRuns().filter((r) => r.taskId === parent.id && r.agentId === "dev-leader");
    assert.equal(leaderRuns.length, 2, "Leader automatically woken for Join Gate synthesis Run");

    // Verify BriefingBuilder generates role-aware Leader & Worker prompts
    const leaderPrompt = runner.buildBriefingForTaskAgent(parent.id, "dev-leader", "Join Gate 汇总");
    assert.ok(leaderPrompt.includes("TASK-500-FE") && leaderPrompt.includes("TASK-500-BE"));
    const workerPrompt = runner.buildBriefingForTaskAgent(children[0].id, "pi-coder");
    assert.ok(workerPrompt.includes("nocturn report"));
  });

  it("Risk-Stratified Autonomous Acceptance & Agent-to-Agent Rework: Reviewer auto-reworks Coder on defects and auto-closes (done) low-risk tasks without bothering human", () => {
    const { store, engine } = setupSeededEngine();
    engine.upsertAgent({
      id: "codex-reviewer",
      name: "codex-reviewer",
      squadId: "dev",
      role: "worker",
      cli: "pi",
      model: "zgca/deepseek-flash",
      skills: ["review"],
      instructions: "负责代码与测试独立审查",
    });

    const task = engine.createTask({
      identifier: "TASK-600",
      title: "实现自动结单与自动打回闭环",
      squadId: "dev",
    });
    engine.dispatchTask({ taskId: task.id, workerAgentId: "pi-coder", orderText: "实现代码" });
    engine.reportVerdict({
      taskId: task.id,
      agentId: "pi-coder",
      state: "ready",
      summary: "初版完成",
    });

    // Leader hands off to codex-reviewer
    engine.dispatchTask({ taskId: task.id, workerAgentId: "codex-reviewer", orderText: "审查代码" });

    // 1. Reviewer finds a bug and reports state='rework' -> automatically wakes pi-coder without bothering human!
    executeAgentCliCommand(engine, "report", {
      task: task.id,
      agent: "codex-reviewer",
      state: "rework",
      summary: "缺少空串边界断言，请补充",
    });
    const reworkedTask = store.getTask(task.id)!;
    assert.equal(reworkedTask.status, "in_progress");
    assert.equal(reworkedTask.assignedWorkerId, "pi-coder", "Task automatically routed back to pi-coder");
    const coderSession = store.getSessionByPair("pi-coder", task.id)!;
    assert.notEqual(coderSession.activeRunId, null, "pi-coder session automatically resumed for rework");

    // 2. Coder fixes and reports ready -> Leader hands off to codex-reviewer -> Reviewer reports ready (risk=low) -> AUTO-DONE!
    engine.reportVerdict({
      taskId: task.id,
      agentId: "pi-coder",
      state: "ready",
      summary: "已补充空串单测",
    });
    engine.dispatchTask({ taskId: task.id, workerAgentId: "codex-reviewer", orderText: "复审" });
    executeAgentCliCommand(engine, "report", {
      task: task.id,
      agent: "codex-reviewer",
      state: "ready",
      risk: "low",
      summary: "复审通过，100% 单测覆盖，自动结单",
    });

    const finalTask = store.getTask(task.id)!;
    assert.equal(finalTask.status, "done", "Low-risk Reviewer-approved task automatically closes as done without bothering human");
  });

  it("Dual Execution Mode (Local / SSH) & Isolated Git Branch Worktree Initialization", () => {
    const { engine } = setupSeededEngine();
    const localRunner = new SotaPiRunner(engine, {
      execMode: "local",
      baseDir: "/tmp/nocturn-test-local",
      dryRun: true,
    });
    const localCmd = localRunner.buildSotaPiCommand({
      worktreePath: "/tmp/nocturn-test-local/worktrees/task-700",
      piSessionId: "00000000-0000-0000-0000-000000000700",
      prompt: "test local execution",
    });
    assert.equal(localCmd.bin, "sh");
    assert.ok(
      localCmd.args[1].includes('git -C /tmp/nocturn-test-local/worktrees/task-700 init -b "$b"'),
      "Local mode command automatically initializes isolated Git branch nocturn/<slug>"
    );

    const sshRunner = new SotaPiRunner(engine, {
      execMode: "ssh",
      baseDir: "/home/qijinyin/multimodal/yangxin/nocturn",
      sshHost: "root@115.190.90.101",
      sshPort: 10780,
      dryRun: true,
    });
    const sshCmd = sshRunner.buildSotaPiCommand({
      worktreePath: "/home/qijinyin/multimodal/yangxin/nocturn/worktrees/task-700",
      piSessionId: "00000000-0000-0000-0000-000000000700",
      prompt: "test ssh execution",
    });
    assert.equal(sshCmd.bin, "ssh");
    assert.ok(
      sshCmd.args[sshCmd.args.length - 1].includes(
        'git -C /home/qijinyin/multimodal/yangxin/nocturn/worktrees/task-700 init -b "$b"'
      ),
      "SSH mode command initializes isolated Git branch inside sota worktree"
    );
  });

  it("SuperAgent-Style Dynamic Specialist & Squad Creation: Leader can recruit new specialists or auto-spawn unregistered workers on dispatch without manual pre-config", () => {
    const { store, engine } = setupSeededEngine();
    const task = engine.createTask({
      identifier: "TASK-800",
      title: "执行 SQL 注入安全渗透审计",
      squadId: "dev",
    });

    // 1. Leader dispatches directly to a specialist ID ('sec-auditor') that was NEVER manually pre-configured!
    executeAgentCliCommand(engine, "dispatch", {
      task: task.id,
      to: "sec-auditor",
      order: "对 SQLite 层做参数化绑定审计",
      instructions: "专职安全审计员",
    });

    const autoSpawned = store.getAgent("sec-auditor");
    assert.ok(autoSpawned, "Unregistered specialist 'sec-auditor' was automatically materialized on dispatch");
    assert.equal(autoSpawned!.squadId, "dev");
    assert.ok(store.listSquads().find((s) => s.id === "dev")!.memberIds.includes("sec-auditor"));

    // 2. Leader can also explicitly form a brand-new Squad & Specialist via `nocturn recruit`
    executeAgentCliCommand(engine, "recruit", {
      id: "perf-profiler",
      name: "性能压测专家",
      squad: "perf-squad",
      squad_name: "性能特种小队",
      skills: "benchmark,flamegraph",
      instructions: "专职负责百万级并发与内存火焰图剖析",
    });
    const newSquad = store.listSquads().find((s) => s.id === "perf-squad");
    assert.ok(newSquad, "New squad 'perf-squad' dynamically created without manual pre-configuration");
    assert.ok(newSquad!.memberIds.includes("perf-profiler"));
  });
});
