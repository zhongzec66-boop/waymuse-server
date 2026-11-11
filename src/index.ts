import { config, assertProductionConfig } from "./config.ts";
import { ensureRedis } from "./redis.ts";
import { buildApp } from "./app.ts";

async function main() {
  const app = buildApp();

  const problems = assertProductionConfig();
  if (problems.length) {
    app.log.warn({ problems }, "配置不完整，部分功能会不可用");
  }

  await ensureRedis();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`WayMuse API 已启动 :${config.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
