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

**2026-09-29 拆成两刀**（拆的理由不是"太多"，是中间状态必须可用）：D-1 只把**传输层与写路径**换掉并断开 Supabase——做完它，"保存草稿 / 发布 / 改正文"这三件事在界面上都真的能用；D-2 才补**缺失的入口**（列表页、评论表单、导入按钮）。若不分刀，D 的中途会出现"发布功能彻底不可用"的窗口，而那是个倒退，因为 Supabase 时代是能发布的。

### D-1 · 传输层与写路径（先做，做完即达里程碑）

- [x] `apiClient`：`request<T>` 的方法联合扩到 `PATCH | DELETE`，**并补上请求体**——今天的 `request` 根本没有 body 参数，`apiPost(path)` 只能发空体（`authApi.ts:25` 的 logout 是它唯一的现有调用方，恰好不需要 body，所以这个洞一直没暴露）。CSRF 头必须覆盖全部四种写方法，不只 POST
- [x] `articlesApi`：删掉 snake_case 的 `ArticleRecord` 与 `upsertArticle`，换成 `createArticle(CreateArticleInput)` / `updateArticle(slug, UpdateArticleInput)` / `deleteArticle(slug)` / `listAdminArticles()` / `getAdminArticle(slug)`。**两个现有调用点必须一起改**（`AdminArticleEditor.tsx:67`、`ArticleDetail.tsx:104`），否则 `check` 不过
- [x] `commentsApi`：加 `postComment(slug, CreateCommentInput)` 与 `deleteComment(id)`。D-2 才接界面，但函数在这一刀就位，别让 D-2 顺手改传输层
- [x] 编辑器：加载已有文章改走 `getAdminArticle`（草稿读得回来了，这是 D0 存在的意义），"保存"= 新建走 POST 落草稿 / 已存在走 PATCH 且**不带 status**；另给一个独立的**发布**按钮走 `PATCH {status:'published'}`。**不做"导入并发布"**这类合并动作
- [x] `ArticleDetail`：删掉本地那个 `Article` interface（它写着 `coverImage: string` 非空，而 API 给的是 `string | null`；还多了一个契约里不存在的 `createdAt`），改用 `shared` 的类型；正文保存改走 `updateArticle(slug, {content})`；**`localStorage` 兜底改成失败时显式报错**
- [x] 管理员在详情页看草稿时给一个"草稿"标记，否则他会以为文章丢了
- [x] 删 `apps/web/src/lib/supabase.ts`（连带里面**已无人调用**的 `hasSupabaseCredentials`）；卸载 `@supabase/supabase-js`；清掉 `.env.example` 里 `VITE_SUPABASE_*` 的残留说明
- [x] 附带（超出原清单，理由见下面执行结论）：`app.ts` 的 cors 补 `methods`，新增 `test/cors.test.ts`

**D-1 执行结论（真跑过的账，含浏览器真点）**

里程碑那两条 grep 实测：`grep -rniE "supabase" apps/web/src` → 无输出；`grep -c supabase apps/web/package.json` → `0`；连 `pnpm-lock.yaml` 也是 `0`。`App.tsx` / `Home.tsx` 里两处提到 Supabase 的**注释**也改了措辞——不是洁癖，是那条 grep 不分正文与注释，留着就归不了零。

**挖出一个让整段 D 无法工作的真缺陷，以及它为什么活了四个阶段没被发现。** `@fastify/cors` 的默认 `methods` 是 `'GET,HEAD,POST'`（`index.js:11`；预检回的就是这个静态列表，`index.js:243`），而 `app.ts` 注册 cors 时只给了 `origin` 与 `credentials`。实测：

```
OPTIONS /api/v1/articles/x  Access-Control-Request-Method: PATCH
  → access-control-allow-methods: GET,HEAD,POST      ← 浏览器据此拦掉发布
```

**当时 220 条后端测试全绿，而"发布"在浏览器里根本不可能工作。** 原因是 `app.inject()` 跑完整的请求生命周期，但这里没有浏览器、不做同源检查——**CORS 配置对测试是隐形的**。修法只有一行：`methods: ['GET','HEAD','POST','PATCH','DELETE']`，且只放 API 真路由的动词（`PUT` 不在内，允许用不上的动词等于白开门）。新增 `test/cors.test.ts` 把**预检响应本身**当被测对象，因为那是这个设置唯一可观察的地方。变异验证：把 `methods` 改回默认 → **恰好 2 红 3 绿**，红的正是 PATCH 与 DELETE 两条，绿的正是"GET/POST 仍被允许"那条对照（它防的是反向的错：把列表写成只剩 `PATCH,DELETE` 会让整站在浏览器里读不出内容）。

**顺带修掉一个已存在的用户可见缺陷**：旧 `request` 对所有响应无条件 `response.json()`，而 `POST /auth/logout` 回 204 空体（`auth/routes.ts:232`），于是每次点"退出登录"都抛 `SyntaxError`、绕开 `catch (ApiError)`、被 `Header.tsx:26` 的 `console.error` 吞掉，表现成"点了没反应"。现在 204/205 直接返回而不解析 body——这条不修，阶段 B 的 `DELETE`（同样 204）在浏览器里一个都用不了。

