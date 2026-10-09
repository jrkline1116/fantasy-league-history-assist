// Fantasy League History Assist: drafts, final rosters, trades and waiver/free-agent pickups.
// Server only (league-history edge function). Needs flh-core.js loaded first (ESPN requests).
//
// Each season gets these extra fields (short keys keep the saved league small):
//   pl:    { playerId: [name, pos, nflTeam?] }       names for every player referenced below
//   draft: { type: "snake"|"auction"|"linear", teams, picks: [{ n, r, s, k, p, kp?, $? }] }
//          n overall pick, r round, s draft slot (board column), k manager key, p player, kp keeper, $ auction price
//   rost:  { managerKey: [{ p, s }] }                   final roster; s = "s" starter, "b" bench, "r" IR, "t" taxi
//   tx:    [{ t: "trade", w, at, sides: [{ k, get: [p], picks: [{ y, r, o }], faab }] }
//           { t: "waiver"|"fa", w, at, k, add: [p], drop: [p], bid? }]
//   tc:    { managerKey: [adds, drops, trades, faabSpent] }   ESPN's own season totals (every year, even before 2019)
//   faab:  true when the league bid on waivers
//   mv:    MOVES_V once fetched (-1 = gave up after repeated failures)
(function (root) {
  const SLEEPER = "https://api.sleeper.app/v1";
  const MOVES_V = 1;
  const C = () => root.FLHCore;

  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }
  async function sget(path) {
    const res = await fetch(SLEEPER + path);
    if (!res.ok) throw new Error(`Sleeper returned ${res.status} for ${path}`);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  /* ---------------- player names ----------------
     Sleeper's player database (about 5 MB) has every player's name, and its espn_id field
     covers most ESPN player IDs too. Sleeper asks apps to fetch it at most once a day, so a
     trimmed copy is kept in the flha_cache table (if it exists) and in memory. */
  let memDb = null;
  async function playerDb(cache) {
    if (memDb && Date.now() - memDb.at < 6 * 3600e3) return memDb.db;
    let row = null;
    try { row = await cache?.get("players"); } catch (e) { console.error("cache get", e?.message); }
    if (row?.data && Date.now() - Date.parse(row.updated_at) < 86400e3) { memDb = { at: Date.now(), db: row.data }; return row.data; }
    try {
      const all = await sget("/players/nfl");
      const s = {}, e = {};
      for (const [id, p] of Object.entries(all || {})) {
        const pos = p.position || (p.fantasy_positions || [])[0] || "";
        const nm = pos === "DEF" ? `${p.last_name || id} D/ST` : (p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" "));
        if (!nm) continue;
        s[id] = [nm, pos === "DEF" ? "D/ST" : pos];
        if (p.espn_id) e[String(p.espn_id)] = s[id];
      }
      const db = { s, e };
      try { await cache?.set("players", db); } catch (err) { console.error("cache set", err?.message); }
      memDb = { at: Date.now(), db };
      return db;
    } catch (err) {
      if (row?.data) { memDb = { at: Date.now(), db: row.data }; return row.data; }   // stale copy beats nothing
      throw err;
    }
  }

  // every player ID a season's moves mention
  function referenced(m) {
    const ids = new Set();
    for (const p of m.draft?.picks || []) ids.add(p.p);
    for (const list of Object.values(m.rost || {})) for (const x of list) ids.add(x.p);
    for (const t of m.tx || []) {
      if (t.t === "trade") for (const s of t.sides) s.get.forEach((p) => ids.add(p));
      else { t.add.forEach((p) => ids.add(p)); t.drop.forEach((p) => ids.add(p)); }
    }
    return ids;
  }

  /* ======================= Sleeper ======================= */
  async function sleeperMoves(lid, opts) {
    const [L, rosters, drafts] = await Promise.all([
      sget(`/league/${lid}`), sget(`/league/${lid}/rosters`), sget(`/league/${lid}/drafts`).catch(() => []),
    ]);
    const keyOf = {};
    for (const r of rosters || []) keyOf[r.roster_id] = r.owner_id ? `sl:${r.owner_id}` : `sl-orphan:${lid}:${r.roster_id}`;
    const pl = {};
    const faab = Number(L?.settings?.waiver_type) === 2;

    // the season's main draft (dynasty leagues also have rookie drafts; take the first finished one)
    let draft = null;
    const d = (drafts || []).filter((x) => x.status === "complete").sort((a, b) => (a.start_time || 0) - (b.start_time || 0))[0];
    if (d) {
      const picks = (await sget(`/draft/${d.draft_id}/picks`).catch(() => [])) || [];
      const type = d.type === "auction" ? "auction" : d.type === "linear" ? "linear" : "snake";
      draft = {
        type, teams: Number(d.settings?.teams) || rosters?.length || null,
        picks: picks.filter((p) => p.player_id).map((p) => {
          const md = p.metadata || {};
          const pos = md.position === "DEF" ? "D/ST" : (md.position || "");
          const nm = md.position === "DEF" ? `${md.last_name || p.player_id} D/ST` : [md.first_name, md.last_name].filter(Boolean).join(" ");
          if (nm) pl[String(p.player_id)] = md.team ? [nm, pos, md.team] : [nm, pos];
          const amt = Number(md.amount);
          return {
            n: p.pick_no, r: p.round, s: p.draft_slot, k: keyOf[p.roster_id] || (p.picked_by ? `sl:${p.picked_by}` : null), p: String(p.player_id),
            ...(p.is_keeper ? { kp: 1 } : {}), ...(type === "auction" && amt ? { $: amt } : {}),
          };
        }).sort((a, b) => a.n - b.n),
      };
    }

    const rost = {};
    for (const r of rosters || []) {
      const st = new Set((r.starters || []).map(String)), ir = new Set((r.reserve || []).map(String)), taxi = new Set((r.taxi || []).map(String));
      rost[keyOf[r.roster_id]] = (r.players || []).map(String).filter((p) => p !== "0")
        .map((p) => ({ p, s: st.has(p) ? "s" : ir.has(p) ? "r" : taxi.has(p) ? "t" : "b" }));
    }

    const weeks = Array.from({ length: 18 }, (_, i) => i + 1);
    const lists = await pool(weeks, 6, (w) => sget(`/league/${lid}/transactions/${w}`).catch(() => []));
    const tx = []; const seen = new Set();
    lists.forEach((list, i) => {
      for (const t of list || []) {
        if (t.status !== "complete" || seen.has(t.transaction_id)) continue;
        seen.add(t.transaction_id);
        const w = Number(t.leg ?? weeks[i]); const at = t.status_updated || t.created || null;
        if (t.type === "trade") {
          const sides = {};
          const side = (rid) => (sides[rid] ||= { k: keyOf[rid] || null, get: [], picks: [], faab: 0 });
          for (const rid of t.roster_ids || []) side(rid);
          for (const [p, rid] of Object.entries(t.adds || {})) side(rid).get.push(String(p));
          for (const dp of t.draft_picks || []) side(dp.owner_id).picks.push({ y: Number(dp.season), r: Number(dp.round), o: keyOf[dp.roster_id] || null });
          for (const b of t.waiver_budget || []) side(b.receiver).faab += Number(b.amount || 0);
          tx.push({ t: "trade", w, at, sides: Object.values(sides).filter((s) => s.k) });
        } else if (t.type === "waiver" || t.type === "free_agent") {
          const rid = (t.roster_ids || [])[0];
          const bid = Number(t.settings?.waiver_bid);
          tx.push({
            t: t.type === "waiver" ? "waiver" : "fa", w, at, k: keyOf[rid] || null,
            add: Object.keys(t.adds || {}), drop: Object.keys(t.drops || {}),
            ...(faab && t.type === "waiver" && !isNaN(bid) ? { bid } : {}),
          });
        }
      }
    });
    tx.sort((a, b) => (a.at || 0) - (b.at || 0) || a.w - b.w);

    const m = { draft, rost, tx, pl, ...(faab ? { faab: true } : {}), mv: MOVES_V };
    const missing = [...referenced(m)].filter((id) => !pl[id]);
    if (missing.length) {
      const db = await playerDb(opts.cache);
      for (const id of missing) pl[id] = db.s[id] || [`Player ${id}`, ""];
    }
    return m;
  }

  /* ======================= ESPN ======================= */
  const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 7: "P", 9: "DT", 10: "DE", 11: "LB", 12: "CB", 13: "S", 14: "HC", 16: "D/ST" };
  const PRO = { 1: ["ATL", "Falcons"], 2: ["BUF", "Bills"], 3: ["CHI", "Bears"], 4: ["CIN", "Bengals"], 5: ["CLE", "Browns"], 6: ["DAL", "Cowboys"],
    7: ["DEN", "Broncos"], 8: ["DET", "Lions"], 9: ["GB", "Packers"], 10: ["TEN", "Titans"], 11: ["IND", "Colts"], 12: ["KC", "Chiefs"],
    13: ["LV", "Raiders"], 14: ["LAR", "Rams"], 15: ["MIA", "Dolphins"], 16: ["MIN", "Vikings"], 17: ["NE", "Patriots"], 18: ["NO", "Saints"],
    19: ["NYG", "Giants"], 20: ["NYJ", "Jets"], 21: ["PHI", "Eagles"], 22: ["ARI", "Cardinals"], 23: ["PIT", "Steelers"], 24: ["LAC", "Chargers"],
    25: ["SF", "49ers"], 26: ["SEA", "Seahawks"], 27: ["TB", "Buccaneers"], 28: ["WSH", "Commanders"], 29: ["CAR", "Panthers"], 30: ["JAX", "Jaguars"],
    33: ["BAL", "Ravens"], 34: ["HOU", "Texans"] };
  const espnPlayer = (p) => {
    if (!p) return null;
    const team = PRO[p.proTeamId]?.[0];
    const nm = p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ");
    return nm ? (team ? [nm, POS[p.defaultPositionId] || "", team] : [nm, POS[p.defaultPositionId] || ""]) : null;
  };
  // team defenses have negative IDs: -16000 minus the NFL team's ID
  const espnDef = (id) => { const n = Number(id); if (n > -16000 || n < -16040) return null; const t = PRO[-16000 - n]; return t ? [`${t[1]} D/ST`, "D/ST", t[0]] : null; };
  // ESPN's public athlete pages: last resort for anyone the other lists don't know (often rookies)
  async function espnAthletes(ids) {
    const out = {};
    await pool(ids.slice(0, 120), 6, async (id) => {
      if (Number(id) < 0) return;
      for (const url of [`https://sports.core.api.espn.com/v3/sports/football/nfl/athletes/${id}`, `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`]) {
        try {
          const res = await fetch(url, { headers: { accept: "application/json" } });
          if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } continue; }
          const j = await res.json(), a = j.athlete || j;
          const nm = a.fullName || a.displayName;
          if (!nm) continue;
          const pos = a.position?.abbreviation || "";
          out[id] = [nm, pos === "PK" ? "K" : pos];
          return;
        } catch { /* try the next one */ }
      }
    });
    return out;
  }
  const unnamed = (pl) => Object.entries(pl || {}).filter(([, v]) => /^Player -?\d+$/.test(v?.[0] || "")).map(([k]) => k);

  // Fill in names for ESPN player IDs: defenses, Sleeper's espn_id list, ESPN's league player
  // lookup, then ESPN's athlete pages. Changes pl in place.
  async function resolveEspn(ids, pl, leagueId, year, creds, opts) {
    let missing = ids.filter((p) => !pl[p] || /^Player /.test(pl[p][0]));
    for (const p of missing) { const x = espnDef(p); if (x) pl[p] = x; }
    missing = missing.filter((p) => !pl[p] || /^Player /.test(pl[p][0]));
    if (missing.length) {
      try { const db = await playerDb(opts.cache); for (const p of missing) if (db.e[p]) pl[p] = db.e[p]; }
      catch (e) { console.error("players", e?.message); }
      missing = missing.filter((p) => !pl[p] || /^Player /.test(pl[p][0]));
    }
    if (missing.length && year >= 2018) {
      try {
        const filter = JSON.stringify({ players: { filterIds: { value: missing.map(Number) }, limit: missing.length } });
        const r = await C().espnGet(`/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${leagueId}?scoringPeriodId=0&view=kona_player_info`, creds, { "x-fantasy-filter": filter });
        for (const x of r?.players || []) { const info = espnPlayer(x.player); if (info) pl[String(x.id ?? x.player?.id)] = info; }
      } catch (e) { if (e instanceof C().PrivateError) throw e; console.error("kona", e?.message); }
      missing = missing.filter((p) => !pl[p] || /^Player /.test(pl[p][0]));
    }
    if (missing.length) {
      const got = await espnAthletes(missing);
      Object.assign(pl, got);
      missing = missing.filter((p) => !got[p]);
      if (missing.length) console.error("unnamed", year, missing.slice(0, 20).join(","));
    }
    for (const p of missing) if (!pl[p]) pl[p] = [`Player ${p}`, ""];
  }

  const TX_FILTER = JSON.stringify({ transactions: { filterType: { value: ["FREEAGENT", "WAIVER", "TRADE_ACCEPT", "TRADE_PROPOSAL", "TRADE_UPHOLD"] } } });

  async function espnMoves(id, year, creds, opts) {
    const d = await C().espnSeason(id, year, creds, "view=mTeam&view=mRoster&view=mDraftDetail&view=mSettings&view=mStatus");
    if (!d) throw new Error(`ESPN has no ${year} season for this league`);
    const keyOf = {};
    for (const t of d.teams || []) {
      const owners = (t.owners ?? (t.primaryOwner ? [t.primaryOwner] : [])).map((o) => String(o).toUpperCase());
      const owner = t.primaryOwner ? String(t.primaryOwner).toUpperCase() : owners[0];
      keyOf[t.id] = owner ? `espn:${owner}` : `espn-team:${t.id}`;
    }
    const N = (d.teams || []).length;
    const pl = {};
    const faab = !!d.settings?.acquisitionSettings?.isUsingAcquisitionBudget;

    const rost = {}, tc = {};
    for (const t of d.teams || []) {
      const k = keyOf[t.id];
      rost[k] = (t.roster?.entries || []).map((e) => {
        const p = String(e.playerId);
        const info = espnPlayer(e.playerPoolEntry?.player) || espnDef(p);
        if (info) pl[p] = info;
        return { p, s: e.lineupSlotId === 20 ? "b" : e.lineupSlotId === 21 ? "r" : "s" };
      });
      const c = t.transactionCounter;
      if (c) tc[k] = [c.acquisitions || 0, c.drops || 0, c.trades || 0, c.acquisitionBudgetSpent || 0];
    }

    let draft = null;
    const dp = d.draftDetail?.picks || [];
    if (dp.length) {
      const type = String(d.settings?.draftSettings?.type || "SNAKE").toUpperCase() === "AUCTION" ? "auction" : "snake";
      draft = {
        type, teams: N || null,
        picks: dp.filter((p) => p.playerId != null && p.playerId !== -1).map((p) => {
          const r = p.roundId, rp = p.roundPickNumber;
          return {
            n: p.overallPickNumber, r, s: type === "snake" && N && r % 2 === 0 ? N + 1 - rp : rp, k: keyOf[p.teamId] || null, p: String(p.playerId),
            ...(p.keeper ? { kp: 1 } : {}), ...(type === "auction" && p.bidAmount ? { $: p.bidAmount } : {}),
          };
        }).sort((a, b) => a.n - b.n),
      };
    }

    // ESPN keeps move-by-move history from 2019 on
    const tx = [];
    if (year >= 2019) {
      const live = d.status?.isActive && !(d.status?.finalScoringPeriod && d.status?.latestScoringPeriod > d.status.finalScoringPeriod);
      const last = Math.min(18, Number(live ? (d.status?.latestScoringPeriod || d.scoringPeriodId) : (d.status?.finalScoringPeriod || 17)) || 17);
      const periods = Array.from({ length: last + 1 }, (_, i) => i);   // 0 = before week 1
      const lists = await pool(periods, 6, async (w) => {
        try {
          const r = await C().espnGet(`/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${id}?view=mTransactions2&scoringPeriodId=${w}`, creds, { "x-fantasy-filter": TX_FILTER });
          return r?.transactions || [];
        } catch (e) { if (e instanceof C().PrivateError) throw e; return []; }
      });
      const seenId = new Set(), seenTrade = new Set();
      lists.forEach((list, i) => {
        for (const t of list) {
          if (t.status !== "EXECUTED" || (t.id && seenId.has(t.id))) continue;
          if (t.id) seenId.add(t.id);
          const items = t.items || [];
          const w = Number(t.scoringPeriodId ?? periods[i]); const at = t.processDate || t.proposedDate || null;
          if (/^TRADE/.test(t.type || "")) {
            const tr = items.filter((x) => x.type === "TRADE");
            if (!tr.length) continue;
            // a trade shows up as the proposal, the accept and the league's OK: keep it once
            const sig = tr.map((x) => `${x.playerId}:${x.fromTeamId}>${x.toTeamId}`).sort().join(",");
            if (seenTrade.has(sig)) continue;
            seenTrade.add(sig);
            const sides = {};
            const side = (tid) => (sides[tid] ||= { k: keyOf[tid] || null, get: [], picks: [], faab: 0 });
            for (const x of tr) { side(x.fromTeamId); side(x.toTeamId).get.push(String(x.playerId)); }
            tx.push({ t: "trade", w, at, sides: Object.values(sides).filter((s) => s.k) });
          } else if (t.type === "WAIVER" || t.type === "FREEAGENT") {
            const add = items.filter((x) => x.type === "ADD"), drop = items.filter((x) => x.type === "DROP");
            if (!add.length && !drop.length) continue;
            const team = t.teamId ?? add[0]?.toTeamId ?? drop[0]?.fromTeamId;
            tx.push({
              t: t.type === "WAIVER" ? "waiver" : "fa", w, at, k: keyOf[team] || null,
              add: add.map((x) => String(x.playerId)), drop: drop.map((x) => String(x.playerId)),
              ...(faab && t.type === "WAIVER" && t.bidAmount != null ? { bid: t.bidAmount } : {}),
            });
          }
        }
      });
      tx.sort((a, b) => (a.at || 0) - (b.at || 0) || a.w - b.w);
    }

    const m = { draft, rost, tx, tc, pl, ...(faab ? { faab: true } : {}), mv: MOVES_V };
    // names: roster entries above, then everything else resolveEspn can find
    await resolveEspn([...referenced(m)], pl, id, year, creds, opts);
    return m;
  }

  /* ======================= filling seasons ======================= */
  const FIELDS = ["draft", "rost", "tx", "tc", "pl", "faab", "mv"];
  const strip = (s) => { const o = { ...s }; for (const f of FIELDS) delete o[f]; delete o.mvErr; return o; };
  const needsMoves = (s) => s.mv == null;
  // a season saved with players we couldn't name (tried at most twice more)
  const needsNames = (s) => s.mv >= 1 && (s.nmFix || 0) < 2 && unnamed(s.pl).length > 0;
  const pendingCount = (seasons) => seasons.filter((s) => needsMoves(s) || needsNames(s)).length;

  async function fixNames(rec, seasons, creds, opts) {
    return pool(seasons, 2, async (s) => {
      const pl = { ...s.pl }, ids = unnamed(pl);
      try {
        if (rec.platform === "espn") await resolveEspn(ids, pl, rec.extId, s.year, creds, opts);
        else { const db = await playerDb(opts.cache); for (const p of ids) if (db.s[p]) pl[p] = db.s[p]; }
      } catch (e) { if (e?.private) throw e; console.error("names", s.year, e?.message); }
      return { ...s, pl, nmFix: (s.nmFix || 0) + 1 };
    });
  }

  // Sleeper seasons saved before league IDs were kept on each season: find them from the saved ID list
  async function sleeperIds(rec) {
    const out = {};
    await pool(rec.extIds || [], 4, async (lid) => {
      try { const L = await sget(`/league/${lid}`); if (L?.season) out[Number(L.season)] = String(L.league_id); } catch { /* skip */ }
    });
    return out;
  }

  // Fetch moves for the given seasons (in place on copies). Failures are counted; after two
  // failed tries a season is marked done with nothing, so one bad season never blocks the rest.
  async function fill(rec, seasons, creds, opts) {
    let ids = null;
    return pool(seasons, rec.platform === "espn" ? 2 : 3, async (s) => {
      try {
        let m;
        if (rec.platform === "sleeper") {
          let lid = s.lid;
          if (!lid) { ids ||= await sleeperIds(rec); lid = ids[s.year]; }
          if (!lid) throw new Error(`no league ID for ${s.year}`);
          m = await sleeperMoves(lid, opts);
          return { ...strip(s), lid, ...m };
        }
        m = await espnMoves(rec.extId, s.year, creds, opts);
        return { ...strip(s), ...m };
      } catch (e) {
        if (e?.private) throw e;
        console.error("moves", rec.extId, s.year, e?.message);
        const tries = (s.mvErr || 0) + 1;
        return tries >= 2 ? { ...strip(s), mv: -1 } : { ...strip(s), mvErr: tries };
      }
    });
  }

  // One batch of the backfill: the newest seasons that don't have moves yet.
  // Returns the league record with those seasons filled in.
  async function backfill(rec, creds, opts = {}) {
    const batch = rec.platform === "espn" ? 4 : 5;
    const todo = rec.seasons.filter(needsMoves).sort((a, b) => b.year - a.year).slice(0, batch);
    const names = todo.length ? [] : rec.seasons.filter(needsNames).sort((a, b) => b.year - a.year).slice(0, 4);
    if (!todo.length && !names.length) return rec;
    const done = todo.length ? await fill(rec, todo, creds, opts) : await fixNames(rec, names, creds, opts);
    const byYear = Object.fromEntries(done.map((s) => [s.year, s]));
    return { ...rec, seasons: rec.seasons.map((s) => byYear[s.year] || s) };
  }

  const api = { MOVES_V, backfill, fill, pendingCount, needsMoves, needsNames, sleeperMoves, espnMoves, playerDb, referenced, espnAthletes };
  root.FLHMoves = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
