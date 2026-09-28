# S2 执行计划

> 契约见 `design.md`，验收见 `prd.md`。
> **排序原则：先把"错了就出漏洞"的部分做完并测透（令牌原语、轮换与撤销、守卫），再碰 OAuth 流程，最后才动前端。** 反过来做会得到一个"界面能登录但内部没人验证过"的东西。

---

## 前置

- [ ] `git tag pre-s2`
- [ ] `pnpm infra:up`，postgres/redis healthy；库已 `migrate:up` + `seed`
- [ ] 新增环境变量写入 `apps/api/.env.example` 与 `.env`：
  `JWT_SECRET`（≥32 字节随机）、`OAUTH_BASE_URL`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`、
  `OAUTH_REDIRECT_PATH`、`PORTAL_WEB_ORIGIN`、`COOKIE_SECURE`
- [ ] **立刻做一条泄漏检查**：`grep -rn "JWT_SECRET\|CLIENT_SECRET" apps/web packages` 必须为空

```bash
# 生成一个合格的密钥，而不是手打
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## A · 迁移 `0002`

- [ ] `users.id` 加默认值；建 `refresh_tokens`（含 3 个索引，其中一个 partial）
- [ ] 写 down：drop table + 撤掉默认值
- [ ] up → down → up 全跑一遍

```bash
pnpm --filter api migrate:up
docker compose -f infra/docker-compose.yml exec -T postgres psql -U myblog -d myblog -Atc \
  "\d refresh_tokens"
pnpm --filter api migrate:down && pnpm --filter api migrate:up
```

> **注意**：`alter column ... set default` 的反向是 `drop default`，不是"删掉"。down 里写错方向会在回滚时静默留下差异。

---

## B · 令牌原语（先孤立地测，不接任何路由）

- [ ] `lib/tokens.ts`：签/验 access（HS256，`sub`+`jti`+`exp`）、生成 refresh 随机串、`sha256(hex)`
- [ ] 装 `@fastify/jwt`（**密码学不自己发明**；签发/校验/轮换策略自己写）
- [ ] 单元测试断言这些点：
  - 篡改 payload 一个字符 → 验签失败
  - `alg: none` 的 token → 拒绝
  - 用另一个密钥签名的 token → 拒绝
  - 过期 token → 可区分地失败（供 `TOKEN_REVOKED` vs `UNAUTHORIZED` 分诊）
  - refresh 明文 ≠ 存储值，且**同一输入两次哈希一致**
- [ ] 密钥强度：启动时校验 `JWT_SECRET` 长度，不足即**拒绝启动**

```bash
pnpm --filter api test -- tokens
```

> 这一步单独做的理由：这三条攻击（alg 混淆、换密钥、改 payload）是 JWT 最经典的三类误用。等接上路由再发现，很难分清是路由错还是验签错。

---

## C · 撤销与轮换（安全核心）— ✅ 完成（86 测试）

实测中修正的四处，全部由运行暴露而非阅读暴露：

| 现象 | 真因 | 性质 |
|---|---|---|
| 5 个 denylist 测试 `app.denylist` undefined | 插件写了但**没在 app.ts 注册** | 实现漏接 |
| 5 个测试 `The client is offline` | 不 await connect ⇒ `buildApp()` 返回时可能仍在拨号；**实现正确，测试抢跑** | 测试缺陷 |
| `Query<TokenRow[]>` 使 rows 成二维 | `Query<T>` 已是 `T[]`。**81 个测试全绿而 tsc 报错** | 类型谎言 |
| `sendCommand({command:'ttl'})` 形状错 | RESP 协议错误**打断 socket**；`client.ttl()` 本已存在 | 凭猜写 API |

**设计变更（因测试而加）**：`RefreshTokenError` 作为共同基类。未知/过期/已用三类失败在**边界上必须同为 401 同码**——分别给不同 code 等于告诉攻击者哪个猜测命中了存储状态；子类仅用于日志与指标。

`rotate` 用 `SELECT ... FOR UPDATE`：无行锁时两个并发刷新都读到"未使用"，各自插入子节点并都成功，留下两支活 token，**复用检测对这一对就永久失效**。

我的两条测试自己也写错了：#2 注释说"B 家族存活"却断言了同族的 `rotated`；#1 断言 `InvalidTokenError` 而整族撤销后再出示任何成员本质仍是复用。后者正是引入基类的原因——**断言应钉住边界结果，而不是钉住实现细节**。

