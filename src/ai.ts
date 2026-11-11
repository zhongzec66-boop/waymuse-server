import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { requireAuth } from "./auth.ts";
import { checkQuota, estimateCostCents } from "./quota.ts";
import type { Usage } from "./quota.ts";

/**
 * AI 代理。
 *
 * 客户端不持 Key：这里用服务端 Key 调 DeepSeek，按 SSE 原样透传；
 * 每轮结束按 token 记账，超配额或触发全局熔断就返回 429/503，
 * 客户端据此回退到本地兜底。
 */

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

async function readUsage(userId: string): Promise<Usage> {
  const daily = await query<{ tokens: string; cost: string }>(
    `select coalesce(sum(tokens_in + tokens_out), 0) as tokens, coalesce(sum(cost_cents), 0) as cost
       from usage_daily where user_id = $1 and day = $2`,
    [userId, todayKey()],
  );
  const monthly = await query<{ tokens: string }>(
    "select coalesce(tokens_in + tokens_out, 0) as tokens from quota_month where user_id = $1 and month = $2",
    [userId, monthKey()],
  );
  const global = await query<{ cost: string }>(
    "select coalesce(cost_cents, 0) as cost from global_usage_daily where day = $1",
    [todayKey()],
  );

  return {
    dailyTokens: Number(daily.rows[0]?.tokens ?? 0),
    monthlyTokens: Number(monthly.rows[0]?.tokens ?? 0),
    globalDailyCostCents: Number(global.rows[0]?.cost ?? 0),
  };
}

async function recordUsage(
  userId: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const cost = estimateCostCents(tokensIn, tokensOut, {
    monthlyTokenLimit: config.monthlyTokenLimit,
    inputCentsPerMillion: config.inputCentsPerMillion,
    outputCentsPerMillion: config.outputCentsPerMillion,
  });

  await query(
    `insert into usage_daily(user_id, day, tokens_in, tokens_out, cost_cents)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id, day) do update
       set tokens_in = usage_daily.tokens_in + excluded.tokens_in,
           tokens_out = usage_daily.tokens_out + excluded.tokens_out,
           cost_cents = usage_daily.cost_cents + excluded.cost_cents`,
    [userId, todayKey(), tokensIn, tokensOut, cost],
  );

  await query(
    `insert into quota_month(user_id, month, tokens_in, tokens_out)
     values ($1, $2, $3, $4)
     on conflict (user_id, month) do update
       set tokens_in = quota_month.tokens_in + excluded.tokens_in,
           tokens_out = quota_month.tokens_out + excluded.tokens_out`,
    [userId, monthKey(), tokensIn, tokensOut],
  );

  await query(
    `insert into global_usage_daily(day, cost_cents) values ($1, $2)
     on conflict (day) do update set cost_cents = global_usage_daily.cost_cents + excluded.cost_cents`,
    [todayKey(), cost],
  );
}

export function registerAiRoutes(app: FastifyInstance) {
  app.get("/api/me/quota", async (request, reply) => {
    const claims = await requireAuth(request);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });

    const usage = await readUsage(claims.sub);
    const monthlyUsed = usage.monthlyTokens;
    const dailyUsed = usage.dailyTokens;

    const resetDaily = new Date();
    resetDaily.setUTCHours(24, 0, 0, 0);
    const resetMonthly = new Date();
    resetMonthly.setUTCDate(1);
    resetMonthly.setUTCHours(0, 0, 0, 0);

    return reply.send({
      monthlyLimit: config.monthlyTokenLimit,
      monthlyUsed,
      dailyLimit: config.dailyTokenLimit,
      dailyUsed,
      resetDailyAt: resetDaily.toISOString(),
      resetMonthlyAt: resetMonthly.toISOString(),
      plan: claims.plan,
    });
  });

  app.post("/api/ai/chat", async (request, reply) => {
    const claims = await requireAuth(request);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });

    const body = z
      .object({
        messages: z
          .array(
            z.object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string().min(1).max(40_000),
            }),
          )
          .min(1)
          .max(40),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(64).max(8192).optional(),
      })
      .safeParse(request.body);

    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const usage = await readUsage(claims.sub);
    const decision = checkQuota(
      usage,
      {
        monthlyTokenLimit: config.monthlyTokenLimit,
        dailyTokenLimit: config.dailyTokenLimit,
        globalDailyCostCents: config.globalDailyCostCents,
      },
      // 先按输入长度给一个保守估计，实际以返回的 usage 为准
      body.data.messages.reduce((sum, m) => sum + m.content.length, 0),
    );

    if (!decision.allowed) {
      return reply.code(decision.reason === "global" ? 503 : 429).send({
        error: "quota_exceeded",
        reason: decision.reason,
        retryAfterSec: decision.retryAfterSec,
      });
    }

    const upstream = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      body: JSON.stringify({
        model: config.deepseek.model,
        messages: body.data.messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: body.data.temperature ?? 0.7,
        max_tokens: body.data.maxTokens ?? 2048,
      }),
    }).catch(() => null);

    if (!upstream || !upstream.ok || !upstream.body) {
      const status = upstream?.status ?? 502;
      return reply.code(502).send({ error: "upstream_failed", status });
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // reply.raw.writeHead 会绕过 Fastify 的 CORS 插件，
      // 这里必须手动补上，否则浏览器预检通过、真实请求仍被拦（ERR_FAILED）
      "access-control-allow-origin": request.headers.origin ?? "*",
      "access-control-allow-headers": "content-type, authorization",
      vary: "Origin",
    });

    // Cloudflare 100 秒无数据会断，心跳兜底
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        // 连接已断开
      }
    }, 15_000);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let usageIn = 0;
    let usageOut = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        reply.raw.write(chunk);

        // 从 stream 里捞 usage（最后一条带 usage 的 data）
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            if (parsed.usage?.prompt_tokens) usageIn = parsed.usage.prompt_tokens;
            if (parsed.usage?.completion_tokens) usageOut = parsed.usage.completion_tokens;
          } catch {
            // 分块可能不完整，忽略
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
      if (usageIn || usageOut) {
        await recordUsage(claims.sub, usageIn, usageOut).catch((error) => {
          request.log.error({ err: error }, "record usage failed");
        });
      }
    }

    return reply;
  });
}
