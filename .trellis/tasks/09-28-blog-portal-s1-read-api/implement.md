# S1 执行计划

> 设计见 `design.md`。**顺序是有意的：两个 spike 不通过就不写业务代码**，schema 不稳就不写 API。

---

## 前置

- [ ] 起基础设施：`pnpm infra:up`，确认 postgres / redis 均 healthy
- [ ] 确认 `DATABASE_URL` 指向本地库（`apps/api/.env`，值参考 `infra/.env`）
- [ ] 打回滚标签：`git tag pre-s1`

---

## 0 · SPIKE-1：Zod 类型提供器（先做，1 次性验证）

**目标**：确认 `fastify-type-provider-zod@7` + `zod@4` + `fastify@5` 可用。

- [ ] 装 `node-pg-migrate`（本阶段唯一新增运行期依赖，spike 不需要）
- [ ] 在 `apps/api/src/` 写**一个**临时最小路由：带 `limit` 查询参数的 GET
- [ ] 验证三点：① 非法 `limit` 被拒；② handler 参数/返回类型被推断（**故意写错返回值，确认 tsc 报错** —— 若 tsc 不报，说明类型退化成 `any`，spike 失败）；③ 校验错误落进 S0 的统一 envelope

**判定**：三点全过 → 记结论进本文件末尾，继续。任一失败 → 停，回到 `design.md` §0 换方案（Fastify 原生 JSON Schema），**不要硬推**。

```bash
pnpm --filter api check && pnpm --filter api dev   # 另开终端
curl -i 'localhost:3001/spike?limit=abc'           # 期望 400 + 统一 envelope
curl -i 'localhost:3001/spike?limit=9999'          # 期望 400
```

---

## 0b · SPIKE-2：`packages/shared` 的消费方式

**目标**：决定 `design.md` §0 的三条候选里选哪条。**必须在写第一个 DTO 之前定下来。**

- [ ] 先试**方案 a**（shared 产出 dist）：给 shared 加 `build`，`main`/`types` 指向 `dist/`，api 里 `import { X } from 'shared'` 一个**运行时值**（不是 type），然后：

```bash
pnpm --filter shared build
pnpm --filter api build && node -e "import('./apps/api/dist/...')"   # 确认运行时能解析
pnpm --filter api check
```

- [ ] 若 rootDir / 构建顺序问题不可接受 → 试**方案 b**（project references + `tsc -b`）
- [ ] **方案 c（两侧各写一份契约）不接受**，除非 a 与 b 都不成立；若被迫选 c，在 `prd.md` 记为已知妥协

**产出**：一段结论写进本文件末尾，含最终 import/export 约定。

---

## A · 迁移工具链与 schema v2

- [x] 建 `apps/api/migrations/`，配 `migrate` / `migrate:up` / `migrate:down` / `migrate:status`
- [x] 写迁移 1：`users` / `articles` / `comments` + 全部索引 + 全部 check 约束（照 `design.md` §2.2）
- [x] 写对应 down（`drop table` 反序，注意依赖顺序）
- [x] **不要**在这一步引入老库数据——S1 不导 Supabase
- [x] **变更**：runner 自己写，不用 `node-pg-migrate`（理由见 `design.md` §2.2 该行更新，及下方 SPIKE 结论后记）
- [x] **补测**：批次原子性与 down 配对强制，各写成自动化用例

### A 阶段实测结果

```
up      → 4 表 / 11 索引 / articles 14 列 / 2 自定义约束 / 3 外键 / 版本表=0001
down all → 只剩 schema_migrations，版本表清空
再 up   → 表全部回来
重复 up → already up to date（幂等）
```

**批次原子性**（临时加 0002 成功 + 0003 失败的迁移对）：

```
rollback_a 存在? 0     rollback_b 存在? 0     版本表 0002/0003 记录? 0
```

**缺 down 文件**：`Migration 0003_bad is missing its down file.` → 拒绝执行 ✓

**⚠️ 上面这组测试抓出我自己写的一个缺陷**：进度日志原本打在事务提交之前，于是回滚的批次会打印 `applied 0002_ok` —— **日志谎报了一次没有发生的成功**。已改为提交后再报告，并复测四条日志路径（reverted / applied / already / 失败批次无虚假 applied）。

