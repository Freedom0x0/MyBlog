# 执行计划：阶段路线图

> 技术设计见 `design.md`，需求见 `prd.md`。本文只写"按什么顺序做、做完怎么验、哪里可以停"。
>
> **每个阶段 = 一个可独立验收、可独立叫停的交付物 = 一个子任务的候选。**
> 阶段边界即停靠点：任何一格喊停，门户都处于可用状态。

---

## 阶段总览

| 阶段 | 主题 | 主要学习目标 | 预计 |
|---|---|---|---|
| S0 | 地基 | Docker Compose、配置校验、结构化日志、健康检查、CI | 1 周 |
| S1 | 数据迁移 + 文章读 API | SQL 迁移、分层、DTO 校验、统一错误、游标分页 | 1–2 周 |
| S2 | 鉴权 | OAuth 授权码流、JWT、refresh 轮换与复用检测、越权测试 | 1–2 周 |
| S3 | 写路径 + 文件 | 事务、对象存储、presigned URL、图片变体 | 1 周 |
| S4 | 前端迁移 + 门户 hub | Next.js App Router、SSG/ISR、模块注册表、设计令牌层、SEO | 2 周 |
| S5 | 网关 + 模块接入 + 令牌统一 | nginx 反代、子路径部署、iframe 嵌入、健康检查、容错、SSO | 1–2 周 |
| S6 | 性能与可观测 | 缓存与失效、击穿防护、限流、ETag、索引、指标、压测 | 1–2 周 |
| S7 | 负载均衡与并发 | upstream 分流、无状态验证、连接池约束、压测对比 | 1 周 |
| S8 | 交付与运维 | 多阶段镜像、CI/CD、环境隔离、灰度回滚、runbook | 1–2 周 |
| S9 | 游戏站与其他小站 | 契约复用与检验 | **另立父任务** |

> S9 是从零建两个应用，与门户真正共享的只有接入契约。**建议在执行到 S8 时把它拆成独立父任务**，而不是塞在本任务尾部——否则本任务永远无法归档。

---

## S0 · 地基

**产出**：`docker compose up` 起 Postgres + Redis + 空 API；`/health`、`/ready` 返回 200；CI 在 PR 上跑 lint + tsc + 单测。

- [ ] 仓库重构为 pnpm workspace：`apps/web`、`apps/api`、`packages/shared`，迁移现有 Vite 代码进 `apps/web`（此时先保持 Vite，S4 再换 Next.js）
- [ ] `infra/docker-compose.yml`：Postgres、Redis 两个基础设施服务
- [ ] `apps/api` 骨架：`server.ts` / `app.ts` / `config/` / `plugins/` 目录就位
- [ ] 配置校验：启动时用 Zod 解析环境变量，缺项**立即退出**并打印缺哪个
- [ ] pino 日志 + 请求 ID 插件（读入或生成 `x-request-id`）
- [ ] `/health` 与 `/ready`（后者检查 Postgres + Redis 连通）
- [ ] 统一错误处理器骨架（`{ error: { code, message, requestId } }`）
- [ ] 后端 spec 文档起步：`.trellis/spec/backend/` 建立，先写分层纪律与目录约定
- [ ] CI：GitHub Actions 跑 lint + `tsc --noEmit` + 单测

**验证**：

```bash
docker compose up -d
curl -s localhost:3001/health    # 期望 {"status":"ok"}
curl -s localhost:3001/ready     # 期望含 postgres/redis 均为 ok
# 故意删掉一个必需环境变量重启，期望进程退出并打印缺失项名字
```

**风险/回滚**：仓库重构影响面大。做法是先建 workspace 骨架、把现有代码整体移入 `apps/web` 且**不改内部逻辑**，确认 `npm run build` 仍通过再继续。回滚点：重构前的 commit。

---

## S1 · 数据迁移 + 文章读 API

**产出**：`GET /api/v1/articles` 支持游标分页，数据来自自建 Postgres。

- [ ] 手写 SQL 迁移重建 schema，同时修掉 D8/D9/D10（见 `design.md` §5.2）
- [ ] 为每个迁移编写 `down`
- [ ] 从 Supabase 导出数据并导入；行数校验 + 抽样比对
- [ ] `articles` 模块四层：`schema.ts`（Zod DTO）/ `repository.ts`（SQL）/ `service.ts` / `routes.ts`
- [ ] 游标分页 + 标签过滤 + 状态过滤
- [ ] 集成测试：真实 Fastify app + 真实 Postgres（越权用例在 S2 补）
- [ ] 补一个 `docker compose` 服务跑测试库，避免污染开发数据