`disableOfflineQueue` 期间隔的 `/ready` 报 degraded 是**正确语义**，因此选择让测试等待连接就绪，而不把启动改回阻塞换测试方便。


- [ ] `plugins/denylist.ts`：`revoke(jti, ttlSeconds)` / `isRevoked(jti)`，走 Redis
- [ ] `modules/auth/token-store.ts`：`issue(userId, familyId?)`、`rotate(oldRaw)`、`revokeFamily(id)`
- [ ] **轮换与复用检测必须在一个事务里**（否则并发双刷会留下两个都活的 token）
- [ ] 集成测试：
  - 正常轮换：旧新交替可用，旧的第二次使用 ⇒ `TOKEN_REUSE_DETECTED`
  - 复用后**同族全部失效**（拿同族另一支去刷也应 401）
  - 登出后旧 access **立即**被拒（denylist，而非等过期）
  - denylist 里 TTL 正确过期（用极短 TTL 测）

```bash
pnpm --filter api test -- token-store
# 手工看 Redis 里确实有键并会消失
docker compose -f infra/docker-compose.yml exec -T redis redis-cli keys 'deny:*'
```

> 并发的坑不好复现，就**直接测不变式**：轮换后旧行 `revoked_at` 非空。断言状态比断言时序可靠。

---

## D · 守卫与身份端点 — ✅ 完成（101 测试）

`requireAuth`（验签 → 校验形状 → 查 denylist）、`requireAdmin`（**查库 `is_admin`**）、
`GET /auth/me`、`src/db/admin.ts` CLI。签发收进唯一一处 `app.signAccessToken`，
它无条件附加 TTL；验签额外要求 `exp` 存在——把 B 阶段发现的库缺陷补成自己的保证。

### 变异检验：三次改坏实现，三次都被抓到

| 变异 | 结果 |
|---|---|
| `requireAdmin` 不查库直接放行 | **2 failed** |
| `requireAuth` 跳过 denylist | **2 failed** |
| 验签不检查 `exp` | **2 failed** |

**并顺带暴露一个测试卫生缺陷**：变异运行时断言失败 → 写在测试体末尾的清理代码被跳过 →
留下孤儿行 → 之后每次运行都撞 `users_github_login_key` 唯一约束，**测试不能安全重跑**。
修法：清理移到 `afterAll`（断言失败也会执行），插入改成 `on conflict do update`。
修完连跑两遍均 101 全绿，可重跑性是被证明的而非假设的。

同类问题还有一处：那条"后端不出现 `user_metadata`"的 grep 测试原本把**任何异常**都当作
"无匹配=通过"，于是 git 缺失、不在仓库、cwd 错误都会让它空过。改为只接受 exit 1，
其他状态直接抛错——否则它什么也没保证。

### 边界语义（有测试固定）

- 无凭证 / 篡改 / `alg:none` / 错密钥 / 过期 / **绕过唯一签发处的无 exp 令牌** → 一律 **401 同一 code**（哪种猜测失败不是调用方该知道的）
- 已登出的 jti → **立即** 401，不等过期
- 非管理员 → 403；**账号已删而令牌仍有效 → 401 而非 403**（身份不存在，谈不上权利）
- `isAdmin` 每次现查库 ⇒ 撤销在**下一次请求**生效，不等令牌过期
- D1 回归：一个 display name 与管理员完全相同的普通用户仍然 403

## D · 守卫与身份端点

- [ ] `plugins/auth.ts`：`requireAuth`（验签 → 查 denylist → `req.auth`）
- [ ] `modules/auth/guards.ts`：`requireAdmin` = requireAuth + **查库 `is_admin`**
- [ ] `GET /api/v1/auth/me`：DB 读 `is_admin`，返回 §4 契约
- [ ] **不做管理 HTTP 接口**（已裁剪）。改为 `src/db/admin.ts` 命令行：`grant <login>` / `revoke <login>`，只动 `users.is_admin`
- [ ] CLI 必须在服务端进程内执行，且**拒绝在 NODE_ENV=production 之外的库上盲跑**前先打印目标 login 与影响面
- [ ] 路由内**不得**出现 `user_metadata`；全局搜一遍确认

```bash
grep -rn "user_metadata" apps/api/src && echo "✗ 后端不应出现" || echo "✓ 后端零引用"
```

---

## E · OAuth 流程（此时才接 provider）

