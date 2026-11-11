/**
 * 配额与成本计算（纯函数，方便单测，不碰数据库）。
 */

export type Usage = {
  monthlyTokens: number;
  dailyTokens: number;
  globalDailyCostCents: number;
};

export type Limits = {
  monthlyTokenLimit: number;
  dailyTokenLimit: number;
  globalDailyCostCents: number;
};

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: "daily" | "monthly" | "global"; retryAfterSec: number };

/** 按 token 用量估算成本（分） */
export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
  limits: Pick<Limits, "monthlyTokenLimit"> & {
    inputCentsPerMillion: number;
    outputCentsPerMillion: number;
  },
): number {
  const million = 1_000_000;
  return (
    (inputTokens / million) * limits.inputCentsPerMillion +
    (outputTokens / million) * limits.outputCentsPerMillion
  );
}

/** 一次请求前先看还有没有额度；approximateTokens 用请求长度估算 */
export function checkQuota(
  usage: Usage,
  limits: Limits,
  approximateTokens: number,
): Decision {
  if (usage.globalDailyCostCents >= limits.globalDailyCostCents) {
    // 全局熔断：到明天 0 点（UTC）重置
    return { allowed: false, reason: "global", retryAfterSec: secondsToUtcMidnight() };
  }
  if (usage.dailyTokens + approximateTokens > limits.dailyTokenLimit) {
    return { allowed: false, reason: "daily", retryAfterSec: secondsToUtcMidnight() };
  }
  if (usage.monthlyTokens + approximateTokens > limits.monthlyTokenLimit) {
    return { allowed: false, reason: "monthly", retryAfterSec: secondsToMonthEnd() };
  }
  return { allowed: true };
}

export function secondsToUtcMidnight(now = new Date()): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

export function secondsToMonthEnd(now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

/** 粗略估算一次请求的 token 数：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token */
export function approximateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}
