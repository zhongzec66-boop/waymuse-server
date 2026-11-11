import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth.ts";
import { registerAiRoutes } from "./ai.ts";
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

  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", request.headers.origin ?? "*");
    reply.header("access-control-allow-headers", "content-type, authorization");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
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

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "unhandled");
    reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