- [ ] `modules/auth/provider.ts`：只依赖 `OAUTH_BASE_URL` 的可插拔客户端（authorize URL、code 交换、profile、emails）
- [ ] `src/test/fake-oauth.ts`：桩服务（真实 HTTP，临时端口）
- [ ] `start`：生成 `state` → Redis `SET ... EX 600`；302
- [ ] `callback`：`GETDEL` 一次性消费 `state`；`error=` 早退；换 token；upsert 用户（**不碰 is_admin**）；签发；下发 cookie；302 `return_to`
- [ ] **`return_to` 白名单**：仅 `/^\/(?!\/)/` 且不含 `\`，否则用默认
- [ ] 集成测试（对桩）：正常登录、`state` 缺失/错误/重放、`error=access_denied`、
      交换 401、交换 200 缺字段、`return_to=//evil.example` 被拒

```bash
pnpm --filter api test -- auth-oauth
# 手工看一眼重定向链是否干净
curl -si 'localhost:3001/api/v1/auth/github/start?return_to=/blog/x' | head -5
```

---

## F · 会话传递：cookie、CORS、CSRF

- [ ] 两个 cookie 按 `design.md` §4 表设置属性；`COOKIE_SECURE=false` 才允许 dev
- [ ] CORS 改 `credentials: true`，origin 用 `PORTAL_WEB_ORIGIN` 单值
- [ ] 写请求（`logout`/`refresh`）要求 `x-requested-with: portal`，缺失 → 403
- [ ] **测试覆盖反向**：带 cookie 但缺自定义头 ⇒ 403；带头无 cookie ⇒ 401

> 这里必须做对称验证：只测"合法请求能过"等于没测 CSRF 防护。

---

## G · 前端切换

- [ ] 新增 `apps/web/src/utils/authApi.ts`：`fetchMe()`、`logout()`、`loginUrl(returnTo)`
- [ ] `useAuthStore` 改为消费 `/auth/me` 的 `{user, isAdmin}`；**删除 `ADMIN_GITHUB_USERNAME` 常量**
- [ ] `Header.tsx` 登录按钮 → 跳 `loginUrl()`；退出 → `POST /auth/logout`（带自定义头）
- [ ] 修掉 `ArticleDetail.tsx` 游离的 `signInWithOAuth()`（拿到 URL 不跳转）
- [ ] 删除 `apps/web/src/auth/githubAuth.ts` 与 `lib/supabase.ts` 的 Auth 用法（`getSupabase()` 仅保留写路径）
- [ ] `exchangeCodeForSessionFromUrl` 的职责由后端 callback 承担 → 移除

```bash
grep -rn "signInWithOAuth\|exchangeCodeForSession\|onAuthChange" apps/web/src && echo "✗ 仍有残留" || echo "✓ 前端已无 Supabase Auth"
```

---

## H · 安全收口

- [ ] **越权测试集**（`src/test/authz.test.ts`），至少覆盖：
  无凭证→401；普通用户→403；`alg:none`→401；错密钥签名→401；过期→401；
  已登出的 access→401；**Supabase 伪造 `user_metadata` 仍非管理员**（D1 回归，永久保留）
- [ ] `requireAdmin` 以测试内注册的临时路由做中间件单测；**端到端 403 覆盖明确记为延后至 S3**，不用合成路由冒充产品行为
- [ ] 日志断言：refresh 明文与 `JWT_SECRET` 不出现在任何日志输出中
- [ ] CI 加一步：构建 web 产物后 `grep -qi "JWT_SECRET\|Client secret" apps/web/dist/*` 必须无命中
- [ ] 逐条过 OWASP 会话管理清单，结论写回本文件末尾（**不做成"应该没问题"**）

---

## 收尾

- [ ] `pnpm -r lint / check / test / build` 全绿
- [ ] **真实 GitHub 走查清单**交付（用户手动执行）：
  1. `github.com/settings/developers` → New OAuth App
  2. Authorization callback URL 填 `http://localhost:3001/api/v1/auth/github/callback`
  3. `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` 写入 `apps/api/.env`（不入库）
  4. `OAUTH_BASE_URL=https://github.com`，`PORTAL_WEB_ORIGIN=http://localhost:5175`
  5. 点登录 → 完成一次真实授权 → `pnpm --filter api exec tsx src/db/admin.ts grant guoshaoran`
  6. 确认 `GET /auth/me` 返回 `isAdmin: true`（本阶段无管理接口，S3 才有靶子）
- [ ] `git tag s2-done`

---

## OWASP 会话管理清单结论（执行时填写）

待填。

## 已知偏差 / 未尽事项（执行时填写）

待填。
