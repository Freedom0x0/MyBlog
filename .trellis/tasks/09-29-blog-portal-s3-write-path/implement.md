# S3 执行计划

> 契约见 `design.md`。**每阶段结束都跑全量闸并打标签**——本阶段跨四件事，"随时可停"比前几个阶段更重要。
>
> 纪律（已在规范里，此处按条执行）：验证必须**中止**动作而不是打印；改内容与提交不放同一命令块；结构守卫要带对照断言；迁移/SQL 必须执行而非阅读；索引/幂等性质要用规模或重复运行证明。

---

## 前置

- [ ] `git tag pre-s3`
- [ ] `pnpm infra:up`；库已迁移到 0003 且 seed 过
- [ ] **确认约束**：`feat/s0-foundation` 不合 `main`（见 prd 前置认知）

---

## A · 文章写 API

- [x] `shared` 加 `ArticleAdmin`、`CreateArticleInput`、`UpdateArticleInput` 接口；api 侧 Zod schema + **编译期漂移守卫**（沿用 `*_MATCHES_CONTRACT` 模式）
- [x] `modules/articles/repository.ts` 加 `insertDraft`（`on conflict do nothing`）、`updateBySlug`、`deleteBySlug`
- [x] `service.ts` 加创建/更新/删除 + 状态流转规则；**只有 `update` 能改 status**，创建恒 `draft`
- [x] `routes.ts` 三个端点挂 `requireAdmin`
- [x] `PATCH` 的 CSRF 头要求（**别只给 POST 加**，design §5 点过这个坑）
- [x] 错误码新增 `SLUG_CONFLICT`、`INVALID_COMMENT_PARENT`

**验证（每条都要真跑）**：

```bash
# 创建→列表不可见→发布→可见→更新→删除
pnpm --filter api test -- articles-write
# 关键证明：改 slug 不丢评论（老结构下这条会失败）
# 并发同 slug 创建：恰好一个 201，其余 409，且响应不含 23505
```

- [x] **反向测试**：无凭证 401、普通用户 403（这条同时补上 S2 记录的"requireAdmin 端到端 403 缺覆盖"缺口）

### A 执行结论（已跑过的真账，不是计划）

- 全量闸：`pnpm -r test` **153 passed（147 基线 + 6 新增）**、`-r lint`、`-r check` 全绿。阶段 A 共 22 条集成测试。
- **复核抓到一个真实缺陷**：首发时间戳原本由 service「先读 `existing.publishedAt` 再决定要不要写」判定，两个并发首发都会读到 null，后提交者覆盖先提交者的首发时间。改法：service 只递交**候选**时间戳，repository 用 `published_at = coalesce(published_at, $n::timestamptz)` 在行锁内决定——与 §3.1 用 `is distinct from` 把比较下推进 SQL 是同一个理由。
  **推广到 B–G**：任何「先查再分支写」都是读后写竞态。判断条件属于 SQL 的（是否为空、是否变化、是否冲突），一律下推，不要在应用层读一遍再决定。
