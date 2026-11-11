import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKbContext, extractKeywords, gradeToGradYear } from "./kb.ts";
import { mapRow, scrub } from "./sync-kb.ts";

test("关键词：中文长句能切出有意义的片段", () => {
  const words = extractKeywords("我是计算机大三，想问问怎么准备保研");
  assert.ok(words.includes("保研"));
  assert.ok(words.length > 0 && words.length <= 12);
  assert.ok(!words.includes("怎么"));
});

test("关键词：去掉虚词", () => {
  const words = extractKeywords("有没有什么办法");
  assert.ok(!words.includes("有没有"));
  assert.ok(!words.includes("什么"));
});

test("经验上下文：包含规则且不含个人字段", () => {
  const context = buildKbContext([
    {
      id: "1",
      school: "某大学",
      major: "计算机",
      grad_year: 2025,
      tags: ["保研"],
      situation: "大三想保研但没科研",
      approach: "提前联系导师，做一个小项目",
      outcome: "保研成功",
      pitfalls: "联系太晚",
    },
  ]);
  assert.ok(context.includes("同专业学长的经验要点"));
  assert.ok(context.includes("不要照抄"));
  assert.ok(context.includes("不要提及具体的人"));
  // 不应出现身份字段
  assert.ok(!context.includes("owner"));
  assert.ok(!context.includes("email"));
});

test("空结果不注入任何东西", () => {
  assert.equal(buildKbContext([]), "");
});

test("年级换算：大三 → 两年后毕业", () => {
  const year = gradeToGradYear("大三", new Date("2026-01-01T00:00:00Z"));
  assert.equal(year, 2028);
  assert.equal(gradeToGradYear("随便写"), undefined);
});

test("正文清洗：抹掉邮箱、手机号、链接", () => {
  const text = scrub("联系我 a@b.com 或 13800138000，参考 https://x.com/abc 谢谢");
  assert.ok(!text.includes("a@b.com"));
  assert.ok(!text.includes("13800138000"));
  assert.ok(!text.includes("http"));
});

test("映射：缺 id 或内容太短则丢弃", () => {
  assert.equal(mapRow({ main_content: "x" }), null);
  assert.equal(mapRow({ id: "1", answer: "短" }), null);
});

test("映射：正常行能取到字段并脱敏", () => {
  const mapped = mapRow({
    id: "abc",
    school: "测试大学",
    major: "软件工程",
    grad_year: 2025,
    tags: ["实习", "简历"],
    situation: "大二想找实习",
    answer: "先做一个项目，然后投 20 家。联系 zz@qq.com",
    outcome: "拿到 offer",
  });
  assert.ok(mapped);
  assert.equal(mapped?.school, "测试大学");
  assert.deepEqual(mapped?.tags, ["实习", "简历"]);
  assert.ok(!mapped?.approach.includes("zz@qq.com"));
});
