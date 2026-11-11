import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approximateTokens,
  checkQuota,
  estimateCostCents,
  secondsToMonthEnd,
  secondsToUtcMidnight,
} from "./quota.ts";

const limits = {
  monthlyTokenLimit: 300_000,
  dailyTokenLimit: 30_000,
  globalDailyCostCents: 1000,
};

test("配额充足时放行", () => {
  const decision = checkQuota(
    { monthlyTokens: 1000, dailyTokens: 1000, globalDailyCostCents: 10 },
    limits,
    500,
  );
  assert.equal(decision.allowed, true);
});

test("日额度用尽时拒绝，并给重试时间", () => {
  const decision = checkQuota(
    { monthlyTokens: 1000, dailyTokens: 29_900, globalDailyCostCents: 10 },
    limits,
    500,
  );
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.reason, "daily");
    assert.ok(decision.retryAfterSec > 0);
  }
});

test("月额度用尽时拒绝", () => {
  const decision = checkQuota(
    { monthlyTokens: 299_900, dailyTokens: 0, globalDailyCostCents: 0 },
    limits,
    500,
  );
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "monthly");
});

test("全局成本熔断优先于个人额度", () => {
  const decision = checkQuota(
    { monthlyTokens: 0, dailyTokens: 0, globalDailyCostCents: 1000 },
    limits,
    100,
  );
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "global");
});

test("成本估算：10 万输入 + 2 万输出", () => {
  const cents = estimateCostCents(100_000, 20_000, {
    monthlyTokenLimit: 300_000,
    inputCentsPerMillion: 100,
    outputCentsPerMillion: 200,
  });
  // 0.1M * 100 + 0.02M * 200 = 10 + 4 = 14 分
  assert.equal(Math.round(cents), 14);
});

test("中文按字估算 token", () => {
  assert.equal(approximateTokens("你好世界"), 4);
  assert.equal(approximateTokens("abcdefgh"), 2);
});

test("重置时间都是正数", () => {
  assert.ok(secondsToUtcMidnight() > 0);
  assert.ok(secondsToMonthEnd() > 0);
});
