# S3 技术设计

> 需求见 `prd.md`。全局设计见父任务 `design.md`；分层/迁移/索引/CI 纪律见 `.trellis/spec/backend/`。

---

## 0. 先说约束：这是"写完但不能上线"的阶段

S3 之后前端只跟自建 API 说话，而 API 只在 localhost。所以：

- 分支不合 `main`，PR #1 保持草稿，直到 S8 有可访问的 API 部署。
- CI 必须继续绿，因为它是本阶段唯一的自动把关（生产部署帮不上忙）。

---

## 1. 写作 API 契约

```
POST   /api/v1/articles            requireAdmin   → 201 ArticleAdmin
POST   /api/v1/articles/import     requireAdmin + requireCsrfHeader, 路由级 bodyLimit 8 MiB
                                                    → 200 ImportArticlesResponse | 400 | 413
PATCH  /api/v1/articles/:slug      requireAdmin   → 200 ArticleAdmin | 404 | 409
DELETE /api/v1/articles/:slug      requireAdmin   → 204 | 404
POST   /api/v1/articles/:slug/comments     requireAuth → 201 CommentNode | 404
DELETE /api/v1/comments/:id        requireAuth    → 204 | 403 | 404
POST   /api/v1/uploads             requireAdmin   → 200 {uploadUrl, publicUrl, key}
GET    /api/v1/admin/articles      requireAdmin   → 200 AdminArticlePage（含草稿，无正文）
GET    /api/v1/admin/articles/:slug requireAdmin  → 200 ArticleAdmin | 404
```

`ArticleAdmin` = `ArticleDetail` 加 `status`、`updatedAt`（管理视图需要看见草稿；**公开端点永不返回 draft**，沿用 S1 的 `findPublished`）。

### 1.1 状态流转规则

| 转换 | 规则 | 由谁保证 |
|---|---|---|
| 创建 | 一律 `draft`，忽略客户端传来的 status | service（防"创建即发布"的误操作） |
| `draft → published` | 必须写 `published_at`；已有则不覆盖（首发时间不变） | service + DB check |
| `published → draft` | 保留 `published_at`（它记录"曾经发布"），不擦除 | service |
| 任何 | 不得出现 `published` 且 `published_at is null` | **数据库约束**（S1 建），非应用自觉 |

### 1.2 slug 冲突：把 SQLSTATE 挡在契约外

创建走 `insert ... on conflict do nothing returning id`，无行则说明撞了 → 抛 `ApiError(SLUG_CONFLICT, 409)`。

**这里必须复用 S0/S1 的错误约定**：Postgres 的 `23505` 绝不能出现在响应里（它描述的是数据库约束，且会让客户端依赖驱动细节）。测试要断言响应体不含 `23505`——这条与 `CODE_BY_STATUS` 的擦除规则是一套的。

### 1.3 改 slug 不孤儿化评论（D10 的证明）

`PATCH` 允许改 slug；评论挂在 `article_id` 上，因此改 slug 不影响可见性。
**测试**：发布 → 评论 → 改 slug → 用新 slug 查详情与评论，两者都必须非空。**这条测试的价值在于它会失败**：老结构用 `article_slug` 文本关联，同样的改动会静默丢掉所有评论，且没有任何约束报错。

---

### 1.4 管理员读端点（S3-R20 ~ R22，2026-09-29 补）

A/B/C 三段建的是写路径，读路径全在 S1 且只服务已发布内容。于是草稿能创建、能改、能删，**却读不回来**：`AdminArticleEditor` 加载已有文章用的是公开详情端点，草稿一律 404，页面于是显示成一张空白新建表单。补两条读端点，都不与公开读共用 SQL：

| 端点 | 守卫 | 返回 |
|---|---|---|
| `GET /api/v1/admin/articles` | `requireAdmin` | `AdminArticlePage`：所有状态、按 `updated_at desc, id desc`、**不含正文** |
| `GET /api/v1/admin/articles/:slug` | `requireAdmin` | `ArticleAdmin`：含正文与 `status`，草稿可读 |

三条设计决定：

