# S3 · 写路径：写入迁至自建 API、发布流水线、对象存储、Supabase 归零

> 父任务：`.trellis/tasks/09-24-blog-production-backend`
> 本阶段最大，含四件事；每件事独立可验证，顺序见 `implement.md`。

## 前置认知：本阶段有一个硬约束影响分支策略

S3 完成后，前端读写**全部指向自建 API**，而 API 目前只跑在本机。因此：

> **`feat/s0-foundation` 在 S8 部署出 API 之前，不得合入 `main`、不得触发生产部署。**

否则线上站点会白屏（连不到 `localhost:3001`）。当前 `main` 仍是旧代码、PR #1 为草稿，所以暂时安全。这条不是风险提示，是**验收项**：见 S3-R0 与 A 节。

## Goal

把最后的数据操作从 Supabase 搬到自建 API，让前端彻底脱离 BaaS；同时补上"本地写 markdown → 一条命令发布"的写作闭环，以及图片上传。

**为什么写作闭环放在这里**：`apps/api/fixtures/*.md` 的 front-matter 格式在 S1 就定了（当时的理由是"一份格式服务两个阶段"），S3 就是它的第二个用户。

## 需求

### 写作 API

- **S3-R0** 文章写端点，全部 `requireAdmin` 保护：
  - `POST /api/v1/articles` 创建（默认 `draft`）
  - `PATCH /api/v1/articles/:slug` 更新（正文、元数据、状态流转）
  - `DELETE /api/v1/articles/:slug` 删除
- **S3-R1** 状态流转必须**在数据库层守住的规则**：`draft → published` 必须设置 `published_at`（首次发布时），且 `published → draft` 不得留下一个"已发布却无时间戳"的状态。S1 建的 `published_needs_timestamp` 约束继续作为唯一真相来源。
- **S3-R2** `slug` 可改，但**改 slug 不得孤儿化评论**——S1 已把评论改为 `article_id` 外键（D10），本阶段用测试证明它真的成立。
- **S3-R3** 创建/更新必须是**幂等友好**的：同一 slug 并发创建只应成功一次（靠 unique 约束，不靠先查再写的竞态）。

### 评论写 API

- **S3-R4** `POST /api/v1/articles/:slug/comments` 需登录；可选 `parentId`（须属同一篇文章，不得跨文章挂树）。
- **S3-R5** `DELETE /api/v1/comments/:id`：**作者本人可删**、**管理员可删任意**（关闭 D8 的权限半边；S2 之前这个能力因为 UI 降级而消失）。
- **S3-R6** 评论长度与内容约束由数据库 `check` 与 DTO 双重把守，且**删除是软校验硬执行**：不存在或无权 → 404/403，不透露存在性。

### 发布流水线

- **S3-R7** 一条命令把 `content/*.md` 发布进数据库：`pnpm --filter api publish [--dir content]`。
- **S3-R8** 复用 S1 的 front-matter 解析器（**不写第二个解析器**），因此格式、错误信息、拒绝 YAML 缩进等行为完全一致。
- **S3-R9** **幂等**：按 slug upsert；再跑一次不产生重复、不重置 `is_admin` 类敏感字段、不刷新不该刷新的 `updated_at`（内容未变则不动）。
- **S3-R10** 默认 `draft`，除非 front-matter 显式 `status: published`。**发布动作不该由同步文件意外触发**。
- **S3-R11** 目标库必须**显式**：拒绝在 `NODE_ENV=production` 下裸跑，且执行前打印目标库主机与将变更的 slug 列表。

### 图片上传

- **S3-R12** Compose 增加 MinIO（含 healthcheck 与持久卷）。
- **S3-R13** 签发式直传：`POST /api/v1/uploads` 返回 presigned PUT URL + 最终可访问 URL；浏览器直传对象存储，**文件字节不经过 API 进程**。
- **S3-R14** 上传必须校验：MIME/扩展名白名单、大小上限、生成随机 key（**绝不用用户提供的文件名**，路径穿越与覆盖他人对象都从这里来）。
- **S3-R15** 只有管理员可签发上传 URL。

### 脱离 Supabase

- **S3-R16** 前端写路径全部切换后，删除 `apps/web/src/lib/supabase.ts`，并从 `apps/web` 卸载 `@supabase/supabase-js`。
- **S3-R17** 撤销 S2 的评论只读降级提示，恢复发布/删除按钮，接新端点。
- **S3-R18** `supabase/migrations/` 与 RLS 不再被应用代码引用：**保留文件作为历史记录**，但加一节说明它已停用（避免以后误以为它还是真相）。

## 验收标准

- [ ] 文章：创建→草稿不出现在公开列表→发布→出现在列表与详情→更新→删除，全链路有集成测试
- [ ] 改 slug 后评论仍随文章可查（外键生效的直接证明）
- [ ] 并发用同一 slug 创建：恰好一条成功，其余 409 `SLUG_CONFLICT`
- [ ] 评论：作者能删自己的、删他人的得 403、管理员能删任意、`parentId` 跨文章被拒
- [ ] `publish` 连跑两次结果字节一致（含 `updated_at` 不变），且能正确拒绝 production
- [ ] presigned 直传成功；超限/错类型/用户构造文件名三种情况被拒
- [ ] `grep` 证实 `apps/web/src` 无任何 Supabase 引用；`@supabase/supabase-js` 不在 `apps/web/package.json`
- [ ] 新端点全部要求鉴权之处有**反向测试**（无凭证 401、有权但非管理员 403）
- [ ] `pnpm -r lint / check / test / build` 全绿，CI 顺序在临时库跑通
- [ ] 所有新端点进入 `packages/shared` 契约且有编译期漂移守卫

## 已知限制（明确记录）

1. **生产仍不可部署**：API 只在本地。合并与上线属 S8。
2. **无限流**：写端点比读端点更需要，仍归 S6——本阶段记录为缺口而非遗漏。
3. **图片不做处理管线**（缩放、webp、EXIF 清除）：EXIF 会泄露 GPS，属已知未做，S4/S6 视需要补。
4. **删除文章是硬删除**（评论随外键 cascade）：没有回收站。若要软删除需新迁移，等真实需求。
5. presigned 直传要求 MinIO 配 CORS；若验证不过则回退为"经 API 中转上传"，两者都在 design 中记录（不悄悄换）。

## 不在范围内

- 邮箱通知 / 订阅、评论审核队列（S5 任务队列的候选场景）
- 图片 CDN、多尺寸变体
- 前端 Next.js 迁移与 SSR（S4）
- 密钥轮换、TLS、部署（S8）
