# S0 技术设计

> 全局架构见父任务 `design.md`。本文只写 S0 需要定下的、父设计未覆盖的细节。

## 1. Workspace 布局

选 **pnpm workspace**（不用 npm workspaces）：pnpm 12.4.1 已装，且它的严格 `node_modules`（不提升幽灵依赖）本身就是一次值得学的教训——`apps/api` 无法 import 一个自己没有声明的包。

```
MyBlog/
├── pnpm-workspace.yaml        packages: ['apps/*', 'packages/*']
├── package.json               根：private，脚本转发到子包
├── pnpm-lock.yaml
├── tsconfig.base.json         共享编译选项，子包 extends
├── apps/
│   ├── web/                   ← 现有 Vite 应用整体迁入，内部逻辑不动
│   │   ├── src/ index.html vite.config.ts tailwind.config.js postcss.config.js
│   │   ├── eslint.config.js tsconfig.json public/ .env.example
│   │   └── package.json
│   └── api/                   ← 新建 Fastify
│       ├── src/ package.json tsconfig.json
│       └── vitest.config.ts
├── packages/
│   └── shared/                共享类型与 Zod schema（S0 先建立空壳 + 一个 smoke 类型）
├── infra/
│   ├── docker-compose.yml
│   └── .env.example
├── gateway/                   ← S5 创建（不在此处预建空目录：git 不跟踪空目录，
│                                 克隆后并不存在，留一个空壳只是假象）
└── .github/workflows/ci.yml
```

### 迁移策略（低风险优先）

`git mv` 整体搬运，**不改 `apps/web` 内部任何一行**。理由：重构与改逻辑混在一次提交里，出问题时无法定位是哪一类改动造成的。

搬完后必须验证的两条硬指标：

```bash
pnpm --filter web check    # tsc --noEmit
pnpm --filter web build    # vite build
```

### 需要处理的搬迁副作用

| 项 | 处理 |
|---|---|
| 根 `package.json` | 变为 workspace 根（`private: true`），原依赖移入 `apps/web/package.json` |
| 根 `package-lock.json` | 删除，改用 `pnpm-lock.yaml` |
| 根 `.env.example` | 拆两份：`apps/web/.env.example`（`VITE_*`）+ `infra/.env.example`（`POSTGRES_*`、`REDIS_*`） |
| 根 `vercel.json` | **保留但标记待改**：SPA rewrite 指向的 `/index.html` 现在位于 `apps/web/`。当前无生产部署，S4/S8 处理前端部署时一并修正 |
| `.vercelignore` | 同上 |
| 根 `eslint.config.js` | 移入 `apps/web/`；`apps/api` 用自己的 |

## 2. `apps/api` 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | node 22，**ESM**（`"type": "module"`） | 与前端一致；`pg` 与 `redis` 均支持 ESM |
| 框架 | Fastify 5 | 原生 pino、原生 JSON Schema 校验、原生请求 ID 支持 |
| 开发运行 | `tsx watch` | 无需编译步骤 |
| 构建 | `tsc` | 类型检查与产物一次完成 |
| 日志 | **Fastify 内置 pino**（不额外装 pino） | Fastify 的 logger 就是 pino。生产用 JSON 输出；开发用 `pino-pretty`（仅 devDependency） |
| 请求 ID | **Fastify 内置** `genReqId` + `requestIdHeader` | 原生能力，不自己写插件 |
| 校验 | Zod + `fastify-type-provider-zod` | 一处定义同时得到运行时校验与 TS 类型 |
| 数据库 | `pg`（裸 Pool） | 父设计已定：不用 ORM |
| Redis | `redis`（官方客户端） | 轻量，S0 只需 PING |
| 测试 | vitest | 与前端统一 |

### 目录

```
apps/api/src/
├── server.ts            listen + 优雅关闭（SIGTERM 时先停止接收新连接）
├── app.ts               组装 Fastify 实例（供测试直接 import，不 listen）
├── config/index.ts      Zod 解析环境变量，失败即抛
├── plugins/
│   ├── db.ts            pg Pool，decorate 到 fastify
│   ├── redis.ts         redis client，decorate 到 fastify
│   └── errorHandler.ts  统一错误契约
└── routes/health.ts     /health 与 /ready
```