- 新增并发**改 slug**测试（S3-R3 的延伸，原计划漏了）：恰好一个 200、一个 409 `SLUG_CONFLICT`，且败方仍持有原 slug。
- 变异检验做过两次：把 schema 字段改错类型 → 两个 `*_MATCHES_CONTRACT` 如期编译失败；回退 coalesce 修复 → repository 层的固定时间戳测试确定性失败。**注意**：HTTP 层的并发首发测试在缺陷代码上会因为同一毫秒而侥幸通过，所以它只是哨兵，确定性证明放在 repository 层用固定时间戳的那条——写并发测试时别把这种测试当证据。
- 环境事实：本机 `pnpm` shim 指向不存在的 `…\.tools\pnpm\12.4.1\`（真实目录带 `_tmp_102640_0` 后缀，疑似安装中断）。本轮所有验证经 `node C:/Users/15532/AppData/Local/pnpm/.tools/pnpm/12.4.1_tmp_102640_0/node_modules/pnpm/bin/pnpm.mjs` 执行。**属环境问题，与本轮代码无关，待单独修复**。
- `pnpm --filter api test -- articles-write` 的**位置参数在本项目 vitest 配置下不起过滤作用**，实际跑的是 api 全量（15 文件）。上面记录的数字按真实执行情况写的，没有按"只跑了 articles-write"记账。

> **A 完成即打 `s3-a`**。若后续做不完，A+B 已经是"写路径可用"的最小闭环。

---

## B · 评论写/删与权限

- [x] `modules/comments/repository.ts` 加 `insert`、`findById`、`deleteById`（计划里写的是 `findAuthor`，实现改成 `findById` 更好：一条语句同时定存在性(404)与作者(403)，省掉第二次读，也就没有两次读之间的 TOCTOU）
- [x] service：`parentId` 必须同文章；创建后返回**完整 CommentNode**（含 join 出的 author），前端不再自己拼
- [x] delete：作者或管理员；分别 204 / 403 / 404
- [x] 集成测试：作者删自己 ✓、删他人 403、管理员删任意 ✓、不存在 404、跨文章 parentId 400
- [x] **注释写清为什么评论用 403 而草稿文章用 404**（design §2），否则以后会被"统一"掉

### B 执行结论（已跑过的真账，不是计划）

- 全量闸：`pnpm -r test` **176 passed（153 基线 + 23 新增）**、`-r lint`、`-r check` 全绿。阶段 B 新增 23 条集成测试（`comments-write.test.ts`）。
- **约束名经 `pg_constraint` 实测核对，非推断**：`repository.ts` catch 分支匹配的 `comments_parent_id_fkey`（→ comments）、`comments_user_id_fkey`（→ users）、`comments_article_id_fkey`（→ articles）三者与库中 `conname` 逐条对得上（这些 FK 都是内联 `references` 未显式命名，Postgres 自动命名即 `<表>_<列>_fkey`）。测试文件断言的 `comments_content_check`、`no_self_reply` 也核对无误。三条翻译分支里：`comments_article_id_fkey`（`article_missing`）在 repository 层用"删文章再插"确定性命中；`comments_user_id_fkey`（`author_missing`）经 HTTP"注销账号仍持有效 token"命中——`requireAuth` 只验签与 denylist、不查用户行是否存在，所以请求确实下到 insert，不是被 401 短路；`comments_parent_id_fkey` 无法被任何 fixture 调度（需要父行在本语句快照之后、自身 FK 检查之前消失），故**有意不测**，可观测的父问题（跨文章、不存在的 uuid）由 guard 走 `invalid_parent` 覆盖。
- **`insert … select … where` 的形状判定：保留**。`$3::uuid is null or exists(...)` 中 parentId 传 JS `null` 时 `$3::uuid` 即 NULL、`NULL is null` 为真 → 无条件插入（无数根评论的既有测试即为证）。四个参数 `$1::uuid,$2::uuid,$3::uuid,$4::text` 全显式 cast，`insert…select` 无法像 `insert…values` 那样从目标列反推参数类型，漏一个就是 `could not determine data type of parameter $n`（代码注释已钉住这点）。新行从写 CTE 别名 `i` 读回而非 base 表 `comments`（数据修改型 CTE 的外层查询看到的是语句起始快照，join base 表会匹配不到自己刚插的行——注释记了这是实测结论）。更直白的替代都被否掉：`on conflict` 需要冲突目标且表达不了"父在另一篇文章"；`select … for update` 锁父行是把 guard 与写拆成两条语句、重新打开竞态窗口且更啰嗦。现写法的代价就是上面两条 cast/别名纪律，均已落在注释里。
- **变异检验全部重做并还原复跑**（承接 A 立的"不信任何'应该会被抓到'"规矩）：去掉 `and p.article_id = $1::uuid` → `refuses a parentId on another article` 与 `an error response carries the envelope` 两条红；把管理员分支改成 `if (!isAuthor)` → `lets an administrator delete another user's comment` 红；`CreateCommentSchema.content` 改 `z.number()` → `tsc` 在 `schema.ts` 的 `CREATE_MATCHES_CONTRACT` 报 `Type 'true' is not assignable to type 'false'`（且下游 routes 连带报错）；两条结构守卫分别植入越层 SQL 验证：B 守卫在 `comments/service.ts` 植入 `insert into comments` 即红，A 守卫在 `articles/service.ts` 植入 `update articles` 即红——确认 B 守卫的 pattern 覆盖 insert/update/delete 三种写法、不止 insert。每次还原后 `pnpm -r test` 复跑回到 176 全绿。
- **测试残留已核**：跑完后 `cw-%` 的 articles/users/comments 在库里均为 0。清理按 slug 删文章（cascade 带走评论）+ 按 `github_login like 'cw-%'` 扫用户，前缀与 A 的 `aw-%` 互不重叠（`aw_users_intact` 查询确认 A 用户未被 B 的清理误伤，反之亦然），无唯一键冲突。
- **判定：`request.auth!` 两处非空断言保留**。唯一站得住的理由是：`onRequest: [requireAuth, requireCsrfHeader]` 里 `requireAuth` 已经 `request.auth = auth`，同一个路由声明块的 handler 必然看得到已赋值的上下文，而 `AuthContext` 在接口上是可选字段，`!` 只消解 nullability、不会把类型退化成 `any`。替代方案都不成立：让 `requireAuth` 返回上下文在 Fastify 的 `onRequest` 机制下无法注入 handler；为这两个端点专门收窄 handler 类型是过度工程；加一句 `if (auth === undefined) throw` 是给不可能的状态写错误处理。**规范并没有为生产代码的类型断言开绿灯**——复核初稿曾引 `conventions §4` 的 `as never` 那条作为依据，那是**测试**里替换 `Pool` 的代价，与这里无关，属误引；`eslint` 也没开 `no-non-null-assertion`，所以这条靠的是注释讲清前提，而不是靠某条许可。
- **错误矩阵逐条对得上**（本轮补齐 design §6 缺失的一行）：400 `INVALID_COMMENT_PARENT`（跨文章/不存在父）、403 `FORBIDDEN`（他人评论非管理员）、400 `BAD_REQUEST`（空/超 4000，走同一 Zod 失败路径）、401 `UNAUTHORIZED`（无凭证、注销账号）均有断言 `code` 的真测试；评论不存在 → 404 `NOT_FOUND` 亦断 `code`。design §6 原表没给评论 404 的 code，已在该表补一行并加脚注说明"评论 404 用通用 `NOT_FOUND`、既不用 `ARTICLE_NOT_FOUND` 也不新造 `COMMENT_NOT_FOUND`"的理由（uuid 不可枚举、无存在性 secrets），防止以后被和草稿文章的 404 "统一"。

