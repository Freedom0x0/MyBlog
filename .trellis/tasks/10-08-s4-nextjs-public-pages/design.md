# S4 设计决策（收窄版）

每条都是"选定 + 被否方案 + 否的理由"，不是方向陈述。事实来源标注在括号里。

## D-1 拓扑：两个前端、一个源、按路径分流

- 公开页 → `apps/web-next`（Next 服务端，监听 `127.0.0.1:3000`）
- `/admin/*` → 现有 Vite SPA 的静态产物（`apps/web/dist`）
- `/api/v1/*` → `apps/api`（`127.0.0.1:3001`，代码里 bind 写死回环，`server.ts:53`）
- 三者由 **nginx 按路径分流**（这条 nginx 配置属于 S5 保留下来的"反代 + 健康检查"那部分，本阶段先用 dev 端口跑通）

**为什么公开路径不用改**（实测 `apps/web/src/App.tsx:45,46`）：现 SPA 只有 `/` 和 `/blog/:slug` 两条公开路由，
**没有** `/blog` 列表页——列表就在首页。所以迁过去 URL 集合不变，用户已分享的链接不会失效。

**否掉的方案**：让 Next 直接服务 `/admin/*`。否因＝父任务裁定 P-2：管理页吃会话 cookie，
让 Next 服务端渲染它们就得转发 cookie 并处理 401/续期，是一整块新复杂度，而它唯一的收益（SEO）
对需要登录的页面恒为 0。

## D-2 设计令牌：单一来源 = 新增 `packages/design-tokens`

实测形状：令牌是 `apps/web/src/index.css`（78 行）`:root` 与 `.dark` 里的一批 **HSL 三元组裸值**
（`--background: 34 50% 95%`），由 `apps/web/tailwind.config.js` 以 `hsl(var(--border))` 这种形式消费；
`darkMode: ['class']`。

- **选定**：把那段 `:root/.dark` 变量块与 Tailwind 的 `colors` 映射一起抽进
  `packages/design-tokens`，导出两样东西：`tokens.css`（变量本体）与 `tailwind-preset.js`（`hsl(var(--x))` 映射）。
  `apps/web` 与 `apps/web-next` 各自 `@import` 前者、`extends` 后者。
- **否：两边各拷一份 CSS。** 否因：两站视觉必然漂移，而且漂移是在**没人看的那一侧**发生的——
  深色模式、`--muted-foreground` 这类只有对比时才看得出。
- **否：Next 里相对路径 import `../web/src/index.css`。** 否因：跨 app 的相对 import 会把两个包的构建生命周期绑死
  （Vite 的 `fs.allow`、Next 的 transpile 都要为它开特例），省下一个包的钱会以调试时间的形式还回去。
- 顺带处理：`prism-react-renderer@2.4.0` 在 `apps/web/package.json` 里，但**全仓 0 处代码引用**（实测 grep，
  排除 node_modules 与 lockfile 后只剩这一行声明）→ 作为死依赖移除，不进新 app。

## D-3 `pnpm build` 不许依赖数据库或运行中的 API

这条是被 CI 的形状逼出来的，不是洁癖：CI（`.github/workflows/ci.yml`）有 postgres/redis 服务，
**没有 portal-api 进程**。而 `next build` 默认会预渲染路由——如果预渲染要去打 API，CI 就会在一个
与代码无关的地方红。

- **选定**：
  - 列表与详情用 `revalidate`，**构建期拿不到数据不是错误**：数据层在 fetch 失败时返回空，
    页面渲染已有的空状态（S3 刚做过"空库与加载中要分得开"那条修复，`HeroCarousel` 那套语义直接复用）。
    首个真实请求会现渲染并按 D-4 缓存住。
  - `sitemap.xml` / `rss.xml` / `robots.txt` 设 `dynamic = 'force-dynamic'`，**请求时读 API**，构建期不预渲染。
- **否：CI 里起一个 API 进程再 build。** 否因：产物因此依赖一份运行时才能确定，"构建"和"部署环境"就粘住了；
  今天为 CI 起 API，明天就要为 staging 起另一个。
- 数据获取地址：服务端用 `API_INTERNAL_URL`（默认 `http://127.0.0.1:3001/api/v1`，**必填无默认**由 env schema 管，
  与 S3 的 `MEDIA_*` 同一套约定：必填项即 CI 契约）；浏览器侧仍走同源 `/api/v1`，即现有 `VITE_API_BASE_URL` 那条不变。

## D-4 陈旧窗口写死数字：**60 秒**，不做按需失效

- **选定**：列表与详情都 `revalidate = 60`。含义说白：**发布或改文后，最多 60 秒对外可见**；
  未被访问的旧文章继续吃缓存。评论数不进这个缓存（见 D-5）。
- **否：按需失效**（`revalidateTag`/`revalidatePath` + Next 的一个 hook 路由）。否因三条，都记下来：
  1. 写路径在 `apps/api`，不在 Next 里——要按需失效，就得让 **API 反过来调用 Next 的一个端点**；
  2. 那个端点必须带一个共享密钥才能不被陌生人刷（多一个带密钥的对外面，且它的失败模式是"看起来发布成功了但没生效"）；
  3. 密钥要在两个进程间同步，部署时多一个必须一致的自由度。
  **启用触发条件**：作者本人因为"发布后要等一分钟才出来"提出不满时再做。届时按第 1 条的形状设计，不要临时发明。
- **否：`no-store` 全动态。** 否因：那就退化成"每个请求都打 API"，白丢 ISR 的意义。

## D-5 Markdown 在服务端渲染，消毒一道不许掉

- 现 SPA：`react-markdown@9` + `rehype-sanitize@6`（`apps/web/package.json`），高亮用 `react-syntax-highlighter@15.5.0`
  （实测只被 `pages/ArticleDetail.tsx` 用；`@uiw/react-md-editor` 的 `MarkdownPreview` 仅出现在编辑器的**预览**里）。
- **选定**：Next 的详情页在**服务端**跑同一条管线（RSC 可以直接渲染 React 组件树），sanitize 保留。
- **验收必须打在 SSR 的 HTML 上**，不是打在浏览器 DOM 上：恶意构造的 `<img onerror=...>`、`javascript:` 链接、
  原始 HTML 块，要在 `curl` 出来的字节里就看不见。理由：SSR 输出的 HTML 会被爬虫和链接预览抓走，
  那是一条与用户浏览器不同的读者路径；只在客户端验等于没验。
- 评论：仍客户端 `fetch`。服务端只给一个 `commentCount` 初值——**若现有公开详情响应里没有这个字段，就不加**，
  不为一个数字去改后端契约（实测：`ArticleDetail` 契约由 S1 定，字段以它为准）。

## D-6 Playwright 只覆盖三条，不铺面

按 `prd.md` 的验收清单落三条（首页正文、详情正文 + OG、sitemap 条目），
CI 里用 `pnpm --filter web-next test:e2e` 跑。**不**在此阶段给 `apps/web` 的后台补 e2e（那条属于"后台的测试设施"，
S3 期间定过：`apps/web` 不引测试设施；Playwright 装在 `apps/web-next` 一侧，只测新站的公开路径）。
