# S0 执行计划

> 设计见 `design.md`，需求与验收见 `prd.md`。
> **执行顺序经过排序：高风险的搬运先做且独立验证，低风险的加建后做。** 这样任何一步失败，回滚范围都是最小的。

---

## 前置检查（做任何事之前）

- [ ] Docker 守护进程已运行：`docker info` 能返回 ServerVersion
  - 未运行则先启动 Docker Desktop，等守护进程就绪
  - 若 `docker` 命令本身找不到 → 先解决 PATH 问题（见 `design.md` §6），**此项需用户确认后再改系统 PATH**
- [ ] `git status` 干净，或已知的未提交内容已确认
- [ ] **打回滚标签**：`git tag pre-s0`

---

## A · workspace 重构（高风险，先做）

**目标**：仓库变成 pnpm workspace，现有前端构建仍通过。**不改 `apps/web` 内部任何逻辑。**

- [ ] 建 `apps/`、`packages/`、`infra/` 目录
- [ ] 建 `pnpm-workspace.yaml`：`packages: ['apps/*', 'packages/*']`
- [ ] 建 `tsconfig.base.json`：只放共享编译项，**不放 `lib`/`include`**（前后端要的 `lib` 不同）
- [ ] `git mv` 现有前端资产进 `apps/web/`：
  `src/`、`index.html`、`vite.config.ts`、`tsconfig.json`、`tailwind.config.js`、`postcss.config.js`、`eslint.config.js`、`public/`、`assets` 相关
- [ ] 原根 `package.json` 的依赖与脚本移入 `apps/web/package.json`
- [ ] 根 `package.json` 改为 workspace 根：`private: true`，脚本转发（`pnpm -r` 或 `--filter`）
- [ ] 删除 `package-lock.json`，`pnpm install` 生成 `pnpm-lock.yaml`
- [ ] 拆分 `.env.example`：`apps/web/.env.example`（`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`）+ `infra/.env.example`（`POSTGRES_*`、`REDIS_*`）
- [ ] `vercel.json` / `.vercelignore` 原地保留并**加注释标记待改**（当前无生产部署，S4/S8 处理）
- [ ] 建 `packages/shared`：`package.json` + 一个 smoke 导出（验证 workspace 链接真的生效）
- [ ] **先建 `apps/api` 的最小 `package.json`**，否则 `pnpm install` 时 workspace 只有一个包，链接问题会被推迟暴露

**验证（必须全绿才进入 B）**：

```bash
pnpm install
pnpm --filter web check        # tsc --noEmit
pnpm --filter web build        # vite build
pnpm --filter web dev          # 手动打开 http://127.0.0.1:5175 确认页面正常
```

**回滚点**：`git reset --hard pre-s0`（本步未改前端逻辑，回滚无损失）

> ⚠️ `apps/web` 内部**一行都不改**。如果为了迁就 workspace 而必须改，把那次改动单独成一个提交，便于区分。

---

## B · 基础设施 Compose

- [ ] `infra/docker-compose.yml`：`postgres:17-alpine` + `redis:7-alpine`
- [ ] 两个服务都配 `healthcheck`（`pg_isready` / `redis-cli ping`）
- [ ] Postgres 命名卷 `pgdata`
- [ ] `infra/.env.example` 提供变量，`.env` 不入库（确认 `.gitignore` 覆盖 `infra/.env`）