浏览器真点记录（api 3001 与 web 5175 都起着；会话 cookie 是 `httpOnly`，管理员态由本地签发的 15 分钟令牌注入，走的正是 `requireAuth` 读的那个 cookie，令牌用完即失效、未落盘）：

| 验收点 | 实际看到的 |
|---|---|
| 匿名读走 API | 首页 6 篇已发布夹具，`draft-unpublished` 不在列表中 |
| 匿名点草稿 | `/blog/draft-unpublished` → "文章未找到" |
| 非管理员进后台 | "需要管理员权限"卡片 |
| 存草稿 | `POST /articles` → **201**；"草稿已保存。公开列表还看不到它——点「发布」才会公开"；URL 转 `/admin/articles/<slug>/edit` |
| **草稿读回来** | `GET /admin/articles/<slug>` → **200**，表单填满并显示"当前：草稿"（D0 那个洞在界面上闭合） |
| 发布 | `PATCH` → **200**；跳 `/blog/...`；草稿标记消失；发布日期出现；正文里 `\path\to` 原样返回 |
| 快速编辑只改正文 | `PATCH {content}` → 200；编辑框关闭、正文更新；`localStorage` 只剩 `theme` |
| **失败可见**（把 api 停掉再存） | 编辑框**不关**；红框"保存失败：Failed to fetch"；**输入的文本完好保留**；无 `localStorage` 写入 |
| DELETE | 走 API 删掉那篇测试文 → **204**；库回到 7 篇、无残留 |

门禁（串行，含 cors 修复）：`-r lint` 0 · `-r check` 0 · `--filter api test` **19 文件 / 225 测试**（18/220 → +1 文件 +5 条）· `-r build` 0（web `✓ built in 58.83s`）。**计划里那条 `pnpm -r lint check build` 的合并写法在 pnpm 下不成立**——后两个词会被当参数传给第一个脚本，实际执行成 `eslint . check build` 并报 `No files matching the pattern "check"`，已按三条分别跑。

**两处留给后面的观察，这一刀不动**：

1. `Home.tsx:212` 与 `HeroCarousel.tsx:56` 仍是 `src={article.coverImage ?? ''}`，即把 null 喂进 `<img src="">`。`ArticleDetail` 里同类写法这一刀已改成"有值才渲染 `<img>`"，这两处不在范围内（7 篇夹具都没有封面图，所以表现为 alt 文本而不是破图）。归 D-2 或 F 一起收。
2. **本地开发必须用 `http://localhost:5175` 打开，不能用 `127.0.0.1:5175`。** `@fastify/cors` 在 origin 是纯字符串时**回显配置值**而不比对请求方，所以页面源与配置串不一致时连 GET 都会被浏览器判失败——而 `pnpm --filter web dev` 绑的恰好是 `--host 127.0.0.1`，天然会踩。同一个回显行为还给 S8 记一笔：`Origin: http://evil.example` 也会拿到一个指向本站的 `allow-origin`（浏览器仍会拦，所以不构成漏洞），但"单源白名单"是靠回显实现的，不是靠校验。

**里程碑标签 `s3-detached-from-supabase` 这一刀不打。** 名字对得上（前端已零 Supabase），但 §D 的验收块里"评论一条、删掉它"这两步要 D-2 才有界面可做，且列表页还没有——标签按计划打在 D 收尾。


### D-2 · 补入口

- [x] `/admin/articles` 列表页 + 路由（S3-R22：标题、slug、状态、最后更新 + 每行编辑/发布/删除；不做搜索、批量、排序切换、预览）
- [x] **顶部入口（计划漏的一条，开工时核实现状补上）**：`Header.tsx` 原本**没有任何通往后台的链接**——只有头像、"Admin" 徽章和登出。列表页若没有入口就只能手输 URL 到达
- [x] 撤销 S2 的只读降级提示，接上发评论与回复（`postComment`，回复带 `parentId`）；删除按钮判据是 `isAdmin || comment.author.id === user.id`（`ArticleDetail.tsx:383-384`），没有用 login 比对——D1 的教训
- [x] **评论按 `parentId` 建树**：`buildCommentTree` 先按 id 建索引；父不在本次数据里的行**当顶级显示**而不是藏起来；父子各自按 `createdAt` 排序，`CommentItem` 递归渲染；删除根评论时 `collectSubtreeIds` 把整棵子树一起从本地列表摘掉（服务端 cascade 会删回复，界面留一行孤儿就是撒谎）
- [x] 导入 Markdown 按钮：`<input type="file" accept=".md" multiple>` → `File.text()` → `POST /api/v1/articles/import` → 逐篇列出成功/冲突
- [x] 冲突行的"覆盖"按钮：按 design §3.3 方案 A 实现——冲突项带回服务端已解析的 `proposed`，界面把它交给现存的 `PATCH /articles/:slug`。浏览器仍不解析 markdown，写仍只有一条门
- [x] 删除文章入口（列表页那行，带 confirm；详情页不放）
- [x] 收掉 D-1 留下的空 `src`：`Home.tsx`、`HeroCarousel.tsx` 封面改成"有值才渲染 `<img>`，否则渐变占位块"；`ArticleDetail.tsx` 的 `comment.author.avatarUrl` 同类。**另补 `Header.tsx` 的头像**（D-2 按边界把它报给我，seed 管理员的 `avatar_url` 实测为 `NULL`，所以这条分支真会走到——改成首字母圆形占位）

