import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NocturnStore } from "../src/store/sqlite.ts";
import { NocturnEngine } from "../src/core/engine.ts";
import { SotaPiRunner } from "../src/daemon/pi-runner.ts";
import { executeAgentCliCommand } from "../src/tools/nocturn-cli.ts";

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

    // 4. Worker finishes Run 1 with Verdict=ready -> Run 1 exits, Task enters in_review
    executeAgentCliCommand(engine, "report", {
      task: task.id,
      agent: "pi-coder",
      state: "ready",
      summary: "单测全部通过，PR #112 就绪",
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
      run2.steps[0].text.includes(`--resume ${firstPiSessionId}`),
      "Run 2 explicitly resumes native Pi session ID"
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
});
