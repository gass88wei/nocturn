# Nocturn 详细架构与核心机制设计文档

本文档定义 **Nocturn** 的四大核心控制面（Control Plane）子系统、状态机流转与数据模型改造方案。

---

## 1. 子系统一：两级事件准入与 Mandate 授权门控 (Admission & Mandate Gate)

### 1.1 设计目标
防止外部高频事件（GitHub Webhook、IM 群聊消息）直接触发重型 Coding CLI 造成 Token 浪费或越权操作。

### 1.2 两级过滤流水线
1. **Fast Path（程序级 0-Token 快筛）**：
   - 校验事件来源是否在白名单（Allowed Repos / Allowed Channels / Allowed Senders）。
   - 校验是否命中显式触发条件（如 `@Coordinator`、特定 Label 或已订阅的 PR Thread）。
   - 未命中直接丢弃（`Status = ignored`），耗时 `< 1ms`，消耗 `0 Token`。
2. **Slow Path（轻量语义判定与 Mandate 签发）**：
   - 由轻量模型或 Coordinator 判断意图类型，并生成不可变的 **`Mandate`（授权单）**：

```json
{
  "mandate_id": "mnd_01j9...",
  "issuer_id": "usr_owner",
  "mode": "observe | execute",
  "allowed_repos": ["poijygfdyy/nocturn"],
  "allowed_branch_prefix": "nocturn/issue-",
  "allow_push": true,
  "allow_merge": false,
  "max_fanout_workers": 3
}
```

- 当 `mode = "observe"` 时，任务进入 `deferred (ReasonObservePendingApproval)` 状态，在前端 `Now` 面板展示为灰色虚线 `Observing`，待用户点击 **Approve** 后转为 `queued`。

---

## 2. 子系统二：双层隔离调度与 Thread 订阅绿色通道 (Dual-Layer & Green-Channel)

### 2.1 架构强制的 Coordinator vs Worker 边界
| 维度 | 前台总管 (Coordinator / Mira Bot) | 后台特种兵 (Worker Assistants) |
| :--- | :--- | :--- |
| **运行位置** | 服务端轻量会话 | 远端 `sota` 服务器 `nocturnd` Daemon |
| **可用工具集** | `create_issue`, `fanout_subtasks`, `assign_worker`, `query_verdict`, `notify_user`（**严禁挂载 Bash / Edit 工具**） | 完整 Coding CLI 工具链（Claude Code / Codex / Pi）+ 独立 Git Worktree |
| **交互对象** | 直接面向人类用户，秒级响应 | 仅向系统提交结构化 `Submission`，不在主群聊刷屏 |

### 2.2 Thread 订阅绿色通道 (Green-Channel Wakeup)
- **绑定时机**：当某个 Worker（如 `codex-high-dev`）在处理 `Issue #42` 时创建或关联了 `PR #108`，系统自动写入订阅表 `thread_subscriptions`：
  - `thread_key = "github:poijygfdyy/nocturn:pr:108"`
  - `issue_id = "issue_42"`
  - `worker_agent_id = "agt_codex_high"`
  - `mandate_id = "mnd_01j9..."`
- **直通唤醒**：
  - 当 `POST /api/webhooks/vcs/{connectionId}` 收到 `PR #108` 的 `pull_request_review_comment` 或 `check_suite (conclusion = failure)`：
  - 查表命中 `thread_subscriptions` 后，**跳过 Coordinator**，直接将评论/报错增量注入 `agt_codex_high` 在 `Issue #42` 上的既有 Task Session（触发 `DispatchQueued` 或 `DispatchSteered`）。
  - **安全不变式**：直通事件仅追加上下文，严禁扩大初始 `mandate_id` 的授权范围。

---

## 3. 子系统三：Loop Engineering 闭环（Verdict 准出 + Acceptance 验收 + 定向 Rework）

### 3.1 结构化准出协议 (`TaskSubmission`)
每个 Worker 执行结束时，必须通过 CLI/MCP 协议提交结构化结果，下游不再解析自然语言：

```json
{
  "task_id": "tsk_01j9...",
  "verdict": "pass | fail | blocked",
  "confidence": 0.92,
  "summary": "修复了 WebSocket 重连时的订阅丢失问题，新增 3 个单元测试全部通过。",
  "root_cause": "reconnect 回调中未重新发送 subscribe 帧",
  "artifacts": {
    "pr_url": "https://github.com/poijygfdyy/nocturn/pull/108",
    "branch": "nocturn/issue-42-ws-reconnect",
    "commit_sha": "a1b2c3d",
    "changed_files": 4
  },
  "diagnostic": {
    "failed_tool": null,
    "stderr_excerpt": null,
    "retry_count": 0
  }
}
```

### 3.2 任务生命周期与定向返工状态机
```text
[Queued] ──► [Running] ──► (Verdict == pass) ──► [Pending Acceptance]
                 │                                     │          │
                 ├──► (Verdict == blocked)             │ Pass     │ Reject (带 rework_reason)
                 │         ▼                           ▼          ▼
                 │    [Explicit Blocked]            [Done]   [Targeted Rework]
                 │    (通知人工介入)                               │
                 └◄───────────────────────(携带 rework_context 唤醒原 Worker 分支)
```

---

## 4. 子系统四：Sweeper 巡检自愈与 `Now` 实时二部图态势台

### 4.1 Sweeper 后台自愈协程
服务端内置定时巡检器（默认每 30 秒 Tick），消除三类静默失败：
1. **Runtime 掉线恢复**：若 `sota` Daemon 心跳超时，将其名下卡在 `running` 的 Task 标记为待恢复或重派给备用 Worker。
2. **Task 超时与僵尸进程清理**：超出最大执行时长仍无流式输出的 Task 自动中断，收集最后 50 行 `stderr` 写入 `diagnostic` 并转为 `blocked`。
3. **Fan-out 收敛补偿**：当所有并行子任务均已达成 `Verdict = pass` 但父任务未推进时，自动触发 `AND Join` 进入 `Pending Acceptance`。

### 4.2 `Now — Who's doing what` 实时态势台指标口径
- **Agent Idle Rate（闲置率）**：`1 - (过去 24h 内各 Worker 处于 Running 状态的总时长 / (在线 Worker 数 × 24h))`
- **First-Pass Yield（一次通过率）**：`未经 Reject Rework 直接 Acceptance Pass 的任务数 / 总验收任务数`
- **二部图连线状态映射**：
  - **蓝色实线 (`Running`)**：Worker 正在 `sota` Worktree 中执行代码或跑测试。
  - **紫色实线 (`Delegating`)**：Coordinator 正在拆解需求或进行 Fan-out 派单。
  - **琥珀色实线 (`Pending Acceptance`)**：Worker 已提交 `Verdict = pass`，等待人类最终确认。
  - **灰色虚线 (`Observing`)**：处于 `Mandate (mode = observe)`，等待人类点击 Approve 启动。
