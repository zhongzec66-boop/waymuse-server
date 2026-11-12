-- 语音（TTS）：字符维度用量 + 缓存元数据

create table if not exists voice_usage_daily (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  chars int not null default 0,
  requests int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- 缓存只记索引，音频本体在磁盘（容器 volume）
create table if not exists voice_cache (
  hash text primary key,
  voice_id text not null,
  chars int not null,
  bytes bigint not null default 0,
  hits int not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz not null default now()
);

create index if not exists voice_cache_last_hit_idx on voice_cache (last_hit_at);