**验证**：

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps      # 两个服务均为 healthy
# 连通性
docker compose -f infra/docker-compose.yml exec postgres psql -U postgres -c 'select 1'
docker compose -f infra/docker-compose.yml exec redis redis-cli ping
```

**回滚点**：`docker compose down -v` 即可，无残留。

---

## C · API 骨架

- [ ] `apps/api` 初始化：`type: module`、Fastify 5、`tsx`、`typescript`、`vitest`
- [ ] `src/app.ts`：组装 Fastify 实例并返回，**不 listen**（测试用 `inject`）
- [ ] `src/server.ts`：引用 `app.ts`、listen、注册优雅关闭（SIGTERM → `app.close()` 后退出）
- [ ] `src/config/index.ts`：Zod 解析环境变量，失败打印**全部**问题后 `process.exit(1)`
- [ ] 日志：Fastify `logger` 配 pino（生产 JSON；开发 `pino-pretty` 仅 devDependency）
- [ ] 请求 ID：用 Fastify 原生 `genReqId` + `requestIdHeader: 'x-request-id'`，**不自己写插件**
- [ ] `src/plugins/db.ts`：`pg` Pool，decorate 到 fastify，`onClose` 时 `pool.end()`
- [ ] `src/plugins/redis.ts`：`redis` client，decorate 到 fastify，`onClose` 时 `quit()`
- [ ] `apps/api/tsconfig.json`：extends base，`lib` **不含 DOM**，`module`/`moduleResolution` 配 ESM

**验证**：

```bash
pnpm --filter api build
# 故意漏掉 DATABASE_URL 启动，期望：打印缺失项名并退出（非堆栈崩溃）
```

---

## D · 健康检查与统一错误契约

- [ ] `src/routes/health.ts`：`/health`（**不查依赖**）与 `/ready`（查 Postgres `SELECT 1` + Redis `PING`，任一失败返回 503）
- [ ] `/ready` 响应体：`{ status, checks: { postgres, redis } }`
- [ ] `src/plugins/errorHandler.ts`：`setErrorHandler` + `setNotFoundHandler`
- [ ] 错误体统一为 `{ error: { code, message, requestId } }`
- [ ] 未知异常：完整堆栈进日志，响应体只给通用信息
- [ ] 404 也走统一格式（覆盖 Fastify 默认）
- [ ] 确认路由内**没有任何**手写的错误响应体

**验证（这是本阶段最关键的一组）**：

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm --filter api dev

curl -i localhost:3001/health                      # 200
curl -i localhost:3001/ready                       # 200，体含 postgres/redis 均为 ok
curl -i localhost:3001/does-not-exist              # 404 且符合统一契约

# 语义分离证明：停掉 Postgres
docker compose -f infra/docker-compose.yml stop postgres
curl -i localhost:3001/ready                       # 期望 503
curl -i localhost:3001/health                      # 期望仍为 200  ← 关键
docker compose -f infra/docker-compose.yml start postgres

# 请求 ID 贯穿：外部传入应被沿用
curl -s -H 'x-request-id: test-123' localhost:3001/does-not-exist   # 响应体 requestId 应为 test-123
# 且日志中同一请求的 id 一致
```

---

## E · CI

- [ ] `.github/workflows/ci.yml`：node 22 + pnpm，启用 pnpm 缓存
- [ ] 步骤：`pnpm install --frozen-lockfile` → `pnpm -r lint` → `pnpm -r check` → `pnpm -r test`
- [ ] 确认 `apps/web` 原有 lint/check/test 脚本被 `-r` 正确覆盖
- [ ] **不加** Postgres/Redis service container（S0 无集成测试，S1 再加）

**验证**：推一个 PR，确认 CI 绿灯。若本地无法验证 CI，至少在本地跑一遍完全相同的命令序列。

---

## F · 后端 spec 起步

- [ ] 建 `.trellis/spec/backend/index.md`（**英文**，遵循 `.trellis/spec/frontend/index.md` 的语言约定）
- [ ] 写入分层纪律：`routes → service → repository` 的依赖方向、各层禁区
- [ ] 写入 `app.ts` / `server.ts` 分离的约定及理由
- [ ] 写入健康检查语义（`/health` vs `/ready` 的区分与理由）
- [ ] 记入 `.trellis/spec/guides/` 的索引（若该处需要登记）

---

## 最终验证清单（全部通过才算 S0 完成）

```bash
# 1. 前端未被破坏
pnpm install && pnpm --filter web check && pnpm --filter web build

# 2. 基础设施
docker compose -f infra/docker-compose.yml up -d && docker compose -f infra/docker-compose.yml ps

# 3. API
pnpm --filter api build && pnpm --filter api test
curl -i localhost:3001/health     # 200
curl -i localhost:3001/ready      # 200

# 4. 语义分离（关键验收）
docker compose -f infra/docker-compose.yml stop postgres
curl -i localhost:3001/ready      # 503
curl -i localhost:3001/health     # 200
docker compose -f infra/docker-compose.yml start postgres

# 5. CI
# PR 上绿灯
```

