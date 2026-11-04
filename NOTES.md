# Nocturn 项目讨论笔记

更新时间：2026-11-04

## 1. 项目基本信息

- **项目名称**：**Nocturn**（原暂定名 AgentRelay 已废弃）
- **GitHub 仓库**：`https://github.com/poijygfdyy/nocturn`（Public）
- **一句话定位**：**Sleepless Multi-Agent Control Plane & Loop Engineering Runtime**（面向 7×24h 无人值守交付的多 Agent 协同控制面与组织级 Loop Runtime）

## 2. 核心技术路线（三大思想融合 + 原创控制面）

1. **工程底座（源自 Multica 提纯与去壳）**：
   - 复用并精简 Go Server + PostgreSQL + 远端 Daemon + 多 CLI 驱动（Claude Code / Codex / Pi）+ Git Worktree 隔离；
   - 砍掉移动端 (`apps/mobile`)、文档站 (`apps/docs`) 与商业计费 (`cloud_billing`、`seat_capacity`) 等冗余代码。
2. **双层自治与绿色通道（源自 DeepSeek Super-agent）**：
   - **架构强制「两层结构」**（绝不超过两层）：前台 **Coordinator 总管**（只动嘴不动手，负责目标理解、签发 `Mandate` 授权单、拆单与 Fan-out）+ 后台 **隔离 Worker**（跑在 `sota` 服务器独立 Worktree）。
   - **Thread 订阅直通（Green-Channel Wakeup）**：Worker 关联 PR 后自动订阅该 Thread，后续 PR Review 评论或 CI 报错绕过 Coordinator 直接唤醒原 Worker Session。
   - **两级准入与 `Observe` 模式**：外部事件先过 0 Token 规则快筛，高风险动作先生成 `Observe` 待确认卡，人工点 Approve 后再执行。
3. **组织级 Loop Engineering 可靠性闭环（源自腾讯 TEG《凌晨3点，我的AI军团还在替我交付》& 腾讯研究院访谈）**：
   - **结构化准出协议 `Verdict`**：强制 Worker 结束时输出 `Submission`（`verdict: pass | fail | blocked` + `artifacts` + `root_cause & confidence`）。
   - **`Agent Completed ≠ Business Completed`（`Acceptance` 验收 + 定向 `Rework`）**：Worker 跑完进入 `Acceptance` 待确认态；人类一键 Pass 或带 `rework_context` 定向打回原 Worker 分支重做。
   - **后台 `Sweeper` 巡检自愈**：定时巡检 `sota` Daemon 掉线、Task 假死超时、孤儿任务并自动重置/重派，记录结构化失败诊断（CLI/MCP stderr 摘要）。
   - **核心度量指标**：在 `Now` 态势台顶部实时追踪 **Agent Idle 率（24h 闲置率）**、**一次通过率** 与 **返工率**。

## 3. 运行与部署硬约束（重要）

- **所有 Agent Session 与执行进程（Daemon / CLI / 代码工作区）必须运行在服务器端（如 `sota` 服务器）**，**绝不在本地 Mac 上跑 Agent Session**。
- 本地 Mac 仅作为展示与操作终端（打开网页看状态、发指令、做审批/验收）；合上 Mac 后，服务器端的 Agent 依然可以 7×24 小时独立运行、恢复 Session 和处理事件。