---

## C · 发布流水线

- [ ] `src/db/publish.ts`：复用 `frontmatter.ts`，读 `content/*.md`
- [ ] 单事务；条件更新用 `is distinct from`；不触碰 `is_admin`
- [ ] 默认 `draft`；显式 `status: published` 才发布
- [ ] production 下拒绝裸跑；先打印目标库主机与 slug 列表
- [ ] 仓库根建 `content/` 目录 + 一篇真实示例文章（取代演示内容的位置）

**验证（幂等的真实含义）**：

```bash
pnpm --filter api publish
# 记录 articles 的 updated_at 与内容哈希
pnpm --filter api publish
# 断言：第二次零行变更，updated_at 完全不变
```

- [ ] 断言写成测试（`publish.test.ts`），不是人肉比对输出

---

## D · 前端切换并脱离 Supabase ← 里程碑

- [ ] `apiClient`：`request<T>` 的方法联合扩到 `PATCH | DELETE`，CSRF 头覆盖所有写方法
- [ ] `articlesApi` 的 `upsertArticle` 改调 API；新增 `createArticle` / `deleteArticle`
- [ ] `commentsApi` 新增 `postComment` / `deleteComment`
- [ ] 撤销 S2 的只读降级：恢复评论表单与删除按钮；管理员可见删除他人评论
- [ ] `AdminArticleEditor` / `ArticleDetail` 的 `localStorage` 兜底**重新审视**：静默本地"保存成功"会让人误以为已发布（design §5 点明）
- [ ] 删 `apps/web/src/lib/supabase.ts`；`pnpm --filter web remove @supabase/supabase-js`

