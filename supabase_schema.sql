-- Fanyakazi / Supabase schema
-- Run in the Supabase SQL editor.
-- Paystack secret keys must remain in the PHP server environment.

create extension if not exists pgcrypto;
create extension if not exists citext;

do $$ begin
  create type public.app_role as enum ('user', 'admin');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.transaction_status as enum ('pending', 'success', 'failed', 'abandoned');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.ledger_type as enum ('earning', 'commission', 'withdrawal', 'adjustment');
exception when duplicate_object then null;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username citext unique,
  phone text unique,
  country text not null default 'Kenya',
  role public.app_role not null default 'user',
  referral_code text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10)),
  referred_by uuid references public.profiles(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_phone_length check (phone is null or length(phone) between 9 and 15),
  constraint profiles_username_length check (username is null or length(username) between 3 and 40)
);

create table if not exists public.programs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  currency text not null default 'KES',
  unlock_amount numeric(12,2) not null check (unlock_amount >= 0),
  task_reward numeric(12,2) not null default 0 check (task_reward >= 0),
  commission_rate numeric(5,2) not null default 0 check (commission_rate between 0 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  program_id uuid references public.programs(id) on delete restrict,
  type text not null default 'program_unlock' check (type in ('registration', 'program_unlock')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'KES',
  status public.transaction_status not null default 'pending',
  paystack_reference text not null unique,
  paystack_access_code text,
  paystack_transaction_id text,
  customer_email text,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transaction_program_required check (type = 'registration' or program_id is not null)
);

create table if not exists public.user_programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  program_id uuid not null references public.programs(id) on delete restrict,
  transaction_id uuid not null unique references public.transactions(id) on delete restrict,
  unlocked_at timestamptz not null default now(),
  is_active boolean not null default true,
  unique (user_id, program_id)
);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.profiles(id) on delete restrict,
  referred_id uuid not null unique references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint referrals_not_self check (referrer_id <> referred_id)
);

create table if not exists public.wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  lifetime_earned numeric(12,2) not null default 0 check (lifetime_earned >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  type public.ledger_type not null,
  amount numeric(12,2) not null check (amount > 0),
  description text not null default '',
  program_id uuid references public.programs(id) on delete set null,
  source_user_id uuid references public.profiles(id) on delete set null,
  transaction_id uuid references public.transactions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_id_idx on public.transactions(user_id);
create index if not exists transactions_status_idx on public.transactions(status);
create index if not exists transactions_created_at_idx on public.transactions(created_at desc);
create index if not exists wallet_ledger_user_id_idx on public.wallet_ledger(user_id);
create index if not exists referrals_referrer_id_idx on public.referrals(referrer_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  referrer uuid;
begin
  select id into referrer
  from public.profiles
  where referral_code = upper(nullif(new.raw_user_meta_data->>'referral_code', ''));

  insert into public.profiles (id, username, phone, country, referred_by)
  values (
    new.id,
    nullif(new.raw_user_meta_data->>'username', ''),
    nullif(new.raw_user_meta_data->>'phone', ''),
    coalesce(nullif(new.raw_user_meta_data->>'country', ''), 'Kenya'),
    referrer
  )
  on conflict (id) do nothing;

  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  if referrer is not null then
    insert into public.referrals (referrer_id, referred_id)
    values (referrer, new.id)
    on conflict (referred_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists programs_updated_at on public.programs;
create trigger programs_updated_at before update on public.programs
for each row execute function public.set_updated_at();

drop trigger if exists transactions_updated_at on public.transactions;
create trigger transactions_updated_at before update on public.transactions
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.programs enable row level security;
alter table public.transactions enable row level security;
alter table public.user_programs enable row level security;
alter table public.referrals enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin on public.profiles
for select using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_admin on public.profiles
for update using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

drop policy if exists programs_select_active on public.programs;
create policy programs_select_active on public.programs
for select using (is_active = true or public.is_admin());

drop policy if exists programs_admin_write on public.programs;
create policy programs_admin_write on public.programs
for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists transactions_select_own_or_admin on public.transactions;
create policy transactions_select_own_or_admin on public.transactions
for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists transactions_admin_write on public.transactions;
create policy transactions_admin_write on public.transactions
for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists user_programs_select_own_or_admin on public.user_programs;
create policy user_programs_select_own_or_admin on public.user_programs
for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists user_programs_admin_write on public.user_programs;
create policy user_programs_admin_write on public.user_programs
for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists referrals_select_involved_or_admin on public.referrals;
create policy referrals_select_involved_or_admin on public.referrals
for select using (referrer_id = auth.uid() or referred_id = auth.uid() or public.is_admin());

drop policy if exists wallets_select_own_or_admin on public.wallets;
create policy wallets_select_own_or_admin on public.wallets
for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists wallet_ledger_select_own_or_admin on public.wallet_ledger;
create policy wallet_ledger_select_own_or_admin on public.wallet_ledger
for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists wallet_ledger_admin_write on public.wallet_ledger;
create policy wallet_ledger_admin_write on public.wallet_ledger
for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists audit_logs_admin_only on public.audit_logs;
create policy audit_logs_admin_only on public.audit_logs
for all using (public.is_admin()) with check (public.is_admin());

insert into public.programs (slug, name, description, unlock_amount, task_reward, commission_rate)
values
  ('hotel-reviews', 'Hotel Reviews', 'Review real hotels and earn for completed reviews.', 80, 300, 80),
  ('y99', 'Y99 Sessions', 'Complete short guided sessions and earn daily.', 100, 300, 80),
  ('ai-training', 'AI Training', 'Complete guided AI training sessions.', 100, 500, 80)
on conflict (slug) do nothing;

-- Promote an existing user to admin manually after their account is created:
-- update public.profiles set role = 'admin' where id = 'USER-UUID-HERE';

-- The server.mjs backend should use the Supabase service-role key for:
-- 1. Paystack transaction initialization and verification.
-- 2. Webhook processing.
-- 3. Inserting successful transactions and unlocks.
-- 4. Updating wallets and writing audit logs.

-- Admin-granted access migration. Run this block after the original schema.
alter table public.transactions drop constraint if exists transactions_type_check;
alter table public.transactions add constraint transactions_type_check
  check (type in ('registration', 'program_unlock', 'admin_grant'));

alter table public.transactions drop constraint if exists transaction_program_required;
alter table public.transactions add constraint transaction_program_required
  check (type in ('program_unlock', 'admin_grant') or program_id is not null);

-- Work content and submissions migration.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs(id) on delete cascade,
  category text not null check (category in ('hotel_review', 'ai_training')),
  title text not null,
  description text not null default '',
  image_url text,
  external_url text,
  reward numeric(12,2) not null default 500 check (reward > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_submissions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  review_text text,
  proof_url text,
  status text not null default 'approved' check (status in ('pending', 'approved', 'rejected')),
  reward numeric(12,2) not null default 0 check (reward >= 0),
  created_at timestamptz not null default now(),
  unique (job_id, user_id)
);

create index if not exists jobs_program_id_idx on public.jobs(program_id);
create index if not exists job_submissions_user_id_idx on public.job_submissions(user_id);
alter table public.jobs enable row level security;
alter table public.job_submissions enable row level security;

drop policy if exists jobs_admin_only on public.jobs;
create policy jobs_admin_only on public.jobs for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists job_submissions_admin_only on public.job_submissions;
create policy job_submissions_admin_only on public.job_submissions for all using (public.is_admin()) with check (public.is_admin());

drop trigger if exists jobs_updated_at on public.jobs;
create trigger jobs_updated_at before update on public.jobs for each row execute function public.set_updated_at();
