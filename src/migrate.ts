import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./db.ts";

/**
 * 极简迁移：按文件名顺序执行 migrations/*.sql，已执行过的记录在 schema_migrations。
 */
async function main() {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rows } = await pool.query("select 1 from schema_migrations where name = $1", [file]);
    if (rows.length) {
      console.log(`[migrate] skip ${file}`);
      continue;
    }
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await pool.query(sql);
    await pool.query("insert into schema_migrations(name) values ($1)", [file]);
    console.log(`[migrate] applied ${file}`);
  }

  await pool.end();
}

main().catch((error) => {
  console.error("[migrate] failed", error);
  process.exit(1);
});
