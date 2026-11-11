/**
 * 运行时配置。所有值来自环境变量，缺失就给保守默认值并在启动时打日志。
 */

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const config = {
  port: num("PORT", 8787),
  databaseUrl: str("DATABASE_URL", "postgres://waymuse:waymuse@db:5432/waymuse"),
  redisUrl: str("REDIS_URL", "redis://cache:6379"),

  /** 签名密钥，必须自己设；默认值只用于本地开发 */
  jwtSecret: str("JWT_SECRET", "dev-only-change-me"),

  accessTtlSec: num("ACCESS_TTL_SEC", 15 * 60),
  refreshTtlSec: num("REFRESH_TTL_SEC", 30 * 24 * 3600),

  /** 配额：30 万 token/月，3 万/天（按账号算） */
  monthlyTokenLimit: num("MONTHLY_TOKEN_LIMIT", 300_000),
  dailyTokenLimit: num("DAILY_TOKEN_LIMIT", 30_000),

  /** 全局熔断：当日总成本（分）超过就拒绝，客户端回退本地兜底 */
  globalDailyCostCents: num("GLOBAL_DAILY_COST_CENTS", 1000),

  /** 成本估算：每百万 token 的分数（1 元 = 100 分） */
  inputCentsPerMillion: num("INPUT_CENTS_PER_MILLION", 100),
  outputCentsPerMillion: num("OUTPUT_CENTS_PER_MILLION", 200),

  /** 同账号最多几台设备在线 */
  maxDevicesPerUser: num("MAX_DEVICES_PER_USER", 2),

  deepseek: {
    baseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    apiKey: str("DEEPSEEK_API_KEY"),
    model: str("DEEPSEEK_MODEL", "deepseek-chat"),
  },

  mail: {
    host: str("SMTP_HOST", "smtp.qq.com"),
    port: num("SMTP_PORT", 465),
    user: str("SMTP_USER"),
    /** QQ 邮箱用的是授权码，不是登录密码 */
    pass: str("SMTP_PASS"),
    from: str("SMTP_FROM", str("SMTP_USER")),
  },

  turnstile: {
    secret: str("TURNSTILE_SECRET"),
    /** 本地开发可以关掉，线上必须开着 */
    required: str("TURNSTILE_REQUIRED", "1") !== "0",
  },
} as const;

export function assertProductionConfig(): string[] {
  const problems: string[] = [];
  if (config.jwtSecret === "dev-only-change-me") {
    problems.push("JWT_SECRET 还是默认值");
  }
  if (!config.deepseek.apiKey) problems.push("DEEPSEEK_API_KEY 未设置");
  if (!config.mail.user || !config.mail.pass) {
    problems.push("SMTP_USER / SMTP_PASS 未设置（QQ 邮箱需要用授权码）");
  }
  if (config.turnstile.required && !config.turnstile.secret) {
    problems.push("TURNSTILE_SECRET 未设置");
  }
  return problems;
}
