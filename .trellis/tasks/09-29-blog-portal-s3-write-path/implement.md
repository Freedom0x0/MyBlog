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
- **复核抓到一个真实缺陷**：首发时间戳原本由 service「先读 `existing.publishedAt` 再决定要不要写」判定，两个并发首发都会读到 null，后提交者覆盖先提交者的首发时间。改法：service 只递交**候选**时间戳，repository 用 `published_at = coalesce(published_at, $n::timestamptz)` 在行锁内决定——与 B 阶段把"父评论是否同一篇文章"写进 insert 的 `where` 是同一个理由：**"读一次再分支"在两个并发写之间不成立，而这个判断本来就属于持有行锁的那条语句。**
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

## C · Markdown 导入端点（原"发布流水线"，形状已于 2026-09-29 按用户决定改）

CLI 方案作废的理由与取舍记在 design §3；这里只留可执行的清单。本阶段**只做后端**——导入的按钮在 D 阶段（前端那一刀本来就要动 `apiClient` 和编辑页）。

- [x] `packages/shared`：`ImportArticlesRequest`（`files: [{ name, markdown }]`）、`ImportArticleResult`（`kind: 'created' | 'conflict'`）、`ImportArticlesResponse`
- [x] `articles/schema.ts`：Zod 校验 + 契约漂移守卫（数组非空、长度上限、单篇与整批字节上限、`name` 长度与字符范围）
- [x] `articles/service.ts`：`importAll(files)` —— 先把**所有**文件过 `parseFixture`（任一无效就抛，一行不写），全通过后再逐篇调已有的 `create()`，且**把 status 强制成 draft**
- [x] 复用而非搬运：`parseFixture` 留在 `src/db/frontmatter.ts`，由 articles 模块 import。若觉得"db 目录里的东西被 service 引用"刺眼，就把它移到 `src/lib/`——但**只搬一次，别 copy**，S1 立它就是为了让两个阶段共用一份
- [x] `articles/routes.ts`：`POST /api/v1/articles/import`，`onRequest: [requireAdmin, requireCsrfHeader]`
- [x] ~~仓库根 `content/` 目录 + 示例文章~~ 取消：没有命令行同步就不需要它，`apps/api/fixtures/` 继续服务 seed 与测试
- [x] **`bodyLimit` 要显式决定**：Fastify 默认 1 MB，一批 markdown 很容易撞上去。超限时框架在 handler **之前**抛 `FST_ERR_CTP_BODY_TOO_LARGE`（`413`，已在 `fastify@5.12.5/lib/errors.js` 核对），**已经**被 `errorHandler.ts` 的 `CODE_BY_STATUS[413]` 翻译成 `PAYLOAD_TOO_LARGE`。（我上一版在这里写的"它和 DTO 的上限必须是同一个数"是**反的**：框架先执行、DTO 后执行，两者相等时框架永远先抢答，Zod 那条更有用的消息就永远不会出现。正确关系是 `bodyLimit` 明显**大于** DTO 各上限之和。）

**C 执行结论（已跑过的真账）**

- `bodyLimit` 用**路由级**选项（`fastify@5.12.5` 的 `types/route.d.ts:67` 核实 `RouteShorthandOptions` 有此字段而 `RouteOptions` extends 它），只给导入这一条路由，全站默认 1 MiB 不动。数值：单篇 128 KiB、整批正文 2 MiB、20 份、名字 255 字符 → DTO 允许的最大**内容**约 2.1 MiB，走线最坏约 **4.1 MiB**（JSON 转义把换行/引号/反斜杠每个 1 字节撑成 2 字节，只会变大不会变小），对 8 MiB 的路由上限仍有约 2 倍余量。**这条大小关系本身被变异验证过**：把 `bodyLimit` 降到与单篇上限相等，两条本该由 Zod 回答的测试变成 413 而红。
- 反向对照测试：往 `POST /api/v1/articles` 塞 2 MiB 仍得 413——证明"给导入放宽"没有顺手把别的端点也放宽（这是最容易偷偷发生的回归，用一条断言钉住）。
- **`toDraftInput` 里把解析结果再过一遍 `CreateArticleSchema`** 是实现者超出清单的一处添加，我核对后判定**必须保留**：`parseFixture` 只校验 front-matter 的**形状**，而 `articles` 表对 `excerpt`/`content_md` 没有长度或空值 check（`0001_portal_schema_v2.up.sql:23-45` 只有 `slug unique`、`read_time > 0`、status 相关与 `published_needs_timestamp`）。少了这一步，导入就是一个绕过 `POST /api/v1/articles` 字段边界的侧门——空 `excerpt`、空正文都能落库。做法是复用既有 DTO，没有新造第二套上限。
- 冲突只按 `error instanceof ApiError && error.code === slugConflict` 收集，其余重抛；变异"把所有 ApiError 都当冲突"只让那一条重抛测试变红。
- 计划里 `import.test.ts` 这个文件名与实际 `articles-import.test.ts` 不一致，按后者（与 `articles-write`/`comments-write` 同族命名）。design §1 的端点表缺导入这一行——我在"C 执行结论"里写了"已补"但**当时并没有真的补**，是复核阶段才实际加上的；design §3 的草图原本是裸数组，与实现的 `{ results }` 不符，也一并对齐。

