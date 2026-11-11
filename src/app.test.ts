import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./app.ts";

test("健康检查返回 200", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  await app.close();
});

test("OPTIONS 预检返回 204", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "OPTIONS", url: "/api/auth/guest" });
  assert.equal(response.statusCode, 204);
  await app.close();
});

test("未登录访问 /api/me 返回 401", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test("请求体不合法时返回 400", async () => {
  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/guest",
    payload: { deviceId: "x" },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});
