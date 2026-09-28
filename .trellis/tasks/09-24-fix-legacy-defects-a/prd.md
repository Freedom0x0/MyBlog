# 修复既有缺陷 A 类

> 父任务：`.trellis/tasks/09-24-blog-production-backend`
>
> 缺陷清单来源：`.trae/documents/technical_architecture.md` §7。**全部 11 项已在动手前逐条核实仍存在**（S0 改动过仓库，未验证的断言不采纳）。

## Goal

清掉 6 项自包含的既有缺陷，让后续阶段建立在干净的基线上。

**范围经过显式裁剪**：B 类 5 项不移入本任务，因为它们是 S1/S4 的设计内容，而非遗留缺陷（见「不在范围内」）。现在对着即将被替换的 Supabase 直连层去修，等于写一遍再删一遍。

## 需求与修法

### D1 🔴 `is_admin()` 提权漏洞

**现状**（`supabase/migrations/03_update_is_admin.sql:7-8`）：函数读 `auth.jwt() -> 'user_metadata'`，而 `user_metadata` **用户可自行修改**。任何 GitHub 账号登录后执行 `supabase.auth.updateUser({ data: { user_name: 'guoshaoran' } })`，刷新 JWT 即获得文章增删改权限。anon key 本就公开在产物里，**此漏洞在生产站点上真实可被利用**。

**修法**：新增 `supabase/migrations/06_fix_is_admin_use_app_metadata.sql`，`create or replace` 该函数，改读 `app_metadata.is_admin`（只有 service_role 能写）。同时加 `security definer` 与固定的 `search_path`。

**决策：新增迁移而非修改 03。** 03 已应用到线上 Supabase；修改已应用的迁移，对线上库无效、对全新搭建有效，会造成两套状态。新增一条对两种情况都正确：全新搭建跑 03（旧）再跑 06（覆盖），最终一致。

**决策：本任务只堵数据库侧，不碰前端 `authStore.isAdmin`。** RLS 才是真正的闸门；前端那个判断只影响界面显示。彻底改为读 `app_metadata` 是 S2 的设计内容，现在动它会把 S2 的活儿提前做一半。

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
- [ ] D1：迁移 06 存在且 `create or replace` 改读 `app_metadata`；**在本地 Postgres 上语法可解析**（逻辑无法本地验证，见下）
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

## 验证的已知限制

**~~D1 无法在本地验证逻辑~~ → 这条限制是错的，我过早放弃了。** 桩一个 `auth.jwt()` 让载荷从会话变量注入，攻击场景与修复效果都能直接跑出来：

| 场景 | 修复前（03） | 修复后（06） |
|---|---|---|
| 伪造 `user_metadata.user_name='guoshaoran'` | **true** ← 漏洞确认 | **false** ← 攻击被挡 |
| 真正设置 `app_metadata.is_admin=true` | — | **true** ← 正常可用 |
| 匿名未登录 | false | false |

其余验收：`lint` ✓ / `check` ✓ / `build` ✓ / 产物中无 Trae 角标 ✓ / `description` 已落进产物（跨行标签，需压平后再查）✓。

**D1 的部署侧仍需人工完成**，本地桩函数不能替代：应用迁移 06 → **立刻**给管理员账号设置 `app_metadata`。顺序不能颠倒——06 应用后到设置完成之间，**所有人都会失去文章写权限**（包括你自己）。

## 本次发现但超出批准范围的问题

**D16 的严重级别被我判错了。** 原记 🟢 P3「构建期冗余」，实际是 **`babel-plugin-react-dev-locator` 把源文件路径与行号编译进生产 DOM**。在 `apps/web/dist/assets/*.js` 中实测到：

```
"trae-inspector-file-path":"src\pages\SplashScreen.tsx"
"trae-inspector-start-line":"149"
```

这是公开产物里的源码结构泄露。修法是移除该 babel 插件（`vite.config.ts` + `package.json`），约两行。**不在本次 6 项范围内，需单独确认后再动。**

顺带发现：`Home.tsx:125` 用 `coresg-normal.trae.ai` 的 AI 生成图作为头像——第三方托管的外部资源，随时可能失效。属 S3 图片上传要解决的范畴。

## 仍未解释的事

**出现过一次不可复现的测试失败**（1 failed / 16），发生在改完 web 之后、`pnpm -r lint` 与 `check` 刚跑完的同一 shell 内。单独重跑 api 测试 5 轮，全部 16/16 通过。

**我没能保留失败详情**（输出被管道过滤掉了），因此**无法断言原因**。最可能是 Windows 上 vitest worker 冷启动的资源竞争，但这只是猜测——记录它、由 CI 兜底，而不是编一个解释。

## 阻塞性开放问题

无。D7 的站点名与描述已按默认值落地（`Guoshaoran` + 一句中文简介），可随时改。
