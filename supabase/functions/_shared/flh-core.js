// Fantasy League History Assist: server-side league loading (runs in the league-history
// edge function). Fetches a league's full history from Sleeper or ESPN, or only what can
// still change (the season in progress and any new seasons), and merges updates into a
// saved copy. Plain JS so it can also be tested in Node. Needs flh-stats.js and flh-data.js
// loaded first. ESPN cookies are only ever passed through to ESPN; nothing here stores them.
(function (root) {
  const D = () => root.FLHData;

  class PrivateError extends Error { constructor(m) { super(m); this.private = true; } }
  class NotFoundError extends Error {}
  class UserError extends Error {}

  /* ---------------- helpers ---------------- */
  function parseEspnId(input) {
    const s = String(input ?? "").trim();
    if (/^\d{3,12}$/.test(s)) return s;
    return (s.match(/leagueId=(\d{3,12})/i) || [])[1] || null;
  }
  function parseSleeperId(input) {
    const s = String(input ?? "").trim();
    return /^\d{6,22}$/.test(s) ? s : ((s.match(/leagues?\/(\d{6,22})/) || [])[1] || null);
  }
  function normSwid(swid) {
    if (!swid) return undefined;
    const s = String(swid).trim().replace(/^%7B/i, "{").replace(/%7D$/i, "}").toUpperCase();
    return s.startsWith("{") ? s : `{${s}}`;
  }
  function cleanCreds(c) {
    const s2 = String(c?.espn_s2 ?? "").trim(), sw = String(c?.swid ?? "").trim();
    if (!!s2 !== !!sw) throw new UserError("Add both cookies (espn_s2 and SWID), or leave both blank.");
    return s2 ? { espn_s2: s2, swid: normSwid(sw) } : null;
  }
  const currentSeason = (d = new Date()) => (d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear());
  // newest season such that it and everything before it is finished
  function doneThrough(seasons) {
    let y = null;
    for (const s of [...seasons].sort((a, b) => a.year - b.year)) { if (!s.complete) break; y = s.year; }
    return y;
  }
  function mergeSeasons(oldSeasons, newSeasons) {
    const byYear = Object.fromEntries(oldSeasons.map((s) => [s.year, s]));
    for (const s of newSeasons) byYear[s.year] = s;
    return Object.values(byYear).sort((a, b) => a.year - b.year);
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  /* ---------------- ESPN ---------------- */
  const HOSTS = ["https://lm-api-reads.fantasy.espn.com", "https://fantasy.espn.com"];
  const VIEWS = "view=mTeam&view=mSettings&view=mMatchupScore&view=mStandings&view=mStatus";

  async function espnGet(path, creds) {
    const headers = { accept: "application/json", "user-agent": "FantasyLeagueHistoryAssist/1.0" };
    if (creds?.espn_s2) headers.cookie = `espn_s2=${creds.espn_s2}; SWID=${creds.swid}`;
    const tried = [];
    for (const host of HOSTS) {
      const h = new URL(host).hostname;
      let res;
      try { res = await fetch(host + path, { headers }); } catch (e) { tried.push(`${h}: ${e.message}`); continue; }
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch { tried.push(`${h}: not JSON`); continue; }
      }
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (res.status === 404) throw new NotFoundError(path);
      tried.push(`${h}:${res.status}`);
    }
    // Private leagues: the API host says 401/403 and the backup host returns an HTML login page
    if (tried.some((t) => /:40[13]/.test(t)) && tried.every((t) => /:40[13]|not JSON/.test(t))) {
      throw new PrivateError(creds?.espn_s2
        ? "ESPN didn't accept those cookies. Copy fresh espn_s2 and SWID values (or click your bookmark again) and try again."
        : "This ESPN league is private.");
    }
    throw new Error(`ESPN request failed (${tried.join(", ")})`);
  }

  // 2018 and later live under /seasons/{year}; older years only under /leagueHistory
  async function espnSeason(id, year, creds) {
    if (year >= 2018) {
      try { return await espnGet(`/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${id}?${VIEWS}`, creds); }
      catch (e) { if (!(e instanceof NotFoundError)) throw e; }
    }
    try {
      const arr = await espnGet(`/apis/v3/games/ffl/leagueHistory/${id}?seasonId=${year}&${VIEWS}`, creds);
      return Array.isArray(arr) ? (arr[0] ?? null) : arr;
    } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  }

  function espnTrim(d) {
    const members = (d.members ?? []).map((m) => ({
      id: String(m.id ?? "").toUpperCase(),
      name: m.displayName || [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
      first: m.firstName || null, last: m.lastName || null,
    }));
    const teams = (d.teams ?? []).map((t) => ({
      id: t.id,
      name: t.name || [t.location, t.nickname].filter(Boolean).join(" ") || t.abbrev || `Team ${t.id}`,
      owners: (t.owners ?? (t.primaryOwner ? [t.primaryOwner] : [])).map((o) => String(o).toUpperCase()),
      primary: t.primaryOwner ? String(t.primaryOwner).toUpperCase() : null,
      rankFinal: t.rankCalculatedFinal ?? 0,
      seed: t.playoffSeed ?? 0,
    }));
    const games = (d.schedule ?? []).map((g) => ({
      p: g.matchupPeriodId, h: g.home?.teamId ?? null, a: g.away?.teamId ?? null,
      hs: g.home?.totalPoints ?? null, as: g.away?.totalPoints ?? null,
      w: g.winner ?? "UNDECIDED", tier: g.playoffTierType ?? "NONE",
    }));
    return {
      season: d.seasonId, name: d.settings?.name ?? null,
      playoffTeams: d.settings?.scheduleSettings?.playoffTeamCount ?? null,
      isActive: d.status?.isActive ?? null, members, teams, games,
    };
  }

  // Real names for every manager who ever played, from each season's member list.
  // ESPN only sends first/last names to a signed-in member, so this runs once per league with a login.
  // Returns { "espn:{ID}": "First L." }
  async function espnPeople(id, years, creds) {
    const people = {};
    const lists = await pool([...years].sort((a, b) => a - b), 4, async (y) => {
      const path = y >= 2018
        ? `/apis/v3/games/ffl/seasons/${y}/segments/0/leagues/${id}?view=mTeam`
        : `/apis/v3/games/ffl/leagueHistory/${id}?seasonId=${y}&view=mTeam`;
      try { const d = await espnGet(path, creds); return (Array.isArray(d) ? d[0] : d)?.members ?? []; }
      catch (e) { if (e instanceof PrivateError) throw e; return []; }
    });
    for (const list of lists) for (const m of list || []) {
      const n = D().realName(m.firstName, m.lastName);
      if (n && m.id) people[`espn:${String(m.id).toUpperCase()}`] = n;
    }
    return people;
  }
  const applyPeople = (seasons, people) => seasons.map((s) => ({
    ...s, teams: s.teams.map((t) => (people[t.key] ? { ...t, manager: people[t.key] } : t)),
  }));

  // since: only seasons after this year (null = everything)
  async function espnHistory(id, creds, since = null) {
    let latest = null;
    const now = currentSeason();
    for (const y of [now, now - 1, now - 2]) {
      if (since != null && y <= since) break;
      latest = await espnSeason(id, y, creds);
      if (latest) break;
    }
    if (!latest) {
      if (since != null) return [];
      throw new UserError(`ESPN couldn't find league ${id}. Check the league address.`);
    }
    let years = (latest.status?.previousSeasons ?? []).map(Number).filter(Boolean);
    if (!years.length && since == null) {
      try {
        const all = await espnGet(`/apis/v3/games/ffl/leagueHistory/${id}?view=mSettings`, creds);
        years = (Array.isArray(all) ? all : []).map((s) => Number(s.seasonId)).filter(Boolean);
      } catch (e) { if (e instanceof PrivateError) throw e; }
    }
    years = [...new Set(years)].filter((y) => y < latest.seasonId && (since == null || y > since)).sort((a, b) => a - b);
    const older = await pool(years, 4, async (y) => {
      try { return await espnSeason(id, y, creds); } catch (e) { if (e instanceof PrivateError) throw e; return null; }
    });
    return [...older.filter(Boolean), latest].map(espnTrim).map((t) => D().espnNormalize(t)).filter((s) => s.teams.length);
  }

  /* ---------------- public API ---------------- */
  // A brand-new league. Returns { platform, extId, extIds, isPrivate, leagueName, seasons }.
  async function loadNew(platform, input, credsIn) {
    if (platform === "sleeper") {
      const id = parseSleeperId(input);
      if (!id) throw new UserError("That doesn't look like a Sleeper league ID.");
      let L = await D().sleeperLoad(id, () => {});
      let rec = { platform, extId: L.id, extIds: L.ids || [L.id], isPrivate: false, leagueName: L.leagueName, seasons: L.seasons };
      // someone pasted an older season's ID: walk forward to the current league too
      const newest = Math.max(...L.seasons.map((s) => s.year));
      if (newest < currentSeason()) { try { rec = await loadUpdate(rec, null); } catch { /* keep what we have */ } }
      return rec;
    }
    if (platform === "espn") {
      const id = parseEspnId(input);
      if (!id) throw new UserError("Paste your league's web address. It should contain leagueId= and a number.");
      const creds = cleanCreds(credsIn);
      try {
        const seasons = await espnHistory(id, null);
        return { platform, extId: id, extIds: [id], isPrivate: false, leagueName: seasons[seasons.length - 1].leagueName || `ESPN league ${id}`, seasons, peopleDone: "anon" };
      } catch (e) {
        if (!(e instanceof PrivateError) || !creds) throw e;
      }
      const seasons = await espnHistory(id, creds);
      return { platform, extId: id, extIds: [id], isPrivate: true, leagueName: seasons[seasons.length - 1].leagueName || `ESPN league ${id}`, seasons, peopleDone: "login" };
    }
    throw new UserError("Unknown platform.");
  }

  // Bring a saved league up to date. Finished seasons are never fetched again.
  // Throws PrivateError if a private ESPN league needs a (fresh) login.
  async function loadUpdate(rec, credsIn) {
    const since = doneThrough(rec.seasons);
    if (rec.platform === "sleeper") {
      const lastTeams = rec.seasons[rec.seasons.length - 1]?.teams || [];
      const fresh = await D().sleeperLoad(rec.extId, () => {}, {
        skip: new Set(rec.seasons.filter((s) => s.complete).map((s) => s.year)),
        userIds: [...new Set(lastTeams.map((t) => t.key).filter((k) => k.startsWith("sl:")).map((k) => k.slice(3)))],
      });
      return {
        ...rec, extId: fresh.id,
        extIds: [...new Set([...(rec.extIds || []), ...(fresh.ids || []), fresh.id])],
        leagueName: fresh.seasons.length ? fresh.leagueName : rec.leagueName,
        seasons: mergeSeasons(rec.seasons, fresh.seasons),
      };
    }
    const creds = cleanCreds(credsIn);
    let isPrivate = rec.isPrivate, seasons;
    if (rec.isPrivate) {
      if (!creds) throw new PrivateError("This ESPN league is private.");
      // Always ask ESPN once, even when nothing is left to fetch: this is what proves the
      // visitor is in the league before they're given its share link.
      const newest = Math.max(...rec.seasons.map((s) => s.year));
      await espnGet(`/apis/v3/games/ffl/seasons/${newest}/segments/0/leagues/${rec.extId}?view=mSettings`, creds)
        .catch((e) => { if (e instanceof NotFoundError) return espnGet(`/apis/v3/games/ffl/leagueHistory/${rec.extId}?seasonId=${newest}&view=mSettings`, creds); throw e; });
      seasons = await espnHistory(rec.extId, creds, since);
    } else {
      try { seasons = await espnHistory(rec.extId, null, since); }
      catch (e) {
        // went private since it was saved
        if (!(e instanceof PrivateError) || !creds) throw e;
        seasons = await espnHistory(rec.extId, creds, since); isPrivate = true;
      }
    }
    let merged = mergeSeasons(rec.seasons, seasons), peopleDone = rec.peopleDone || null;
    // Leagues saved before real names were kept: fetch everyone's names once (needs a login to get them)
    if (peopleDone !== "login" && (creds || !peopleDone)) {
      try {
        const people = await espnPeople(rec.extId, merged.map((s) => s.year), creds);
        merged = applyPeople(merged, people);
        peopleDone = creds ? "login" : "anon";
      } catch (e) { if (e instanceof PrivateError) throw e; console.error("names", e?.message); }
    }
    return {
      ...rec, isPrivate, peopleDone,
      leagueName: seasons.length ? (seasons[seasons.length - 1].leagueName || rec.leagueName) : rec.leagueName,
      seasons: merged,
    };
  }

  // Does this saved league still have games left to fetch?
  const hasLive = (seasons) => seasons.some((s) => !s.complete);

  const api = { loadNew, loadUpdate, doneThrough, mergeSeasons, hasLive, parseEspnId, parseSleeperId, currentSeason, PrivateError, UserError };
  root.FLHCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
