# S0 · 地基

> 父任务：`.trellis/tasks/09-24-blog-production-backend`
> 需求、架构与阶段地图见父任务的 `prd.md` / `design.md` / `implement.md`。本文只写 S0 自身的交付内容。
>
> 本阶段对应父任务需求：R1（增量可用）、R6（分层起步）、R7（可观测性起步）、R8（CI 起步）。

## Goal

为门户项目打地基：把当前单包 Vite 应用重构为 pnpm workspace，并建立一个**可运行、可观测、可测试**的 API 骨架。

**本阶段不做任何业务逻辑**——API 只有健康检查端点。目的是让后续每个阶段都建立在同一套地基上，而不是边写业务边补地基。

## 已确认的工具链现状（实测）

| 工具 | 版本 | 状态 |
|---|---|---|
| node | v22.22.0 | ✅ |
| npm | 10.9.4 | ✅ |
| pnpm | 12.4.1 | ✅ 已安装 |
| docker (client) | 29.8.0 | ⚠️ **已安装但不在 Git Bash 的 PATH 中**，路径见下 |
| docker compose | v5.5.1 | ✅ 同上 |
| python | 3.13.15 | ✅（agent 模块用） |
| WSL2 | Ubuntu | ✅ |

Docker 的实际位置：

```
C:\Users\15532\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe
```

> 这是用户级安装（不在 `C:\Program Files`），Git Bash 默认不继承该路径。**本阶段必须解决这个 PATH 问题**，否则后续所有 `docker compose` 命令都跑不了。

## 需求

- **S0-R1 · workspace 重构**：仓库重构为 pnpm workspace（`apps/web`、`apps/api`、`packages/shared`），**现有前端构建必须仍然通过**。
- **S0-R2 · 基础设施容器化**：Docker Compose 提供 Postgres 与 Redis 两个服务。
- **S0-R3 · API 骨架**：Fastify 应用，含配置校验、结构化日志、请求 ID。
- **S0-R4 · 健康检查**：`/health`（存活）与 `/ready`（就绪）语义分离且正确。
- **S0-R5 · 统一错误契约**：单一错误处理器产出 `{ error: { code, message, requestId } }`，路由内不手写错误响应体。
- **S0-R6 · CI**：GitHub Actions 在 PR 上跑 lint + 类型检查 + 单测。
- **S0-R7 · 后端 spec 起步**：`.trellis/spec/backend/` 建立并写入分层纪律（英文，遵循 `.trellis/spec/frontend/index.md` 的语言约定）。

## 验收标准

- [ ] `pnpm install` 在根目录成功，`pnpm --filter web build` 与 `pnpm --filter web check` 均通过（证明重构未破坏现有前端）
- [ ] `pnpm --filter api build` 与 `pnpm --filter api test` 通过
- [ ] `docker compose -f infra/docker-compose.yml up -d` 起 Postgres 与 Redis，两者均健康
- [ ] `curl localhost:3001/health` 返回 200
- [ ] `curl localhost:3001/ready` 返回 200 且响应体含 postgres / redis 各自状态
- [ ] **停掉 Postgres 后 `/ready` 返回 503，而 `/health` 仍返回 200**（证明两者语义确实分离，不是同一个实现）
- [ ] 缺少必需环境变量时进程**立即退出**并打印缺失项名称，而不是启动后才在请求时崩
- [ ] 任意请求的日志行与错误响应体中含**同一个** request id；外部传入 `x-request-id` 时沿用它
- [ ] 未知路由返回 404，且响应体符合统一错误契约（不是 Fastify 默认格式）
- [ ] CI 在 PR 上绿灯
- [ ] `.trellis/spec/backend/` 存在且含分层纪律文档

## 不在范围内

- 任何业务端点（文章、鉴权、上传）——S1 起才有
- 数据库 schema 与迁移——S1
- nginx 网关——S5
- 前端迁移 Next.js——S4（本阶段前端只是被搬进 `apps/web`，内部逻辑一行不改）
- agent 模块接入——S5
- 多实例与负载均衡——S7

## 阻塞性开放问题

无。工具链已实测，设计决策已定（见 `design.md`）。
