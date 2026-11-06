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
1. 委派给组员执行（支持直接填现有组员 ID；**若现有团队缺少对应专精角色，你也可以直接填一个全新的专职 ID 如 \`sec-auditor\` / \`svg-artist\`，系统会像 SuperAgent 一样当场自动孵化该新组员并派单，无需人类预先配置！**）：
   \`nocturn dispatch --task ${task.identifier} --to <组员ID或新专职ID> --order "<具体执行要求>" --instructions "<可选：新专职组员的人设约束>"\`
2. 自主招募/组建新的专职组员或新特种小队：
   \`nocturn recruit --id <新专职ID> --name "<显示名称>" --squad ${squad.id} --skills "<技能列表>" --instructions "<专职人设>"\`
3. 拆分为多个并行子任务（Fan-out，所有子任务完成后会自动唤醒你汇总）：
   \`nocturn fanout --parent ${task.identifier} --subtasks '[{"id":"${task.identifier}-1","title":"...","to":"pi-coder"}]'\`
4. 若组员已上报 Verdict=ready 且你已完成最终核验，直接上报 ready：
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
核心收敛铁律（Stop by impact, not by effort）：完成核心文件/代码编写并做 1 次验证通过后，先在当前隔离 Git 分支执行 \`git add -A && git commit -m "feat(${task.identifier}): deliver verified changes"\`，随后**立即调用 \`nocturn report --state ready\` 交付并结束回合**！严禁反复截图或微调超过 2 轮！
目录红线：当前工作区已是独立 Git 分支 \`nocturn/${task.identifier.toLowerCase()}\`，所有文件读写与临时测试必须在当前工作区或 \`$TMPDIR\` 内进行，严禁在 /tmp 或 /root 下创建任何文件！

## 当前任务
- 任务号：${task.identifier} (内部 ID: ${task.id})
- 标题：${task.title}
- 队长委派指令：${orderText}
${prevVerdictSection}${inputsSection}

## 汇报与协作原语（通过 bash 工具调用）
1. 汇报进度或提出需要人类拍板的问题（可边提问边继续干确定性的活）：
   \`nocturn report --task ${task.identifier} --agent ${worker.id} --state progress --summary "<当前进展>" --human-action "<一句话拍板问题>"\`
2. 完成工作并提交准出 Verdict（常规确定性任务且单测通过默认 \`--risk low\`，经 Reviewer 审查通过后系统将**自动结单为已完成 done，无需打扰人类验收**；仅当涉及高风险破坏性变更、架构拍板或无法自动验证时传 \`--risk high\` 停在待人类审核）：
   \`nocturn report --task ${task.identifier} --agent ${worker.id} --state ready --risk low --summary "<完成摘要与测试结果>" --pr <PR编号>\`
3. 若你是审查员（codex-reviewer）且发现代码或测试有缺陷，直接调用 \`--state rework\` **自动打回给 pi-coder 原会话返工**（无需人类介入）：
   \`nocturn report --task ${task.identifier} --agent ${worker.id} --state rework --summary "<具体缺陷与返工要求>"\`
4. 若收到的评论超出本任务范围，退回给队长另建新任务：
   \`nocturn handback --task ${task.identifier} --trigger <triggerId> --reason "<越界说明>"\`
`;
}
