# S4 执行计划（收窄版）

子阶段按依赖顺序；每个都带"跑什么命令 + 看哪一行判断成功"。**A 是行为保持的重构**，
判断标准不是"构建过了"，而是"产出的 CSS 与重构前一致"。

---

## A · 设计令牌抽成单一来源（design.md D-2）

- [ ] 新建 `packages/design-tokens`：`tokens.css`（`:root`/`.dark` 变量块）+ `tailwind-preset`（`hsl(var(--x))` 色映射），**无构建步骤**
- [ ] `apps/web` 改为消费它：`index.css` 只留三条 `@tailwind` + 从包里引令牌；`tailwind.config.js` 用 `presets`，
      但 **`content` glob 留在 app 本地**（共享包里带别人 glob 会扫错文件、静默 purge 掉在用的类）
- [ ] `apps/web/package.json` 加 `"design-tokens": "workspace:*"`
- [ ] 删死依赖 `prism-react-renderer@^2.4.0`（实测全仓 0 处代码引用，只剩 package.json 那行声明）

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

- [ ] Next.js App Router + TS，`apps/web-next`，dev 端口 `3000`，bind 回环
- [ ] 数据层：服务端 fetch `API_INTERNAL_URL`（必填无默认；**新必填键＝CI 契约**，必须同步进 `.github/workflows/ci.yml` 的 `env:`，见 `apps/api/src/config/index.ts` 那条注释里的同一教训）
- [ ] `/` 首页：最新文章 + 轮播（`swiper`/`framer-motion` 是客户端组件，正文部分仍要是服务端 HTML）
- [ ] `/blog/[slug]`：文章正文**在服务端渲染**，管线 = `react-markdown@9` + `rehype-sanitize@6` + `react-syntax-highlighter@15.5.0`
- [ ] `revalidate = 60`（D-4 的数字），评论保持客户端 fetch（D-5）
- [ ] 构建期不许依赖运行中的 API（D-3）：fetch 失败 → 渲染空状态，不是抛错

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

- [ ] `generateMetadata`：`title`/`description`/`og:title`/`og:description`/`og:image`/`canonical`，逐篇取自文章字段
- [ ] `sitemap.xml`、`robots.txt`、`rss.xml` —— **`dynamic = 'force-dynamic'`**（D-3：不能在构建期预渲染）
- [ ] OG 图缺 `coverImage` 时**省略该标签**，不编造站点级假图

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

- [ ] 构造三篇恶意 markdown：`<img src=x onerror=alert(1)>`、`[点我](javascript:alert(1))`、原始 HTML 块
- [ ] 走**正式接口**入库（导入端点或创建端点，不碰 SQL——这是 S3 定过的规矩），发布，然后
      `curl` 服务端 HTML 断言这些串不出现在输出里
- [ ] 验完清理：删掉这三篇（cascade 带走评论），库回到 seed 基线

**为什么打在 SSR 上**：SSR 的 HTML 会被爬虫与链接预览抓走，那是一条**与用户浏览器不同的读者路径**；
只在客户端 DOM 上验等于没验。

---

## E · Playwright 三条 + CI

- [ ] `apps/web-next` 一侧装 Playwright（**只测新站的公开路径**；`apps/web` 仍不引测试设施，S3 定的）
- [ ] 三条：首页含正文 / 详情含正文与 OG / sitemap 条目数正确
- [ ] CI 加 job 或步骤，确认 `API_INTERNAL_URL` 等必填键进 `env:`，并确认 API 进程在 e2e 前已起（现在 CI 没有 API 进程，只有库服务）

**验证**：`corepack pnpm@12.4.1 --filter web-next test:e2e` 三条绿；且**故意把 `rehype-sanitize` 摘掉一次**，
D 那组断言必须变红——否则 D 是假测试。

---

## 收尾

- [ ] `pnpm -r lint / check / build / test` 全绿（api 侧现为 **299 passed / 21 files**，不许倒退）
- [ ] 残留：桶 0 对象；库 `articles 7 / comments 2`
- [ ] 更新本文件勾选 + prd 验收，做不到的照实标 ⚠️（写"没测到"而不是"没问题"）
- [ ] 父任务 `09-24-.../implement.md` 的 S4 段按**收窄后**的范围回写（原列表里 hub/注册表那几条要标"经 P-1 延后"，不删）
