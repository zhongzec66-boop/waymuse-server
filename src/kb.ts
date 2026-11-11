import { query } from "./db.ts";

/**
 * 学长学姐经验检索。
 *
 * 只做「结构化过滤 + 关键词」，不引入向量库：
 * 几千条规模下，pg_trgm 足够，而且解释性强、成本为零。
 */

export type KbEntry = {
  id: string;
  school: string;
  major: string;
  grad_year: number | null;
  tags: string[];
  situation: string;
  approach: string;
  outcome: string;
  pitfalls: string;
};

export type KbSearchInput = {
  question: string;
  school?: string;
  major?: string;
  gradYear?: number;
  limit?: number;
};

/**
 * 学生场景的领域词表。
 * 中文没有空格，纯滑窗会切出一堆噪声（「我是计」「算机大」），
 * 先用领域词命中，再补短词，效果稳定得多。
 */
const LEXICON = [
  "保研", "考研", "考公", "实习", "求职", "秋招", "春招", "简历", "面试",
  "竞赛", "论文", "科研", "实验室", "出国", "留学", "雅思", "托福",
  "奖学金", "绩点", "挂科", "转专业", "四六级", "社团", "学生会",
  "时间管理", "拖延", "焦虑", "作息", "熬夜", "选课", "双学位",
  "就业", "转行", "大厂", "国企", "体制内", "导师", "开题", "答辩",
];

const STOP = new Set([
  "什么", "怎么", "如何", "可以", "有没有", "一些", "这个", "那个",
  "我的", "我是", "想要", "应该", "请问", "一下", "现在", "自己",
  "问问", "准备", "想问", "的话", "时候", "有点", "最近", "感觉",
]);

/** 从问题里抽关键词：领域词优先，其次补 2~3 字短词 */
export function extractKeywords(question: string): string[] {
  const text = question.trim();
  const words: string[] = [];
  const seen = new Set<string>();

  const add = (word: string) => {
    if (word.length < 2 || STOP.has(word) || seen.has(word)) return;
    seen.add(word);
    words.push(word);
  };

  // 1. 领域词命中（按出现顺序）
  for (const word of LEXICON) {
    if (text.includes(word)) add(word);
  }

  // 2. 补充：2~3 字滑窗，只取前面几个，避免噪声淹没
  const cleaned = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ").trim();
  for (const token of cleaned.split(/\s+/).filter(Boolean)) {
    if (token.length >= 2 && token.length <= 6) add(token);
  }

  return words.slice(0, 12);
}

/** 「大三」→ 毕业年份（本科四年制，粗略估算） */
export function gradeToGradYear(grade: string, now = new Date()): number | undefined {
  const text = grade.trim();
  const map: Record<string, number> = {
    大一: 4, 大二: 3, 大三: 2, 大四: 1,
    研一: 3, 研二: 2, 研三: 1,
  };
  const years = map[text];
  if (!years) return undefined;
  return now.getFullYear() + years;
}

/** 问题里是否出现学生场景的领域词（考研/实习/竞赛…） */
export function hasDomainTerm(question: string): boolean {
  return LEXICON.some((word) => question.includes(word));
}

export async function searchKb(input: KbSearchInput): Promise<KbEntry[]> {
  const limit = Math.min(input.limit ?? 5, 10);
  const question = input.question.trim();

  // 与学业/求职无关的问题不注入经验，避免把「考研经验」塞进「什么是二分查找」
  if (!question || !hasDomainTerm(question)) return [];

  const keywords = extractKeywords(question);
  const params: unknown[] = [];

  const school = input.school?.trim() ?? "";
  const major = input.major?.trim() ?? "";
  const gradYear = input.gradYear;

  // 注意：学校和专业只用来「加权」，不做硬过滤。
  // 每条经验带的是作者自己的学校，要求等于用户学校会把绝大多数条目直接排除。
  const bonusParts: string[] = [];
  if (major) {
    params.push(major);
    bonusParts.push(`(case when major = $${params.length} then 4 else 0 end)`);
  }
  if (school) {
    params.push(school);
    bonusParts.push(`(case when school = $${params.length} then 3 else 0 end)`);
  }
  if (typeof gradYear === "number" && Number.isFinite(gradYear)) {
    params.push(gradYear);
    bonusParts.push(
      `(case when grad_year is not null and abs(grad_year - $${params.length}) <= 1 then 1 else 0 end)`,
    );
  }

  // 关键词命中数
  const keywordParts: string[] = [];
  for (const word of keywords) {
    params.push(`%${word}%`);
    const idx = params.length;
    keywordParts.push(
      `(case when situation ilike $${idx} or approach ilike $${idx} or pitfalls ilike $${idx} then 1 else 0 end)`,
    );
  }

  const bonusExpr = bonusParts.length ? bonusParts.join(" + ") : "0";
  const keywordExpr = keywordParts.length ? keywordParts.join(" + ") : "0";
  const scoreExpr = `(${bonusExpr} + ${keywordExpr})`;

  params.push(limit);
  const sql = `
    select id, school, major, grad_year, tags, situation, approach, outcome, pitfalls,
           ${scoreExpr} as score
      from kb_entries
     where visibility = 'public'
       and (${bonusExpr}) + (${keywordExpr}) > 0
     order by score desc, updated_at desc
     limit $${params.length}
  `;

  const { rows } = await query<KbEntry & { score: number }>(sql, params);
  return rows;
}

/**
 * 把检索结果压成给模型的「要点」，而不是原文。
 *
 * 三条硬规则在这里落地：
 * 1. 不带任何来源标识（没有 owner、没有名字）
 * 2. 每条压到两行以内，逼模型改写而不是照抄
 * 3. 明确告诉模型「这是同专业学长的做法，不是用户本人」
 */
export function buildKbContext(entries: KbEntry[]): string {
  if (!entries.length) return "";

  const lines = entries.slice(0, 5).map((entry, index) => {
    const parts = [
      `情境：${entry.situation.slice(0, 80)}`,
      `做法：${entry.approach.slice(0, 120)}`,
      entry.outcome ? `结果：${entry.outcome.slice(0, 50)}` : "",
      entry.pitfalls ? `坑：${entry.pitfalls.slice(0, 60)}` : "",
    ].filter(Boolean);
    return `${index + 1}. ${parts.join("；")}`;
  });

  return [
    "【同专业学长的经验要点】以下是从经验库里检索到的做法摘要，属于他人经历：",
    ...lines,
    "",
    "使用规则（必须遵守）：",
    "- 用你自己的话重述，不要照抄原句（连续相同不得超过 8 个字）",
    "- 不要提及具体的人、姓名、学校全称或个人隐私",
    "- 结合用户自己的情况（学校/专业/年级）来挑，不要全部罗列",
    "- 如果这些经验与问题关系不大，就忽略它们，按常识给建议",
  ].join("\n");
}
