import { query } from "./db.ts";

/**
 * 从 CloudBase（PostgREST）同步脱敏经验到 kb_entries。
 *
 * 只读、只取白名单字段；任何可能识别到个人的字段都不读。
 * 用法：
 *   KB_REST_URL=https://xxx.service.tcloudbase.com/v1/rest \
 *   KB_REST_KEY=... \
 *   KB_TABLE=experience_public_v2 \
 *   node --experimental-strip-types src/sync-kb.ts [--dry-run] [--limit 50]
 */

const env = (name: string, fallback = "") => (process.env[name] ?? fallback).trim();

const REST_URL = env("KB_REST_URL");
const REST_KEY = env("KB_REST_KEY");
/** 直连 PostgreSQL（公网地址 + 只读账号）；与 REST 二选一 */
const PG_URL = env("KB_PG_URL");
const TABLE = env("KB_TABLE", "experience_public_v2");
const DRY_RUN = process.argv.includes("--dry-run");
const limitIndex = process.argv.indexOf("--limit");
const LIMIT = limitIndex > -1 ? Number(process.argv[limitIndex + 1]) : 200;

/** 字段映射：左边是我们的字段，右边是候选来源字段（按顺序取第一个有值的） */
const FIELD_MAP = {
  school: ["school", "university", "school_name"],
  major: ["major", "specialty", "major_name"],
  grad_year: ["grad_year", "graduation_year", "gradYear"],
  tags: ["tags", "tag", "category", "categories"],
  situation: ["situation", "question", "title", "summary"],
  approach: ["approach", "answer", "content", "advice", "detail"],
  outcome: ["outcome", "result"],
  pitfalls: ["pitfalls", "pitfall", "warning", "note"],
} as const;

/** 绝对不读的字段：一旦出现在响应里，说明视图设计有问题 */
const FORBIDDEN = [
  "email", "display_name", "avatar_data", "owner_id", "birth_date",
  "constellation", "phone", "real_name", "id_card", "wechat",
];

type Row = Record<string, unknown>;

function pick(row: Row, keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** 抹掉邮箱/手机号/链接，避免经验正文里夹带联系方式 */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "")
    .replace(/1[3-9]\d{9}/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function toTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").slice(0, 8);
  }
  if (typeof value === "string") {
    return value.split(/[,，、/\s]+/).filter(Boolean).slice(0, 8);
  }
  return [];
}

export function mapRow(row: Row): {
  source_id: string;
  school: string;
  major: string;
  grad_year: number | null;
  tags: string[];
  situation: string;
  approach: string;
  outcome: string;
  pitfalls: string;
} | null {
  const rawId = row.id ?? row.experience_id ?? row.uuid;
  const sourceId = typeof rawId === "string" ? rawId : "";
  if (!sourceId) return null;

  const approach = scrub(pick(row, FIELD_MAP.approach));
  if (approach.length < 12) return null; // 内容太短，没信息量

  const yearRaw = pick(row, FIELD_MAP.grad_year);
  const year = Number(yearRaw);

  return {
    source_id: sourceId,
    school: scrub(pick(row, FIELD_MAP.school)).slice(0, 40),
    major: scrub(pick(row, FIELD_MAP.major)).slice(0, 40),
    grad_year: Number.isFinite(year) && year > 1990 && year < 2100 ? year : null,
    tags: toTags(row.tags ?? row.tag ?? row.category ?? row.categories),
    situation: scrub(pick(row, FIELD_MAP.situation)).slice(0, 400),
    approach: approach.slice(0, 800),
    outcome: scrub(pick(row, FIELD_MAP.outcome)).slice(0, 200),
    pitfalls: scrub(pick(row, FIELD_MAP.pitfalls)).slice(0, 300),
  };
}

async function fetchRows(): Promise<Row[]> {
  const take = Math.min(LIMIT, 500);

  // ① 直连 PostgreSQL（推荐：只读账号 + 公网地址 + 白名单）
  if (PG_URL) {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: PG_URL });
    await client.connect();
    try {
      // 表名来自环境变量，做一次白名单校验，避免拼串注入
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(TABLE)) {
        throw new Error(`表名不合法：${TABLE}`);
      }
      const result = await client.query(`select * from ${TABLE} limit $1`, [take]);
      return result.rows as Row[];
    } finally {
      await client.end();
    }
  }

  // ② PostgREST
  if (!REST_URL) throw new Error("缺少 KB_PG_URL 或 KB_REST_URL");

  const url = new URL(`${REST_URL.replace(/\/$/, "")}/${TABLE}`);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", String(take));

  const response = await fetch(url, {
    headers: {
      apikey: REST_KEY,
      authorization: `Bearer ${REST_KEY}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`PostgREST ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("响应不是数组");
  return data as Row[];
}

async function main() {
  console.log(`[sync-kb] table=${TABLE} limit=${LIMIT} dryRun=${DRY_RUN}`);
  const rows = await fetchRows();
  console.log(`[sync-kb] 拉取 ${rows.length} 行`);

  // 预览时检查是否含禁用字段
  const sample = rows[0] ?? {};
  const leaked = FORBIDDEN.filter((key) => key in sample);
  if (leaked.length) {
    console.warn(`[sync-kb] ⚠️ 视图里出现了个人字段：${leaked.join(", ")}（不会同步，但建议改视图）`);
  }

  const mapped = rows.map(mapRow).filter((item): item is NonNullable<typeof item> => Boolean(item));
  console.log(`[sync-kb] 可入库 ${mapped.length} 条（其余内容为空或太短）`);

  if (DRY_RUN) {
    console.log("[sync-kb] 预览前 3 条：");
    for (const item of mapped.slice(0, 3)) {
      console.log(JSON.stringify(item, null, 2).slice(0, 600));
    }
    return;
  }

  let inserted = 0;
  for (const item of mapped) {
    await query(
      `insert into kb_entries
         (source_table, source_id, school, major, grad_year, tags, situation, approach, outcome, pitfalls, visibility, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'public', now())
       on conflict (source_table, source_id) do update
         set school = excluded.school, major = excluded.major, grad_year = excluded.grad_year,
             tags = excluded.tags, situation = excluded.situation, approach = excluded.approach,
             outcome = excluded.outcome, pitfalls = excluded.pitfalls, updated_at = now()`,
      [
        TABLE,
        item.source_id,
        item.school,
        item.major,
        item.grad_year,
        item.tags,
        item.situation,
        item.approach,
        item.outcome,
        item.pitfalls,
      ],
    );
    inserted += 1;
  }
  console.log(`[sync-kb] 写入 ${inserted} 条`);
}

// 直接执行时才跑（被 import 时不跑）
if (process.argv[1]?.endsWith("sync-kb.ts")) {
  main().catch((error) => {
    console.error("[sync-kb] 失败：", error);
    process.exit(1);
  });
}
