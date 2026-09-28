# 修复既有缺陷 A 类

> 父任务：`.trellis/tasks/09-24-blog-production-backend`
>
> 缺陷清单来源：`.trae/documents/technical_architecture.md` §7。**全部 11 项已在动手前逐条核实仍存在**（S0 改动过仓库，未验证的断言不采纳）。

## Goal

清掉既有缺陷，让后续阶段建立在干净的基线上。

**实际交付 6 项**：D2、D3、D4、D5、D7，以及 **D16**——后者是执行中搜产物时发现的，原判 🟢 P3「构建期冗余」，实测是把源文件路径与行号编译进生产 DOM，经你确认后追加。

**D1 曾实现、后撤销。** 撤销理由与排除 B 类用的是同一条标准（代码会被替换掉），再加上线上库里只有演示数据、无可保护内容。详见下方 D1 一节——其中记录了我 scoping 时漏问的那个关键问题。

**范围经过显式裁剪**：B 类 5 项不移入本任务，因为它们是 S1/S4 的设计内容，而非遗留缺陷（见「不在范围内」）。现在对着即将被替换的 Supabase 直连层去修，等于写一遍再删一遍。

## 需求与修法

### D1 ~~🔴 `is_admin()` 提权漏洞~~ → **已撤销，本任务不处理**

**漏洞确认存在，且已本地复现。**（`supabase/migrations/03_update_is_admin.sql:7-8`）函数读 `auth.jwt() -> 'user_metadata'`，而该字段用户可自行修改：任何 GitHub 账号登录后执行 `supabase.auth.updateUser({ data: { user_name: 'guoshaoran' } })`，刷新 JWT 即获得文章增删改权限。用桩 `auth.jwt()` 实测，伪造载荷下 INSERT 确实穿过了 RLS。

**但仍决定不在本任务修——理由不是"改动太大"，而是"没有值得保护的东西"。** 迁移 02 种子进去的 4 篇是虚构演示文章（RSC / TS 5 / GSAP / 微前端），攻击者能破坏的正是 S1 要迁走、S2 要整体替换的数据。为一个空靶子写 Supabase 专属 SQL 不值得。

**这暴露了我 scoping 时的方法错误。** 我用了两个问题分级：「代码会被替换掉吗」（据此排除 B 类）与「是不是 P0」（据此把 D1 列进 A 类并定为优先）。可 **D1 的修复同样是会被替换的 Supabase 专属代码**——按我自己的标准它该归 B 类。真正该问的第三个问题我始终没问：**漏洞背后有没有值得保护的数据**。那是业务事实，只能由你提供，我却等到代码写完、提交、复核派出之后才问。

**处置**：迁移 06 曾实现并提交，后经 `git rebase --onto` 从历史中整体移除（提交未推送，重写安全）。已验证重写后的树与原树**仅差该文件**，且 `lint`/`check`/`test` 全部复跑通过。

**不会丢的部分**：「**绝不用用户可自改的字段做授权判断**」这条原则已记入 `technical_architecture.md` 的 D1 行与父任务 `design.md`，**S2 直接依赖它**（改为 `users.is_admin` 数据库列）。撤销代码不等于撤销结论。

### D2 🔴 生产构建注入 Trae 推广角标

`apps/web/vite.config.ts:4` 引入 `traeBadgePlugin`，`:24-31` 启用且 `prodOnly: true`——**本地看不见，只有线上会注入**。

**修法**：移除该插件的 import 与调用，并从 `apps/web/package.json` 移除依赖。

### D3 🟠 `Projects.tsx` 双重死代码

`apps/web/src/pages/Projects.tsx` 存在，但 `App.tsx` 中 **0 次引用**（无路由），且全文件使用 `bg-skin-base` / `text-skin-muted` 等类名，而 `tailwind.config.js` 中 **0 个 `skin` 定义**——样式全部无效。

**修法**：删除该文件。修不如删：接上路由还得把它重写一遍（色板不存在），而 GitHub 项目展示已在 `Home.tsx` 内实现（内联拉取 + 硬编码兜底）。

