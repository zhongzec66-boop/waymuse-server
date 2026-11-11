import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.ts";
import { query, withTransaction } from "./db.ts";
import { rateLimit } from "./redis.ts";
import { sendLoginCode } from "./mailer.ts";
import {
  hashToken,
  newLoginCode,
  newOpaqueToken,
  signAccessToken,
  verifyAccessToken,
} from "./tokens.ts";

const emailSchema = z.string().trim().toLowerCase().email();
const deviceSchema = z.string().trim().min(8).max(128);

type UserRow = {
  id: string;
  email: string | null;
  plan: "free" | "paid";
  is_guest: boolean;
};

async function findOrCreateUserByEmail(email: string): Promise<UserRow> {
  const existing = await query<UserRow>(
    "select id, email, plan, is_guest from users where email = $1",
    [email],
  );
  if (existing.rows[0]) return existing.rows[0];
  const created = await query<UserRow>(
    `insert into users(email, is_guest) values ($1, false)
     on conflict (email) do update set email = excluded.email
     returning id, email, plan, is_guest`,
    [email],
  );
  return created.rows[0]!;
}

async function findOrCreateGuest(deviceId: string): Promise<UserRow> {
  // 游客以 deviceId 建账号；deviceId 存在 devices 表里，用一张映射表更简单
  const existing = await query<{ user_id: string }>(
    "select user_id from devices where device_id = $1 order by last_seen_at desc limit 1",
    [deviceId],
  );
  if (existing.rows[0]) {
    const user = await query<UserRow>(
      "select id, email, plan, is_guest from users where id = $1",
      [existing.rows[0].user_id],
    );
    if (user.rows[0]) return user.rows[0];
  }
  const created = await query<UserRow>(
    "insert into users(email, is_guest) values (null, true) returning id, email, plan, is_guest",
  );
  return created.rows[0]!;
}

/**
 * 绑定设备并签发令牌。
 * 超过上限时踢掉最久未活跃的那台（用户会收到提示）。
 */
async function issueTokens(
  user: UserRow,
  deviceId: string,
  deviceName: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  evicted: string[];
}> {
  const refreshToken = newOpaqueToken();
  const refreshHash = await hashToken(refreshToken);

  const evicted = await withTransaction(async (client) => {
    const existing = await client.query<{ id: string; device_id: string }>(
      "select id, device_id from devices where user_id = $1 and revoked_at is null order by last_seen_at asc",
      [user.id],
    );

    const rows = existing.rows;
    const already = rows.find((row) => row.device_id === deviceId);
    const activeCount = rows.length;

    const kicked: string[] = [];
    if (!already && activeCount >= config.maxDevicesPerUser) {
      const toKick = rows.slice(0, activeCount - config.maxDevicesPerUser + 1);
      for (const row of toKick) {
        await client.query("update devices set revoked_at = now() where id = $1", [row.id]);
        kicked.push(row.device_id);
      }
    }

    await client.query(
      `insert into devices(user_id, device_id, name, refresh_hash, last_seen_at, revoked_at)
       values ($1, $2, $3, $4, now(), null)
       on conflict (user_id, device_id) do update
         set refresh_hash = excluded.refresh_hash,
             name = excluded.name,
             last_seen_at = now(),
             revoked_at = null`,
      [user.id, deviceId, deviceName.slice(0, 40), refreshHash],
    );

    return kicked;
  });

  const accessToken = await signAccessToken({
    sub: user.id,
    deviceId,
    plan: user.plan,
  });

  return { accessToken, refreshToken, evicted };
}