**主控对复核三个待决点的定案**

- **`parseFixture` 不搬出 `src/db/`**。复核独立判定它不违反 architecture §1（该节禁的是 service 引用 `request` 或含 `SELECT`，这条是纯文本函数），搬迁要牵动 `seed.ts` 与 `frontmatter.test.ts` 的 import 才能消除一个目录名的观感问题。**明确不采纳**。
- **写批次中途的非冲突失败**（连接断、约束意外违反）→ 抛出、整批逐篇结果随之丢失，不回滚。理由与恢复路径写进 design §3.2：连接已不可信时发 200 等于谎称处理完整；重导同一批会以 `conflict` 逐篇报出而不会写出重复行，所以"再点一次"是安全补救。**D 阶段界面别把它做成静默重试。**
- **`storedRows([])` 加运行时报错**（已加）。这不是"给不可能的场景写校验"：一个测试助手在收到空列表时静默恒真，正是本项目"零匹配 grep 与什么都没扫的 grep 无法区分"那条规则要防的假绿。
- **复核自陈未验证的三项，归入后续**：并发导入同 slug 无导入层专门测试（依赖 A 阶段 `on conflict do nothing` 与 A 的并发测试）；`bodyLimit` 的 JSON 转义膨胀估算（最坏 4.1 MiB）是纸面算术，没有真发过 4 MiB 全转义请求；pg 驱动错误在导入 HTTP 层的擦除只有 M5 变异与代码推理，没有实际制造一次约束违反。三项都不是"已知坏了"，是"没测到"，S6/S7 补测试时优先捞回来。

### C 复核（2026-09-29，第二双眼睛，全部实跑变异）

- 上面"C 执行结论"里的每一条断言都经过再验证，全部成立：**边解析边写**变异 → 2 红（HTTP 行数哨兵 + 调用边界确定性哨兵）；给 `toDraftInput` 塞 `status` → `tsc` **编译期**就报 TS2353（结构性防线真实存在）；冲突收集放宽为"任何 ApiError" → 恰好 1 红（重抛测试）；`bodyLimit` 从路由级改为全局 8 MiB → 恰好 1 红（"别的端点仍守默认"对照测试）；`bodyLimit` 降到与单篇上限相等 → 恰好 2 红（与本文上面记录的数字一致）；errorHandler 透传 `error.code` → 7 红（413 与 400 两条路径都抓到）；第二次导入的 kind 断言反转成 created → 1 红；把 `shared` 的 `message` 改可选 → `tsc` 报在 `IMPORT_RESPONSE_MATCHES_CONTRACT` 那一行（守卫有效）；去掉 `CreateArticleSchema` 交叉校验 → 1 红（证明它是唯一的门，不是重复兜底）。
- 全量 api 套件 17 文件 / 197 测试全绿；跑完**实查库**：`ai-%` 文章行 0、`ai-%` 用户行 0、`articles` 总数回到 seed 的 7。变异逐条还原后复跑变绿。
- 修正两处文档与代码不符（点名）：**design §1 端点表此前并没有补上导入这一行**（上一段"已补"的说法不实，本次真的补上了）；design §3 草图的裸数组响应与实际 `{ results: [...] }` 不一致，已按实现定稿并写明理由。另把 `schema.ts` 里"DTO 最大约 2.1 MiB"的算术补上 JSON 转义膨胀（最坏 ~4.1 MiB），大小关系结论不变。
- 独立判定：`import { parseFixture } from '../../db/frontmatter.js'` **不违反** architecture §1 的原文（"service 不得碰 `request`、不得含 `SELECT`"——两者皆无，它是纯文本函数）；`db/` 目录归属只是历史位置的观感问题，若要消除，最小改法是 `git mv` 到 `src/lib/` 并同步 seed 与测试的两处 import。本轮不搬，交主控决定。
- 遗留观察（非缺陷）：阶段 2 写入中途若抛出**非冲突**错误（如数据库宕机），此前已写成的几篇会留在库里而整批响应是 4xx/5xx，逐篇结果丢失。**已定案**，理由与恢复路径写进 design §3.2——不回滚也不返回部分结果是对的（连接不可信时发 200 等于谎称处理完整），而重导同一批会把已写成的那些以 `conflict` 逐篇报出、不产生重复行，所以"再点一次"是安全补救。D 阶段界面**不得做成静默重试**。

