# Runbook

这是 S8 的硬性验收项（父任务 R8）：**上版、回滚、密钥轮换、故障排查**四件都有能照抄的命令，
每条都写"看哪一行判断成功"。目标机是一台 Ubuntu + Docker 的云服务器，nginx 在前面。

约定：`$URL` = 站点公网地址（现在是 `http://60.205.178.223`），仓库在 `/srv/myblog`。

---

## 0 · 两种拓扑，先选一种（它们不是同一台机器的两种写法，是有实质差别的）

| | A 路线（**当前实际状态**） | B 路线（容器化） |
|---|---|---|
| 三个进程 | 宿主机跑 `node` + `next`，nginx 托管 SPA 静态文件 | `infra/docker-compose.prod.yml` 起 api/web/gateway |
| 配置来源 | `apps/api/.env`、构建期 `VITE_API_BASE_URL` | 同样的 env 文件，但**镜像内不含任何 secret** |
| 网络 | nginx → 127.0.0.1:3000/3001 | 同（`network_mode: host`，理由写在 prod compose 顶部） |
| 何时用 | 现在，单机单人 | 当"重装要半天"变成真痛点，或这台机器要放第二个项目 |

两条路共用同一份 nginx 配置与同一份 env，**互不覆盖**。B 路线不要求改 A 的任何东西。

---

## 1 · 首次部署（A 路线）

前置：安全组只开 `22/80`（将来 `443`）；**不要**开 `3001/5432/6379/9000`。

```bash
# 1) 基础
apt update && apt upgrade -y
apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
curl -fsSL https://get.docker.com | bash && systemctl enable --now docker
corepack enable

# 2) 代码
git clone <repo> /srv/myblog && cd /srv/myblog && git checkout <tag-or-branch>
pnpm install --frozen-lockfile

# 3) 数据与对象存储
cd infra && cp .env.example .env && vi .env      # 换掉 POSTGRES_PASSWORD（openssl rand -hex 16）
docker compose up -d postgres redis              # minio 只有需要上传功能时才起
cd ..

# 4) 后端
cd apps/api && cp .env.example .env && vi .env && cd ../..
#   必须填：JWT_SECRET、OAUTH_CLIENT_ID/SECRET、MEDIA_ACCESS_KEY_ID/MEDIA_SECRET_ACCESS_KEY
#   必须改成公网值：API_PUBLIC_URL、PORTAL_WEB_ORIGIN（两者都填 $URL，不带端口）
#   COOKIE_SECURE=false 直到有证书；有了立刻改 true 并重开 HTTPS
pnpm --filter api migrate:up
node --env-file=apps/api/.env -e 'console.log("env ok:", /^postgres:\/\//.test(process.env.DATABASE_URL))'   # 冒烟：env 文件能被读到，期望 env ok: true
# 5) 构建（VITE_API_BASE_URL 必须是 /api/v1，否则产物指回你自己电脑）
VITE_API_BASE_URL=/api/v1 pnpm -r build
# 6) nginx
cp infra/nginx/myblog.conf /etc/nginx/sites-available/myblog
mv /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default.disabled 2>/dev/null || true
ln -sf /etc/nginx/sites-available/myblog /etc/nginx/sites-enabled/myblog
nginx -t && systemctl reload nginx
# 7) 后端常驻：systemd（ExecStart 用 --env-file，因为 dist/server.js 不自己读 .env）
#    参考 infra/docker-compose.prod.yml 的替代方案，或写 unit：
#    WorkingDirectory=/srv/myblog/apps/api  ExecStart=/usr/bin/node --env-file=.env dist/server.js
```

**看哪几行判断成功**

```bash
curl -s $URL/ready          # 期望 {"status":"ok","checks":{"postgres":"ok","redis":"ok","media":"ok"}}
curl -s $URL/api/v1/articles | head -c 60   # 期望 {"data":[ 开头
bash infra/nginx/smoke.sh $URL              # 期望 pass 6 fail 0；出现 CANNOT VERIFY 就是没走完
```

`/ready` 里 `media` 是 `failed` 而站点正常，是**预期行为**：媒体坏不该把整站摘掉（见
`apps/api/src/routes/health.ts` 里 `trafficOk` 与 `status` 的分工）。