- **顺序按"最近改动"，不按发布时间。** 管理员要找回刚存的那篇草稿，而草稿的 `published_at` 是 null——若沿用公开列表的 `published_at desc nulls last`，所有草稿会被挤到最后一堆、彼此按 uuid 随机排列，等于没有顺序。
- **不给公开端点加 `?includeDraft`。** 那等于把"草稿对谁可见"交给请求方开关；可见性必须是**授权**判断，只能挂在新端点的 `requireAdmin` 上。公开端点继续只认 `findPublished`。
- **暂时不为此加新索引。** `articles_list_keyset` 服务的是公开顺序，`updated_at` 上没有任何索引，所以管理员列表目前是一次顺序扫描加排序。个人博客的文章数量在几十到几百的量级，这个成本可以接受；**去除条件**：当列表页明显变慢时加 `create index articles_admin_list_keyset on articles (updated_at desc, id desc)`，并且按 conventions §9 的要求——`ORDER BY` 与索引表达式逐字对齐，且在几千行的临时库里用 `EXPLAIN` 证明它真被用上，而不是在 7 行表上看一个"看着对"的计划。

**`updatedAt` 的可空性**：`ArticleAdmin.updatedAt` 目前是必填 `string`，而管理列表要把每行的"最后更新"显示出来。这条不阻塞（写路径已经把它读进 `ArticleRecord`），但要求 `adminList` 的投影显式包含 `to_char(updated_at ...)`，别用 `published_at` 的游标键凑数。

---

## 2. 评论权限

```
POST comment   : 需登录；parentId 存在时必须属于同一 article_id，否则 400
                 （否则可以给别人的文章挂一棵树，或用 IDOR 探测他文评论）
DELETE comment : 作者本人 → 204；管理员 → 204；其他人 → 403
                 不存在 → 404
```

**403 而不是 404 是这里的刻意选择，与文章的 draft 用 404 相反**：评论 ID 是 UUID，不可枚举；而"这条存在但你不能删"对已登录用户是正常反馈，不泄露敏感事实。文章 draft 用 404 是因为 slug 可猜测且"是否存在的草稿"本身就是要保护的信息。**同一个项目里两种答案，理由不同——注释必须写清，否则以后会被"统一"掉。**

关闭 D8 的权限半边：S0 时管理员无法删他人评论（RLS 只允许 `auth.uid() = user_id`）。

---

## 3. Markdown 导入 `POST /api/v1/articles/import`

> 原设计是 `pnpm --filter api publish` 命令行同步 `content/*.md`。2026-09-29 用户否决了
> "需要记命令行的发布方式"——写作入口只留编辑器和文件导入。本节按新形状重写，
> 并把因此作废的取舍留在原处说明，免得以后有人以为它是被"统一"掉的。

```
前端 <input type="file" accept=".md" multiple>
  → 每份 File.text()
  → POST /api/v1/articles/import { files: [{ name, markdown }] }
  → 服务端逐份 parseFixture：任一无效 → 400，一行不写
  → 全通过后逐篇 articles.service.create()（强制 draft）
  → 返回 { results: [{ name, kind: 'created' | 'conflict' }, ...] }
```

> 响应形状定稿为 `{ results: [...] }` 包装对象而非裸数组（实现时的决定，2026-09-29 复核确认）：
> 与本 API 其余列表响应（`ArticlePage`/`CommentList`/`TagList`）同构，且将来可在不改响应类型的前提下
> 增补计数字段。冲突条目**不开新错误码**——HTTP 仍是 200（见 §6）。

**为什么解析放服务端**：`parseFixture` 住在 `apps/api/src/db/`，而 `apps/web` 不依赖 api 包。前端要解析只能把它搬去 `packages/shared`，那时校验就有两条路径，**前端那条可以绕过**——改一改请求体就能塞进解析器拒绝过的数据。放在服务端还顺带继承了 A 阶段 `service.create` 的写入规则（状态、`updated_at`、`published_at` 的 `coalesce`），而不是另开一条绕过它的写路。一条写库的路被两个入口共用，这才是它可信的原因。

### 3.1 作废的设计：`is distinct from` 条件更新

原方案要"连跑两次零变更、`updated_at` 不动"，因为命令行同步的前提是"文件是真相、库是投影，所以要能反复重放"。导入不是重放：每次点导入都是一个人刚做的决定，"这篇内容变了没有"由人自己判断，不需要 SQL 替他判断。条件更新语句因此不写。

