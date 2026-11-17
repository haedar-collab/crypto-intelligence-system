/* CIS web runtime — stands in for the claude.ai artifact runtime (window.claude.use) when the app is hosted as a
   static site (GitHub Pages). The application code in index.html is the same as the artifact; only this file differs.

   Data sources (public, free, read-only — no Binance trading keys are ever requested or used):
     Binance   https://data-api.binance.vision/api/v3   market data only (exchangeInfo, ticker/24hr, klines, depth, aggTrades)
     CoinGecko https://api.coingecko.com/api/v3         coin list with contracts, top-1000 ranks, coin categories
                                                        (optional free "Demo" key raises the rate limit)
     Etherscan https://api.etherscan.io/v2/api          ERC-20 transfers — only with the user's own free API key
   Storage: IndexedDB in this browser. It is NOT a server database: it lives on this device and browser only, is not
   shared or synced, and is lost if site data is cleared. Back it up from the ⚙ panel. */
(() => {
  "use strict";
  const BIN_API = "https://data-api.binance.vision/api/v3";
  const CG_API = "https://api.coingecko.com/api/v3";
  const ES_API = "https://api.etherscan.io/v2/api";
  const KEY_CG = "cis.web.cgKey", KEY_ES = "cis.web.esKey";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ls = { get: (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }, set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} } };
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  /* ---------------- IndexedDB (stores: docs = app documents by path, cache = large reference lists) ---------------- */
  let _idb = null;
  function openIdb() {
    if (_idb) return _idb;
    _idb = new Promise((res) => {
      try {
        const r = indexedDB.open("cis-web", 1);
        r.onupgradeneeded = () => { r.result.createObjectStore("docs"); r.result.createObjectStore("cache"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      } catch (e) { res(null); }
    });
    return _idb;
  }
  async function idbAll(store) {
    const db = await openIdb(); if (!db) return new Map();
    return new Promise((res) => {
      const out = new Map();
      try {
        const rq = db.transaction(store).objectStore(store).openCursor();
        rq.onsuccess = () => { const c = rq.result; if (c) { out.set(c.key, c.value); c.continue(); } else res(out); };
        rq.onerror = () => res(out);
      } catch (e) { res(out); }
    });
  }
  async function idbPut(store, key, val) {
    const db = await openIdb(); if (!db) return false;
    return new Promise((res) => {
      try {
        const tx = db.transaction(store, "readwrite"), st = tx.objectStore(store);
        val === undefined ? st.delete(key) : st.put(val, key);
        tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
      } catch (e) { res(false); }
    });
  }
  async function idbGet(store, key) {
    const db = await openIdb(); if (!db) return undefined;
    return new Promise((res) => { try { const rq = db.transaction(store).objectStore(store).get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(undefined); } catch (e) { res(undefined); } });
  }
  async function idbClear(store) {
    const db = await openIdb(); if (!db) return;
    await new Promise((res) => { try { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).clear(); tx.oncomplete = res; tx.onerror = res; } catch (e) { res(); } });
  }

  /* ---------------- document database with the subset of the artifact db API the app uses ----------------
     doc(path).set/get/delete/onSnapshot, collection(path).orderBy(field, dir).limit(n).onSnapshot.
     Paths alternate collection/document ("journal/abc"); a collection holds the documents exactly one level below it. */
  const DB = {
    docs: new Map(), subs: new Set(), persistent: false,
    ready: null,
    init() {
      if (!this.ready) this.ready = (async () => { const db = await openIdb(); this.persistent = !!db; this.docs = await idbAll("docs"); })();
      return this.ready;
    },
    notify(path) { for (const s of this.subs) if (s.match(path)) queueMicrotask(() => s.fire()); },
    async write(path, val) {
      if (val === undefined) this.docs.delete(path); else this.docs.set(path, val);
      this.notify(path);
      if (this.persistent) { const ok = await idbPut("docs", path, val); if (!ok) throw { code: "storage_error", message: "Browser storage refused the write (storage full or blocked)" }; }
    },
  };
  const parent = (p) => p.slice(0, p.lastIndexOf("/"));
  const leaf = (p) => p.slice(p.lastIndexOf("/") + 1);
  function docSnap(path) { const v = DB.docs.get(path); return { id: leaf(path), exists: v !== undefined, data: () => clone(v), ref: docRef(path) }; }
  function docRef(path) {
    return {
      id: leaf(path), path,
      async set(data) { await DB.init(); await DB.write(path, clone(data)); },
      async update(data) { await DB.init(); const prev = DB.docs.get(path); if (prev === undefined) throw { code: "not_found", message: "No document at " + path }; await DB.write(path, Object.assign(clone(prev), clone(data))); },
      async delete() { await DB.init(); await DB.write(path, undefined); },
      async get() { await DB.init(); return docSnap(path); },
      onSnapshot(cb, onErr) {
        const sub = { match: (p) => p === path, fire: () => { try { cb(docSnap(path)); } catch (e) { if (onErr) onErr(e); } } };
        DB.subs.add(sub); DB.init().then(() => sub.fire());
        return () => DB.subs.delete(sub);
      },
    };
  }
  function query(coll, order, lim, wheres) {
    const run = () => {
      let rows = [];
      for (const [p, v] of DB.docs) if (parent(p) === coll) rows.push({ id: leaf(p), v });
      for (const [f, op, val] of wheres) rows = rows.filter((r) => { const x = r.v && r.v[f]; return op === "==" ? x === val : op === "!=" ? x !== val : op === "<" ? x < val : op === "<=" ? x <= val : op === ">" ? x > val : op === ">=" ? x >= val : op === "in" ? (val || []).includes(x) : true; });
      if (order) { const [f, dir] = order, s = dir === "desc" ? -1 : 1; rows.sort((a, b) => { const x = a.v && a.v[f], y = b.v && b.v[f]; return x === y ? 0 : x == null ? 1 : y == null ? -1 : (x < y ? -1 : 1) * s; }); }
      if (lim != null) rows = rows.slice(0, lim);
      const docs = rows.map((r) => ({ id: r.id, exists: true, data: () => clone(r.v), ref: docRef(coll + "/" + r.id) }));
      return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
    };
    return {
      orderBy: (f, dir) => query(coll, [f, dir || "asc"], lim, wheres),
      limit: (n) => query(coll, order, n, wheres),
      where: (f, op, v) => query(coll, order, lim, wheres.concat([[f, op, v]])),
      doc: (id) => docRef(coll + "/" + id),
      async get() { await DB.init(); return run(); },
      onSnapshot(cb, onErr) {
        let pending = false;
        const sub = { match: (p) => parent(p) === coll, fire: () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; try { cb(run()); } catch (e) { if (onErr) onErr(e); } }); } };
        DB.subs.add(sub); DB.init().then(() => sub.fire());
        return () => DB.subs.delete(sub);
      },
    };
  }
  const dbApi = { doc: (p) => docRef(p), collection: (p) => query(p, null, null, []) };

  /* ---------------- HTTP helpers ---------------- */
  async function getJSON(url, label) {
    let r;
    try { r = await fetch(url); } catch (e) { throw { code: "network", retryable: true, message: `${label}: network error (${e.message || e})` }; }
    if (r.status === 429 || r.status === 418) throw { code: "rate_limited", retryable: true, message: `${label}: rate limit (HTTP ${r.status})` };
    const j = await r.json().catch(() => null);
    if (!r.ok) throw { code: "tool_error", retryable: r.status >= 500, message: `${label}: ${(j && (j.msg || j.error || (j.status && j.status.error_message))) || "HTTP " + r.status}`, status: r.status };
    return j;
  }
  const qs = (params) => Object.entries(params || {}).filter(([, v]) => v != null && v !== "").map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(Array.isArray(v) ? JSON.stringify(v) : String(v))).join("&");

  /* ---------------- Binance public market data ---------------- */
  const BIN_PATH = { "spot.exchangeInfo": "/exchangeInfo", "spot.ticker24hr": "/ticker/24hr", "spot.klines": "/klines", "spot.depth": "/depth", "spot.aggTrades": "/aggTrades" };
  async function binance(tool, input) {
    const path = BIN_PATH[tool]; if (!path) throw { code: "tool_error", message: "Unknown Binance tool " + tool };
    const p = Object.assign({}, input);
    if (path === "/exchangeInfo") { delete p.showPermissionSets; }
    try { return await getJSON(`${BIN_API}${path}?${qs(p)}`, "Binance"); }
    catch (e) {
      // Older mirrors reject optional filters: retry once without them.
      if (e.status === 400 && (p.symbolStatus || p.permissions)) { delete p.symbolStatus; delete p.permissions; return getJSON(`${BIN_API}${path}?${qs(p)}`, "Binance"); }
      throw e;
    }
  }

  /* ---------------- CoinGecko (free public API, throttled queue) ---------------- */
  let cgNext = 0;
  async function cgGet(path, params) {
    const key = ls.get(KEY_CG), gap = key ? 2100 : 6500; // demo key ≈ 30 calls/min; keyless ≈ 5–15 calls/min
    const now = Date.now(), at = Math.max(now, cgNext); cgNext = at + gap;
    if (at > now) await sleep(at - now);
    const url = `${CG_API}${path}?${qs(Object.assign({}, params, key ? { x_cg_demo_api_key: key } : {}))}`;
    for (let k = 0; k < 3; k++) {
      try { return await getJSON(url, "CoinGecko"); }
      catch (e) { if (e.code === "rate_limited" && k < 2) { cgNext = Date.now() + 61e3; await sleep(61e3); continue; } throw Object.assign(e, { retryable: false }); }
    }
  }
  async function cachedList(name, maxAgeMs, load) {
    const c = await idbGet("cache", name);
    if (c && Date.now() - c.at < maxAgeMs) return c.v;
    try { const v = await load(); await idbPut("cache", name, { at: Date.now(), v }); return v; }
    catch (e) { if (c) return c.v; throw e; }
  }
  let _coins = null, _ranks = null;
  const coinList = () => (_coins = _coins || cachedList("cg.coinsList", 7 * 864e5, async () => {
    const all = await cgGet("/coins/list", { include_platform: true });
    return (all || []).map((c) => ({ id: c.id, s: String(c.symbol || "").toUpperCase(), n: c.name, p: c.platforms || {} }));
  }).catch((e) => { _coins = null; throw e; }));
  const rankMap = () => (_ranks = _ranks || cachedList("cg.ranks", 864e5, async () => {
    const m = {};
    for (let page = 1; page <= 4; page++) { const rows = await cgGet("/coins/markets", { vs_currency: "usd", order: "market_cap_desc", per_page: 250, page }); for (const r of rows || []) if (r.market_cap_rank) m[r.id] = r.market_cap_rank; }
    return m;
  }).catch((e) => { _ranks = null; throw e; }));
  async function coingecko(tool, input) {
    if (tool === "search-coingecko") {
      const want = String(input.query || "").toUpperCase(), coins = await coinList(), ranks = await rankMap().catch(() => ({}));
      const hits = coins.filter((c) => c.s === want);
      if (input.type === "token") {
        const ch = input.chain; if (!ch) throw { code: "tool_error", message: "CoinGecko token search needs a chain" };
        const cands = hits.filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c.p[ch] || "")).map((c) => ({ identity: { type: "token", chain: ch, address: c.p[ch].toLowerCase() }, name: c.n, symbol: c.s, marketCapRank: ranks[c.id] || null, canonicalCoinId: c.id }));
        return { status: cands.length === 1 ? "resolved" : cands.length ? "ambiguous" : "not_found", selected: cands.length === 1 ? cands[0] : null, candidates: cands.length === 1 ? [] : cands, message: null, warnings: [] };
      }
      const cands = hits.map((c) => ({ identity: { type: "coin", id: c.id }, name: c.n, symbol: c.s, marketCapRank: ranks[c.id] || null })).sort((a, b) => (a.marketCapRank || 1e9) - (b.marketCapRank || 1e9));
      return { status: cands.length === 1 ? "resolved" : cands.length ? "ambiguous" : "not_found", selected: cands.length === 1 ? cands[0] : null, candidates: cands.length === 1 ? [] : cands, message: null, warnings: [] };
    }
    if (tool === "get-coin-info") {
      const c = await cgGet("/coins/" + encodeURIComponent(input.id), { localization: false, tickers: false, market_data: false, community_data: false, developer_data: false, sparkline: false });
      return { id: c.id, name: c.name, symbol: String(c.symbol || "").toUpperCase(), categories: (c.categories || []).filter(Boolean), links: { homepage: ((c.links && c.links.homepage) || []).filter(Boolean) } };
    }
    if (tool === "get-crypto-news") throw { code: "server_not_connected", message: "No free headline source is connected in the web version" };
    throw { code: "tool_error", message: "Unknown CoinGecko tool " + tool };
  }

  /* ---------------- Etherscan (user's own free key; per-second limit handled here) ---------------- */
  let esNext = 0;
  async function etherscan(tool, input) {
    const key = ls.get(KEY_ES); if (!key) throw { code: "server_not_connected", message: "Add an Etherscan API key in ⚙ to read on-chain transfers" };
    if (tool !== "get_token_transfers") throw { code: "tool_error", message: "Unknown Etherscan tool " + tool };
    const p = { chainid: input.chainid || 1, module: "account", action: "tokentx", contractaddress: input.contractaddress, page: input.page || 1, offset: input.offset || 1000, sort: input.sort || "desc", apikey: key };
    for (let k = 0; k < 4; k++) {
      const now = Date.now(), at = Math.max(now, esNext); esNext = at + 260; if (at > now) await sleep(at - now);
      const j = await getJSON(`${ES_API}?${qs(p)}`, "Etherscan");
      const msg = String((j && (typeof j.result === "string" ? j.result : j.message)) || "");
      if (j && j.status === "1") return { status: "1", message: "OK", result: j.result };
      if (/no transactions found/i.test(msg)) return { status: "0", message: "No transactions found", result: [] };
      if (/per sec|max calls per/i.test(msg)) { await sleep(1100); continue; } // per-second cap: wait and retry (not the 12-hour cap)
      if (/invalid api key|missing/i.test(msg)) throw { code: "needs_reauth", message: "Etherscan rejected the API key: " + msg };
      if (/daily|rate limit/i.test(msg)) throw { code: "rate_limited", message: "Etherscan daily rate limit: " + msg };
      throw { code: "tool_error", message: "Etherscan: " + msg };
    }
    throw { code: "tool_error", message: "Etherscan: per-second limit kept failing" };
  }

  /* ---------------- mcp namespace (callTool / listTools) with an in-memory response cache ---------------- */
  const respCache = new Map();
  const TOOLS = { Binance: Object.keys(BIN_PATH), CoinGecko: ["search-coingecko", "get-coin-info"], Etherscan: ["get_token_transfers"] };
  const mcp = {
    async listTools(server) {
      const tools = server === "Etherscan" && !ls.get(KEY_ES) ? [] : (TOOLS[server] || []);
      return { servers: [{ server, tools: tools.map((name) => ({ name })) }] };
    },
    async callTool(server, tool, input, opts) {
      const stale = opts && opts.cache && opts.cache.staleTime, key = server + "|" + tool + "|" + JSON.stringify(input || {});
      const hit = respCache.get(key);
      if (stale && hit && Date.now() - hit.at < stale) return { payload: hit.payload, cache: { storedAt: hit.at } };
      const fn = server === "Binance" ? binance : server === "CoinGecko" ? coingecko : server === "Etherscan" ? etherscan : null;
      if (!fn) throw { code: "server_not_found", message: "Unknown source " + server };
      const payload = await fn(tool, input || {});
      if (stale) { respCache.set(key, { at: Date.now(), payload }); if (respCache.size > 3000) respCache.delete(respCache.keys().next().value); }
      return { payload };
    },
  };

  /* ---------------- downloads ---------------- */
  const downloads = {
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], { type: mimeType || (/\.json$/i.test(filename) ? "application/json" : /\.csv$/i.test(filename) ? "text/csv" : "text/plain") });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename || "download.txt";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { status: "saved" };
    },
  };

  window.CIS_WEB = { version: "1.0.0", storage: "IndexedDB (this browser only)", DB, idbClear };
  window.claude = Object.freeze({
    use: async (name) => {
      if (name === "db") { await DB.init(); return dbApi; }
      if (name === "mcp") return mcp;
      if (name === "downloads") return downloads;
      return null;
    },
  });

  /* ---------------- ⚙ panel: API keys, backup / restore, local-data notice ---------------- */
  function panel() {
    const css = document.createElement("style");
    css.textContent = `#cisWebBtn{position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:max(12px,env(safe-area-inset-bottom,0px));z-index:60;background:var(--panel,#121820);color:var(--fg,#dbe3ec);border:1px solid var(--line2,#2f3b49);border-radius:999px;padding:8px 12px;font:600 12px/1 Inter,system-ui,sans-serif;cursor:pointer}
#cisWebBtn:hover{border-color:var(--amber,#f0b90b)}
#cisWeb{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
#cisWeb .box{background:var(--panel,#121820);color:var(--fg,#dbe3ec);border:1px solid var(--line2,#2f3b49);border-radius:10px;max-width:560px;width:100%;max-height:90vh;overflow:auto;padding:18px;display:grid;gap:12px;font:13px/1.5 Inter,system-ui,sans-serif}
#cisWeb h2{margin:0;font:600 16px/1.2 'Space Grotesk',Inter,sans-serif}#cisWeb h3{margin:4px 0 0;font:600 13px/1.2 Inter,sans-serif}
#cisWeb label{display:grid;gap:4px;font-size:12px;color:var(--muted,#8a99aa)}#cisWeb input[type=password],#cisWeb input[type=text]{background:var(--sunk,#18202a);color:var(--fg,#dbe3ec);border:1px solid var(--line2,#2f3b49);border-radius:6px;padding:7px 9px;font:12px 'JetBrains Mono',monospace}
#cisWeb .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}#cisWeb button{background:var(--sunk,#18202a);color:var(--fg,#dbe3ec);border:1px solid var(--line2,#2f3b49);border-radius:6px;padding:7px 11px;font:600 12px Inter,sans-serif;cursor:pointer}
#cisWeb button.pri{border-color:var(--amber,#f0b90b);color:var(--amber,#f0b90b)}#cisWeb button.bad{border-color:var(--neg,#f6465d);color:var(--neg,#f6465d)}#cisWeb .note{font-size:12px;color:var(--muted,#8a99aa)}#cisWeb .msg{font-size:12px;color:var(--amber,#f0b90b);min-height:1em}`;
    document.head.appendChild(css);
    const btn = document.createElement("button"); btn.id = "cisWebBtn"; btn.type = "button"; btn.textContent = "⚙ Web"; btn.title = "API keys, backup and local storage";
    document.body.appendChild(btn);
    btn.addEventListener("click", open);
  }
  const IDT = { "Web version settings": "Pengaturan versi web", "This copy runs on a static website. Market data comes straight from Binance's public market-data API, coin categories from CoinGecko's free API and on-chain transfers from Etherscan with your own key. No Binance account keys are needed or accepted, and no orders can be placed.": "Salinan ini berjalan di situs statis. Data pasar langsung dari API data pasar publik Binance, kategori coin dari API gratis CoinGecko, dan transfer on-chain dari Etherscan dengan key Anda sendiri. Tidak perlu dan tidak menerima API key akun Binance, dan tidak bisa menempatkan order.", "Storage": "Penyimpanan", "Download backup (.json)": "Unduh backup (.json)", "Restore backup": "Pulihkan backup", "API keys (optional, stored in this browser)": "API key (opsional, disimpan di browser ini)", "CoinGecko Demo API key — raises the free rate limit for coin categories": "CoinGecko Demo API key — menaikkan batas gratis untuk kategori coin", "Etherscan API key — enables on-chain transfer metrics (free at etherscan.io)": "Etherscan API key — mengaktifkan metrik transfer on-chain (gratis di etherscan.io)", "Save keys and reload": "Simpan key dan muat ulang", "Close": "Tutup", "Reset": "Reset", "Delete all local data…": "Hapus semua data lokal…", "Yes, delete": "Ya, hapus" };
  const tr = (x) => (document.querySelector('[data-lang="id"][aria-pressed="true"]') && IDT[x]) || x;
  const idOn = () => !!document.querySelector('[data-lang="id"][aria-pressed="true"]');
  function open() {
    if (document.getElementById("cisWeb")) return;
    const n = DB.docs.size, w = document.createElement("div"); w.id = "cisWeb";
    w.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-labelledby="cisWebT">
      <h2 id="cisWebT">${tr("Web version settings")}</h2>
      <p class="note">${tr("This copy runs on a static website. Market data comes straight from Binance's public market-data API, coin categories from CoinGecko's free API and on-chain transfers from Etherscan with your own key. No Binance account keys are needed or accepted, and no orders can be placed.")}</p>
      <h3>${tr("Storage")}</h3>
      <p class="note">${DB.persistent ? (idOn() ? `Journal, watchlist, pengaturan dan riwayat disimpan <b>hanya di browser ini</b> (IndexedDB, ${n} dokumen). Ini bukan database server: tidak dibagikan atau disinkronkan, dan ikut terhapus kalau data situs dibersihkan. Lakukan backup secara rutin.` : `Your journal, watchlist, settings and history are kept in <b>this browser only</b> (IndexedDB, ${n} documents). It is not a server database: nothing is shared or synced, and clearing site data deletes it. Back up regularly.`) : (idOn() ? `<b>Penyimpanan browser tidak tersedia</b> (jendela privat atau data situs diblokir). Semua data hilang saat tab ditutup.` : `<b>Browser storage is not available</b> (private window or blocked site data). Everything is lost when this tab closes.`)}</p>
      <div class="row"><button type="button" id="cwExport" class="pri">${tr("Download backup (.json)")}</button><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><span>${tr("Restore backup")}</span><input type="file" id="cwImport" accept="application/json,.json"></label></div>
      <h3>${tr("API keys (optional, stored in this browser)")}</h3>
      <label>${tr("CoinGecko Demo API key — raises the free rate limit for coin categories")}<input type="password" id="cwCg" autocomplete="off" value=""></label>
      <label>${tr("Etherscan API key — enables on-chain transfer metrics (free at etherscan.io)")}<input type="password" id="cwEs" autocomplete="off" value=""></label>
      <div class="row"><button type="button" id="cwSave" class="pri">${tr("Save keys and reload")}</button><button type="button" id="cwClose">${tr("Close")}</button></div>
      <h3>${tr("Reset")}</h3>
      <div class="row"><button type="button" id="cwWipe" class="bad">${tr("Delete all local data…")}</button><span id="cwWipeAsk"></span></div>
      <div class="msg" id="cwMsg"></div></div>`;
    document.body.appendChild(w);
    const $ = (id) => document.getElementById(id), msg = (t) => { $("cwMsg").textContent = t; };
    $("cwCg").value = ls.get(KEY_CG); $("cwEs").value = ls.get(KEY_ES);
    const close = () => w.remove();
    w.addEventListener("click", (e) => { if (e.target === w) close(); });
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } });
    $("cwClose").onclick = close;
    $("cwSave").onclick = () => { ls.set(KEY_CG, $("cwCg").value.trim()); ls.set(KEY_ES, $("cwEs").value.trim()); location.reload(); };
    $("cwExport").onclick = async () => {
      await DB.init();
      const out = { app: "crypto-intelligence-system-web", version: 1, exportedAt: new Date().toISOString(), docs: Object.fromEntries(DB.docs) };
      await downloads.save({ filename: `cis-backup-${new Date().toISOString().slice(0, 10)}.json`, data: JSON.stringify(out) });
      msg(idOn() ? `Backup tersimpan (${DB.docs.size} dokumen).` : `Backup saved (${DB.docs.size} documents).`);
    };
    $("cwImport").onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j || j.app !== "crypto-intelligence-system-web" || typeof j.docs !== "object") throw new Error("Not a CIS web backup file");
        await DB.init(); let k = 0;
        for (const [p, v] of Object.entries(j.docs)) { if (typeof p === "string" && p.split("/").length % 2 === 0) { await DB.write(p, v); k++; } }
        msg(`Restored ${k} documents. Reloading…`); setTimeout(() => location.reload(), 800);
      } catch (er) { msg("Restore failed: " + (er.message || er)); }
    };
    $("cwWipe").onclick = () => {
      $("cwWipeAsk").innerHTML = `<span class="note">${idOn() ? `Hapus ${DB.docs.size} dokumen dari browser ini?` : `Delete ${DB.docs.size} documents from this browser?`}</span> <button type="button" id="cwWipeOk" class="bad">${tr("Yes, delete")}</button>`;
      $("cwWipeOk").onclick = async () => { await idbClear("docs"); await idbClear("cache"); DB.docs = new Map(); msg("Local data deleted. Reloading…"); setTimeout(() => location.reload(), 600); };
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", panel); else panel();
})();