**D-2 执行结论（浏览器逐项点过的真账）**

先说清**这棒的验证手段与它的边界**，因为其中一项和"用真文件点选"不一样：后台浏览器面板没有可视表面（`visibilityState=hidden`，指针动作直接失败），所以文件是**用 `DataTransfer` 造 `File` 挂到那个 `<input type=file>` 上、再派发 `change`** 送进去的。走的是真人选文件的同一段代码（`input.files` → `handlePick` → `File.text()` → `POST`），但**文件名与正文是脚本里内联的字符串，不是磁盘上的那两个 `.md`**。这条差异按事实记着，不许写成"已用真文件验过"。其余各项都是真点击、真网络往返。

管理员态由本地签发的 15 分钟访问令牌注入（`portal_access`，正是 `requireAuth` 读的那个 cookie）。令牌中途自然过期过一次，界面自动回到登出态——这顺带也算一次过期行为的观察。

| 清单 | 实际看到的 |
|---|---|
| 列表页 | 7 行、徽章区分"已发布/草稿"、每行编辑/发布/删除、顶部"文章管理"与"新建文章"都在。顺序看着随意是**预期**：seed 七行的 `updated_at` 精确到微秒完全相同，靠 id 决胜 |
| 封面占位 | 首页不再有 `src=""`，换成渐变占位块（18 个）；整页空 src 计数 0 |
| 评论嵌套 | seed 那条"这是一条嵌套回复。"**确实缩进在父评论下面**（`ml-6` 命中）。D-2 之前它是平铺的顶级行——这是本棒修掉的、当下可见的错，不是我构造的场景 |
| 发评论 | 计数 2 → 3，正文在界面上查得到 |
| 回复 | "正在回复 @…"提示 + 表单出现，提交后计数 3 → 4，且**缩进一层**（缩进行 1 → 2） |
| 删自己的评论 | confirm 后计数 3 → 2：根评论**连带它的回复一起消失**，正是 cascade 的语义 |
| 导入第一份 | "已创建草稿（1）"，列表 7 → 8 行；收尾提示是"在下面的列表里逐篇发布"，**没有"导入并发布"** |
| 解析失败的零写入 | 一次意外但有效的证据：我先把一个内容只有 "placeholder" 的假文件挂进去，红框显示后端原话 `Cannot import noop.md: fixture must begin with a '---' front-matter line`，而**列表仍是 7 行**——"整批不写"在界面上也成立 |
| 导入第二份（同 slug） | "已存在，未改动（1）"，行文案带文件名与已存在的 slug，**列表仍 8 行**（冲突没造出重复文章），"用这份文件覆盖"按钮出现 |
| **覆盖** | 点下去后：面板"已用这份文件覆盖"、列表**仍 8 行**、那一行标题从"D-2 导入界面验证"变成"**D-2 导入界面验证（第二版）**"、时间戳从 22:19:32 推到 22:20:55。后两项是关键——它证明服务端带回的 `proposed` 真被写进库里，不是界面自己改了显示 |
| 列表页发布 | "已发布：d2-import-check"，行状态变"已发布"；匿名 `GET /articles/d2-import-check` → **200**，公开列表也查得到 |
| 列表页删除 | confirm → 行消失、回到 7 行；匿名再读那篇 → **404** |
| 登出反向 | "文章管理"链接消失；直接访问 `/admin/articles` 得到"需要管理员权限"卡片且**没有渲染表格** |

数据收尾实查：`articles` 7、`comments` 2（都回到 seed）、`d2-%` 文章 0、本轮造的评论 0 残留。

门禁：`-r build` 0 · `-r lint` 0 · `-r check` 0 · `--filter api test` **19 文件 / 226 测试**（覆盖那条端到端测试 +1）。

**两处我自己的错误，记下来是因为它们差点被我当成产品缺陷**：连着两次是同一个形状——"字符串重打而不是复制"。查评论时探针里写了句我**没发过**的文本，于是报"评论不见了"；注入令牌时贴的是我自己拼的那串而不是脚本刚打印的那串，于是界面显示未登录，而我差点去查登录逻辑。被测对象都没坏，坏的是我的检查手段。

**空库走查（2026-09-29 补做，把上面那条"未验"关掉）**

