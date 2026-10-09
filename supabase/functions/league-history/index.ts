// Fantasy League History Assist: the one backend function.
// Loads a league's history once, saves it under an unguessable share code, and keeps the
// season in progress up to date. ESPN cookies are passed through to ESPN for one request
// and are never saved or logged.
//
// POST { action: "open",    slug }
//      { action: "load",    platform: "sleeper"|"espn", league, espn_s2?, swid? }
//      { action: "refresh", slug, espn_s2?, swid? }
//      { action: "edit",    slug, names: {key: name}, aliases: {key: key}, by? }   shared renames/merges
//      { action: "history", slug }                                                 recent name changes
//      { action: "restore", slug, id, by? }                                        undo back to before change `id`
//      { action: "moves",   slug, espn_s2?, swid? }   fetch drafts/rosters/trades for a few more older seasons
// 200  { slug, platform, isPrivate, leagueName, seasons, updatedAt, edits, movesPending }
// 4xx  { error, private?: true }
import { createClient } from "npm:@supabase/supabase-js@2";
import "../_shared/flh-stats.js";
import "../_shared/flh-data.js";
import "../_shared/flh-core.js";
import "../_shared/flh-moves.js";

const Core = (globalThis as any).FLHCore;
const Moves = (globalThis as any).FLHMoves;
const TABLE = "flha_leagues";
const LIVE_STALE_MS = 3 * 3600e3;     // a season in progress: re-check every 3 hours
const OFF_STALE_MS = 7 * 86400e3;     // offseason: check weekly for a new season
const MIN_REFRESH_MS = 5 * 60e3;      // Refresh button: at most every 5 minutes without a login

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = {
  slug: string; platform: string; ext_id: string; ext_ids: string[]; is_private: boolean;
  name: string | null; data: { leagueName: string; seasons: any[]; peopleDone?: string | null }; updated_at: string; views: number;
  edits?: Edits | null; edit_log?: LogEntry[] | null;
};
type Edits = { names: Record<string, string>; aliases: Record<string, string>; v?: number };
type LogEntry = { id: string; at: string; by: string | null; changes: string[]; prev: Edits };
// v: 2 = "aliases[a] = b" means a was merged INTO b. Edits saved before v2 meant the reverse (the site flips those).
const edOf = (r: Row): Edits => ({ names: r.edits?.names ?? {}, aliases: r.edits?.aliases ?? {}, ...(r.edits?.v ? { v: r.edits.v } : {}) });
const toRec = (r: Row) => ({ platform: r.platform, extId: r.ext_id, extIds: r.ext_ids, isPrivate: r.is_private, leagueName: r.data.leagueName, seasons: r.data.seasons, peopleDone: r.data.peopleDone ?? null });
const out = (r: Row) => ({ slug: r.slug, platform: r.platform, isPrivate: r.is_private, leagueName: r.data.leagueName, seasons: r.data.seasons, updatedAt: r.updated_at, edits: edOf(r), movesPending: Moves.pendingCount(r.data.seasons) });