export function registerAuthRoutes(app: FastifyInstance) {
  /* ── 发验证码 ───────────────────────────────────────── */
  app.post("/api/auth/request-code", async (request, reply) => {
    const body = z
      .object({
        email: emailSchema,
        deviceId: deviceSchema,
        turnstileToken: z.string().optional(),
      })
      .safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const email = body.data.email;
    const ip = request.ip;

    // 人机验证：线上必须过
    if (config.turnstile.required) {
      const ok = await verifyTurnstile(body.data.turnstileToken, ip);
      if (!ok) return reply.code(403).send({ error: "turnstile_failed" });
    }

    // 同一邮箱 60 秒一次、每小时 5 次；同一 IP 每小时 20 次
    const emailLimit = await rateLimit(`rl:code:email:${email}`, 5, 3600);
    if (!emailLimit.ok) {
      return reply.code(429).send({ error: "too_many_requests", retryAfter: 3600 });
    }
    const burst = await rateLimit(`rl:code:burst:${email}`, 1, 60);
    if (!burst.ok) {
      return reply.code(429).send({ error: "too_frequent", retryAfter: 60 });
    }
    const ipLimit = await rateLimit(`rl:code:ip:${ip}`, 20, 3600);
    if (!ipLimit.ok) {
      return reply.code(429).send({ error: "too_many_requests" });
    }

    const code = newLoginCode();
    const codeHash = await hashToken(`${email}:${code}`);

    await query(
      `insert into login_codes(email, code_hash, expires_at, attempts, sent_at)
       values ($1, $2, now() + interval '10 minutes', 0, now())
       on conflict (email) do update
         set code_hash = excluded.code_hash,
             expires_at = excluded.expires_at,
             attempts = 0,
             sent_at = now()`,
      [email, codeHash],
    );

    try {
      await sendLoginCode(email, code);
    } catch (error) {
      request.log.error({ err: error }, "send mail failed");
      return reply.code(502).send({ error: "mail_failed" });
    }

    // 不返回验证码，也不确认该邮箱是否已注册（防枚举）
    return reply.send({ ok: true, expiresInSec: 600 });
  });

  /* ── 校验并登录 ─────────────────────────────────────── */
  app.post("/api/auth/verify", async (request, reply) => {
    const body = z
      .object({
        email: emailSchema,
        code: z.string().trim().regex(/^\d{6}$/),
        deviceId: deviceSchema,
        deviceName: z.string().max(60).optional(),
      })
      .safeParse(request.body);

    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const { email, code, deviceId } = body.data;
    const ip = request.ip;

    const ipLimit = await rateLimit(`rl:verify:ip:${ip}`, 30, 3600);
    if (!ipLimit.ok) return reply.code(429).send({ error: "too_many_requests" });

    const { rows } = await query<{
      code_hash: string;
      expires_at: string;
      attempts: number;
    }>("select code_hash, expires_at, attempts from login_codes where email = $1", [email]);

    const record = rows[0];
    if (!record) return reply.code(400).send({ error: "code_not_found" });

    if (new Date(record.expires_at).getTime() < Date.now()) {
      return reply.code(400).send({ error: "code_expired" });
    }
    if (record.attempts >= 5) {
      return reply.code(429).send({ error: "too_many_attempts" });
    }

    const expected = await hashToken(`${email}:${code}`);
    if (expected !== record.code_hash) {
      await query("update login_codes set attempts = attempts + 1 where email = $1", [email]);
      return reply.code(400).send({ error: "code_invalid" });
    }

    await query("delete from login_codes where email = $1", [email]);

    const user = await findOrCreateUserByEmail(email);
    const tokens = await issueTokens(user, deviceId, body.data.deviceName ?? "");

    return reply.send({
      ...tokens,
      accessTtlSec: config.accessTtlSec,
      user: { id: user.id, email: user.email, plan: user.plan },
    });
  });

  /* ── 游客登录（首次启动，不强制注册）───────────────── */
  app.post("/api/auth/guest", async (request, reply) => {
    const body = z
      .object({ deviceId: deviceSchema, deviceName: z.string().max(60).optional() })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    // 同一出口 IP 一天最多建 60 个游客账号。
    // 宿舍/校园网共享出口 IP，10 个太容易误伤；真正的闸门是配额和登录码限流。
    const limit = await rateLimit(`rl:guest:ip:${request.ip}`, 60, 86400);
    if (!limit.ok) return reply.code(429).send({ error: "too_many_accounts" });

    const user = await findOrCreateGuest(body.data.deviceId);
    const tokens = await issueTokens(user, body.data.deviceId, body.data.deviceName ?? "");
    return reply.send({
      ...tokens,
      accessTtlSec: config.accessTtlSec,
      user: { id: user.id, email: user.email, plan: user.plan },
    });
  });

  /* ── 刷新 ───────────────────────────────────────────── */
  app.post("/api/auth/refresh", async (request, reply) => {
    const body = z
      .object({ refreshToken: z.string().min(32), deviceId: deviceSchema })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const hash = await hashToken(body.data.refreshToken);
    const { rows } = await query<{
      user_id: string;
      plan: "free" | "paid";
      email: string | null;
      is_guest: boolean;
    }>(
      `select d.user_id, u.plan, u.email, u.is_guest
         from devices d join users u on u.id = d.user_id
        where d.refresh_hash = $1 and d.device_id = $2 and d.revoked_at is null`,
      [hash, body.data.deviceId],
    );

    const row = rows[0];
    if (!row) return reply.code(401).send({ error: "invalid_refresh" });

    await query("update devices set last_seen_at = now() where refresh_hash = $1", [hash]);

    // 轮换：每次刷新都换新串，旧的立即失效
    const next = newOpaqueToken();
    await query("update devices set refresh_hash = $1 where refresh_hash = $2", [
      await hashToken(next),
      hash,
    ]);

    const accessToken = await signAccessToken({
      sub: row.user_id,
      deviceId: body.data.deviceId,
      plan: row.plan,
    });

    return reply.send({ accessToken, refreshToken: next, accessTtlSec: config.accessTtlSec });
  });

  /* ── 登出（吊销本设备）────────────────────────────── */
  app.post("/api/auth/logout", async (request, reply) => {
    const claims = await requireAuth(request);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });
    await query("update devices set revoked_at = now() where user_id = $1 and device_id = $2", [
      claims.sub,
      claims.deviceId,
    ]);
    return reply.send({ ok: true });
  });

  /* ── 当前账号信息 ───────────────────────────────────── */
  app.get("/api/me", async (request, reply) => {
    const claims = await requireAuth(request);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });

    const user = await query<{ id: string; email: string | null; plan: string; is_guest: boolean }>(
      "select id, email, plan, is_guest from users where id = $1",
      [claims.sub],
    );
    const devices = await query<{ device_id: string; name: string; last_seen_at: string }>(
      `select device_id, name, last_seen_at from devices
        where user_id = $1 and revoked_at is null order by last_seen_at desc`,
      [claims.sub],
    );
    const profile = await query<{
      school: string;
      major: string;
      grade: string;
      direction: string;
    }>("select school, major, grade, direction from profiles where user_id = $1", [claims.sub]);

    return reply.send({
      user: user.rows[0] ?? null,
      devices: devices.rows,
      profile: profile.rows[0] ?? null,
    });
  });

  /* ── 保存资料（知识库匹配用）───────────────────────── */
  app.post("/api/me/profile", async (request, reply) => {
    const claims = await requireAuth(request);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });

    const body = z
      .object({
        school: z.string().max(60).default(""),
        major: z.string().max(60).default(""),
        grade: z.string().max(20).default(""),
        direction: z.string().max(60).default(""),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    await query(
      `insert into profiles(user_id, school, major, grade, direction, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (user_id) do update
         set school = excluded.school, major = excluded.major,
             grade = excluded.grade, direction = excluded.direction,
             updated_at = now()`,
      [claims.sub, body.data.school, body.data.major, body.data.grade, body.data.direction],
    );

    return reply.send({ ok: true });
  });
}

/* ── 人机验证 ─────────────────────────────────────────── */
async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (!token) return false;
  const form = new URLSearchParams();
  form.set("secret", config.turnstile.secret);
  form.set("response", token);
  form.set("remoteip", ip);

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/** 从 Authorization: Bearer 里解析并校验 access token */
export async function requireAuth(
  request: FastifyRequest,
): Promise<{ sub: string; deviceId: string; plan: "free" | "paid" } | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return verifyAccessToken(header.slice(7).trim());
}