**验证**（全部写成 `import.test.ts` 集成测试，人肉点界面不算）：

- 3 份合法 → 3 篇草稿出现，公开列表一篇都查不到
- 2 份合法 + 1 份缺 `title` → 400，且**库里文章总数不变**（"解析失败零写入"的唯一证明方式就是数一遍）
- front-matter 写 `status: published` 的一份 → 导入后 `status` 仍是 `draft`（R9 的正面证据）
- 同一份导入两次 → 第二次该篇 `kind: 'conflict'`，库里仍只有一条
- 反向权限：无凭证 401、普通用户 403、缺 CSRF 头 403
- 超限：单篇过大与份数过多各自 400/413，且都不落库
- 错误响应里不出现 `23505` / `23503` / 解析器抛的原始堆栈

---

## C2 · 内容起点（**不做搬迁**，2026-09-29 用户决定）

Supabase 里的既有文章直接废弃，不导出、不核对、不搬。因此 D 切换完成后，站点的真实内容数量是 **0**，第一篇必须来自编辑器手写或 C 的导入端点——这是决定的后果，不是缺陷，但要知道它长什么样：切完那天首页是空的。

- [ ] 定一下 `apps/api/fixtures/` 那些演示文章（`normal-published`、`draft-unpublished`、`backslashes` 等 7 篇）的处置：它们是 seed 与测试的数据来源，**不能删**；但生产环境不该有它们。`seed.ts` 已经拒绝在 `NODE_ENV=production` 下跑，所以只要部署流程里不调 seed 就没有泄漏——在 S8 的部署清单上记一笔"不要跑 seed"即可。

---

## D0 · 管理员读文章（S3-R20 ~ R22，D 的前置）

计划原稿的 A~G 里没有管理员读端点，导致草稿读不回来（理由见 prd 该段与 design §1.4）。这一段是补的，先做后端两条读端点，列表页随 D 一起做（它要用的写端点、导入按钮都在 D 里接）。