// Small shared cache (Sleeper's player list, refreshed daily). Optional: without the
// flha_cache table everything still works, it just downloads the list more often.
const cache = {
  async get(key: string) {
    const { data, error } = await db.from("flha_cache").select("data, updated_at").eq("key", key).maybeSingle();
    if (error) throw error;
    return data;
  },
  async set(key: string, data: unknown) {
    const { error } = await db.from("flha_cache").upsert({ key, data, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
};
const opts = { cache };

// 10 characters, no look-alikes (0/O, 1/l/I): about 10^16 possibilities, so codes can't be guessed
const ALPHA = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
function newSlug() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(b, (x) => ALPHA[x % ALPHA.length]).join("");
}

async function bySlug(slug: string): Promise<Row | null> {
  if (!/^[A-Za-z0-9]{8,16}$/.test(slug)) return null;
  const { data, error } = await db.from(TABLE).select("*").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data as Row | null;
}
async function byExt(platform: string, id: string): Promise<Row | null> {
  const q = db.from(TABLE).select("*").eq("platform", platform);
  const { data, error } = await (platform === "sleeper" ? q.contains("ext_ids", [id]) : q.eq("ext_id", id)).limit(1);
  if (error) throw error;
  return (data?.[0] as Row) ?? null;
}
async function save(row: Row, rec: any): Promise<Row> {
  const patch = {
    ext_id: rec.extId, ext_ids: rec.extIds, is_private: rec.isPrivate, name: rec.leagueName,
    data: { leagueName: rec.leagueName, seasons: rec.seasons, peopleDone: rec.peopleDone ?? null }, updated_at: new Date().toISOString(),
  };
  const { data, error } = await db.from(TABLE).update(patch).eq("slug", row.slug).select("*").single();
  if (error) throw error;
  return data as Row;
}
/* ---------- shared manager names (anyone with the link can edit; every change can be undone) ---------- */
const LOG_KEEP = 50;
const cleanName = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
function cleanEdits(row: Row, body: any): Edits {
  const keys = new Set(row.data.seasons.flatMap((s: any) => s.teams.map((t: any) => t.key)));
  const names: Record<string, string> = {}, aliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(body?.names ?? {}).slice(0, 300)) { const n = cleanName(v); if (keys.has(k) && n) names[k] = n; }
  for (const [k, v] of Object.entries(body?.aliases ?? {}).slice(0, 300)) { const to = String(v); if (keys.has(k) && keys.has(to) && k !== to) aliases[k] = to; }
  // no loops (A -> B -> A)
  for (const k of Object.keys(aliases)) { let c: string | undefined = aliases[k], n = 0; while (c && n++ < 50) { if (c === k) { delete aliases[k]; break; } c = aliases[c]; } }
  return { names, aliases, ...(body?.v === 2 ? { v: 2 } : {}) };
}
function labeler(row: Row, names: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const s of [...row.data.seasons].sort((a: any, b: any) => a.year - b.year)) for (const t of s.teams) base[t.key] = t.manager || t.teamName || base[t.key];
  return { now: (k: string) => names[k] || base[k] || "someone", base: (k: string) => base[k] || "someone" };
}
function describe(row: Row, prev: Edits, next: Edits): string[] {
  const b = labeler(row, prev.names), a = labeler(row, next.names), out: string[] = [];
  for (const k of new Set([...Object.keys(prev.names), ...Object.keys(next.names)])) {
    if (prev.names[k] === next.names[k]) continue;
    out.push(next.names[k] ? `Renamed ${b.now(k)} to ${next.names[k]}` : `${prev.names[k]} went back to ${a.base(k)}`);
  }
  for (const k of new Set([...Object.keys(prev.aliases), ...Object.keys(next.aliases)])) {
    if (prev.aliases[k] === next.aliases[k]) continue;
    out.push(next.aliases[k] ? `Merged ${a.now(k)} into ${a.now(next.aliases[k])}` : `Split ${b.now(k)} back out from ${b.now(prev.aliases[k])}`);
  }
  return out;
}
async function saveEdits(row: Row, next: Edits, by: unknown, changes: string[]): Promise<Row> {
  const entry: LogEntry = { id: newSlug().slice(0, 8), at: new Date().toISOString(), by: cleanName(by).slice(0, 30) || null, changes, prev: edOf(row) };
  const log = [entry, ...(row.edit_log ?? [])].slice(0, LOG_KEEP);
  const { data, error } = await db.from(TABLE).update({ edits: next, edit_log: log }).eq("slug", row.slug).select("*").single();
  if (error) throw error;
  return data as Row;
}

// the fields flh-moves.js adds to a season
const MOVE_FIELDS = ["draft", "rost", "tx", "tc", "pl", "faab", "mv", "mvErr", "lid", "nmFix"];

