# WayMuse Server

App 的后端：账号、配额、AI 代理、云同步。**Key 只在服务端**。

## 目录

```
src/
  app.ts       Fastify 组装（可 inject 测试，不负责 listen）
  index.ts     启动入口（连 Redis 后 listen）
  auth.ts      邮箱验证码登录 / 游客 / 刷新 / 设备 / 资料
  ai.ts        多模型代理（SSE 透传）+ 配额扣减 + 全局熔断
  quota.ts     纯函数：额度判断、成本估算（有单测）
  tokens.ts    JWT 签发校验、验证码、哈希
  mailer.ts    SMTP 发信（QQ 邮箱授权码）
  db.ts        pg 连接池
  redis.ts     Redis + 固定窗口限流
  migrate.ts   极简迁移
migrations/    SQL
```

## 本地开发

```bash
cp .env.example .env
# 填 DEEPSEEK_API_KEY / SMTP / JWT_SECRET
docker compose up -d db cache
npm install
npm run migrate
npm run dev
```

没有 Docker 时也能跑测试（不需要数据库）：

```bash
npm run typecheck
npm test
```

## 部署（东京服务器）

```bash
# 1. 装 docker & compose
curl -fsSL https://get.docker.com | sh

# 2. 拉代码
git clone <repo> && cd waymuse-server

# 3. 配环境
cp .env.example .env
vim .env        # JWT_SECRET 用 openssl rand -hex 32

# 4. 起服务
docker compose up -d --build
docker compose exec api npm run migrate

# 5. 看日志
docker compose logs -f api
```

Caddy 会自动为 `Caddyfile` 里的域名申请证书。用 Cloudflare 时：

- 记录先灰云（DNS only）等证书签发成功
- 再开橙云，SSL 模式选 **Full (strict)**
- 给 `/api/ai/*` 关掉压缩（SSE 会被缓冲）

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 |
| GET | `/ready` | 依赖检查（DB + SMTP） |
| POST | `/api/auth/guest` | 游客登录（deviceId） |
| POST | `/api/auth/request-code` | 发验证码（Turnstile 校验） |
| POST | `/api/auth/verify` | 验证码登录 / 注册 |
| POST | `/api/auth/refresh` | 刷新（轮换 refresh） |
| POST | `/api/auth/logout` | 吊销本设备 |
| GET | `/api/me` | 账号 + 设备 + 资料 |
| POST | `/api/me/profile` | 学校/专业/年级/目标（知识库匹配用） |
| GET | `/api/me/quota` | 配额卡数据 |
| POST | `/api/ai/chat` | SSE 流式代理 |

## 配额

| 项 | 默认 |
| --- | --- |
| 每月 | 300,000 token |
| 每日 | 30,000 token |
| 全局熔断 | 当日成本 ¥10 |

超限返回 `429`（个人）或 `503`（全局），客户端据此回退本地兜底。

## 设备

- 一台设备一个 `deviceId`（客户端生成，存 Keychain/Keystore）
- 同账号最多 2 台在线，超出踢最久未活跃的
- refresh token 每次刷新轮换，旧的立刻失效

## 安全说明

- 客户端不接触 `DEEPSEEK_API_KEY`
- 登录码只存哈希、10 分钟过期、同邮箱 60 秒一次
- 邮箱不存在时不暴露差异（防枚举）
- 真正的防线是配额 + 限流 + 熔断；客户端混淆只能提高门槛
