// Fantasy League History Assist: Sleeper loading plus the Sleeper and ESPN normalizers that turn
// both platforms into the same "normalized season" shape flh-stats.js expects.
// Used by the site (Sleeper league search) and by the league-history edge function (everything else).
(function (root) {
  const SLEEPER = "https://api.sleeper.app/v1";

  // Jan-Feb still belong to last season
  const currentSeason = (d = new Date()) => (d.getMonth() < 2 ? d.getFullYear() - 1 : d.getFullYear());

  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  // Final standings when the platform doesn't hand them to us:
  // playoff teams by how far they got (champion first), everyone else by regular-season rank.
  function deriveFinal(keys, playoffGames, regRank) {
    if (!playoffGames.length) return Object.fromEntries([...keys].sort((a, b) => (regRank[a] ?? 99) - (regRank[b] ?? 99)).map((k, i) => [k, i + 1]));
    const lastRound = Math.max(...playoffGames.map((g) => g.round ?? g.week));
    const reached = {}; const lostIn = {}; const wonLast = {};
    for (const g of [...playoffGames].sort((p, q) => (p.round ?? p.week) - (q.round ?? q.week))) {
      const r = g.round ?? g.week;
      for (const k of [g.a, g.b]) reached[k] = Math.max(reached[k] ?? 0, r);
      const loser = g.as > g.bs ? g.b : g.as < g.bs ? g.a : null;
      if (loser) lostIn[loser] = Math.max(lostIn[loser] ?? 0, r);
      wonLast[g.a] = g.as > g.bs; wonLast[g.b] = g.bs > g.as;
    }
    const final = playoffGames.filter((g) => (g.round ?? g.week) === lastRound);
    // the championship is the last-round game with the most-advanced pair; assume the one whose teams never lost earlier
    const champGame = final.find((g) => !(lostIn[g.a] < lastRound) && !(lostIn[g.b] < lastRound)) || final[0];
    const champ = champGame ? (champGame.as >= champGame.bs ? champGame.a : champGame.b) : null;
    const runner = champGame ? (champ === champGame.a ? champGame.b : champGame.a) : null;
    const inPlayoffs = Object.keys(reached);
    // furthest round reached, then whether they won their last game (3rd-place game), then seed
    const score = (k) => (k === champ ? 1e6 : k === runner ? 5e5 : reached[k] * 1000 + (wonLast[k] ? 500 : 0)) - (regRank[k] ?? 99);
    const p = [...inPlayoffs].sort((a, b) => score(b) - score(a));
    const rest = keys.filter((k) => !reached[k]).sort((a, b) => (regRank[a] ?? 99) - (regRank[b] ?? 99));
    return Object.fromEntries([...p, ...rest].map((k, i) => [k, i + 1]));
  }

  /* ======================= Sleeper ======================= */
  async function sget(path) {
    const res = await fetch(SLEEPER + path);
    if (!res.ok) throw new Error(`Sleeper returned ${res.status}`);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  async function sleeperFindLeagues(username) {
    const u = await sget(`/user/${encodeURIComponent(username.trim())}`);
    if (!u?.user_id) throw new Error("No Sleeper user with that username.");
    const state = await sget("/state/nfl");
    let season = Number(state?.league_season || state?.season || currentSeason());
    let leagues = await sget(`/user/${u.user_id}/leagues/nfl/${season}`) || [];
    if (!leagues.length) { season -= 1; leagues = await sget(`/user/${u.user_id}/leagues/nfl/${season}`) || []; }
    return { season, user: u.display_name || u.username, leagues: leagues.map((l) => ({ id: String(l.league_id), name: l.name, teams: l.total_rosters, season: l.season })) };
  }

  async function sleeperLoad(leagueId, progress = () => {}, opts = {}) {
    const skip = opts.skip || new Set();
    const state = await sget("/state/nfl");
    const nowSeason = String(state?.season ?? "");
    const nowWeek = Number(state?.week ?? 0);
    // Updating a saved league: Sleeper gives a renewed league a new ID, so look for a newer
    // league (in a manager's league list) whose previous_league_id points at this one.
    if (opts.userIds?.length) {
      const leagueSeason = Number(state?.league_season || state?.season || 0);
      for (let hops = 0; hops < 3; hops++) {
        let next = null;
        for (const uid of opts.userIds.slice(0, 3)) {
          for (const yr of [leagueSeason, leagueSeason - 1]) {
            const ls = await sget(`/user/${uid}/leagues/nfl/${yr}`).catch(() => []) || [];
            next = ls.find((l) => String(l.previous_league_id) === String(leagueId));
            if (next) break;
          }
          if (next) break;
        }
        if (!next) break;
        leagueId = String(next.league_id);
      }
    }
    // walk back through previous_league_id to the first season
    const chain = []; let id = String(leagueId).trim(); const seen = new Set();
    while (id && id !== "0" && !seen.has(id) && chain.length < 40) {
      seen.add(id);
      progress(`Finding seasons… (${chain.length + 1})`);
      const L = await sget(`/league/${id}`);
      if (!L?.league_id) { if (!chain.length) throw new Error("Sleeper couldn't find that league. Check the league ID."); break; }
      chain.push(L); id = L.previous_league_id ? String(L.previous_league_id) : null;
    }
    const usable = chain.filter((L) => !["pre_draft", "drafting"].includes(L.status) && !skip.has(Number(L.season)));
    let done = 0;
    const seasons = await pool(usable, 3, async (L) => {
      const inProgress = L.status !== "complete";
      const maxWeek = inProgress ? (String(L.season) === nowSeason ? Math.max(0, nowWeek - 1) : 18) : 18;
      const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
      const [users, rosters, wb, ...weekData] = await Promise.all([
        sget(`/league/${L.league_id}/users`), sget(`/league/${L.league_id}/rosters`),
        sget(`/league/${L.league_id}/winners_bracket`).catch(() => []),
        ...weeks.map((w) => sget(`/league/${L.league_id}/matchups/${w}`).catch(() => [])),
      ]);
      progress(`Loading seasons… ${++done} of ${usable.length}`);
      return sleeperNormalize(L, users || [], rosters || [], wb || [], weekData.map((d, i) => ({ week: weeks[i], data: d || [] })), inProgress);
    });
    const out = seasons.filter((s) => s && s.teams.length).sort((a, b) => a.year - b.year);
    if (!out.length && !opts.skip) throw new Error("That league hasn't played any games yet.");
    return { platform: "sleeper", id: String(leagueId), ids: chain.map((L) => String(L.league_id)), leagueName: chain[0]?.name || "Sleeper league", seasons: out };
  }

  function sleeperNormalize(L, users, rosters, wb, weekData, inProgress) {
    const st = L.settings || {};
    const pws = Number(st.playoff_week_start || 0);
    const roundType = Number(st.playoff_round_type || 0);   // 0: 1 wk/round, 1: 2-wk final, 2: 2 wks/round
    const userById = Object.fromEntries(users.map((u) => [String(u.user_id), u]));
    const keyOf = {};
    const teams = rosters.map((r) => {
      const u = userById[String(r.owner_id)];
      const key = r.owner_id ? `sl:${r.owner_id}` : `sl-orphan:${L.league_id}:${r.roster_id}`;
      keyOf[r.roster_id] = key;
      return { key, teamName: u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`, manager: u?.display_name || null, rid: r.roster_id };
    });
    const maxR = wb.length ? Math.max(...wb.map((g) => g.r)) : 0;
    const roundOf = (w) => roundType === 2 ? Math.floor((w - pws) / 2) + 1 : roundType === 1 ? Math.min(w - pws + 1, maxR || 99) : w - pws + 1;
    const bracketPairs = new Set(wb.filter((g) => typeof g.t1 === "number" && typeof g.t2 === "number").map((g) => `${g.r}:${Math.min(g.t1, g.t2)}-${Math.max(g.t1, g.t2)}`));

    const games = []; const po = {};
    for (const { week, data } of weekData) {
      const byM = {};
      for (const m of data) if (m.matchup_id != null) (byM[m.matchup_id] ||= []).push(m);
      for (const pair of Object.values(byM)) {
        if (pair.length !== 2) continue;
        const [x, y] = pair; const xs = Number(x.points || 0), ys = Number(y.points || 0);
        if (!xs && !ys) continue;                  // not played
        if (!pws || week < pws) {
          games.push({ week, kind: "reg", a: keyOf[x.roster_id], b: keyOf[y.roster_id], as: xs, bs: ys });
        } else {
          const r = roundOf(week);
          const lo = Math.min(x.roster_id, y.roster_id), hi = Math.max(x.roster_id, y.roster_id);
          const k = `${r}:${lo}-${hi}`;
          const cur = po[k] ||= { week, round: r, a: lo, b: hi, as: 0, bs: 0 };
          const sx = x.roster_id === lo ? xs : ys, sy = x.roster_id === lo ? ys : xs;
          cur.as += sx; cur.bs += sy;
        }
      }
    }
    for (const [k, g] of Object.entries(po)) {
      games.push({ week: g.week, round: g.round, kind: bracketPairs.has(k) ? "playoff" : "cons", a: keyOf[g.a], b: keyOf[g.b], as: Math.round(g.as * 100) / 100, bs: Math.round(g.bs * 100) / 100 });
    }
    games.sort((p, q) => p.week - q.week);

    // regular-season rank the way Sleeper seeds: wins (incl. median wins), then points for
    const rs = (r) => r.settings || {};
    const pts = (r) => Number(rs(r).fpts || 0) + Number(rs(r).fpts_decimal || 0) / 100;
    const regOrder = [...rosters].sort((a, b) => (Number(rs(b).wins || 0) + Number(rs(b).ties || 0) / 2) - (Number(rs(a).wins || 0) + Number(rs(a).ties || 0) / 2) || pts(b) - pts(a));
    const regRank = Object.fromEntries(regOrder.map((r, i) => [keyOf[r.roster_id], i + 1]));

    let finalRank = null;
    if (!inProgress) {
      const keys = teams.map((t) => t.key);
      const placed = {};
      for (const g of wb) if (g.p && g.w && g.l) { placed[keyOf[g.w]] = g.p; placed[keyOf[g.l]] = g.p + 1; }
      const derived = deriveFinal(keys, games.filter((g) => g.kind === "playoff"), regRank);
      if (Object.keys(placed).length) {
        // trust Sleeper's placement games, fill the gaps with the derived order
        const used = new Set(Object.values(placed));
        const rest = keys.filter((k) => !placed[k]).sort((a, b) => derived[a] - derived[b]);
        let n = 1;
        for (const k of rest) { while (used.has(n)) n++; placed[k] = n; used.add(n); }
        finalRank = placed;
      } else finalRank = derived;
    }
    return {
      year: Number(L.season), platform: "sleeper", leagueName: L.name, complete: !inProgress,
      playoffTeams: Number(st.playoff_teams || 0) || null,
      teams: teams.map(({ rid, ...t }) => t), games, regRank, finalRank,
      medianScoring: !!st.league_average_match,
    };
  }

  /* ======================= ESPN ======================= */
  // "Graham" + "Cawley" -> "Graham C."
  function realName(first, last) {
    const f = String(first || "").trim(), l = String(last || "").trim();
    if (!f) return null;
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    return l ? `${cap(f)} ${l.charAt(0).toUpperCase()}.` : cap(f);
  }
  // ESPN is fetched by the edge function (flh-core.js); this turns one trimmed season into a normalized one.
  function espnNormalize(d) {
    // "First L." when ESPN sends real names (signed-in member), otherwise their ESPN display name
    const memberName = Object.fromEntries((d.members || []).map((m) => [m.id, realName(m.first, m.last) || m.name]));
    const keyOf = {}; const seed = {};
    const teams = d.teams.map((t) => {
      const owner = t.primary || t.owners[0];
      const key = owner ? `espn:${owner}` : `espn-team:${t.id}`;
      keyOf[t.id] = key; if (t.seed) seed[key] = t.seed;
      return { key, teamName: t.name, manager: (owner && memberName[owner]) || null };
    });
    const games = [];
    for (const g of d.games) {
      if (g.h == null || g.a == null || g.w === "UNDECIDED" || g.hs == null || g.as == null) continue;
      const kind = g.tier === "NONE" ? "reg" : g.tier === "WINNERS_BRACKET" ? "playoff" : "cons";
      games.push({ week: g.p, kind, a: keyOf[g.h], b: keyOf[g.a], as: g.hs, bs: g.as });
    }
    games.sort((p, q) => p.week - q.week);
    const keys = teams.map((t) => t.key);
    const regRank = Object.keys(seed).length === keys.length ? seed : root.FLHStats.regStandings(keys, games);
    const hasFinal = d.teams.some((t) => t.rankFinal > 0);
    const complete = hasFinal || (d.isActive === false) || d.season < currentSeason();
    let finalRank = null;
    if (hasFinal) finalRank = Object.fromEntries(d.teams.filter((t) => t.rankFinal > 0).map((t) => [keyOf[t.id], t.rankFinal]));
    else if (complete) finalRank = deriveFinal(keys, games.filter((g) => g.kind === "playoff"), regRank);
    return { year: d.season, platform: "espn", leagueName: d.name, complete, playoffTeams: d.playoffTeams, teams, games, regRank, finalRank };
  }

  const api = { sleeperFindLeagues, sleeperLoad, sleeperNormalize, espnNormalize, realName, deriveFinal, currentSeason };
  root.FLHData = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
