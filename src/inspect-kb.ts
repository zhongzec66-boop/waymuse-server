import { Client } from "pg";

/**
 * 只读探查：看看对方库里到底有什么，不改任何东西。
 *
 * 用法：
 *   KB_PG_URL='postgres://ro:pass@host:5432/db' \
 *   node --experimental-strip-types src/inspect-kb.ts
 */

const PG_URL = (process.env.KB_PG_URL ?? "").trim();

const PII = [
  "email", "phone", "mobile", "display_name", "real_name", "avatar",
  "owner_id", "birth_date", "constellation", "id_card", "wechat",
  "password", "token", "secret", "openid", "unionid",
];

const CANDIDATES = [
  "experiences",
  "experience_public_v2",
  "experience_submissions",
  "user_profiles",
  "mentor_verification_applications",
];

function mask(value: unknown): unknown {
  if (typeof value === "string" && value.length > 24) {
    return `${value.slice(0, 8)}…(${value.length}字)`;
  }
  return value;
}

async function main() {
  if (!PG_URL) throw new Error("缺少 KB_PG_URL");

  const client = new Client({
    connectionString: PG_URL,
    // 探查不该长跑
    statement_timeout: 8000,
  });
  await client.connect();

  try {
    console.log("=== 连接成功 ===");
    const version = await client.query("select current_database() as db, version() as v");
    console.log("db:", version.rows[0]?.db);

    console.log("\n=== public schema 里的表（前 40）===");
    const tables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name limit 40`,
    );
    console.log(tables.rows.map((row) => row.table_name).join(", "));

    const views = await client.query<{ table_name: string }>(
      `select table_name from information_schema.views
        where table_schema = 'public' order by table_name limit 20`,
    );
    console.log("\n视图：", views.rows.map((row) => row.table_name).join(", "));

    for (const table of CANDIDATES) {
      const exists = await client
        .query("select to_regclass($1) as oid", [`public.${table}`])
        .then((result) => Boolean(result.rows[0]?.oid));
      if (!exists) {
        console.log(`\n--- ${table}: 不存在 ---`);
        continue;
      }

      console.log(`\n--- ${table} ---`);
      const columns = await client.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
          where table_schema='public' and table_name=$1 order by ordinal_position`,
        [table],
      );
      console.log(
        columns.rows.map((row) => `${row.column_name}:${row.data_type}`).join(", "),
      );

      const count = await client.query<{ n: string }>(`select count(*)::text as n from ${table}`);
      console.log(`行数：${count.rows[0]?.n}`);

      const sample = await client.query(`select * from ${table} limit 2`);
      for (const row of sample.rows) {
        const cleaned: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
          const lower = key.toLowerCase();
          cleaned[key] = PII.some((token) => lower.includes(token)) ? "<已隐藏>" : mask(value);
        }
        console.log(JSON.stringify(cleaned).slice(0, 800));
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[inspect-kb] 失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