**验证**：

```bash
npm run migrate:up && npm run migrate:down   # 验证可回滚
psql "$DATABASE_URL" -c "select count(*) from articles"  # 与 Supabase 行数比对
curl -s 'localhost:3001/api/v1/articles?limit=5'
curl -s 'localhost:3001/api/v1/articles?limit=5&cursor=<上页返回值>'
```

**风险/回滚**：数据迁移是**最高风险步骤**。迁移前先 `pg_dump` 全量备份；导入失败即回退到备份，Supabase 侧数据不受影响（只读导出，不修改源）。

---

## S2 · 鉴权（学习密度最高，风险也最高）

**产出**：自建登录可用；越权测试集全绿；D1 修复。

- [ ] GitHub OAuth 授权码流（手写）：`state` 防 CSRF、code 换 token、取用户信息
- [ ] JWT access token 签发（15 分钟），refresh token 签发（30 天，随机不透明串，**哈希后存库**）
- [ ] **refresh 轮换 + 复用检测**：旧 token 复用即撤销整条 token 家族
- [ ] Redis denylist：登出时写入 access token 的 `jti`，TTL = 剩余有效期
- [ ] 权限中间件：`requireAuth` / `requireAdmin`
- [ ] **修复 D1**：管理员判定改查 `users.is_admin`，不读 `user_metadata`，不硬编码用户名
- [ ] 前端调通登录/登出（此阶段前端仍为 Vite）
- [ ] **越权测试集**（R5 硬性验收）：普通用户增删改文章、访问他人资源、伪造管理员身份 → 全部 401/403

**验证**：

```bash
npm test -- auth            # 含 refresh 轮换与复用检测用例
curl -s -X POST localhost:3001/api/v1/articles -d '{...}'   # 无 token → 401
# 用普通用户 token 重放 → 403
# 用已轮换过的旧 refresh token 再刷 → 期望整条家族被撤销
```

**风险/回滚**：手写鉴权出漏洞即真实越权。上线前专门过一遍 OWASP 会话管理清单。回滚点：D1 修复前 Supabase 的鉴权路径仍在（只读对照期内可切回）。

---

## S3 · 写路径 + 文件

**产出**：后台完全跑在自建 API 上；图片存 MinIO。

- [ ] 文章写 API（创建 / 更新 / 删除），事务包裹多表写入
- [ ] MinIO 服务加入 Compose
- [ ] presigned URL 直传：客户端向 API 要 URL → 直传 MinIO → 回调确认
- [ ] 图片尺寸变体（原图 + 缩略图）
- [ ] 评论 API，含 `parent_id` 嵌套读取（递归或一次取全再组树）
- [ ] 前端后台切到自建 API；修复 D4（拆掉 `mockData` 兜底）

**验证**：

```bash
# 上传走完整 presigned 流程，产物可在 MinIO 控制台看到
curl -s localhost:3001/api/v1/articles/<id>/comments   # 嵌套结构正确
```

**风险/回滚**：前端从此依赖自建 API。保留 Supabase 只读路径一个阶段，确认写路径稳定后再移除。

---

## S4 · 前端迁移 + 门户 hub

**产出**：门户 hub 上线；文章模块走 Next.js；SEO 生效；D7 修复；设计令牌层抽出来。

- [ ] `apps/web` 迁到 Next.js App Router
- [ ] **首页改造成门户 hub**：上半部模块卡片、下半部最新文章摘要；文章列表移到 `/blog`（Q10）
- [ ] 模块注册表（`design.md` §3.2 的类型，含 `embed` 字段）+ 首页渲染注册表
- [ ] **抽出设计令牌层**（`design.md` §3.5）：把现有 `index.css` 的 HSL 变量整理为规范令牌，同时产出 tokens JSON。这是 R17 的落地物，S5 交给 agent 消费
- [ ] 文章列表 / 详情用 **SSG + ISR**，按需 revalidate
- [ ] SEO：`generateMetadata` 输出 title/description/OG；`sitemap.xml`；`robots.txt`；RSS
- [ ] 修复 D7（`<title>My Trae Project</title>` 与零 meta）；修复 D3（`Projects.tsx` 死代码与不存在的 `skin` 色板）
- [ ] 个人信息模块落地
- [ ] 修复 D2：移除 `vite-plugin-trae-solo-badge`（迁到 Next.js 后自然消失，需确认产物中无残留）
- [ ] 修复 D8：评论嵌套 UI
- [ ] Playwright 覆盖门户关键路径

