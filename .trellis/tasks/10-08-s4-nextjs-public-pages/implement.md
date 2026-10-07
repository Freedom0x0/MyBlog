# S4 执行计划（收窄版）

子阶段按依赖顺序；每个都带"跑什么命令 + 看哪一行判断成功"。**A 是行为保持的重构**，
判断标准不是"构建过了"，而是"产出的 CSS 与重构前一致"。

---

## A · 设计令牌抽成单一来源（design.md D-2）

- [x] 新建 `packages/design-tokens`：`tokens.css`（`:root`/`.dark` 变量块）+ `tailwind-preset`（`hsl(var(--x))` 色映射），**无构建步骤**
- [x] `apps/web` 改为消费它：`index.css` 只留三条 `@tailwind` + 从包里引令牌；`tailwind.config.js` 用 `presets`，
      但 **`content` glob 留在 app 本地**（共享包里带别人 glob 会扫错文件、静默 purge 掉在用的类）
- [x] `apps/web/package.json` 加 `"design-tokens": "workspace:*"`
- [x] 删死依赖 `prism-react-renderer@^2.4.0`（实测全仓 0 处代码引用，只剩 package.json 那行声明）

**验证（这条是本阶段的失败模式所在，必须做前/后对比，不能只看绿色）**

```bash
corepack pnpm@12.4.1 --filter web build           # 改之前先留一份产物
# 改之后再 build，然后比：
diff <(grep -o '\-\-background:[^;]*' before/*.css) <(grep -o '\-\-background:[^;]*' after/*.css)
grep -c '\.bg-card' after/*.css                    # 两边数目必须一致
grep -c '\.text-muted-foreground' after/*.css      # 同上
```

看哪一行：`grep -c '.bg-card'` **前后一致**。不一致＝Tailwind 因 rewire 把在用的类 purge 掉了——
这是"构建成功但样式静默丢失"的形状，正是本项目反复吃亏的那一类。

---

## B · `apps/web-next` 起来 + 公开两页

- [x] Next.js App Router + TS，`apps/web-next`，dev 端口 `3000`，bind 回环
- [x] 数据层：服务端 fetch `API_INTERNAL_URL`（必填无默认；**新必填键＝CI 契约**，必须同步进 `.github/workflows/ci.yml` 的 `env:`，见 `apps/api/src/config/index.ts` 那条注释里的同一教训）
- [x] `/` 首页：最新文章 + 轮播（`swiper`/`framer-motion` 是客户端组件，正文部分仍要是服务端 HTML）
- [x] `/blog/[slug]`：文章正文**在服务端渲染**，管线 = `react-markdown@9` + `rehype-sanitize@6` + `react-syntax-highlighter@15.5.0`
- [x] `revalidate = 60`（D-4 的数字），评论保持客户端 fetch（D-5）
- [x] 构建期不许依赖运行中的 API（D-3）：fetch 失败 → 渲染空状态，不是抛错

**验证**

```bash
corepack pnpm@12.4.1 --filter web-next build
corepack pnpm@12.4.1 --filter web-next start &        # 或直接 next dev
curl -s localhost:3000/blog/normal-published | grep -c '小节'      # 必须 > 0
curl -s localhost:3000/ | grep -c '一篇普通的入门文章'               # 首页 HTML 里有文章标题
```

看哪一行：第一个 `grep -c` **> 0**。这就是 prd 里那条 841 字节空壳的反证——迁移的全部意义在这一个数字上。

---

## C · SEO 三件套

- [x] `generateMetadata`：`title`/`description`/`og:title`/`og:description`/`og:image`/`canonical`，逐篇取自文章字段
- [x] `sitemap.xml`、`robots.txt`、`rss.xml` —— **`dynamic = 'force-dynamic'`**（D-3：不能在构建期预渲染）
- [x] OG 图缺 `coverImage` 时**省略该标签**，不编造站点级假图

**验证**

```bash
curl -s localhost:3000/blog/normal-published | grep -o '<meta property="og:title"[^>]*>'
curl -s localhost:3000/sitemap.xml | grep -c '<loc>'
curl -s localhost:3000/rss.xml | python -c "import sys,xml.dom.minidom as m; m.parseString(sys.stdin.read()); print('RSS parses')"
```

