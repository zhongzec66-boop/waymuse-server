import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { requireAuth } from "./auth.ts";
import { checkQuota, estimateCostCents } from "./quota.ts";
import { buildKbContext, gradeToGradYear, searchKb } from "./kb.ts";
import { composeSystemPrompt } from "./prompts/index.ts";
import type { Usage } from "./quota.ts";

/**
 * AI 代理。
 *
 * 客户端不持 Key：这里用服务端 Key 调 DeepSeek，按 SSE 原样透传；
 * 每轮结束按 token 记账，超配额或触发全局熔断就返回 429/503，
 * 客户端据此回退到本地兜底。
 */

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;

/** 纯文本用字符串；带图时用 OpenAI 兼容的块数组（deepseek-flash 支持 image_url） */
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

/** 取出消息里的纯文本（用于检索与估算） */
function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function imageCount(content: string | ContentPart[]): number {
  if (typeof content === "string") return 0;
  return content.filter((part) => part.type === "image_url").length;
}

/**
 * 粗略估算输入 token：
 * 文本按字符数，图片按 1500 token/张（约等于一张 1024×1024 的高清图）。
 */
function estimateInputTokens(content: string | ContentPart[]): number {
  return textOf(content).length + imageCount(content) * 1500;
}

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

/**
 * 把学长的经验要点拼进 system prompt。
 *
 * 失败一律降级为「不注入」：经验库挂了不能影响聊天。
 */
async function withKnowledge(
  userId: string,
  messages: ChatMessage[],
): Promise<{ messages: ChatMessage[]; kbCount: number; kbTags: string[] }> {
  try {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const question = lastUser ? textOf(lastUser.content) : "";
    if (!question.trim()) return { messages, kbCount: 0, kbTags: [] };

    const profile = await query<{
      school: string;
      major: string;
      grade: string;
    }>(
      "select school, major, grade from profiles where user_id = $1",
      [userId],
    );
    const row = profile.rows[0];

    const entries = await searchKb({
      question,
      school: row?.school,
      major: row?.major,
      gradYear: row?.grade ? gradeToGradYear(row.grade) : undefined,
      limit: 4,
    });

    await query(
      "insert into kb_query_log(user_id, query, matched) values ($1, $2, $3)",
      [userId, question.slice(0, 200), entries.length],
    ).catch(() => undefined);

    const context = buildKbContext(entries);
    if (!context) return { messages, kbCount: 0, kbTags: [] };

    // 只带「专业 + 标签」这种不含个人信息的摘要，用于客户端展开「参考了什么」
    const kbTags = [
      ...new Set(
        entries
          .flatMap((entry) => [entry.major, ...entry.tags])
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ].slice(0, 8);

    const systemIndex = messages.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      const next = [...messages];
      const current = next[systemIndex]!.content;
      if (typeof current === "string") {
        next[systemIndex] = { ...next[systemIndex]!, content: `${current}\n\n${context}` };
      } else {
        next.unshift({ role: "system", content: context });
      }
      return { messages: next, kbCount: entries.length, kbTags };
    }
    return {
      messages: [{ role: "system", content: context }, ...messages],
      kbCount: entries.length,
      kbTags,
    };
  } catch {
    return { messages, kbCount: 0, kbTags: [] };
  }
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
              // 纯文本用字符串；带图片时用 OpenAI 兼容的 content 块数组
              content: z.union([
                z.string().min(1).max(40_000),
                z
                  .array(
                    z.union([
                      z.object({
                        type: z.literal("text"),
                        text: z.string().max(40_000),
                      }),
                      z.object({
                        type: z.literal("image_url"),
                        image_url: z.object({
                          // data:image/... 或 http(s) 链接
                          url: z.string().min(8).max(12_000_000),
                        }),
                      }),
                    ]),
                  )
                  .min(1)
                  .max(6),
              ]),
            }),
          )
          .min(1)
          .max(40),
        useServerPrompt: z.boolean().optional(),
        variables: z
          .object({
            today: z.string().max(500).optional(),
            companion: z.string().max(2_000).optional(),
            identity: z.string().max(8_000).optional(),
            soul: z.string().max(8_000).optional(),
            memory: z.string().max(8_000).optional(),
            profile: z.string().max(4_000).optional(),
            memories: z.array(z.string().max(500)).max(50).optional(),
            courses: z.array(z.string().max(500)).max(50).optional(),
            tasks: z.array(z.string().max(500)).max(50).optional(),
            insights: z.string().max(4_000).optional(),
            web: z.string().max(8_000).optional(),
          })
          .optional(),
        temperature: z.number().min(0).max(2).optional(),
        // flash 会先输出 reasoning_content，给太少正文就空了
        maxTokens: z.number().int().min(64).max(16_384).optional(),
      })
      .safeParse(request.body);

    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    // 提示词模板在服务端拼：客户端只发变量。
    // 老客户端没带 useServerPrompt，就用它自己发上来的 system prompt，行为不变。
    let incoming = body.data.messages;
    let skillId: string | null = null;
    if (body.data.useServerPrompt) {
      const lastUser = [...incoming]
        .reverse()
        .find((message) => message.role === "user");
      const userText =
        lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
      const composed = composeSystemPrompt(body.data.variables ?? {}, userText);
      skillId = composed.skillId;
      incoming = [
        { role: "system" as const, content: composed.prompt },
        ...incoming.filter((message) => message.role !== "system"),
      ];
    }

    const usage = await readUsage(claims.sub);
    const decision = checkQuota(
      usage,
      {
        monthlyTokenLimit: config.monthlyTokenLimit,
        dailyTokenLimit: config.dailyTokenLimit,
        globalDailyCostCents: config.globalDailyCostCents,
      },
      // 先按输入长度给一个保守估计，实际以返回的 usage 为准
      incoming.reduce((sum: number, m: (typeof incoming)[number]) => sum + estimateInputTokens(m.content), 0),
    );

    if (!decision.allowed) {
      return reply.code(decision.reason === "global" ? 503 : 429).send({
        error: "quota_exceeded",
        reason: decision.reason,
        retryAfterSec: decision.retryAfterSec,
      });
    }

    // 经验库注入：只给「要点」，不给原文，也不带任何人的标识
    const { messages, kbCount, kbTags } = await withKnowledge(claims.sub, incoming);


    const upstream = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      body: JSON.stringify({
        model: config.deepseek.model,
        messages,
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
      // 命中的学长经验条数，客户端用来显示「参考了 N 位同专业学长」
      "x-waymuse-kb": String(kbCount),
      "x-waymuse-kb-tags": encodeURIComponent(JSON.stringify(kbTags)),
      // 命中的技能 id。必须写进 writeHead：reply.header() 会被 raw 绕过。
      ...(skillId ? { "x-waymuse-skill": skillId } : {}),
      "access-control-expose-headers":
        "x-waymuse-kb, x-waymuse-kb-tags, x-waymuse-skill",
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