- [ ] 打阶段标签：`git tag s0-done`
- [ ] 更新父任务 `implement.md` 中 S0 的状态（若需要）

---

## 完成状态（2026-09-24）

A–F 全部完成并通过验证：

| 验证 | 结果 |
|---|---|
| `pnpm -r lint` | ✅ |
| `pnpm -r check` | ✅ |
| `pnpm -r --if-present test` | ✅ 16 passed / 3 files |
| `pnpm --filter api build` | ✅ 产物不含测试文件 |
| `pnpm --filter web build` | ✅ 3943 modules |
| `node dist/server.js`（无配置） | ✅ 退出 1，列出全部缺失变量 |
| Compose 两服务 healthy | ✅ PostgreSQL 17.11 / Redis PONG |
| 停 Postgres → `/ready` 503 而 `/health` 200 | ✅ 实测 |
| Redis 不可达 → 进程照常启动、`/ready` 503（0.34s） | ✅ 实测 |
| 外部 `x-request-id` 贯穿日志与响应体 | ✅ 实测 |

## 独立复核发现并已修复的问题

复核代理（`trellis-check`）报告了 5 项，其中 3 项确认为真缺陷，均已修复并补测试：

| # | 问题 | 修复 |
|---|---|---|
| 1 | 🔴 5xx 会转发 `error.code`，泄露 Postgres SQLSTATE（`23505`）与 Fastify 内部码（`FST_ERR_*`） | 引入 `ApiError`；5xx 一律 `INTERNAL_ERROR`，4xx 走状态码映射表；补 3 个测试（其中一个专门抛带 `.code` 的错误） |
| 2 | 🔴 Redis 连不上会阻止启动，并以 `AVV_ERR_PLUGIN_EXEC_TIMEOUT` 未捕获拒绝收场；与 pg 的惰性连接不对称 | 首连不 await；`disableOfflineQueue` + 有界 `connectTimeout`；`main()` 加 `.catch()` |
| 3 | 🟠 `CORS_ORIGIN` 已声明但无任何消费方 | 移除（等 S1 装 CORS 插件时一并加回） |
| 4 | 🟠 空的 `gateway/` 目录克隆后不存在 | 删除；改在 S5 创建 |
| 5 | 🟡 `authStore` 自造的 `User` 接口缺 `app_metadata` | **未修，交接给 S2**（见下） |

## 交接给后续阶段的事项

| 事项 | 归属 | 说明 |
|---|---|---|
| `authStore` 的 `User` 接口与 SDK 的 `User` 重复，且缺 `app_metadata` | **S2** | `app_metadata` 正是 D1 修复要用的字段。S2 重做管理员判定时应直接改用 `@supabase/supabase-js` 的 `User` 类型，否则会在安全相关路径上重新引入刚被清掉的 `as any` 模式 |
| `packages/shared` 的构建策略未定 | **S1** | 目前只被 api 导入**类型**，编译时擦除，`rootDir` 无冲突。一旦导出运行时值需在「shared 产出 dist」与「TS project references」间选一条 |
| `server.ts` 的 SIGTERM 优雅关闭无法在 Windows 验证 | **S8** | Windows 无 POSIX 信号，`taskkill` 只能强杀。只能在 Linux 容器里验 |
| Redis 重连日志无节制 | **S6** | 每次重试记一条 error，长时间故障会刷屏。属可观测性问题 |
| 跨平台换行符策略（`.gitattributes` 加 `* text=auto eol=lf`） | 未分配 | 当前不影响；会重写全仓库换行符，应作为独立改动并由用户决定 |

## 完成后需要用户确认的事

- [ ] **是否将 Docker 目录加入系统 PATH**：`C:\Users\15532\AppData\Local\Programs\DockerDesktop\resources\bin`。这是修改用户环境的操作，需明确授权
- [ ] 跨平台换行符策略是否要统一处理
- [ ] S1 是否立即开始（建 S1 子任务）
