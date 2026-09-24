# 个人博客生产化：个人门户 + 自建后端（学习项目）

## Goal / 用户价值

把当前「Vite SPA + Supabase BaaS」博客，改造成**个人门户 + 自建 Node/Fastify 分层后端**的生产级应用。

**不是"一个博客"，是一个个人门户，博客只是其中一个模块。** 门户聚合若干异构模块：个人信息、GitHub 项目展示、文章分享、自建 agent、自建游戏站、其他小站。

**本项目的真实交付物是「学到的生产技能」，门户是需要持续可用的载体。** 因此验收标准同时约束两件事：门户能用，且每个学习方向都有可验证的产出。

学习方向：鉴权与安全、API 与数据库、性能与可观测、交付与运维、高并发与负载均衡、前端 SSR 与工程化。

### 门户形态对学习目标的意义

多异构服务聚合到统一入口，使若干"为了学而学"的课题获得真实存在理由：

| 课题 | 在单体博客上 | 在门户上 |
|---|---|---|
| 反向代理 / 路径路由 | 多余 | 必需（把各模块挂到统一域名下） |
| 上游健康检查 / 熔断 | 无意义 | 真实需求（某模块挂了不该拖垮门户） |
| 负载均衡 | 无从施展 | 有多个上游可分流 |
| 共享鉴权 / SSO | 无收益 | 一次登录访问所有模块 |
| Docker Compose 编排 | 练习 | 必需品（服务数量足够多） |

---

## 背景

### 已确认的现状（代码实证）

- 前端：React 18 + TS 5 + Vite 4 + Tailwind 3，纯 CSR，无 SSR
- 后端：无。数据访问是前端拿 anon key **直连 Supabase**（`src/utils/articlesApi.ts`）
- 鉴权：Supabase Auth + GitHub OAuth，PKCE 流（`src/lib/supabase.ts`、`src/auth/githubAuth.ts`）
- 授权：Postgres RLS（`supabase/migrations/01`、`02`、`03`）
- 部署：Vercel（`vercel.json` 全量 rewrite 到 `index.html`）
- 数据库结构、RLS 策略、完整技术债清单见 `.trae/documents/technical_architecture.md`

### 既有缺陷（改造必须一并处理）

| 编号 | 缺陷 | 证据 |
|---|---|---|
| D1 | 🔴 `is_admin()` 读 `user_metadata`，任何登录用户可通过 `updateUser({data:{user_name:'guoshaoran'}})` 提权 | `supabase/migrations/03_update_is_admin.sql` |
| D2 | 🔴 生产构建注入 Trae 推广角标（`prodOnly: true`，本地不可见） | `vite.config.ts:24` |
| D3 | 🟠 `Projects.tsx` 双重死代码：无路由，且使用的 `skin` 色板在 Tailwind 中不存在 | `src/App.tsx`、`tailwind.config.js` |
| D4 | 🟠 文章详情仍 import `mockData` 兜底 | `src/pages/ArticleDetail.tsx:7` |
| D5 | 🟠 迁移 04 是坏 SQL（单引号内含 `'JavaScript'`），已被 05 重写，应删除 | `supabase/migrations/04_update_article_style.sql` |
| D6 | 🟠 文章列表无分页，`select *` 全表拉取 | `src/utils/articlesApi.ts:15` |
| D7 | 🟠 零 SEO：`index.html` 无 description/OG，标题仍为 `<title>My Trae Project</title>` | `index.html:7` |
| D8 | 🟡 评论无 `parent_id`（PRD 要的嵌套回复未做）；管理员不能删他人评论 | `supabase/migrations/01_init_comments.sql` |
| D9 | 🟡 无 `published`/`published_at`，草稿与定时发布不可用 | `articles` 表结构 |
| D10 | 🟡 评论靠 `article_slug` 字符串关联，无外键，改 slug 即孤儿 | `supabase/migrations/01_init_comments.sql` |
| D11 | 🟡 GitHub 仓库数据由浏览器直连 API 拉取，`provider_token` 刷新后失效 → 回退硬编码快照 | `src/pages/Home.tsx:18,52` |

