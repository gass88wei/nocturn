# Nocturn

> **Sleepless Multi-Agent Control Plane & Loop Engineering Runtime.**  
> 当你合上电脑，你的 AI 研发军团仍在夜里持续拆单、编码、自测、自愈与交付。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Architecture: Coordinator-Worker](https://img.shields.io/badge/Architecture-Dual--Layer%20%2B%20Green--Channel-purple.svg)](#核心架构设计)
[![Runtime: 24/7 Server Daemon](https://img.shields.io/badge/Runtime-7%C3%9724h%20Remote%20Daemon-success.svg)](#全天候远端部署模型)

---

## 为什么做 Nocturn？

Coding Agent（如 Claude Code、Codex、Pi）的单点执行能力已经非常强，但在真实工程交付中，个人与团队依然困在三个结构性瓶颈里：

1. **「人下班，Agent 也下班」（高达 80%+ 的 Agent Idle 闲置率）**  
   旧模式下，Agent 的启动、上下文转述、步骤衔接、报错重跑全部依赖人的在线状态。你同时开三个终端窗口，看似多了三个 AI 同事，实则自己变成了全天候人工调度员。
2. **单 Session 漂移 vs 多层传话损耗**  
   把所有工作塞进同一个长 Session，经过多次上下文压缩（Compact）后会产生严重漂移，且「既当运动员又当裁判」会带来强烈偏见；但若盲目模仿人类组织建多层审批 Agent，又会在层层自然语言转述中丢失关键代码上下文、烧光 Token。
3. **自然语言交接脆弱 & 半夜无人盯屏时「静默卡死」**  
   Agent 回复一句散装的自然语言“改好了”不代表业务真正可交付（`Agent Completed ≠ Business Completed`）；而在凌晨 3 点无人值守时，最怕的不是报错，而是 CLI 进程假死、Runtime 掉线导致整条链路静默停摆。

**Nocturn** 的目标不是训练另一个单点 Agent，而是构建一套 **从 Prompt Engineering 走向 Loop Engineering（工作循环工程）** 的控制面：用**严格两层架构**消除传话损耗，用**结构化准出与定向返工**保障交付质量，用**后台巡检自愈**兑现 7×24 小时无人值守运转。

---

## 核心架构设计

```text
                          ┌────────────────────────────────────────────────────────┐
                          │             External Events / Human Input              │
                          │      (Web UI / GitHub PR & CI Webhook / IM Trigger)    │
                          └───────────────┬────────────────────────┬───────────────┘
                                          │                        │
                         [1. Admission & Mandate Gate]             │ [2. Thread Green-Channel]
                         (Fast-Path 0-Token 规则快筛                │ (PR Review 评论 / CI 失败
                          + Observe 待批 / Execute 授权单)          │  0 路由损耗直通原 Worker)
                                          │                        │
                                          ▼                        │
                          ┌───────────────────────────────┐        │
                          │   Foreground Coordinator      │        │
                          │   (Mira Bot · 只动嘴不动手)     │        │
                          │  • 零代码执行工具，秒级响应     │        │
                          │  • 目标拆解 / Fan-out 并行派单 │        │
                          └───────────────┬───────────────┘        │
                                          │ Dispatch Ticket        │
                                          ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                     Remote Server Daemon (7×24h 远端计算节点)                     │
│                                                                                  │
│   ┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐ │
│   │ Worker: codex-high   │   │ Worker: cc-xhigh     │   │ Worker: pi-verifier  │ │
│   │ [Git Worktree #101]  │   │ [Git Worktree #102]  │   │ [Git Worktree #103]  │ │
│   └──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘ │
│              └──────────────────────────┼──────────────────────────┘             │
│                                         │                                        │
│                        [3. Structured Verdict Submission]                        │
│                 (Verdict: pass | fail | blocked + Artifacts + Confidence)        │
│                                         │                                        │
│                        [4. Acceptance & Targeted Rework]                         │
│                 (Pass -> 归档合并  |  Reject -> 带 Rework Context 定向打回原分支)  │
└──────────────────────────────────────────────────────────────────────────────────┘
                 ▲
                 └─── [5. Sweeper 自愈协程] 定时巡检假死 Task / 掉线 Runtime / 自动重派
```

### 1. 架构强制的「前台 Coordinator + 后台隔离 Worker」双层模型
* **绝不超过两层**：摒弃低效的人类多级传话流程，全系统严格分为两层。
* **前台总管（Coordinator）**：常驻在线，**从架构层剥夺写文件与执行 Bash 的工具权限**，只负责理解目标、签发不可变的 **Mandate（授权单）**、拆解子任务（支持 **Fan-out 并行拆分与 AND 收敛**）并派发给专职 Worker，确保前台对话永远秒回不阻塞。
* **后台特种兵（Isolated Workers）**：每个 Worker 绑定专属底层 CLI（Claude Code / Codex / Pi）与模型档位，在远端服务器的独立 **Git Worktree** 中隔离执行，严禁直接对外刷屏，仅通过结构化协议汇报。

### 2. Thread 订阅与「绿色通道直通（Green-Channel Wakeup）」
* 当某个 Worker 在处理任务过程中创建或关联了 GitHub Pull Request，Nocturn 会自动为该 Worker 注册 **Thread Subscription**。
* 后续该 PR 下产生的所有 Code Review 评论、CI Check 失败事件，**不再经过前台 Coordinator 二次路由转发**，而是通过绿色通道直接唤醒原 Worker 的既有 Session 与代码分支，节省 30%+ 路由 Token 并完整保留上下文。

### 3. 两级准入过滤与 `Observe / Execute` 授权边界
* **Fast Path（0 Token 规则快筛）**：对外部 Webhook 与群聊事件进行白名单、分支保护与显式提及过滤，直接拦截 90% 无关噪音。
* **Mandate 授权单与 `Observe` 模式**：为每个任务生成不可变的权限边界（限定可读写仓库、分支及操作级别）；支持 `Observe`（观察记账模式）——先生成「拟执行计划卡」，人工在网页端点击 Approve 后再正式唤醒 Daemon 执行，后续 Thread 直通消息无法突破初始 Mandate 边界。

### 4. 组织级 Loop Engineering：`Verdict` 准出、`Acceptance` 验收与定向 `Rework`
* **结构化准出（Submission & Verdict）**：告别脆弱的自然语言状态猜测。Worker 结束任务时必须提交结构化 `Submission`：
  * `verdict`: `pass` | `fail` | `blocked`
  * `artifacts`: PR 链接、Commit SHA、改动摘要与测试报告
  * `root_cause & confidence`: 根因解释与自评置信度
* **`Agent Completed ≠ Business Completed`**：Worker 跑完且 CI 通过后进入 `Acceptance`（待验收态）。人类验收者点击 **Reject（驳回）** 时，系统带着 `rework_context` **定向打回原 Worker 节点与原分支重修**，无需全链路重头跑起。

### 5. `Sweeper` 无人值守自愈 + `Now` 实时二部图态势台
* **后台 `Sweeper` 巡检协程**：针对「凌晨 3 点无人盯屏」场景，定时巡检 Daemon 心跳、长时间卡在 `running` 的假死任务与孤儿节点，自动执行重置重派或升级为显式 `blocked`（附带 CLI/MCP `stderr` 结构化诊断摘要）。
* **`Now (Who's doing what)` 实时连线大屏**：
  * 采用 **二部图（Bipartite Graph）** 实时渲染左侧 `Coordinator & Workers` 与右侧 `Running Sessions / Tasks` 之间的平滑贝塞尔连线（区分 `Running`、`Delegating`、`Pending Acceptance`、`Observing` 状态）。
  * 顶部实时追踪 **Agent Idle 率（24h 闲置率）**、**一次通过率（First-Pass Yield）** 与 **定向返工率（Rework Rate）**。

---

## 全天候远端部署模型（Thin Client + Remote Server）

Nocturn 遵循严格的**脑手驻留远端、本地轻量交互**原则：

* **远端服务器（如 `sota` 节点）**：7×24 小时运行 Nocturn Go Server、PostgreSQL、Redis 以及 `nocturnd` Daemon，托管所有 Git Worktree 与 Coding CLI 进程。
* **本地终端（Mac / 浏览器）**：仅作为态势观察、指令下发与 `Acceptance` 审批面板。**合上笔记本电脑后，远端服务器上的 Coordinator 与 Worker 军团依然全速运转、处理 Webhook 并推进交付循环。**

---

## 项目演进路线（Roadmap）

- [x] **Phase 0：架构蓝图与协议定义**（双层调度、Thread 直通、Verdict 准出与 Now 态势台规范）
- [ ] **Phase 1：核心代码底座迁入与精简提纯**（Go Server + Web 控制台 + 远端 Daemon 协议，剥离非核心冗余）
- [ ] **Phase 2：Coordinator → Worker 强制分工与 Thread 绿色通道实现**
- [ ] **Phase 3：Verdict 结构化准出、Acceptance 定向 Rework 与 Sweeper 自愈协程**
- [ ] **Phase 4：`Now — Who's doing what` 实时贝塞尔二部图态势台与 Idle 率指标面板**

---

## 致谢与灵感来源

Nocturn 的工程设计与架构演进深度汲取了以下开源项目与工程实践的启发：
* **[Multica](https://github.com/multica-ai/multica)**：提供了优秀的 Go Server + Daemon + 多 CLI 运行时协作底座与「不超过两层（Orchestrator + Worker + Validator）、降低 Agent Idle 率」的核心理念。
* **DeepSeek Super-agent 架构实践**：启发了「前台轻量 Router + 后台隔离 Worker」强制双层解耦、两级事件准入（Fast/Slow Path + Mandate / Observe）以及「Thread 订阅绿色通道直通」机制。
* **腾讯技术工程（TEG）《凌晨3点，我的AI军团还在替我交付》**：启发了组织级 Loop Engineering 中的「`Verdict` 结构化准出协议」「`Agent Completed ≠ Business Completed`（Acceptance 与定向 Rework）」以及「`Sweeper` 防静默卡死巡检自愈」机制。