**关键设计**：`app.ts` 与 `server.ts` 分离。`app.ts` 导出的是**未 listen 的 Fastify 实例**，测试用 `app.inject()` 直接打，无需真实端口。这是后续所有集成测试的基础。

## 3. 配置校验

```ts
// 环境变量 schema（S0 最小集）
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5175'),
})
```

**失败行为**：启动时解析失败 → 打印**每一个**缺失/非法的变量名与原因 → `process.exit(1)`。不静默降级、不延后到请求时才崩。

## 4. 健康检查语义

| 端点 | 语义 | 依赖检查 | 失败码 |
|---|---|---|---|
| `/health` | **存活**：进程还在跑就有意义 | **不检查**任何依赖 | 永不 503（除非进程死了） |
| `/ready` | **就绪**：能否接流量 | 检查 Postgres（`SELECT 1`）与 Redis（`PING`） | 任一失败 → 503 |

**为什么要分开**：这是负载均衡与容器编排的核心概念。把依赖检查放进 liveness，会让数据库短暂抖动导致容器被反复重启——一个真实且常见的生产事故。S0 就要把这个语义钉死，并在验收里用"停掉 Postgres"来证明两者确实不同。

`/ready` 响应体：

```json
{ "status": "ok", "checks": { "postgres": "ok", "redis": "ok" } }
```

## 5. 统一错误契约

```json
{ "error": { "code": "ARTICLE_NOT_FOUND", "message": "…", "requestId": "…" } }
```

- 由 `setErrorHandler` + `setNotFoundHandler` 统一产出；**路由内不得手写错误响应体**
- 捕获未知异常时：记录完整堆栈到日志，但**响应体只给通用信息**，不泄露内部细节
- 404 也走统一格式（Fastify 默认格式不符合契约，必须覆盖）

## 6. Docker 与 PATH

### Compose 服务（S0 只两个）

```yaml
services:
  postgres:   # postgres:17-alpine，端口 5432，健康检查 pg_isready
  redis:      # redis:7-alpine，端口 6379，健康检查 redis-cli ping
volumes:
  pgdata:
```

两者都配 `healthcheck`——S1 的集成测试与 S7 的编排都依赖它。

### PATH 问题的解法

`docker.exe` 在用户级安装路径下，Git Bash 不继承。三条路（择一，实现时确认）：

1. **推荐**：把 `C:\Users\15532\AppData\Local\Programs\DockerDesktop\resources\bin` 加入系统 PATH（一劳永逸，所有 shell 都能用）
2. 项目内加 `scripts/docker.sh` 包装（只解决本项目）
3. 每次手动 export（最差）

**倾向 1**，但它是修改用户环境、影响面超出本项目，需用户确认后执行。

## 7. CI

`.github/workflows/ci.yml`，单 job：

```
pnpm install --frozen-lockfile
pnpm -r lint
pnpm -r check        # tsc --noEmit
pnpm -r test
```

S0 不加 Postgres/Redis service container——本阶段没有集成测试。S1 引入集成测试时再加 service。

**缓存**：用 `actions/setup-node` 的 pnpm 缓存，避免每次重装。

## 8. 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| workspace 搬迁破坏现有前端构建 | 前端挂掉，违反 R1 | 搬迁与改逻辑**分成两次提交**；搬完立即跑 `web check` + `web build`；失败就 `git reset` 重来 |
| Docker 守护进程未启动 | 所有 compose 命令失败 | 前置检查：`docker info` 通了再继续；文档中写明需先启动 Docker Desktop |
| 前端与 api 的 TS 配置冲突 | 类型检查互相污染 | `tsconfig.base.json` 只放共享项；各子包显式声明自己的 `include`/`lib`（前端要 DOM，后端不要） |
| ESM/CJS 互操作坑 | 启动即报错 | `apps/api` 全程 ESM 且依赖均支持 ESM；不引入 CJS-only 包 |

**回滚点**：搬迁前打 tag `pre-s0`。S0 全程只做加法与搬运，不改前端逻辑，因此回滚成本极低。
