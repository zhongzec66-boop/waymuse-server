import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCourses } from "./course.ts";

test("纯 JSON 能解析", () => {
  const courses = extractCourses(
    '{"courses":[{"name":"高等数学","weekday":1,"start":"08:00","end":"09:40","place":"教三-302"}]}',
  );
  assert.equal(courses.length, 1);
  assert.equal(courses[0]?.name, "高等数学");
  assert.equal(courses[0]?.weekday, 1);
});

test("包在代码块里也能解析", () => {
  const courses = extractCourses(
    '```json\n{"courses":[{"name":"大学英语","weekday":3,"start":"10:00","end":"11:40"}]}\n```',
  );
  assert.equal(courses.length, 1);
  assert.equal(courses[0]?.name, "大学英语");
});

test("前后有废话也能解析", () => {
  const courses = extractCourses(
    '好的，提取结果如下：\n{"courses":[{"name":"数据结构","weekday":2,"start":"14:00","end":"15:40"}]}\n希望有帮助。',
  );
  assert.equal(courses.length, 1);
});

test("非法字段被丢弃，合法字段保留", () => {
  const courses = extractCourses(
    '{"courses":[{"name":"合法","weekday":5,"start":"08:00","end":"09:40"},{"name":"缺时间","weekday":5},{"weekday":2,"start":"08:00","end":"09:40"}]}',
  );
  assert.equal(courses.length, 1);
  assert.equal(courses[0]?.name, "合法");
});

test("完全不是 JSON 返回空数组", () => {
  assert.deepEqual(extractCourses("我看不清这张图"), []);
  assert.deepEqual(extractCourses(""), []);
});

test("最多 60 条", () => {
  const many = {
    courses: Array.from({ length: 80 }, (_, index) => ({
      name: `课${index}`,
      weekday: 1,
      start: "08:00",
      end: "09:40",
    })),
  };
  assert.equal(extractCourses(JSON.stringify(many)).length, 60);
});