**仍然保留的性质**：并发导入同一 slug 仍恰好成功一次——A 阶段 `insertDraft` 的 `on conflict (slug) do nothing` 已经保证，不靠先查再写。

### 3.2 安全边界

- **一律 `draft`**，front-matter 的 `status` 仍参与格式校验（值必须合法）但不参与决定；`published` 也建草稿（R9）。
- `requireAdmin` + `requireCsrfHeader`，与其余写端点同源。
- 大小上限有三个层次，数值以实现为准：单篇 128 KiB、整批正文 2 MiB、份数 20，另有一条**路由级** `bodyLimit` 8 MiB 兜在最外面。上限不是防"文章太大"——markdown 是纯文本，128 KiB 对一篇博客已经荒谬地够用；它防的是把手按在选文件框上一次性送进几百份。`bodyLimit` 必须明显大于 DTO 允许的最大 body（含 JSON 转义膨胀），否则框架的 413 会抢在 Zod 那条说得出"哪一份、超了多少"的消息之前回答。
- 解析失败零写入（R11）。写阶段中途的**冲突**不整批回滚：逐篇报告比"整批失败后人工猜是哪份坏了"更好用，而单条 insert 本来就是原子的。
- 写阶段中途的**非冲突失败**（连接断、意外约束违反）→ 直接抛出，整批响应是 4xx/5xx，**已写成的那几篇不回滚，逐篇结果随之丢失**。定案而非疏漏：连接已经不可信，这时还返回 200 就是谎称请求被完整处理了。恢复路径是安全的——重导同一批时已落库的那些会以 `kind: 'conflict'` 逐篇报出，不会写出重复行（`insertDraft` 的 `on conflict do nothing`），所以"再点一次"这个最朴素的补救不产生垃圾。代价记在明处：D 阶段的界面**不能把它做成静默重试**，要让人看见"这次失败了，已写进去的会以下次导入的冲突形式出现"。
- 不触碰 `is_admin`——这条与 seed 同源（S2 复核就是为此改过 seed 一次）。
- 浏览器只能选到用户手动挑中的文件，读不到目录，也就无从"误同步整个项目"；R11 原来那条"拒绝在 production 裸跑、打印目标库主机"随 CLI 一并作废——导入永远经过一个已经连好库的服务端进程，没有"连错库"这个入口。

---

## 4. 对象存储与 presigned 直传

### 4.1 为什么是 presigned 而不是经 API 中转

| | presigned 直传 | API 中转 |
|---|---|---|
| 文件字节 | 浏览器 → MinIO | 浏览器 → API → MinIO |
| 大文件 | API 不缓冲 | API 内存/超时受文件大小支配 |
| 依赖 | 需给 MinIO 配 CORS | 需 `@fastify/multipart` |
| 学到 | 签名 URL、有效期、CORS 边界 | multipart 流式处理 |

选 presigned（生产形态，且是本项目的学习目标）。**但有一个 spike**：MinIO 的浏览器 CORS 若配不通，就退回 API 中转——**两个方案都写在这里，退回时显式记录，不悄悄换**。

### 4.2 key 与校验

```
key 形态：uploads/<yyyy>/<mm>/<random32hex>.<ext-from-sniffed-type>
```

- **绝不用用户提供的文件名**：`../../etc/passwd`、`a.svg`（可含脚本）、同名覆盖他人对象，全都来自信任这个名字。
- 扩展名由**内容嗅探**决定，不由请求声明决定：客户端可以声明 `image/png` 而传 SVG/HTML。**先看魔数再决定存成什么**（PNG/JPEG/GIF/WebP 魔数在应用层判，几百行内）。
- 大小上限在**签发时**就用 `content-length-range` 条件钉住，而不是等上传完再拒绝。
- URL 有效期短（60 秒），且一次签一个 key（不可复用）。

### 4.3 桶与访问

- `portal-media`，公开只读（博客图片要能直接被 `<img>` 引），写只走 presigned PUT。
- Compose 加 `minio` + healthcheck + 卷 + `MINIO_API_CORS_ALLOW_ORIGIN`。
- 一个启动期确保桶存在的步骤（不假设桶已在）。