const stale = (r: Row) => Date.now() - Date.parse(r.updated_at) > (Core.hasLive(r.data.seasons) ? LIVE_STALE_MS : OFF_STALE_MS);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const creds = body.espn_s2 || body.swid ? { espn_s2: body.espn_s2, swid: body.swid } : null;

  try {
    switch (body.action) {
      case "open": {
        let row = await bySlug(String(body.slug ?? ""));
        if (!row) return json({ error: "That league link doesn't exist. Check that you copied the whole link." }, 404);
        // Sleeper and public ESPN leagues keep themselves current; private ones wait for a member's login
        if (!row.is_private && stale(row)) {
          try { row = await save(row, await Core.loadUpdate(toRec(row), null, opts)); } catch (e) { console.error("auto-update", row.slug, (e as Error).message); }
        }
        db.from(TABLE).update({ views: (row.views ?? 0) + 1 }).eq("slug", row.slug).then(() => {}, () => {});
        return json(out(row));
      }

      case "load": {
        const platform = String(body.platform ?? "");
        const id = platform === "sleeper" ? Core.parseSleeperId(body.league) : platform === "espn" ? Core.parseEspnId(body.league) : null;
        if (!id) return json({ error: platform === "espn" ? "Paste your league's web address. It should contain leagueId= and a number." : "That doesn't look like a league ID." }, 400);

        const existing = await byExt(platform, id);
        if (existing) {
          // A private league's share code is only handed to someone ESPN lets in
          if (existing.is_private && !creds) return json({ error: "This ESPN league is private.", private: true }, 401);
          let row = existing;
          if (existing.is_private || stale(existing)) row = await save(existing, await Core.loadUpdate(toRec(existing), creds, opts));
          return json(out(row));
        }

        const rec = await Core.loadNew(platform, body.league, creds, opts);
        // a renewed Sleeper league may already be saved under another season's ID
        const dup = platform === "sleeper" ? (await Promise.all(rec.extIds.map((x: string) => byExt("sleeper", x)))).find(Boolean) : null;
        if (dup) return json(out(await save(dup, { ...rec, extIds: [...new Set([...dup.ext_ids, ...rec.extIds])] })));
        for (let tries = 0; tries < 3; tries++) {
          const row = {
            slug: newSlug(), platform, ext_id: rec.extId, ext_ids: rec.extIds, is_private: rec.isPrivate,
            name: rec.leagueName, data: { leagueName: rec.leagueName, seasons: rec.seasons, peopleDone: rec.peopleDone ?? null },
          };
          const { data, error } = await db.from(TABLE).insert(row).select("*").single();
          if (!error) return json(out(data as Row));
          if (error.code !== "23505") throw error;
          const raced = await byExt(platform, rec.extId);   // someone saved the same league a moment ago
          if (raced) return json(out(raced));
        }
        throw new Error("Couldn't save the league. Try again.");
      }

      case "refresh": {
        const row = await bySlug(String(body.slug ?? ""));
        if (!row) return json({ error: "That league link doesn't exist." }, 404);
        if (row.is_private && !creds) return json({ ...out(row), needLogin: true });
        if (!creds && Date.now() - Date.parse(row.updated_at) < MIN_REFRESH_MS) return json(out(row));
        return json(out(await save(row, await Core.loadUpdate(toRec(row), creds, opts))));
      }

      case "moves": {
        const row = await bySlug(String(body.slug ?? ""));
        if (!row) return json({ error: "That league link doesn't exist." }, 404);
        if (!Moves.pendingCount(row.data.seasons)) return json(out(row));
        if (row.is_private && !creds) return json({ ...out(row), needLogin: true });
        const rec = await Moves.backfill(toRec(row), Core.cleanCreds(creds), opts);
        // someone else may have saved this league while we were fetching: only add moves, keep their copy of everything else
        const now = (await bySlug(row.slug)) ?? row;
        const before = Object.fromEntries(row.data.seasons.map((s: any) => [s.year, s]));
        const filled = Object.fromEntries(rec.seasons.filter((s: any) => s !== before[s.year]).map((s: any) => [s.year, s]));
        const seasons = now.data.seasons.map((s: any) => {
          const f = filled[s.year];
          // fill seasons without moves yet, or repaired player names on a season nobody else changed meanwhile
          if (!f || (s.mv != null && !(f.nmFix > (s.nmFix || 0)))) return s;
          const { mvErr: _e, ...base } = s;
          return { ...base, ...Object.fromEntries(MOVE_FIELDS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])) };
        });
        return json(out(await save(now, { ...toRec(now), seasons })));
      }

      case "edit": {
        const row = await bySlug(String(body.slug ?? ""));
        if (!row) return json({ error: "That league link doesn't exist." }, 404);
        const next = cleanEdits(row, body), changes = describe(row, edOf(row), next);
        if (!changes.length && edOf(row).v === next.v) return json(out(row));
        return json(out(await saveEdits(row, next, body.by, changes.length ? changes : ["Updated how merges are stored (no visible change)"])));
      }

      case "history": {
        const row = await bySlug(String(body.slug ?? ""));
        if (!row) return json({ error: "That league link doesn't exist." }, 404);
        return json({ log: (row.edit_log ?? []).map(({ prev: _p, ...e }) => e) });
      }

      case "restore": {
        const row = await bySlug(String(body.slug ?? ""));
        if (!row) return json({ error: "That league link doesn't exist." }, 404);
        const entry = (row.edit_log ?? []).find((e) => e.id === String(body.id ?? ""));
        if (!entry) return json({ error: "That change is too old to undo." }, 404);
        const next = cleanEdits(row, entry.prev), changes = describe(row, edOf(row), next);
        if (!changes.length) return json(out(row));
        const when = new Date(entry.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Phoenix" });
        return json(out(await saveEdits(row, next, body.by, [`Undid changes back to before ${entry.by ? entry.by + "'s" : "the"} edit on ${when}`, ...changes])));
      }
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    const err = e as any;
    if (err?.private) return json({ error: err.message, private: true }, 401);
    if (err instanceof Core.UserError) return json({ error: err.message }, 400);
    console.error(err);
    return json({ error: err?.message || "Something went wrong." }, 502);
  }
});
