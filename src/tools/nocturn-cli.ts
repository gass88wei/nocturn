#!/usr/bin/env node
/**
 * Nocturn Core Agent Primitives CLI
 *
 * 1. `nocturn report`   — Worker reports structured Verdict (progress/ready/blocked/failed) + optional human_action + PR binding
 * 2. `nocturn handback` — Worker returns an out-of-scope message back to Squad Leader for re-routing
 * 3. `nocturn dispatch` — Squad Leader delegates a Task to a Worker and immediately exits its pulse turn
 * 4. `nocturn fanout`   — Squad Leader splits a parent Task into parallel subtasks with an AND Join Gate
 * 5. `nocturn note`     — Squad Leader sends a context-only note to a running Worker Session
 */
import type { NocturnEngine } from "../core/engine.ts";
import type { VerdictState } from "../core/model.ts";

export type NocturnCliCommand = "report" | "handback" | "dispatch" | "fanout" | "note";

export function executeAgentCliCommand(
  engine: NocturnEngine,
  command: NocturnCliCommand,
  args: Record<string, unknown>
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

    case "fanout": {
      const rawSubtasks =
        typeof args.subtasks === "string"
          ? (JSON.parse(args.subtasks) as Array<{
              id: string;
              title: string;
              to: string;
              order?: string;
            }>)
          : (args.subtasks as Array<{
              id: string;
              title: string;
              to: string;
              order?: string;
            }>);
      return engine.fanoutSubtasks({
        parentTaskId: String(args.parent ?? args.task ?? ""),
        subtasks: (rawSubtasks ?? []).map((s) => ({
          identifier: s.id,
          title: s.title,
          workerAgentId: s.to,
          orderText: s.order ?? s.title,
        })),
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
