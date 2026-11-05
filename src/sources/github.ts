import type { NocturnEngine } from "../core/engine.ts";

export interface GitHubWebhookEvent {
  deliveryId: string;
  event: "issues" | "issue_comment" | "pull_request_review" | "check_suite";
  action?: string;
  sender: string;
  issueNumber?: number;
  prNumber?: number;
  title?: string;
  body?: string;
  checkConclusion?: "success" | "failure" | "cancelled";
  defaultSquadId?: string;
}

/**
 * V2 Event-Driven GitHub Source Adapter
 *
 * - Distinguishes new Issue creation from follow-up events on existing subscribed Issues/PRs.
 * - Guarantees webhook idempotency via `deliveryId` (duplicate deliveries never create duplicate Tasks or Runs).
 * - Routes CI failure or PR review comments directly to the owning Worker's Session via Subscription fan-out.
 */
export function ingestGitHubWebhook(
  engine: NocturnEngine,
  webhook: GitHubWebhookEvent
): {
  status: "duplicate" | "created_task" | "fanned_out" | "ignored";
  taskId?: string;
  routedToTaskIds?: string[];
} {
  const eventKey = `gh:${webhook.deliveryId}`;
  if (engine.store.getTriggerByEventKey(eventKey)) {
    return { status: "duplicate" };
  }

  // 1. New GitHub Issue opened -> create a new Task if not already tracked
  if (webhook.event === "issues" && webhook.action === "opened" && webhook.issueNumber) {
    const identifier = `GH-${webhook.issueNumber}`;
    const existingTask = engine.store.getTask(identifier);
    if (existingTask) return { status: "duplicate", taskId: existingTask.id };

    // Record the trigger for idempotency first
    engine.receiveExternalTrigger({
      eventKey,
      threadKey: `github:issue:${identifier}`,
      actor: webhook.sender,
      text: `${webhook.title ?? ""}: ${webhook.body ?? ""}`.trim(),
    });

    const task = engine.createTask({
      identifier,
      title: `#${webhook.issueNumber} ${webhook.title ?? "GitHub Issue"}`,
      description: webhook.body ?? "",
      squadId: webhook.defaultSquadId ?? "dev",
    });
    return { status: "created_task", taskId: task.id };
  }

  // 2. PR CI check failure -> fan out to any Task subscribed to `github:pr:<prNumber>`
  if (
    webhook.event === "check_suite" &&
    webhook.checkConclusion === "failure" &&
    webhook.prNumber
  ) {
    const res = engine.receiveExternalTrigger({
      eventKey,
      threadKey: `github:pr:${webhook.prNumber}`,
      actor: "github-ci",
      text: `[CI 失败] PR #${webhook.prNumber} 检查未通过：${webhook.body ?? "请检查单测与构建日志"}`,
    });
    return {
      status: res.duplicate ? "duplicate" : "fanned_out",
      routedToTaskIds: res.routedToTaskIds,
    };
  }

  // 3. Issue comment or PR review comment -> fan out to subscribed Task(s)
  const threadKey = webhook.prNumber
    ? `github:pr:${webhook.prNumber}`
    : `github:issue:GH-${webhook.issueNumber ?? 0}`;

  const res = engine.receiveExternalTrigger({
    eventKey,
    threadKey,
    actor: webhook.sender,
    text: webhook.body ?? "",
  });

  return {
    status: res.duplicate ? "duplicate" : "fanned_out",
    routedToTaskIds: res.routedToTaskIds,
  };
}
