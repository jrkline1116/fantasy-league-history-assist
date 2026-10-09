-- Fantasy League History Assist: run once in Supabase → SQL Editor → New query → Run.
-- Adds a small cache table for Sleeper's player list (used to put names on draft picks,
-- rosters, trades and pickups). Optional but recommended: without it the function still
-- works, it just downloads Sleeper's 5 MB player list far more often than it needs to.

create table if not exists public.flha_cache (
  key         text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
-- Locked down like flha_leagues: only the league-history function (service role) touches it.
alter table public.flha_cache enable row level security;
