# S2 · 鉴权：GitHub OAuth + JWT 生命周期 + 越权测试

> 父任务：`.trellis/tasks/09-24-blog-production-backend`（架构与阶段地图见其 `design.md` §2.3、`implement.md` S2）
> **本任务是全流程里唯一"做错就出真漏洞"的阶段**，因此验收标准比其他阶段更硬。

## Goal

用自建鉴权替换 Supabase Auth：手写 GitHub OAuth 授权码流、自己签发并校验 JWT、
实现 refresh token 的轮换与复用检测，并让权限判定来自**用户改不了的**数据。

**同时根治 D1**——`users.is_admin` 列已在 S1 的 schema v2 建好但无人读取，本阶段让它成为唯一的管理员依据。

## 已决策

**先用本地桩 IdP 建完整套并测透，真实 GitHub 接线作为交付清单的最后一步**（用户 2026-09-28 确认）。

理由不是"绕开外部依赖"，而是**桩能覆盖真 GitHub 覆盖不了的分支**：`state` 重放、
code 二次使用、回调带 `error=`、token 交换返回 401、交换超时。这些恰是鉴权代码最容易
写错、而用真实 provider 几乎无法稳定测到的地方。所以桩让测试**更完整，不是更弱**。

## 需求

### OAuth 授权码流

- **S2-R1** 手写授权码流，仅用 HTTP 客户端，不引入封装好的 OAuth 库。
- **S2-R2 `state`**：随机生成、**一次性**消费、存 Redis 并带 TTL；缺失/已用/过期一律拒绝。
- **S2-R3** 换取 code 与拉取用户信息都走**可配置的 provider 基址**，使测试可指向桩服务。
- **S2-R4** GitHub 回调携带 `error=` 时必须失败并给出可诊断日志，不得把用户当已登录。
- **S2-R5** 首次登录按 `github_login` **upsert** 用户；已存在则更新 login/display/avatar，**绝不改写 `is_admin`**。

### 令牌生命周期

- **S2-R6** access token 为 JWT，有效期 15 分钟，**载荷只放 `sub` 与 `jti`**，不放权限。
- **S2-R7** refresh token 为高熵随机串，**库中只存其哈希**，有效期 30 天，带 `family_id`。
- **S2-R8 轮换**：每次刷新签发新 refresh 并把旧的标记为已用。
- **S2-R9 复用检测**：已标记已用的 refresh 再次出现 ⇒ 撤销**整条 token 家族**并要求重新登录。
  这是"被复制的 token 无法长期存活"的机制，必须有测试证明。
- **S2-R10 登出**：撤销该 refresh，并把当前 access 的 `jti` 写入 Redis denylist，TTL = 其剩余寿命。
- **S2-R11** 校验 access 时**必须查 denylist**（无状态与可吊销的折中点，需注释说明这是有状态开销）。

### 授权

- **S2-R12** 权限判定只读数据库 `users.is_admin`，**不读 JWT 里的声明、绝不读 `user_metadata`**（D1 根因）。
- **S2-R13** 提供 `requireAuth` 与 `requireAdmin` 两个守卫；未登录 401、已登录非管理员 403。
- **S2-R14** 管理员的授予**只通过数据库列 `users.is_admin` 与一个命令行脚本**完成，**不提供 HTTP 管理接口**（用户 2026-09-28 明确裁剪）。
  引导：seed 在 dev 置位，生产由 `pnpm --filter api admin grant <login>` 完成。

### 前端与会话传递

- **S2-R15** 会话经 **HttpOnly cookie** 传递（JS 读不到 ⇒ XSS 拿不走令牌），refresh cookie 限定较窄 Path。
- **S2-R16** 因此 CORS 必须 `credentials: true` 且 origin **收紧到单一明确来源**，禁止 `*`。
- **S2-R17** 前端登录态改由 `GET /api/v1/auth/me` 提供；删除对 Supabase Auth 的依赖。
- **S2-R18** 修掉 `ArticleDetail.tsx` 那个游离的 `signInWithOAuth()`：它拿到返回 URL 却从不跳转。
- **S2-R19** 写状态变更请求要求自定义头（配合 `SameSite`）以抵御 CSRF，并说明两种机制各自挡住什么。