- [x] `packages/shared`：`AdminArticleSummary`（= `ArticleAdmin` 去掉 `content`）、`AdminArticlePage`（`data`/`next`/`limit`，与 `ArticlePage` 同构）
- [x] `articles/repository.ts`：`adminList({limit, cursor, status?})` —— **新写一条 SQL**，不要复用 `listPublished`：那条的名字就承诺了 `status = 'published'`，让它返回草稿是在撒谎。顺序 `updated_at desc, id desc`，游标键取 `updated_at` 的全精度文本（同 `LIST_COLUMNS` 对 `published_at` 的处理，理由也相同：给客户端的是毫秒，游标必须是微秒）
- [x] `articles/repository.ts`：`findBySlug` **已经是**"返回查到的任何东西、由 service 决定可见性"，所以 `GET /admin/articles/:slug` 直接复用它，不需要第三条 SQL
- [x] `articles/service.ts`：`listForAdmin(...)` 与 `getForAdmin(slug)`。后者查不到时 404 `ARTICLE_NOT_FOUND`——与公开路径同一个 code 同一个语义，管理员不需要从这里分辨"存在但是草稿"
- [x] `articles/routes.ts`：两条 `app.get`，`onRequest: [requireAdmin]`；**不挂 `requireCsrfHeader`**（那是写操作的要求，GET 带它只会让浏览器预检与将来的直链多一层无意义失败）
- [x] `articles/schema.ts`：`AdminArticleSummarySchema`/`AdminArticlePageSchema` + 两条 exported 漂移守卫，以及 `AdminListQuerySchema`（`limit` 上限照公开列表，`status` 用枚举）。（我原先在这条后面写的"非法值 400 而不是落到 SQL"理由是**错的**，实现时纠正：非法 `status` 是 WHERE 里的一个比较值，永远撞不到写入侧的 `check` 约束，真实后果是查出空集、返回 200 + `data: []`——一个骗人的"你没有归档文章"。400 这个行为保留，理由换成这个。）

**验证**（写成 `apps/api/src/test/admin-articles.test.ts`）：

- 库里同时有草稿与已发布时，管理员列表**两样都有**且带 `status`；公开列表仍只有已发布那一条（同一次运行里两个端点都查，才算对照）
- 草稿经 `GET /admin/articles/:slug` 返回 200 且 `status: 'draft'`、`publishedAt: null`；同一个 slug 走公开端点仍 404
- 顺序正确：改一篇旧的使其 `updated_at` 最新，它必须排到第一页第一行
- 游标翻页不重不漏：造 3 篇、`limit=2` 走两页，slug 集合等于 3 且无重复
- 反向权限：无凭证 401、已登录但非管理员 403；**非管理员即使带 CSRF 头也是 403**（证明守卫顺序没被人写反）
- `status` 传非法值 → 400 `BAD_REQUEST`，且响应里不含 `23514`/`check_constraint`
- 结构守卫沿用 A/B 那条：`select ... from articles` 的新增语句只出现在 `repository.ts`

**D0 执行结论（已跑过的真账）**

- 实际发出的 SQL 是被**包 `pool.query` 抓下来**的，不是照着源码想象的：无过滤时 `where true`，带游标时 `where true and (updated_at, id) < ($1::timestamptz, $2::uuid)`，顺序一律 `order by updated_at desc, id desc limit $n`。`true` 作为基条件是为了让"没有任何过滤条件"这个**默认情形**（管理员列表本来就要看全部状态）拼出来仍是合法 SQL。
- `updated_at` 在 `0001_portal_schema_v2.up.sql:40` 是 `not null`，所以顺序里不需要 `nulls` 修饰——这一点与公开列表相反，那边的 `published_at desc nulls last` 是逐字对齐索引表达式写出来的。
- **没有加新索引**，实现者独立同意 design §1.4 的判断并给了实测：当前计划是 `Limit → Sort → Seq Scan`（7 行），而 conventions §9 明说小表两种写法都会给出"看着对"的计划，所以这个实测**不构成**"不需要索引"的证据，它只是说明现阶段无从判断。它同时确认新写的 `ORDER BY` 已经是未来 `(updated_at desc, id desc)` 索引需要逐字匹配的形状。
- 三条易糊验证都做了变异：**对照**那条把 `listPublished` 的 `status = 'published'` 改成 `status <> 'draft'` → 1 红；**顺序**那条改成 `published_at desc nulls last` 或 `created_at desc, id desc` → 各 3 红；**守卫顺序**那条把 `requireAdmin` 换成 `requireCsrfHeader` → 21 红，加上 CSRF 一起挂 → 14 红（含专门测"管理员不带 CSRF 头也得放行"的那条）。另有两处更细的：游标改用发给客户端的毫秒值 → 1 红；行值比较里删掉 tie-breaker 的 `id`（语法完全合法、两个参数都绑上了）→ 红在 `seed row cjk-emoji: expected [] to have a length of 1`——**这一条证明翻页真的走过了 seed 那 7 行的并列组**，不是理论上的并列。
- `listForAdmin` 把 `list()` 那 8 行分页组装**复制**了一份而不是抽公共 helper，实现者主动报出来请我定。我判**保留**：两者的游标键一个是 `published_at` 一个是 `updated_at`，而 `list()` 带着"`published_at` 为 null 就是不变量被破坏"这个前提，管理路径必须不继承它——抽出来的泛型 helper 会让改动管理员分页有可能波及一个自 S1 起稳定的公开响应。8 行重复是这个判断的价格。
- 门禁：`-r lint` 0 错、`-r check` 0 错、`--filter api test` **18 文件 / 220 测试**（基线 17/197，+1 文件 +23 测试）。`-r build` 后真发了一次请求（不是只 import 模块）：列表 200 且含 `draft-unpublished`、详情 200 带 10 个字段、第二页与第一页不交、无凭证 401、`?status=nope` 400。库内残留 `ad-%` 文章与用户各 0，历史三套件各 0，`articles` 回到 seed 的 7。
- **给 D 的两个实况提示**：① seed 那 7 行的 `updated_at` 精确到微秒**完全相同**（`min = max = 2026-09-28T11:24:00.908386Z`），所以刚 seed 完的管理列表实际上是按 uuid 排的——界面别把"顺序看起来随机"当成 bug 去修；② 前端 `AdminArticleEditor.tsx:40` 用的确实是公开详情端点（`articlesApi.ts:36-43` 把 404 映射成 null），这就是"草稿变成空白表单"的机制，D 要改的就是这一行调用。
- 顺手记一笔与 D0 无关的仓库垃圾：`apps/api/undefined/temp/tsx-15532/` 有**两个已被提交**的 tsx 缓存文件（上次会话产物）。清理属 `git rm -r` + 一条 `.gitignore`，留给收尾一次性做，不在这里顺手改。

