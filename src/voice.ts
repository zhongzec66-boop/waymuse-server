import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { config } from "./config.ts";
import { requireAuth } from "./auth.ts";
import { query } from "./db.ts";
import { rateLimit } from "./redis.ts";

/**
 * 语音合成（一期）。
 *
 * 设计要点：
 * - Breeze key 只在服务端，客户端拿到的永远是音频字节
 * - 上游流式返回，边回客户端边写缓存（tee），命中直接读文件
 * - 按字符数计配额，不走 token
 * - 客户端断连立刻掐掉上游请求，不为离开的用户付费
 */

const bodySchema = z.object({
  text: z.string().min(1).max(600),
  voiceId: z.string().max(64).optional(),
  instruction: z.string().max(120).optional(),
});

function cacheKey(text: string, voiceId: string, instruction: string): string {
  return createHash("sha256")
    .update(`${text}\u0000${voiceId}\u0000${instruction}`)
    .digest("hex");
}

/** 每用户每天 / 每月字符数 */
async function readVoiceUsage(userId: string): Promise<{ day: number; month: number }> {
  const { rows } = await query<{ day: string | null; month: string | null }>(
    `select
       (select coalesce(sum(chars),0) from voice_usage_daily
         where user_id = $1 and day = current_date)::text as day,
       (select coalesce(sum(chars),0) from voice_usage_daily
         where user_id = $1 and day >= date_trunc('month', current_date))::text as month`,
    [userId],
  );
  return {
    day: Number(rows[0]?.day ?? 0),
    month: Number(rows[0]?.month ?? 0),
  };
}

async function addVoiceUsage(userId: string, chars: number): Promise<void> {
  await query(
    `insert into voice_usage_daily(user_id, day, chars, requests)
     values ($1, current_date, $2, 1)
     on conflict (user_id, day) do update
       set chars = voice_usage_daily.chars + excluded.chars,
           requests = voice_usage_daily.requests + 1,
           updated_at = now()`,
    [userId, chars],
  );
}

export function registerVoiceRoutes(app: FastifyInstance) {
  app.post("/api/voice/tts", async (request, reply) => {
    const claims = await requireAuth(request);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    if (!config.breeze.apiKey) {
      request.log.error("BREEZE_API_KEY 未配置");
      return reply.code(503).send({ error: "audio_unavailable" });
    }

    const text = parsed.data.text.trim();
    const chars = [...text].length;
    if (chars > config.breeze.maxCharsPerRequest) {
      return reply.code(400).send({ error: "text_too_long" });
    }

    const voiceId = (parsed.data.voiceId ?? config.breeze.voiceId).trim() || config.breeze.voiceId;
    const instruction = (parsed.data.instruction ?? "").trim();

    // 一个用户一轮对话最多 6 段，60 次/分钟足够
    const limit = await rateLimit(`rl:tts:${claims.sub}`, 60, 60);
    if (!limit.ok) return reply.code(429).send({ error: "rate_limited" });

    const usage = await readVoiceUsage(claims.sub);
    if (
      usage.day + chars > config.breeze.dailyChars ||
      usage.month + chars > config.breeze.monthlyChars
    ) {
      return reply.code(429).send({
        error: "quota_exceeded",
        dailyUsed: usage.day,
        monthlyUsed: usage.month,
      });
    }

    const hash = cacheKey(text, voiceId, instruction);
    const file = join(config.breeze.cacheDir, hash.slice(0, 2), `${hash}.mp3`);

    reply.header("access-control-expose-headers", "x-waymuse-cache, x-waymuse-chars, x-waymuse-voice");

    // ① 命中缓存：直接回文件
    if (existsSync(file)) {
      const info = await stat(file);
      await query(
        `update voice_cache set hits = hits + 1, last_hit_at = now() where hash = $1`,
        [hash],
      ).catch(() => undefined);

      reply
        .header("content-type", "audio/mpeg")
        .header("content-length", String(info.size))
        .header("cache-control", "private, max-age=86400")
        .header("x-waymuse-cache", "hit")
        .header("x-waymuse-chars", String(chars))
        .header("x-waymuse-voice", voiceId);
      return reply.send(createReadStream(file));
    }

    // ② 未命中：请求上游，边转发边落盘
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.breeze.timeoutMs);
    // 客户端断开就不再为它付费
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    const upstreamBody: Record<string, unknown> = {
      text,
      model_id: config.breeze.model,
      language_code: config.breeze.languageCode,
    };
    // Breeze 不接受 instruction 字段（顶层和 voice_settings 都 422），
    // 但接受 voice_settings.style / speed，用它承载语气预设。
    if (instruction) {
      upstreamBody.voice_settings = { style: instruction.slice(0, 120) };
    }

    let upstream: Response;
    try {
      upstream = await fetch(
        `${config.breeze.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3`,
        {
          method: "POST",
          headers: {
            "xi-api-key": config.breeze.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(upstreamBody),
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timer);
      request.log.warn({ err: error }, "tts 上游请求失败");
      return reply.code(502).send({ error: "audio_unavailable" });
    }

    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      const detail = (await upstream.text().catch(() => "")).slice(0, 200);
      request.log.warn({ status: upstream.status, detail }, "tts 上游拒绝");
      return reply.code(502).send({ error: "audio_unavailable" });
    }

    reply.raw.writeHead(200, {
      "content-type": "audio/mpeg",
      "cache-control": "private, max-age=86400",
      "x-waymuse-cache": "miss",
      "x-waymuse-chars": String(chars),
      "x-waymuse-voice": voiceId,
      "access-control-allow-origin": request.headers.origin ?? "*",
      "access-control-expose-headers": "x-waymuse-cache, x-waymuse-chars, x-waymuse-voice",
      vary: "Origin",
    });

    const temp = `${file}.part`;
    await mkdir(dirname(file), { recursive: true });
    const disk = createWriteStream(temp);
    const reader = upstream.body.getReader();
    let bytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        disk.write(Buffer.from(value));
        if (!reply.raw.write(Buffer.from(value))) {
          await new Promise((resolve) => reply.raw.once("drain", resolve));
        }
      }
      reply.raw.end();
      disk.end();

      // 只有完整收完才进缓存，避免半截文件被后续命中
      await new Promise<void>((resolve) => disk.once("close", () => resolve()));
      if (bytes > 1024) {
        await rename(temp, file);
        await query(
          `insert into voice_cache(hash, voice_id, chars, bytes)
           values ($1,$2,$3,$4)
           on conflict (hash) do update set bytes = excluded.bytes, last_hit_at = now()`,
          [hash, voiceId, chars, bytes],
        ).catch(() => undefined);
      } else {
        await unlink(temp).catch(() => undefined);
      }

      await addVoiceUsage(claims.sub, chars).catch(() => undefined);
      request.log.info({ chars, voiceId, bytes, cache: "miss" }, "tts 完成");
    } catch (error) {
      disk.destroy();
      await unlink(temp).catch(() => undefined);
      if (!reply.raw.writableEnded) reply.raw.end();
      request.log.warn({ err: error }, "tts 传输中断");
    } finally {
      clearTimeout(timer);
    }
  });
}
