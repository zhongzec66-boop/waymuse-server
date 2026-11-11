import { readFileSync } from "node:fs";
import { query, pool } from "./db.ts";

/**
 * 把导出的经验 JSON 导入 kb_entries。
 *
 * 用法（容器内）：
 *   node --experimental-strip-types src/import-kb.ts /tmp/kb-records.json
 */

type Record = {
  source_table: string;
  source_id: string;
  school?: string;
  major?: string;
  grad_year?: number | null;
  tags?: string[];
  situation?: string;
  approach?: string;
  outcome?: string;
  pitfalls?: string;
};

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("用法：import-kb.ts <json文件>");

  const records = JSON.parse(readFileSync(path, "utf8")) as Record[];
  if (!Array.isArray(records)) throw new Error("JSON 不是数组");

  let ok = 0;
  let skipped = 0;

  for (const record of records) {
    if (!record.source_id || !record.approach?.trim()) {
      skipped += 1;
      continue;
    }
    await query(
      `insert into kb_entries
         (source_table, source_id, school, major, grad_year, tags,
          situation, approach, outcome, pitfalls, visibility, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'public', now())
       on conflict (source_table, source_id) do update
         set school = excluded.school, major = excluded.major,
             grad_year = excluded.grad_year, tags = excluded.tags,
             situation = excluded.situation, approach = excluded.approach,
             outcome = excluded.outcome, pitfalls = excluded.pitfalls,
             updated_at = now()`,
      [
        record.source_table || "import",
        String(record.source_id),
        record.school ?? "",
        record.major ?? "",
        record.grad_year ?? null,
        record.tags ?? [],
        record.situation ?? "",
        record.approach,
        record.outcome ?? "",
        record.pitfalls ?? "",
      ],
    );
    ok += 1;
  }

  const total = await query<{ n: string }>("select count(*)::text as n from kb_entries");
  console.log(`[import-kb] 写入 ${ok} 条，跳过 ${skipped} 条，库内合计 ${total.rows[0]?.n}`);
  await pool.end();
}

main().catch(async (error) => {
  console.error("[import-kb] 失败：", error);
  process.exit(1);
});