**验证**：

```bash
npm run build && npm start
curl -s localhost:3000/ | grep -c '模块'                    # 首页是 hub 而非文章列表
curl -s localhost:3000/blog | head                          # 文章列表已移到这里
curl -s localhost:3000/blog/<slug> | grep -o '<meta property="og:title"[^>]*>'
curl -s localhost:3000/sitemap.xml | head
# 查看页面源码确认正文 HTML 存在（非空 div）
```

**风险/回滚**：这是最大的一次性改动。做法：Next.js 版本与 Vite 版本**并行存在一段时间**，按页面逐个切换，不做大爆炸式替换。

---

## S5 · 网关 + 模块接入 + 令牌统一

**产出**：`/` 门户 hub、`/blog`、`/agent` 都通；agent 以 iframe 嵌入门户页面且已登录；agent 挂掉门户不崩；两边视觉一致。

- [ ] nginx 网关加入 Compose，`gateway/nginx.conf` 做路径路由
- [ ] agent 模块接入改造（`design.md` §4.3）：Vite `base: '/agent/'`、router basename、FastAPI `root_path` + `--proxy-headers`
- [ ] **iframe 嵌入**（`design.md` §4.2）：门户页面内嵌 `/agent/`，用 `postMessage` 解决高度自适应
- [ ] **确认 agent 响应允许被嵌入**：不设 `X-Frame-Options: DENY`，或在 CSP 中声明 `frame-ancestors`
- [ ] **给 agent 套上门户的设计令牌**（R17）：把 S4 产出的令牌映射进 agent 的 `styles.css` 变量与 antd `XProvider theme`，浅深色都要对
- [ ] 游戏模块走 `link` 模式（整页跳转，不嵌 iframe）—— 即便游戏站尚未建，先把注册表条目与降级 UI 做好
- [ ] 跨仓库编排：agent 镜像如何被门户 Compose 引用（构建后按 tag，或外部 build context）
- [ ] 健康检查聚合：门户探活各模块并缓存进 Redis
- [ ] 容错 UI：模块不可用显示"维护中"，不阻塞其他模块
- [ ] nginx `proxy_next_upstream` 与超时配置
- [ ] 统一鉴权（R15）：cookie 域共享方案；**验证同源 iframe 内自动已登录**
- [ ] **契约文档成文**：模块需要提供什么、门户保证什么

**验证**：

```bash
curl -s localhost/agent/ | head          # agent 前端资源路径正确（非 404）
curl -s localhost/agent/api/docs         # FastAPI OpenAPI 里 URL 带正确前缀
curl -sI localhost/agent/ | grep -i x-frame-options   # 不应为 DENY
docker compose stop agent-api
curl -s localhost/ | grep -c '维护中'     # 门户降级而非报错
docker compose start agent-api
# 浏览器里确认：iframe 内 agent 显示已登录；切换深浅色两边同步
```

**风险/回滚**：子路径配置易白屏（**症状是资源 404 或空白页，不是配置报错**）。每个模块接入独立提交、独立验证。回滚点：单个模块回退不影响门户。

---

## S6 · 性能与可观测

**产出**：压测数据 + 缓存对比数据；缓存加与不加都有据可依。

- [ ] 基线压测（k6）：单实例、无缓存的 P50/P95/P99 与吞吐
- [ ] Redis 缓存文章列表与详情；**写路径同步失效**
- [ ] 缓存击穿防护（空值缓存 + 互斥重建）；评估雪崩与穿透
- [ ] 限流（Redis 计数器，多实例共享）
- [ ] ETag / Cache-Control
- [ ] `EXPLAIN ANALYZE` 索引调优，记录优化前后对比
- [ ] 慢查询日志阈值化
- [ ] 指标端点：请求数 / 错误数 / 延迟分位
- [ ] **压测报告**：缓存加与不加的对比数字（R12 硬性验收）

**验证**：

```bash
k6 run infra/k6/articles.js                    # 记录基线
# 开启缓存后重跑，对比数字写入报告
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE select ..."   # 确认走索引
```

**风险/回滚**：缓存引入不一致。**先有压测数据再决定是否加缓存**，不凭感觉优化。缓存开关做成配置项，出问题可立即关闭。

---

## S7 · 负载均衡与并发

**产出**：分流生效证据；无状态验证；压测对比。