然后：浏览器登录一次 → `cd apps/api && pnpm run admin grant <你的 GitHub 用户名>` →
后台 `/admin/articles` 导入 `.md`。**不要跑 seed**（`seed.ts` 在 `NODE_ENV=production` 下自己抛错）。

---

## 2 · 日常更新

```bash
cd /srv/myblog
git fetch --tags && git checkout <新 tag>          # 用 tag，不用分支名：回滚要靠它
VITE_API_BASE_URL=/api/v1 pnpm -r build
pnpm --filter api migrate:up                        # 有迁移才动；没有它是幂等的
systemctl restart myblog-api                        # A 路线；B 路线：docker compose -f infra/docker-compose.prod.yml up -d --build
bash infra/nginx/smoke.sh $URL
```

**看哪一行**：`smoke.sh` 退出码 `0` 全过；`2` = 有检查没被验证到（**不算通过**）；`1` = 真失败。

---

## 3 · 回滚

```bash
cd /srv/myblog && git checkout <上一个 tag>
VITE_API_BASE_URL=/api/v1 pnpm -r build && systemctl restart myblog-api
```

**只有纯代码变更可以这样回。** 带迁移的版本不要直接 `git checkout` 回退——
迁移是向前写的（`apps/api/migrations/`，`0001..0003`），旧代码配新库不是兼容状态。
两条正路：

1. 迁移向后兼容时：只回代码，不回库（本项目当前所有迁移都是加列/加表性质）。
2. 不兼容时：`infra/backup/pg-backup.sh` 的还原流程（下一节）把库回到发布前，再回代码。

**决定"这次能不能只回代码"的是那句迁移的注释**，所以下一步永远先看 diff：
`git diff <旧tag>..<新tag> -- apps/api/migrations`。

---

## 4 · 备份与还原

```bash
bash infra/backup/pg-backup.sh            # 产出 infra/backup/pgdata-backups/myblog-<UTC>.dump
```

**看哪一行**：`verified: archive lists articles+comments; database currently holds N articles`
和最后 `OK <path> (16K)`。脚本在**列不出 articles 时非零退出**——一个没内容的备份不该被叫作备份。

**当天必须做第二次动作**：文件在数据库同一块盘上，就还不是备份。脚本会把该跑的 `rsync`
打出来；设 `BACKUP_HOST=you@host` 让它自己传。

**还原演练是计划内的动作，不是灾难时才想起的事**（本文件写完后已在真机上跑通）：

```bash
D=infra/backup/pgdata-backups/<最新的>.dump
docker cp $D myblog-infra-postgres-1:/tmp/r.dump
docker exec myblog-infra-postgres-1 psql -U myblog -d postgres -c 'create database restore_check'
docker exec myblog-infra-postgres-1 pg_restore -U myblog -d restore_check --no-owner /tmp/r.dump
docker exec myblog-infra-postgres-1 psql -U myblog -d restore_check -tAc 'select count(*) from articles'
docker exec myblog-infra-postgres-1 psql -U myblog -d postgres -c 'drop database restore_check'
```

期望：条数与原库一致。**永远还原到临时库**——直接盖在线上库上的"演练"就是事故。

> 内容与备份是两件事：`GET /api/v1/admin/articles/export` 导出的是**能读回来的文字**，
> 导入时一律落成草稿、id 重造、`published_at` 丢回 NULL；评论、图片对象、用户都不在那个文件里。
> 状态与关系的唯一恢复路径是上面的 `pg_dump`。

定时（每天 03:40）：

```cron
40 3 * * * root cd /srv/myblog && BACKUP_HOST=you@host BACKUP_DIR=backups/myblog bash infra/backup/pg-backup.sh >> /var/log/myblog-backup.log 2>&1
```

`pg_restore` 只存在于容器里（宿主机没有 postgres 客户端工具，实测），所以脚本的验证步骤在容器内跑——
把它改成宿主机命令会在服务器上以"备份失败"的样子骗过你。

---

## 5 · 密钥轮换

