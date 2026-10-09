// Fantasy League History Assist: a made-up demo league, so visitors (and we) can see
// every screen without linking anything. Deterministic: same league every time.
(function (root) {
  function demoLeague() {
    let seed = 20180901;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const people = [
      ["d1", "Mike T.", ["Mahomes Alone", "Kelce Grammer"], 6],
      ["d2", "Sarah K.", ["Brady Bunch", "Tua Legit"], 9],
      ["d3", "Dave R.", ["Show Me Your TDs", "Dak to the Future"], 2],
      ["d4", "Jenna P.", ["The Fighting Amish", "Jenna Kelce"], 5],
      ["d5", "Chris B.", ["Bijan Mustard", "Chubb Club"], 0],
      ["d6", "Alex M.", ["Hurts Donut", "Jalen Hurts My Feelings"], 3],
      ["d7", "Tony G.", ["Cooper Troopers", "Tony's Takeover"], -3],
      ["d8", "Rachel W.", ["Kamara Shy", "Saquon Not Gone"], 4],
      ["d9", "Kevin L.", ["Waiver Wire Warriors"], -5],
      ["d10", "Matt S.", ["Lamb Chops", "CeeDee Nuts"], 1],
      ["d11", "Priya N.", ["Puka Shells"], 2],
    ];
    const seasons = [];
    for (let year = 2018; year <= 2026; year++) {
      // Kevin left after 2022; Priya joined in 2023
      const roster = people.filter((p) => !(p[0] === "d9" && year > 2022) && !(p[0] === "d11" && year < 2023));
      const teams = roster.map((p) => ({ key: "demo:" + p[0], teamName: p[2][year < 2022 ? 0 : p[2].length - 1], manager: p[1] }));
      const skill = Object.fromEntries(roster.map((p) => ["demo:" + p[0], p[3] + (rnd() - 0.5) * 14]));
      const score = (k) => Math.round((112 + skill[k] + (rnd() - 0.5) * 60) * 100) / 100;
      const regWeeks = year < 2021 ? 13 : 14;
      const live = year === 2026;
      const lastWeek = live ? 5 : regWeeks;
      const games = [];
      const keys = teams.map((t) => t.key);
      for (let w = 1; w <= lastWeek; w++) {
        const order = [...keys].sort(() => rnd() - 0.5);
        for (let i = 0; i + 1 < order.length; i += 2) games.push({ week: w, kind: "reg", a: order[i], b: order[i + 1], as: score(order[i]), bs: score(order[i + 1]) });
      }
      const regRank = FLHStats.regStandings(keys, games);
      let finalRank = null;
      if (!live) {
        const seedOf = [...keys].sort((a, b) => regRank[a] - regRank[b]);
        const play = (round, a, b, kind = "playoff") => { const g = { week: regWeeks + round, round, kind, a, b, as: score(a), bs: score(b) }; games.push(g); return g.as >= g.bs ? [a, b] : [b, a]; };
        // 6-team playoff, top 2 get byes, plus a 3rd-place game
        const [w36] = play(1, seedOf[2], seedOf[5]);
        const [w45] = play(1, seedOf[3], seedOf[4]);
        const low = regRank[w36] > regRank[w45] ? w36 : w45, high = low === w36 ? w45 : w36;
        const [s1, l1] = play(2, seedOf[0], low);
        const [s2, l2] = play(2, seedOf[1], high);
        play(3, s1, s2);
        play(3, l1, l2);
        play(1, seedOf[6], seedOf[7], "cons");
        finalRank = FLHData.deriveFinal(keys, games.filter((g) => g.kind === "playoff"), regRank);
      }
      seasons.push({ year, platform: "demo", leagueName: "The Commish's Revenge (demo)", complete: !live, playoffTeams: 6, teams, games, regRank, finalRank });
    }
    addMoves(seasons);
    return { slug: "demo", platform: "demo", leagueName: "The Commish's Revenge (demo)", seasons, savedAt: Date.now() };
  }

  // Made-up drafts, final rosters, trades and pickups (invented players), same every time
  function addMoves(seasons) {
    let seed = 7741;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pickOne = (a) => a[Math.floor(rnd() * a.length)];
    const FIRST = ["Marcus", "Tyrell", "Jordan", "Caleb", "Devin", "Isaiah", "Brandon", "Malik", "Trent", "Darius", "Cole", "Jalen", "Austin", "Dante", "Elijah", "Garrett", "Hunter", "Keenan", "Logan", "Rashad", "Bryce", "Corey", "Dalton", "Xavier", "Nico", "Quinn", "Reggie", "Silas", "Terrell", "Wyatt"];
    const LAST = ["Holloway", "Brooks", "Whitfield", "Okafor", "Dempsey", "Calloway", "Hargrove", "Pruitt", "Lindqvist", "Mabry", "Strickland", "Vance", "Ashby", "Coleman", "Dunbar", "Ellery", "Fontaine", "Granger", "Hastings", "Ivey", "Jessup", "Kimbrough", "Lockett", "Mercer", "Norwood", "Oakes", "Pemberton", "Rourke", "Sutter", "Tolliver", "Upshaw", "Weatherby"];
    const TEAMS = ["Bears", "Bills", "Hawks", "Kings", "Lions", "Owls", "Pilots", "Rams", "Sharks", "Stags", "Titans", "Wolves"];
    const pl = {}; const pool = [];
    let id = 1000;
    const used = new Set();
    for (const [pos, n] of [["QB", 28], ["RB", 60], ["WR", 76], ["TE", 26], ["K", 18]]) for (let i = 0; i < n; i++) {
      let nm; do nm = `${pickOne(FIRST)} ${pickOne(LAST)}`; while (used.has(nm)); used.add(nm);
      const pid = String(id++); pl[pid] = [nm, pos]; pool.push({ p: pid, pos, v: 100 - i * (pos === "QB" ? 3.2 : pos === "TE" ? 3.6 : pos === "K" ? 9 : 1.5) + (pos === "K" ? -60 : 0) });
    }
    for (const t of TEAMS) { const pid = "D-" + t; pl[pid] = [`${t} D/ST`, "D/ST"]; pool.push({ p: pid, pos: "D/ST", v: 20 + rnd() * 10 }); }
    const fav = {};
    for (const s of seasons) {
      const keys = s.teams.map((t) => t.key);
      for (const k of keys) fav[k] ||= [pickOne(pool.filter((x) => x.pos === "RB" && x.v > 70)).p, pickOne(pool.filter((x) => x.pos === "WR" && x.v > 65)).p];
      // value drifts a little each year
      const val = Object.fromEntries(pool.map((x) => [x.p, x.v + (rnd() - 0.5) * 30]));
      const order = [...keys].sort(() => rnd() - 0.5), N = order.length, rounds = 15;
      const avail = new Set(pool.map((x) => x.p)), have = Object.fromEntries(keys.map((k) => [k, []]));
      const cap = { QB: 2, TE: 2, K: 1, "D/ST": 1, RB: 6, WR: 7 };
      const picks = [];
      for (let r = 1; r <= rounds; r++) for (let i = 0; i < N; i++) {
        const slot = r % 2 ? i + 1 : N - i, k = order[slot - 1];
        const cnt = (pos) => have[k].filter((p) => pl[p][1] === pos).length;
        const late = r >= rounds - 1;
        const best = pool.filter((x) => avail.has(x.p) && cnt(x.pos) < cap[x.pos] && (late ? true : !["K", "D/ST"].includes(x.pos)))
          .map((x) => ({ ...x, sc: val[x.p] + (fav[k].includes(x.p) ? 9 : 0) + (late && ["K", "D/ST"].includes(x.pos) && !cnt(x.pos) ? 200 : 0) + rnd() * 8 }))
          .sort((a, b) => b.sc - a.sc)[0];
        avail.delete(best.p); have[k].push(best.p);
        picks.push({ n: picks.length + 1, r, s: slot, k, p: best.p });
      }
      // trades and pickups through the season
      const lastWeek = Math.max(...s.games.map((g) => g.week));
      const tx = []; const faab = s.year >= 2021;
      const free = [...avail];
      const nTrades = s.complete ? 2 + Math.floor(rnd() * 4) : 1;
      for (let i = 0; i < nTrades; i++) {
        const [a, b] = [...keys].sort(() => rnd() - 0.5);
        const pa = pickOne(have[a].filter((p) => !["K", "D/ST"].includes(pl[p][1]))), pb = pickOne(have[b].filter((p) => !["K", "D/ST"].includes(pl[p][1])));
        have[a] = have[a].filter((p) => p !== pa).concat(pb); have[b] = have[b].filter((p) => p !== pb).concat(pa);
        const w = 2 + Math.floor(rnd() * Math.max(1, Math.min(lastWeek, 11) - 2));
        tx.push({ t: "trade", w, at: Date.UTC(s.year, 8, 5 + w * 7, 18), sides: [{ k: a, get: [pb], picks: [], faab: 0 }, { k: b, get: [pa], picks: [], faab: 0 }] });
      }
      const nPick = s.complete ? 28 + Math.floor(rnd() * 20) : 10;
      for (let i = 0; i < nPick; i++) {
        const k = pickOne(keys), add = free.splice(Math.floor(rnd() * Math.min(free.length, 40)), 1)[0];
        const bench = have[k].filter((p) => !fav[k].includes(p));
        const drop = bench[bench.length - 1 - Math.floor(rnd() * Math.min(6, bench.length))];
        have[k] = have[k].filter((p) => p !== drop).concat(add); free.push(drop);
        const w = 1 + Math.floor(rnd() * lastWeek), waiver = rnd() < 0.6;
        tx.push({ t: waiver ? "waiver" : "fa", w, at: Date.UTC(s.year, 8, 3 + w * 7, 9), k, add: [add], drop: [drop], ...(waiver && faab ? { bid: Math.floor(rnd() * rnd() * 45) } : {}) });
      }
      tx.sort((x, y) => x.at - y.at);
      const rost = {};
      for (const k of keys) {
        const list = [...have[k]].sort((x, y) => val[y] - val[x]);
        const need = { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, "D/ST": 1 }; let flex = 1;
        rost[k] = list.map((p) => { const pos = pl[p][1]; if (need[pos] > 0) { need[pos]--; return { p, s: "s" }; } if (flex && ["RB", "WR", "TE"].includes(pos)) { flex = 0; return { p, s: "s" }; } return { p, s: "b" }; });
      }
      const refd = new Set([...picks.map((x) => x.p), ...Object.values(rost).flat().map((x) => x.p), ...tx.flatMap((t) => t.t === "trade" ? t.sides.flatMap((x) => x.get) : [...t.add, ...t.drop])]);
      Object.assign(s, { draft: { type: "snake", teams: N, picks }, rost, tx, pl: Object.fromEntries([...refd].map((p) => [p, pl[p]])), ...(faab ? { faab: true } : {}), mv: 1 });
    }
  }
  root.FLHDemo = { demoLeague };
})(typeof window !== "undefined" ? window : globalThis);
