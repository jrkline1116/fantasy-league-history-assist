-- Fantasy League History Assist: run once in Supabase → SQL Editor → New query → Run.
-- Same Supabase project as Fantasy Injury Assist; this only adds one new table.

create table if not exists public.flha_leagues (
  slug        text primary key,                       -- the unguessable share code (#k7Qm2xPa9d)
  platform    text not null check (platform in ('sleeper', 'espn')),
  ext_id      text not null,                          -- current Sleeper league ID / ESPN leagueId
  ext_ids     text[] not null default '{}',           -- every Sleeper season's league ID
  is_private  boolean not null default false,         -- private ESPN league
  name        text,
  data        jsonb not null,                         -- { leagueName, seasons: [...] }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  views       integer not null default 0,
  edits       jsonb not null default '{}'::jsonb,       -- shared renames/merges { names, aliases }
  edit_log    jsonb not null default '[]'::jsonb        -- last 50 changes, newest first (for undo)
);
create unique index if not exists flha_leagues_ext on public.flha_leagues (platform, ext_id);
create index if not exists flha_leagues_ext_ids on public.flha_leagues using gin (ext_ids);

-- Locked down: no policies, so the public site can't read or write the table directly.
-- Only the league-history function (service role) touches it.
alter table public.flha_leagues enable row level security;

-- Handy: most-viewed leagues
-- select name, platform, is_private, views, created_at, updated_at from public.flha_leagues order by views desc limit 50;
