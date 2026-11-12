import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerAuthRoutes } from "./auth.ts";
import { registerAiRoutes } from "./ai.ts";
import { registerCourseRoutes } from "./course.ts";
import { registerVoiceRoutes } from "./voice.ts";
import { verifyMailer } from "./mailer.ts";
import { pool } from "./db.ts";

/**
 * 只负责组装，不负责 listen。
 * 这样可以在没有 Redis/Postgres 的环境里用 inject() 做冒烟测试。
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  // CORS 必须用插件：手写 onRequest 里 reply.send() 不会带上头
  void app.register(cors, {
    origin: true, // 回显请求来源；App 和本地调试都能用
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
    maxAge: 600,
  });

  app.get("/health", async () => ({ ok: true, now: new Date().toISOString() }));

  app.get("/ready", async (_request, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      await pool.query("select 1");
      checks.db = true;
    } catch {
      checks.db = false;
    }
    checks.mail = await verifyMailer();
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  registerAuthRoutes(app);
  registerAiRoutes(app);
  registerCourseRoutes(app);
  registerVoiceRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "unhandled");
    reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