先说清性质：这是**清空 seed 后在真浏览器里点出来的**，不是推演。setup 是 `delete from articles`（`7 → 0`，评论随 cascade `2 → 0`），走完后再 `pnpm --filter api seed` 复原（输出 `seeded 7 articles, 2 comments`，实查回到 7/2）。

| 步骤 | 实际看到的 |
|---|---|
| 空库首页（未登录） | **抓出一个真缺陷**：轮播区永远显示"正在加载文章轮播内容..."。原因是 `Home.tsx:87` 在加载中和加载完成后**都**传空数组，而 `HeroCarousel.tsx:17` 只看"数组是否为空"——于是"库里没有文章"被显示成"还在忙"。修法是给它一个 `loading` prop 把两种状态分开；修完未登录下显示"这里还没有文章"，`Loading` 徽章不再出现 |
| 空库后台列表 | 不渲染表格，显示"还没有文章"，保留"重新加载"与"选择 .md 文件" |
| 界面新建 → 存草稿 | 进编辑态 URL、表单被管理员读端点填满、标"当前：草稿"；此时公开详情 **404**、公开列表 **0 条** |
| 点发布 | 公开详情 **200**、公开列表 **1 条**；首页轮播与"最新文章"都出现它，空状态文案消失 |
| 在新文章下发评论 | `评论 (1)`，文本可见 |
| 列表页删除 | 界面回到空态，库 `articles 0 / comments 0`——**cascade 把评论一起带走**，这是 D-2 之前只在测试里断言过的性质 |

结论：§D 那条"从空库写出第一篇可见文章"的验收**已走完**，上面的"未点的一项"作废。顺带说明为什么这一趟值得：它发现的轮播缺陷，在任何"有文章"的界面上都不可能出现——而此前每一次验证（含 226 条测试）库里都有 7 行数据。

**里程碑标签已打**：`s3-detached-from-supabase`（与 `pre-s3`、`s3-a` 并列）。

**两个环境实况（与代码无关，但会影响后面几段的排障）**：Docker Desktop 在这一小时内**自己退出两次**，第二次连带打死 API 进程（`/ready` 直接连不上）。判断依据是 `/health` 仍 200 而 `/ready` 503——liveness 与 readiness 分开这件事在真实故障里立刻有了用处。E 阶段起 MinIO 之前先确认 daemon 活着，否则会误判成"新配置坏了"。


**D-2 之后：真实 GitHub 登录第一次跑通（2026-09-29）**

上面表格里所有管理员操作都是用**本地签发的令牌**注入 cookie 做的，所以"登录 → 回调 → 建会话"这条链当时**一次都没走过**。凭据补上之后第一次真走，它立刻暴露了一个前面所有手段都看不见的缺陷：

- 回调成功（日志 `login succeeded`）、会话 cookie 种下了，但 `Location` 是**相对路径**，浏览器按 API 的 3001 解析 → 用户被丢在 API 的 404 页。修在 `auth/routes.ts`（挂到 `PORTAL_WEB_ORIGIN` 上），`safeReturnTo` 那道防开放重定向的闸门一字未动。
- 更难看的是测试侧：`auth-flows.test.ts` 有一条断言**把 `Location: /blog/x` 当成契约**逐字比着；另一条用 `new URL(location, 'https://good.example')` 拿假想 base 解析相对地址，于是无论服务端返回什么都"没跳出本站"。四条断言已改，变异验证：把路由改回相对跳转 → **9 红 / 21 绿**。
- **一条设计上的好消息第一次被真实流量证明**：登录写入的更新列表里刻意不含 `is_admin`，所以那次登录把 `github_login` 更新成了 `Freedom0x0`，而 `is_admin` 保持 `true`、也没多出第二行用户（`users` 仍 2 行）。这条以前只有注释和单元测试撑着，现在有了真实一次成功。
- 环境侧记两笔给 S8：**Docker Desktop 停了会让 `/ready` 回 503**（postgres/redis 双双 failed），而 `/health` 仍回 200——liveness 与 readiness 分得对，但本地排障时别看错端口；OAuth 的 Client ID/Secret 只存在于**未入库**的 `apps/api/.env`（`.gitignore:22` 覆盖 `.env`，已用 `git check-ignore` 验过），全历史也从未提交过真 client id。


**顺带修掉 D-2 报上来的一个后端真缺口**：纯空格的评论此前**会落库**——`length('   ')` 是 3，库的 check 与 DTO 的 `min(1)` 都放行，所以 design §6 那句"评论体空 → 400"当时只有一半真。现在 `CreateCommentSchema` 加了一条 refine 拒绝"全是空白"，但**不做 trim**：你打的字节仍按原样存，界面也不会替你改内容。测试补在 `comments-write.test.ts` 的边界那条里。

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

- [x] Compose 加 `minio`（healthcheck、卷、`MINIO_API_CORS_ALLOW_ORIGIN`）
- [x] 起服务、建公开只读桶、签一个 PUT、**从浏览器同源策略的角度实测**一次跨源 PUT（结果见文末"浏览器实测那一发"）
- [x] **判定并写回本文末尾**：
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

