import { BASE_PROMPT } from "./base.ts";
import { PROTOCOL_PROMPT } from "./protocol.ts";
import { SKILLS } from "./skills.ts";
import type { Skill } from "./skills.ts";

/**
 * 服务端拼装 system prompt。
 *
 * 为什么放在服务端：模板是中文明文，几万字，放在客户端里拆包就能整段抄走。
 * 搬过来以后，客户端只发「用户原话 + 结构化变量」，能力清单和正文都不出服务器。
 *
 * 兼容：老客户端仍然会把完整 system prompt 发上来，那条路保持不变
 * （见 ai.ts 里的分支），所以已发出去的包不会坏。
 */

export type PromptVariables = {
  /** 日期与教学周，例如「今天是 2026-11-11 周三 · 第 11 周」 */
  today?: string;
  /** 语气与回复长度偏好 */
  companion?: string;
  identity?: string;
  soul?: string;
  memory?: string;
  /** 学校 / 专业 / 年级 / 方向 */
  profile?: string;
  memories?: string[];
  courses?: string[];
  tasks?: string[];
  /** 本机读到的状态（屏幕时间 / 步数） */
  insights?: string;
  /** 联网搜索结果 */
  web?: string;
};

export type ComposedPrompt = {
  prompt: string;
  /** 命中的技能 id，用于日志与排错 */
  skillId: string | null;
};

/** 单段变量上限：防止有人塞几十万字把上下文撑爆 */
const MAX_SECTION = 4_000;
/** 列表类变量最多几项 */
const MAX_ITEMS = 30;

function clip(value: string | undefined, max = MAX_SECTION): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function clipList(values: string[] | undefined, perItem = 200): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => clip(item, perItem))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

/**
 * 按触发词挑一个技能。
 *
 * 打分规则：命中的触发词越长越具体（「明天考」比「考」更指向考试冲刺），
 * 所以用「命中词长度之和」排序，同分取先定义的。
 */
export function matchSkill(userMessage: string): Skill | null {
  const text = (userMessage ?? "").trim();
  if (!text) return null;

  let best: Skill | null = null;
  let bestScore = 0;
  for (const skill of SKILLS) {
    let score = 0;
    for (const trigger of skill.triggers) {
      if (trigger && text.includes(trigger)) score += trigger.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return best;
}

export function composeSystemPrompt(
  variables: PromptVariables,
  userMessage: string,
): ComposedPrompt {
  const skill = matchSkill(userMessage);
  const sections: string[] = [BASE_PROMPT];

  const today = clip(variables.today, 200);
  if (today) sections.push("", today);

  const companion = clip(variables.companion, 500);
  if (companion) sections.push(companion);

  for (const [title, value] of [
    ["IDENTITY.md", clip(variables.identity)],
    ["SOUL.md", clip(variables.soul)],
    ["MEMORY.md", clip(variables.memory)],
  ] as const) {
    if (value) sections.push(`【${title}】\n${value}`);
  }

  if (skill) sections.push(skill.body);

  const insights = clip(variables.insights, 1_000);
  if (insights) sections.push(insights);

  sections.push(PROTOCOL_PROMPT);

  const profile = clip(variables.profile, 1_000);
  if (profile) sections.push("", profile);

  const memories = clipList(variables.memories);
  if (memories.length) sections.push(`【记忆】${memories.join("；")}`);

  const courses = clipList(variables.courses);
  if (courses.length) {
    sections.push("【课程】", ...courses.map((line) => `- ${line}`));
  }

  const tasks = clipList(variables.tasks);
  if (tasks.length) {
    sections.push("【任务】", ...tasks.map((line) => `- ${line}`));
  }

  const web = clip(variables.web);
  if (web) sections.push("", web);

  return { prompt: sections.join("\n"), skillId: skill?.id ?? null };
}

/** 供接口层校验：只允许这些变量名 */
export const ALLOWED_VARIABLES = [
  "today",
  "companion",
  "identity",
  "soul",
  "memory",
  "profile",
  "memories",
  "courses",
  "tasks",
  "insights",
  "web",
] as const;