| 密钥 | 换法 | 代价 |
|---|---|---|
| `JWT_SECRET` | 改 `apps/api/.env` → `systemctl restart myblog-api` | 所有人被登出（access 15 分钟内自然过期，refresh 令牌全部作废）。**不会**丢账号 |
| `OAUTH_CLIENT_SECRET` | GitHub OAuth App → Generate a new secret → 改 env → 重启 | 换的瞬间正在跳转的登录会失败一次 |
| Postgres 密码 | 先进容器 `ALTER USER myblog WITH PASSWORD '...'`，再改 `infra/.env` + `apps/api/.env`，然后 `docker compose up -d` | 顺序反了会让 API 连不上而 postgres 已改，重启也难查 |
| `MEDIA_SECRET_ACCESS_KEY` | MinIO root 凭据。**若上生产，先给它建一个只能读写该桶的普通用户**，别把 root 交出去 | 见"已知缺口" |
| 会话紧急吊销 | 现成手段：把所有 `portal_refresh` 家族吊销 = 换 `JWT_SECRET` 并重启；Redis `deny:*` 是当前用的拒绝名单 | 粗，但快 |

`.env` 全在 `.gitignore` 里（`.env` 模式覆盖），CI 用的是 `env:` 块里的显式假值——
加**必填**键时必须同步去 `.github/workflows/ci.yml` 加一行，否则本地全绿、CI 每个集成文件在 `beforeAll` 死掉。

---

## 6 · 故障排查

| 现象 | 第一步看哪里 | 常见真因 |
|---|---|---|
| 502 | `docker logs` 三个容器 + `curl $URL/ready` | 后端没起；网关配置里 upstream 是 127.0.0.1 而进程绑别的地址 |
| 站点整体不可达但服务器内部 200 | 安全组 80 | 只放行过 22 |
| `/ready` 503，`postgres` failed | `docker ps`（`myblog-infra-*` 是否 healthy） | Docker 守护进程被重启/容器没随开机起（`restart: unless-stopped` 只在 daemon 起来后生效） |
| `/ready` 200 但 `media` failed | `docker exec myblog-infra-minio-1 ls /data/portal-media` | 上传会 5xx，**文章读与整站不受影响**（这是设计） |
| 登录跳到 404 页 | `PORTAL_WEB_ORIGIN` 是否等于 `$URL`（不带端口） | 这里踩过一次：留相对路径时浏览器按 API 端口解析 |
| 登录被 GitHub 拒 | `API_PUBLIC_URL` 与 OAuth App 回调串**逐字符**比对 | 回调 URL 少写 `/api/v1` |
| 导入 `.md` 报 413 | nginx `client_max_body_size` | 默认 1m 会在后端说话之前拦掉（导入路由自己的上限是 8 MiB） |
| 上传后图片不显示 | 浏览器 Network 里那条 PUT 的状态与 `Origin` | 页面开在 `127.0.0.1` 而 MinIO 允许清单是 `localhost` 精确串 |
| 429 | `RATE_LIMIT_WRITE_PER_MINUTE`（默认 60/分钟） | 是限流在正常工作，不是坏；见 `apps/api/src/plugins/rateLimit.ts` |
| 发布后首页看不到 | ISR 60 秒窗口 | 不是 bug；等一分钟或换隐私窗口 |

日志：`journalctl -u myblog-api -f`（A 路线）/ `docker compose -f infra/docker-compose.prod.yml logs -f api`；
访问与 upstream 归属在 `/var/log/nginx/myblog.access.log`（`log_format` 里带 `$upstream_addr`，
"哪个后端挂了"是排障第一个问题）。

---

## 7 · 上线前仍未关闭的缺口（照抄进决策，别等出事先找）

1. **`http://` + 裸 IP**：cookie 非 `Secure`、GitHub 授权跳转和登录凭据在网络上明文。有域名后 `certbot --nginx`，然后 `COOKIE_SECURE=true`。
2. **`PORTAL_WEB_ORIGIN` 是回显不是校验**：`@fastify/cors` 在 origin 配成字符串时把配置值原样写进响应而不比对来源。同源部署下无影响，但它是"看着像白名单"的东西。
3. **API 持有 MinIO root 凭据**：能建桶、能改桶策略。生产换成只对 `portal-media` 有读写权的用户（代价：启动期"桶不存在就建"这条路要挪到基础设施里）。
4. **图片无处理管线**：EXIF/GPS 已在 `complete` 阶段剥离（S8-c），但不做缩放/webp 变体——一张 5 MiB 原图会原样发给手机。
5. **CI 从未在 runner 上验证过 S4/S5/S6 新增的部分**（MinIO step、e2e step）。第一次推上去要盯住这两步。
6. **仓库里 `feat/*` 未合并 `main`**：`main` 仍是 Supabase 时代的代码。真要长期跑，先决定分支策略再谈自动化部署。