## SPIKE-E 结论（2026-10-05 执行）

> 环境事实先记一笔，因为它改变了 compose 的形状：**MinIO 上游已经不再发布免费镜像**。
> `docker pull minio/minio`（任意 tag，含历史 tag）一律 `error from registry: denied`，
> `quay.io/minio/minio` 对匿名 manifest 请求回 401。本机 Docker 只能经镜像加速拉
> `library/*`，所以 `minio/minio` 这条路在这台机器上根本不存在。
> 替代：**`cgr.dev/chainguard/minio:latest`** —— Chainguard 对同一份 AGPL 上游源码的重建，
> 容器内 `/usr/bin/minio --version` 实测输出 `RELEASE.2026-09-22T19-25-18Z`，是真 MinIO；
> 且镜像自带 `/usr/bin/mc`（这是后面所有内容 provision 的工具，没给 `apps/api` 加任何依赖）。
> compose 里注释了这段来历，避免下一个人在这里重新踩。

### E 执行结论

- [x] Compose 加 `minio`：healthcheck + 持久卷 + CORS（`infra/docker-compose.yml`，凭据走 `infra/.env`）
- [x] 起服务、建公开只读桶 `portal-media`、签 PUT、curl 层面实测预检与真 PUT
- [x] 判定：**CORS 可行 → F 走 presigned**（下方"判定"一节；`apps/api/src/**`、`apps/web/src/**` 一字未改）
- [x] 真浏览器跨源 PUT：**200 + 可读回的 etag + 对象匿名 GET 200/70B**，探针对象已删；判定闭合（见本节末"浏览器实测那一发"）

### 1. CORS 到底配在哪：`MINIO_API_CORS_ALLOW_ORIGIN` 存在，但 `--help` 里看不见

按"以 `--help` 输出为准"的要求核：`minio --help` 与 `minio server --help` 的 FLAGS 里**没有任何 CORS 项**
（只有 `--config/$MINIO_CONFIG`、`--address/$MINIO_ADDRESS`、`--console-address/$MINIO_CONSOLE_ADDRESS`、
`--ftp`、`--sftp`、`--certs-dir`、`--quiet`、`--anonymous`、`--json`）。如果到此为止就会得出
"这个环境变量不存在"的**错误结论** —— 它是 config key，不是 CLI flag，两个渠道都能看到它：

```
$ docker exec myblog-infra-minio-1 bash -c 'mc admin config get local api'
# MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:5175          ← 环境里设的就是它，被当注释回显
api … cors_allow_origin=* …                                    ← 出厂默认是 *（任意源）
```

镜像里 `grep`/`sed`/`strings` 都没有，所以另用宿主 Node 扫了 `/usr/bin/minio` 二进制（110 MB），
里面确有 `MINIO_API_CORS_ALLOW_ORIGIN`、`cors_allow_origin`、`corsConfig` 这些串。

**结论：CORS 的配置项是 `MINIO_API_CORS_ALLOW_ORIGIN`（config key `api.cors_allow_origin`），
它是服务端全局允许清单，compose 里就是这么配的。** 另有独立的每桶机制 `mc cors set`（S3
`PutBucketCors`），实测本桶**没有**桶级 CORS（`mc cors get` → `No bucket CORS configuration found.`），
下面所有预检结果都只由那一个环境变量产生 —— 也就是说"生效的是它"是测出来的，不是猜的。

`*` 是默认值这点值得警惕：**不配就等于对任意网站开放预检**。写仍要签名，但这不是我们想要的边界，
所以 compose 显式钉成前端源，并在 `.env.example` 注明"必须与页面 Origin 逐字节一致"。

### 2. 预检响应头原文（curl 层面，签名无关所以无需遮蔽）