### 模块现状

| 模块 | 现状 | 本项目需做 |
|---|---|---|
| 文章分享 | ✅ 已实现（现有 Vite 博客，数据在 Supabase） | 迁到自建 API + 补齐内容能力（R2） |
| GitHub 项目展示 | ✅ 已实现，但脆弱（浏览器直连 API，token 失效即回退硬编码快照，D11） | 迁到服务端抓取 + 缓存（修复 D11） |
| 个人信息 | ⚠️ 仅有首页简介，无独立模块 | 建 |
| 自建 agent | ✅ 代码已写好，未接入门户。独立仓库 `C:\Users\15532\Desktop\xj\my-agent`（自带 git / Trellis / CLAUDE.md）。**技术栈：Python + FastAPI 后端（:8000）+ Vite + React + @ant-design/x 前端（:5173），双进程** | 接入门户（R13） |
| 自建游戏站 | ❌ 未开始 | 见决策 Q9 |
| 其他小站 | ❌ 未开始 | 见决策 Q9 |

### 项目约束

- 远程仓库：`git@github.com:Freedom0x0/MyBlog.git`，单分支 `main`，单次提交
- 无本地 Vercel 关联（无 `.vercel`），无生产部署证据，**无真实读者** → "改造期间保持线上可用"不构成硬约束（仍按增量迁移执行，成本为零）
- 时间投入：**每周 10 小时以上**
- Trellis spec 现状：仅 `frontend` 层，且 6 个文件全为 `Status: To fill` 空模板；**后端 spec 完全缺失**

### agent 模块的实证结论

门户需面向**两个技术栈完全不同**的服务做聚合（门户 Node/TS，agent Python/FastAPI）。由此确定三条硬约束：

1. **接入契约必须与模块技术栈无关**——只约束「入口地址 + 健康检查 + 鉴权约定」，不约束模块用什么语言实现。这条原为推测，已由 agent 的 Python 栈证实为必需。
2. **子路径部署需每个模块配合改造**：FastAPI 需配 `root_path` 与 `--proxy-headers`；Vite 需配 `base`。配错的后果是白屏或资源 404，**不是配置报错**。这是接入每个模块的主要工作量。
3. **跨仓库编排**：agent 位于门户仓库之外（同级目录 `../my-agent`），本地 Compose 如何引用它是真实设计问题。

---

## 需求

### 产品需求

- **R1 · 增量可用**：改造全程门户保持可访问。每个阶段结束时必须存在一个能跑的版本，允许随时叫停而不产生烂尾。
- **R2 · 内容模块补齐**：标签页 / 分类页 / 归档页、列表分页、草稿与发布状态、图片上传。
- **R3 · 缺陷修复**：D1–D11 全部处理，其中 D1、D2 为 P0 优先。
- **R4 · 脱离 BaaS SDK**：改造完成后，读路径与写路径均不经过 Supabase SDK；前后端共享类型定义。
- **R13 · 门户外壳与模块接入契约**：定义统一入口、模块清单与模块元数据（标题 / 图标 / 入口地址 / 健康检查地址 / **嵌入模式**），以及每个模块的接入方式。**契约先行，模块逐个接入。**
- **R16 · 双入口**：每个模块既可被门户页面内访问（嵌入），也可独立直访（同域路径）。**两者是同一个 URL，不做两套集成。**
- **R17 · 设计令牌统一**：各模块共享一份技术栈无关的设计令牌（CSS 变量 + tokens JSON），保证"看起来是一个站"。**不统一组件库**——三种模块是三种不同的 UI 问题。
- **R14 · 模块隔离与容错**：任一模块不可用时，门户其余部分与其他模块不受影响。门户须感知模块健康状态并优雅降级（而非整页报错）。
- **R15 · 统一鉴权**：一次登录可访问受保护模块；模块间鉴权状态共享，但各模块的授权边界独立可配。