自动化测试：`src/db/migrate.test.ts`，8 例覆盖校验规则（含"用真实 migrations/ 目录跑一遍校验"）。api 总计 **24 passed**。

**验证（这是"迁移可回滚"的硬证明）**：

```bash
pnpm --filter api migrate:up
psql "$DATABASE_URL" -c "\d articles"        # 确认列、约束、索引都在
pnpm --filter api migrate:down
psql "$DATABASE_URL" -c "\dt"                # 期望三张表全部消失
pnpm --filter api migrate:up                 # 再上一次，确认幂等
```

> 顺带练到的课：`down` 的 drop 顺序必须与依赖相反，否则 Postgres 因外键拒绝。

---

## B · 夹具与 seed（危险内容是重点，不是点缀）— ✅ 完成

- [x] 7 个夹具（原计划 4 个，实际拆得更细）：`hostile-quotes`（`name: 'demo'` 与 `'a', 'b'` 数组）、`dollar-tags`（字面 `$md$` / `$$` / `$SQL$`）、`cjk-emoji`（中日韩 + 组合字形 + 国旗 + 零宽字符）、`backslashes`（Windows 路径、正则、`\n` 字面量）、`oversized`（>50 kB，**实测 117,887 字节**）、`normal-published`、`draft-unpublished`
- [x] front-matter 解析器：**刻意不做 YAML 解析器**，只支持"扁平 `key: value` + `[a, b]` 数组"，**缩进行与注释行一律拒绝**（宽松解析会把 YAML 列表读成字符串、静默灌错数据）
- [x] `src/db/seed.ts`：按 slug upsert、**固定 UUID**（随机 UUID 会让每次运行插入新副本，那就必须靠手工清空表，而那种 seed 在 CI 里没法用）；整批单事务；**`NODE_ENV=production` 拒绝执行**
- [x] 逐字节读回一致：已用临时脚本实测证明（阶段 F 自动化）

### B 阶段实测

**幂等（跑两次 seed 后查库，不是查脚本自报的数字）**：

```
articles 总数 7 / distinct slug 7 / comments 2 / users 2
draft 1 / published 且 published_at 为空 0 / 嵌套评论 1
```

**逐字节读回一致：7/7**

```
OK  backslashes       bytes=   219  sha=02ca777e→02ca777e
OK  cjk-emoji         bytes=   275  sha=163b3dcc→163b3dcc
OK  dollar-tags       bytes=   190  sha=e3926816→e3926816
OK  draft-unpublished  bytes=    89  sha=fa1845ef→fa1845ef
OK  hostile-quotes    bytes=   362  sha=67d95b00→67d95b00
OK  normal-published  bytes=   122  sha=36696809→36696809
OK  oversized         bytes=117669  sha=40eb9497→40eb9497
```

**生产守卫实测**：`Refusing to seed NODE_ENV=production — this is development data.`，退出码 1 ✓

**测试**：解析器 10 例（含"正文中间的 `---` 是内容不是闭合符"这条边界）；api 累计 **34 passed**。

> 迁移 04 就是死在这一类内容上（`syntax error at or near "demo"`）。**用眼睛看 SQL 文件看不出语法错误，只能执行。** 造这些夹具的动机就是把它变成可重复的断言，而不是等下一次踩到。
>
> 顺带一条：生成 oversized 时我自己先踩了一次——Python 里 `C:\tmp\x` 被当成转义序列，SyntaxError。改用 raw 字符串。危险内容夹具确实有效。

---

## C · 文章读 API（list + detail）— ✅ 完成

- [x] `lib/pagination.ts`：游标编解码 + 单元测试（往返、URL 安全性、7 类非法输入）
- [x] `modules/articles/schema.ts`：Zod DTO + **三个编译期漂移守卫**（`*_MATCHES_CONTRACT`）
- [x] `repository.ts`：只写 SQL；行 → camelCase 领域对象；**列表不 select 正文**；全参数化
- [x] `service.ts`：分页与可见性规则；**不含 `request`/`reply`，不含 SQL**
- [x] `routes.ts`：两个 GET；不手写错误响应体
- [x] 注册进 `app.ts`
- [x] keyset 用行值比较 `(published_at, id) < ($n::timestamptz, $m::uuid)`