请求：`OPTIONS http://localhost:9000/portal-media/spike/preflight-probe.png`
带 `Origin: http://localhost:5175` + `Access-Control-Request-Method: PUT` + `Access-Control-Request-Headers: content-type`

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Credentials: true
Access-Control-Allow-Headers: content-type
Access-Control-Allow-Methods: PUT
Access-Control-Allow-Origin: http://localhost:5175
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
Date: Mon, 05 Oct 2026 02:08:47 GMT
```

对照（同一个 OPTIONS，换成不在允许清单的源）：

```http
HTTP/1.1 204 No Content
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
```

——**一个 `Access-Control-*` 头都不回**，浏览器会拦掉。这条对照才是"配置真的在起作用"的证据，
也顺便说明：`Access-Control-Allow-Origin` 回显的是精确源而不是 `*`，所以 `credentials` 语义是干净的。

预检要 `content-type, x-my-custom` 时，MinIO 把两个都反射进
`Access-Control-Allow-Headers` —— 预检这关**不是**限制条件，限制在签名那关（见下面第 4 节）。

### 3. presigned PUT 是怎么签的（以及 `mc` 为什么签不出来）

**`mc share upload` 不给 presigned PUT。** 它输出的 `url` 字段是不带任何 `X-Amz-*` query 的裸 URL，
真正可用的是 `share` 字段里的 **POST form / bucket-policy**（`-F policy=… -F x-amz-signature=…`）。
拿那个裸 URL 直接 PUT 会是 403。这个版本（`mc version DEVELOPMENT.GOGET`）也没有 `mc presign`。

所以真·presigned PUT URL 由一个**一次性脚本**签：
`%TEMP%\miniospike\sign-presigned-put.mjs`（约 70 行，只用 `node:crypto`）。
**没有装任何东西**：没进 `apps/api/package.json`，没进仓库，没碰 lockfile；脚本在仓库外，
用完可直接删。判定如果走 presigned，F 在 API 里自己签（design §4.1 本来就是这个形状），
这个脚本的使命到 spike 结束就结束了。

签法要点（这几条都是踩过才知道的）：
- `X-Amz-SignedHeaders=host` —— **只签 host**。于是浏览器可以自由声明任何 `Content-Type` 而签名不破
  （实测：同一 URL 声明 `image/png` 与 `text/plain` 都 200）。
- `X-Amz-Content-Sha256` 位置放 `UNSIGNED-PAYLOAD`。
- path-style URI，每段单独 encode、保留 `/`；`X-Amz-Credential` 里的 `/` 必须是 `%2F`。
  **`uriEncode` 只能做一遍**：第一版我写的是"把非 unreserved 字符全转 %XX"，它把
  `encodeURIComponent` 已经产出的 `%2F` 又变成 `%252F`，MinIO 回
  `400 <Code>MissingFields</Code>`（错误信息完全不指向编码，很难猜）。

### 4. PUT 成功与失败的真账（服务端层面，辅助证据）

同一批 10 分钟有效期的 presigned PUT URL，`curl` 实测：

| # | 请求 | 结果 |
|---|---|---|
| 1 | PUT + `Origin: http://localhost:5175` + `Content-Type: image/png` + 69B PNG 体 | **`200 OK`**，带 `ETag: "ee76702403cd15dbc71587365494cbe5"`，**且响应本身带 `Access-Control-Allow-Origin: http://localhost:5175`** |
| 2 | 匿名 GET 公开 URL（无任何凭据） | **`200 OK`**，`Content-Type: image/png`，`Content-Length: 69` —— 公开只读成立 |
| 3 | **不带签名** PUT 同一 key | `403 AccessDenied` —— 写只认签名 |
| 4 | 匿名 GET 桶根（列举） | `200 OK`，返回完整 `ListBucketResult` —— **匿名列举是开着的**，见下方缺口 |
| 5 | PUT + 未签名的 `x-amz-meta-spike: 1` | `400 AccessDenied` — *"There were headers present in the request which were not signed"* |
| 6 | PUT + `Authorization: Bearer nope` | `400 InvalidRequest` — *"request has multiple authentication types, please use one"* |
| 7 | URL 过期后 PUT（`X-Amz-Expires=1`，等 4s） | `403 AccessDenied` — *"Request has expired"* |
| 8 | 签名 host 是 `localhost:9000`，却发到 `127.0.0.1:9000` | `403 SignatureDoesNotMatch` |
| 9 | PUT 声明 `Content-Type: text/plain`（类型未签） | `200 OK` —— 存的还是原始字节 |
| 10 | PUT 带**浏览器整套自动头**（`Accept`、`Accept-Language`、`Referer`、`Sec-Fetch-*` 四件套、`User-Agent`、`Origin`、`Content-Type`） | **`200 OK`** ← 这条才是"浏览器能不能直传"的关键预测，见判定 |

公开只读的落地方式：`mc anonymous set download local/portal-media`（`mc anonymous get` 回
`Access permission for local/portal-media is download`）。桶由 `mc mb --ignore-existing` 建。

**缺口（测出来的，不是推测的）**：`download` 这一档**连匿名列举一起放开了**。桶里放一个对象后
不带任何凭据 `GET http://localhost:9000/portal-media/` 回 `200` + 完整 `ListBucketResult`，
里面每条 `<Key>` 都在（实测样本：`<Key>uploads/2026/10/listprobe…</Key>`），而不存在的 key 仍正确回 404。
影响的是 F 的一个隐含假设：design §4.2 让 key 由服务端随机生成，如果 F 把"key 猜不到"当成一道防线，
**它不是** —— 随机 key 防的是*覆盖他人对象*和*路径穿越*（这两条依然成立），防不了枚举。
对"博客封面图"这种本来就公开发布的字节来说风险很低，但**未发布的草稿封面在写进文章之前就已经可被列举**，
这条要按事实交给 F：真要收口，`mc anonymous set` 的四档 `private/download/upload/public`
（`mc anonymous set --help` 里就是这么列的）都不够用 —— `download` 已经是"能读对象"里最宽的一档，
它表达不了"只给 `s3:GetObject`、不给 `s3:ListBucket`"。够用的路是 `mc anonymous set-json FILE TARGET`
（下发一份只含 `s3:GetObject` 的匿名 JSON），F 里做启动期确保桶存在时顺手把策略钉成那份 JSON 即可。
或者干脆接受"进了这个桶就等于公开"，把列举当无害。本轮两者都不做（做了就偏离 design §4.3 的"公开只读"），只记录。

