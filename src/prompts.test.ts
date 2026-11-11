import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt, matchSkill } from "./prompts/index.ts";

test("技能按触发词命中：考试类问题进考试冲刺", () => {
  const skill = matchSkill("明天考试，我背不下来怎么办");
  assert.equal(skill?.id, "exam-sprint");
});

test("技能按触发词命中：论文类问题进论文推进", () => {
  const skill = matchSkill("开题报告不知道写什么");
  assert.equal(skill?.id, "thesis");
});

test("日常闲聊不命中任何技能", () => {
  assert.equal(matchSkill("今天天气不错"), null);
});

test("空消息不命中", () => {
  assert.equal(matchSkill("   "), null);
});

test("命中的触发词越长越优先", () => {
  // 「明天考」属于考试冲刺；单字「考」如果命中别的技能也会被更长的词压过
  const skill = matchSkill("明天考高数");
  assert.equal(skill?.id, "exam-sprint");
});

test("拼装结果包含基础人格、协议，并在命中时带上技能正文", () => {
  const composed = composeSystemPrompt(
    { today: "今天是 2026-11-11 周三" },
    "明天考试怎么办",
  );
  assert.match(composed.prompt, /WayMuse/);
  assert.match(composed.prompt, /回复协议/);
  assert.equal(composed.skillId, "exam-sprint");
  assert.match(composed.prompt, /考试冲刺/);
});

test("没命中技能时不带技能正文", () => {
  const composed = composeSystemPrompt({}, "你好");
  assert.equal(composed.skillId, null);
  assert.doesNotMatch(composed.prompt, /# 考试冲刺/);
});

test("三份人格文件会拼进去", () => {
  const composed = composeSystemPrompt(
    {
      identity: "Name: WayMuse",
      soul: "先自己查再问",
      memory: "- 大二 计算机",
    },
    "你好",
  );
  assert.match(composed.prompt, /【IDENTITY\.md】/);
  assert.match(composed.prompt, /【SOUL\.md】/);
  assert.match(composed.prompt, /【MEMORY\.md】/);
});

test("列表类变量最多 30 项，防止撑爆上下文", () => {
  const courses = Array.from({ length: 60 }, (_, index) => `课程 ${index}`);
  const composed = composeSystemPrompt({ courses }, "你好");
  const lines = composed.prompt.split("\n").filter((line) => line.startsWith("- 课程 "));
  assert.equal(lines.length, 30);
});

test("超长变量会被截断", () => {
  const composed = composeSystemPrompt({ identity: "x".repeat(20_000) }, "你好");
  assert.ok(composed.prompt.length < 20_000);
});