## 验收标准

### 可证伪的功能验收

- [ ] 完整登录流程经桩 IdP 走通：start → 授权 → 回调 → 换取 → 建用户 → 下发两套 cookie
- [ ] `GET /api/v1/auth/me` 有 cookie 返回身份；无 cookie **401** 且 `code` 属本项目词汇
- [ ] 刷新后旧 refresh **再使用即失败**，且该用户所有 refresh 全部失效（复用检测）
- [ ] 登出后旧 access 在有效期内**立即**被拒（denylist 生效，不是等它自然过期）
- [ ] 回调带 `error=` 时返回失败且**不创建会话**
- [ ] `state` 缺失 / 错误 / 重复使用三种情况均被拒
- [ ] `requireAdmin` 中间件本身被单测覆盖（在测试应用内注册临时路由）：无凭证 401、非管理员 403、管理员通过
- [ ] **已知范围限制（如实记录）**：本阶段无产品级管理路由，故 403 的**端到端**覆盖延后到 S3 的管理写接口出现时补；不以合成路由冒充产品行为
- [ ] **伪造 Supabase `user_metadata.user_name='guoshaoran'` 不再能获得管理员**（D1 回归测试，永久保留）
- [ ] 首次管理员通过 seed/命令行引导，之后仅管理员可授予

### 安全验收（本阶段的硬性部分）

- [ ] 越权测试集存在且全绿，覆盖：普通用户触碰管理接口、无凭证触碰需登录接口、
      伪造/篡改 JWT 签名、过期 token、被撤销 token、跨用户操作
- [ ] JWT 密钥只从环境读取；仓库内**任何 `VITE_`/`NEXT_PUBLIC_` 变量与前端产物中不含**服务端密钥
- [ ] refresh token 明文不落库、不出现在日志字段中（日志断言验证）
- [ ] `state` 与 code 交换的失败不泄露内部信息给调用方（沿用统一错误契约）
- [ ] 上线前逐条过一遍 OWASP 会话管理清单，结论记录在任务笔记

### 前端

- [ ] 登录按钮可用（不再依赖 Supabase）；退出可清除会话
- [ ] `grep` 证实 `apps/web/src` 中 `signInWithOAuth` 与 Supabase Auth 调用已清空
- [ ] 写操作 CSRF 防护生效：缺少自定义头的跨站表单式请求被拒
- [ ] `pnpm -r lint/check/test/build` 全绿，不回退 S0/S1 基线

## 不在范围内

- 任何内容写 API（文章/评论的创建与删除）→ **S3**
- 管理员 HTTP 接口（用户列表、在线授权）→ 不在计划内；刻意只做数据库列 + CLI
- 评论写入从 Supabase 迁走 → S3（`getSupabase()` 在 S2 后仅剩写路径）
- 给未来多模块做**离线**JWT 验签的非对称密钥/JWKS：当前只有门户自己验签，
  对称密钥足够。**升级触发条件写在 design 里**，不预先实现
- 邮箱密码登录、多因子、第三方非 GitHub 登录
- 限流与登录防爆破 → S6（会在 design 中标注这是已知缺口，不是遗漏）

## 已知缺口（明确记录，不假装没有）

1. **登录接口无限流**，可被暴力尝试 `code`/`state`。归 S6。
2. **单密钥 HS256 签名**，无法安全地把验签能力交给非 Node 的模块。归 S5 视需要升级。
3. S2 期间**写路径仍走 Supabase**，故存在两套身份体系并存。S3 结束前不得对外宣称"已脱离 Supabase"。

## 阻塞性开放问题

无。外部依赖（真实 GitHub OAuth App）已决定推迟为交付清单中的手动步骤。