### 两个被测试抓出来的真 bug（都不是读代码能看出来的）

**① 参数占位符重号**：`param()` 辅助函数按 `values.length` 生成编号，而我在**同一个模板字符串里调用了它两次、且都在 `values.push` 之前** → 生成 `($4::timestamptz, $4::uuid)`。Postgres 报：

```
cannot cast type timestamp with time zone to uuid   (code 42846)
```

**② 分层假设越界**：`repository.findBySlug` 直接调 `toSummary`，隐含假定 `published_at` 非空。草稿该列合法地为 NULL → `.toISOString()` 崩 → **草稿详情返回 500 而不是 404**。

这不是笔误，是**层放错了**：`published_at` 是否可空取决于"这行能不能公开"，那是 service 的规则。修法是 repository 返回 `publishedAt: string | null` 的 `ArticleRecord`，由 service 在决定可见性之后再构造 `ArticleDetail`。

**我原本的验收断言还掩盖了它**：page-walk 测试直接取 `body.data` 而不先查状态码，失败信息是 `body.data is not iterable`，真正的数据库错误被埋了。已改为**每页先断言 200 再读 body**。

### 一处诚实的能力边界

`EXPLAIN (ANALYZE, BUFFERS)` 显示两条查询都用 `Index Scan using articles_list_keyset`，且 **keyset 谓词被下推进 `Index Cond`**：

```
Index Cond: ((status='published') AND (ROW(published_at, id) < ROW(...::timestamptz, ...::uuid)))
```

但表只有 6 行，planner 仍选了 `Sort` + top-N heapsort 并扫了全部匹配行。**所以这组证据只证明"索引可用、谓词由索引服务"，尚未证明"提前终止扫描"** —— 那需要规模化数据，留给 S6 与 k6 一起做。不在此夸大。

### 补记：一条我自己写的测试当时过不了

`decodeCursor` 原先不校验 `i` 的形状，而我写的用例断言非 uuid 应被拒。**注释里写的风险是真的**（非法值会在 Postgres 里炸成 500）。所以补了 uuid 正则校验，而不是删掉那条测试。

### 状态

api 测试 **53 passed / 7 files**；`pnpm -r lint/check/test/build` 全绿；CI 已加 Postgres service container 并本地按 CI 确切顺序从**空库**跑通（install→lint→check→migrate→seed→test→build→产物解析）。

> **CI 里没有 Redis service 也能跑集成测试**，这是阶段 0 那个"Redis 不可达不再阻塞启动"修复的直接回报——否则每个集成测试都得先把 Redis 起起来。

---

## D · 评论读 API — ✅ 完成

- [x] `modules/comments/`：`GET /api/v1/articles/:slug/comments`
- [x] join `users` 取作者（**不再快照 user_name/avatar**）
- [x] 返回平铺 + `parentId`，不服务端建树
- [x] 文章不存在或非 published → 404

### 本阶段最值得记的一条：复用而非复制安全规则

"这条文章是否公开"已经写在 `ArticleService` 里。评论端点**必须调用同一条规则**，不能把三个条件抄一遍——抄的那份早晚和原件不一致，而后果是某个端点开始漏草稿。

因此把规则从 `getPublished` 里提出来成 `findPublished(slug)`，`getPublished` 与 `CommentService` 都走它。测试里专门有一条断言：草稿的评论端点返回 404 **且响应体不含草稿评论内容**。

### 另一个教训：vitest 全绿而 tsc 报错

第一次跑时 **58 个测试全过，但 `pnpm --filter api check` 失败**：`findPublished` 内部已排除 null，返回类型却仍是 `string | null`。

**vitest 用 esbuild 转译，不做类型检查**——所以"测试通过"从来不等于类型正确。这正是 `check` 必须作为 CI 独立闸口的原因，两处都不能省。

修法上还有一个 TS 细节：`if (found.publishedAt === null) throw` 只收窄**属性访问**，不收窄**整个对象的可赋值性**，所以 `return found` 仍然报 `ArticleRecord` 不能赋给 `PublishedArticle`。要显式 `return { ...found, publishedAt: found.publishedAt }`。

### 一个 tie-breaker 真的派上用场的地方