**#5/#6/#10 三条合起来是本轮最有用的一条**：MinIO 拒绝"未签名的、但对 S3 语义有影响的头"
（`x-amz-*`、`Authorization`），却**放过浏览器自己硬加的那批**（`Sec-Fetch-*`、`Accept`、`User-Agent`、
`Referer` …）。#10 用 curl 把这整套头原样发过去拿到了 200，说明浏览器那条路上没有"删不掉的头"会挡签名。
这一条**不等于**浏览器实测通过 —— 它只是让失败点从"签名"移回"同源策略"，而同源策略正是 #2 已经量过的那件事。

**顺手记一个 design 里没写到的事实**：`content-length-range`（design §4.2 要求"大小上限在签发时钉住"）
**是 bucket-policy/POST 的条件，presigned PUT 没有它**。`mc share upload` 生成的 POST policy 里
conditions 实测只有 `eq bucket / eq key / eq x-amz-date / eq x-amz-algorithm / eq x-amz-credential`，
连 `content-length-range` 都没有。所以 F 想钉大小，只有两条路：自己签 POST policy（把条件加进去），
或者在 `uploads/complete` 里用 HEAD object 复核真实大小再决定留不留。presigned PUT 这一侧
**无法**限制体积，别在 F 里假装有。

### 判定：**presigned**（CORS 可行）

`MINIO_API_CORS_ALLOW_ORIGIN` 在本版本确实生效，跨源预检对 `PUT` + `content-type` 给出精确源回显，
且**预检与真 PUT 的响应都带 `Access-Control-Allow-Origin`**（后者经常被忽略：没有它，JS 连状态码都读不到）。
服务端层面从预检到写入到公开读整条链路都通。**F 按 design §4.1/§4.3 原方案做 presigned，不退回 API 中转。**

**这个判定目前还差的一步**：真正的浏览器跨源 PUT。#10 是 curl 伪装的头极限，不是同源策略本身；
`app.inject()` 那次教训的反面（真浏览器才会做预检）只有真浏览器能补。主控点完下面这段之后判定才算闭合。

### 给主控：在真浏览器里执行的那一段

前置：页面必须开在 **`http://localhost:5175`**（不能是 `127.0.0.1:5175`，design §5 那条同源约束）。
这条在 MinIO 侧同样成立，实测过：同一个 OPTIONS，`Origin: http://127.0.0.1:5175` 回来的是
`204` + **零个 `Access-Control-*` 头** —— 允许清单是精确串匹配，不做 `localhost`/`127.0.0.1` 归一。
所以页面开错，失败会长成"CORS 拦了"的样子，而其实是源串不匹配。
MinIO 容器 healthy；URL 里的 host 必须是 `localhost:9000` —— 签名只签了 `host`，
换成 `127.0.0.1:9000` 就是 #8 那个 `SignatureDoesNotMatch`。

presigned PUT URL（有效期 7 天，签给一个**当前不存在**的 key，key 见 `E_URL` 的 path 段）：

```
E_URL = <见本棒最终报告；形如
http://localhost:9000/portal-media/uploads/2026/10/<32hex>.png?X-Amz-Algorithm=…&X-Amz-Signature=…>
签名串不进任何可提交文件，故此处只留形状>
```

在**该页面的 DevTools Console** 里粘贴执行（不是 curl，不是新标签页地址栏——地址栏是顶层导航，不做 CORS）：

```js
// 从 http://localhost:5175 的页面里执行。E_URL 换成上面那条完整 presigned PUT URL。
const E_URL = 'http://localhost:9000/portal-media/uploads/2026/10/….png?X-Amz-…';

// 70 字节的合法 PNG（1x1），不依赖任何文件选择器；magic 实测 89504e47 开头
const bytes = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
), (c) => c.charCodeAt(0));
console.log('sending', bytes.length, 'bytes');  // 记住这个数，下面 curl 的 Content-Length 要跟它一致

// 关键：除了 Content-Type 之外什么都别加。
// 不要 headers: { Authorization, X-*, Content-Length … }（#5/#6 实测会被拒）。
// 不要 mode:'no-cors' —— 那拿不到状态码，"成功"是假的。
const res = await fetch(E_URL, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/png' }, // 唯一需要显式带的头；它不在签名里，写什么都行
  body: bytes,
  credentials: 'omit',                      // 预检回了 Allow-Credentials: true，但我们不需要 cookie
  mode: 'cors',
});

console.log('status', res.status, 'etag', res.headers.get('etag'));
// 期望：status 200，且 etag 非空（形如 "ee76…" 的 32 位 hex；值随字节内容变，不必跟本轮 curl 的一致，
//       但 `res.headers.get('etag')` 能读到东西 —— 这一点本身就证明 CORS 放行了）。
// 反过来，读不到头/读不到状态码的失败长这样：
//   fetch 直接抛 TypeError: Failed to fetch（DevTools Network 里那条 OPTIONS 无 ACAO 响应）
//   → 那就是 CORS 拦了，不是 MinIO 拦的。
```

