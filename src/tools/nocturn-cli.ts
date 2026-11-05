#!/usr/bin/env node
/**
 * Nocturn 4 Core Agent Primitives CLI
 *
 * Replaces dozens of bloated CRUD commands with 4 orthogonal orchestration primitives:
 * 1. `nocturn report`   — Worker reports structured Verdict (progress/ready/blocked/failed) + optional human_action + PR binding
 * 2. `nocturn handback` — Worker returns an out-of-scope message back to Squad Leader for re-routing
 * 3. `nocturn dispatch` — Squad Leader delegates a Task to a Worker and immediately exits its pulse turn
 * 4. `nocturn note`     — Squad Leader sends a context-only note to a running Worker Session
 */
import type { NocturnEngine } from "../core/engine.ts";
import type { VerdictState } from "../core/model.ts";

export function executeAgentCliCommand(
  engine: NocturnEngine,
  command: "report" | "handback" | "dispatch" | "note",
  args: Record<string, string | number | undefined>
): unknown {
  switch (command) {
    case "report": {
      const taskId = String(args.task ?? "");
      const agentId = String(args.agent ?? "");
      const state = String(args.state ?? "progress") as VerdictState;
      const summary = String(args.summary ?? "");
      const humanAction =
        args.human_action === "null"
          ? null
          : args.human_action !== undefined
          ? String(args.human_action)
          : undefined;
      const prNumber = args.pr !== undefined ? Number(args.pr) : undefined;
      return engine.reportVerdict({
        taskId,
        agentId,
        state,
        summary,
        humanAction,
        prNumber,
      });
    }

    case "handback": {
      return engine.handbackTrigger({
        taskId: String(args.task ?? ""),
        triggerId: String(args.trigger ?? ""),
        reason: String(args.reason ?? ""),
        newIdentifier: String(args.new_id ?? `TASK-${Date.now()}`),
      });
    }

    case "dispatch": {
      return engine.dispatchTask({
        taskId: String(args.task ?? ""),
        workerAgentId: String(args.to ?? ""),
        orderText: String(args.order ?? ""),
      });
    }

    case "note": {
      return engine.sendInput({
        taskId: String(args.task ?? ""),
        targetAgentId: String(args.to ?? ""),
        author: String(args.from ?? "leader"),
        mode: "note",
        text: String(args.text ?? ""),
      });
    }
  }
}