两条 seed 评论在同一事务里插入，`created_at` **完全相同**——`order by created_at asc`  alone 是不确定的。加上 `id asc` 后顺序才稳定，测试才能断言"根在回复之前"。**分页与排序必须有全序**，这条在这里变成了具体可见的。

### 状态

api 测试 **58 passed / 8 files**；`lint / check / build` 全绿。

---

## E · 标签读 API

- [ ] `GET /api/v1/tags`：`unnest(tags)` 聚合计数
- [ ] `GET /api/v1/tags/:tag`：`tags @> array[$1]` + 复用 C 的分页

---

## F · 集成测试与 CI

- [ ] `src/test/` 建测试库引导（独立库名，不碰开发库）
- [ ] 逐端点覆盖 `design.md` §4.3 错误矩阵的每一行
- [ ] 覆盖：draft 在列表与详情均不可见（**安全边界，不是可选用例**）
- [ ] CI 加 Postgres service container + 跑迁移 + 跑 seed

**验证**：

```bash
pnpm -r lint && pnpm -r check && pnpm -r --if-present test && pnpm -r build
```

---

## G · 前端读路径切换

- [ ] `apps/web/.env.example` 增 `VITE_API_BASE_URL`
- [ ] 重写 `utils/articlesApi.ts` 为 fetch 自建 API
- [ ] `Home.tsx` / `ArticleDetail.tsx` 改用新 API；**评论写入暂时仍走 Supabase**（S3 处理），但需保证写入失败不影响读取
- [ ] `lib/supabase.ts` 改惰性单例（S1-R11）
- [ ] 确认 `grep -rn "supabase.from(" apps/web/src` 只剩写路径

**验证（不再用构建通过冒充可访问）**：

```bash
grep -rn "supabase.from(" apps/web/src            # 逐条核对，只有 insert/delete 允许
mv apps/web/.env apps/web/.env.bak                # 关键一步：拿掉凭据
pnpm --filter web dev                             # 期望：首页仍能渲染文章列表
curl -s localhost:5175/ | head -c 200
mv apps/web/.env.bak apps/web/.env
```

> 上一条验证针对的正是我在这轮犯的错：曾用 dev server 的 HTTP 200 冒充"门户可访问"，而应用因缺凭据在加载期就抛异常。**这个自证要专门做，不能只看退出码。**

**本环境无浏览器，渲染正确性无法验证**——留到 S4 的 Playwright。此限制已在 `prd.md` 写明。

---

## 收尾

- [ ] 更新 `prd.md` 验收清单，逐项打勾或标注无法验证的原因
- [ ] 两个 spike 的结论已写在本文件末尾
- [ ] `git tag s1-done`

---

## Spike 结论

### SPIKE-1 · 通过（2026-09-28）

`fastify-type-provider-zod@7` + `zod@4.6.5` + `fastify@5.12.5` 三项全部成立，**S1 可以按 `design.md` 的 Zod 单一契约源方案推进**。

**接线方式（重要，避免踩同一个坑）**：**不要**给实例加 `.withTypeProvider<ZodTypeProvider>()`——那会让 `buildApp` 的返回类型 `FastifyInstance` 与实际推断类型不一致。正确做法是路由插件用 `FastifyPluginAsyncZod` 类型（自带 type provider），实例上**只设两个编译器**：

```ts
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)
```

**类型推断的验证方式**——不是"看代码像不像有类型"，而是**故意写错返回值让 tsc 报错**：

```
Type '{ limit: string; echo: number; }' is not assignable to type '{ limit: number; echo: string; }'
  Types of property 'limit' are incompatible.
```

错误类型来自 Zod schema，证明推断真实存在、不是 `any`。

**校验与错误矩阵实测**（`app.inject()`，无端口）：

| 用例 | 状态 | 结果 |
|---|---|---|
| `limit=5` | 200 | `{"limit":5,"echo":"ok"}` |
| 无参数 | 200 | `{"limit":10,...}` — `default(10)` 生效 |
| `limit=abc` | 400 | `code: BAD_REQUEST`（非 `FST_ERR_VALIDATION`） |
| `limit=0` / `limit=-3` | 400 | 同上，"expected number to be >=1" |
| `limit=9999` | 400 | 同上，"expected number to be <=50" |