**成功判据（两条都要）**：

```bash
# 1) 匿名读：不带任何凭据，公开 URL 必须回 200 且字节对得上
KEY=uploads/2026/10/<上面那个 32hex>.png
curl -s -D - -o /dev/null "http://localhost:9000/portal-media/$KEY" | sed -n '1p;/Content-Length/p;/ETag/p'
#    预期：HTTP/1.1 200 OK / Content-Length 与 console 里打印的字节数一致（上面那段 base64 是 70）
#          / ETag 与 fetch 打印的一致
#    （执行前它是 404 —— 这个"先 404 后 200"的差别才是 PUT 真写进去的证明）

# 2) 桶里确实多了一个对象
docker exec myblog-infra-minio-1 bash -c "mc ls local/portal-media/$KEY --disable-pager"
```

如果浏览器这步炸了，**先看 Network 里那条 OPTIONS**，再下结论：
OPTIONS 没有 `Access-Control-Allow-Origin` → CORS 问题（判定翻回"退回 API 中转"，并在此改写理由）；
OPTIONS 有 ACAO、PUT 回了 4xx → **不是** CORS 问题，是签名/头的问题，把响应 XML 的 `<Code>` 带回来
（`SignatureDoesNotMatch` / `AccessDenied` / `InvalidRequest` 分别对应 #8 / #5 / #6，都已复现过）。

**执行完请清场**（桶要保持成"只有桶、没有 spike 遗产"的状态交给 F）：

```bash
docker exec myblog-infra-minio-1 bash -c "mc rm --force local/portal-media/$KEY --disable-pager"
```

### 浏览器实测那一发（主控执行，2026-10-05，判定就此闭合）

在 `http://localhost:5175` 页面上下文里，对 presigned URL 发真 `fetch`（`method: PUT`、`mode: 'cors'`、`credentials: 'omit'`、只带 `Content-Type: image/png`、70 字节 PNG）：

```
origin  http://localhost:5175        ← 发起方，与 MinIO 不同源
status  200
etag    "2605723f72faf19be32a67eddc35ee1f"   ← 读得到，说明响应没被同源策略挡掉
acao    http://localhost:5175
```

随后 `curl` 匿名读那个对象：`200 / Content-Length: 70 / Content-Type: image/png`，证明字节真落盘而不是 fetch 假成功。探针对象已 `mc rm` 删掉，`mc ls --recursive local/portal-media` 为空。

**所以判定是闭合的，不是"看起来可行"**：curl 那 13 组（尤其 #10 带全套浏览器自动头拿 200）负责解释**为什么**能成，这一发负责证明**确实**能成。F 走 presigned。

给 F 留的两条硬事实，都是从这次实测里掉出来的、文档上没有的：

1. **`content-length-range` 在 presigned PUT 上不存在**（design §4.2 假设了它）。它是 POST policy 的条件，`mc share upload` 生成的 policy 实测也没有。所以体积上限只能在 `uploads/complete` 里 `HEAD object` 复核——签发给你的时候拦不住，只能事后不认。
2. **`X-Amz-SignedHeaders=host` 意味着 `Content-Type` 不被签名保护**：客户端声明什么类型都签名不破。这正是 design §4.2 "客户端声明可以撒谎"的那一半，且比预想更彻底——所以**魔数嗅探必须是 F 的硬门，不能省**；`uploads` 里若按声明类型决定 key 后缀，写进去的字节和后缀可以毫无关系。

### compose 落地时踩到的两个坑（不是 CORS，但会挡住下一个起这套环境的人）

1. **镜像的 `/data` 是 root:root 0777，而容器默认 uid=65532**：MinIO 直接
   `FATAL Unable to initialize backend: file access denied` 退出（跟 CORS 无关，容易误判成"镜像坏了"）。
   compose 里用 `user: '0:0'` 绕开并注释了这是 dev-only 取舍；不想留 root 的话得加一个 chown 的
   init 服务，本轮没做（那是 S8 的事）。
2. **healthcheck 不能用 curl/wget/nc，甚至没有 `grep`/`head`/`sed`/`awk`/`find`**（Chainguard 最小镜像）。
   探 `/minio/health/live` 用的是 bash 的 `/dev/tcp` 假设备 + 纯 builtin 比较；注意 compose 会把
   `$$hc_resp` 里的 `$` 当变量插值，`read -r` 的**目标名**不能带 `$`（两处都实测炸过一次才写对）。
   现在 `docker ps` 里 `myblog-infra-minio-1` 是 `healthy`，`localhost:9000/minio/health/live` 从宿主回 200。

## OWASP 写操作清单结论（执行时填写）

待填。