### D4 🟠 `ArticleDetail` 的 mockData 兜底

`apps/web/src/pages/ArticleDetail.tsx:7` 引入 `mockArticles`，`:57-61` 在数据库查不到时**回退到硬编码的假文章**。实际行为：访问一个不存在的 URL 会渲染出虚构内容，而不是显示未找到。

**修法**：删除 `apps/web/src/utils/mockData.ts`（唯一引用者就是本文件），把其中的 `Article` 视图模型类型移入 `ArticleDetail.tsx`，删除兜底分支。

**为什么干净**：组件 `:154` 已有正确的 `if (!article)` 守卫，渲染「文章未找到」。删掉兜底后自然落到该分支——行为从「显示假文章」变为「显示未找到」。

### D5 🟠 损坏的迁移 04

`supabase/migrations/04_update_article_style.sql` 是语法错误。**已实测确认**（本地 Postgres 隔离执行）：

```
ERROR: syntax error at or near "demo"
LINE 6: ...const r = ok({ id: 1, name: 'demo' })
```

根因：content_md 里的 TypeScript 示例含 ASCII 单引号（`name: 'demo'`），提前终止了 SQL 字符串字面量。对照的 05 用 `$md$...$md$` 美元引号，实测干净通过（3 个 UPDATE，退出码 0）。

**修法**：删除 04。05 是它的修正版，保留 05 即可。

### D7 🟠 页面标题与缺失的 meta

`apps/web/index.html:7` 仍是脚手架标题 `<title>My Trae Project</title>`，且全文件无 `description`。

**修法**：改为真实标题 + 一条 `description`。完整的 SEO（每页 OG、sitemap、RSS）属 S4，不在本任务。

**待定**：站点名与描述文案。默认取 `Guoshaoran`（与 Header 品牌一致）与一句中文简介，**可随时改**。

## 验收标准

- [ ] `pnpm -r lint` / `check` / `--if-present test` / `build` 全部通过（S0 的基线不得回退）
- [x] ~~D1~~ **已撤销**，不在本任务验收范围（理由见上）。留待 S2 用 `users.is_admin` 列根治
- [ ] D2：`apps/web/vite.config.ts` 无 `traeBadgePlugin`；`pnpm --filter web build` 产物中**搜索不到 Trae 角标相关字样**（必须实测产物，不能只看源码）
- [ ] D3：`Projects.tsx` 已删；`pnpm --filter web build` 仍通过、`pnpm --filter web dev` 页面正常
- [ ] D4：`mockData.ts` 已删；全仓库无 `mockArticles` 引用；访问不存在的 slug 显示「文章未找到」
- [ ] D5：`supabase/migrations/04_update_article_style.sql` 已删；`supabase/migrations/` 下剩余文件按序执行无语法错误
- [ ] D7：`index.html` 标题不再是 `My Trae Project`；存在 `description`
- [ ] **改动前后前端产物对比，确认除预期外无行为变化**

## 不在范围内（B 类，留给 S1/S4）

| 项 | 归属 | 理由 |
|---|---|---|
| D6 文章列表无分页 | S1 | 要改的 `articlesApi.ts` 正是 S1 整体替换的文件 |
| D8 评论无 `parent_id`；管理员不能删他人评论 | S1 / S4 | schema + UI，属 S1 迁移重写与 S4 前端范围 |
| D9 无 `published` / `published_at` | S1 | 父任务 `design.md` §5.2 的 schema 变更方案已包含 |
| D10 评论靠 `article_slug` 关联无外键 | S1 | 同上 |
| D11 GitHub 仓库客户端直连、token 失效回退硬编码 | S1 | 需要后端存在才能改为服务端抓取 |

## 验证结果

### 独立复核（trellis-check）

复核代理未采信本 PRD 的任何说法，全部重新构建并实测。**结论：范围内 6 项零确认问题。**