- [ ] nginx `upstream` 配 `portal-api-1` / `portal-api-2`，轮询分流
- [ ] **无状态验证**：`docker compose stop portal-api-1`，服务无感知、无 401、无数据错乱
- [ ] 审查全部共享状态确已入 Redis（**这是无状态验证失败的最常见原因**）
- [ ] 连接池：`N 实例 × pool_size` vs Postgres `max_connections` 的约束推导，记录实际数字
- [ ] 评估 PgBouncer（是否引入取决于上面的约束是否真的撞上）
- [ ] **必修点：Docker DNS vs 静态 upstream**——两条路都实现一遍，对比 `--scale` 下新实例收不到流量的现象（`design.md` §1.3）
- [ ] 压测对比：单实例 vs 双实例的吞吐与延迟

**验证**：

```bash
curl -s localhost/api/v1/health   # 重复调用，响应中实例标识应在 api-1/api-2 间切换
docker compose stop portal-api-1
k6 run infra/k6/articles.js       # 期望无明显错误率上升
```

**风险/回滚**：连接池耗尽会导致全站 5xx。上线前先用压测把 `max_connections` 边界摸清楚。回滚点：nginx 配置改动可单文件回退。

---

## S8 · 交付与运维

**产出**：镜像 + CI/CD 流水线 + runbook；真机部署决策点。

- [ ] 多阶段 Dockerfile：构建与运行分离，镜像瘦身，非 root 用户运行
- [ ] CD：镜像构建 → 推送 → 部署；环境隔离（dev / staging）
- [ ] 灰度与回滚：换镜像 tag 的回滚路径验证
- [ ] 密钥管理：不再有 `VITE_*` / `NEXT_PUBLIC_*` 形式的私密值；`.env` 不入库
- [ ] **runbook**：上版、回滚、密钥轮换、故障排查步骤（R8 硬性验收）
- [ ] **真机部署决策点**：评估是否上云主机。若上，补齐 TLS、域名、systemd/编排、防火墙；若不上，在文档中显式记录哪些学习目标未覆盖
- [ ] 更新 `.trae/documents/technical_architecture.md` 的 §8 与 §10（当前内容基于"留在 Supabase"的旧结论，与本设计冲突）

**验证**：

```bash
docker build -t portal-api:s8 apps/api && docker run --rm portal-api:s8
docker image ls portal-api:s8        # 确认体积合理
# 按 runbook 完整演练一次回滚
```

**风险/回滚**：CD 首次接入易把线上打挂。先在 staging 演练全流程。回滚 = 换 tag + 跑 down 迁移（runbook 中固化）。

---

## S9 · 游戏站与其他小站

**产出**：按契约接入的最小可用站点。

> **建议拆为独立父任务**。此处只保留准入条件与验收，具体规划在其自身任务中进行。

- [ ] 前置：S5 的接入契约已成文，且已成功接入 agent（证明契约可用）
- [ ] 前置：S8 的镜像与 CD 流水线可复用
- [ ] 逐站接入，每站独立可交付
- [ ] **契约检验**：记录契约有哪些地方不够用、做了哪些修改——这是本项目最有价值的一份复盘

---

## 执行前的必办事项

以下事项**必须在 `task.py start` 之前完成**：

- [ ] **用户对最终规划摘要的显式批准**（本计划的评审门）
- [ ] 按阶段拆分子任务：**先建 S0 子任务**并以其为实施目标；父任务不做直接实施。S1 之后的子任务在上一阶段完成后再建，避免为 10 个阶段预先写 10 份猜测性 PRD
- [ ] 校准 `implement.jsonl` / `check.jsonl`：当前仓库可引用的**真实**参考文档只有 `.trae/documents/technical_architecture.md`（含 D1–D11 的完整证据与行号）与 `.trellis/spec/guides/` 下的思维指南。`.trellis/spec/frontend/` 6 个文件全是 `Status: To fill` 空模板，**不可引用**。后端 spec 需在 S0 实际写出后方可作为后续阶段的上下文
- [ ] 确认 Supabase 项目的当前可用性与数据完整性（若项目已因不活动被暂停，需先恢复才能导出数据）

---

## 全局纪律

- **每阶段结束打 git tag**，作为回滚锚点
- **每个迁移都必须有 `down`**，无 down 的迁移不予合入
- **共享状态只允许进 Redis**，模块级可变全局量视为 bug
- **性能结论必须有压测数据**，不接受"应该会更快"
- **每个阶段结束时门户必须可访问**，这是 R1 的硬性含义