**验证**：

```bash
grep -rniE "supabase" apps/web/src || echo "✓ 前端零 Supabase"
grep -c "supabase" apps/web/package.json   # 期望 0
pnpm -r lint check build && pnpm -r --if-present test
git tag s3-detached-from-supabase          # 里程碑标签
```

---

## E · 存储 spike（**先验证再写功能**）

**目标**：确认浏览器能否直传 MinIO（CORS）。这是 design §4.1 的未证事实。

- [ ] Compose 加 `minio`（healthcheck、卷、`MINIO_API_CORS_ALLOW_ORIGIN`）
- [ ] 起服务、建公开只读桶、签一个 PUT、**从浏览器同源策略的角度实测**一次跨源 PUT
- [ ] **判定并写回本文末尾**：
  - CORS 可行 → 走 presigned（下一步继续）
  - 不通 → 退回 API 中转（加 `@fastify/multipart`），并**在此处记录退回理由**，不许悄悄换

> 这一步的结论会决定 F 的形状，所以必须先做。

---

## F · 图片上传

- [ ] `POST /api/v1/uploads`（requireAdmin + CSRF）：入参 `contentType`/`size`
- [ ] 校验：MIME 白名单、大小上限、**魔数嗅探在签发之后由 API 复核**（客户端声明可以撒谎）
- [ ] key 由服务端随机生成，**绝不使用用户文件名**
- [ ] presigned PUT 60 秒有效、单 key、带 `content-length-range`
- [ ] 上传完成回调 `POST /api/v1/uploads/complete`：核实对象存在与真实类型，才返回可入库的 `publicUrl`
- [ ] 启动期确保桶存在（不假设桶已在）

**验证**：

```bash
pnpm --filter api test -- uploads
# 必测：声明 image/png 实为 SVG → 415；超限 → 413；
#      文件名含 ../ → key 里不出现用户输入；未登录 → 401；普通用户 → 403
# 断言响应体不含 MinIO 凭据或服务端内部路径
```

---

## G · 安全收口

- [ ] 所有写端点补齐**反向授权测试**（缺头、无凭证、非管理员、跨作者）
- [ ] 错误响应抽查：不含 `23505`、不含 SQL、不含服务端路径
- [ ] 若 F 做了 API 中转：确认请求体有上限，否则一个请求能打满内存（**这是新增攻击面**）
- [ ] 契约守卫：新 DTO 都有 `*_MATCHES_CONTRACT`
- [ ] CI：MinIO 若被测试依赖，加进 services；确认 `env -u` 步骤仍然只剥该剥的变量
- [ ] 逐条过 OWASP **写操作**相关项（CSRF、越权、上传校验、资源限制），结论写回本文件

---

## 收尾

- [ ] 更新 prd 的验收勾选，未做的照实标注
- [ ] `supabase/migrations/` 加"已停用"说明（保留历史，不误导后来者）
- [ ] 在父任务 `implement.md` 标记 S3 完成，并记下 **S3 遗留缺口**：无限流(S6)、图片无处理管线/EXIF 未清、无软删除
- [ ] `git tag s3-done`

---

## SPIKE-E 结论（执行时填写）

待填：CORS 是否可行、最终选了 presigned 还是 API 中转、理由。

## OWASP 写操作清单结论（执行时填写）

待填。