| 项 | 状态 | 代理的独立证据 |
|---|---|---|
| D2 | ✅ | 新构建产物中 0 处角标字符串 |
| D3 | ✅ | 源码无 `bg-skin`/`text-skin` 残留；`Projects` 仅剩 `Home.tsx` 的局部变量名 |
| D4 | ✅ | 零代码引用；`:61-66` 早返回留 `article` 为 null，`:173-180` 在任何字段访问**之前**渲染未找到；`setEditedContent` 在 DB 路径上保留 |
| D5 | ✅ | 01→02→03→05 在 scratch 库干净通过，无语法错误 |
| D7 | ✅ | 标题与 description 均落进产物（跨行标签，压平后可查） |
| D16 | ✅ | 生产包 0 处 `trae-inspector`；**并反向验证 dev 仍挂载**：serve transform 中 SplashScreen 11 / Header 35 / Home 43 处 |
| B 类未被侵入 | ✅ | `git diff` 证实 D6/D8/D9/D10/D11 相关文件一行未改 |

**代理补上了我漏掉的一半验证**：我只证明了"生产包干净"，没证明"开发路径仍然工作"。**只测删除侧、不测保留侧，验证就不算完整**——这个对称要求已记进后端 spec 的验收习惯里。

### 命令结果

`pnpm -r lint` ✓ / `pnpm -r check` ✓ / `pnpm -r --if-present test` 16/16 ✓ / `pnpm -r build` ✓

### 更正：那条"偶发测试失败"

我曾记录出现过一次 `1 failed / 16`。代理跑了 **6 轮**（5 次单包 + 1 次全仓）全部 16/16，**无法复现**。所以准确表述是「发生过、但无法证实也无法复现」，而不是「仓库里有一个抖动测试」。我当时把它写得太像既成事实了。

### D1 的复现记录（撤销代码，但保留结论）

修复代码已移除，**漏洞本身已用桩 `auth.jwt()` 实测确认**：伪造 `user_metadata` 载荷下 INSERT 确实穿过 RLS；改读 `app_metadata` 后被挡。这段留给 S2 作为需求依据，不必重新验证一次。

## 第 7 项：D16（经确认后追加）

搜产物时抓到，**原判级别错误**。原记 🟢 P3「构建期冗余」，实测是 **`babel-plugin-react-dev-locator` 把源文件路径与行号编译进生产 DOM**：

```
"trae-inspector-file-path":"src\pages\SplashScreen.tsx"
"trae-inspector-start-line":"149"
```

**在生产包中实测到 1020 处** `trae-inspector-*` 属性——公开产物里的源码结构泄露，另加约 105 kB 无用体积。

**修法不是删插件**：它支撑 Trae 的"点击元素跳转源码"，开发期确实有用。改为用 Vite 官方的 `defineConfig(({ command }) => ...)` 将其限定在 `serve`，`build` 不挂载。

**两条路径都验证**（配置改函数形式会影响 serve，只验 build 不够）：

| | 修改前 | 修改后 |
|---|---|---|
| `build` 的 `trae-inspector` 计数 | **1020** | **0** |
| 生产包体积 | 2473 kB | 2369 kB |
| `serve` 冒烟 | — | HTTP 200，Vite 1018ms 就绪，插件仍挂载 |

顺带发现：`Home.tsx:125` 用 `coresg-normal.trae.ai` 的 AI 生成图作为头像——第三方托管的外部资源，随时可能失效。属 S3 图片上传要解决的范畴，本任务不动。

## 仍未解释的事

**出现过一次不可复现的测试失败**（1 failed / 16），发生在改完 web 之后、`pnpm -r lint` 与 `check` 刚跑完的同一 shell 内。单独重跑 api 测试 5 轮，全部 16/16 通过。

**我没能保留失败详情**（输出被管道过滤掉了），因此**无法断言原因**。最可能是 Windows 上 vitest worker 冷启动的资源竞争，但这只是猜测——记录它、由 CI 兜底，而不是编一个解释。

## 阻塞性开放问题

无。D7 的站点名与描述已按默认值落地（`Guoshaoran` + 一句中文简介），可随时改。
