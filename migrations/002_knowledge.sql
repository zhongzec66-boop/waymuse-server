-- 学长学姐经验镜像（脱敏后）
-- 只放"可被检索的一般化经验"，不放任何个人标识。

create extension if not exists pg_trgm;

create table if not exists kb_entries (
  id uuid primary key default gen_random_uuid(),
  -- 来源：方便按条删除（某人撤回同意时）
  source_table text not null,
  source_id text not null,

  -- 匹配维度
  school text not null default '',
  major text not null default '',
  grad_year int,
  tags text[] not null default '{}',

  -- 内容（已改写/脱敏）
  situation text not null default '',
  approach text not null default '',
  outcome text not null default '',
  pitfalls text not null default '',

  -- 可见性：public = 可引用；aggregate = 只参与聚合
  visibility text not null default 'public',

  updated_at timestamptz not null default now(),
  unique (source_table, source_id)
);

create index if not exists kb_school_idx on kb_entries (school);
create index if not exists kb_major_idx on kb_entries (major);
create index if not exists kb_year_idx on kb_entries (grad_year);
create index if not exists kb_tags_idx on kb_entries using gin (tags);
create index if not exists kb_text_idx on kb_entries
  using gin ((situation || ' ' || approach || ' ' || pitfalls) gin_trgm_ops);

-- 检索日志（用来评估命中率，也方便日后清理）
create table if not exists kb_query_log (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  query text not null,
  matched int not null default 0,
  created_at timestamptz not null default now()
);
