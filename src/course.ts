import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { config } from "./config.ts";
import { requireAuth } from "./auth.ts";
import { rateLimit } from "./redis.ts";

/**
 * 课表截图 → 结构化课程。
 *
 * 和聊天不同：这里要的是 JSON，不是聊天回复。
 * 走 deepseek-flash 的视觉输入，模型只负责「看图抽字段」，写不进数据库的
 * 一律在服务端丢掉，前端再让用户确认一次。
 */

const courseSchema = z.object({
  name: z.string().min(1).max(40),
  weekday: z.number().int().min(1).max(7),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  place: z.string().max(40).optional(),
  weeks: z.array(z.number().int().min(1).max(30)).max(30).optional(),
});

const PROMPT = `你在做课表截图的信息提取。只输出 JSON，不要解释、不要 Markdown 代码块。

输出格式：
{"courses":[{"name":"高等数学","weekday":1,"start":"08:00","end":"09:40","place":"教三-302","weeks":[1,2,3]}]}

规则：
- weekday：1=周一 … 7=周日。
- start/end 用 24 小时制 HH:mm。如果图上只有节次（如「1-2 节」），按 1-2 节 08:00-09:40、3-4 节 10:00-11:40、5-6 节 14:00-15:40、7-8 节 16:00-17:40、9-10 节 19:00-20:40 换算。
- place 只写教室/地点，没有就省略。
- weeks 只在图上明确写了周次范围时才给（如「1-16 周」→ [1..16]）；没写就省略。
- 一门课出现在多个时间段，就输出多条。
- 看不清的字段宁可省略，不要猜。
- 最多 60 条。`;

export function registerCourseRoutes(app: FastifyInstance) {
  app.post("/api/course/parse-image", async (request, reply) => {
    const claims = await requireAuth(request);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });

    const body = z
      .object({
        imageDataUrl: z.string().min(64).max(12_000_000),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    // 一次识图约 2k token，防止有人刷：每人每天 20 次
    const limit = await rateLimit(`rl:course:${claims.sub}`, 20, 86_400);
    if (!limit.ok) {
      return reply.code(429).send({ error: "too_many_requests" });
    }

    const upstream = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      body: JSON.stringify({
        model: config.deepseek.model,
        temperature: 0,
        max_tokens: 2400,
        messages: [
          { role: "system", content: PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "提取这张课表截图里的所有课程。" },
              { type: "image_url", image_url: { url: body.data.imageDataUrl } },
            ],
          },
        ],
      }),
    });

    if (!upstream.ok) {
      return reply.code(502).send({ error: "upstream_failed", status: upstream.status });
    }

    const payload = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const raw = payload.choices?.[0]?.message?.content ?? "";

    const courses = extractCourses(raw);
    if (!courses.length) {
      return reply.code(422).send({
        error: "no_courses_found",
        hint: "截图里没识别出课程，换一张更清晰的、或者直接粘贴文字",
      });
    }

    return reply.send({
      courses,
      usage: payload.usage?.total_tokens ?? 0,
    });
  });
}

/** 模型有时会把 JSON 包在代码块里，或者前面带一句废话 */
export function extractCourses(raw: string): z.infer<typeof courseSchema>[] {
  const cleaned = raw
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return [];

  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    const list =
      Array.isArray(parsed)
        ? parsed
        : (parsed as { courses?: unknown }).courses;
    if (!Array.isArray(list)) return [];

    const result: z.infer<typeof courseSchema>[] = [];
    for (const item of list.slice(0, 60)) {
      const one = courseSchema.safeParse(item);
      if (one.success) result.push(one.data);
    }
    return result;
  } catch {
    return [];
  }
}