---

## 5. 前端与 apiClient

- `apiClient` 的 `request<T>` 方法联合类型扩到 `PATCH | DELETE`；CSRF 头对所有写方法都要带（不只 POST）——**这一点容易漏**，`PATCH`/`DELETE` 与 `POST` 同级。
- 删除 S2 的"写入迁移中"提示，恢复评论表单与删除按钮。
- 移除 `lib/supabase.ts`、卸载 `@supabase/supabase-js`。
- 编辑器改为写自建 API；`AdminArticleEditor` 与 `ArticleDetail` 的乐观本地保存（`localStorage` 兜底）**要重新审视**：静默本地覆盖会让用户以为已发布。至少要给出明确的成功/失败状态。

---

## 6. 校验与错误矩阵（新增部分）

| 条件 | 状态 | `code` |
|---|---|---|
| 导入批次中任一份 front-matter 非法 | 400 | `BAD_REQUEST`（消息里带文件名与解析器原话） |
| 导入请求体超上限 | 413 | `PAYLOAD_TOO_LARGE` |
| 导入时某篇 slug 已存在 | 200（该篇 `kind: 'conflict'`） | 不开新 code：其余篇可能已写成，HTTP 状态说的是这一**批**被接受了，冲突是逐篇数据 |
| 创建时 slug 已存在 | 409 | `SLUG_CONFLICT` |
| 目标 slug 不存在 | 404 | `ARTICLE_NOT_FOUND` |
| `parentId` 属于另一篇文章 | 400 | `INVALID_COMMENT_PARENT` |
| 评论 id 不存在（含被父线程 cascade 掉） | 404 | `NOT_FOUND` |
| 删他人评论（非管理员） | 403 | `FORBIDDEN` |
| 评论体空/超 4000 | 400 | `BAD_REQUEST` |
| 上传声明类型与内容不符 | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 上传超上限 | 413 | `PAYLOAD_TOO_LARGE` |
| 未登录写任意资源 | 401 | `UNAUTHORIZED` |
| 普通用户走管理端点 | 403 | `FORBIDDEN` |
| 响应中出现 `23505` 等驱动码 | — | **测试断言绝不出现** |

**评论 404 用通用 `NOT_FOUND`，不是 `ARTICLE_NOT_FOUND`，也不新增 `COMMENT_NOT_FOUND`**：`ARTICLE_NOT_FOUND` 承载的是"这个可猜的 slug 背后有没有一篇未发布的草稿"这个秘密（§2），评论 id 是不可枚举的 uuid，没有要藏的 secrets，所以状态码 404 本身就是完整答案，通用 code 足够。没有为评论单开 code，是因为没有调用方需要按它分支——将来若真出现该需求再开，别提前塞进词汇表。**别把它和 `ARTICLE_NOT_FOUND` "统一"**：两者的 code 不同恰恰是 §2 那套存在性探测理由的延续。

---

## 7. 权衡与风险

| 权衡 | 选择 | 代价 / 反悔条件 |
|---|---|---|
| 硬删除 vs 软删除 | 硬删除 | 无回收站；需要时加 `deleted_at` + 部分索引 |
| 403（评论）vs 404（草稿文章） | 分别处理 | 以后可能有人"统一"掉；注释写清理由 |
| presigned vs 中转 | presigned，spike 验证 | MinIO CORS 不通则换中转，显式记录 |
| 类型由魔数决定 | 是 | 多写几十行；比信任客户端声明便宜 |
| 导入用端点而非 CLI | 端点（用户决定） | 失去"重放同步整个目录"；若将来真要 git→库 的自动同步，那是独立任务而非本阶段的回归 |
| 解析在服务端 | 是 | 请求体是原文，边界上必须再加一层体积校验；换来的是"只有一条写库的路" |

**最大风险**：S3 一次动写路径 + 新基础设施（MinIO）+ 前端三件事，容易做成"每件事都半成品"。缓解：`implement.md` 按 A→G 顺序，**每阶段结束都跑一次全量闸并且可停靠**；MinIO 整块放最后（F），因为它对"脱离 Supabase"这个里程碑不是必需的——真要做不完，F 可以整块推到 S4 之后，而主目标仍然达成。
