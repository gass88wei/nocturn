# Nocturn

> **一个面向长程任务的极简多 Agent 协作与调度平台（Persistent Multi-Agent Orchestration & Harness Platform）。**
> 提纯融合自 **Multica**（长期 Agent 身份与跨周期 Session 底座）、**腾讯 TEG Loop Engineering**（结构化 Verdict 准出与带上下文定向返工）、以及 **DeepSeek SuperAgent (`dsh-superagent-prototype`)**（`report` 边提问边执行、Subscription 绿色通道直达与 `handback` 越界退回、`delivered → read` 两阶段防丢回执、单 SQLite + Effects 事务队列）。

---

## 1. 为什么做 Nocturn？（核心设计取舍）

原版 Multica 拥有近 **66.6 万行代码**（包含大量多租户 RBAC、云计费、6 种 IM 机器人与重型看板 CRUD）；而传统 Subagent 框架又只围绕单次主进程生命周期运转，进程退出即丢失协作关系。

**Nocturn** 将代码体量压缩了 **99.4%**（核心后端仅 **~1,350 行零外部依赖 TypeScript**），只保留真正决定长程多 Agent 协作质量的硬核机制：

| 维度 | 借鉴来源 | Nocturn 的提纯实现 | 砍掉的冗余包袱 |
| --- | --- | --- | --- |
| **三层生命周期分离** | Multica + 自研状态机 | 严格分离 **`Task`（长期目标）** ↔ **`Session`（`(agentId, taskId)` 绑定的远端 `sota` Worktree 与原生 `piSessionId`）** ↔ **`Run`（单次 CLI 进程执行，跑完即退）** | 砍掉多租户权限、席位计费、复杂的自定义看板字段 |
| **结构化 Verdict 与边问边干** | 腾讯知乎文 + SuperAgent `orchestrator_report` | Worker 通过 `nocturn report` 上报结构化 `state (progress/ready/blocked/failed)` + `summary` + `human_action`（抛出待人类拍板问题的同时可保持 `progress` 继续干确定性的活）+ `pr_number`（自动建立 PR 线程订阅） | 砍掉重型 6 节点固定 Workflow Template、自由 DAG 画布与 Temporal 引擎 |
| **绿色通道直达与越界退回** | SuperAgent `Subscription` + `handback` | 命中已订阅 Issue/PR 的后续评论与 CI 事件直接扇出给原 Worker Session（免唤醒队长）；若评论超出当前任务范围，Worker 调 `nocturn handback` 退回给队长另建新任务 | 砍掉 SuperAgent 针对公共飞书群设计的复杂 `Gate / Mandate / PolicyVersion` 权限推理矩阵 |
| **两阶段输入回执 (`delivered` vs `read`)** | SuperAgent `inputsDelivered` / `inputsRead` | 人类发出的实时插话（`--steer`）先记为 `delivered`（已送达进程），待模型完成当前回合后才升为 `read`。若进程在 `delivered` 期间崩溃或重启，恢复时自动重放所有未 `read` 的插话，绝不丢消息 | 砍掉外部消息队列依赖 |
| **单文件 SQLite + Effects 队列** | SuperAgent `Store` + `Effects` | 基于 Node.js 原生 `node:sqlite` 的单文件事务存储 + `effects` 持久化副作用表，零外部数据库依赖（无需 Postgres / Redis） | 砍掉 PostgreSQL + Redis 部署负担 |

---

## 2. 极简目录结构（6 个核心模块）

```text
nocturn/
├── src/
│   ├── core/
│   │   ├── model.ts        # 155 行：Task / Session / Run / Verdict / Attention / Input 领域模型
│   │   └── engine.ts       # 554 行：纯状态机引擎（脉冲派单、Verdict、订阅扇出、Handback、两阶段回执与崩溃重放、定向返工）
│   ├── store/
│   │   └── sqlite.ts       # 300 行：基于 node:sqlite 的单文件事务存储 + Effects 持久化队列
│   ├── daemon/
│   │   └── pi-runner.ts    # 108 行：远端 sota 服务器 Pi 1.5.0 执行器（Git Worktree 隔离 + --session-id 跨周期恢复）
│   ├── tools/
│   │   └── nocturn-cli.ts  #  69 行：注入给 Agent 的 4 个正交原语 (report / handback / dispatch / note)
│   ├── server/
│   │   └── index.ts        # 166 行：轻量 HTTP API + 状态同步服务
│   └── ui/
│       └── index.html      # 单屏指挥舱 UI（中间恒定实时态势二部图 + 右侧四态伴随式 Session 抽屉）
└── tests/
    └── engine.test.ts      # 204 行：核心不变量与故障恢复测试套件
```

---

## 3. 快速开始（零第三方 npm 依赖）

要求：Node.js `>= 22.6.0`（直接利用内置 `--experimental-strip-types`、`node:sqlite` 与 `node:test`）。

### 运行核心状态机与故障恢复测试
```bash
npm test
```
验证内容：
1. **V0 & V1 跨周期连续性**：Leader 脉冲式派单后立即退出进程；Worker 在独立 Worktree 完成 Run 1 并退出后，人类发起定向返工（`Rework`）自动通过同一个原生 `piSessionId` 拉起 Run 2。
2. **两阶段回执与崩溃重放**：运行中注入 `--steer` 插话（状态 `delivered`），模拟进程意外中断后恢复，验证未 `read` 的插话被自动重放。
3. **订阅直达与越界退回（Handback）**：上报 `pr_number` 自动绑定 PR 订阅；越界请求通过 `nocturn handback` 退回给队长并自动生成新任务。

### 启动本地服务与单屏指挥台
```bash
npm start
# 打开浏览器访问 http://localhost:4100
```
