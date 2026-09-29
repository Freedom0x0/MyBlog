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
PATCH  /api/v1/articles/:slug      requireAdmin   → 200 ArticleAdmin | 404 | 409
DELETE /api/v1/articles/:slug      requireAdmin   → 204 | 404
POST   /api/v1/articles/:slug/comments     requireAuth → 201 CommentNode | 404
DELETE /api/v1/comments/:id        requireAuth    → 204 | 403 | 404
POST   /api/v1/uploads             requireAdmin   → 200 {uploadUrl, publicUrl, key}
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

## 3. 发布流水线 `pnpm --filter api publish`

**复用 `src/db/frontmatter.ts`，不写第二个解析器**——S1 定格式时就说了它服务两个阶段。

```
读 content/*.md → 解析 → 逐篇：
  insert ... on conflict (slug) do update
    set title=..., content_md=..., category=..., tags=..., status=..., published_at=..., updated_at=now()
    where articles.content_md is distinct from excluded.content_md
       or articles.title        is distinct from excluded.title
       or ...
```

### 3.1 为什么用 `is distinct from` 而不是先查再比

先查再比是**读后写竞态**（两个进程同时跑会都判定"变了"），而且把比较逻辑放到应用层，将来每个写路径都要抄一遍。放在 SQL 里一条语句解决，且 NULL 语义正确（`cover_image` 可为 null）。

**可测的性质**：连跑两次，第二次**零行变更**，`updated_at` 不变。这是 S3-R9 的硬验收，也是"幂等"的真实含义——不是"跑两遍不报错"，而是"跑两遍等于跑一遍"。

### 3.2 安全边界

- `status` 默认 `draft`，除非 front-matter 明写 `published`（同步文件不该顺手发布）。
- 拒绝 `NODE_ENV=production` 裸跑；执行前打印**目标库主机**与受影响 slug 列表。
- 整个目录**一个事务**：半途失败不留"半套内容"。
- 不触碰 `is_admin`（S2 复核已因此修过 seed 一次，同样规则）。

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
| 创建时 slug 已存在 | 409 | `SLUG_CONFLICT` |
| 目标 slug 不存在 | 404 | `ARTICLE_NOT_FOUND` |
| `parentId` 属于另一篇文章 | 400 | `INVALID_COMMENT_PARENT` |
| 删他人评论（非管理员） | 403 | `FORBIDDEN` |
| 评论体空/超 4000 | 400 | `BAD_REQUEST` |
| 上传声明类型与内容不符 | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 上传超上限 | 413 | `PAYLOAD_TOO_LARGE` |
| 未登录写任意资源 | 401 | `UNAUTHORIZED` |
| 普通用户走管理端点 | 403 | `FORBIDDEN` |
| 响应中出现 `23505` 等驱动码 | — | **测试断言绝不出现** |

---

## 7. 权衡与风险

| 权衡 | 选择 | 代价 / 反悔条件 |
|---|---|---|
| 硬删除 vs 软删除 | 硬删除 | 无回收站；需要时加 `deleted_at` + 部分索引 |
| 403（评论）vs 404（草稿文章） | 分别处理 | 以后可能有人"统一"掉；注释写清理由 |
| presigned vs 中转 | presigned，spike 验证 | MinIO CORS 不通则换中转，显式记录 |
| 内容比对放 SQL | `is distinct from` | 需要 DB 方言支持（Postgres 有）；换库需重做 |
| 类型由魔数决定 | 是 | 多写几十行；比信任客户端声明便宜 |
| 幂等测试用 `updated_at` | 是 | 若将来加其他可变列，`where` 条件要同步扩，否则漏更新——**列清单集中在一处定义** |

**最大风险**：S3 一次动写路径 + 新基础设施（MinIO）+ 前端 + CLI 四件事，容易做成"每件事都半成品"。缓解：`implement.md` 按 A→G 顺序，**每阶段结束都跑一次全量闸并且可停靠**；MinIO 整块放最后（F），因为它对"脱离 Supabase"这个里程碑不是必需的——真要做不完，F 可以整块推到 S4 之后，而主目标仍然达成。
