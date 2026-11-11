-- WayMuse 服务端初始化
-- 只跑一次；后续变更用迁移文件累加。

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  plan text not null default 'free',
  created_at timestamptz not null default now(),
  -- 游客态：没有邮箱，只有设备
  is_guest boolean not null default true
);

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  device_id text not null,
  name text not null default '',
  refresh_hash text not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, device_id)
);

create index if not exists devices_user_idx on devices(user_id);

create table if not exists login_codes (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  sent_at timestamptz not null default now()
);

create table if not exists usage_daily (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  cost_cents numeric(12, 4) not null default 0,
  primary key (user_id, day)
);

create table if not exists quota_month (
  user_id uuid not null references users(id) on delete cascade,
  month text not null, -- YYYY-MM
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  primary key (user_id, month)
);

-- 用户资料：知识库匹配要用到学校/专业/年级/目标
create table if not exists profiles (
  user_id uuid primary key references users(id) on delete cascade,
  school text not null default '',
  major text not null default '',
  grade text not null default '',
  direction text not null default '',
  updated_at timestamptz not null default now()
);

-- 云同步：先按「整包 JSONB + 版本号」存，简单可靠
create table if not exists sync_state (
  user_id uuid primary key references users(id) on delete cascade,
  revision bigint not null default 0,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 全局熔断用的当日总成本
create table if not exists global_usage_daily (
  day date primary key,
  cost_cents numeric(12, 4) not null default 0
);
