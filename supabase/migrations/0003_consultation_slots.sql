-- Real appointment slots for consultations.
--
-- Until now a booking carried an optional preferred_date and no time at all,
-- and the confirmation page said "we will be in touch to agree a time". This
-- turns it into an actual appointment: the customer picks a slot, that slot is
-- held while they pay, and nobody else can take it.
--
-- Slot times are stored in UTC (timestamptz). Availability below is expressed
-- in LOCAL time, because "I work nine to five" means nine to five in London in
-- both June and December. The server converts using the Europe/London offset in
-- force on each date, so BST and GMT are handled rather than drifting an hour
-- twice a year.

-- ---------------------------------------------------------------------------
-- The booked slot
-- ---------------------------------------------------------------------------

alter table public.consultation_bookings
  add column if not exists starts_at timestamptz;

comment on column public.consultation_bookings.starts_at is
  'Start of the booked appointment, UTC. Null on rows created before slot '
  'booking existed. Duration is fixed by the server, not stored per row.';

-- ---------------------------------------------------------------------------
-- Double booking, prevented by the database
--
-- The application also checks whether a slot is free, but a check followed by
-- an insert is not atomic: two people clicking the same slot in the same second
-- both see it free and both write. Only a constraint can decide that race, so
-- the second insert fails and that customer is told to pick again -- before any
-- money is taken.
--
-- Cancelled and refunded bookings are excluded, so a released slot becomes
-- bookable again.
-- ---------------------------------------------------------------------------

create unique index if not exists consultation_bookings_slot_unique
  on public.consultation_bookings (starts_at)
  where starts_at is not null
    and status in ('pending', 'paid', 'confirmed', 'completed');

create index if not exists consultation_bookings_starts_at_idx
  on public.consultation_bookings (starts_at)
  where starts_at is not null;

-- ---------------------------------------------------------------------------
-- Weekly availability
--
-- Edit these rows in the Supabase table editor to change working hours. No
-- deploy is needed; the booking page reads them on every request.
--
-- weekday follows Postgres dow: 0 = Sunday ... 6 = Saturday.
-- ---------------------------------------------------------------------------

create table if not exists public.consultation_availability (
  id         uuid primary key default gen_random_uuid(),
  weekday    smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time   time not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

comment on table public.consultation_availability is
  'Weekly working hours in Europe/London local time. Slots are generated '
  'between start_time and end_time; the last slot starts one duration before '
  'end_time, so 09:00-17:00 with 60 minute sessions ends at 16:00.';

-- Monday to Friday, 09:00-17:00 local.
insert into public.consultation_availability (weekday, start_time, end_time)
select d, time '09:00', time '17:00'
from generate_series(1, 5) as d
where not exists (select 1 from public.consultation_availability);

-- ---------------------------------------------------------------------------
-- Days off
--
-- Holidays and one-off closures. A date listed here offers no slots at all,
-- whatever the weekly hours say.
-- ---------------------------------------------------------------------------

create table if not exists public.consultation_blackouts (
  id            uuid primary key default gen_random_uuid(),
  blackout_date date not null unique,
  reason        text,
  created_at    timestamptz not null default now()
);

comment on table public.consultation_blackouts is
  'Dates with no availability: holidays, leave, anything one-off. Add rows '
  'here rather than editing the weekly hours.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Working hours and closures are not secret -- the booking page has to show
-- them -- so anyone may read them. Nobody may write them from the browser:
-- editing happens in the Supabase dashboard, and the serverless functions use
-- the service role, which bypasses these policies entirely.
--
-- Bookings keep their existing policies. The public must NOT be able to read
-- them, or anyone could list who is seeing Jeffery and when. Free/busy is
-- computed server-side and only ever leaves as a list of free times.
-- ---------------------------------------------------------------------------

alter table public.consultation_availability enable row level security;
alter table public.consultation_blackouts    enable row level security;

drop policy if exists availability_public_read on public.consultation_availability;
create policy availability_public_read
  on public.consultation_availability for select
  using (is_active = true);

drop policy if exists blackouts_public_read on public.consultation_blackouts;
create policy blackouts_public_read
  on public.consultation_blackouts for select
  using (true);
