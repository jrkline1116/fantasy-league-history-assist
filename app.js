// Fantasy League History Assist: the site.
// Opens a league saved by the league-history function, runs flh-stats.js over it, and renders
// the tabs (including drafts, final rosters, trades and pickups). Manager renames/merges are shared on the server.
(() => {
  "use strict";
  const CFG = window.FLH_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const f1 = (n) => n == null || isNaN(n) ? "—" : n.toFixed(1);
  const f2 = (n) => n == null || isNaN(n) ? "—" : n.toFixed(2);
  const pct = (n) => n == null || isNaN(n) ? "—" : n.toFixed(3).replace(/^0(?=\.)/, "");
  const signPct = (n) => n == null ? "—" : `<span class="${n > 0.005 ? "pos" : n < -0.005 ? "neg" : ""}">${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}</span>`;
  const rec = (w, l, t) => `${w}-${l}${t ? "-" + t : ""}`;
  const ord = (n) => n == null ? "—" : n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  // a total with its per-game average: "1896.9 (145.9)"
  const tot = (t, g, round) => t == null || isNaN(t) ? "—" : `${round ? Math.round(t).toLocaleString() : f1(t)}${g ? ` <span class="avg">(${f1(t / g)})</span>` : ""}`;
  const NO_EDITS = { names: {}, aliases: {}, v: 2 };
  // Edits saved before Oct 9 2026 stored merges the other way round ("Cory K: same person as C K" meant keep Cory K).
  // Turn those into the current form, where aliases[a] = b means a was merged INTO b.
  function currentEdits(e) {
    if (!e) return NO_EDITS;
    if (e.v === 2 || !Object.keys(e.aliases || {}).length) return { names: e.names || {}, aliases: e.aliases || {}, v: 2 };
    const seasonsOf = {};
    for (const s of S.league?.seasons || []) for (const t of s.teams) seasonsOf[t.key] = (seasonsOf[t.key] || 0) + 1;
    const parent = {}; const find = (k) => { while (parent[k] && parent[k] !== k) k = parent[k]; return k; };
    for (const [a, b] of Object.entries(e.aliases)) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    const groups = {};
    for (const k of new Set([...Object.keys(e.aliases), ...Object.values(e.aliases)])) (groups[find(k)] ||= []).push(k);
    const aliases = {}, names = { ...(e.names || {}) };
    for (const list of Object.values(groups)) {
      // the keeper is an account whose row the merge was picked on (the most seasons if there were several)
      const keep = list.filter((k) => e.aliases[k]).sort((x, y) => (seasonsOf[y] || 0) - (seasonsOf[x] || 0))[0] || list[0];
      for (const k of list) if (k !== keep) { aliases[k] = keep; if (names[k] && !names[keep]) names[keep] = names[k]; delete names[k]; }
    }
    return { names, aliases, v: 2 };
  }
  const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`; };

  const S = {
    league: null,       // { slug, platform, isPrivate, leagueName, seasons, savedAt }
    stats: null,
    tab: "overview",
    prefs: { h2hPlayoffs: true },   // this browser only (old per-browser names/aliases may linger here)
    sort: { key: "avgFinish", asc: true },
    fsort: { key: "medals", asc: false },   // all-time finishes table
    minSeasons: null,                       // Overview slider (null = half the league's finished seasons)
    ptsMode: "game",
    selMgr: null, openOpp: null, selYear: null, selWeek: null,
    dYear: null, dView: "board",                  // Drafts tab
    mvYear: "all", mvMgr: "", mvAll: false,       // Trades & Waivers tab
    movesBusy: false,                             // fetching older seasons' drafts and moves
    espnCreds: {},      // this visit only, unless "remember" is ticked (then this browser only)
    pendingEspn: null,
    showShare: false,
    busy: false,
  };
  const TABS = [["overview", "Overview"], ["standings", "All-Time Standings"], ["teams", "Teams"], ["h2h", "Head-to-Head"], ["records", "Record Book"], ["seasons", "Seasons"]];
  const MOVE_TABS = [["drafts", "Drafts"], ["moves", "Trades & Waivers"]];

  /* ---------------- small UI helpers ---------------- */
  let toastT;
  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3600);
  }
  function openDlg(html) {
    $("dlgBody").innerHTML = `<button class="btn ghost small close" data-act="closeDlg" aria-label="Close">✕</button>${html}`;
    if (!$("dlg").open) $("dlg").showModal();
  }
  const closeDlg = () => $("dlg").open && $("dlg").close();
  const setErr = (msg, id = "formErr") => { const el = $(id); if (el) el.textContent = msg || ""; };
  const name = (k) => S.stats?.managerByKey[k]?.name ?? "Unknown";
  const shortName = (k) => { const n = name(k); const p = n.split(/\s+/); return p.length > 1 && n.length > 10 ? `${p[0]} ${p[1][0]}.` : n; };
  const leagueKey = (L) => L.slug;
  const shareUrl = (L) => location.origin + location.pathname + "#" + L.slug;

  /* ---------------- routing ---------------- */
  const SLUG_RE = /^[A-Za-z0-9]{8,16}$/;
  function readHash() {
    const raw = location.hash.slice(1);
    const h = new URLSearchParams(raw);
    if (h.get("espnlink")) {
      try {
        const b = h.get("espnlink").replace(/-/g, "+").replace(/_/g, "/");
        const p = JSON.parse(atob(b + "===".slice((b.length + 3) % 4)));
        S.pendingEspn = { league: String(p.l || ""), s2: p.s || "", sw: p.w || "" };
      } catch { S.pendingEspn = { bad: true }; }
      history.replaceState(null, "", location.pathname);   // wipe cookies from the address bar
      return { landing: true };
    }
    if (raw === "demo") return { demo: true };
    if (SLUG_RE.test(raw)) return { slug: raw };
    return { landing: true };
  }
  function setHash(L) {
    const h = "#" + L.slug;
    if (location.hash !== h) history.replaceState(null, "", location.pathname + h);
  }

  async function boot() {
    if (CFG.BMC_URL) $("bmc").href = CFG.BMC_URL;
    const r = readHash();
    if (r.demo || window.FLH_PREVIEW) return openLeague(FLHDemo.demoLeague());
    if (r.slug) return openSlug(r.slug);
    renderLanding();
  }
  window.addEventListener("hashchange", () => {
    const r = readHash();
    if (r.slug && r.slug !== S.league?.slug) return openSlug(r.slug);
    if (r.demo && S.league?.slug !== "demo") return openLeague(FLHDemo.demoLeague());
    if (r.landing && !S.pendingEspn && S.league) { S.league = null; renderLanding(); }
    if (S.pendingEspn) renderLanding();
  });

  /* ---------------- server ---------------- */
  async function api(action, payload = {}) {
    if (!CFG.SUPABASE_URL) throw new Error("The site isn't connected to its server yet (config.js).");
    let res;
    try {
      res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/league-history`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(CFG.SUPABASE_ANON_KEY ? { apikey: CFG.SUPABASE_ANON_KEY } : {}) },
        body: JSON.stringify({ action, ...payload }),
      });
    } catch { throw new Error("Couldn't reach the server. Check your connection and try again."); }
    let body = null; try { body = await res.json(); } catch { /* not json */ }
    if (!res.ok) { const e = new Error(body?.error || `Server error (${res.status})`); e.private = !!body?.private; throw e; }
    return body;
  }
  const fromServer = (r) => ({ slug: r.slug, platform: r.platform, isPrivate: !!r.isPrivate, leagueName: r.leagueName, seasons: r.seasons, savedAt: Date.parse(r.updatedAt) || Date.now(), edits: r.edits || NO_EDITS, movesPending: r.movesPending || 0 });
  const sameEdits = (a, b) => JSON.stringify(a?.edits || NO_EDITS) === JSON.stringify(b?.edits || NO_EDITS);

  /* ---------------- loading ---------------- */
  function showLoading(msg) {
    $("tabs").innerHTML = ""; $("hdrActions").innerHTML = "";
    $("main").innerHTML = `<div class="loading"><div class="spin" aria-hidden="true"></div><div id="loadMsg">${esc(msg)}</div></div>`;
  }
  const savedCreds = (slug) => S.espnCreds[slug] || store.get(`flha:espncreds:${slug}`);
  function keepCreds(slug, creds, remember) {
    if (!creds?.espn_s2) return;
    S.espnCreds[slug] = creds;
    if (remember) store.set(`flha:espncreds:${slug}`, creds);
  }

  // A local copy makes repeat visits instant; the server copy is the real one.
  function saveLocal(L) {
    if (L.slug === "demo") return;
    store.set(`flha:L:${L.slug}`, L);
    try { navigator.storage?.persist?.(); } catch { /* best effort */ }
    const recent = store.get("flha:recent", []).filter((r) => r.slug !== L.slug);
    recent.unshift({ slug: L.slug, platform: L.platform, name: L.leagueName, at: Date.now() });
    store.set("flha:recent", recent.slice(0, 8));
  }
  // Swap in newer data without losing the reader's place
  function replaceLeague(L) {
    saveLocal(L);
    if (S.league?.slug !== L.slug) return;
    S.league = L; recompute(); render();
  }

  async function openSlug(slug) {
    const local = store.get(`flha:L:${slug}`);
    if (local) openLeague(local); else showLoading("Loading league…");
    try {
      const L = fromServer(await api("open", { slug }));
      if (!local) { saveLocal(L); openLeague(L); }
      else if (L.savedAt !== local.savedAt || !sameEdits(L, local) || L.movesPending !== local.movesPending) replaceLeague(L);
      fetchMoves();
    } catch (e) {
      if (!local) renderLanding({ notice: e.message });
    }
  }

  // Load (or find) a league by its platform ID. Saves it on the server and opens its share link.
  async function loadLeague(platform, league, creds, opts = {}) {
    showLoading(platform === "espn" ? "Loading every season from ESPN… (big leagues take 10–20 seconds)" : "Loading every season from Sleeper…");
    try {
      const L = fromServer(await api("load", { platform, league, ...(creds || {}) }));
      keepCreds(L.slug, creds, opts.remember);
      saveLocal(L); S.showShare = true; openLeague(L); fetchMoves();
    } catch (e) {
      if (platform === "sleeper") return renderLanding({ sleeperErr: e.message, sleeperVal: league });
      renderLanding({ espnErr: e.message, espnVal: league, espnPrivate: e.private, espnHadCreds: !!creds?.espn_s2, s2: creds?.espn_s2, sw: creds?.swid });
    }
  }

  // Refresh button / "Update this season"
  async function refreshLeague(creds, remember) {
    const L = S.league; if (!L || S.busy) return;
    const cr = creds || savedCreds(L.slug);
    S.busy = true; render();
    try {
      const r = await api("refresh", { slug: L.slug, ...(cr || {}) });
      if (r.needLogin) { S.busy = false; render(); return askEspnLogin(); }
      keepCreds(L.slug, creds, remember);
      S.busy = false; replaceLeague(fromServer(r)); toast("Up to date"); fetchMoves();
    } catch (e) {
      S.busy = false; render();
      if (e.private) return askEspnLogin(e.message);
      toast(`Couldn't update: ${e.message}`);
    }
  }
  function commishRefreshMsg(L) {
    return `Can you update our league history page with the latest games? ${shareUrl(L)}\n\n`
      + `On a computer: open fantasy.espn.com and our league, then click your "Load League History" bookmark and tap Load history. That's it.\n\n`
      + `(If you'd rather it update on its own, make the league viewable to the public on ESPN's website: LM Tools → Basic Settings → Edit → Make League Viewable to Public → Yes → Save.)`;
  }
  function askEspnLogin(msg) {
    const expired = msg && /accept/.test(msg);
    openDlg(`<h3>Update this season</h3>
      <p class="sub">This is a private ESPN league, so ESPN only sends the newest games to someone signed in to the league${expired ? " (the login used last time has expired)" : ""}. Anyone in the league can do it, and the update shows up for everyone with the link.</p>

      <details class="howto" open><summary><b>Option A (easiest):</b> ask your commissioner to update it</summary>
        <p>Sends them a ready-made message with this page's link and the one step to do. Once they've done it, everyone sees the new games.</p>
        <div class="actions"><button class="btn small" data-act="askCommishRefresh">${navigator.share ? "Send your commissioner a message" : "Copy a message for your commissioner"}</button></div>
      </details>

      <details class="howto" open><summary><b>Option B:</b> do it yourself with the ESPN bookmark (computer)</summary>
        <p>Already have the <b>Load League History</b> bookmark? Open your league on fantasy.espn.com, click it, and tap <b>Load history</b>.</p>
        <p>Don't have it yet? It takes about a minute to set up. <button class="linkbtn" data-act="setupBookmark">Show me how</button></p>
      </details>

      <details class="howto"><summary><b>Option C:</b> paste your ESPN cookies</summary>
        <p class="sub">The setup page (Option C there) shows where to find them on a computer.</p>
        <label class="f" for="us2">espn_s2</label><input type="text" id="us2" autocomplete="off" autocapitalize="off" spellcheck="false">
        <label class="f" for="usw">SWID</label><input type="text" id="usw" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}">
        <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:.92rem"><input type="checkbox" id="urem"> Remember my ESPN cookies on this device</label>
        <div class="actions"><button class="btn" data-act="espnUpdate">Update</button></div><div class="err" id="formErr"></div>
      </details>`);
  }

  function openLeague(L) {
    S.league = L;
    S.prefs = { h2hPlayoffs: true, ...store.get(`flha:prefs:${leagueKey(L)}`, {}) };
    S.tab = "overview"; S.minSeasons = null; S.selMgr = null; S.openOpp = null; S.selYear = null; S.selWeek = null;
    S.dYear = null; S.mvYear = "all"; S.mvMgr = ""; S.mvAll = false; S.trAll = false;
    recompute(); setHash(L); render();
    window.scrollTo(0, 0);
  }
  function recompute() {
    const ed = currentEdits(S.league.edits);
    S.stats = FLHStats.compute(S.league.seasons, { aliases: ed.aliases, names: ed.names, h2hPlayoffs: S.prefs.h2hPlayoffs });
    S.canon = canonIn(ed.aliases);
  }
  const savePrefs = () => store.set(`flha:prefs:${leagueKey(S.league)}`, S.prefs);

  /* ---------------- landing ---------------- */
  const COMMISH_MSG = "Can you make our ESPN fantasy league viewable to the public? I want to load our league history (all-time standings and head-to-head records) on fantasyleaguehistoryassist.com. On ESPN's website (not the app): open our league, click LM Tools, then Basic Settings, then Edit. Set \"Make League Viewable to Public\" to Yes and click Save. It only lets people with the league link see the league. Nothing else changes.";

  // The ESPN bookmark: runs on fantasy.espn.com, reads the league id + login cookies, and opens this
  // site with them in the #fragment (never sent to any server; the site wipes it on arrival).
  function espnBookmarklet() {
    const app = location.origin + location.pathname;
    return "javascript:(()=>{if(!/(^|\\.)espn\\.com$/.test(location.hostname)){alert('Open your ESPN fantasy league at fantasy.espn.com first, then click this bookmark.');return}"
      + "const g=n=>(document.cookie.match('(?:^|; )'+n+'=([^;]*)')||[])[1];const l=new URLSearchParams(location.search).get('leagueId');const s=g('espn_s2'),w=g('SWID');"
      + "if(!l){alert('Open your league first (the address should contain leagueId=), then click again.');return}"
      + "if(!s||!w){alert('Sign in to ESPN first, then click again.');return}"
      + "const d=btoa(JSON.stringify({l:l,s:s,w:w})).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');"
      + `window.open('${app}#espnlink='+d,'_blank')})()`;
  }

  function espnPrivateHtml(o) {
    const fromBm = !!o.fromBookmark;
    return `<div id="privBox" ${o.espnPrivate || fromBm || o.showPriv ? "" : "hidden"}>
      <div class="stepnum">Step 2 · Private league: pick one</div>
      ${o.espnPrivate && !o.espnHadCreds ? `<p class="warnbox">This league is private, so ESPN won't share its history without permission.</p>` : ""}
      ${fromBm ? "" : `<details class="howto" open><summary><b>Option A (easiest):</b> ask your commissioner to make the league public</summary>
        <p>It takes them about 30 seconds on ESPN's website: <b>LM Tools → Basic Settings → Edit → Make League Viewable to Public → Yes → Save</b>. The league becomes viewable to anyone with the league link. Nothing else about the league changes.</p>
        <div class="actions"><button class="btn small" data-act="askCommish">Send your commissioner the steps</button></div>
        <p class="sub">Once they've done it, come back and tap <b>Load history</b> with just the address. No cookies needed, and anyone in the league can open the link you share.</p></details>
      <details class="howto" open><summary><b>Option B (easiest on a computer):</b> the one-click ESPN bookmark</summary>
        <ol>
          <li>On a computer, in Chrome or Edge, press <b>Ctrl + Shift + B</b> (Mac: <b>Cmd + Shift + B</b>) to show the bookmarks bar.</li>
          <li>Drag this button onto the bookmarks bar: <a class="btn small" style="text-decoration:none;display:inline-block;cursor:grab" href="${esc(espnBookmarklet())}" data-act="bmHelp">Load League History</a></li>
          <li>Go to <b>fantasy.espn.com</b>, sign in, and open your league.</li>
          <li>Click <b>Load League History</b> on the bookmarks bar. This site opens with everything filled in. Tap <b>Load history</b>.</li>
        </ol>
        <p class="sub">Can't drag it? Right-click the bookmarks bar, choose <b>Add page</b>, name it <b>Load League History</b>, and paste this as the URL: <button class="linkbtn" data-act="bmCopy">copy bookmark code</button></p></details>`}
      <details class="howto" ${fromBm ? "" : ""}><summary><b>${fromBm ? "Or copy them by hand" : "Option C:"}</b>${fromBm ? "" : " copy two ESPN cookies yourself (about 2 minutes, needs a computer)"}</summary><ol>
        <li>On a computer, open <b>Chrome</b>, go to <b>fantasy.espn.com</b>, and make sure you're signed in.</li>
        <li>Press <b>F12</b> (Mac: <b>Cmd + Option + I</b>). A developer panel opens.</li>
        <li>At the top of that panel, click <b>Application</b>. If you don't see it, click the <b>»</b> arrows first.</li>
        <li>In its left sidebar under <b>Storage</b>, expand <b>Cookies</b> and click <b>https://fantasy.espn.com</b>.</li>
        <li>In the <b>Filter</b> box type <b>espn_s2</b>. Click that row; its full value appears at the bottom. Copy all of it into <b>espn_s2</b> below.</li>
        <li>Change the filter to <b>SWID</b> and copy that value, curly braces included, into <b>SWID</b> below.</li></ol>
        <p class="sub">To get them onto your phone, email or text them to yourself. They work like a login to your ESPN fantasy account, so don't post them in screenshots. This site sends them to ESPN only to read your league, and never saves them on a server.</p></details>
      <label class="f" for="es2">espn_s2</label><input type="text" id="es2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="AEB…  (long)" value="${esc(o.s2 || "")}">
      <label class="f" for="esw">SWID</label><input type="text" id="esw" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" value="${esc(o.sw || "")}">
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:.92rem"><input type="checkbox" id="erem"> Remember my ESPN cookies on this device (so updating later is one tap)</label>
    </div>`;
  }

  function renderLanding(o = {}) {
    S.league = null;
    $("tabs").innerHTML = ""; $("hdrActions").innerHTML = "";
    if (location.hash) history.replaceState(null, "", location.pathname);
    const p = S.pendingEspn; S.pendingEspn = null;
    if (p && !p.bad) Object.assign(o, { espnVal: p.league, s2: p.s2, sw: p.sw, fromBookmark: true });
    const recent = store.get("flha:recent", []).filter((r) => r.slug);
    $("main").innerHTML = `
      ${o.notice ? `<p class="warnbox" style="margin-top:16px">${esc(o.notice)}</p>` : ""}
      <section class="hero">
        <h2>Your league's whole history, in one place.</h2>
        <p>All-time standings, average finish, points for and against, championships, and who you beat most (and who owns you), back to the season your league started. Free for Sleeper and ESPN leagues, including private ESPN leagues.</p>
      </section>

      ${p?.bad ? `<p class="warnbox">The ESPN bookmark didn't send a complete login. Open your league on fantasy.espn.com while signed in, then click the bookmark again.</p>` : ""}

      <div class="connect">
        <div class="panel">
          <div class="plat"><span class="dot sl">S</span><h3 style="margin:0">Sleeper</h3></div>
          <p class="sub">Enter your Sleeper username to pick a league, or paste a league ID. Previous seasons are found automatically.</p>
          <label class="f" for="slu">Sleeper username or league ID</label>
          <div class="row-in"><input type="text" id="slu" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(o.sleeperVal || "")}" placeholder="e.g. jrkline">
          <button class="btn" data-act="sleeperGo">Find</button></div>
          <div id="sleeperOut"></div>
          <div class="err" id="sleeperErr">${esc(o.sleeperErr || "")}</div>
        </div>

        <div class="panel">
          <div class="plat"><span class="dot es">E</span><h3 style="margin:0">ESPN</h3></div>
          ${o.bookmarkOnly ? `<p class="tipbox"><b>To update your league:</b> add the bookmark with Option B below. Then open your league on fantasy.espn.com, click the bookmark, and tap <b>Load history</b>. It updates the same page and link your league already uses.</p>` : ""}
          ${o.fromBookmark ? `<p class="tipbox"><b>Filled in from ESPN.</b> Your league and ESPN login came from the bookmark. Tap <b>Load history</b> to finish.</p>`
            : `<p class="sub">Most leagues take one step: paste the league's address and tap <b>Load history</b>. If your league is private, the site will say so and show you how to finish.</p>`}
          <div class="stepnum">Step 1 · Your league's address</div>
          <label class="f" for="elg">League URL</label>
          <input type="text" id="elg" placeholder="https://fantasy.espn.com/football/league?leagueId=…" value="${esc(o.espnVal || "")}" autocomplete="off" autocapitalize="off" spellcheck="false">
          ${o.fromBookmark ? "" : `<details class="howto"><summary>Where do I find it?</summary>
            <p><b>On a phone</b> (the ESPN app doesn't show it):</p><ol>
            <li>Open <b>Safari</b> or <b>Chrome</b> and go to <b>fantasy.espn.com</b>. If it offers to open the ESPN app, stay in the browser.</li>
            <li>Sign in and tap your league so you see your team or the standings.</li>
            <li>Tap the address bar and copy the whole address. It contains <b>leagueId=</b> followed by numbers.</li>
            <li>Come back here and paste it above.</li></ol>
            <p><b>On a computer:</b> open your league at <b>fantasy.espn.com</b>, copy the address bar, and paste it.</p>
            <p class="sub">Just the leagueId number works too.</p></details>`}
          ${espnPrivateHtml(o)}
          <div class="actions"><button class="btn" data-act="espnGo">Load history</button>
            ${o.espnPrivate || o.fromBookmark || o.showPriv ? "" : `<button class="btn ghost small" data-act="espnPrivate" id="privBtn">My league is private</button>`}</div>
          <div class="err" id="espnErr">${esc(o.espnErr && !(o.espnPrivate && !o.espnHadCreds) ? o.espnErr : "")}</div>
        </div>
      </div>

      <p style="margin-top:16px">Just looking? <button class="linkbtn" data-act="demo">Open a demo league</button> to see every screen.</p>

      ${recent.length ? `<h2>Your recent leagues</h2><div class="panel pad list">${recent.map((r) => `<div class="item"><span><b>${esc(r.name)}</b> <span class="tag">${r.platform === "espn" ? "ESPN" : "Sleeper"}</span><br><span class="sub">Opened ${ago(r.at)}</span></span><button class="btn small" data-act="openRecent" data-slug="${esc(r.slug)}">Open</button></div>`).join("")}</div>` : ""}

      <div class="features">
        <div><b>All-time standings</b>Record, average finish, titles, playoff trips, and points for and against per game and per season.</div>
        <div><b>Rivalries</b>Who you've beaten the most, who you've lost to the most, and every game between any two managers.</div>
        <div><b>Luck, measured</b>All-play record shows how you'd do playing everyone every week. The gap is your luck.</div>
        <div><b>Record book</b>Highest and lowest scores, biggest blowouts, closest games, and the longest streaks.</div>
      </div>`;
  }

  /* ---------------- league views ---------------- */
  function render() {
    if (!S.league) return renderLanding();
    const tabs = hasMoveData() || S.league.movesPending ? [...TABS, ...MOVE_TABS] : TABS;
    if (!tabs.some(([k]) => k === S.tab)) S.tab = "overview";
    $("tabs").innerHTML = tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.tab === k}" data-act="tab" data-tab="${k}">${l}</button>`).join("");
    $("hdrActions").innerHTML = `
      ${S.league.platform !== "demo" ? `<button class="btn small" data-act="share" title="Share this league's link"><span>Share</span> 🔗</button>` : ""}
      <button class="btn ghost small" data-act="managers" title="Rename or merge managers"><span>Managers</span> ✎</button>
      <button class="btn ghost small" data-act="switch" title="Open another league"><span>Switch</span> ⇄</button>`;
    const v = { overview: vOverview, standings: vStandings, teams: vTeams, h2h: vH2H, records: vRecords, seasons: vSeasons, drafts: vDrafts, moves: vMoves }[S.tab];
    $("main").innerHTML = head() + v();
  }

  function head() {
    const L = S.league, st = S.stats;
    const yrs = st.years;
    const live = L.seasons.find((s) => !s.complete);
    return `<div class="lghead"><div><h2>${esc(L.leagueName)}</h2>
      <div class="sub" style="margin:2px 0 0">${yrs[0]}–${yrs[yrs.length - 1]} · ${yrs.length} season${yrs.length === 1 ? "" : "s"} · ${L.platform === "espn" ? "ESPN" : L.platform === "sleeper" ? "Sleeper" : "Demo"}
      ${L.platform === "demo" ? "" : S.busy ? ` · <span class="muted">updating…</span>` : ` · updated ${ago(L.savedAt)}${L.isPrivate ? " · private ESPN league" : ""} · <button class="linkbtn" data-act="refresh">${L.isPrivate ? "Update this season" : "Refresh"}</button>`}</div></div></div>
      ${S.showShare && L.platform !== "demo" ? `<div class="sharebox"><div><b>Saved.</b> Send this link to your league. It opens right to this page on any phone or computer${L.isPrivate ? ", no ESPN login needed" : ""}.
        <div class="shareurl"><input type="text" id="shareUrl" readonly value="${esc(shareUrl(L))}" aria-label="Share link"><button class="btn small" data-act="share">${navigator.share ? "Share" : "Copy link"}</button></div></div>
        <button class="btn ghost small" data-act="hideShare" aria-label="Dismiss">✕</button></div>` : ""}
      ${live && !["records", "drafts"].includes(S.tab) ? `<p class="tipbox">The ${live.year} season is in progress. Its finished games count toward records, points, and head-to-head, but not toward finishes or titles until it's over.</p>` : ""}`;
  }

  function vOverview() {
    const st = S.stats, M = st.managers;
    const done = st.seasons.filter((s) => s.complete);
    const games = st.seasons.reduce((a, s) => a + s.rows.reduce((b, r) => b + r.g, 0) / 2, 0);
    const champs = new Set(done.map((s) => s.champion).filter(Boolean));
    const best = (arr, f, dir = -1) => [...arr].filter((m) => f(m) != null).sort((a, b) => dir * (f(a) - f(b)))[0];
    const maxS = Math.max(1, ...M.map((m) => m.completeSeasons));
    const defS = Math.min(maxS, Math.max(1, Math.ceil(done.length / 2)));   // default: at least half the finished seasons
    const minS = Math.min(maxS, Math.max(1, S.minSeasons ?? defS));
    const eligible = M.filter((m) => m.completeSeasons >= minS);
    const cards = [
      ["Most titles", best(eligible, (m) => m.titles || null), (m) => `${m.titles} title${m.titles === 1 ? "" : "s"} (${m.titleYears.join(", ")})`, true],
      ["Best average finish", best(eligible, (m) => m.avgFinish, 1), (m) => `${f2(m.avgFinish)} over ${m.finishes.length} seasons`],
      ["Most points per game", best(eligible, (m) => m.pfPerGame), (m) => `${f1(m.pfPerGame)} per game`],
      ["Best all-time record", best(eligible, (m) => m.winPct), (m) => `${rec(m.w, m.l, m.t)} (${pct(m.winPct)})`],
      ["Unluckiest manager", best(eligible, (m) => m.luck, 1), (m) => `Win% is ${(Math.abs(m.luck) * 100).toFixed(1)} pts below their all-play %`],
      ["Luckiest manager", best(eligible, (m) => m.luck), (m) => `Win% is ${(m.luck * 100).toFixed(1)} pts above their all-play %`],
      ["Most points allowed", best(eligible, (m) => m.paPerGame), (m) => `${f1(m.paPerGame)} per game against`],
      ["Most last-place finishes", best(eligible, (m) => m.lasts || null), (m) => `${m.lasts} time${m.lasts === 1 ? "" : "s"}`],
    ].filter((c) => c[1]);
    const top = (s, f) => [...s.rows].sort((a, b) => f(b) - f(a))[0];
    return `
      <div class="kpis">
        <div class="kpi"><div class="v num">${st.years.length}</div><div class="l">Seasons</div></div>
        <div class="kpi"><div class="v num">${M.length}</div><div class="l">Managers</div></div>
        <div class="kpi"><div class="v num">${Math.round(games).toLocaleString()}</div><div class="l">Regular-season games</div></div>
        <div class="kpi"><div class="v num">${champs.size}</div><div class="l">Different champions</div></div>
      </div>
      <h2>Trophy room</h2>
      <p class="sub" style="margin-top:-4px">Tap a manager to see that team's roster, draft and moves. Tap a year for the whole season.</p>
      <div class="scroll"><table>
        <thead><tr><th class="l">Year</th><th class="l">Champion</th><th class="l">Runner-up</th><th class="l">Best regular season</th><th class="l">Most points</th></tr></thead>
        <tbody>${[...st.seasons].reverse().map((s) => {
          const t = (k) => s.rows.find((r) => r.key === k);
          const reg1 = s.rows.find((r) => r.regRank === 1); const pts = top(s, (r) => r.pf);
          const cellM = (r, extra = "") => r ? `<td class="l mgr" data-act="teamSeason" data-year="${s.year}" data-k="${esc(r.key)}">${esc(name(r.key))}<span class="tn">${esc(r.teamName)}${extra}</span></td>` : `<td class="l muted">—</td>`;
          return `<tr class="clickable" data-act="gotoSeason" data-year="${s.year}"><td class="l"><b>${s.year}</b></td>
            ${s.complete ? cellM(t(s.champion), "").replace('class="l mgr"', 'class="l mgr trophy"') : `<td class="l muted">In progress</td>`}
            ${s.complete ? cellM(t(s.runnerUp)) : `<td class="l muted">—</td>`}
            ${cellM(reg1, reg1 ? ` · ${rec(reg1.w, reg1.l, reg1.t)}` : "")}
            ${cellM(pts, pts ? ` · ${f1(pts.pf)} (${f1(pts.g ? pts.pf / pts.g : null)}/g)` : "")}</tr>`;
        }).join("")}</tbody></table></div>
      <div class="slider panel pad">
        <label for="minSeasons"><b>Who counts below:</b> managers with at least <b id="minSeasonsN">${minS}</b> finished season<span id="minSeasonsS">${minS === 1 ? "" : "s"}</span> · <span id="minSeasonsC">${eligible.length} of ${M.length} managers</span></label>
        <input type="range" id="minSeasons" min="1" max="${maxS}" step="1" value="${minS}" aria-describedby="minSeasonsHelp">
        <div class="ends" id="minSeasonsHelp"><span>Everyone who ever played</span><span>Only the longest-tenured (${maxS} seasons)</span></div>
      </div>
      <h2>League superlatives</h2>
      <div class="cards">${cards.map(([k, m, d, gold]) => `<div class="card${gold ? " gold" : ""}"><div class="k">${k}</div><div class="who">${esc(m.name)}</div><div class="d">${esc(d(m))}</div></div>`).join("")}</div>
      ${vFinishes(eligible, done)}`;
  }

  // All-time finishes: how often each manager finished 1st, 2nd, 3rd... and a strip of every season's finish
  function vFinishes(list, done) {
    const years = done.map((s) => s.year);
    const rows = list.map((m) => {
      const fin = m.finishes, n = (r) => fin.filter((f) => f.rank === r).length;
      const by = Object.fromEntries((m.lines || []).filter((l) => l.complete).map((l) => [l.year, l]));
      return { m, firsts: n(1), seconds: n(2), thirds: n(3), top3: fin.filter((f) => f.rank <= 3).length, played: fin.length,
        playoffs: m.playoffs, lasts: m.lasts, avg: m.avgFinish, by };
    });
    const { key, asc } = S.fsort, dir = asc ? 1 : -1;
    const medals = (a, b) => b.firsts - a.firsts || b.seconds - a.seconds || b.thirds - a.thirds || (a.avg ?? 99) - (b.avg ?? 99);
    const val = { name: (r) => r.m.name.toLowerCase(), firsts: (r) => r.firsts, seconds: (r) => r.seconds, thirds: (r) => r.thirds,
      top3: (r) => r.played ? r.top3 / r.played : 0, playoffs: (r) => r.played ? r.playoffs / r.played : 0, lasts: (r) => r.lasts, avg: (r) => r.avg ?? 99 }[key];
    rows.sort((a, b) => key === "medals" ? medals(a, b) * (asc ? -1 : 1) : ((val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir || medals(a, b)));
    const th = (k, label, cls = "") => `<th class="sort ${cls} ${key === k ? "sorted" + (asc ? " asc" : "") : ""}" data-act="fsort" data-k="${k}">${label}</th>`;
    const pctTxt = (a, b) => b ? `${a} <span class="avg">(${Math.round((a / b) * 100)}%)</span>` : "—";
    const box = (r, y) => {
      const l = r.by[y];
      if (!l || !l.finalRank) return `<span class="fbox none" title="${y}: not in the league">·</span>`;
      const k = l.finalRank === 1 ? "c1" : l.finalRank <= 3 ? "c3" : l.playoffs ? "cp" : l.finalRank === l.teamCount ? "cl" : "";
      return `<span class="fbox ${k}" title="${y}: ${ord(l.finalRank)} of ${l.teamCount}${l.playoffs ? " (made playoffs)" : ""}">${l.finalRank}</span>`;
    };
    return `<h2>All-time finishes</h2>
      <p class="sub" style="margin-top:-4px">Ranked by titles, then 2nd-place finishes, then 3rd (tap a column to sort another way). Finished seasons only. The strip shows every season's final place, oldest to newest.</p>
      <div class="scroll"><table class="compact">
        <thead><tr>${th("name", "Manager", "l")}${th("firsts", "🏆 1st")}${th("seconds", "2nd")}${th("thirds", "3rd")}${th("top3", "Top 3")}${th("playoffs", "Playoffs")}${th("lasts", "Last")}${th("avg", "Avg<br>finish")}<th class="l">Finish each season<br><span class="avg">${years[0] ?? ""}–${years[years.length - 1] ?? ""}</span></th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="clickable" data-act="gotoRival" data-k="${esc(r.m.key)}">
          <td class="l mgr">${esc(r.m.name)}<span class="tn">${r.played} finished season${r.played === 1 ? "" : "s"}</span></td>
          <td class="num ${r.firsts ? "trophy" : "muted"}">${r.firsts}</td><td class="num ${r.seconds ? "" : "muted"}">${r.seconds}</td><td class="num ${r.thirds ? "" : "muted"}">${r.thirds}</td>
          <td class="num">${pctTxt(r.top3, r.played)}</td><td class="num">${pctTxt(r.playoffs, r.played)}</td><td class="num ${r.lasts ? "" : "muted"}">${r.lasts}</td>
          <td class="num"><b>${f2(r.avg)}</b></td><td class="l"><span class="fstrip">${years.map((y) => box(r, y)).join("")}</span></td></tr>`).join("")}</tbody></table></div>
      <p class="sub" style="margin-top:8px">Strip key: <span class="fbox c1">1</span> champion · <span class="fbox c3">2</span> 2nd or 3rd · <span class="fbox cp">5</span> made playoffs · <span class="fbox">8</span> missed playoffs · <span class="fbox cl">12</span> last place · <span class="fbox none">·</span> not in the league. Hover or tap-and-hold a box for the year.</p>`;
  }

  function vStandings() {
    const st = S.stats; const pm = S.ptsMode;
    const P = {
      game: [["pfPerGame", "PF /<br>game"], ["paPerGame", "PA /<br>game"]],
      season: [["pfPerSeason", "PF /<br>season"], ["paPerSeason", "PA /<br>season"]],
      total: [["pf", "PF total<br><span class=\"avg\">(per game)</span>"], ["pa", "PA total<br><span class=\"avg\">(per game)</span>"]],
    }[pm];
    const cols = [
      ["name", "Manager", "l", (m) => `<td class="l mgr">${esc(m.name)}<span class="tn">${m.seasons.length} season${m.seasons.length === 1 ? "" : "s"} · ${m.seasons[0]}–${m.seasons[m.seasons.length - 1]}</span></td>`],
      ["winPct", "W-L-T", "", (m) => `<td class="num">${rec(m.w, m.l, m.t)}</td>`],
      ["winPct", "Win %", "", (m) => `<td class="num">${pct(m.winPct)}</td>`],
      ["avgFinish", "Avg<br>finish", "", (m) => `<td class="num"><b>${f2(m.avgFinish)}</b></td>`],
      ["avgRegFinish", "Avg reg.<br>season", "", (m) => `<td class="num">${f2(m.avgRegFinish)}</td>`],
      ["bestFinish", "Best", "", (m) => `<td class="num">${ord(m.bestFinish)}</td>`],
      ["titles", "Titles", "", (m) => `<td class="num ${m.titles ? "trophy" : "muted"}">${m.titles ? "🏆 " + m.titles : "0"}</td>`],
      ["playoffs", "Play-<br>offs", "", (m) => `<td class="num">${m.playoffs}/${m.completeSeasons}</td>`],
      [P[0][0], P[0][1], "", (m) => `<td class="num">${pm === "total" ? tot(m.pf, m.games, true) : f1(m[P[0][0]])}</td>`],
      [P[1][0], P[1][1], "", (m) => `<td class="num">${pm === "total" ? tot(m.pa, m.games, true) : f1(m[P[1][0]])}</td>`],
      ["highScore", "High<br>game", "", (m) => `<td class="num" title="${m.highGame ? esc(when(m.highGame)) : ""}">${f1(m.highGame?.my)}</td>`],
      ["lowScore", "Low<br>game", "", (m) => `<td class="num" title="${m.lowGame ? esc(when(m.lowGame)) : ""}">${f1(m.lowGame?.my)}</td>`],
      ["allPlayPct", "All-<br>play %", "", (m) => `<td class="num">${pct(m.allPlayPct)}</td>`],
      ["luck", "Luck", "", (m) => `<td class="num">${signPct(m.luck)}</td>`],
      ["pw", "Playoff<br>W-L", "", (m) => `<td class="num">${rec(m.pw, m.pl)}</td>`],
    ];
    const { key, asc } = S.sort;
    const val = (m) => key === "name" ? m.name.toLowerCase() : key === "highScore" ? m.highGame?.my : key === "lowScore" ? m.lowGame?.my : m[key];
    const list = [...st.managers].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
    });
    return `<div class="toolbar"><p class="sub" style="margin:0">Tap a column to sort. Points are regular season only.</p>
      <div class="seg" role="group" aria-label="Points shown">${[["game", "Per game"], ["season", "Per season"], ["total", "Totals"]].map(([k, l]) => `<button aria-pressed="${pm === k}" data-act="ptsMode" data-m="${k}">${l}</button>`).join("")}</div></div>
      <div class="scroll"><table class="compact">
      <thead><tr>${cols.map(([k, l, c], i) => `<th class="sort ${c} ${k === key && !(i === 1) ? "sorted" + (asc ? " asc" : "") : ""}" data-act="sort" data-k="${k}">${l}</th>`).join("")}</tr></thead>
      <tbody>${list.map((m) => `<tr class="clickable" data-act="gotoRival" data-k="${esc(m.key)}">${cols.map((c) => c[3](m)).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="sub" style="margin-top:10px"><b>Avg finish</b> is the final standing after playoffs, finished seasons only. <b>All-play %</b> is your record if you'd played every team every week. <b>Luck</b> is your real win % minus your all-play % (positive means your schedule helped you). Tap a manager to open their team page.</p>`;
  }

  function gameLine(g, me) {
    const mine = g.a === me ? g.as : g.bs, their = g.a === me ? g.bs : g.as;
    const res = mine > their ? `<span class="pos">W</span>` : mine < their ? `<span class="neg">L</span>` : "T";
    return `<tr><td class="l">${g.year}</td><td class="l">${g.kind === "playoff" ? `<span class="tag">Playoffs</span>` : `Week ${g.week}`}</td><td>${res}</td><td class="num">${f2(mine)} – ${f2(their)}</td></tr>`;
  }

  function gameChip(g, me) {
    const mine = g.a === me ? g.as : g.bs, their = g.a === me ? g.bs : g.as;
    const r = mine > their ? `<b class="pos">W</b>` : mine < their ? `<b class="neg">L</b>` : "<b>T</b>";
    return `<span>${r} <span class="num">${f1(mine)}–${f1(their)}</span> <span class="muted">${g.year} ${g.kind === "playoff" ? "playoffs" : "wk " + g.week}</span></span>`;
  }

  const when = (g) => `${g.year} ${g.kind === "playoff" ? "playoffs" : g.kind === "cons" ? "consolation" : "wk " + g.week}`;
  const card = (k, who, d, cls = "") => `<div class="card ${cls}"><div class="k">${k}</div><div class="who">${who}</div><div class="d">${d}</div></div>`;

  function vTeams() {
    const st = S.stats;
    const list = [...st.managers].sort((a, b) => a.name.localeCompare(b.name));
    if (!S.selMgr || !st.managerByKey[S.selMgr]) S.selMgr = list[0]?.key;
    const m = st.managerByKey[S.selMgr]; if (!m) return "";
    const r = st.rivals(m.key);
    const opp = (x, lab, d) => x ? card(lab, esc(name(x.op)), d(x)) : "";
    const gameCard = (lab, g, cls) => g ? card(lab, `<span class="num">${f2(g.my)}</span>`, `${when(g)} vs ${esc(name(g.op))} (${g.my > g.their ? "W" : g.my < g.their ? "L" : "T"} ${f1(g.my)}–${f1(g.their)})`, cls) : "";
    const marginCard = (lab, g) => g ? card(lab, `<span class="num">${f2(Math.abs(g.my - g.their))}</span>`, `${f1(g.my)}–${f1(g.their)} vs ${esc(name(g.op))}, ${when(g)}`) : "";
    const streakCard = (lab, x) => x ? card(lab, `${x.len} game${x.len === 1 ? "" : "s"}`, `${when(x.from)} to ${when(x.to)}`) : "";
    const result = (l) => !l.complete ? `<span class="muted">In progress</span>` : l.champ ? `<span class="trophy">🏆 Champion</span>` : l.runnerUp ? "Runner-up" : l.playoffs ? "Playoffs" : "";
    return `<div class="chips" role="group" aria-label="Pick a team">${list.map((x) => `<button class="chip" aria-pressed="${x.key === m.key}" data-act="selMgr" data-k="${esc(x.key)}">${esc(x.name)}</button>`).join("")}</div>
      <div class="rivalhead"><span class="big">${esc(m.name)}</span>
        <span class="sub" style="margin:0">${m.seasons.length} season${m.seasons.length === 1 ? "" : "s"} · ${m.seasons[0]}–${m.seasons[m.seasons.length - 1]}</span></div>
      <p class="sub">Team names: ${m.teamNames.map(esc).join(" · ")}</p>

      <div class="kpis">
        <div class="kpi ${m.titles ? "gold" : ""}"><div class="v num">${m.titles}</div><div class="l">Championship${m.titles === 1 ? "" : "s"}${m.titles ? ` (${m.titleYears.map((y) => `<button class="linkbtn" data-act="teamSeason" data-year="${y}" data-k="${esc(m.key)}">${y}</button>`).join(", ")})` : ""}</div></div>
        <div class="kpi"><div class="v num">${rec(m.w, m.l, m.t)}</div><div class="l">All-time record · ${pct(m.winPct)}</div></div>
        <div class="kpi"><div class="v num">${Math.round(m.pf).toLocaleString()}</div><div class="l">Points for · ${f1(m.pfPerGame)} / game</div></div>
        <div class="kpi"><div class="v num">${Math.round(m.pa).toLocaleString()}</div><div class="l">Points against · ${f1(m.paPerGame)} / game</div></div>
        <div class="kpi"><div class="v num">${f2(m.avgFinish)}</div><div class="l">Avg finish · best ${ord(m.bestFinish)}, worst ${ord(m.worstFinish)}</div></div>
        <div class="kpi"><div class="v num">${m.playoffs}/${m.completeSeasons}</div><div class="l">Playoff trips · ${rec(m.pw, m.pl)} in playoffs</div></div>
      </div>

      <h2>Personal records</h2>
      <div class="cards">
        ${gameCard("Highest score", m.highGame, "gold")}
        ${gameCard("Lowest score", m.lowGame)}
        ${marginCard("Biggest win", m.bestWin)}
        ${marginCard("Worst loss", m.worstLoss)}
        ${streakCard("Longest winning streak", m.winStreak)}
        ${streakCard("Longest losing streak", m.lossStreak)}
      </div>

      <h2>Rivals</h2>
      <div class="cards">
        ${opp(r.mostBeaten, "Most wins against", (x) => `${x.w} wins (${rec(x.w, x.l, x.t)} overall)`)}
        ${opp(r.mostLostTo, "Most losses to", (x) => `${x.l} losses (${rec(x.w, x.l, x.t)} overall)`)}
        ${opp(r.bestPct, "Best matchup (3+ games)", (x) => `${rec(x.w, x.l, x.t)} · ${pct(x.pct)}`)}
        ${opp(r.worstPct, "Toughest matchup (3+ games)", (x) => `${rec(x.w, x.l, x.t)} · ${pct(x.pct)}`)}
      </div>

      ${teamMovesSection(m)}

      <h2>Season by season</h2>
      <div class="scroll"><table>
        <thead><tr><th class="l">Year</th><th class="l">Team</th><th>Finish</th><th>Reg. season</th><th>W-L-T</th><th>PF <span class="avg">(avg)</span></th><th>PA <span class="avg">(avg)</span></th><th>High</th><th>Low</th><th class="l">Result</th></tr></thead>
        <tbody>${m.lines.map((l) => `<tr class="clickable" data-act="teamSeason" data-year="${l.year}" data-k="${esc(m.key)}"><td class="l"><b>${l.year}</b></td><td class="l">${esc(l.teamName)}</td>
          <td class="num">${l.complete ? `${ord(l.finalRank)} <span class="muted">of ${l.teamCount}</span>` : "—"}</td><td class="num">${ord(l.regRank)}</td><td class="num">${rec(l.w, l.l, l.t)}</td>
          <td class="num">${tot(l.pf, l.g)}</td><td class="num">${tot(l.pa, l.g)}</td><td class="num">${f1(l.high)}</td><td class="num">${f1(l.low)}</td><td class="l">${result(l)}</td></tr>`).join("")}</tbody></table></div>
      <p class="sub" style="margin-top:8px">W-L, PF and PA are regular season. High and low include playoff games. Tap a year for that team's roster, draft and moves.</p>

      <h2>Against every opponent</h2>
      <p class="sub">${S.prefs.h2hPlayoffs ? "Regular season and playoff games." : "Regular season games only."} Tap a row for every game.</p>
      <div class="scroll"><table>
        <thead><tr><th class="l">Opponent</th><th>Games</th><th>W-L-T</th><th>Win %</th><th>Avg for</th><th>Avg against</th><th class="l">Last meeting</th></tr></thead>
        <tbody>${r.list.map((x) => {
          const last = x.games[x.games.length - 1];
          const lm = last ? (() => { const mine = last.a === m.key ? last.as : last.bs, th = last.a === m.key ? last.bs : last.as; return `${mine > th ? "W" : mine < th ? "L" : "T"} ${f1(mine)}–${f1(th)} (${when(last)})`; })() : "—";
          const open = S.openOpp === x.op;
          return `<tr class="clickable" data-act="openOpp" data-k="${esc(x.op)}"><td class="l mgr">${open ? "▾" : "▸"} ${esc(name(x.op))}</td><td class="num">${x.gp}</td><td class="num">${rec(x.w, x.l, x.t)}</td>
            <td class="num ${x.pct > .5 ? "pos" : x.pct < .5 ? "neg" : ""}">${pct(x.pct)}</td><td class="num">${f1(x.pfPg)}</td><td class="num">${f1(x.paPg)}</td><td class="l">${lm}</td></tr>
            ${open ? `<tr><td colspan="7" class="l" style="background:var(--surface2);padding:6px 12px 10px 28px;white-space:normal"><div class="glog">${[...x.games].reverse().map((g) => gameChip(g, m.key)).join("")}</div></td></tr>` : ""}`;
        }).join("")}</tbody></table></div>`;
  }

  function vH2H() {
    const st = S.stats;
    const list = [...st.managers].sort((a, b) => (a.avgFinish ?? 99) - (b.avgFinish ?? 99) || a.name.localeCompare(b.name));
    const bucket = (c) => {
      const gp = c.w + c.l + c.t; if (!gp) return "";
      const p = (c.w + c.t / 2) / gp;
      return p >= .7 ? "hw2" : p > .5 ? "hw1" : p === .5 ? "" : p > .3 ? "hl1" : "hl2";
    };
    return `<div class="toolbar"><p class="sub" style="margin:0">Each cell is the <b>row</b> manager's record against the <b>column</b> manager. Tap a cell for every game.</p>
      <div class="seg" role="group" aria-label="Games counted"><button aria-pressed="${S.prefs.h2hPlayoffs}" data-act="h2hp" data-v="1">Incl. playoffs</button><button aria-pressed="${!S.prefs.h2hPlayoffs}" data-act="h2hp" data-v="0">Regular season</button></div></div>
      <div class="legend"><span><span class="sw hw2"></span>Dominates (70%+)</span><span><span class="sw hw1"></span>Winning</span><span><span class="sw hl1"></span>Losing</span><span><span class="sw hl2"></span>Owned (under 30%)</span></div>
      <div class="scroll"><table class="matrix">
        <thead><tr><th class="l">vs →</th>${list.map((m) => `<th title="${esc(m.name)}">${esc(shortName(m.key))}</th>`).join("")}</tr></thead>
        <tbody>${list.map((a) => `<tr><th title="${esc(a.name)}">${esc(shortName(a.key))}</th>${list.map((b) => {
          if (a.key === b.key) return `<td class="self" aria-label="same manager"></td>`;
          const c = st.h2h[a.key]?.[b.key];
          if (!c || !(c.w + c.l + c.t)) return `<td class="muted">—</td>`;
          return `<td class="cellbtn ${bucket(c)}" data-act="cell" data-a="${esc(a.key)}" data-b="${esc(b.key)}" title="${esc(a.name)} vs ${esc(b.name)}">${rec(c.w, c.l, c.t)}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function vRecords() {
    const R = S.stats.records;
    const panel = (title, head, rows) => `<div class="panel"><h3>${title}</h3><div style="overflow-x:auto"><table><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td class="l muted" colspan="5">Not enough games yet</td></tr>`}</tbody></table></div></div>`;
    const wk = (g) => `${g.year} ${g.kind === "playoff" ? "playoffs" : "wk " + g.week}`;
    const five = (a) => a.slice(0, 5);
    return `<div class="recgrid">
      ${panel("Highest single-game scores", `<th class="l">Manager</th><th>Points</th><th class="l">When</th><th class="l">Opponent</th>`,
        five(R.highScores).map((x) => `<tr><td class="l mgr">${esc(name(x.me))}</td><td class="num"><b>${f2(x.my)}</b></td><td class="l">${wk(x)}</td><td class="l">${esc(name(x.op))} (${f1(x.their)})</td></tr>`).join(""))}
      ${panel("Lowest single-game scores", `<th class="l">Manager</th><th>Points</th><th class="l">When</th><th class="l">Opponent</th>`,
        five(R.lowScores).map((x) => `<tr><td class="l mgr">${esc(name(x.me))}</td><td class="num"><b>${f2(x.my)}</b></td><td class="l">${wk(x)}</td><td class="l">${esc(name(x.op))} (${f1(x.their)})</td></tr>`).join(""))}
      ${panel("Biggest blowouts", `<th class="l">Winner</th><th>Margin</th><th class="l">Loser</th><th class="l">When</th>`,
        five(R.blowouts).map((x) => `<tr><td class="l mgr">${esc(name(x.win))}</td><td class="num"><b>${f2(x.ws - x.ls)}</b></td><td class="l">${esc(name(x.lose))} <span class="muted">${f1(x.ws)}–${f1(x.ls)}</span></td><td class="l">${wk(x)}</td></tr>`).join(""))}
      ${panel("Closest games", `<th class="l">Winner</th><th>Margin</th><th class="l">Loser</th><th class="l">When</th>`,
        five(R.closest).map((x) => `<tr><td class="l mgr">${esc(name(x.win))}</td><td class="num"><b>${f2(x.ws - x.ls)}</b></td><td class="l">${esc(name(x.lose))} <span class="muted">${f2(x.ws)}–${f2(x.ls)}</span></td><td class="l">${wk(x)}</td></tr>`).join(""))}
      ${panel("Longest winning streaks", `<th class="l">Manager</th><th>Games</th><th class="l">From</th><th class="l">To</th>`,
        five(R.winStreaks).map((x) => `<tr><td class="l mgr">${esc(name(x.key))}</td><td class="num"><b>${x.len}</b></td><td class="l">${wk(x.from)}</td><td class="l">${wk(x.to)}</td></tr>`).join(""))}
      ${panel("Longest losing streaks", `<th class="l">Manager</th><th>Games</th><th class="l">From</th><th class="l">To</th>`,
        five(R.lossStreaks).map((x) => `<tr><td class="l mgr">${esc(name(x.key))}</td><td class="num"><b>${x.len}</b></td><td class="l">${wk(x.from)}</td><td class="l">${wk(x.to)}</td></tr>`).join(""))}
      ${panel("Best regular seasons", `<th class="l">Manager</th><th>Record</th><th>Year</th><th>PF</th>`,
        five(R.bestSeasons).map((x) => `<tr><td class="l mgr">${esc(name(x.key))}</td><td class="num"><b>${rec(x.w, x.l, x.t)}</b></td><td class="num">${x.year}</td><td class="num">${tot(x.pf, x.g)}</td></tr>`).join(""))}
      ${panel("Highest-scoring seasons", `<th class="l">Manager</th><th>PF / game</th><th>Year</th><th>Record</th>`,
        five(R.mostPointsSeasons).map((x) => `<tr><td class="l mgr">${esc(name(x.key))}</td><td class="num"><b>${f1(x.pfPg)}</b></td><td class="num">${x.year}</td><td class="num">${rec(x.w, x.l, x.t)}</td></tr>`).join(""))}
      ${panel("Lowest-scoring seasons", `<th class="l">Manager</th><th>PF / game</th><th>Year</th><th>Record</th>`,
        five(R.fewestPointsSeasons).map((x) => `<tr><td class="l mgr">${esc(name(x.key))}</td><td class="num"><b>${f1(x.pfPg)}</b></td><td class="num">${x.year}</td><td class="num">${rec(x.w, x.l, x.t)}</td></tr>`).join(""))}
      ${panel("Highest combined scores", `<th class="l">Game</th><th>Total</th><th class="l">When</th>`,
        five(R.highCombined).map((x) => `<tr><td class="l">${esc(name(x.a))} ${f1(x.as)} – ${f1(x.bs)} ${esc(name(x.b))}</td><td class="num"><b>${f1(x.as + x.bs)}</b></td><td class="l">${wk(x)}</td></tr>`).join(""))}
    </div>
    <p class="sub" style="margin-top:10px">Regular season and playoff games; consolation games are left out. Streaks carry over from one season to the next.</p>`;
  }

  function matchup(g, tn) {
    const aw = g.as > g.bs, bw = g.bs > g.as;
    const side = (k, sc, win) => `<div class="mside ${win ? "win" : ""}"><span class="mname">${esc(name(k))}<span class="tn">${esc(tn[k] || "")}</span></span><span class="mscore num">${f2(sc)}</span></div>`;
    return `<div class="mu">${side(g.a, g.as, aw)}${side(g.b, g.bs, bw)}</div>`;
  }

  function vSeasons() {
    const st = S.stats;
    if (!S.selYear || !st.years.includes(S.selYear)) { S.selYear = st.years[st.years.length - 1]; S.selWeek = null; }
    const s = st.seasons.find((x) => x.year === S.selYear);
    const tn = Object.fromEntries(s.rows.map((r) => [r.key, r.teamName]));
    const result = (r) => !s.complete ? "" : r.key === s.champion ? `<span class="trophy">🏆 Champion</span>` : r.key === s.runnerUp ? "Runner-up" : r.playoffs ? "Playoffs" : "";
    const regWeeks = [...new Set(s.games.filter((g) => g.kind === "reg").map((g) => g.week))].sort((a, b) => a - b);
    if (!regWeeks.includes(S.selWeek)) S.selWeek = regWeeks[regWeeks.length - 1] ?? null;
    const wi = regWeeks.indexOf(S.selWeek);
    const weekGames = s.games.filter((g) => g.kind === "reg" && g.week === S.selWeek).sort((x, y) => (y.as + y.bs) - (x.as + x.bs));
    const po = s.games.filter((g) => g.kind === "playoff");
    const rounds = [...new Set(po.map((g) => g.round ?? g.week))].sort((a, b) => a - b);
    const roundName = (r, i) => i === rounds.length - 1 ? "Championship round" : i === rounds.length - 2 ? "Semifinals" : `Round ${i + 1}`;
    const R = s.rec;
    const gc = (lab, x, cls) => x ? card(lab, `<span class="num">${f2(x.my)}</span>`, `${esc(name(x.me))} · ${when(x)} vs ${esc(name(x.op))}`, cls) : "";
    const mc = (lab, x) => x ? card(lab, `<span class="num">${f2(x.ws - x.ls)}</span>`, `${esc(name(x.win))} ${f1(x.ws)}–${f1(x.ls)} ${esc(name(x.lose))} · ${when(x)}`) : "";
    return `<div class="chips" role="group" aria-label="Season">${[...st.years].reverse().map((y) => `<button class="chip" aria-pressed="${y === S.selYear}" data-act="selYear" data-y="${y}">${y}</button>`).join("")}</div>
      <p class="sub">${esc(s.leagueName || "")} · ${s.teamCount} teams${s.complete ? "" : " · in progress"}</p>

      <h2>${s.complete ? "Final standings" : "Standings so far"}</h2>
      <div class="scroll"><table>
        <thead><tr><th>${s.complete ? "Final" : "Now"}</th><th class="l">Manager</th><th>W-L-T</th><th>PF <span class="avg">(avg)</span></th><th>PA <span class="avg">(avg)</span></th><th>Reg. season</th><th class="l">Result</th></tr></thead>
        <tbody>${s.rows.map((r) => `<tr class="clickable" data-act="teamSeason" data-year="${s.year}" data-k="${esc(r.key)}"><td class="num rank1">${s.complete ? ord(r.finalRank) : ord(r.regRank)}</td><td class="l mgr">${esc(name(r.key))}<span class="tn">${esc(r.teamName)}</span></td>
          <td class="num">${rec(r.w, r.l, r.t)}</td><td class="num">${tot(r.pf, r.g)}</td><td class="num">${tot(r.pa, r.g)}</td><td class="num">${ord(r.regRank)}</td><td class="l">${result(r)}</td></tr>`).join("")}</tbody></table></div>
      <p class="sub" style="margin-top:8px">Records and points are regular season. Tap a team for its roster, draft and moves.${S.league.seasons.find((x) => x.year === s.year)?.rost ? ` <a href="#rosters" data-act="jumpRosters">Jump to every team's final roster</a>.` : ""} ${S.league.seasons.find((x) => x.year === s.year)?.medianScoring ? "This league also plays the weekly median; those extra wins count toward seeding but aren't head-to-head games." : ""}</p>

      <h2>${s.year} records</h2>
      <div class="cards">${gc("Highest score", R.high, "gold")}${gc("Lowest score", R.low)}${mc("Biggest blowout", R.blowout)}${mc("Closest game", R.closest)}</div>

      ${regWeeks.length ? `<h2>Week by week</h2>
      <div class="weeknav">
        <button class="btn ghost small" data-act="week" data-w="${regWeeks[wi - 1] ?? ""}" ${wi <= 0 ? "disabled" : ""} aria-label="Previous week">‹</button>
        <label class="sr" for="weekSel">Week</label>
        <select id="weekSel" data-act-change="weekSel">${regWeeks.map((w) => `<option value="${w}" ${w === S.selWeek ? "selected" : ""}>Week ${w}</option>`).join("")}</select>
        <button class="btn ghost small" data-act="week" data-w="${regWeeks[wi + 1] ?? ""}" ${wi >= regWeeks.length - 1 ? "disabled" : ""} aria-label="Next week">›</button>
      </div>
      <div class="mugrid">${weekGames.map((g) => matchup(g, tn)).join("")}</div>` : ""}

      ${po.length ? `<h2>Playoffs</h2>
      ${rounds.map((r, i) => {
        const gs = po.filter((g) => (g.round ?? g.week) === r);
        const last = i === rounds.length - 1;
        // last round: the game with the champion is the final, the rest are placement games (3rd place)
        const fin = last && s.champion ? gs.filter((g) => g.a === s.champion || g.b === s.champion) : gs;
        const rest = last && s.champion ? gs.filter((g) => !fin.includes(g)) : [];
        return `<h3 class="round">${last && s.champion ? "Championship" : roundName(r, i)}</h3><div class="mugrid">${fin.map((g) => matchup(g, tn)).join("")}</div>`
          + (rest.length ? `<h3 class="round">3rd place game</h3><div class="mugrid">${rest.map((g) => matchup(g, tn)).join("")}</div>` : "");
      }).join("")}` : ""}

      ${rosterSection(S.league.seasons.find((x) => x.year === s.year), s)}`;
  }

  /* ---------------- drafts, rosters, trades and pickups ---------------- */
  // Seasons carry these from the server (see flh-moves.js): pl, draft, rost, tx, tc, faab, mv.
  // Their manager keys are the original accounts, so everything goes through S.canon (merges).
  const ck = (k) => (S.canon ? S.canon(k) : k);
  const POS_ORDER = { QB: 1, RB: 2, WR: 3, TE: 4, K: 6, "D/ST": 7 };
  const pinfo = (s, id) => s.pl?.[id] || [`Player ${id}`, ""];
  const posCls = (p) => ({ QB: "qb", RB: "rb", WR: "wr", TE: "te", K: "k", "D/ST": "dst" }[p] || "oth");
  const ptag = (pos) => pos ? `<span class="ppos ${posCls(pos)}">${esc(pos)}</span>` : "";
  const pchip = (s, id) => { const [n, pos] = pinfo(s, id); return `<span class="pl">${esc(n)} ${ptag(pos)}</span>`; };
  const draftSeasons = () => S.league.seasons.filter((s) => s.draft?.picks?.length).sort((a, b) => b.year - a.year);
  const moveSeasons = () => S.league.seasons.filter((s) => s.mv != null && s.mv !== -1).sort((a, b) => b.year - a.year);
  const hasMoveData = () => S.league.seasons.some((s) => s.draft?.picks?.length || s.tx?.length || s.tc || s.rost);
  const shortDate = (ms) => ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const wkLabel = (t) => t.w ? `Week ${t.w}` : "Preseason";
  const pickLabel = (pk) => `${pk.y} round ${pk.r} pick${pk.o ? ` <span class="muted">(${esc(name(ck(pk.o)))}'s)</span>` : ""}`;

  function movesNote() {
    const L = S.league, n = L.movesPending || 0;
    if (!n || isDemo()) return "";
    if (S.movesBusy) return `<p class="tipbox"><span class="spin inline" aria-hidden="true"></span> Loading drafts, rosters and trades… ${n} season${n === 1 ? "" : "s"} to go. This only happens once.</p>`;
    if (L.isPrivate && !savedCreds(L.slug)) return `<p class="tipbox">Drafts, rosters and trades for ${n} season${n === 1 ? "" : "s"} load the next time someone in the league taps <b>Update this season</b> with their ESPN login.</p>`;
    return `<p class="tipbox">${n} season${n === 1 ? "" : "s"} of drafts and trades still to load. <button class="linkbtn" data-act="movesGo">Load them now</button></p>`;
  }

  // Keep fetching older seasons' drafts and moves, a few per request, until they're all in
  async function fetchMoves() {
    const L = S.league;
    if (!L || isDemo() || S.movesBusy || !(L.movesPending > 0)) return;
    const cr = savedCreds(L.slug);
    if (L.isPrivate && !cr) return;
    S.movesBusy = true; render();
    let stuck = 0;
    try {
      for (let i = 0; i < 30 && S.league?.slug === L.slug; i++) {
        const before = S.league.movesPending;
        const r = await api("moves", { slug: L.slug, ...(cr || {}) });
        if (r.needLogin) break;
        const NL = fromServer(r);
        S.movesBusy = NL.movesPending > 0;
        replaceLeague(NL);
        if (!NL.movesPending) break;
        stuck = NL.movesPending >= before ? stuck + 1 : 0;
        if (stuck >= 3) break;
      }
    } catch (e) {
      if (!e.private) toast(`Couldn't load drafts and trades: ${e.message}`);
    } finally {
      S.movesBusy = false;
      if (S.league?.slug === L.slug) render();
    }
  }

  /* ----- Drafts tab ----- */
  function vDrafts() {
    const ds = draftSeasons();
    if (!ds.length) return movesNote() + `<p class="sub">${S.league.movesPending ? "Drafts show up here once they've loaded." : "No drafts found for this league. ESPN and Sleeper only keep drafts the league ran on their site."}</p>`;
    if (!ds.find((s) => s.year === S.dYear)) S.dYear = ds[0].year;
    const s = ds.find((x) => x.year === S.dYear), d = s.draft;
    const view = d.type === "auction" ? "auction" : S.dView;
    return `${movesNote()}
      <div class="chips" role="group" aria-label="Draft year">${ds.map((x) => `<button class="chip" aria-pressed="${x.year === s.year}" data-act="dYear" data-y="${x.year}">${x.year}</button>`).join("")}</div>
      <div class="toolbar"><p class="sub" style="margin:0">${s.year} · ${d.type === "auction" ? "auction" : d.type === "linear" ? "linear draft" : "snake draft"} · ${d.picks.length} picks${d.picks.some((p) => p.kp) ? " · <b>K</b> = keeper" : ""}</p>
        ${d.type === "auction" ? "" : `<div class="seg" role="group" aria-label="Draft view">${[["board", "Draft board"], ["team", "By manager"]].map(([k, l]) => `<button aria-pressed="${view === k}" data-act="dView" data-v="${k}">${l}</button>`).join("")}</div>`}</div>
      ${view === "board" ? draftBoard(s) : view === "auction" ? auctionTable(s) : draftByTeam(s)}
      <p class="sub" style="margin-top:8px">Positions: ${["QB", "RB", "WR", "TE", "K", "D/ST"].map(ptag).join(" ")} · Tap a manager for their team page.</p>
      ${draftAllTime(ds)}`;
  }

  function draftBoard(s) {
    const d = s.draft;
    const N = d.teams || Math.max(...d.picks.filter((p) => p.r === 1).map((p) => p.s || 0), 1);
    const slotOf = (p) => p.s || (() => { const rp = p.n - (p.r - 1) * N; return d.type === "snake" && p.r % 2 === 0 ? N + 1 - rp : rp; })();
    const slots = [...new Set(d.picks.map(slotOf))].sort((a, b) => a - b);
    const owner = Object.fromEntries(d.picks.filter((p) => p.r === 1).map((p) => [slotOf(p), p.k]));
    const rounds = [...new Set(d.picks.map((p) => p.r))].sort((a, b) => a - b);
    const at = {}; for (const p of d.picks) at[`${p.r}:${slotOf(p)}`] = p;
    const cell = (p, slot) => {
      if (!p) return `<td class="dcell empty"></td>`;
      const [n, pos, tm] = pinfo(s, p.p), traded = owner[slot] && ck(p.k) !== ck(owner[slot]);
      return `<td class="dcell ${posCls(pos)}"><span class="dn">${esc(n)}</span><span class="dm">${esc(pos)}${tm ? " · " + esc(tm) : ""} · #${p.n}${p.kp ? ` · <b>K</b>` : ""}</span>${traded ? `<span class="dt">→ ${esc(shortName(ck(p.k)))}</span>` : ""}</td>`;
    };
    return `<div class="scroll"><table class="board">
      <thead><tr><th class="l">Rd</th>${slots.map((sl) => `<th class="l clickable" data-act="gotoRival" data-k="${esc(ck(owner[sl] || ""))}">${owner[sl] ? esc(shortName(ck(owner[sl]))) : `Slot ${sl}`}</th>`).join("")}</tr></thead>
      <tbody>${rounds.map((r) => `<tr><th class="l rnd">${r}</th>${slots.map((sl) => cell(at[`${r}:${sl}`], sl)).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="sub" style="margin-top:6px">Columns are the round-1 draft order. "→ name" means that pick was traded and someone else made it.</p>`;
  }

  function draftByTeam(s) {
    const by = {};
    for (const p of s.draft.picks) (by[ck(p.k)] ||= []).push(p);
    const keys = Object.keys(by).sort((a, b) => by[a][0].n - by[b][0].n);
    return `<div class="rgrid">${keys.map((k) => `<div class="rcard"><div class="rhead clickable" data-act="gotoRival" data-k="${esc(k)}"><b>${esc(name(k))}</b></div>
      <ol class="plist">${by[k].map((p) => { const [n, pos] = pinfo(s, p.p); return `<li><span class="rk num">${p.r}.${String(p.n - (p.r - 1) * (s.draft.teams || by[k].length)).padStart(2, "0")}</span> ${esc(n)} ${ptag(pos)}${p.kp ? ` <b>K</b>` : ""}</li>`; }).join("")}</ol></div>`).join("")}</div>`;
  }

  function auctionTable(s) {
    const picks = [...s.draft.picks].sort((a, b) => (b.$ || 0) - (a.$ || 0) || a.n - b.n);
    const spend = {};
    for (const p of picks) { const k = ck(p.k); const x = (spend[k] ||= { k, $: 0, n: 0, top: p }); x.$ += p.$ || 0; x.n++; }
    return `<h3 class="round">Spending by manager</h3>
      <div class="scroll"><table><thead><tr><th class="l">Manager</th><th>Spent</th><th>Players</th><th class="l">Biggest buy</th></tr></thead>
      <tbody>${Object.values(spend).sort((a, b) => b.$ - a.$).map((x) => `<tr class="clickable" data-act="gotoRival" data-k="${esc(x.k)}"><td class="l mgr">${esc(name(x.k))}</td><td class="num">$${x.$}</td><td class="num">${x.n}</td><td class="l">${pchip(s, x.top.p)} $${x.top.$ || 0}</td></tr>`).join("")}</tbody></table></div>
      <h3 class="round">Every player, most expensive first</h3>
      <div class="scroll"><table><thead><tr><th>Price</th><th class="l">Player</th><th class="l">Manager</th><th>Nominated</th></tr></thead>
      <tbody>${picks.map((p) => `<tr><td class="num"><b>$${p.$ || 0}</b></td><td class="l">${pchip(s, p.p)}${p.kp ? " <b>K</b>" : ""}</td><td class="l">${esc(name(ck(p.k)))}</td><td class="num muted">#${p.n}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function draftAllTime(ds) {
    const years = [...ds].map((s) => s.year).sort((a, b) => a - b);
    const mg = {};
    const M = (k) => (mg[k] ||= { k, drafts: new Set(), first: {}, firstPos: {}, picks: 0, kept: 0, onRoster: 0, rosterKnown: 0, qbRound: [], times: {} });
    for (const s of ds) {
      const firstOf = {};
      for (const p of s.draft.picks) {
        const k = ck(p.k); if (!k) continue;
        const m = M(k); m.drafts.add(s.year); m.picks++;
        if (p.kp) m.kept++;
        const [, pos] = pinfo(s, p.p);
        if (!firstOf[k]) { firstOf[k] = p; m.firstPos[pos || "?"] = (m.firstPos[pos || "?"] || 0) + 1; }
        if (p.r === 1) (m.first[s.year] ||= []).push(p);
        if (pos === "QB" && !m.qbRound.find((x) => x.y === s.year)) m.qbRound.push({ y: s.year, r: p.r });
        if (s.rost && s.complete) { m.rosterKnown++; if ((s.rost[p.k] || []).some((x) => x.p === p.p)) m.onRoster++; }
        const t = (m.times[p.p] ||= { p: p.p, s, years: [] }); t.years.push(s.year); t.s = s;
      }
    }
    const list = Object.values(mg).sort((a, b) => name(a.k).localeCompare(name(b.k)));
    const loyal = list.flatMap((m) => Object.values(m.times).filter((t) => t.years.length >= 2).map((t) => ({ m, ...t }))).sort((a, b) => b.years.length - a.years.length || b.years[b.years.length - 1] - a.years[a.years.length - 1]).slice(0, 10);
    const posMix = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${esc(p)} ${n}`).join(" · ");
    const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    return `<h2>Every first-round pick</h2>
      <div class="scroll"><table class="compact firsts"><thead><tr><th class="l">Manager</th>${years.map((y) => `<th class="l">${y}</th>`).join("")}</tr></thead>
      <tbody>${list.map((m) => `<tr><td class="l mgr clickable" data-act="gotoRival" data-k="${esc(m.k)}">${esc(name(m.k))}</td>${years.map((y) => {
        const ps = m.first[y]; const s = ds.find((x) => x.year === y);
        return `<td class="l">${ps ? ps.map((p) => `${pchip(s, p.p)}${p.kp ? " <b>K</b>" : ""}`).join("<br>") : m.drafts.has(y) ? `<span class="muted">none</span>` : `<span class="muted">·</span>`}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>
      <h2>Draft habits</h2>
      <div class="scroll"><table class="compact"><thead><tr><th class="l">Manager</th><th>Drafts</th><th class="l">First pick's position</th><th>First QB<br>(avg round)</th><th>Keepers</th><th>Still on roster<br>at season end</th></tr></thead>
      <tbody>${list.map((m) => `<tr class="clickable" data-act="gotoRival" data-k="${esc(m.k)}"><td class="l mgr">${esc(name(m.k))}</td><td class="num">${m.drafts.size}</td><td class="l">${posMix(m.firstPos)}</td>
        <td class="num">${m.qbRound.length ? f1(avg(m.qbRound.map((x) => x.r))) : "—"}</td><td class="num ${m.kept ? "" : "muted"}">${m.kept}</td>
        <td class="num">${m.rosterKnown ? `${Math.round((m.onRoster / m.rosterKnown) * 100)}%` : "—"}</td></tr>`).join("")}</tbody></table></div>
      <p class="sub" style="margin-top:8px"><b>Still on roster</b> is the share of a manager's draft picks still on their team after the last game of the season (finished seasons only). Low means they churn their roster; high means they ride with their picks.</p>
      ${loyal.length ? `<h2>Can't quit him</h2>
      <p class="sub" style="margin-top:-4px">The same manager drafting the same player in different seasons.</p>
      <div class="scroll"><table><thead><tr><th class="l">Manager</th><th class="l">Player</th><th>Times</th><th class="l">Years</th></tr></thead>
      <tbody>${loyal.map((x) => `<tr><td class="l mgr">${esc(name(x.m.k))}</td><td class="l">${pchip(x.s, x.p)}</td><td class="num"><b>${x.years.length}</b></td><td class="l">${x.years.join(", ")}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  }

  /* ----- Trades & Waivers tab ----- */
  // every move in the chosen seasons, with merged manager keys
  function collectMoves(years) {
    const trades = [], pickups = [], counts = {};
    const C = (k) => (counts[k] ||= { k, trades: 0, adds: 0, drops: 0, waivers: 0, fas: 0, faab: 0, bigBid: null, partners: {}, est: false });
    for (const s of S.league.seasons) {
      if (!years.includes(s.year) || s.mv == null || s.mv === -1) continue;
      const detail = (s.tx || []).length > 0;
      for (const t of s.tx || []) {
        if (t.t === "trade") {
          const sides = t.sides.map((x) => ({ ...x, k: ck(x.k) }));
          trades.push({ s, t, sides });
          for (const a of sides) {
            C(a.k).trades++;
            for (const b of sides) if (b.k !== a.k) C(a.k).partners[b.k] = (C(a.k).partners[b.k] || 0) + 1;
          }
        } else {
          const k = ck(t.k); if (!k) continue;
          pickups.push({ s, t, k });
          const c = C(k);
          c.adds += t.add.length; c.drops += t.drop.length;
          if (t.add.length) { if (t.t === "waiver") c.waivers++; else c.fas++; }
          if (t.bid != null) { c.faab += t.bid; if (!c.bigBid || t.bid > c.bigBid.t.bid) c.bigBid = { s, t }; }
        }
      }
      // ESPN before 2019: only season totals
      if (!detail && s.tc) for (const [raw, [a, d, tr, spent]] of Object.entries(s.tc)) {
        const c = C(ck(raw)); c.adds += a; c.drops += d; c.trades += tr; c.faab += spent || 0; c.est = true;
      }
    }
    return { trades, pickups, counts };
  }

  function tradeCard({ s, t, sides }) {
    return `<div class="tcard"><div class="th">${s.year} · ${wkLabel(t)}${t.at ? ` · ${shortDate(t.at)}` : ""}</div>
      ${sides.map((x) => `<div class="tside"><div class="tw clickable" data-act="gotoRival" data-k="${esc(x.k)}"><b>${esc(name(x.k))}</b> got</div><div class="tg">${[
        ...x.get.map((p) => pchip(s, p)), ...(x.picks || []).map((pk) => `<span class="pl">${pickLabel(pk)}</span>`),
        ...(x.faab ? [`<span class="pl">$${x.faab} FAAB</span>`] : []),
      ].join("") || `<span class="muted">nothing</span>`}</div></div>`).join("")}</div>`;
  }

  function vMoves() {
    const ms = moveSeasons();
    const yrs = ms.map((s) => s.year);
    if (!ms.length) return movesNote() + `<p class="sub">${S.league.movesPending ? "Trades and pickups show up here once they've loaded." : "No trades or pickups found for this league."}</p>`;
    if (S.mvYear !== "all" && !yrs.includes(S.mvYear)) S.mvYear = "all";
    const years = S.mvYear === "all" ? yrs : [S.mvYear];
    const { trades, pickups, counts } = collectMoves(years);
    const mgrs = Object.keys(counts).sort((a, b) => name(a).localeCompare(name(b)));
    if (S.mvMgr && !counts[S.mvMgr]) S.mvMgr = "";
    const mine = (k) => !S.mvMgr || k === S.mvMgr;
    const tr = trades.filter((x) => x.sides.some((y) => mine(y.k))).reverse();
    const pu = pickups.filter((x) => mine(x.k)).reverse();
    const anyFaab = pickups.some((x) => x.t.bid != null) || Object.values(counts).some((c) => c.faab);
    const anyEst = Object.values(counts).some((c) => c.est);
    const nAdds = pu.reduce((a, x) => a + x.t.add.length, 0);
    const spent = pu.reduce((a, x) => a + (x.t.bid || 0), 0);
    const shown = S.mvAll ? pu : pu.slice(0, 40);
    const pairs = {};
    for (const x of trades) for (let i = 0; i < x.sides.length; i++) for (let j = i + 1; j < x.sides.length; j++) {
      const [a, b] = [x.sides[i].k, x.sides[j].k].sort(); const key = a + "|" + b; (pairs[key] ||= { a, b, n: 0 }).n++;
    }
    const topPairs = Object.values(pairs).sort((p, q) => q.n - p.n).slice(0, 6);
    const added = {};
    for (const x of pickups) for (const p of x.t.add) { const a = (added[p] ||= { p, s: x.s, n: 0, by: new Set() }); a.n++; a.by.add(x.k); a.s = x.s; }
    const journeymen = Object.values(added).filter((a) => a.n >= 2).sort((a, b) => b.n - a.n || b.by.size - a.by.size).slice(0, 8);
    const bids = pickups.filter((x) => x.t.bid).sort((a, b) => b.t.bid - a.t.bid).slice(0, 8);
    const partner = (c) => { const e = Object.entries(c.partners).sort((a, b) => b[1] - a[1])[0]; return e ? `${esc(name(e[0]))} <span class="avg">(${e[1]})</span>` : `<span class="muted">—</span>`; };
    const espnEarly = S.league.platform === "espn" && S.league.seasons.some((s) => s.year < 2019);

    return `${movesNote()}
      <div class="chips" role="group" aria-label="Seasons"><button class="chip" aria-pressed="${S.mvYear === "all"}" data-act="mvYear" data-y="all">All seasons</button>${yrs.map((y) => `<button class="chip" aria-pressed="${S.mvYear === y}" data-act="mvYear" data-y="${y}">${y}</button>`).join("")}</div>
      <div class="toolbar"><label class="sr" for="mvMgr">Manager</label><select id="mvMgr" style="width:auto;min-width:200px"><option value="">Everyone</option>${mgrs.map((k) => `<option value="${esc(k)}" ${k === S.mvMgr ? "selected" : ""}>${esc(name(k))}</option>`).join("")}</select></div>
      <div class="kpis">
        <div class="kpi"><div class="v num">${tr.length}</div><div class="l">Trades</div></div>
        <div class="kpi"><div class="v num">${nAdds}</div><div class="l">Players added off waivers or free agency</div></div>
        <div class="kpi"><div class="v num">${pu.filter((x) => x.t.t === "waiver" && x.t.add.length).length}</div><div class="l">Waiver claims won</div></div>
        ${anyFaab ? `<div class="kpi"><div class="v num">$${spent.toLocaleString()}</div><div class="l">FAAB spent on claims</div></div>` : ""}
      </div>
      ${S.mvMgr ? "" : `<h2>Who works the wire</h2>
      <div class="scroll"><table class="compact"><thead><tr><th class="l">Manager</th><th>Trades</th><th>Adds</th><th>Drops</th><th>Waiver<br>claims</th>${anyFaab ? "<th>FAAB<br>spent</th><th class=\"l\">Biggest bid</th>" : ""}<th class="l">Favorite trade partner</th></tr></thead>
      <tbody>${Object.values(counts).sort((a, b) => (b.adds + b.trades * 3) - (a.adds + a.trades * 3)).map((c) => `<tr class="clickable" data-act="mvPick" data-k="${esc(c.k)}"><td class="l mgr">${esc(name(c.k))}${c.est ? " *" : ""}</td>
        <td class="num">${c.trades}</td><td class="num">${c.adds}</td><td class="num">${c.drops}</td><td class="num">${c.waivers}</td>
        ${anyFaab ? `<td class="num">$${c.faab}</td><td class="l">${c.bigBid ? `$${c.bigBid.t.bid} · ${esc(pinfo(c.bigBid.s, c.bigBid.t.add[0])[0])} <span class="avg">(${c.bigBid.s.year})</span>` : `<span class="muted">—</span>`}</td>` : ""}
        <td class="l">${partner(c)}</td></tr>`).join("")}</tbody></table></div>
      <p class="sub" style="margin-top:8px">Tap a manager to see only their moves.${anyEst ? " * Includes ESPN's season totals for years before 2019, when ESPN didn't keep move-by-move history." : ""}${espnEarly && !anyEst ? " ESPN only keeps move-by-move history from 2019 on." : ""}</p>`}
      ${!S.mvMgr && topPairs.length ? `<h2>Most frequent trade partners</h2><div class="cards">${topPairs.map((p) => card(`${p.n} trade${p.n === 1 ? "" : "s"}`, `${esc(name(p.a))} &amp; ${esc(name(p.b))}`, "")).join("")}</div>` : ""}
      <h2>Trades${S.mvMgr ? ` · ${esc(name(S.mvMgr))}` : ""}</h2>
      ${tr.length ? `<div class="tgrid">${(S.trAll ? tr : tr.slice(0, 12)).map(tradeCard).join("")}</div>${tr.length > 12 && !S.trAll ? `<div class="actions"><button class="btn ghost small" data-act="trAll">Show all ${tr.length} trades</button></div>` : ""}` : `<p class="sub">No trades${S.mvMgr ? " for this manager" : ""} in ${S.mvYear === "all" ? "these seasons" : S.mvYear}.</p>`}
      <h2>Waiver and free-agent pickups${S.mvMgr ? ` · ${esc(name(S.mvMgr))}` : ""}</h2>
      ${pu.length ? `<div class="scroll"><table><thead><tr><th class="l">When</th>${S.mvMgr ? "" : `<th class="l">Manager</th>`}<th class="l">Added</th><th class="l">Dropped</th><th class="l">How</th></tr></thead>
      <tbody>${shown.map((x) => `<tr><td class="l">${x.s.year} · ${x.t.w ? "wk " + x.t.w : "pre"}<span class="tn">${shortDate(x.t.at)}</span></td>${S.mvMgr ? "" : `<td class="l mgr">${esc(name(x.k))}</td>`}
        <td class="l">${x.t.add.map((p) => pchip(x.s, p)).join("<br>") || `<span class="muted">—</span>`}</td><td class="l muted">${x.t.drop.map((p) => esc(pinfo(x.s, p)[0])).join("<br>") || "—"}</td>
        <td class="l">${x.t.t === "waiver" ? `Waivers${x.t.bid != null ? ` <b>$${x.t.bid}</b>` : ""}` : "Free agent"}</td></tr>`).join("")}</tbody></table></div>
      ${pu.length > shown.length ? `<div class="actions"><button class="btn ghost small" data-act="mvAll">Show all ${pu.length}</button></div>` : ""}` : `<p class="sub">No pickups${S.mvMgr ? " for this manager" : ""} in ${S.mvYear === "all" ? "these seasons" : S.mvYear}.</p>`}
      ${!S.mvMgr && (bids.length || journeymen.length) ? `<div class="recgrid" style="margin-top:20px">
        ${bids.length ? `<div class="panel"><h3>Biggest FAAB bids</h3><div style="overflow-x:auto"><table><thead><tr><th class="l">Manager</th><th>Bid</th><th class="l">Player</th><th class="l">When</th></tr></thead><tbody>${bids.map((x) => `<tr><td class="l mgr">${esc(name(x.k))}</td><td class="num"><b>$${x.t.bid}</b></td><td class="l">${x.t.add.map((p) => pchip(x.s, p)).join(" ")}</td><td class="l">${x.s.year} wk ${x.t.w}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
        ${journeymen.length ? `<div class="panel"><h3>Most-added players</h3><div style="overflow-x:auto"><table><thead><tr><th class="l">Player</th><th>Times added</th><th>By</th></tr></thead><tbody>${journeymen.map((a) => `<tr><td class="l">${pchip(a.s, a.p)}</td><td class="num"><b>${a.n}</b></td><td class="num">${a.by.size} manager${a.by.size === 1 ? "" : "s"}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      </div>` : ""}`;
  }

  /* ----- final rosters (Seasons tab) and one team's season ----- */
  // how each player got there: the last move that brought him to this team, else the draft
  function howMap(src) {
    const how = {};
    for (const p of src.draft?.picks || []) how[`${p.k}|${p.p}`] = p.kp ? "K" : "D";
    for (const t of src.tx || []) {
      if (t.t === "trade") { for (const x of t.sides) for (const p of x.get) how[`${x.k}|${p}`] = "T"; }
      else for (const p of t.add) how[`${t.k}|${p}`] = t.t === "waiver" ? "W" : "FA";
    }
    return how;
  }
  const HOW_KEY = "How they got him: <b>D</b> drafted · <b>K</b> keeper · <b>T</b> trade · <b>W</b> waivers · <b>FA</b> free agent.";
  const SLOT_RANK = { s: 0, b: 1, t: 2, r: 3 };
  function rosterList(src, raw, how) {
    const anyHow = Object.keys(how).length > 0;
    const list = [...src.rost[raw]].sort((a, b) => SLOT_RANK[a.s] - SLOT_RANK[b.s] || (POS_ORDER[pinfo(src, a.p)[1]] || 5) - (POS_ORDER[pinfo(src, b.p)[1]] || 5));
    const tally = {}; for (const x of list) { const h = how[`${raw}|${x.p}`]; if (h) tally[h] = (tally[h] || 0) + 1; }
    return `<ul class="plist">${list.map((x) => { const [n, pos] = pinfo(src, x.p), h = how[`${raw}|${x.p}`];
        return `<li class="${x.s === "s" ? "" : "bench"}">${ptag(pos)} ${esc(n)}${x.s === "r" ? ` <span class="tag">IR</span>` : x.s === "t" ? ` <span class="tag">Taxi</span>` : ""}${anyHow ? `<span class="how">${h || ""}</span>` : ""}</li>`; }).join("")}</ul>
      ${anyHow ? `<div class="rfoot">${["D", "K", "T", "W", "FA"].filter((h) => tally[h]).map((h) => `${h} ${tally[h]}`).join(" · ")}</div>` : ""}`;
  }

  function rosterSection(src, st) {
    if (!src.rost || !Object.keys(src.rost).length) return "";
    const how = howMap(src);
    const tn = Object.fromEntries(st.rows.map((r) => [r.key, r.teamName]));
    const keys = Object.keys(src.rost).sort((a, b) => {
      const ra = st.rows.find((r) => r.key === ck(a)), rb = st.rows.find((r) => r.key === ck(b));
      return ((src.complete ? ra?.finalRank : ra?.regRank) ?? 99) - ((src.complete ? rb?.finalRank : rb?.regRank) ?? 99);
    });
    return `<h2 id="rosters">${src.complete ? "Final rosters" : "Rosters right now"}</h2>
      <p class="sub" style="margin-top:-4px">${src.complete ? "Each team's roster after its last game of the season" : "Each team's roster today"}, starters first.${Object.keys(how).length ? " " + HOW_KEY : ""} Tap a team for its draft and moves.</p>
      <div class="rgrid">${keys.map((raw) => {
        const k = ck(raw);
        return `<div class="rcard"><div class="rhead clickable" data-act="teamSeason" data-year="${src.year}" data-k="${esc(k)}"><b>${esc(name(k))}</b><span class="tn">${esc(tn[k] || "")}</span></div>${rosterList(src, raw, how)}</div>`;
      }).join("")}</div>`;
  }

  // One manager's season: result, final roster, draft picks, trades and pickups
  function teamSeasonDlg(year, key) {
    const src = S.league.seasons.find((x) => x.year === year);
    const st = S.stats.seasons.find((x) => x.year === year);
    const row = st?.rows.find((r) => r.key === key);
    if (!src || !row) return;
    const raws = [...new Set(src.teams.map((t) => t.key).filter((k) => ck(k) === key))];
    const how = howMap(src);
    const res = !src.complete ? "season in progress" : st.champion === key ? "🏆 Champion" : st.runnerUp === key ? "Runner-up" : `${ord(row.finalRank)} of ${st.teamCount}`;
    const picks = (src.draft?.picks || []).filter((p) => ck(p.k) === key);
    const trades = (src.tx || []).filter((t) => t.t === "trade" && t.sides.some((x) => ck(x.k) === key)).map((t) => ({ s: src, t, sides: t.sides.map((x) => ({ ...x, k: ck(x.k) })) }));
    const pickups = (src.tx || []).filter((t) => t.t !== "trade" && ck(t.k) === key);
    const roster = raws.filter((r) => src.rost?.[r]?.length);
    const why = src.mv == null
      ? (S.league.isPrivate && !savedCreds(S.league.slug) ? "Rosters, drafts and moves for this season haven't loaded yet. They load the next time someone taps <b>Update this season</b> with their ESPN login." : "Rosters, drafts and moves for this season are still loading. Check back in a minute.")
      : src.mv === -1 ? `${S.league.platform === "espn" ? "ESPN" : "Sleeper"} didn't return a roster for this season.` : "No roster saved for this season.";
    openDlg(`<h3>${esc(name(key))} · ${year}</h3>
      <p class="sub">${esc(row.teamName)} · ${src.complete ? `<b>${res}</b>` : res} · ${rec(row.w, row.l, row.t)} · ${tot(row.pf, row.g)} PF</p>
      <h3 class="round">${src.complete ? "Final roster" : "Roster right now"}</h3>
      ${roster.length ? `<div class="rcard">${roster.map((r) => rosterList(src, r, how)).join("")}</div>${Object.keys(how).length ? `<p class="sub" style="margin-top:6px">${HOW_KEY}</p>` : ""}` : `<p class="sub">${why}</p>`}
      ${picks.length ? `<h3 class="round">Draft</h3><div class="glog">${picks.map((p) => `<span><span class="muted num">Rd ${p.r} · #${p.n}</span> ${pchip(src, p.p)}${p.$ ? ` $${p.$}` : ""}${p.kp ? " <b>K</b>" : ""}</span>`).join("")}</div>` : ""}
      ${trades.length ? `<h3 class="round">Trades</h3><div class="tgrid">${trades.map(tradeCard).join("")}</div>` : ""}
      ${pickups.length ? `<h3 class="round">Pickups (${pickups.length})</h3><div class="scroll"><table><tbody>${[...pickups].reverse().map((t) => `<tr><td class="l">${t.w ? "Wk " + t.w : "Pre"}</td><td class="l">${t.add.map((p) => pchip(src, p)).join("<br>") || "—"}</td><td class="l muted">${t.drop.length ? "dropped " + t.drop.map((p) => esc(pinfo(src, p)[0])).join(", ") : ""}</td><td class="l">${t.t === "waiver" ? `Waivers${t.bid != null ? ` $${t.bid}` : ""}` : "FA"}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <div class="actions"><button class="btn ghost small" data-act="gotoSeason" data-year="${year}">Open the ${year} season</button><button class="btn ghost small" data-act="gotoRival" data-k="${esc(key)}">${esc(name(key))}'s team page</button></div>`);
  }

  /* ----- team page summary ----- */
  function teamMovesSection(m) {
    const ds = draftSeasons();
    const firsts = ds.flatMap((s) => s.draft.picks.filter((p) => p.r === 1 && ck(p.k) === m.key).map((p) => ({ s, p }))).sort((a, b) => b.s.year - a.s.year);
    const { trades, counts } = collectMoves(moveSeasons().map((s) => s.year));
    const c = counts[m.key];
    if (!firsts.length && !c) return "";
    const top = c && Object.entries(c.partners).sort((a, b) => b[1] - a[1])[0];
    const lastTrade = trades.filter((x) => x.sides.some((y) => y.k === m.key)).pop();
    return `<h2>Drafts and moves</h2>
      <div class="cards">
        ${c ? card("Trades", `${c.trades}`, top ? `Most with ${esc(name(top[0]))} (${top[1]})` : "No trade partners yet") : ""}
        ${c ? card("Pickups", `${c.adds}`, `${c.waivers} waiver claim${c.waivers === 1 ? "" : "s"}${c.faab ? ` · $${c.faab} FAAB spent` : ""}${c.est ? " · includes ESPN season totals" : ""}`) : ""}
        ${lastTrade ? card("Latest trade", `${lastTrade.s.year} · ${wkLabel(lastTrade.t)}`, lastTrade.sides.map((x) => `${esc(name(x.k))} got ${x.get.map((p) => esc(pinfo(lastTrade.s, p)[0])).join(", ") || (x.picks.length ? "draft picks" : "nothing")}`).join(" · ")) : ""}
      </div>
      ${firsts.length ? `<h3 class="round">First-round picks</h3><div class="glog">${firsts.map(({ s, p }) => `<span><b>${s.year}</b> ${pchip(s, p.p)} <span class="muted">#${p.n}</span></span>`).join("")}</div>` : ""}
      <div class="actions">${ds.length ? `<button class="btn ghost small" data-act="tab" data-tab="drafts">All drafts</button>` : ""}${c ? `<button class="btn ghost small" data-act="mvPick" data-k="${esc(m.key)}">All their trades and pickups</button>` : ""}</div>`;
  }


  /* ---------------- managers (rename / merge, shared with everyone who has the link) ---------------- */
  const isDemo = () => S.league?.slug === "demo";
  // names/merges someone saved in this browser before they were shared
  const legacyEdits = () => ({ names: S.prefs.names || {}, aliases: S.prefs.aliases || {} });
  const hasAny = (e) => Object.keys(e.names).length || Object.keys(e.aliases).length;

  // Every original account (including ones merged into someone else)
  function mgrAccounts() {
    const origs = {};
    for (const s of [...S.league.seasons].sort((a, b) => a.year - b.year)) for (const t of s.teams) {
      const o = origs[t.key] ||= { key: t.key, manager: t.manager, teams: new Set(), years: [] };
      if (t.manager) o.manager = t.manager; o.teams.add(t.teamName); o.years.push(s.year);
    }
    return origs;
  }
  const canonIn = (aliases) => (k) => { let c = k, n = 0; while (aliases[c] && aliases[c] !== c && n++ < 50) c = aliases[c]; return c; };
  // Flatten merges so every merged account points straight at the person it was merged into
  function flattenDraft(d, origs) {
    const canon = canonIn(d.aliases), aliases = {}, names = { ...d.names };
    for (const k of Object.keys(origs)) {
      const K = canon(k);
      if (K === k) continue;
      aliases[k] = K;
      if (names[k] && !names[K]) names[K] = names[k];
      delete names[k];
    }
    return { names, aliases };
  }
  // Read the open dialog back into the draft
  function syncMgrDraft() {
    const d = S.mgrDraft, origs = mgrAccounts();
    document.querySelectorAll("[data-name]").forEach((i) => { const v = i.value.trim(); if (v) d.names[i.dataset.name] = v; else delete d.names[i.dataset.name]; });
    const picked = {};
    document.querySelectorAll("[data-merge-into]").forEach((sel) => { (picked[sel.dataset.mergeInto] ||= []).push(sel.value); });
    // removals first: an account merged into K that's no longer picked on K's row goes back on its own
    for (const [K, vals] of Object.entries(picked)) for (const [x, to] of Object.entries(d.aliases)) if (to === K && !vals.includes(x)) delete d.aliases[x];
    // additions: picking an account on K's row folds it (and anyone already merged with it) into K
    for (const [K, vals] of Object.entries(picked)) for (const v of vals) {
      if (!v || v === K) continue;
      const canon = canonIn(d.aliases), root = canon(v);
      for (const y of Object.keys(origs)) if (y !== K && canon(y) === root) d.aliases[y] = K;
      delete d.aliases[K];
    }
    S.mgrDraft = flattenDraft(d, origs);
  }

  function managersDlg(fresh = true) {
    const origs = mgrAccounts();
    if (fresh) {
      const server = currentEdits(S.league.edits), legacy = currentEdits({ ...legacyEdits(), v: 1 });
      S.mgrLegacy = !hasAny(server) && hasAny(legacy);
      const src = S.mgrLegacy ? legacy : server;
      S.mgrDraft = flattenDraft({ names: { ...src.names }, aliases: { ...src.aliases } }, origs);
    }
    const ed = S.mgrDraft, all = Object.values(origs);
    const span = (o) => o.years[0] === o.years[o.years.length - 1] ? `${o.years[0]}` : `${o.years[0]}–${o.years[o.years.length - 1]}`;
    const seasonsTxt = (o) => `${o.years.length} season${o.years.length === 1 ? "" : "s"} (${span(o)})`;
    const acct = (o) => o.manager || [...o.teams][0];
    const shown = (o) => ed.names[o.key] || acct(o);
    const people = all.filter((o) => !ed.aliases[o.key]).sort((a, b) => shown(a).localeCompare(shown(b)));
    const membersOf = (K) => all.filter((o) => ed.aliases[o.key] === K);
    const opts = (K, sel) => `<option value="">${sel ? "Remove this account" : "Choose an account…"}</option>` + all.filter((x) => x.key !== K)
      .sort((a, b) => acct(a).localeCompare(acct(b)))
      .map((x) => { const into = ed.aliases[x.key]; const note = into && into !== K ? ` · now part of ${shown(origs[into])}` : "";
        return `<option value="${esc(x.key)}" ${sel === x.key ? "selected" : ""}>${esc(acct(x))} · ${seasonsTxt(x)}${esc(note)}</option>`; }).join("");
    const keepScroll = !fresh && $("dlg").open ? $("dlgBody").scrollTop : null;
    openDlg(`<h3>Managers</h3>
      <p class="sub">${isDemo() ? "This is the demo league, so changes here stay on this page." : "Changes show for <b>everyone with the link</b>. Anyone in the league can edit, and every change can be undone from <b>Change history</b>."}</p>
      <p class="sub"><b>Same person, two accounts?</b> Go to the row of the name you want to keep and pick the other account under <b>Merge in another account</b>. It gets folded into that row and their records combine.</p>
      ${S.mgrLegacy ? `<p class="warnbox">These names were saved only in this browser before names were shared. Tap <b>Save for everyone</b> to share them.</p>` : ""}
      ${people.map((o) => { const mem = membersOf(o.key); return `<div class="mgrrow"><div class="orig"><b>${esc(acct(o))}</b> · ${seasonsTxt(o)} · ${esc([...o.teams].slice(-2).join(", "))}${mem.map((m) => `<br>＋ merged in: <b>${esc(acct(m))}</b> · ${seasonsTxt(m)}`).join("")}</div>
        <div><label class="f" style="margin-top:0" for="nm-${esc(o.key)}">Show as</label><input type="text" maxlength="40" data-name="${esc(o.key)}" id="nm-${esc(o.key)}" value="${esc(ed.names[o.key] || "")}" placeholder="${esc(acct(o))}"></div>
        <div><label class="f" style="margin-top:0">Merge in another account</label>${[...mem.map((m) => m.key), ""].map((k) => `<select data-merge-into="${esc(o.key)}" style="margin-bottom:6px">${opts(o.key, k)}</select>`).join("")}</div></div>`; }).join("")}
      ${isDemo() ? "" : `<label class="f" for="mgrBy">Your name (optional, shown in the change history)</label><input type="text" id="mgrBy" maxlength="30" value="${esc(store.get("flha:by", ""))}">`}
      <div class="actions"><button class="btn" data-act="saveMgrs">${isDemo() ? "Save" : "Save for everyone"}</button>${isDemo() ? "" : `<button class="btn ghost small" data-act="mgrHistory">Change history</button>`}</div>
      <div class="err" id="formErr"></div>`);
    if (keepScroll != null) $("dlgBody").scrollTop = keepScroll;
  }

  async function saveEdits(next, btn) {
    if (isDemo()) { S.league = { ...S.league, edits: { ...next, v: 2 } }; recompute(); closeDlg(); render(); return toast("Managers updated"); }
    const by = $("mgrBy")?.value.trim() || "";
    store.set("flha:by", by);
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const L = fromServer(await api("edit", { slug: S.league.slug, names: next.names, aliases: next.aliases, v: 2, by }));
      delete S.prefs.names; delete S.prefs.aliases; savePrefs();   // shared now, so drop the old browser-only copy
      closeDlg(); replaceLeague(L); toast("Saved for everyone with the link");
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "Save for everyone"; }
      setErr(`Couldn't save: ${err.message}`);
    }
  }

  async function historyDlg() {
    openDlg(`<h3>Change history</h3><div class="loading" style="padding:20px"><div class="spin" aria-hidden="true"></div></div>`);
    let log;
    try { log = (await api("history", { slug: S.league.slug })).log || []; }
    catch (err) { return openDlg(`<h3>Change history</h3><p class="err">${esc(err.message)}</p>`); }
    openDlg(`<h3>Change history</h3>
      <p class="sub">The last ${log.length || ""} name changes for this league, newest first. <b>Undo back to here</b> puts every name back the way it was just before that change (later changes are undone too, and the undo shows up here as its own change).</p>
      ${log.length ? `<div class="list">${log.map((e) => `<div class="item"><span><b>${esc(e.by || "Someone")}</b> <span class="sub">${ago(Date.parse(e.at))}</span><br>${e.changes.map((c) => `<span class="sub">${esc(c)}</span>`).join("<br>")}</span><button class="btn small ghost" data-act="mgrRestore" data-id="${esc(e.id)}">Undo back to here</button></div>`).join("")}</div>`
        : `<p class="sub">No changes yet.</p>`}
      <div class="actions"><button class="btn ghost small" data-act="managers">Back to managers</button></div>`);
  }

  /* ---------------- events ---------------- */
  document.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-act]"); if (!a) return;
    const act = a.dataset.act;
    try {
      switch (act) {
        case "home": e.preventDefault(); closeDlg(); S.pendingEspn = null; S.showShare = false; return renderLanding();
        case "closeDlg": return closeDlg();
        case "demo": return openLeague(FLHDemo.demoLeague());
        case "switch": S.showShare = false; return renderLanding();
        case "tab": S.tab = a.dataset.tab; render(); return window.scrollTo(0, 0);
        case "sort": {
          const k = a.dataset.k;
          S.sort = S.sort.key === k ? { key: k, asc: !S.sort.asc } : { key: k, asc: ["name", "avgFinish", "avgRegFinish", "bestFinish", "paPerGame", "paPerSeason", "pa"].includes(k) };
          return render();
        }
        case "fsort": {
          const k = a.dataset.k;
          S.fsort = S.fsort.key === k ? { key: k, asc: !S.fsort.asc } : { key: k, asc: ["name", "avg", "lasts"].includes(k) };
          const y = window.scrollY; render(); return window.scrollTo(0, y);
        }
        case "ptsMode": S.ptsMode = a.dataset.m; if (/^p[fa]/.test(S.sort.key)) S.sort.key = "avgFinish"; return render();
        case "gotoRival": if (!a.dataset.k) return; closeDlg(); S.tab = "teams"; S.selMgr = a.dataset.k; S.openOpp = null; render(); return window.scrollTo(0, 0);
        case "gotoSeason": closeDlg(); S.tab = "seasons"; S.selYear = Number(a.dataset.year); S.selWeek = null; render(); return window.scrollTo(0, 0);
        case "selMgr": S.selMgr = a.dataset.k; S.openOpp = null; return render();
        case "openOpp": S.openOpp = S.openOpp === a.dataset.k ? null : a.dataset.k; return render();
        case "selYear": S.selYear = Number(a.dataset.y); S.selWeek = null; return render();
        case "week": if (a.dataset.w) { S.selWeek = Number(a.dataset.w); render(); } return;
        case "h2hp": S.prefs.h2hPlayoffs = a.dataset.v === "1"; savePrefs(); recompute(); return render();
        case "cell": {
          const A = a.dataset.a, B = a.dataset.b, c = S.stats.h2h[A][B];
          return openDlg(`<h3>${esc(name(A))} vs ${esc(name(B))}</h3>
            <p class="sub">${esc(name(A))} is ${rec(c.w, c.l, c.t)} · averages ${f1(c.pf / c.games.length)} to ${f1(c.pa / c.games.length)}</p>
            <div class="scroll"><table>${[...c.games].reverse().map((g) => gameLine(g, A)).join("")}</table></div>`);
        }
        case "share": {
          const url = shareUrl(S.league);
          if (navigator.share) { try { await navigator.share({ title: `${S.league.leagueName} · league history`, url }); return; } catch (err) { if (err?.name === "AbortError") return; } }
          try { await navigator.clipboard.writeText(url); toast("Link copied. Paste it in your league chat."); }
          catch {
            S.showShare = true; render();
            const i = $("shareUrl"); i?.focus(); i?.select();
            toast("Copy the link from the box.");
          }
          return;
        }
        case "hideShare": S.showShare = false; return render();
        case "refresh": return refreshLeague();
        case "managers": return managersDlg();
        case "saveMgrs": syncMgrDraft(); return saveEdits(S.mgrDraft, a);
        case "mgrHistory": return historyDlg();
        case "mgrRestore": {
          a.disabled = true; a.textContent = "Undoing…";
          try {
            const L = fromServer(await api("restore", { slug: S.league.slug, id: a.dataset.id, by: store.get("flha:by", "") }));
            replaceLeague(L); toast("Undone for everyone"); return historyDlg();
          } catch (err) { a.disabled = false; a.textContent = "Undo back to here"; return toast(`Couldn't undo: ${err.message}`); }
        }
        case "openRecent": return openSlug(a.dataset.slug);
        case "teamSeason": return teamSeasonDlg(Number(a.dataset.year), a.dataset.k);
        case "jumpRosters": e.preventDefault(); return $("rosters")?.scrollIntoView({ block: "start" });
        case "dYear": S.dYear = Number(a.dataset.y); return render();
        case "dView": S.dView = a.dataset.v; return render();
        case "mvYear": S.mvYear = a.dataset.y === "all" ? "all" : Number(a.dataset.y); S.mvAll = false; S.trAll = false; return render();
        case "trAll": { const y = window.scrollY; S.trAll = true; render(); return window.scrollTo(0, y); }
        case "mvAll": { const y = window.scrollY; S.mvAll = true; render(); return window.scrollTo(0, y); }
        case "mvPick": S.tab = "moves"; S.mvMgr = a.dataset.k; S.mvAll = false; S.trAll = false; render(); return window.scrollTo(0, 0);
        case "movesGo": return fetchMoves();

        /* Sleeper */
        case "sleeperGo": {
          const v = $("slu").value.trim(); setErr("", "sleeperErr");
          if (!v) return setErr("Enter a Sleeper username or league ID.", "sleeperErr");
          if (/^\d{12,22}$/.test(v) || /sleeper\.(app|com)\/leagues?\//.test(v)) return loadLeague("sleeper", v);
          a.disabled = true; a.textContent = "Finding…";
          try {
            const r = await FLHData.sleeperFindLeagues(v);
            $("sleeperOut").innerHTML = r.leagues.length
              ? `<p class="sub" style="margin:12px 0 4px">${esc(r.user)}'s ${r.season} leagues:</p><div class="list">${r.leagues.map((l) => `<div class="item"><span><b>${esc(l.name)}</b><br><span class="sub">${esc(l.teams)} teams</span></span><button class="btn small" data-act="sleeperPick" data-id="${esc(l.id)}">Load history</button></div>`).join("")}</div>`
              : `<p class="sub" style="margin-top:10px">No ${r.season} leagues found for that username.</p>`;
          } catch (err) { setErr(err.message, "sleeperErr"); }
          finally { a.disabled = false; a.textContent = "Find"; }
          return;
        }
        case "sleeperPick": return loadLeague("sleeper", a.dataset.id);

        /* ESPN */
        case "espnPrivate": $("privBox").hidden = false; return a.remove();
        case "espnGo": {
          const league = $("elg").value.trim(), s2 = $("es2")?.value.trim() || "", sw = $("esw")?.value.trim() || "";
          setErr("", "espnErr");
          if (!/leagueId=\d+|^\d{3,12}$/i.test(league)) return setErr("Paste your league's web address. It should contain leagueId= and a number.", "espnErr");
          if (!!s2 !== !!sw) return setErr("Add both cookies (espn_s2 and SWID), or leave both blank.", "espnErr");
          return loadLeague("espn", league, s2 ? { espn_s2: s2, swid: sw } : null, { remember: !!$("erem")?.checked });
        }
        case "askCommishRefresh": {
          const text = commishRefreshMsg(S.league);
          if (navigator.share) { try { await navigator.share({ text }); closeDlg(); return; } catch (err) { if (err?.name === "AbortError") return; } }
          try { await navigator.clipboard.writeText(text); closeDlg(); return toast("Message copied. Paste it in a text to your commissioner or in the league chat."); }
          catch { return toast("Couldn't copy. Try the Share button instead."); }
        }
        case "setupBookmark": {
          closeDlg(); S.showShare = false;
          renderLanding({ showPriv: true, bookmarkOnly: true });
          const box = $("privBox"); box?.scrollIntoView({ block: "start" });
          return;
        }
        case "espnUpdate": {
          const s2 = $("us2").value.trim(), sw = $("usw").value.trim();
          if (!s2 || !sw) return setErr("Paste both cookies (espn_s2 and SWID).");
          const remember = $("urem").checked;
          closeDlg(); return refreshLeague({ espn_s2: s2, swid: sw }, remember);
        }
        case "bmHelp": e.preventDefault(); return toast("Drag it, don't click it. Drop it on your bookmarks bar, then click it while your ESPN league is open.");
        case "bmCopy": await navigator.clipboard?.writeText(espnBookmarklet()); return toast("Bookmark code copied. Paste it as the URL of a new bookmark.");
        case "askCommish": {
          if (navigator.share) { try { await navigator.share({ text: COMMISH_MSG }); } catch { /* cancelled */ } return; }
          await navigator.clipboard?.writeText(COMMISH_MSG);
          return toast("Message copied. Paste it into a text or the league chat.");
        }
      }
    } catch (err) { toast(err.message || String(err)); }
  });
  // Overview slider: update the label while dragging, redraw when let go
  document.addEventListener("input", (e) => {
    if (e.target.id !== "minSeasons") return;
    const v = Number(e.target.value), M = S.stats.managers;
    $("minSeasonsN").textContent = v; $("minSeasonsS").textContent = v === 1 ? "" : "s";
    $("minSeasonsC").textContent = `${M.filter((m) => m.completeSeasons >= v).length} of ${M.length} managers`;
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "minSeasons") {
      S.minSeasons = Number(e.target.value);
      const y = window.scrollY; render(); window.scrollTo(0, y); $("minSeasons")?.focus(); return;
    }
    // picking or removing an account in the Managers dialog redraws it so merged accounts show under their person
    if (e.target.matches?.("[data-merge-into]")) { syncMgrDraft(); return managersDlg(false); }
    if (e.target.id === "mvMgr") { S.mvMgr = e.target.value; S.mvAll = false; S.trAll = false; render(); $("mvMgr")?.focus(); return; }
    if (e.target.id === "weekSel") { S.selWeek = Number(e.target.value); render(); $("weekSel")?.focus(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.id === "slu") document.querySelector('[data-act="sleeperGo"]')?.click();
    if (["elg", "es2", "esw"].includes(e.target.id)) document.querySelector('[data-act="espnGo"]')?.click();
  });
  $("dlg").addEventListener("click", (e) => { if (e.target === $("dlg")) closeDlg(); });

  boot();
})();