第四行是 **S0 那个"框架码不得外泄"修复的直接兑现**——Zod 的 `FST_ERR_VALIDATION` 被 `CODE_BY_STATUS` 映射成了本项目自己的 `BAD_REQUEST`。

### ⚠️ SPIKE-1 顺带发现并修复的真缺陷

**`redisPlugin` 的关闭路径泄漏 socket，进程永不退出。**

诊断用 `process.getActiveResourcesInfo()`：

```
close 前: ["SimpleWriteWrap","GetAddrInfoReqWrap","TCPSocketWrap","Immediate"]
close 后: ["SimpleWriteWrap","GetAddrInfoReqWrap","TCPSocketWrap","Immediate"]  ← 一个没释放
```

**根因是我在 S0 做的那个"不 await connect()"改动**：`connect()` 仍在飞行中（DNS 未回来）就调 `destroy()`，socket 与 `GetAddrInfoReqWrap` 双双悬空。

后果很实际：**S1 的集成测试会永久挂起**；真实容器里 SIGTERM 只能等编排系统超时强杀。

**修法**：onClose 里先给在飞的 connect 一个有界等待（1s），再按状态走 `quit()`（已就绪）或 `disconnect()`（未就绪）；两条路径都不让关闭失败。**"不 await connect" 换来的是启动韧性，代价就是必须在关闭路径上把它还回去**——这是一对，不能只做一半。

**双向都验证过**（对称验证）：Redis 正常 → 退出码 0；Redis 指向死端口 → 仍启动、`/ready` 503 且指出 `redis: failed`、退出码 0。

### SPIKE-2 · 通过（2026-09-28）— 采用方案 a：`shared` 产出自己的 `dist`

`packages/shared` 现在导出**运行时值**（`ERROR_CODES`），并被 `apps/api` 在运行时 import——这正是 S0 埋下、当时判定"会冲突"的场景。

**实测结论：不冲突，但有一个必要条件。**

```jsonc
// packages/shared/package.json
"main": "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
"scripts": { "build": "tsc -p tsconfig.json", "check": "tsc -p tsconfig.json" }
```

`apps/api` 的 `rootDir: src` 不再被触发，因为 Node 与 tsc 解析 `shared` 时走的是它的 `dist`，而不是它仓库里的源文件。**方案 c（两侧各写一份契约）没有被启用。**

### ⚠️ Spike 抓到的、只有真跑才会暴露的 CI 破坏

**`shared` 的 `check` 脚本必须也产出 `dist`**（即去掉 `--noEmit`）。原因：

- CI 顺序是 `lint → check → test → build`，**`check` 在 `build` 之前**
- api 的类型检查要读 `shared/dist/index.d.ts`
- 干净检出时那一刻 `dist` 还不存在 → **`pnpm -r check` 直接红**

实测证据：删掉 `packages/shared/dist` 后单独跑 `pnpm --filter api check` → **exit 1**。

靠 `-r` 的拓扑顺序（shared 先于 api）+ shared 的 check 会产出，问题消失。

**代价（写下来，因为它是真实的开发体验陷阱）**：单独运行 `pnpm --filter api check` 或 `pnpm --filter api test` 时，若 `shared` 从未构建过会失败。绕过方式是先 `pnpm --filter shared build`。`pnpm -r check` 不受影响。**这条待沉淀进 `.trellis/spec/backend/architecture.md`。**

**最终证明**——从干净状态（三个 `dist` 全删）按 `ci.yml` 的确切顺序跑：

```
pnpm -r lint      ✓
pnpm -r check     ✓
pnpm -r test      ✓
pnpm -r build     ✓
api 产物可解析     ✓（如期失败于配置校验，说明含 shared 在内的 import 全部解析）
```

### 副作用（好的）

`ERROR_CODES` 落到 shared 后，`ApiError.code` 的类型从 `string` 收紧成 `ErrorCode` 联合——**路由再也造不出前端从没听说过的错误码**。同时 `errorHandler` 里的裸字符串常量全部消失，未知 4xx 的兜底码从含糊的 `REQUEST_ERROR` 变成明确的 `BAD_REQUEST`。


### `EXPLAIN` 证据

待填（阶段 C）。