### 学习需求（本项目的核心交付物）

- **R5 · 鉴权与安全**：自实现 GitHub OAuth 授权码流、JWT 签发 / refresh 轮换 / 吊销、权限中间件、越权测试。
- **R6 · API 与数据库**：手写 routes→controllers→services→repositories 分层、REST 资源契约、统一错误码、DTO 校验、迁移工具链与回滚、事务、连接池、索引与执行计划。
- **R7 · 性能与可观测**：Redis 缓存与失效策略、限流、ETag/Cache-Control、结构化日志、请求追踪、指标与健康检查。
- **R8 · 交付与运维**：Docker 化、CI/CD、环境隔离、灰度与回滚、密钥管理、自建部署。
- **R9 · 高并发与负载均衡**：多实例水平扩容、反向代理负载均衡、无状态设计验证、连接池与 `max_connections` 约束处理、缓存击穿防护。
- **R10 · 有证据的学习**：每个学习方向必须有可验证产出（压测报告 / 测试用例 / runbook），不接受无证据的"已完成"。

### 学习方式的约束

- **R11 · 手写优先于框架**：分层、中间件、校验、鉴权均自行实现，不使用 NestJS 等把这些问题预先解决的框架。目的是理解"为什么需要这一层"，而非"如何调用别人做好的装饰器"。
- **R12 · 压测驱动**：个人博客无自然流量。性能与并发相关结论必须由人为制造的量级支撑（k6 或 autocannon），否则不构成学习成果。

---

## 关键决策

| # | 问题 | 结论 | 理由与代价 |
|---|---|---|---|
| Q1 | 运行环境 | **本地 Docker Compose 起步，真实云主机推迟到 S8 再决定** | 本地 `--scale api=N` + nginx 反代即可覆盖负载均衡学习，零成本。代价：systemd/防火墙/TLS/域名这一层真实运维推迟；若 S8 最终不上真机，需显式记录未覆盖项 |
| Q2/Q3 | Postgres、对象存储 | **自建 Postgres 容器 + MinIO（S3 兼容）**，均为 Compose 服务 | 由 Q1 推出，零成本 |
| Q4 | 前端范围 | **纳入学习范围** | 用户明确"前后端都学" |
| Q5 | 时间投入 | **每周 10 小时以上** | 决定阶段粒度取 1–2 周 |
| Q6 | `guoshaoran` / `Freedom0x0` 账号关系 | **由设计消解，无需确认** | D1 修复时管理员标识改为数据库列 / `app_metadata`，不硬编码用户名，两种账号情形均可覆盖 |
| Q7 | 模块现状 | 文章 ✅、GitHub 展示 ✅、agent 代码已写好待接入、个人信息未做、游戏站与其他小站未做 | 本项目需做：集成已有三个模块 + 建个人信息模块 |
| Q8 | 模块接入方式 | **路径反向代理为主 + 子域跳转作逃生舱**；接入模式写进契约，由模块自己声明 | 保住反代 / 负载均衡 / 统一鉴权的学习价值，同时不让配不了子路径的模块阻塞门户。代价：契约需处理两种模式，子域模式下需跨域传 token |
| Q9 | 游戏站与其他小站 | **纳入范围，但排到所有阶段之后；建议届时拆为独立父任务** | 两站从零开始，与门户真正共享的只有接入契约。满足 R1 的逐步可停原则 |
| Q10 | 首页形态 | **改造成门户 hub**：上半部模块卡片，下半部最新文章；文章列表移到 `/blog` | 符合"不止展示文章，做成几个模块"的意图；否则"门户"这层名不副实，S5 的网关工作也失去展示面。代价：博客阅读感被削弱 |
| Q11 | 组件库与视觉统一 | **统一设计令牌，不统一组件库** | 实测：门户 Tailwind 3、agent antd 6 + @ant-design/x、游戏是 canvas——三种不同的 UI 问题。但两边都已有 CSS 变量令牌层且浅色底同为暖白系，统一成本低。形式必须是 CSS 变量 + JSON（技术栈无关），不能是 React 组件包 |

