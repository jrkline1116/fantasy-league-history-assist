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
    return { slug: "demo", platform: "demo", leagueName: "The Commish's Revenge (demo)", seasons, savedAt: Date.now() };
  }
  root.FLHDemo = { demoLeague };
})(typeof window !== "undefined" ? window : globalThis);
