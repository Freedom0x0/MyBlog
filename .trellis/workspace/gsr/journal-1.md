# Journal - gsr (Part 1)

> AI development session journal
> Started: 2026-09-24

---



## Session 1: S0 地基：workspace 重构 + Fastify 骨架 + CI 打通
<!-- trellis-session: v=2 fp=dc935fbba49c0a56 -->

**Date**: 2026-09-24
**Task**: S0 地基：workspace 重构 + Fastify 骨架 + CI 打通
**Branch**: `feat/s0-foundation`

### Summary

把单包 Vite 应用重构为 pnpm workspace（apps/web、apps/api、packages/shared），建立 Fastify 服务骨架（Zod 配置校验、pino 结构化日志、请求 ID、/health 与 /ready 语义分离、统一错误契约、ApiError），用 Docker Compose 起本地 Postgres + Redis，打通 GitHub Actions CI（lint/类型/测试/构建/产物可解析），建立 backend spec 层。独立复核发现 3 个真缺陷并修复：5xx 转发 error.code 泄露 Postgres SQLSTATE、Redis 连不上阻止启动且以 avvio 超时收场、CORS_ORIGIN 声明未消费。开 PR 后暴露并修复 Vercel 部署失败（workspace 重构后 monorepo 未配 rootDirectory）。更正两处基于推断的错误结论：换行符归一化实测零内容变化；存在生产部署（本地查不到不等于不存在）。学习要点：any 会掩盖真实缺陷；依赖别默认取最新大版本；liveness 与 readiness 混用会导致重启循环；ESM nodenext 下 tsc 不补 .js 扩展名。

### Git Commits

| Hash | Message |
|------|---------|
| `91858bb` | docs(task): correct the deployment assumption that broke the Vercel build |
| `ff3d988` | fix(deploy): point Vercel at the web app after the workspace move |
| `4c0b78e` | chore: normalize line endings to LF |
| `cdd41ab` | docs(task): record S0 completion and handover items |
| `490a34d` | docs(spec): add the backend layer spec |
| `8fb1b6f` | ci: verify lint, types, tests, and that the built API resolves |
| `7295e21` | fix(web): resolve pre-existing lint errors and a hidden prop-type bug |
| `96c0d81` | feat(api): add the Fastify service skeleton |
| `328ceee` | docs(plan): refine module integration for dual entry and shared tokens |
| `66cd542` | feat(infra): add local Postgres and Redis compose services |
| `9f26724` | refactor: restructure repo into a pnpm workspace |
| `9893bfa` | docs: rewrite technical architecture to match actual code |
| `b78b3af` | chore: add Trellis + CodeGraph project tooling |

### Status

[OK] **Completed**


## Session 2: 既有缺陷清理（A 类 + D16）与 D1 的撤销
<!-- trellis-session: v=2 fp=f6de10f729649455 -->

**Date**: 2026-09-28
**Task**: 既有缺陷清理（A 类 + D16）与 D1 的撤销
**Branch**: `feat/s0-foundation`

### Summary

清理既有缺陷 6 项：D2 生产构建的 Trae 推广角标、D3 双重死代码 Projects.tsx、D4 会渲染虚构文章的 mockData 兜底、D5 实测确认语法错误的坏迁移 04、D7 脚手架标题与缺失 description，以及执行中新增的 D16——搜产物发现 react-dev-locator 把源文件路径与行号以 1020 处 trae-inspector 属性编译进生产包，改为限定 command==='serve'（生产包 1020→0，包体 2473→2369 kB，dev 侧经反向验证仍挂载）。D1 提权漏洞先实现、经独立复核验证、再撤销：理由是它与 B 类缺陷同样属于「会被 S1/S2 替换掉的代码」，且线上库里只有迁移 02 的 4 篇演示文章、无可保护内容；迁移 06 已用 git rebase --onto 从历史中整体移除（未推送，重写安全），并验证重写后仅差该文件、全部命令复跑通过。漏洞本身用桩 auth.jwt() 实测确认可利用，结论保留给 S2 用 users.is_admin 列根治。独立复核对 6 项全部重新构建实测，零确认问题；代理补上了我漏掉的对称验证（只证生产包干净、未证 dev 仍挂载），并 6 轮未能复现此前那次偶发测试失败，故改记为「无法证实」而非已知缺陷。沉淀规范：backend/conventions.md 新增迁移章节（美元引号、scratch 库实测、禁改已应用迁移、不用用户可写字段做授权），新建 guides/verification-checklist.md 记录三次「由缺失证据推出结论」的错误（which 只报 PATH、Vercel App 挂在仓库层本地无痕、autocrlf 归一化实测零内容变化）。

### Git Commits

