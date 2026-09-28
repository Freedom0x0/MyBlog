# S1 技术设计

> 需求见 `prd.md`。全局架构见父任务 `design.md`。

---

## 0. 两个必须先跑的 spike

设计里有两处**我无法靠推理确定**的地方。它们会决定后续代码的形态，所以先验证再写，而不是写完发现方向错。

### SPIKE-1 · Zod 类型提供器是否真的可用

`fastify-type-provider-zod@7` + `zod@4` + `fastify@5` 在本仓库**从未实际用过**（S0 只装未用）。写一个最小路由，验证三点：

1. 查询参数能被 Zod 校验并自动拒绝非法值
2. handler 的参数与返回值类型能推断出来（不是 `any`）
3. 校验失败时错误**落进 S0 的统一 envelope**，而不是 Fastify 默认格式

**若不成立**：退回 Fastify 原生 JSON Schema（Ajv 校验 + `fast-json-stringify` 序列化，性能更好但类型要另写），或换 provider 版本。**在结论出来前不写第二个端点。**

### SPIKE-2 · `packages/shared` 如何被两个消费方使用

S1 让 shared 第一次承载真实内容。这里有个已知但未解的结构性问题：`apps/api` 的 `tsconfig` 设了 `rootDir: src`，**一旦 shared 导出运行时值（如 Zod schema 对象）并被 api 在运行时 import，就会触发"文件不在 rootDir 下"**。S0 只 import 类型，编译期擦除，所以没暴露。

三条候选，实测后择一：

| 方案 | 做法 | 代价 |
|---|---|---|
| a | shared 产出自己的 `dist`，两个消费方引构建产物 | 类型检查依赖构建顺序（`pnpm -r` 拓扑排序能解，但编辑器体验绕） |
| b | TS project references（`composite` + `tsc -b`） | 正统解，配置多；与 Vite 需要额外对齐 |
| c | shared 保持**仅类型**（接口），Zod schema 留在 api | 最省事，但**契约会在两侧各写一份，可能静默漂移**——这恰恰削弱 R4 |

**倾向 a 或 b，不接受 c**（c 等于放弃"契约只有一处定义"这个学价值）。

---

## 1. 目录结构

```
apps/api/
├── migrations/                 node-pg-migrate 的手写 SQL
│   └── 1700000000001_init_v2.sql (+ .down 同名反向)
├── fixtures/                   ← 夹具 markdown（front-matter + 正文）
│   ├── hostile-quotes.md        含 name: 'demo' 这类 ASCII 单引号
│   ├── dollar-tag-collision.md  正文含字面 $md$ / $sql$
│   ├── cjk-emoji.md             CJK + emoji 混排
│   └── oversized.md             > 50 kB
├── src/
│   ├── db/seed.ts              读 fixtures 灌库（幂等）
│   ├── modules/
│   │   ├── articles/{schema,repository,service,routes}.ts
│   │   ├── comments/{...}.ts
│   │   └── tags/{...}.ts
│   ├── lib/pagination.ts       游标编解码
│   ├── app.ts  server.ts  config/  plugins/  errors.ts
│   └── test/                   集成测试（真实 Fastify + 真实 Postgres）
└── vitest.config.ts
```

**fixtures 的格式就是 S3 发布流水线的输入格式**——一份设计服务两个阶段，且夹具不再是"用完即扔的测试数据"。

---

## 2. 数据层

### 2.1 迁移工具链

`node-pg-migrate` + **纯 SQL 文件**，不引入 ORM。理由见父设计 §2.2：ORM 会藏掉本项目要学的执行计划、索引命中、N+1、事务隔离。

```jsonc
// apps/api/package.json
"scripts": {
  "migrate:up":   "node-pg-migrate up   -m migrations -j none",
  "migrate:down": "node-pg-migrate down -m migrations -j none --count all",
  "migrate:create": "node-pg-migrate create -m migrations",
  "seed": "tsx src/db/seed.ts"
}
```

`-j none` = 保持 SQL 文件而非 JS 文件——**迁移就是 SQL，逼你写 down**。

### 2.2 Schema v2（含相对现状的变更）

```sql
create table users (
  id           uuid primary key,
  github_login text not null unique,
  display_name text,
  avatar_url   text,
  is_admin     boolean not null default false,   -- S1 建列不读；D1 的最终归宿在 S2
  created_at   timestamptz not null default now()
);

create table articles (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  title        text not null,
  excerpt      text not null,
  content_md   text not null,
  category     text not null,
  tags         text[] not null default '{}',
  cover_image  text,
  read_time    int not null default 5 check (read_time > 0),
  status       text not null default 'draft'
               check (status in ('draft','published','archived')),
  published_at timestamptz,
  views        int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- 不变式放进数据库，而不是靠应用代码自觉
  constraint published_needs_timestamp
    check (status <> 'published' or published_at is not null)
);

create table comments (
  id         uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete cascade,  -- D10
  user_id    uuid not null references users(id) on delete cascade,
  parent_id  uuid references comments(id) on delete cascade,           -- D8
  content    text not null check (length(content) between 1 and 4000), -- 此前无任何长度约束
  created_at timestamptz not null default now(),
  constraint no_self_reply check (parent_id is null or parent_id <> id)
);

create index articles_list_keyset   on articles (status, published_at desc nulls last, id desc);
create index articles_tags_gin      on articles using gin (tags);
create index articles_category      on articles (category);
create index comments_article_time  on comments (article_id, created_at desc);
create index comments_parent        on comments (parent_id);
```

### 2.3 相对现状的取舍