技术设计见 `design.md`，执行顺序见 `implement.md`。

---

## 验收标准

### 门户可用性

- [ ] 每个阶段结束时可产出可访问版本，且 `npm run build` 与 `npm run check` 通过
- [ ] 读路径与写路径均不经过 Supabase SDK（可通过全局搜索 `@supabase/supabase-js` 使用点验证）
- [ ] 生产构建产物中不包含 Trae 角标（D2）
- [ ] 非管理员账号无法增删改任何文章（D1，有对应越权测试）
- [ ] `GET /` 门户、`/blog`、`/agent` 三条路径全部可访问（R13）
- [ ] 停止 agent 服务后，门户首页仍可访问且该模块显示降级状态（R14）
- [ ] 首页是门户 hub（模块卡片 + 最新文章摘要），文章列表位于 `/blog`（Q10）
- [ ] 每个模块都可通过同域路径**独立直访**，无需先经过门户跳转（R16）
- [ ] agent 以 iframe 嵌入门户页面时**自动处于已登录态**（验证同源 cookie 生效），且模块响应不设 `X-Frame-Options: DENY`（R15/R16）
- [ ] 游戏模块走 `link` 整页跳转（不被 iframe 包裹），键盘与全屏 API 正常（R13 的 `embed` 契约）
- [ ] 门户与 agent 消费同一份设计令牌值，浅色与深色模式下两边观感一致（R17）

### 学习产出（每项需可验证）

- [ ] 登录由自建后端签发 JWT；refresh token 轮换可验证（旧 token 复用被拒绝，且整条 token 家族被撤销）
- [ ] 存在越权测试用例集且全部通过（R5）
- [ ] 存在迁移工具链，且任一迁移可回滚（`migrate:down` 可执行）
- [ ] 存在 k6 压测报告，含**单实例 vs 多实例**对比数据（R9）
- [ ] 存在**缓存加与不加**的对比数据，且说明失效策略（含击穿/雪崩/穿透处理）（R7）
- [ ] 单条 `docker compose up` 可在本地起全套环境（API 双实例 + Postgres + Redis + MinIO + 网关 + agent 双进程）
- [ ] 无状态验证：停掉一个 API 实例，服务无感知、无 401、无数据错乱（R9）
- [ ] CI 在 PR 上跑通 lint + 单测 + 集成测试（R8）
- [ ] 存在可观测性证据：结构化日志含请求 ID、`/health` 与 `/ready` 端点、关键指标可查（R7）
- [ ] 存在一份部署 runbook：含上版、回滚、密钥轮换步骤（R8）
- [ ] 接入契约成文，且经 agent 模块真实接入检验（R13）

### 文档

- [ ] `.trae/documents/technical_architecture.md` 的 §8 与 §10 已更新（当前内容基于"留在 Supabase"的旧结论，与本设计冲突）
- [ ] `.trellis/spec/backend/` 建立（当前仅有空模板的 frontend 层，后端 spec 完全缺失）

---

## 不在范围内

- 微服务拆分：单体分层已足够覆盖本项目全部学习目标
- Kubernetes：容器编排的复杂度会淹没学习重点，本地 Compose 多实例足以覆盖负载均衡学习
- 微前端（Module Federation）：iframe 与反代已覆盖需求；微前端的收益在"多团队独立发布"，本项目无此问题
- ORM（Prisma / Drizzle）：会隐藏本项目最想学的执行计划、索引、N+1、事务隔离
- 会员 / 付费 / 多租户
- 自研 Markdown 编辑器（`@uiw/react-md-editor` 可用）
- 标签关联表规范化：`tags text[]` + GIN 索引在博客量级足够
- 全文搜索上外部引擎（如 Meilisearch）：Postgres `tsvector` 足够
- 消息队列中间件（Kafka / RabbitMQ）：后台任务先用 Redis 承载，最后阶段再评估
