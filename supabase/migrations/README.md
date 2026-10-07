# 已停用 — 这些迁移不再被执行

这里的文件是 Supabase 时代的旧库历史，**保留仅为可追溯**。S3 之后没有任何工具读取它们：
现在的真相来源是 `apps/api/migrations/`（只有 `0001`–`0003`，由 `pnpm --filter api migrate:up`
在 `infra/docker-compose.yml` 起的本地 Postgres 上执行）。两套 schema 已经分叉——S1 在自建库里
把评论改成 `article_id` 外键、加了 `published_needs_timestamp` 检查约束、把身份键换成不可变的
`github_id`——这些都不在下面任何一个文件里。**不要**拿它们当参照去改现在的库，也不要在这里补新迁移。

时间线：S3（2026-10-07）把最后的数据操作搬到自建 API，前端同时移除 `@supabase/supabase-js`；
旧 Supabase 项目里的文章按当时的决定**不迁移、直接丢弃**（S3-R19，见
`.trellis/tasks/09-29-blog-portal-s3-write-path/prd.md`）。

| 文件 | 它实际是什么 | 现在的位置 |
|---|---|---|
| `01_init_comments.sql` | schema：comments 表 | `apps/api/migrations/0001_portal_schema_v2.up.sql` |
| `02_init_articles.sql` | schema：articles 表（含三篇文章的初始正文） | 同上 |
| `03_update_is_admin.sql` | schema：users 加 `is_admin` | 同上 |
| `05_update_article_style.sql` | **不是 schema**，是对三篇文章正文的改写 | 无替代——内容已随 R19 丢弃 |

`04` 缺号是当年的真实缺口（不是这个目录丢了文件）。

## 一个顺带查明的事实，写给未来的你

`02_init_articles.sql` 与 `05_update_article_style.sql` 合起来是这三篇文章**在仓库里唯一的残存副本**：

- `typescript-5-new-features`
- `gsap-animation-tutorial`
- `micro-frontends-practice`

实测：现在的库里查不到（`select count(*) ... where slug in (...)` 回 `0`），
`apps/api/fixtures/` 里也只有七个测试夹具，没有这三篇。

也就是说 R19 的"丢弃"在数据库层面成立，但**字节还在 git 历史与工作区里**。如果你想把其中任何一篇
重新发出来，不需要写任何工具：把正文抠出来存成 `.md`（带 front-matter，格式参照
`apps/api/fixtures/normal-published.md`），在后台 `/admin/articles` 用"选择 .md 文件"导入即可——
导入端点是服务端解析，导入后是草稿，你审一遍再发布。