| 变更 | 为什么 |
|---|---|
| **删掉** `comments.user_name` / `avatar_url` | 现状是插入时从 JWT 拍的快照，**用户在 GitHub 改名后历史评论仍显示旧名**。有了 `users` 外键就 join 取最新值 |
| `tags` 保持 `text[]` + GIN | 几十个标签的量级，关联表是纯多余复杂度 |
| 长度校验放 DB `check` | 老库的 `content` 无上限、无频率限制，可被刷 |
| `views` 列先建不用 | 计数逻辑属 S6；列先占位避免将来再加 |
| `is_admin` 列先建不用 | 同上，S2 读它 |

---

## 3. 游标分页

**不用 offset**：`limit 10 offset 10000` 仍要扫过并丢弃一万行；游标是索引直接 seek。

游标是**不透明**的（客户端不该解析它，这样将来能换编码而不破坏调用方）：

```ts
// {p: publishedAt ISO 字符串, i: id} → base64url(JSON)
encodeCursor({ p: '2026-09-28T10:00:00Z', i: 'uuid' })
```

keyset 条件用**行值比较**（Postgres 原生支持，比手写 `(a<x) OR (a=x AND b<y)` 不易错）：

```sql
where status = 'published'
  and (published_at, id) < ($1, $2)
order by published_at desc nulls last, id desc
limit $3
```

**边界情形必须在测试里覆盖**：缺省 cursor、非法 cursor（→ 400 `INVALID_CURSOR`，不是 500）、末页返回 `next: null`。

---

## 4. API 契约

### 4.1 命名约定（一个真实的跨层陷阱）

| 层 | 命名 | 例 |
|---|---|---|
| Postgres | snake_case | `content_md`, `published_at` |
| 领域对象 | camelCase | `contentMd`, `publishedAt` |
| API 响应 | camelCase | `content`, `publishedAt` |

**映射只发生在 repository**（行 → 领域）和**序列化**（领域 → 响应）两处。中间的 service 只见 camelCase。若让 snake_case 漏进 service 或响应，就是跨层边界 bug 的典型来源。

### 4.2 端点

```
GET /api/v1/articles
  query: limit?  (1..50, 默认 10)
         cursor? (不透明)
         tag?     category?
  200: { data: ArticleSummary[], next: { cursor: string } | null, limit: number }

GET /api/v1/articles/:slug
  200: ArticleDetail (= ArticleSummary + content)
  404: ARTICLE_NOT_FOUND

GET /api/v1/articles/:slug/comments
  200: { data: Comment[] }   // 平铺 + parentId，由客户端组树
  404: ARTICLE_NOT_FOUND

GET /api/v1/tags
  200: { data: { tag: string, count: number }[] }

GET /api/v1/tags/:tag
  200: 同 GET /api/v1/articles
```

`ArticleSummary`：`{ slug, title, excerpt, category, tags, coverImage, readTime, publishedAt }`
`Comment`：`{ id, articleId, parentId, content, author: { login, displayName, avatarUrl }, createdAt }`

**返回树还是平铺**：选择**平铺 + `parentId`，客户端组树**。理由：评论嵌套层数浅（2–3 层），递归 CTE 或两次查询换服务端建树的收益，抵不上客户端一次 O(n) 聚合的简单。将来若要"折叠深层回复"再改。

### 4.3 校验与错误矩阵

| 条件 | 状态 | `code` |
|---|---|---|
| `limit` 为 0 / 负 / 非数字 / >50 | 400 | `BAD_REQUEST` |
| `cursor` 无法解码 | 400 | `INVALID_CURSOR` |
| `status` 参数试图读 draft | 400 | `BAD_REQUEST`（公开端点不接受状态参数） |
| slug 不存在**或**非 published | 404 | `ARTICLE_NOT_FOUND` |
| DB 连接失败 | 500 | `INTERNAL_ERROR`（详情只进日志） |

**draft 不可见是一条必须测的安全边界**：详情端点遇到 draft 也返回 404，而不是 403——不给攻击者"这篇文章存在"的信息。

---

## 5. 前端切换

- `apps/web/src/utils/articlesApi.ts` 重写为 `fetch` 自建 API，base URL 取 `import.meta.env.VITE_API_BASE_URL`，默认 `http://localhost:3001/api/v1`
- 类型来自 `packages/shared`（见 SPIKE-2）
- **`lib/supabase.ts` 改惰性单例**：现状是模块顶层 `throw`，缺凭据时整个 bundle 加载失败，首页直接白屏。改成首次真正使用鉴权时才初始化。**这条与 S1 的读路径切换是配套的**——否则读路径不依赖 Supabase 了，应用还是打不开。

---

## 6. 测试

| 层 | 内容 |
|---|---|
| 单元 | `pagination` 游标编解码往返、非法输入；`tags` 排序 |
| 集成 | 真实 Fastify + 真实 Postgres，逐端点跑 4.3 的错误矩阵；**夹具逐字节读回一致** |
| CI | 加 Postgres service container（Redis 暂不需要，本阶段无缓存） |

**集成测试需要真实库**，这是 S0 就预告过的：CI 从这一步起要有 `services: postgres`，测试库用独立连接串，不碰开发库。

---

## 7. 风险

| 风险 | 应对 |
|---|---|
| SPIKE-1 不成立，routes 全要换方案 | 先 spike 再写第二个端点；失败即改设计，不硬推 |
| SPIKE-2 选错，shared 变成第三份手工维护的契约 | 明确不接受方案 c；宁可先只在 api 内部用 Zod，也不在两侧各写一份 |
| 迁移不可回滚（忘写 down） | 父任务纪律：**无 down 的迁移不予合入**；验收要求 down 能回到空库 |
| 游标编码泄露内部实现 | 游标必须 base64url 不透明；测试断言客户端无需解析 |
| 夹具"太干净"，测不出引号问题 | 五类危险内容写进验收，逐字节比对，不接受"看着差不多" |