| Hash | Message |
|------|---------|
| `2604419` | fix(web): drop the Trae promo badge from production builds |
| `7307468` | fix(web): remove the unreachable Projects page and the mock article fallback |
| `42b4a3b` | fix(web): replace the scaffold title and add a description |
| `f0adbf5` | chore(db): delete the broken migration 04 |
| `bf31c0f` | docs: correct two audit records and add the defect-fix task |
| `a4fb569` | fix(web): keep react-dev-locator out of production builds |
| `7b5ad31` | docs(task): withdraw the D1 patch and record the scoping error behind it |
| `c918c2d` | docs(spec): add migration rules and a verification checklist |

### Status

[OK] **Completed**


## Session 3: S1 数据层与读 API：两个 spike、六个阶段、一次推翻自己结论的独立复核
<!-- trellis-session: v=2 fp=515e7bcfd3bce672 -->

**Date**: 2026-09-28
**Task**: S1 数据层与读 API：两个 spike、六个阶段、一次推翻自己结论的独立复核
**Branch**: `feat/s0-foundation`

### Summary

自建后端第一个真正的数据层与读路径：自写迁移 runner（美元引号规则、强制成对 down、单事务批次、事务级 advisory lock；据此推翻父设计里的 node-pg-migrate 选型，因为该 CLI 自读 DATABASE_URL 会破坏配置单源）、schema v2 顺带修掉 D8/D9/D10、夹具+seed（7 类危险内容逐字节读回一致）、游标分页与 articles/comments/tags 三组分层读 API、前端读路径从 Supabase 切到自建 API 并补 @fastify/cors。SPIKE-1 用『故意写错返回值看 tsc 是否报错』确证类型真实推断，并顺带发现 S0 的 Redis 未 await connect 在关闭路径泄漏 socket 致进程永不退出（会卡死集成测试），已修并双向验证。独立复核重新构建与实测，抓出 6 个真缺陷并全部修复：CI 产物校验步骤因 job 级 env 而永挂、ORDER BY 缺 nulls last 使 keyset 索引失效（5000 行实测 2505 行排序 vs 10 行有界扫描）、标签过滤写成 = any(tags) 使 GIN 索引彻底是死代码（109 vs 10 buffers、1.767 vs 0.275 ms）、惰性 supabase 仍让首页在无凭据时白屏（我用 curl 拿 200 误判为可访问，SPA 壳 HTML 恰是检查清单警告过的假证据）、author.id 契约改了但消费方没改因脚本中途抛异常静默跳过后续编辑、评论写入后把 Supabase snake_case 行塞进 CommentNode 数组致渲染崩。另纠正一次自我验证：首次证 D3 时给全部 5000 行都打上被过滤标签，两种写法同计划同通过，属『删掉特性测试仍在过』的假测试，改用有选择性数据重做。沉淀规范：conventions §9 索引与 ORDER BY 匹配、GIN 仅服务 @>、小表测不出任何东西；§10 CI job 级 env 泄漏进每一步；检查清单新增三条静默无效的验证方式。api 62 测试全绿，lint/check/build 通过。

### Git Commits

| Hash | Message |
|------|---------|
| `bedfee1` | chore(task): archive 09-28-blog-portal-s1-read-api |
| `a3d5452` | docs(spec): reorder the checklist and point Related at the new sections |
| `b7810b5` | docs(spec): index rules, CI env scope, and three ways a check lies |
| `2d86b2e` | fix: correct six defects found by the independent S1 review |
| `78a94d6` | feat(web): read articles and comments from the portal API |
| `299a3d0` | feat(api): read tags through the article list; harden the test data assumptions |
| `31604f1` | feat(api): read comments through the article visibility rule |
| `f9172fe` | feat(api): layered articles read API with keyset pagination |
| `91ccf7f` | feat(api): seed hostile-content fixtures and a strict front-matter reader |
| `af6e3fd` | docs(task): record stage A results and the migration-runner reversal |
| `f159217` | feat(api): add schema v2 and a hand-written migration runner |
| `99f7e2d` | chore(shared): emit dist so the API can import runtime values |
| `eaabdaf` | chore(api): wire Zod as the validator and serializer compiler |
| `488f39d` | fix(api): release the redis socket when shutdown races an in-flight connect |
| `8806828` | chore(task): archive 09-24-fix-legacy-defects-a |
| `7b5ad31` | docs(task): withdraw the D1 patch and record the scoping error behind it |
| `a4fb569` | fix(web): keep react-dev-locator out of production builds |
| `bf31c0f` | docs: correct two audit records and add the defect-fix task |
| `f0adbf5` | chore(db): delete the broken migration 04 |
| `42b4a3b` | fix(web): replace the scaffold title and add a description |
| `7307468` | fix(web): remove the unreachable Projects page and the mock article fallback |
| `2604419` | fix(web): drop the Trae promo badge from production builds |

### Status

[OK] **Completed**
