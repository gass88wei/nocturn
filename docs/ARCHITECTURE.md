# Nocturn 架构与核心机制详解

> 本文档对应代码仓库中的 6 个核心模块（总计约 1,450 行零依赖 TypeScript 源码），完整说明 Nocturn 如何将 **Multica**、**腾讯 TEG Loop Engineering** 与 **DeepSeek SuperAgent** 的核心机制提纯融合为一个轻量、可自愈的长程多 Agent 调度系统。

---

## 1. 三层生命周期的严格分离 (`src/core/model.ts` & `src/core/engine.ts`)

Nocturn 将传统 Subagent 混为一谈的执行过程拆解为三个正交的生命周期：

```text
Task Lifecycle (长期目标)
  todo ──> dispatching ──> in_progress ──> in_review ──> done
                              │               │
                              ▼               └──(reworkTask 定向返工)──┐
Session Lifecycle ((agentId, taskId) 唯一绑定)                         │
  worktreePath: /root/code/worktrees/<task>-<agent>                    │
  piSessionId:  UUID (对应 sota 上 pi --session-id <uuid>) <───────────┘
        │
        ├── Run #1 (脉冲启动 -> 执行 -> 上报 Verdict -> 退出进程)
        ├── Run #2 (数小时后收到 PR CI 报错或人类插话 -> 恢复同一 piSessionId -> 退出进程)
        └── Run #3 (收到人类 Rework 驳回 -> 携带上次产物与驳回理由恢复同一 piSessionId)
```

* **单 Session 互斥锁**：`NocturnEngine.startRun` 强制校验同一 `Session` 在同一时刻最多只能有 1 个处于 `running` 状态的 `AgentRun`，杜绝并发写坏同一个 Git Worktree。
* **脉冲式队长调度（Stop after dispatching）**：`dispatchTask` 在队长将任务委派给执行组员的同一 SQLite 事务内，立即将队长的派单 Run 置为 `completed` 并释放 `activeRunId`，队长进程即刻退出，零后台进程空转。

---

## 2. 结构化 Verdict 准出与「边提问边执行」(`reportVerdict`)

融合腾讯知乎文（4.1 节准出字段与 Verdict）与 DeepSeek SuperAgent（`orchestrator_report`）：

* 执行组员通过 `nocturn report` 提交结构化报告：
  * `state`: `progress | ready | blocked | failed | dropped`
  * `summary`: 结构化交付摘要与证据
  * `humanAction`: **一句话向人类提出的拍板问题（`AttentionRequest`）**
  * `prNumber`: 关联的 GitHub PR 编号
* **关键机制**：
  1. **边提问边干活**：当 `state = 'progress'` 且携带 `humanAction` 时，`task.pendingAttention` 被置顶到左侧控制面供人类拍板，同时组员的当前 Run 继续推进不依赖该决定的工作，不会挂死进程。
  2. **报 PR 号即自动建立绿色通道订阅**：一旦上报 `prNumber: 112`，引擎自动将 `github:pr:112` 加入 `task.subscribedThreads`。

---

## 3. 订阅绿色通道扇出 (`receiveExternalTrigger`) 与越界退回 (`handbackTrigger`)

* **绿色通道直达（0 路由开销）**：来自 `src/sources/github.ts` 的 PR Review 评论或 CI `check_suite` 失败事件，只要命中 `task.subscribedThreads`，直接调用 `sendInput` 投递给该任务的执行组员（若组员处于空闲态则自动 `--session-id` 唤醒原会话），无需每次唤醒小队队长传话。
* **越界主动退回（`nocturn handback`）**：若人类在已订阅的 PR/Issue 下顺嘴提出超出当前任务边界的新需求，执行组员调用 `handbackTrigger(taskId, triggerId, reason)`，引擎在同一事务内将该 Trigger 标记退回并交由小队队长自动生成新任务（如 `TASK-431`）。

---

## 4. 两阶段输入回执 (`waiting → delivered → read`) 与崩溃重放

为彻底解决“人类在 Agent 运行中发送 `--steer` 插话，刚送达进程就遇到网络闪断或重启导致插话丢失”的工程难题：

1. **三态转换**：
   * `waiting`：消息已写入 SQLite，等待投递；
   * `delivered`：消息已注入正在运行的 CLI 进程（`deliveredRunId = run.id`），但模型尚未完成当前回合；
   * `read`：模型完成了包含该消息的 step/report，正式调用 `markDeliveredInputsReadForRun(run.id)` 将其确认为已读。
2. **崩溃/中断自动重放（`interruptAndRecoverSession`）**：
   * 当某个 Run 因超时或重启中断时，引擎自动扫描所有 `receiptState === 'delivered' && deliveredRunId === oldRunId`（已送达旧进程但未完成回合读取）的插话，将其重新绑定并重放到新启动的恢复 Run 中，实现**零丢消息保证**。

---

## 5. 租约屏障（Lease Fencing）与 Sweeper 自愈 (`sweepStaleRuns`)

* 每个 `AgentRun` 启动时生成唯一的 `leaseToken` 与 `leaseExpiresAt`（默认 5 分钟租约）。
* `sweepStaleRuns()` 巡检发现超时未续租的卡死 Run 时，自动触发 `interruptAndRecoverSession` 接管会话并轮换新的 `leaseToken`。
* 如果旧的僵尸执行进程（Zombie Executor）稍后恢复并试图携带旧 `leaseToken` 调用 `reportVerdict`，引擎会直接通过 `Fenced stale executor` 屏障拒绝写入，彻底避免双执行脑裂。
