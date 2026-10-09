# Fantasy League History Assist

All-time history for a fantasy football league: average finish, points for and against, titles, playoff trips, head-to-head records (who you beat most, who you lose to most), all-play luck, a record book, every draft, final rosters, trades, and waiver/free-agent pickups. Sleeper and ESPN (public and private).

Website: https://fantasyleaguehistoryassist.com/ (once the domain is pointed here)

## How it works

1. One person loads the league (Sleeper username or league ID, or an ESPN league address).
2. The server fetches every season once and saves it under an unguessable share code, like `fantasyleaguehistoryassist.com/#k7Qm2xPa9d`.
3. They send that link to the league chat. Anyone who opens it lands on the league page, on any device, with no login.

**Keeping the current season fresh**
- Sleeper and public ESPN leagues update themselves: when someone opens the link and the saved copy is more than 3 hours old during a season (a week in the offseason), the server fetches only the current season first. Sleeper's new league ID each year is followed automatically.
- Private ESPN leagues need a league member's ESPN login to update. Any member can do it, not just whoever set it up: **Update this season** on the league page, then the bookmark or pasted cookies. The update shows for everyone. Phone visitors just see "updated X ago."
- Finished seasons are never fetched again.

**Private ESPN leagues and safety**
- ESPN cookies go to the server for one request, are passed to ESPN, and are never saved or logged. (A visitor can tick "remember" to keep them in their own browser only.)
- A private league's share code is only handed out after ESPN accepts the visitor's login for that league. Typing a private league's ID without a working login gets nothing.
- Anyone with the share link can view that league's history (manager names, team names, scores). That's the point of sharing it.

**Drafts, rosters, trades and pickups**
- **Drafts** tab: the draft board for every season (or each manager's picks, or the price list for auctions), every manager's first-round picks by year, draft habits (first pick's position, average round of their first QB, keepers, how many picks were still on the roster at season's end), and "Can't quit him" (same manager drafting the same player in different seasons).
- **Trades & Waivers** tab: filter by season and manager. Who works the wire (trades, adds, drops, waiver claims, FAAB spent, biggest bid, favorite trade partner), most frequent trade partners, every trade, every pickup, biggest FAAB bids, most-added players.
- **Seasons** tab: final rosters (or current rosters for the season in progress), starters first, with how each player got there (drafted, keeper, trade, waivers, free agent).
- **Teams** page: trades, pickups, latest trade and first-round picks for that manager.
- Sleeper has all of it for every season. ESPN has drafts and final rosters for every season, but move-by-move trades and pickups only from 2019 on; before that the counts use ESPN's season totals (marked with *).
- Leagues saved before this get their older seasons filled in a few at a time the first time someone opens the link (the page loads them automatically). Private ESPN leagues fill in the next time a member taps **Update this season** with their login.
- Player names come from Sleeper's player list (also used to name ESPN players), kept in the `flha_cache` table and refreshed once a day.

**Manager names**
- Private ESPN leagues show real names as "First L." (ESPN only sends real names to a signed-in member). Leagues loaded before this get everyone's names the next time a member updates with their login. Sleeper and public ESPN leagues show usernames.
- **Managers ✎** renames people and merges two accounts into one person ("same person as"). Changes are saved on the server and show for everyone with the link.
- Anyone with the link can edit. Every change goes into **Change history** (last 50, with an optional name), and any change can be undone from there.

## Files

```
index.html / app.js / app.css       the site (GitHub Pages, no build step)
demo.js                             made-up demo league (#demo)
config.js                           Supabase URL + publishable key (safe to publish)
supabase/setup.sql                  the one database table (run once)
supabase/update-shared-names.sql    adds shared names to a table made before Oct 2026 (run once)
supabase/update-moves.sql           adds the player-name cache table (run once, Oct 2026)
supabase/functions/league-history/  the one backend function
supabase/functions/_shared/
  flh-stats.js   stats engine (used by the site)
  flh-data.js    Sleeper loader + Sleeper/ESPN normalizers (site + server)
  flh-core.js    server-side loading/updating (ESPN fetch, merge)
  flh-moves.js   drafts, final rosters, trades and pickups (server only)
```

The site loads `flh-stats.js` and `flh-data.js` straight from the `_shared` folder, so there's one copy shared by the site and the server.

## Setup

Everything goes in the **same Supabase project as Fantasy Injury Assist** (`idwpxslgbtudrkxxxyqr`). Nothing in the injury app changes.

### 1. Create the table

Supabase → **SQL Editor** → **New query** → paste all of `supabase/setup.sql` → **Run**.

If the table already existed before shared names were added, also run `supabase/update-shared-names.sql` the same way. If it existed before drafts and trades were added, run `supabase/update-moves.sql` too.

### 2. Deploy the function

In a terminal, from this repo's folder:

```
npx supabase login
npx supabase link --project-ref idwpxslgbtudrkxxxyqr
npx supabase functions deploy league-history --no-verify-jwt
```

(`link` asks for that project's database password.) `--no-verify-jwt` lets the public site call it without signing in.

Quick test (any public Sleeper league ID works; this should print a share code and league name):

```
curl -s -X POST https://idwpxslgbtudrkxxxyqr.supabase.co/functions/v1/league-history -H "content-type: application/json" -d '{"action":"load","platform":"sleeper","league":"YOUR_SLEEPER_LEAGUE_ID"}' | head -c 300
```

### 3. GitHub repo + Pages

1. Create a public repo `jrkline1116/fantasy-league-history-assist` and upload everything in this folder (keep the folder structure).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
3. Custom domain: once you buy `fantasyleaguehistoryassist.com`, the `CNAME` file is already here. Add the domain in **Settings → Pages → Custom domain**, point DNS at GitHub Pages the same way as fantasydefenseassist.com, and tick **Enforce HTTPS**.

Drag the ESPN bookmark from the **live site** (not a local copy), since it opens whatever address it was dragged from.

## Updating

Site changes: edit, push to `main`, live in about a minute.
Function or `_shared` changes: `npx supabase functions deploy league-history --no-verify-jwt`.
(`flh-data.js` is used by both, so changing it means push and redeploy.)

## Handy SQL

```
-- most-viewed leagues
select name, platform, is_private, views, created_at, updated_at from flha_leagues order by views desc limit 50;
-- how many leagues
select platform, is_private, count(*) from flha_leagues group by 1, 2;
```

## Stat definitions

- **Avg finish:** final standing after playoffs, finished seasons only. Where the platform doesn't report it, playoff teams are ordered by how far they got (3rd-place game counts), everyone else by regular-season rank.
- **Avg reg. season:** regular-season standing (the platform's seed).
- **Averages in parentheses:** anywhere a points total shows, the per-game average follows it, e.g. 1896.9 (145.9).
- **Superlatives** (best average finish, record, points per game, luck, points allowed) only count managers who played at least half the league's finished seasons.
- **W-L-T, PF, PA:** regular season head-to-head games. Median-score wins on Sleeper affect seeding but aren't head-to-head games, so they aren't in W-L.
- **Head-to-head / Teams page rivals:** regular season plus winners-bracket playoff games (toggle on the Head-to-Head tab). Consolation games are left out everywhere.
- **All-play %:** your record if you'd played every team every week. **Luck** = win % minus all-play %.
- **Streaks** run across seasons.
- **Still on roster at season end:** share of a manager's draft picks on their final roster (finished seasons only).
- **Adds / Drops / Waiver claims:** completed waiver and free-agent moves (failed claims aren't counted). Players received in trades aren't adds.

## Later

- Draft grades from player points, trade winners (points after the trade), rivalry card images for the group chat, banner ads, Yahoo.
