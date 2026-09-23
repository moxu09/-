create table if not exists public.jkopay_service_payments (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null,
  payment_kind text not null check (payment_kind in ('order', 'extension', 'tip')),
  entity_key text not null,
  platform_order_id text not null unique,
  user_id text not null,
  amount integer not null check (amount > 0),
  currency text not null default 'TWD' check (currency = 'TWD'),
  channel_id text,
  payment_message_id text,
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  payment_url text,
  qr_img text,
  qr_timeout bigint,
  status text not null default 'pending' check (status in ('pending', 'processing', 'paid', 'failed')),
  trade_no text,
  trans_time text,
  raw_result jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_code, payment_kind, entity_key)
);
create index if not exists jkopay_service_payments_lookup_idx on public.jkopay_service_payments (organization_code, payment_kind, entity_key);
alter table public.jkopay_service_payments enable row level security;
revoke all on table public.jkopay_service_payments from anon, authenticated;
grant all on table public.jkopay_service_payments to service_role;
