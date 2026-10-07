# S4 · 公开页迁 Next.js（收窄版）

> 范围由父任务 `09-24-blog-production-backend/implement.md` 的"范围裁定（2026-10-08）"P-1/P-2 决定：
> 公开页走 Next.js + ISR + SEO；**后台 `/admin/*` 继续用现有 Vite SPA**；不做门户 hub、不做模块注册表。

## 为什么要做（这条是量出来的，不是推断的）

2026-10-08 本机实测，对一个真实存在的文章 URL 直接 `curl` 服务端返回的 HTML：

```
字节数            841
<div id="root">   空
正文关键词命中     0    （文章里有"小节 / 列表项"等词，HTML 里一个都没有）
<title>           Guoshaoran        ← 只有这一个 meta
meta description  无
```

结论：今天整站的公开内容在**首个 HTML 字节里不存在**，全靠 JS 跑起来才有。
这对两类读者是同一件事：**搜索引擎爬虫**看不到正文（等于没有 SEO），
**链接预览爬虫**（微信、Twitter/X、Telegram、飞书）拿不到 OG 标签，分享出去是一张空卡片。

`<title>` 在 2026-10-08 之前是 `My Trae Project`（缺陷 D7），现在已经是 `Guoshaoran`——
D7/D3/D2 三个原列在 S4 里的缺陷经实测都已不存在，所以本阶段真正剩下的只有"让 HTML 里有内容"这一件事。

## 需求

- **S4-R1** 新增 `apps/web-next`（Next.js App Router + TypeScript），承载公开页；`apps/web` 不动、继续承载 `/admin/*`。
- **S4-R2** 公开 URL **一字不改**：`/`（首页：轮播 + 最新文章）、`/blog/:slug`（详情 + 评论）。实测现 SPA 的路由为
  `App.tsx:45,46,50,51,52`，其中**没有** `/blog` 列表页——列表在首页，所以不引入新路径。
- **S4-R3** 文章列表与详情的**正文必须出现在服务端返回的 HTML 里**（这是本阶段的验收核心，用 `curl` 断言，不用浏览器断言）。
- **S4-R4** 每篇文章有 `generateMetadata`：`title`、`description`、`og:title`、`og:description`、`og:image`（用 `coverImage`，没有就省略而不是编造）、`canonical`。
- **S4-R5** `sitemap.xml`、`robots.txt`、`rss.xml`（或 `feed.xml`）三个静态/半静态端点，条目来自数据库真实文章。
- **S4-R6** **markdown 渲染必须在服务端跑，并且保留消毒**。现 SPA 用 `react-markdown@9` + `rehype-sanitize@6`
  （`apps/web/package.json`）；迁过去时 sanitize 一道不许掉——文章正文来自 `.md` 导入，消毒是它进 `<img>`/`<a>` 之前唯一把关点。
- **S4-R7** 评论**保持客户端获取**：它是登录态相关的、按访问者变化的数据，塞进 SSR 会把会话复杂度（P-2）引到公开页上。
  详情页 HTML 里有文章正文即可，评论数可由服务端顺带给出一个初值。
- **S4-R8** 设计令牌单一来源：`apps/web/src/index.css` 里那套 HSL 变量不能变成两份（否则两站视觉必然漂移）。见 design.md D-2。
- **S4-R9** Playwright 覆盖三条关键路径（首页有正文、详情有正文与 OG、sitemap 有条目），CI 里能跑。

## 验收标准

- [ ] `curl -s http://<next>/blog/normal-published | grep -c '小节'` **> 0**（正文真的在 HTML 里）
- [ ] 同一份 HTML 里 `og:title` 与 `description` 存在且内容来自文章本身，不是站点级写死的串
- [ ] `curl -s .../sitemap.xml` 里每条 `<loc>` 都对应数据库里一篇 `published` 文章，且**草稿不在其中**
- [ ] `curl -s .../rss.xml` 可被 XML 解析（用 `python -c "import xml.dom.minidom"` 之类，不靠肉眼看）
- [ ] 首页 `/` 的服务端 HTML 含最新文章标题；轮播的动效部分允许是客户端（`swiper`/`framer-motion` 本来就需要）
- [ ] 发布一篇新文章后，**在规定时限内**（见 D-4 的数字）列表与详情能拿到它，且旧文章仍能命中缓存
- [ ] 恶意构造的 markdown（`<img onerror>`、`javascript:` 链接、原始 HTML）在**服务端渲染的 HTML** 里仍然是被消毒过的——这条必须在 SSR 输出上验，不能只在客户端验
- [ ] `pnpm -r lint / check / build / test` 全绿；Playwright 三条在 CI 绿
- [ ] 现 SPA 的 5 条路由里，`/admin/*` 三条功能不变（它仍在 Vite 上，不该被这次改动碰到）

## 明确不做（沿用范围裁定，不重议）

- 门户 hub、模块注册表、`embed` 字段、tokens JSON 供 agent 消费
- 把 `/admin/*` 迁到 Next / SSR 管理页（P-2：转发 cookie 与 401/续期是一整块新复杂度，收益为 0）
- 图片 CDN、多尺寸变体、EXIF 剥离（后者另记为上线前硬门槛，属 S8 批次）
- 用 Next 的 API routes 代理后端（后端仍是 `apps/api`，两件事不混）

## 已知限制

1. **两个前端并行存在**：视觉与依赖会有短暂重复期，靠 D-2 的令牌单一来源压住最大漂移面；组件级重复（如 Header）在切换完成后再删。
2. **ISR 的读端一致性**：缓存期内发布/改文不会立刻可见，具体上限写在 D-4，不许写"最终一致"这种没数字的话。
3. 本阶段不解决**限流/导出/备份/EXIF**——那四条是上线硬门槛，分别归 S6/S8。
