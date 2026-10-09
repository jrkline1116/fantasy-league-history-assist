// Fantasy League History Assist: stats engine.
// Pure functions: normalized seasons in, all-time numbers out. No DOM, no network.
//
// Normalized season (built by data.js for Sleeper and ESPN):
// {
//   year, platform, leagueName, complete (bool), playoffTeams,
//   teams: [{ key, teamName, manager }],              key = stable manager id (Sleeper user / ESPN SWID)
//   games: [{ week, kind: "reg"|"playoff"|"cons", a, b, as, bs }],   final games only
//   regRank: { key: n },                               regular-season standing
//   finalRank: { key: n } | null                       only when the season is complete
// }
(function (root) {
  const r2 = (n) => Math.round(n * 100) / 100;

  // Regular-season standings from games: wins (ties = half), then points for.
  function regStandings(teamKeys, games) {
    const t = Object.fromEntries(teamKeys.map((k) => [k, { w: 0, l: 0, t: 0, pf: 0 }]));
    for (const g of games) {
      if (g.kind !== "reg" || !t[g.a] || !t[g.b]) continue;
      t[g.a].pf += g.as; t[g.b].pf += g.bs;
      if (g.as > g.bs) { t[g.a].w++; t[g.b].l++; } else if (g.as < g.bs) { t[g.b].w++; t[g.a].l++; } else { t[g.a].t++; t[g.b].t++; }
    }
    const order = [...teamKeys].sort((x, y) => (t[y].w + t[y].t / 2) - (t[x].w + t[x].t / 2) || t[y].pf - t[x].pf);
    return Object.fromEntries(order.map((k, i) => [k, i + 1]));
  }

  function compute(seasonsIn, opts = {}) {
    const alias = opts.aliases || {};
    const canon = (k) => { let c = k, n = 0; while (alias[c] && alias[c] !== c && n++ < 20) c = alias[c]; return c; };
    const includePlayoffs = opts.h2hPlayoffs !== false;

    // Re-key every season through merges
    const seasons = [...seasonsIn].sort((a, b) => a.year - b.year).map((s) => {
      const mapRank = (m) => m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [canon(k), v])) : null;
      return {
        ...s,
        teams: s.teams.map((t) => ({ ...t, key: canon(t.key) })),
        games: s.games.map((g) => ({ ...g, a: canon(g.a), b: canon(g.b) })),
        regRank: mapRank(s.regRank) || {},
        finalRank: mapRank(s.finalRank),
      };
    });

    // ---- managers ----
    const M = {};
    const mgr = (k) => (M[k] ||= {
      key: k, name: null, teamNames: [], seasons: [], completeSeasons: 0,
      w: 0, l: 0, t: 0, pw: 0, pl: 0, pf: 0, pa: 0, games: 0,
      apW: 0, apL: 0, apT: 0,
      finishes: [], regFinishes: [], titles: 0, titleYears: [], runnerUps: 0, playoffs: 0, lasts: 0,
      highGame: null, lowGame: null,
    });
    for (const s of seasons) {
      for (const t of s.teams) {
        const m = mgr(t.key);
        m.name = (opts.names && opts.names[t.key]) || t.manager || m.name || t.teamName;
        if (!m.teamNames.includes(t.teamName)) m.teamNames.push(t.teamName);
        if (!m.seasons.includes(s.year)) m.seasons.push(s.year);
      }
    }
    for (const k of Object.keys(M)) if (opts.names && opts.names[k]) M[k].name = opts.names[k];

    // ---- per-season rows, records, h2h, all-play ----
    const h2h = {};        // h2h[a][b] = { w, l, t, pf, pa, games: [...] }
    const cell = (a, b) => ((h2h[a] ||= {})[b] ||= { w: 0, l: 0, t: 0, pf: 0, pa: 0, games: [] });
    const allGames = [];
    const seasonRows = [];

    for (const s of seasons) {
      const keys = s.teams.map((t) => t.key);
      const row = Object.fromEntries(s.teams.map((t) => [t.key, { key: t.key, teamName: t.teamName, w: 0, l: 0, t: 0, pf: 0, pa: 0, g: 0, pw: 0, pl: 0 }]));
      const weekly = {};   // week -> [[key, score]] for all-play (regular season)

      for (const g of s.games) {
        if (!row[g.a] || !row[g.b]) continue;
        const gameRec = { year: s.year, week: g.week, kind: g.kind, a: g.a, b: g.b, as: g.as, bs: g.bs };
        if (g.kind === "reg") {
          for (const [me, op, my, their] of [[g.a, g.b, g.as, g.bs], [g.b, g.a, g.bs, g.as]]) {
            const r = row[me]; r.g++; r.pf += my; r.pa += their;
            if (my > their) r.w++; else if (my < their) r.l++; else r.t++;
            (weekly[g.week] ||= []).push([me, my]);
          }
        } else if (g.kind === "playoff") {
          if (g.as > g.bs) { row[g.a].pw++; row[g.b].pl++; } else if (g.bs > g.as) { row[g.b].pw++; row[g.a].pl++; }
        }
        if (g.kind === "reg" || (g.kind === "playoff" && includePlayoffs)) {
          const c1 = cell(g.a, g.b), c2 = cell(g.b, g.a);
          c1.pf += g.as; c1.pa += g.bs; c2.pf += g.bs; c2.pa += g.as;
          if (g.as > g.bs) { c1.w++; c2.l++; } else if (g.as < g.bs) { c1.l++; c2.w++; } else { c1.t++; c2.t++; }
          c1.games.push(gameRec); c2.games.push(gameRec);
        }
        if (g.kind !== "cons") allGames.push(gameRec);
      }

      // all-play: every team's score vs every other score that week
      for (const list of Object.values(weekly)) {
        for (const [k, sc] of list) {
          for (const [k2, sc2] of list) {
            if (k === k2) continue;
            const m = mgr(k);
            if (sc > sc2) m.apW++; else if (sc < sc2) m.apL++; else m.apT++;
          }
        }
      }

      const regRank = Object.keys(s.regRank).length ? s.regRank : regStandings(keys, s.games);
      const champ = s.finalRank ? Object.keys(s.finalRank).find((k) => s.finalRank[k] === 1) : null;
      const runner = s.finalRank ? Object.keys(s.finalRank).find((k) => s.finalRank[k] === 2) : null;
      const n = keys.length;

      for (const k of keys) {
        const r = row[k], m = mgr(k);
        m.w += r.w; m.l += r.l; m.t += r.t; m.pf += r.pf; m.pa += r.pa; m.games += r.g; m.pw += r.pw; m.pl += r.pl;
        r.regRank = regRank[k] ?? null;
        r.finalRank = s.finalRank ? (s.finalRank[k] ?? null) : null;
        const madePlayoffs = s.games.some((g) => g.kind === "playoff" && (g.a === k || g.b === k))
          || (s.playoffTeams && r.regRank && r.regRank <= s.playoffTeams && s.complete);
        r.playoffs = !!madePlayoffs;
        if (s.complete) {
          m.completeSeasons++;
          if (r.finalRank) m.finishes.push({ year: s.year, rank: r.finalRank, of: n });
          if (r.regRank) m.regFinishes.push({ year: s.year, rank: r.regRank, of: n });
          if (madePlayoffs) m.playoffs++;
          if (k === champ) { m.titles++; m.titleYears.push(s.year); }
          if (k === runner) m.runnerUps++;
          if (r.finalRank === n) m.lasts++;
        }
      }
      // this season's games (canonical keys) and its own record book
      const sg = s.games.filter((g) => row[g.a] && row[g.b]).map((g) => ({ year: s.year, week: g.week, round: g.round, kind: g.kind, a: g.a, b: g.b, as: g.as, bs: g.bs }));
      const real = sg.filter((g) => g.kind !== "cons");
      const sSides = real.flatMap((g) => [{ ...g, me: g.a, op: g.b, my: g.as, their: g.bs }, { ...g, me: g.b, op: g.a, my: g.bs, their: g.as }]).filter((x) => x.my > 0);
      const sDec = real.filter((g) => g.as !== g.bs).map((g) => g.as > g.bs ? { ...g, win: g.a, lose: g.b, ws: g.as, ls: g.bs } : { ...g, win: g.b, lose: g.a, ws: g.bs, ls: g.as });
      const pick = (arr, f) => arr.length ? arr.reduce((b, x) => (f(x) > f(b) ? x : b)) : null;
      seasonRows.push({
        year: s.year, leagueName: s.leagueName, complete: s.complete, platform: s.platform, teamCount: n,
        champion: champ, runnerUp: runner, games: sg,
        weeks: [...new Set(sg.map((g) => g.week))].sort((a, b) => a - b),
        rec: {
          high: pick(sSides, (x) => x.my), low: pick(sSides, (x) => -x.my),
          blowout: pick(sDec, (x) => x.ws - x.ls), closest: pick(sDec, (x) => -(x.ws - x.ls)),
        },
        rows: Object.values(row).sort((x, y) => (x.finalRank ?? 99) - (y.finalRank ?? 99) || (x.regRank ?? 99) - (y.regRank ?? 99)),
      });
    }

    // ---- finish up managers ----
    const avg = (arr, f) => arr.length ? arr.reduce((a, x) => a + f(x), 0) / arr.length : null;
    const managers = Object.values(M).map((m) => {
      const gp = m.w + m.l + m.t, ap = m.apW + m.apL + m.apT;
      const winPct = gp ? (m.w + m.t / 2) / gp : null;
      const apPct = ap ? (m.apW + m.apT / 2) / ap : null;
      // finish percentile: 0 = always first, 1 = always last (fair across league sizes)
      const pctile = avg(m.finishes, (f) => f.of > 1 ? (f.rank - 1) / (f.of - 1) : 0);
      return {
        ...m,
        seasons: m.seasons.sort((a, b) => a - b),
        gp, winPct, allPlayPct: apPct, luck: winPct != null && apPct != null ? winPct - apPct : null,
        avgFinish: avg(m.finishes, (f) => f.rank),
        avgRegFinish: avg(m.regFinishes, (f) => f.rank),
        finishPctile: pctile,
        bestFinish: m.finishes.length ? Math.min(...m.finishes.map((f) => f.rank)) : null,
        worstFinish: m.finishes.length ? Math.max(...m.finishes.map((f) => f.rank)) : null,
        pfPerGame: m.games ? m.pf / m.games : null,
        paPerGame: m.games ? m.pa / m.games : null,
        pfPerSeason: m.seasons.length ? m.pf / m.seasons.length : null,
        paPerSeason: m.seasons.length ? m.pa / m.seasons.length : null,
      };
    });

    // ---- rivalries ----
    function rivals(k) {
      const row = h2h[k] || {};
      const list = Object.entries(row).map(([op, c]) => ({
        op, w: c.w, l: c.l, t: c.t, gp: c.w + c.l + c.t,
        pct: (c.w + c.l + c.t) ? (c.w + c.t / 2) / (c.w + c.l + c.t) : null,
        pfPg: c.games.length ? c.pf / c.games.length : 0, paPg: c.games.length ? c.pa / c.games.length : 0,
        games: c.games,
      }));
      const most = (f, tie) => [...list].sort((x, y) => f(y) - f(x) || tie(x, y))[0] || null;
      return {
        list: list.sort((x, y) => y.gp - x.gp || (y.pct ?? 0) - (x.pct ?? 0)),
        mostBeaten: most((x) => x.w, (x, y) => x.l - y.l),
        mostLostTo: most((x) => x.l, (x, y) => x.w - y.w),
        // win% based, at least 3 meetings
        bestPct: [...list].filter((x) => x.gp >= 3).sort((x, y) => y.pct - x.pct || y.gp - x.gp)[0] || null,
        worstPct: [...list].filter((x) => x.gp >= 3).sort((x, y) => x.pct - y.pct || y.gp - x.gp)[0] || null,
      };
    }

    // ---- records ----
    const sides = [];
    for (const g of allGames) {
      sides.push({ ...g, me: g.a, op: g.b, my: g.as, their: g.bs });
      sides.push({ ...g, me: g.b, op: g.a, my: g.bs, their: g.as });
    }
    const scored = sides.filter((x) => x.my > 0);
    const top = (arr, f, n = 10) => [...arr].sort(f).slice(0, n);
    const decided = allGames.filter((g) => g.as !== g.bs);
    const asWin = (g) => g.as > g.bs ? { ...g, win: g.a, lose: g.b, ws: g.as, ls: g.bs } : { ...g, win: g.b, lose: g.a, ws: g.bs, ls: g.as };

    // streaks (chronological, regular season + playoffs, carries across seasons)
    const byMgr = {};
    for (const x of sides.sort((p, q) => p.year - q.year || p.week - q.week)) (byMgr[x.me] ||= []).push(x);
    const streaks = { win: [], loss: [] };
    for (const [k, list] of Object.entries(byMgr)) {
      for (const type of ["win", "loss"]) {
        let cur = 0, best = 0, start = null, bestStart = null, bestEnd = null;
        for (const x of list) {
          const hit = type === "win" ? x.my > x.their : x.my < x.their;
          if (hit) { if (!cur) start = x; cur++; if (cur > best) { best = cur; bestStart = start; bestEnd = x; } } else cur = 0;
        }
        if (best) streaks[type].push({ key: k, len: best, from: bestStart, to: bestEnd });
      }
    }

    // season-level bests (complete seasons only, per game so short and long seasons compare)
    const seasonLines = [];
    for (const s of seasonRows) for (const r of s.rows) if (r.g) seasonLines.push({ year: s.year, key: r.key, ...r, pfPg: r.pf / r.g, complete: s.complete });

    const records = {
      highScores: top(scored, (x, y) => y.my - x.my),
      lowScores: top(scored, (x, y) => x.my - y.my),
      blowouts: top(decided.map(asWin), (x, y) => (y.ws - y.ls) - (x.ws - x.ls)),
      closest: top(decided.map(asWin), (x, y) => (x.ws - x.ls) - (y.ws - y.ls)),
      highCombined: top(allGames, (x, y) => (y.as + y.bs) - (x.as + x.bs)),
      winStreaks: top(streaks.win, (x, y) => y.len - x.len),
      lossStreaks: top(streaks.loss, (x, y) => y.len - x.len),
      bestSeasons: top(seasonLines.filter((x) => x.complete), (x, y) => (y.w + y.t / 2) / (y.w + y.l + y.t) - (x.w + x.t / 2) / (x.w + x.l + x.t) || y.pf - x.pf),
      mostPointsSeasons: top(seasonLines.filter((x) => x.complete), (x, y) => y.pfPg - x.pfPg),
      fewestPointsSeasons: top(seasonLines.filter((x) => x.complete), (x, y) => x.pfPg - y.pfPg),
    };

    // ---- per-manager personal records and year-by-year lines ----
    const by = (arr, k) => arr.reduce((o, x) => ((o[x[k]] ||= []).push(x), o), {});
    const scoredBy = by(scored, "me");
    const winBy = Object.fromEntries(streaks.win.map((x) => [x.key, x]));
    const lossBy = Object.fromEntries(streaks.loss.map((x) => [x.key, x]));
    for (const m of managers) {
      const mine = scoredBy[m.key] || [];
      m.highGame = mine.length ? mine.reduce((b, x) => (x.my > b.my ? x : b)) : null;
      m.lowGame = mine.length ? mine.reduce((b, x) => (x.my < b.my ? x : b)) : null;
      m.topGames = [...mine].sort((x, y) => y.my - x.my).slice(0, 5);
      m.bottomGames = [...mine].sort((x, y) => x.my - y.my).slice(0, 5);
      m.bestWin = (sides.filter((x) => x.me === m.key && x.my > x.their).sort((x, y) => (y.my - y.their) - (x.my - x.their))[0]) || null;
      m.worstLoss = (sides.filter((x) => x.me === m.key && x.my < x.their).sort((x, y) => (y.their - y.my) - (x.their - x.my))[0]) || null;
      m.winStreak = winBy[m.key] || null;
      m.lossStreak = lossBy[m.key] || null;
      m.playoffGames = sides.filter((x) => x.me === m.key && x.kind === "playoff").sort((x, y) => y.year - x.year || y.week - x.week);
      m.lines = seasonRows.flatMap((sr) => {
        const r = sr.rows.find((x) => x.key === m.key); if (!r) return [];
        const g = mine.filter((x) => x.year === sr.year);
        return [{
          year: sr.year, complete: sr.complete, teamName: r.teamName, teamCount: sr.teamCount,
          w: r.w, l: r.l, t: r.t, pf: r.pf, pa: r.pa, g: r.g, pw: r.pw, pl: r.pl,
          regRank: r.regRank, finalRank: r.finalRank, playoffs: r.playoffs,
          champ: sr.champion === m.key, runnerUp: sr.runnerUp === m.key,
          high: g.length ? Math.max(...g.map((x) => x.my)) : null, low: g.length ? Math.min(...g.map((x) => x.my)) : null,
        }];
      }).reverse();
    }

    return {
      seasons: seasonRows,
      managers,
      managerByKey: Object.fromEntries(managers.map((m) => [m.key, m])),
      h2h, rivals, records,
      years: seasons.map((s) => s.year),
    };
  }

  const api = { compute, regStandings, r2 };
  root.FLHStats = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
