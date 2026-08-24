-- CASTTCO shop schema
--
-- Money is stored as integer minor units (pence), never as float or numeric
-- with decimals. 0.1 + 0.2 != 0.3 in floating point, and a rounding error in
-- a total is a real charge to a real customer.
--
-- Two purchase paths, deliberately separate:
--   products    -> basket -> Stripe checkout -> shipped
--   consultation -> booking form -> Stripe checkout -> no shipping, GBP 50

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,
  description   text,
  image_path    text,
  -- Null price means "not yet priced". The storefront hides Add to Basket
  -- while this is null, so an unpriced item can never be bought for nothing.
  price_pence   integer check (price_pence is null or price_pence >= 0),
  currency      char(3) not null default 'GBP',
  -- Null stock means untracked rather than zero. Zero means genuinely sold out.
  stock         integer check (stock is null or stock >= 0),
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column public.products.price_pence is
  'Price in pence. Null until a price is set; storefront will not sell it.';

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text unique not null,
  -- Null user_id is a guest order. Guest checkout is supported by design.
  user_id              uuid references auth.users(id) on delete set null,
  email                text not null,
  kind                 text not null default 'product'
                         check (kind in ('product', 'consultation')),
  status               text not null default 'pending'
                         check (status in ('pending','paid','fulfilled',
                                           'cancelled','refunded')),
  subtotal_pence       integer not null check (subtotal_pence >= 0),
  shipping_pence       integer not null default 0 check (shipping_pence >= 0),
  total_pence          integer not null check (total_pence >= 0),
  currency             char(3) not null default 'GBP',
  stripe_session_id    text unique,
  stripe_payment_intent text,
  shipping_name        text,
  shipping_line1       text,
  shipping_line2       text,
  shipping_city        text,
  shipping_postcode    text,
  shipping_country     text default 'GB',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists orders_user_id_idx on public.orders(user_id);
create index if not exists orders_email_idx   on public.orders(email);

-- ---------------------------------------------------------------------------
-- Order items
-- ---------------------------------------------------------------------------

create table if not exists public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete cascade,
  product_id       uuid references public.products(id) on delete set null,
  -- Name and price are snapshotted at purchase time. Editing a product later
  -- must never rewrite what a customer was actually charged.
  name_snapshot    text not null,
  unit_price_pence integer not null check (unit_price_pence >= 0),
  quantity         integer not null check (quantity > 0),
  line_total_pence integer not null check (line_total_pence >= 0)
);

create index if not exists order_items_order_id_idx on public.order_items(order_id);

-- ---------------------------------------------------------------------------
-- Consultation bookings (separate from the product basket, GBP 50)
-- ---------------------------------------------------------------------------

create table if not exists public.consultation_bookings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  name              text not null,
  email             text not null,
  phone             text,
  service           text,
  preferred_date    date,
  notes             text,
  price_pence       integer not null default 5000,
  currency          char(3) not null default 'GBP',
  status            text not null default 'pending'
                      check (status in ('pending','paid','confirmed',
                                        'completed','cancelled','refunded')),
  stripe_session_id text unique,
  order_id          uuid references public.orders(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists bookings_email_idx on public.consultation_bookings(email);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The storefront key may READ active products and nothing else. Every write to
-- orders, order_items and bookings happens server-side in a Vercel function
-- using the service role key.
--
-- This is the point of the whole design: if the browser could insert an order,
-- it could insert its own prices, and a customer could buy the device for 1p.
-- Prices are always re-read from this table server-side at checkout.
-- ---------------------------------------------------------------------------

alter table public.products              enable row level security;
alter table public.orders                enable row level security;
alter table public.order_items           enable row level security;
alter table public.consultation_bookings enable row level security;

drop policy if exists products_public_read on public.products;
create policy products_public_read
  on public.products for select
  using (is_active = true);

drop policy if exists orders_owner_read on public.orders;
create policy orders_owner_read
  on public.orders for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists order_items_owner_read on public.order_items;
create policy order_items_owner_read
  on public.order_items for select
  to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
      and o.user_id = (select auth.uid())
  ));

drop policy if exists bookings_owner_read on public.consultation_bookings;
create policy bookings_owner_read
  on public.consultation_bookings for select
  to authenticated
  using (user_id = (select auth.uid()));

-- No insert, update or delete policies are defined on purpose. Without a
-- permissive policy those operations are denied to anon and authenticated
-- roles, while the service role used by the serverless functions bypasses RLS.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

drop trigger if exists bookings_touch on public.consultation_bookings;
create trigger bookings_touch before update on public.consultation_bookings
  for each row execute function public.touch_updated_at();