---

## D · 前端切换并脱离 Supabase ← 里程碑

- [ ] `apiClient`：`request<T>` 的方法联合扩到 `PATCH | DELETE`，CSRF 头覆盖所有写方法
- [ ] `articlesApi` 的 `upsertArticle` 改调 API；新增 `createArticle` / `deleteArticle`
- [ ] `commentsApi` 新增 `postComment` / `deleteComment`
- [ ] 管理页加"导入 Markdown"：`<input type="file" accept=".md" multiple>` → `File.text()` → `POST /api/v1/articles/import`（C 阶段的端点）→ 逐篇列出成功/冲突；冲突行给一个"覆盖"按钮，点了才发 `PATCH`。**导入后一律是草稿，界面上别放"导入并发布"**——那是 R9 想守住的那条线，加个按钮就会有人用它
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

**并且真点一遍界面**（R19 决定丢弃旧内容，所以切换后列表是空的——"空库能写出一篇可见文章"才是这个里程碑的真实验收）：清掉演示文章行，然后在管理页新建一篇 → 确认公开列表查不到 → 点发布 → 首页与详情页出现它 → 在详情页发一条评论 → 删掉它。每一步都要看到结果，不接受只看接口返回。

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

**为什么要做这一块**：`AdminArticleEditor.tsx:180` 现在的"封面图"是一个**手填 URL 的文本框**——图片必须已经在某个地方可访问。一个走正规接口的博客不该靠人粘贴外链：图床搬了文章就裂，而且粘贴外部 URL 是 XSS 与追踪像素的入口。F 的全部意义就是把这个文本框换成真正的上传。

- [ ] `POST /api/v1/uploads`（requireAdmin + CSRF）：入参 `contentType`/`size`
- [ ] 校验：MIME 白名单、大小上限、**魔数嗅探在签发之后由 API 复核**（客户端声明可以撒谎）
- [ ] key 由服务端随机生成，**绝不使用用户文件名**
- [ ] presigned PUT 60 秒有效、单 key、带 `content-length-range`
- [ ] 上传完成回调 `POST /api/v1/uploads/complete`：核实对象存在与真实类型，才返回可入库的 `publicUrl`
- [ ] 启动期确保桶存在（不假设桶已在）
- [ ] 前端：封面图字段旁加"上传"按钮（选文件 → 签发 → 直传 → 把返回的 `publicUrl` 填回字段）。字段仍可手填，不额外加限制——`cover_image` 只落在 `<img src>` 上，不是执行点

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