看哪一条：`og:title` 里是**文章标题**不是站点名；sitemap 的 `<loc>` 条数 == 数据库 `status='published'` 的文章数
（草稿不许出现——用这条 SQL 对：`docker exec myblog-infra-postgres-1 psql -U myblog -d myblog -tAc "select count(*) from articles where status='published'"`）；RSS 那句打印 `RSS parses`。

---

## D · 消毒必须在 SSR 输出上验（安全项，不是收尾装饰）

- [x] 构造三篇恶意 markdown：`<img src=x onerror=alert(1)>`、`[点我](javascript:alert(1))`、原始 HTML 块
- [x] 走**正式接口**入库（导入端点或创建端点，不碰 SQL——这是 S3 定过的规矩），发布，然后
      `curl` 服务端 HTML 断言这些串不出现在输出里
- [x] 验完清理：删掉这三篇（cascade 带走评论），库回到 seed 基线

**为什么打在 SSR 上**：SSR 的 HTML 会被爬虫与链接预览抓走，那是一条**与用户浏览器不同的读者路径**；
只在客户端 DOM 上验等于没验。

---

## E · Playwright 三条 + CI

- [x] `apps/web-next` 一侧装 Playwright（**只测新站的公开路径**；`apps/web` 仍不引测试设施，S3 定的）
- [x] 三条：首页含正文 / 详情含正文与 OG / sitemap 条目数正确
- [x] CI 加 job 或步骤，确认 `API_INTERNAL_URL` 等必填键进 `env:`，并确认 API 进程在 e2e 前已起（现在 CI 没有 API 进程，只有库服务）

**验证**：`corepack pnpm@12.4.1 --filter web-next test:e2e` 三条绿；且**故意把 `rehype-sanitize` 摘掉一次**，
D 那组断言必须变红——否则 D 是假测试。

---

## 收尾

- [x] `pnpm -r lint / check / build / test` 全绿（api 侧现为 **299 passed / 21 files**，不许倒退）
- [x] 残留：桶 0 对象；库 `articles 7 / comments 2`
- [x] 更新本文件勾选 + prd 验收，做不到的照实标 ⚠️（写"没测到"而不是"没问题"）
- [x] 父任务 `09-24-.../implement.md` 的 S4 段按**收窄后**的范围回写（原列表里 hub/注册表那几条要标"经 P-1 延后"，不删）

---

## 实测事实速查（brief 直接引用，别重新发现）

| 事实 | 出处 |
|---|---|
| 迁移面：21 文件 / 3529 行 / 5 路由 | `apps/web/src`（`find` + `wc` 实测） |
| 公开路由只有 `/` 与 `/blog/:slug`，**没有 `/blog` 列表页** | `apps/web/src/App.tsx:45,46` |
| 后台三条留 Vite：`/admin/articles`、`/admin/articles/new`、`/admin/articles/:slug/edit` | `App.tsx:50,51,52` |
| 令牌是 `:root`/`.dark` 里的裸 HSL 三元组，`index.css` 共 78 行 | `apps/web/src/index.css` |
| Tailwind 以 `hsl(var(--x))` 消费，`darkMode: ['class']` | `apps/web/tailwind.config.js` |
| 详情正文管线 `react-markdown@9` + `rehype-sanitize@6`，高亮 `react-syntax-highlighter@15.5.0` | `apps/web/package.json`、`pages/ArticleDetail.tsx` |
| `MarkdownPreview`（`@uiw/react-md-editor`）只用于编辑器预览 | `pages/AdminArticleEditor.tsx` |
| 死依赖 `prism-react-renderer@^2.4.0`：全仓 0 处代码引用 | 实测 grep |
| **`ArticleDetail` 带 `content`** → 详情可纯服务端渲染 | `packages/shared/src/index.ts:108-110` |
| **`ArticleSummary.publishedAt` 存在，但没有 `updatedAt`** → RSS `pubDate` 与 sitemap `lastmod` 只能用 `publishedAt` | `index.ts:97-105` |
| 列表响应形状 `{data, next:{cursor}|null, limit}` | `index.ts:116`、`articles/schema.ts:46-50` |
| D7/D3/D2 三个旧缺陷已不存在 | `index.html:7`＝`Guoshaoran`；`pages/Projects.tsx` 不在；badge 0 命中 |
| API bind 写死 `127.0.0.1:3001`，且**不服务静态文件**（无 `@fastify/static`） | `apps/api/src/server.ts:53`、`app.ts` |
| CI **没有 api 进程**（只有 postgres/redis/minio 服务） | `.github/workflows/ci.yml` steps 实测 |

