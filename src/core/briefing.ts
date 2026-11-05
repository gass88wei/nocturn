import type { Agent, Squad, Task, TaskInput } from "./model.ts";

/**
 * Briefing & Prompt Context Builder
 *
 * Mirrors Multica's `squad_briefing.go` + DeepSeek SuperAgent's `orchestrator.md` & `worker.md`:
 * Assembles deterministic role-aware prompts for Squad Leaders and Workers on `sota`.
 */
export function buildLeaderBriefing(params: {
  task: Task;
  squad: Squad;
  leader: Agent;
  members: Agent[];
  childTasks: Task[];
  wakeReason?: string;
}): string {
  const { task, squad, leader, members, childTasks, wakeReason } = params;
  const workers = members.filter((m) => m.id !== leader.id);
  const rosterLines = workers
    .map((w) => `- ${w.id} (${w.name}): 技能=[${w.skills.join(", ")}] · 职责=${w.instructions}`)
    .join("\n");

  const childrenSection =
    childTasks.length > 0
      ? `\n## 子任务进度 (Fan-out & Join Gate)\n` +
        childTasks
          .map(
            (c) =>
              `- ${c.identifier} (${c.title}): 状态=${c.status}, 负责人=${c.assignedWorkerId ?? "未分配"}, Verdict=${c.latestVerdict?.state ?? "无"} (${c.latestVerdict?.summary ?? ""})`
          )
          .join("\n")
      : "";

  const wakeSection = wakeReason ? `\n## 本次唤醒原因\n${wakeReason}\n` : "";

  return `你是【${squad.name}】的小队队长（${leader.name}）。
核心铁律：你只负责拆单、委派与验收，**绝不亲自编写业务代码，派完单后立即结束当前回合（Stop after dispatching）**。

## 当前任务
- 任务号：${task.identifier} (内部 ID: ${task.id})
- 标题：${task.title}
- 描述：${task.description || "无补充描述"}
- 当前状态：${task.status}
${wakeSection}${childrenSection}
## 小队可用执行组员
${rosterLines}

## 你可执行的动作（在 bash 工具中执行一条即可结束回合）
1. 委派给单个组员执行：
   \`nocturn dispatch --task ${task.identifier} --to <组员ID> --order "<具体执行要求>"\`
2. 拆分为多个并行子任务（Fan-out，所有子任务完成后会自动唤醒你汇总）：
   \`nocturn fanout --parent ${task.identifier} --subtasks '[{"id":"${task.identifier}-1","title":"...","to":"pi-coder"}]'\`
3. 若组员已上报 Verdict=ready 且你已完成最终核验，直接上报 ready 移交人类待审核：
   \`nocturn report --task ${task.identifier} --agent ${leader.id} --state ready --summary "<验收结论>"\`
`;
}

export function buildWorkerBriefing(params: {
  task: Task;
  worker: Agent;
  orderText: string;
  unreadInputs: TaskInput[];
}): string {
  const { task, worker, orderText, unreadInputs } = params;
  const inputsSection =
    unreadInputs.length > 0
      ? `\n## 待处理的人类插话 / 返工 / 事件输入 (Inputs)\n` +
        unreadInputs
          .map((inp) => `- [${inp.mode}] 来自 ${inp.author}: 「${inp.text}」`)
          .join("\n")
      : "";

  const prevVerdictSection = task.latestVerdict
    ? `\n## 上一轮结构化 Verdict 记录\n- 状态: ${task.latestVerdict.state}\n- 摘要: ${task.latestVerdict.summary}\n`
    : "";

  return `你是执行组员 ${worker.name} (${worker.id})，职责：${worker.instructions}
核心收敛铁律（Stop by impact, not by effort）：完成核心文件/代码编写并做 1 次验证通过后，**必须立即调用 \`nocturn report --state ready\` 交付并结束回合**！严禁反复截图或微调超过 2 轮！

## 当前任务
- 任务号：${task.identifier} (内部 ID: ${task.id})
- 标题：${task.title}
- 队长委派指令：${orderText}
${prevVerdictSection}${inputsSection}

## 汇报与协作原语（通过 bash 工具调用）
1. 汇报进度或提出需要人类拍板的问题（可边提问边继续干确定性的活）：
   \`nocturn report --task ${task.identifier} --agent ${worker.id} --state progress --summary "<当前进展>" --human-action "<一句话拍板问题>"\`
2. 完成工作并提交准出 Verdict（若附带 --pr 会自动绑定 PR 事件绿色通道）：
   \`nocturn report --task ${task.identifier} --agent ${worker.id} --state ready --summary "<完成摘要与测试结果>" --pr <PR编号>\`
3. 若收到的评论超出本任务范围，退回给队长另建新任务：
   \`nocturn handback --task ${task.identifier} --trigger <triggerId> --reason "<越界说明>"\`
`;
}
