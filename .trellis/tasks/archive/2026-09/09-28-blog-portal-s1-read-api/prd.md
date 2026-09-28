# S1 · 数据层与文章读 API

> 父任务：`.trellis/tasks/09-24-blog-production-backend`（架构与阶段地图见其 `design.md` / `implement.md`）
>
> 本文只写 S1 自身的需求与验收。

## Goal

建立自建后端的**数据层**与**公开浏览所需的读取 API**，并把前端的读路径从 Supabase SDK 切换过来。

**本阶段只做 GET**：写入路径（发文章、发/删评论）留到 S3，鉴权留到 S2。

## 已决策：不导 Supabase 数据

**S1 全程本地闭环**，不从 Supabase 导入那 4 篇演示文章。

理由：导入需要你提供连接串与密码，且依赖 Docker 出网到 `db.<ref>.supabase.co:5432`——而数据本身是脚手架生成的占位内容，S3 之后发布路径本来要改成 markdown 文件流水线。**让纯本地的学习目标去依赖凭据与网络，不成立。**

**但那 4 篇数据有一个价值必须保留**：它们含长 markdown、CJK、代码块和 ASCII 单引号——**正是让迁移 04 翻车的内容形状**。因此本任务改为**刻意构造同等强度的夹具**，而不是碰巧依赖真实数据：

- 含 ASCII 单引号的代码示例（`name: 'demo'` 这类）
- 含 `$md$` 字样的正文（检验美元引号标签冲突）
- CJK 与 emoji 混排
- 超长正文（> 50 kB）
- 含反斜杠、null 字节敏感字符

**硬性验收：这些夹具经迁移写入后读回必须与源文件逐字节一致。**

## 需求

### 数据层

- **S1-R1 · 迁移工具链**：`apps/api/migrations/` 下的**手写 SQL** 迁移，配 up / down / create 命令，不引入 ORM。
- **S1-R2 · Schema v2**：重建 `users` / `articles` / `comments`，并在本次顺带修掉三项既有缺陷：
  - **D9** `status`（draft/published/archived）+ `published_at`
  - **D10** `comments.article_id` 外键取代 `article_slug` 字符串关联
  - **D8** `comments.parent_id` 自引用外键（本轮只建 schema，UI 在 S4）
  - `tags` 保持 `text[]` + GIN 索引，**不改关联表**
- **S1-R3 · 视图与索引**：列表查询走覆盖索引，`EXPLAIN` 证明分页查询命中索引而非全表扫。
- **S1-R4 · 夹具**：`apps/api/fixtures/*.md`（front-matter + 正文）。**夹具文件格式即 S3 发布流水线的输入格式**，一处设计服务两个阶段。

### 读 API

- **S1-R5 · 分层**：`routes → service → repository`，依赖只能向下。`service` 不得出现 `request`/`reply`，`repository` 不得含业务规则。
- **S1-R6 · DTO 校验**：Zod schema 作为查询参数与响应契约的**唯一定义源**，经 `fastify-type-provider-zod` 接到路由，消除"运行时校验 + 手写类型"两份维护。
- **S1-R7 · 游标分页**：`?limit=&cursor=`，不用 offset（学 offset 在大表下的退化）。
- **S1-R8 · 端点**：
  - `GET /api/v1/articles`（分页 + 标签/分类过滤 + 只返回 published）
  - `GET /api/v1/articles/:slug`
  - `GET /api/v1/articles/:slug/comments`
  - `GET /api/v1/tags` 与 `GET /api/v1/tags/:tag`（补 D6 与归档导航的后端能力）
- **S1-R9 · 错误契约**：沿用 S0 的统一 envelope；`code` 必须是本 API 自己的词汇（`ApiError`），不得转发驱动或框架码。

### 前端切换

- **S1-R10 · 读路径切换**：`apps/web` 的文章列表、文章详情、评论读取改调自建 API，不再使用 `@supabase/supabase-js` 的 `from()`。
- **S1-R11 · 修掉启动阻塞**：`apps/web/src/lib/supabase.ts` 在模块顶层 `throw`，导致**缺凭据时整个 bundle 加载失败**。改为惰性单例——只有真正调用鉴权时才需要凭据。这样本地无 Supabase 凭据也能浏览站点。

## 验收标准

### 数据层

- [ ] `migrate:up` 建出 schema；**`migrate:down` 能干净回滚到空库**（每个迁移都必须有可执行的 down）
- [ ] 重复执行 `migrate:up` 不报错（幂等）
- [ ] 五类危险夹具全部**逐字节读回一致**（含 `'`、含 `$md$`、CJK、>50kB、反斜杠）
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` 证明分页列表查询走索引；输出记录进任务笔记

### 读 API

- [ ] 四个端点各有集成测试，跑真实 Fastify + 真实本地 Postgres
- [ ] 非法 `limit`（0、负数、非数字、超上限）→ 400，`code` 属于本项目词汇表
- [ ] 不存在的 slug → 404 `ARTICLE_NOT_FOUND`
- [ ] `draft` 状态的文章**不出现**在任何公开列表与详情响应中
- [ ] `GET /api/v1/articles` 全链路不出现 `select *`（只取列表页需要的列，正文只在详情返回）
- [ ] CI 中有 Postgres service container，集成测试在 CI 上跑通

### 前端

- [ ] `grep` 证实 `apps/web/src` 的读路径无 `supabase.from(`（写路径与鉴权允许保留）
- [ ] **本地无 Supabase 凭据时应用能启动并渲染首页**——这是对 S1-R11 的直接检验
- [ ] `pnpm -r lint` / `check` / `test` / `build` 全通过（不回退 S0 基线）

## 已知限制（明确写出，不再用"构建通过"冒充"可访问"）

**本环境没有浏览器，无法验证渲染正确性。** S1 能做到的是：构建通过、模块加载不抛错、API 契约有集成测试。真正的渲染与交互验证**依赖 S4 的 Playwright**。

上一轮我用 dev server 的 HTTP 200 冒充"门户可访问"，而应用其实因缺凭据在加载期就抛异常——**这个错误不再重复**。因此 S1 对"可访问"的检验下移到 S1-R11 那条具体的启动断言。

## 需要先做的去风险验证

**S1 第一个动作是 spike，不是写业务代码。**

`fastify-type-provider-zod@7` + `zod@4` + `fastify@5` 的组合**从未在本仓库实际用过**（S0 只装了没用）。若这个组合的路由类型推断不成立，`S1-R6` 整条设计要换方案（退回 Fastify 原生 JSON Schema + 手写类型，或换校验库）。

**必须先写一个最小路由验证三件事**：查询参数能被 Zod 校验、响应类型能推断、错误能落到统一 envelope。跑通再写其余端点。

## 不在范围内

- 任何写端点（文章创建/更新/删除、评论增删）→ S3
- 鉴权、权限中间件、`users.is_admin` → S2
- Next.js 迁移、SSR、评论嵌套 UI → S4
- 从 Supabase 导入历史数据 → 已明确不做；若将来要，单开任务
- 缓存、限流 → S6