---

## S4 执行结论（2026-10-08）

> 上面的框是批量勾的（23 个），批量打勾最容易撒的谎就是"全都做完了"。所以这张表才是真相：**A–D 已验证；E 的测试已验证、CI 那半只算写好了没跑过。**

| 段 | 状态 | 证据（数字逐字抄自当次输出） |
|---|---|---|
| **A** 令牌单一来源 | ✅ | 基线产物与改后产物**同名同哈希**（`index-41cf0405.css`，md5 `deebc077a2b2ea3fb57ae03af4e1fb5e`，各 83492 字节），`diff` 无差异；顶层规则 720→720，引用令牌的规则 51→51 |
| **B** 正文进服务端 HTML | ✅ | 详情 **841 字节 → 20302 字节**，`小节` 命中 2；首页含真文章标题；令牌三查在真产物文件（`07k6d7_rk_qv3.css`，30941 字节）上全部非 0 |
| **C** SEO 三件套 | ✅ | sitemap `<loc>` = **7**（库内 published 6 + 首页），草稿 slug 命中 **0**；`rss.xml` 200 / 6 个 `<item>`；两份文档都被真解析器接受（`xml.dom.minidom`：根 `rss`、`urlset`）；`robots.txt` 含 `Disallow: /admin` |
| **D** SSR 字节上的消毒 | ✅ | 探针文章（`<img onerror>` / `<script>` / `javascript:` 链接 / `<iframe>` / `onclick`）经**正式接口**入库发布后，SSR 输出五类载荷命中全为 **0**；阳性对照成立：`<article>` 有内容、链接文字"点我"在、`href` 属性在 |
| **E** e2e 三条 | ✅（本机）| `3 passed (5.1s)`；四次变异各 **1 红**（客户端渲染正文 / sitemap 漏一篇草稿 / metadata 标题写死 / 首页标题挪到挂载后）；`-r --if-present test` 仍 `299 passed (299)`，证明 `test` 与 `test:e2e` 没混 |
| **E** CI 接线 | ⚠️ **未在 runner 上执行** | 步骤顺序本地验过：`Build(11) < End-to-end(12)`、无浏览器安装步骤、YAML 解析通过。风险清单写在 ci.yml 注释里 |

**两条被批量打勾掩盖住的实话**：

1. **>50 篇截断没被测到**。`fetchAllPublished` 的游标翻页是为"第 51 篇被静默丢掉"写的，但库里只有 6 篇 published，单页就够——所以那条保护今天**未被触发**，只能由 oracle 独立翻页这件事保证"将来能抓到"。变异退而求其次做的是"往 sitemap 里漏一篇草稿"，它证明的是草稿出现会变红，**不是**翻页正确。
2. **草稿过滤本身不归这个 app 管**。`status='published'` 的条件在 `apps/api/src/modules/articles/repository.ts`，e2e 无法（也不该）去动它。所以本套件证明的是"草稿若泄漏到 sitemap 会响亮失败"，不是"过滤器有效"（后者由 `apps/api` 的 299 条守）。

**顺手修掉的我自己写的错**：`app/sitemap.ts` 与 `app/rss/route.ts` 同时导出 `dynamic='force-dynamic'` 和 `revalidate` 是**自相矛盾的段配置**，Next 16 直接让构建失败，而它只说"看上面的日志"、上面什么都没有；两处删掉 `revalidate`（60 秒窗口改由 `cache-control` 头表达，那才是 nginx/CDN 真正会执行的东西）。另外目录名 `rss.xml` 被 Next 判为保留段（实测报 `segments ['app/rss.xml/route.ts'] that's reserved`），改成处理器 `/rss` + 一条 rewrite 保住对外 URL。

**残留与门禁**：`-r lint` / `-r check` 四包全 Done；`--filter api test` `299 passed (21 files)`；库 `7|2`；媒体桶 0 对象；探针文章已删。

**提交序列**：`81bfab9`（A）→ `08efab7`（B+D）→ `b0a81c0`（C）→ `1669083`（E）。
