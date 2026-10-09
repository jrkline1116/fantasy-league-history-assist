-- Fantasy League History Assist: shared manager names.
-- Run once in Supabase → SQL Editor → New query → Run (safe to run more than once).
alter table public.flha_leagues add column if not exists edits    jsonb not null default '{}'::jsonb;
alter table public.flha_leagues add column if not exists edit_log jsonb not null default '[]'::jsonb;
