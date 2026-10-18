/* RadDeck — app
 *
 * Data lives in IndexedDB on this device and syncs to the Worker's R2 bucket
 * when you're signed in with the admin token. Every change goes into an
 * outbox first, so nothing is lost if you're offline or signed out; the
 * outbox flushes as soon as sync is possible.
 *
 *   decks   one doc per module: { cards: [{ id, front, back, tags, type, srs }], updatedAt }
 *   user    { settings, log: { "YYYY-MM-DD": { reviews, again, new, rev, revPass, time } }, updatedAt }
 *   pods    { items: { [moduleId]: { step, due, last, count } }, updatedAt }
 */
(function () {
  "use strict";

  /* ================= basics ================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + "s"}`;
  const { DAY, MIN } = FSRS;
  const ROLLOVER_H = 4; // a study day runs 4am to 4am, like Anki
  const LEARN_AHEAD = 20 * MIN;
  const POD_FIRST = { 1: 1, 3: 2, 4: 4 };      // days until the 2nd listen, by rating
  const POD_GROW = { 1: 0.5, 3: 2.2, 4: 3.5 };    // how the gap changes after each rated listen
  const POD_MAX = 180;
  const POD_LADDER = [1, 3, 7, 14, 30, 60, 120]; // old fixed schedule, only used to convert old data
  const POD_RATINGS = [[1, "Felt new"], [3, "Familiar"], [4, "Knew it well"]];
  const LATER_MS = 24 * 3600 * 1000;              // "Later" hides a card this long
  const AHEAD_DAYS = 3;                           // "Review ahead" pulls in cards due this many days early
  const SQL_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/";
  const ZSTD_CDN = "https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js";

  /* Chapters come from chapters.js, plus a Miscellaneous chapter of your own topics. */
  const CH = window.CHAPTERS;
  const MISC = { id: "misc", num: "", name: "Miscellaneous", modules: [] };
  let CHAPS = [];
  const MODS = [];
  const MOD = {};
  function rebuildMods() {
    MODS.length = 0;
    for (const k of Object.keys(MOD)) delete MOD[k];
    MISC.modules = (S.user.custom || []).map((c) => ({ id: c.id, name: c.name, custom: true }));
    CHAPS = [...CH, MISC];
    CHAPS.forEach((c) => c.modules.forEach((m) => { const o = { ...m, ch: c, idx: MODS.length }; MODS.push(o); MOD[m.id] = o; }));
  }

  function dayStart(ts = Date.now()) {
    const d = new Date(ts);
    if (d.getHours() < ROLLOVER_H) d.setDate(d.getDate() - 1);
    d.setHours(ROLLOVER_H, 0, 0, 0);
    return d.getTime();
  }
  function nextDayStart(ts = Date.now()) {
    const d = new Date(dayStart(ts));
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  function dayKey(ts = Date.now()) {
    const d = new Date(dayStart(ts));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function textOf(html) {
    const t = String(html || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ");
    const ta = document.createElement("textarea"); ta.innerHTML = t;
    return ta.value.replace(/\s+/g, " ").trim();
  }
  function fmtBytes(n) { if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`; if (n > 1024) return `${Math.round(n / 1024)} KB`; return `${n} B`; }
  function relDay(ts) {
    const diff = Math.round((dayStart(ts) - dayStart()) / DAY);
    if (diff <= 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff < 30) return `in ${diff} days`;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function mimeFor(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      bmp: "image/bmp", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff", mp3: "audio/mpeg", m4a: "audio/mp4",
      aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac" })[ext] || "application/octet-stream";
  }
  let toastT;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200); }

  /* ================= IndexedDB ================= */
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open("raddeck6", 1);
        r.onupgradeneeded = () => { for (const s of ["kv", "decks", "blobs"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const q = fn(t.objectStore(store));
        t.oncomplete = () => res(q && "result" in q ? q.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error("Storage write aborted (is the disk full?)"));
      });
    },
    get(s, k) { return this.tx(s, "readonly", (o) => o.get(k)); },
    put(s, k, v) { return this.tx(s, "readwrite", (o) => o.put(v, k)); },
    del(s, k) { return this.tx(s, "readwrite", (o) => o.delete(k)); },
    keys(s) { return this.tx(s, "readonly", (o) => o.getAllKeys()); },
    async entries(s) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const out = []; const t = db.transaction(s);
        const c = t.objectStore(s).openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { out.push([cur.key, cur.value]); cur.continue(); } };
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
      });
    },
    clear(s) { return this.tx(s, "readwrite", (o) => o.clear()); },
  };

  /* ================= state ================= */
  const DEFAULT_SETTINGS = { newPerDay: 20, retention: 0.9, theme: "auto" };
  const S = {
    decks: {},
    user: { settings: { ...DEFAULT_SETTINGS }, log: {}, custom: [], updatedAt: 0 },
    pods: { items: {}, updatedAt: 0 },
    localAudio: new Set(),
    serverAudio: {},
    outbox: new Map(),
    token: lsGet("rd_token"),
    online: false,      // Worker API reachable
    authOk: false,      // token accepted
    adminConfigured: true,
    syncing: false,
    syncError: null,
    lastSync: 0,
    base: {},           // server version of each doc this device has already merged
  };
  function persistBase() { idb.put("kv", "base", S.base).catch(() => {}); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } }

  function validSrs(s) { return s && typeof s === "object" && typeof s.state === "string" && typeof s.due === "number"; }
  function normalizeDeck(d) {
    const cards = (d && Array.isArray(d.cards) ? d.cards : []).map((c, i) => ({
      id: String(c.id ?? c.cardId ?? "x" + hash(String(c.front ?? "") + i)),
      front: String(c.front ?? c.q ?? ""),
      back: String(c.back ?? c.a ?? ""),
      tags: Array.isArray(c.tags) ? c.tags : [],
      type: c.type === "cloze" || c.kind === "cloze" ? "cloze" : "basic",
      srs: validSrs(c.srs) ? c.srs : FSRS.fresh(),
      added: Number(c.added) || 0,
      buriedUntil: Number(c.buriedUntil) || 0,
    })).filter((c) => c.front);
    return { cards, updatedAt: Number(d && d.updatedAt) || 0 };
  }
  function normalizeUser(u) {
    const s = (u && u.settings) || {};
    return {
      settings: {
        newPerDay: Number.isFinite(+s.newPerDay) ? Math.max(0, Math.min(999, +s.newPerDay)) : DEFAULT_SETTINGS.newPerDay,
        retention: [0.85, 0.9, 0.95].includes(+s.retention) ? +s.retention : DEFAULT_SETTINGS.retention,
        theme: ["auto", "light", "dark"].includes(s.theme) ? s.theme : "auto",
      },
      log: u && u.log && typeof u.log === "object" && !Array.isArray(u.log) ? u.log : {},
      custom: Array.isArray(u && u.custom)
        ? u.custom.filter((c) => c && /^misc-[a-z0-9-]{1,60}$/.test(c.id) && typeof c.name === "string")
            .map((c) => ({ id: c.id, name: c.name.slice(0, 120), created: Number(c.created) || 0 }))
        : [],
      deletedCustom: Array.isArray(u && u.deletedCustom) ? u.deletedCustom.filter((x) => typeof x === "string").slice(-500) : [],
      updatedAt: Number(u && u.updatedAt) || 0,
    };
  }
  function normalizePods(p) {
    const items = {};
    const src = p && p.items && typeof p.items === "object" ? p.items : {};
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v.due !== "number") continue;
      const ivl = Number(v.ivl) || POD_LADDER[Math.min(Number(v.step) || 0, POD_LADDER.length - 1)];
      items[k] = { ivl, due: v.due, last: Number(v.last) || 0, count: Number(v.count) || 1 };
    }
    return { items, updatedAt: Number(p && p.updatedAt) || 0 };
  }

  function today() {
    const k = dayKey();
    return (S.user.log[k] ||= { reviews: 0, again: 0, new: 0, rev: 0, revPass: 0, time: 0, extraNew: 0 });
  }

  /* ================= persistence + outbox ================= */
  async function saveDeck(mid) {
    const d = S.decks[mid]; if (!d) return;
    d.updatedAt = Date.now();
    await idb.put("decks", mid, d);
    queue("deck:" + mid);
  }
  async function saveUser() { S.user.updatedAt = Date.now(); await idb.put("kv", "user", S.user); queue("user"); }
  async function savePods() { S.pods.updatedAt = Date.now(); await idb.put("kv", "pods", S.pods); queue("pods"); }

  const OPPOSITE = { deck: "deldeck", deldeck: "deck", audio: "delaudio", delaudio: "audio" };
  function queue(op, delay = 4000) {
    const [kind, ...rest] = op.split(":");
    if (OPPOSITE[kind]) S.outbox.delete(OPPOSITE[kind] + ":" + rest.join(":"));
    S.outbox.set(op, (S.outbox.get(op) || 0) + 1);
    persistOutbox();
    scheduleFlush(delay);
    renderSync();
  }
  function persistOutbox() { idb.put("kv", "outbox", [...S.outbox.entries()]).catch(() => {}); }

  /* ================= API ================= */
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    if (S.token && opts.auth !== false) headers.authorization = "Bearer " + S.token;
    const r = await fetch(path, { ...opts, headers });
    if (!r.ok) {
      let msg = `Request failed (${r.status})`;
      try { const j = await r.json(); msg = j.message || msg; } catch { /* not json */ }
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r;
  }
  const getJSON = async (p) => (await api(p, { auth: false })).json();
  const putJSON = (p, data) => api(p, { method: "PUT", body: JSON.stringify(data), headers: { "content-type": "application/json" } });

  function xhrPut(url, body, headers, onProgress) {
    return new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => {
        if (x.status < 300) return res();
        let msg = `Upload failed (${x.status})`;
        try { msg = JSON.parse(x.responseText).message || msg; } catch { /* ignore */ }
        const e = new Error(msg); e.status = x.status; rej(e);
      };
      x.onerror = () => rej(new Error("Network error during upload. Check your connection and try again."));
      x.send(body);
    });
  }

  /* ================= sync ================= */
  let flushTimer = null;
  function scheduleFlush(delay = 4000) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, delay); }
  const canSync = () => S.online && S.authOk;

  async function flush() {
    if (S.syncing || !canSync() || !S.outbox.size) return;
    S.syncing = true; S.syncError = null; renderSync();
    try {
      // small docs first, then decks, then binaries
      if ([...S.outbox.keys()].some((op) => /^(user|pods|deck:)/.test(op))) await pull();
      const rank = (op) => (op.startsWith("user") || op.startsWith("pods") ? 0 : op.startsWith("deck") || op.startsWith("del") ? 1 : 2);
      const ops = [...S.outbox.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
      for (const [op, seq] of ops) {
        const [kind, ...rest] = op.split(":");
        const arg = rest.join(":");
        if (kind === "user") { await putJSON("/api/flashcards/user", S.user); S.base.user = S.user.updatedAt; }
        else if (kind === "pods") { await putJSON("/api/flashcards/podcasts", S.pods); S.base.pods = S.pods.updatedAt; }
        else if (kind === "deck") { if (S.decks[arg]) { await putJSON(`/api/flashcards/cards/${arg}`, S.decks[arg]); S.base["deck:" + arg] = S.decks[arg].updatedAt; } }
        else if (kind === "deldeck") { await api(`/api/flashcards/cards/${arg}`, { method: "DELETE" }); delete S.base["deck:" + arg]; }
        else if (kind === "media") {
          const b = await idb.get("blobs", "media/" + arg);
          const [mid, ...n] = arg.split("/");
          if (b) await api(`/api/media/${mid}/${encodeURIComponent(n.join("/"))}`, { method: "PUT", body: b, headers: { "content-type": b.type || "application/octet-stream" } });
        } else if (kind === "audio") {
          const b = await idb.get("blobs", "audio/" + arg);
          if (b) {
            await xhrPut(`/api/audio/${arg}`, b, { authorization: "Bearer " + S.token, "content-type": b.type || "audio/mpeg", "x-filename": encodeURIComponent(b.name || arg) });
            S.serverAudio[arg] = { size: b.size, filename: b.name || arg, uploadedAt: Date.now() };
          }
        } else if (kind === "delaudio") { await api(`/api/audio/${arg}`, { method: "DELETE" }); delete S.serverAudio[arg]; }
        if (S.outbox.get(op) === seq) S.outbox.delete(op); // changed while uploading? keep it queued
        persistOutbox();
        persistBase();
      }
      S.lastSync = Date.now();
    } catch (e) {
      if (e.status === 401) { S.authOk = false; S.syncError = "Your admin token was rejected. Sign in again in Settings."; }
      else S.syncError = e.message || "Sync failed";
    } finally {
      S.syncing = false; renderSync();
      if (S.outbox.size && canSync() && !S.syncError) scheduleFlush(1500);
    }
  }

  /* ---------- merging: newest change per card wins, so no device overwrites another ---------- */
  function mergeDeck(local, remote) {
    const byId = new Map(local.cards.map((c) => [c.id, c]));
    for (const rc of normalizeDeck(remote).cards) {
      const lc = byId.get(rc.id);
      if (!lc) { local.cards.push(rc); byId.set(rc.id, rc); continue; }
      const rl = rc.srs.last || 0, ll = lc.srs.last || 0;
      // update in place so a study session holding this card sees the change
      if (rl > ll || (rl === ll && rc.buriedUntil > lc.buriedUntil)) Object.assign(lc, rc);
    }
  }
  function mergePods(local, remote) {
    for (const [k, v] of Object.entries(normalizePods(remote).items)) {
      const l = local.items[k];
      if (!l || v.last > l.last) local.items[k] = v;
    }
  }
  function mergeUser(local, remote) {
    const r = normalizeUser(remote);
    if (r.updatedAt > local.updatedAt) local.settings = r.settings;
    for (const [day, e] of Object.entries(r.log)) {
      const l = local.log[day];
      if (!l || (e.reviews || 0) > (l.reviews || 0)) local.log[day] = { ...e, extraNew: Math.max(e.extraNew || 0, (l && l.extraNew) || 0) };
    }
    const gone = new Set([...(local.deletedCustom || []), ...r.deletedCustom]);
    const mine = new Map(local.custom.map((c) => [c.id, c]));
    for (const c of r.custom) {
      if (!mine.has(c.id)) local.custom.push(c);
      else if (r.updatedAt > local.updatedAt) mine.get(c.id).name = c.name;
    }
    local.custom = local.custom.filter((c) => !gone.has(c.id));
    local.deletedCustom = [...gone];
  }

  /* Bring in anything another device saved since we last looked, merging it with this device's data. */
  async function pull() {
    const man = await getJSON("/api/flashcards");
    S.serverAudio = man.audio || {};
    const pending = (op) => S.outbox.has(op);
    // after a merge, a doc with unsent local changes gets a fresh timestamp so other devices fetch the merged copy
    const stamp = (doc, op, serverAt) => { doc.updatedAt = pending(op) ? Date.now() : Math.max(doc.updatedAt || 0, serverAt); };

    const su = (man.user && man.user.updatedAt) || 0;
    if (su > (S.base.user || 0)) {
      const u = await getJSON("/api/flashcards/user");
      if (u) { mergeUser(S.user, u); stamp(S.user, "user", su); await idb.put("kv", "user", S.user); rebuildMods(); applyTheme(); }
      S.base.user = su;
    }
    if (S.user.updatedAt > su && S.user.updatedAt > 0) queue("user");

    const sp = (man.podcasts && man.podcasts.updatedAt) || 0;
    if (sp > (S.base.pods || 0)) {
      const pd = await getJSON("/api/flashcards/podcasts");
      if (pd) { mergePods(S.pods, pd); stamp(S.pods, "pods", sp); await idb.put("kv", "pods", S.pods); }
      S.base.pods = sp;
    }
    if (S.pods.updatedAt > sp && S.pods.updatedAt > 0) queue("pods");

    const remote = man.cards || {};
    for (const [mid, info] of Object.entries(remote)) {
      if (pending("deldeck:" + mid)) continue;
      const key = "deck:" + mid;
      if (info.updatedAt > (S.base[key] || 0) || !S.decks[mid]) {
        const d = await getJSON(`/api/flashcards/cards/${mid}`);
        if (S.decks[mid]) mergeDeck(S.decks[mid], d);
        else S.decks[mid] = normalizeDeck(d);
        stamp(S.decks[mid], key, info.updatedAt || 1);
        await idb.put("decks", mid, S.decks[mid]);
        S.base[key] = info.updatedAt;
      }
      if (S.decks[mid].updatedAt > info.updatedAt) queue(key);
    }
    // decks deleted on another device
    for (const mid of Object.keys(S.decks)) {
      if (!(mid in remote) && !pending("deck:" + mid)) { delete S.decks[mid]; delete S.base["deck:" + mid]; await idb.del("decks", mid); }
    }
    persistBase();
    pruneSession();
  }

  /* If a pull changed cards that an open study session was holding, drop the ones no longer due. */
  function pruneSession() {
    if (typeof session === "undefined" || !session || session.finished) return;
    const now = Date.now();
    const end = session.ahead ? addDays(nextDayStart(now), AHEAD_DAYS) : nextDayStart(now);
    const ok = (p) => !isLater(p[1], now) && (p[1].srs.state === "new" || p[1].srs.due < end);
    session.reviews = session.reviews.filter((p) => p[1].srs.state === "review" && ok(p));
    session.fresh = session.fresh.filter((p) => p[1].srs.state === "new" && ok(p));
    session.learning = session.learning.filter((p) => p[1].srs.state !== "review" && p[1].srs.state !== "new" && ok(p));
    if (session.current && !ok(session.current)) { session.current = null; session.revealed = false; session.stale = true; }
  }

  async function connect() {
    try {
      const h = await (await fetch("/api/health", { cache: "no-store" })).json();
      S.online = Boolean(h && h.ok);
      S.adminConfigured = Boolean(h.adminConfigured);
    } catch { S.online = false; }
    if (S.online && S.token) {
      try { await api("/api/auth", { method: "POST" }); S.authOk = true; }
      catch (e) { S.authOk = false; if (e.status === 401) S.syncError = "Your admin token was rejected. Sign in again in Settings."; }
    }
    if (S.online) {
      S.syncing = true; renderSync();
      try { await pull(); S.lastSync = Date.now(); }
      catch (e) { S.syncError = "Couldn't load from the server: " + e.message; }
      S.syncing = false;
    }
    renderSync();
    if (canSync()) flush();
  }

  function renderSync() {
    const el = $("#sync"); if (!el) return;
    const label = el.querySelector("span");
    el.classList.toggle("busy", S.syncing);
    el.classList.toggle("on", canSync() && !S.syncError);
    let text, title;
    if (S.syncing) { text = "Syncing"; title = "Saving to your Cloudflare storage"; }
    else if (!S.online) { text = "This device"; title = "Saved on this device. The sync server isn't reachable."; }
    else if (!S.authOk) { text = "Sign in to sync"; title = "Progress is saved on this device only until you sign in."; }
    else if (S.syncError) { text = "Sync paused"; title = S.syncError; }
    else if (S.outbox.size) { text = "Saving…"; title = `${S.outbox.size} change(s) waiting to sync`; }
    else { text = "Synced"; title = S.lastSync ? `Last synced ${new Date(S.lastSync).toLocaleTimeString()}` : "Up to date"; }
    label.textContent = text; el.title = title;
    if (location.hash.startsWith("#/settings")) { const s = $("#sync-detail"); if (s) s.textContent = title; }
  }

  /* ================= cards: counting + queues ================= */
  function cardsOf(mid) {
    if (mid) return (S.decks[mid] ? S.decks[mid].cards : []).map((c) => [mid, c]);
    const out = [];
    for (const m of MODS) if (S.decks[m.id]) for (const c of S.decks[m.id].cards) out.push([m.id, c]);
    return out;
  }
  function newLimitLeft() {
    const t = S.user.log[dayKey()];
    const used = t ? t.new : 0;
    const extra = t ? t.extraNew || 0 : 0;
    return Math.max(0, S.user.settings.newPerDay + extra - used);
  }
  const isLater = (card, now) => card.buriedUntil > now;
  function counts(mid) {
    const now = Date.now();
    const end = nextDayStart(now);
    const aheadEnd = addDays(end, AHEAD_DAYS);
    const c = { total: 0, review: 0, learning: 0, new: 0, unseen: 0, mature: 0, young: 0, later: 0, ahead: 0 };
    for (const [, card] of cardsOf(mid)) {
      c.total++;
      const s = card.srs;
      if (s.state === "review" && s.s >= 21) c.mature++;
      if (isLater(card, now)) { c.later++; continue; }
      if (s.state === "new") { c.unseen++; continue; }
      if (s.state === "review") { if (s.due < end) c.review++; else if (s.due < aheadEnd) c.ahead++; if (s.s < 21) c.young++; }
      else { if (s.due < end) c.learning++; c.young++; }
    }
    c.new = Math.min(c.unseen, newLimitLeft());
    c.due = c.review + c.learning + c.new;
    c.moreNew = c.unseen - c.new; // new cards beyond today's limit
    return c;
  }

  /* opts.ahead: also include review cards due in the next AHEAD_DAYS days (no new cards). */
  function buildSession(mid, opts = {}) {
    const now = Date.now();
    const today0 = nextDayStart(now);
    const end = opts.ahead ? addDays(today0, AHEAD_DAYS) : today0;
    const reviews = [], learning = [], fresh = [];
    for (const pair of cardsOf(mid)) {
      const card = pair[1], s = card.srs;
      if (isLater(card, now)) continue;
      if (s.state === "new") fresh.push(pair);
      else if (s.state === "review") { if (s.due < end) reviews.push(pair); }
      else if (s.due < today0) learning.push(pair);
    }
    reviews.sort((a, b) => a[1].srs.due - b[1].srs.due);
    return {
      mid, ahead: Boolean(opts.ahead), reviews, learning,
      fresh: opts.ahead ? [] : fresh.slice(0, newLimitLeft()),
      sinceNew: 0, done: 0, started: now, history: [], current: null, revealed: false, shownAt: 0,
    };
  }
  function pickNext(sess) {
    const now = Date.now();
    let best = null;
    for (const p of sess.learning) if (p[1].srs.due <= now && (!best || p[1].srs.due < best[1].srs.due)) best = p;
    if (best) return best;
    if (sess.reviews.length || sess.fresh.length) {
      // spread new cards evenly through the reviews
      const gap = sess.fresh.length ? Math.max(1, Math.floor(sess.reviews.length / sess.fresh.length)) : Infinity;
      if (sess.fresh.length && (!sess.reviews.length || sess.sinceNew >= gap)) { sess.sinceNew = 0; return sess.fresh[0]; }
      sess.sinceNew++;
      return sess.reviews[0];
    }
    for (const p of sess.learning) if (p[1].srs.due <= now + LEARN_AHEAD && (!best || p[1].srs.due < best[1].srs.due)) best = p;
    return best;
  }
  function remaining(sess) {
    const now = Date.now();
    return {
      new: sess.fresh.length,
      learning: sess.learning.filter((p) => p[1].srs.due <= now + LEARN_AHEAD).length,
      review: sess.reviews.length,
    };
  }

  function snapshot(sess, pair) {
    return {
      pair, prev: pair[1].srs, prevLater: pair[1].buriedUntil || 0, log: { ...today() },
      reviews: [...sess.reviews], learning: [...sess.learning], fresh: [...sess.fresh], sinceNew: sess.sinceNew, done: sess.done,
    };
  }
  function remember(sess, pair) { sess.history.push(snapshot(sess, pair)); if (sess.history.length > 50) sess.history.shift(); }
  function dropFromSession(sess, pair) {
    for (const arr of [sess.reviews, sess.fresh, sess.learning]) { const i = arr.indexOf(pair); if (i >= 0) arr.splice(i, 1); }
  }

  async function grade(sess, g) {
    const pair = sess.current; if (!pair) return;
    const [mid, card] = pair;
    const now = Date.now();
    const prev = card.srs;
    const t = today();
    remember(sess, pair);

    card.srs = FSRS.next(prev, g, now, { retention: S.user.settings.retention, seed: card.id });
    card.buriedUntil = 0;
    dropFromSession(sess, pair);
    if (card.srs.state !== "review" && card.srs.due < nextDayStart(now)) sess.learning.push(pair);

    t.reviews++;
    if (g === 1) t.again++;
    if (prev.state === "new") t.new++;
    if (prev.state === "review") { t.rev++; if (g > 1) t.revPass++; }
    t.time += Math.min(60000, now - (sess.shownAt || now));
    sess.done++;

    await saveDeck(mid);
    await saveUser();
  }

  /* "Later": hide the card for 24 hours. Its schedule is untouched, and new cards
     don't count against today's new-card limit until you actually answer them. */
  async function later(sess) {
    const pair = sess.current; if (!pair) return;
    remember(sess, pair);
    pair[1].buriedUntil = Date.now() + LATER_MS;
    dropFromSession(sess, pair);
    await saveDeck(pair[0]);
  }

  async function undo(sess) {
    const h = sess.history.pop(); if (!h) return false;
    h.pair[1].srs = h.prev;
    h.pair[1].buriedUntil = h.prevLater;
    S.user.log[dayKey()] = h.log;
    Object.assign(sess, { reviews: h.reviews, learning: h.learning, fresh: h.fresh, sinceNew: h.sinceNew, done: h.done, current: h.pair, revealed: false });
    await saveDeck(h.pair[0]);
    await saveUser();
    return true;
  }

  /* Start studying: optionally add extra new cards to today, or review ahead. */
  async function startStudy(mid, { moreNew = 0, ahead = false } = {}) {
    if (moreNew) { today().extraNew = (today().extraNew || 0) + moreNew; await saveUser(); }
    session = buildSession(mid, { ahead });
    const target = mid ? `#/study/${mid}` : "#/study";
    if (location.hash === target) renderStudy(mid); else location.hash = target;
  }

  /* ================= card rendering ================= */
  const blobUrls = new Map();
  async function mediaUrl(mid, name) {
    const key = `media/${mid}/${name}`;
    if (blobUrls.has(key)) return blobUrls.get(key);
    try {
      const b = await idb.get("blobs", key);
      if (b) { const u = URL.createObjectURL(b); blobUrls.set(key, u); return u; }
    } catch { /* fall through */ }
    return `/api/media/${encodeURIComponent(mid)}/${encodeURIComponent(name)}`;
  }
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    root.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button,textarea,select,audio,video,base").forEach((n) => n.remove());
    root.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith("on")) el.removeAttribute(a.name);
        else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
        else if (n === "style") el.setAttribute("style", a.value.replace(/(font-family|background(-color)?)\s*:[^;]+;?/gi, ""));
      }
      if (el.tagName === "IMG") {
        const s = el.getAttribute("src") || "";
        if (s && !/^(https?:|data:|blob:)/i.test(s)) { el.setAttribute("data-media", s); el.removeAttribute("src"); }
        el.setAttribute("loading", "lazy");
      }
      if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener"); }
    });
    return root.innerHTML;
  }
  function hydrate(el, mid) {
    $$("img[data-media]", el).forEach(async (img) => {
      let name = img.getAttribute("data-media");
      try { name = decodeURIComponent(name); } catch { /* keep raw */ }
      img.src = await mediaUrl(mid, name);
      img.alt ||= "";
    });
  }

  /* ================= theme ================= */
  function applyTheme() {
    const t = S.user.settings.theme;
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }

  /* ================= router ================= */
  const view = () => $("#view");
  let activeAudio = null;
  let studyKeys = null;

  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [page, arg] = h.split("/");
    document.body.classList.toggle("study-mode", page === "study");
    if (studyKeys) { document.removeEventListener("keydown", studyKeys); studyKeys = null; }
    if (activeAudio && page !== "m") { activeAudio.pause(); activeAudio = null; }
    $$("#nav a").forEach((a) => { if (a.dataset.nav === (page || "today") || (page === "m" && a.dataset.nav === "library")) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    window.scrollTo(0, 0);
    if (!page) return renderToday();
    if (page === "library") return renderLibrary();
    if (page === "podcasts") return renderPodcasts();
    if (page === "m" && MOD[decodeURIComponent(arg || "")]) return renderModule(decodeURIComponent(arg));
    if (page === "study") return renderStudy(arg ? decodeURIComponent(arg) : null);
    if (page === "stats") return renderStats();
    if (page === "settings") return renderSettings();
    location.hash = "#/";
  }

  /* ================= Today ================= */
  const hasAudio = (mid) => S.localAudio.has(mid) || Boolean(S.serverAudio[mid]);
  function podsDue() {
    const end = nextDayStart();
    const due = [], fresh = [], upcoming = [];
    for (const m of MODS) {
      if (!hasAudio(m.id)) continue;
      const p = S.pods.items[m.id];
      if (!p) fresh.push(m);
      else if (p.due < end) due.push(m);
      else upcoming.push(m);
    }
    const byDue = (a, b) => S.pods.items[a.id].due - S.pods.items[b.id].due;
    return { due: due.sort(byDue), fresh, upcoming: upcoming.sort(byDue) };
  }
  function podLabel(mid) {
    const p = S.pods.items[mid];
    if (!p) return "Not heard yet";
    const late = Math.round((dayStart() - dayStart(p.due)) / DAY);
    if (late > 1) return `Due ${late} days ago`;
    if (late === 1) return "Due yesterday";
    if (p.due < nextDayStart()) return "Due today";
    return `Next listen ${relDay(p.due)}`;
  }
  /* What the next listen date would be after rating this listen 1 (felt new), 3 (familiar) or 4 (knew it well).
     The gap grows each time you know it, shrinks when it felt new, and listening early earns less credit. */
  function podNext(mid, r, now = Date.now()) {
    const p = S.pods.items[mid];
    let ivl;
    if (!p) ivl = POD_FIRST[r];
    else {
      const base = Math.max(1, p.ivl || 1);
      const credit = Math.min(1, Math.max(0.25, (now - p.last) / DAY / base));
      ivl = r === 1 ? base * POD_GROW[1] : base * (1 + (POD_GROW[r] - 1) * credit);
    }
    ivl = Math.min(POD_MAX, Math.max(1, Math.round(ivl)));
    return { ivl, due: addDays(dayStart(now), ivl), last: now, count: (p ? p.count : 0) + 1 };
  }
  async function rateListen(mid, r) {
    S.pods.items[mid] = podNext(mid, r);
    await savePods();
    lsSet("rd_pos_" + mid, null);
    toast(`Got it. Next listen ${relDay(S.pods.items[mid].due)}.`);
    const player = $("#player");
    if (location.hash === `#/m/${mid}` && (!player || player.paused)) renderModule(mid);
    else { const st = $("#pod-head-status"); if (st) st.textContent = podLabel(mid); }
  }

  /* ---------- your own topics (Miscellaneous) ---------- */
  async function createTopic(name) {
    const id = "misc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    S.user.custom.push({ id, name: name.slice(0, 120), created: Date.now() });
    rebuildMods();
    await saveUser();
    return id;
  }
  function askTopicName(def = "") {
    const n = prompt("Name this topic (for example: MRI physics)", def);
    return n && n.trim() ? n.trim() : null;
  }
  async function deleteTopic(mid) {
    const m = MOD[mid];
    if (!m || !m.custom) return;
    if (!confirm(`Delete “${m.name}” with its cards and podcast? This can't be undone.`)) return;
    if (S.decks[mid]) { delete S.decks[mid]; await idb.del("decks", mid); queue("deldeck:" + mid, 500); }
    for (const k of await idb.keys("blobs")) if (String(k).startsWith(`media/${mid}/`)) { await idb.del("blobs", k); S.outbox.delete("media:" + String(k).slice(6)); }
    if (S.localAudio.has(mid)) { await idb.del("blobs", "audio/" + mid); S.localAudio.delete(mid); }
    S.outbox.delete("audio:" + mid);
    if (S.serverAudio[mid]) { queue("delaudio:" + mid, 500); delete S.serverAudio[mid]; }
    if (S.pods.items[mid]) { delete S.pods.items[mid]; await savePods(); }
    S.user.custom = S.user.custom.filter((c) => c.id !== mid);
    S.user.deletedCustom = [...(S.user.deletedCustom || []), mid];
    rebuildMods();
    await saveUser();
    toast("Topic deleted");
    location.hash = "#/library";
  }
  function addOwnPodcast() {
    const inp = $("#file-audio");
    inp.value = "";
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const guess = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
      const name = askTopicName(guess); if (!name) return;
      const id = await createTopic(name);
      location.hash = `#/m/${id}`;
      await new Promise((r) => setTimeout(r, 60));
      runAudioUpload(id, f);
    };
    inp.click();
  }

  function podRow(m, label) {
    return `<a class="item" href="#/m/${m.id}">
      <span class="pod-dot" aria-hidden="true"></span>
      <span class="t"><b>${esc(m.name)}</b><span class="small muted">${esc(m.ch.name)}</span></span>
      <span class="meta">${esc(label)}</span><span class="chev" aria-hidden="true">›</span></a>`;
  }
  function moreButtons(c, mid) {
    const out = [];
    if (c.moreNew > 0) {
      out.push(`<button class="btn" data-more="10">Learn 10 more new</button>`);
      if (c.moreNew > 10) out.push(`<button class="btn" data-more="20">Learn 20 more</button>`);
    }
    if (!c.review && !c.learning && c.ahead) out.push(`<button class="btn" data-ahead="1" title="Cards due in the next ${AHEAD_DAYS} days">Review ahead (${c.ahead})</button>`);
    return out.join("");
  }
  function wireMore(root, mid) {
    $$("[data-more]", root).forEach((b) => (b.onclick = () => startStudy(mid, { moreNew: Number(b.dataset.more) })));
    $$("[data-ahead]", root).forEach((b) => (b.onclick = () => startStudy(mid, { ahead: true })));
  }

  function renderToday() {
    const c = counts(null);
    const anyCards = c.total > 0;
    const pods = podsDue();
    const anyAudio = MODS.some((m) => hasAudio(m.id));

    if (!anyCards && !anyAudio) {
      view().innerHTML = `
        <div class="stack">
          <div>
            <h1 class="lede">Start by adding a deck.</h1>
            <p class="muted" style="margin-top:10px;max-width:52ch">Pick a module in the library and upload an Anki deck (.apkg) or a podcast. Your own recordings go in <a href="#/podcasts">Podcasts</a>. Everything you add shows up here on a spaced-repetition schedule.</p>
          </div>
          <div class="row"><a class="btn primary lg" href="#/library">Open the library</a><a class="btn lg" href="#/podcasts">Add your own podcast</a></div>
          ${!S.authOk && S.online ? `<p class="small muted">Want this on all your devices? <a href="#/settings">Sign in with your admin token</a> first, so uploads go to your Cloudflare storage.</p>` : ""}
        </div>`;
      return;
    }

    const perMod = MODS.map((m) => ({ m, c: S.decks[m.id] ? counts(m.id) : null })).filter((x) => x.c && x.c.review + x.c.learning + x.c.unseen > 0);
    const dueMods = perMod.filter((x) => x.c.review + x.c.learning > 0);
    const nextUp = nextReviewInfo();

    const headline = c.due ? `${plural(c.due, "card")} to study today.` : anyCards ? "You're caught up." : "No cards yet.";
    let sub = c.due
      ? [c.review && plural(c.review, "review"), c.learning && `${c.learning} learning`, c.new && `${c.new} new`].filter(Boolean).join(", ") + (dueMods.length > 1 ? `, across ${dueMods.length} modules.` : ".")
      : nextUp ? `Next reviews ${nextUp}.` : anyCards ? "" : "Add cards to a module to get started.";
    if (c.later) sub += ` ${plural(c.later, "card")} set aside for later.`;

    view().innerHTML = `
      <div class="stack">
        <section>
          <h1 class="lede">${headline}</h1>
          ${sub.trim() ? `<p class="muted" style="margin-top:8px">${esc(sub.trim())}</p>` : ""}
          <div class="row" style="margin-top:20px">
            ${c.due ? `<a class="btn primary lg" href="#/study">Start studying</a>` : ""}
            ${moreButtons(c, null)}
          </div>
        </section>

        ${pods.due.length || pods.fresh.length ? `
        <section>
          <div class="section-h"><h2>Listen today</h2><a class="small" href="#/podcasts">All podcasts</a></div>
          <div class="list">
            ${[...pods.due.map((m) => podRow(m, podLabel(m.id))), ...pods.fresh.slice(0, 4).map((m) => podRow(m, "New"))].join("")}
          </div>
        </section>` : ""}

        ${perMod.length ? `
        <section>
          <div class="section-h"><h2>By module</h2></div>
          <div class="list">
            ${perMod.slice(0, 30).map(({ m, c }) => `
              <a class="item" href="#/m/${m.id}">
                <span class="t"><b>${esc(m.name)}</b><span class="small muted">${esc(m.ch.name)}</span></span>
                <span class="meta">${c.review + c.learning ? `<span class="due">${c.review + c.learning} due</span>` : ""}${c.unseen ? `<span>${c.unseen} new</span>` : ""}</span>
                <span class="chev" aria-hidden="true">›</span>
              </a>`).join("")}
          </div>
        </section>` : ""}
      </div>`;
    wireMore(view(), null);
  }
  function nextReviewInfo() {
    let min = Infinity;
    for (const [, c] of cardsOf(null)) if (c.srs.state !== "new" && c.srs.due < min) min = c.srs.due;
    if (min === Infinity) return null;
    if (min < nextDayStart()) return `later today at ${new Date(min).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return relDay(min);
  }

  /* ================= Library ================= */
  function renderLibrary() {
    const open = new Set(JSON.parse(lsGet("rd_open") || "[]"));
    view().innerHTML = `
      <div class="stack">
        <div class="row between">
          <h1>Library</h1>
          <input type="text" id="lib-q" placeholder="Find a module" aria-label="Find a module" style="width:220px">
        </div>
        <div class="list" id="lib"></div>
      </div>`;
    const lib = $("#lib");
    const draw = (q) => {
      q = (q || "").trim().toLowerCase();
      lib.innerHTML = CHAPS.map((c) => {
        const isMisc = c === MISC;
        const mods = MODS.filter((m) => m.ch === c && (!q || m.name.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)));
        if (!mods.length && (q || !isMisc)) return "";
        let cards = 0, due = 0;
        const rows = mods.map((m) => {
          const k = S.decks[m.id] ? counts(m.id) : null;
          if (k) { cards += k.total; due += k.review + k.learning; }
          const a = hasAudio(m.id);
          return `<a class="item" href="#/m/${m.id}">
            <span class="t"><b>${esc(m.name)}</b></span>
            <span class="meta">
              ${a ? `<span class="pod-dot" title="Has a podcast" aria-label="Has a podcast"></span>` : ""}
              ${k && k.review + k.learning ? `<span class="due">${k.review + k.learning} due</span>` : ""}
              ${k ? `<span>${plural(k.total, "card")}</span>` : ""}
            </span>
            <span class="chev" aria-hidden="true">›</span></a>`;
        }).join("") + (isMisc ? `<button class="item add-topic" type="button" data-new-topic>+ New topic for your own podcasts and cards</button>` : "");
        const isOpen = q || open.has(c.id);
        const meta = isMisc && !mods.length ? "Your own topics" : cards ? plural(cards, "card") : plural(mods.length, isMisc ? "topic" : "module");
        return `<details class="chap" data-id="${c.id}" ${isOpen ? "open" : ""}>
          <summary><span class="n">${c.num}</span><span>${esc(c.name)}</span>
            <span class="meta">${due ? `<span class="due" style="color:var(--accent);font-weight:600">${due} due</span>&ensp;` : ""}${meta}</span>
            <span class="arrow" aria-hidden="true">›</span></summary>
          <div class="mods">${rows}</div></details>`;
      }).join("") || `<div class="item muted">No modules match “${esc(q)}”.</div>`;
      $$("details.chap", lib).forEach((d) => d.addEventListener("toggle", () => {
        if ($("#lib-q").value) return;
        d.open ? open.add(d.dataset.id) : open.delete(d.dataset.id);
        lsSet("rd_open", JSON.stringify([...open]));
      }));
      $$("[data-new-topic]", lib).forEach((b) => (b.onclick = async () => {
        const name = askTopicName(); if (!name) return;
        const id = await createTopic(name);
        location.hash = `#/m/${id}`;
      }));
    };
    draw("");
    $("#lib-q").addEventListener("input", (e) => draw(e.target.value));
  }

  /* ================= Podcasts ================= */
  function renderPodcasts() {
    const pods = podsDue();
    const total = pods.due.length + pods.fresh.length + pods.upcoming.length;
    const section = (title, list, label) => list.length ? `
      <section>
        <div class="section-h"><h2>${title}</h2><span class="small muted">${list.length}</span></div>
        <div class="list">${list.map((m) => podRow(m, label(m))).join("")}</div>
      </section>` : "";
    view().innerHTML = `
      <div class="stack">
        <div class="row between">
          <h1>Podcasts</h1>
          <button class="btn primary" id="add-pod">Add your own podcast</button>
        </div>
        <p class="muted" style="max-width:62ch">After each listen, rate how well you knew it. The next listen is timed for just before you'd start to forget, and the gap grows each time you know it well. Your own recordings go in Miscellaneous, with the same schedule.</p>
        ${section("Due to listen", pods.due, (m) => podLabel(m.id))}
        ${section("Not heard yet", pods.fresh, () => "New")}
        ${section("Coming up", pods.upcoming, (m) => relDay(S.pods.items[m.id].due).replace(/^./, (x) => x.toUpperCase()))}
        ${!total ? `<div class="card pad empty"><p class="muted">No podcasts yet. Add one to a module from the <a href="#/library">library</a>, or upload your own recording with the button above.</p></div>` : ""}
      </div>`;
    $("#add-pod").onclick = addOwnPodcast;
  }

  /* ================= Module ================= */
  function renderModule(mid) {
    const m = MOD[mid];
    const deck = S.decks[mid];
    const c = deck ? counts(mid) : null;
    const pod = S.pods.items[mid];
    const audio = hasAudio(mid);
    const srvA = S.serverAudio[mid];
    const podDue = pod && pod.due < nextDayStart();

    view().innerHTML = `
      <div class="stack">
        <div>
          <div class="crumb"><a href="#/library">Library</a> › ${esc(m.ch.name)}</div>
          <div class="row between" style="align-items:flex-end">
            <h1>${esc(m.name)}</h1>
            ${m.custom ? `<div class="row" style="gap:4px"><button class="btn sm quiet" id="topic-rename">Rename</button><button class="btn sm quiet danger" id="topic-del">Delete topic</button></div>` : ""}
          </div>
        </div>

        ${c && c.total ? `
        <section class="card pad">
          <div class="row between" style="align-items:flex-start;gap:20px">
            <div class="stats-row">
              <div class="stat"><b>${c.review + c.learning}</b><span>due</span></div>
              <div class="stat"><b>${c.unseen}</b><span>new</span></div>
              <div class="stat"><b>${c.mature}</b><span>mature</span></div>
              <div class="stat"><b>${c.total}</b><span>cards</span></div>
            </div>
            <div class="row" style="gap:8px">
              ${c.due ? `<a class="btn primary" href="#/study/${mid}">Study ${plural(c.due, "card")}</a>` : ""}
              ${moreButtons(c, mid)}
              ${!c.due && !c.moreNew && !c.ahead ? `<span class="small muted" style="align-self:center">Nothing due in this module today.</span>` : ""}
            </div>
          </div>
          ${c.later ? `<p class="small muted" style="margin-top:12px">${plural(c.later, "card")} set aside with Later. They come back within 24 hours. <button class="btn sm quiet" id="unlater">Bring back now</button></p>` : ""}
        </section>` : ""}

        <section>
          <div class="section-h"><h2>Podcast</h2>${audio ? `<span class="small muted" id="pod-head-status">${podLabel(mid)}</span>` : ""}</div>
          ${audio ? `
          <div class="card pad${podDue ? " due-ring" : ""}">
            <div class="row between">
              <span class="small muted" id="pod-name">${esc((srvA && srvA.filename) || "Podcast")}${srvA && srvA.size ? `, ${fmtBytes(srvA.size)}` : ""}</span>
              <div class="row" style="gap:4px" role="group" aria-label="Playback speed">
                ${[1, 1.25, 1.5, 2].map((r) => `<button class="btn sm quiet" data-rate="${r}">${r}×</button>`).join("")}
              </div>
            </div>
            <audio id="player" controls preload="metadata"></audio>
            <div class="rate-pod" id="rate-pod">
              <p class="small">${pod ? `Heard ${plural(pod.count, "time")}. ` : ""}Finished listening? Rate how well you knew it to schedule the next listen.</p>
              <div class="pod-rate">
                ${POD_RATINGS.map(([r, l]) => `<button class="btn sm" data-pr="${r}">${l}<span class="muted">&ensp;${FSRS.fmtSpan(podNext(mid, r).ivl * DAY)}</span></button>`).join("")}
              </div>
            </div>
            <div class="row" style="margin-top:10px;gap:4px;justify-content:flex-end">
              <button class="btn sm quiet" id="pod-replace">Replace audio</button>
              <button class="btn sm quiet danger" id="pod-del">Remove</button>
            </div>
            <div class="status" id="pod-status"></div>
          </div>` : `
          <div class="drop" id="pod-drop">
            <div class="t"><b>Add a podcast</b><p class="small muted">Drop an audio file here. MP3, M4A, WAV or OGG, up to 300 MB.</p></div>
            <button class="btn" id="pod-pick">Choose audio</button>
            <div class="status" id="pod-status" style="flex-basis:100%"></div>
          </div>`}
        </section>

        <section>
          <div class="section-h"><h2>Flashcards</h2>${c && c.total ? `<span class="small muted">${plural(c.total, "card")}</span>` : ""}</div>
          <div class="drop" id="card-drop">
            <div class="t"><b>${c && c.total ? "Add or update cards" : "Import flashcards"}</b>
              <p class="small muted">Drop an Anki deck (.apkg), or a text file with front and back separated by a tab or comma. Re-importing the same deck updates cards and keeps your progress.</p></div>
            <button class="btn" id="card-pick">Choose file</button>
            <div class="status" id="card-status" style="flex-basis:100%"></div>
          </div>
          ${c && c.total ? `
          <div class="list" style="margin-top:12px" id="card-list"></div>
          <div class="row" style="margin-top:12px;gap:6px">
            <button class="btn sm quiet" id="card-reset">Reset progress</button>
            <button class="btn sm quiet danger" id="card-del">Delete all cards</button>
          </div>` : ""}
        </section>
      </div>`;

    if (m.custom) {
      $("#topic-rename").onclick = async () => {
        const n = askTopicName(m.name); if (!n) return;
        const t = S.user.custom.find((x) => x.id === mid); if (t) t.name = n.slice(0, 120);
        rebuildMods(); await saveUser(); renderModule(mid);
      };
      $("#topic-del").onclick = () => deleteTopic(mid);
    }
    if (c && c.total) wireMore(view(), mid);
    const ul = $("#unlater");
    if (ul) ul.onclick = async () => { for (const card of deck.cards) card.buriedUntil = 0; await saveDeck(mid); renderModule(mid); };

    /* --- cards --- */
    const cardFile = $("#file-cards");
    $("#card-pick").onclick = () => { cardFile.value = ""; cardFile.onchange = () => cardFile.files[0] && runImport(mid, cardFile.files[0]); cardFile.click(); };
    wireDrop($("#card-drop"), (f) => runImport(mid, f));
    if (c && c.total) {
      drawCardList(mid);
      $("#card-reset").onclick = async () => {
        if (!confirm(`Reset progress for all ${c.total} cards in “${m.name}”? They'll all become new again.`)) return;
        for (const card of deck.cards) { card.srs = FSRS.fresh(); card.buriedUntil = 0; }
        await saveDeck(mid); toast("Progress reset"); renderModule(mid);
      };
      $("#card-del").onclick = async () => {
        if (!confirm(`Delete all ${c.total} cards in “${m.name}”? This can't be undone.`)) return;
        delete S.decks[mid];
        await idb.del("decks", mid);
        for (const k of await idb.keys("blobs")) if (String(k).startsWith(`media/${mid}/`)) { await idb.del("blobs", k); S.outbox.delete("media:" + String(k).slice(6)); }
        queue("deldeck:" + mid, 500);
        toast("Cards deleted"); renderModule(mid);
      };
    }

    /* --- podcast --- */
    const audioFile = $("#file-audio");
    const pickAudio = () => { audioFile.value = ""; audioFile.onchange = () => audioFile.files[0] && runAudioUpload(mid, audioFile.files[0]); audioFile.click(); };
    if (!audio) {
      $("#pod-pick").onclick = pickAudio;
      wireDrop($("#pod-drop"), (f) => runAudioUpload(mid, f));
      return;
    }
    $("#pod-replace").onclick = pickAudio;
    $("#pod-del").onclick = async () => {
      if (!confirm(`Remove the podcast from “${m.name}”?`)) return;
      if (S.localAudio.has(mid)) { await idb.del("blobs", "audio/" + mid); S.localAudio.delete(mid); }
      S.outbox.delete("audio:" + mid);
      if (S.serverAudio[mid]) queue("delaudio:" + mid, 300);
      delete S.serverAudio[mid];
      delete S.pods.items[mid]; await savePods();
      lsSet("rd_pos_" + mid, null);
      toast("Podcast removed"); renderModule(mid);
    };
    $$("[data-pr]").forEach((b) => (b.onclick = () => rateListen(mid, Number(b.dataset.pr))));
    const player = $("#player");
    activeAudio = player;
    (async () => {
      if (S.localAudio.has(mid)) {
        const b = await idb.get("blobs", "audio/" + mid);
        if (b) { player.src = URL.createObjectURL(b); $("#pod-name").textContent = `${b.name || "Podcast"}, ${fmtBytes(b.size)}`; return; }
      }
      player.src = `/api/audio/${mid}`;
    })();
    const rate = Number(lsGet("rd_rate") || 1);
    const setRate = (r) => { player.playbackRate = r; lsSet("rd_rate", String(r)); $$("[data-rate]").forEach((b) => { const on = Number(b.dataset.rate) === r; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }); };
    $$("[data-rate]").forEach((b) => (b.onclick = () => setRate(Number(b.dataset.rate))));
    player.addEventListener("loadedmetadata", () => {
      setRate(rate);
      const pos = Number(lsGet("rd_pos_" + mid) || 0);
      if (pos > 5 && pos < player.duration - 10) player.currentTime = pos;
    });
    let lastSave = 0;
    player.addEventListener("timeupdate", () => { if (Date.now() - lastSave > 3000) { lastSave = Date.now(); lsSet("rd_pos_" + mid, String(player.currentTime)); } });
    player.addEventListener("ended", () => {
      lsSet("rd_pos_" + mid, null);
      const box = $("#rate-pod");
      if (box) { box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); box.scrollIntoView({ block: "center", behavior: "smooth" }); }
      toast("Finished. How well did you know it?");
    });
    player.addEventListener("error", () => { const st = $("#pod-status"); if (st && player.src) { st.textContent = "This audio couldn't be played. Try replacing it with an MP3 or M4A file."; st.classList.add("err"); } });
  }

  function drawCardList(mid) {
    const list = $("#card-list"); if (!list) return;
    const cards = S.decks[mid].cards;
    const LIMIT = 40;
    let showAll = false;
    const now = Date.now();
    const state = (s, c) => isLater(c, now) ? "Later" : s.state === "new" ? "New" : s.state === "review" ? `Due ${relDay(s.due)}` : "Learning";
    const draw = () => {
      const shown = showAll ? cards : cards.slice(0, LIMIT);
      list.innerHTML = shown.map((c, i) => `
        <details class="chap" data-i="${i}">
          <summary style="font-weight:400"><span class="t" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(textOf(c.front).slice(0, 140)) || "<i>Image</i>"}</span>
          <span class="meta">${state(c.srs, c)}</span></summary>
          <div class="mods" style="padding:14px 16px"></div>
        </details>`).join("") + (cards.length > LIMIT && !showAll ? `<button class="item btn quiet" style="width:100%;border-radius:0;justify-content:center" id="show-all">Show all ${cards.length} cards</button>` : "");
      $$("details", list).forEach((d) => d.addEventListener("toggle", () => {
        if (!d.open) return;
        const box = d.querySelector(".mods");
        if (box.dataset.done) return;
        const c = shown[Number(d.dataset.i)];
        box.innerHTML = `<div class="scard" style="min-height:0;box-shadow:none;font-size:16px;padding:18px"><div class="side">${sanitize(c.front)}</div><div class="side">${sanitize(c.back)}</div></div>`;
        hydrate(box, mid); box.dataset.done = "1";
      }));
      const sa = $("#show-all"); if (sa) sa.onclick = () => { showAll = true; draw(); };
    };
    draw();
  }

  function wireDrop(el, onFile) {
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  }

  /* --- import --- */
  let ankiLibs = null;
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load " + src)); document.head.appendChild(s); });
  }
  async function getAnkiLibs() {
    if (ankiLibs) return ankiLibs;
    await loadScript(SQL_CDN + "sql-wasm.js");
    const [SQL] = await Promise.all([
      window.initSqlJs({ locateFile: (f) => SQL_CDN + f }),
      loadScript(ZSTD_CDN).catch(() => null),
    ]);
    ankiLibs = { SQL, openZip: window.openZip, fzstd: window.fzstd || null };
    return ankiLibs;
  }

  async function runImport(mid, file) {
    const st = $("#card-status");
    const say = (t, err) => { if (st) { st.textContent = t; st.classList.toggle("err", Boolean(err)); } };
    try {
      let parsed;
      if (/\.(apkg|colpkg)$/i.test(file.name)) {
        say("Loading the Anki reader…");
        const libs = await getAnkiLibs();
        say(`Reading ${file.name}…`);
        parsed = await AnkiImport.parseApkg(await file.arrayBuffer(), libs);
      } else if (/\.(txt|csv|tsv)$/i.test(file.name) || file.type.startsWith("text/")) {
        parsed = AnkiImport.parseText(await file.text());
      } else {
        throw new Error("That file type isn't supported. Use an Anki .apkg file, or a .txt/.csv with front and back columns.");
      }
      if (!parsed.cards.length) throw new Error("No cards found in that file.");

      let imgs = 0;
      for (const md of parsed.media) {
        say(`Saving images… ${imgs + 1} of ${parsed.media.length}`);
        const bytes = await md.read();
        const name = md.name.replace(/\//g, "_");
        await idb.put("blobs", `media/${mid}/${name}`, new Blob([bytes], { type: mimeFor(name) }));
        blobUrls.delete(`media/${mid}/${name}`);
        queue(`media:${mid}/${name}`);
        imgs++;
      }

      const deck = S.decks[mid] || { cards: [], updatedAt: 0 };
      const byId = new Map(deck.cards.map((c) => [c.id, c]));
      let added = 0, updated = 0;
      for (const pc of parsed.cards) {
        const id = pc.nid ? `a${pc.nid}-${pc.ord}` : "t" + hash(textOf(pc.front));
        const type = /cloze-gap/.test(pc.front) ? "cloze" : "basic";
        const ex = byId.get(id);
        if (ex) {
          if (ex.front !== pc.front || ex.back !== pc.back) { ex.front = pc.front; ex.back = pc.back; ex.type = type; updated++; }
          ex.tags = pc.tags || [];
        } else {
          const card = { id, front: pc.front, back: pc.back, tags: pc.tags || [], type, srs: FSRS.fresh(), added: Date.now() };
          deck.cards.push(card); byId.set(id, card); added++;
        }
      }
      S.decks[mid] = deck;
      await saveDeck(mid);
      const parts = [];
      if (added) parts.push(plural(added, "new card"));
      if (updated) parts.push(`${updated} updated`);
      if (imgs && (added || updated)) parts.push(plural(imgs, "image"));
      const summary = parts.length ? `Imported ${parts.join(", ")} from ${file.name}.` : `Nothing new in ${file.name}. Every card was already here.`;
      toast(parts.length ? `Imported ${parts.join(", ")}` : "No new cards");
      renderModule(mid);
      const st2 = $("#card-status");
      if (st2) st2.textContent = summary + (!canSync() && parts.length ? " Saved on this device. Sign in to sync." : "");
    } catch (e) {
      console.error(e);
      say(e.message || "Import failed.", true);
    }
  }

  async function runAudioUpload(mid, file) {
    const st = $("#pod-status");
    const say = (t, err) => { if (st) { st.textContent = t; st.classList.toggle("err", Boolean(err)); } };
    if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(file.name)) return say("That isn't an audio file. Use MP3, M4A, WAV or OGG.", true);
    if (file.size > 300 * 1048576) return say("That file is over 300 MB. Compress it to MP3 or M4A first.", true);
    try {
      if (canSync()) {
        await xhrPut(`/api/audio/${mid}`, file, { authorization: "Bearer " + S.token, "content-type": file.type || mimeFor(file.name), "x-filename": encodeURIComponent(file.name) },
          (p) => say(`Uploading… ${Math.round(p * 100)}%`));
        S.serverAudio[mid] = { size: file.size, filename: file.name, uploadedAt: Date.now() };
        if (S.localAudio.has(mid)) { await idb.del("blobs", "audio/" + mid); S.localAudio.delete(mid); }
        S.outbox.delete("audio:" + mid); S.outbox.delete("delaudio:" + mid); persistOutbox();
      } else {
        say("Saving…");
        await idb.put("blobs", "audio/" + mid, file);
        S.localAudio.add(mid);
        queue("audio:" + mid);
      }
      lsSet("rd_pos_" + mid, null);
      toast("Podcast added");
      renderModule(mid);
      if (!canSync()) { const s2 = $("#pod-status"); if (s2) s2.textContent = "Saved on this device. Sign in to upload it to your Cloudflare storage."; }
    } catch (e) {
      if (e.status === 401) { S.authOk = false; renderSync(); }
      say(e.message || "Upload failed.", true);
    }
  }

  /* ================= Study ================= */
  let session = null;
  function renderStudy(mid) {
    if (mid && !MOD[mid]) mid = null;
    if (!session || session.mid !== mid || session.finished) session = buildSession(mid);
    const sess = session;
    const back = mid ? `#/m/${mid}` : "#/";

    view().innerHTML = `
      <div class="study">
        <div class="study-top">
          <a class="btn sm quiet" href="${back}" title="End session (Esc)">✕ End</a>
          <div class="progress" aria-hidden="true"><i id="prog"></i></div>
          <span class="small muted num" id="left"></span>
        </div>
        <div id="stage"></div>
      </div>
      <div class="grade-bar" id="gbar"></div>`;

    const stage = $("#stage"), gbar = $("#gbar");

    const showDone = () => {
      sess.finished = true;
      const mins = Math.max(1, Math.round((Date.now() - sess.started) / 60000));
      const waiting = sess.learning.length;
      const c = counts(mid);
      stage.innerHTML = `
        <div class="done">
          <h1>${sess.done ? "Done for now." : "Nothing to study right now."}</h1>
          <p class="muted">${sess.done ? `${plural(sess.done, "card")} in ${plural(mins, "minute")}.` : ""}
          ${waiting ? ` ${plural(waiting, "card")} will come back later today.` : ""}</p>
          <div class="row" style="margin-top:22px">
            <a class="btn primary" href="${back}">${mid ? "Back to module" : "Back to today"}</a>
            ${moreButtons(c, mid)}
            ${sess.history.length ? `<button class="btn quiet" id="undo-last">Undo last card</button>` : ""}
          </div>
        </div>`;
      gbar.style.display = "none";
      $("#prog").style.width = "100%";
      $("#left").textContent = "";
      wireMore(stage, mid);
      const u = $("#undo-last");
      if (u) u.onclick = async () => { if (await undo(sess)) { sess.finished = false; gbar.style.display = ""; draw(); } };
    };

    const draw = () => {
      const pair = sess.current || pickNext(sess);
      sess.current = pair;
      if (!pair) return showDone();
      const [cmid, card] = pair;
      const r = remaining(sess);
      const left = r.new + r.learning + r.review;
      $("#left").innerHTML = `${sess.ahead ? `<span style="margin-right:10px">Reviewing ahead</span>` : ""}<span style="color:var(--easy)">${r.new}</span>&ensp;<span style="color:var(--again)">${r.learning}</span>&ensp;<span style="color:var(--good)">${r.review}</span>`;
      $("#left").title = `${r.new} new, ${r.learning} learning, ${r.review} review`;
      $("#prog").style.width = `${Math.min(100, (sess.done / Math.max(1, sess.done + left)) * 100)}%`;

      const m = MOD[cmid];
      const isCloze = card.type === "cloze";
      const front = sanitize(card.front);
      const backHtml = sanitize(card.back);
      stage.innerHTML = `
        <article class="scard${sess.revealed ? "" : " tap"}" aria-live="polite" ${sess.revealed ? "" : `title="Tap to show the answer"`}>
          <div class="side">${sess.revealed && isCloze ? backHtml : front}</div>
          ${sess.revealed && !isCloze ? `<div class="side">${backHtml}</div>` : ""}
          ${!mid && m ? `<div class="tagline">${esc(m.ch.name)} › ${esc(m.name)}</div>` : ""}
        </article>
        <div class="row" style="margin-top:10px;justify-content:space-between">
          <button class="btn sm quiet" id="later" title="Hide this card for 24 hours. Its schedule doesn't change.">Later <span class="k">L</span></button>
          ${sess.history.length ? `<button class="btn sm quiet" id="undo">Undo <span class="k">Z</span></button>` : ""}
        </div>`;
      hydrate(stage, cmid);
      $("#later").onclick = doLater;
      const u = $("#undo"); if (u) u.onclick = doUndo;
      const art = stage.querySelector(".scard");
      art.onclick = (e) => { if (!sess.revealed && !e.target.closest("a,button")) reveal(); };

      if (!sess.revealed) {
        sess.shownAt = Date.now();
        gbar.innerHTML = `<div class="grade-in one"><button class="btn primary lg" id="reveal">Show answer <span class="k">Space</span></button></div>`;
        $("#reveal").onclick = reveal;
      } else {
        const pv = FSRS.previews(card.srs, Date.now(), { retention: S.user.settings.retention, seed: card.id });
        const names = { 1: ["again", "Again"], 2: ["hard", "Hard"], 3: ["good", "Good"], 4: ["easy", "Easy"] };
        gbar.innerHTML = `<div class="grade-in">${[1, 2, 3, 4].map((g) => `<button class="gbtn ${names[g][0]}" data-g="${g}"><b>${names[g][1]}</b><span>${FSRS.fmtSpan(pv[g])}&ensp;<span class="k" style="font-size:10px">${g}</span></span></button>`).join("")}</div>`;
        $$("[data-g]", gbar).forEach((b) => (b.onclick = () => doGrade(Number(b.dataset.g))));
      }
    };
    const reveal = () => { if (sess.revealed) return; sess.revealed = true; draw(); };
    const doGrade = async (g) => {
      if (!sess.revealed || !sess.current) return;
      await grade(sess, g);
      sess.current = null; sess.revealed = false;
      draw();
    };
    const doLater = async () => {
      if (!sess.current) return;
      await later(sess);
      sess.current = null; sess.revealed = false;
      toast("Set aside. It comes back in 24 hours.");
      draw();
    };
    const doUndo = async () => { if (await undo(sess)) { sess.finished = false; gbar.style.display = ""; draw(); toast("Undone"); } };

    studyKeys = (e) => {
      if (e.target.closest("input,textarea,select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") { location.hash = back; return; }
      if (sess.finished) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); sess.revealed ? doGrade(3) : reveal(); }
      else if (/^[1-4]$/.test(e.key) && sess.revealed) { e.preventDefault(); doGrade(Number(e.key)); }
      else if (e.key === "z" || e.key === "Z") { e.preventDefault(); doUndo(); }
      else if (e.key === "l" || e.key === "L") { e.preventDefault(); doLater(); }
    };
    document.addEventListener("keydown", studyKeys);
    draw();
  }

  /* ================= Stats ================= */
  function renderStats() {
    const log = S.user.log;
    const t = log[dayKey()] || { reviews: 0, time: 0 };
    const all = cardsOf(null);
    let mature = 0, learned = 0;
    for (const [, c] of all) { if (c.srs.state !== "new") learned++; if (c.srs.state === "review" && c.srs.s >= 21) mature++; }

    // retention over the last 30 days (reviews of graduated cards only)
    let rev = 0, pass = 0;
    for (let i = 0; i < 30; i++) { const d = log[dayKey(addDays(Date.now(), -i))]; if (d) { rev += d.rev || 0; pass += d.revPass || 0; } }
    // streak
    let streak = 0;
    for (let i = (t.reviews ? 0 : 1); i < 3650; i++) { const d = log[dayKey(addDays(Date.now(), -i))]; if (d && d.reviews) streak++; else break; }

    // forecast: next 14 days
    const fc = new Array(14).fill(0);
    const base = dayStart();
    for (const [, c] of all) {
      if (c.srs.state === "new") continue;
      const i = Math.max(0, Math.floor((dayStart(c.srs.due) - base) / DAY + 0.5));
      if (i < 14) fc[i]++;
    }
    const fmax = Math.max(1, ...fc);

    // heatmap: last 26 weeks, aligned to weekday columns
    const weeks = 26;
    const end = new Date(dayStart()); const start = addDays(end.getTime(), -(weeks * 7 - 1) - end.getDay());
    const cells = [];
    let hmax = 1;
    for (let ts = start; ts <= end.getTime(); ts = addDays(ts, 1)) { const n = (log[dayKey(ts)] || {}).reviews || 0; hmax = Math.max(hmax, n); cells.push([ts, n]); }
    const lvl = (n) => (n === 0 ? "" : n < hmax * 0.25 ? "l1" : n < hmax * 0.5 ? "l2" : n < hmax * 0.75 ? "l3" : "l4");

    view().innerHTML = `
      <div class="stack">
        <h1>Stats</h1>
        <div class="tiles">
          <div class="tile"><b>${t.reviews}</b><span>reviewed today${t.time ? `, ${Math.round(t.time / 60000)} min` : ""}</span></div>
          <div class="tile"><b>${plural(streak, "day")}</b><span>streak</span></div>
          <div class="tile"><b>${rev ? Math.round((pass / rev) * 100) + "%" : "–"}</b><span>retention, last 30 days</span></div>
          <div class="tile"><b>${fc[1]}</b><span>due tomorrow</span></div>
          <div class="tile"><b>${learned.toLocaleString()}</b><span>of ${plural(all.length, "card")} learned</span></div>
          <div class="tile"><b>${mature.toLocaleString()}</b><span>mature (21+ day interval)</span></div>
        </div>
        <section class="card pad">
          <div class="section-h"><h2>Next 14 days</h2><span class="small muted">reviews due</span></div>
          <div class="bars" role="img" aria-label="Reviews due over the next 14 days">
            ${fc.map((n, i) => `<div title="${n} due ${i === 0 ? "today" : relDay(addDays(base, i))}"><span>${n || ""}</span><i style="height:${(n / fmax) * 70}px"></i><span>${i === 0 ? "Today" : new Date(addDays(base, i)).toLocaleDateString(undefined, { weekday: "narrow" })}</span></div>`).join("")}
          </div>
        </section>
        <section class="card pad">
          <div class="section-h"><h2>Activity</h2><span class="small muted">last 6 months</span></div>
          <div class="heat" role="img" aria-label="Reviews per day over the last six months">
            ${cells.map(([ts, n]) => `<i class="${lvl(n)}" title="${new Date(ts).toLocaleDateString()}: ${plural(n, "review")}"></i>`).join("")}
          </div>
        </section>
      </div>`;
  }

  /* ================= Settings ================= */
  function renderSettings() {
    const st = S.user.settings;
    view().innerHTML = `
      <div class="stack settings">
        <h1>Settings</h1>

        <section>
          <div class="section-h"><h2>Sync</h2></div>
          <div class="card pad">
            ${!S.online ? `<p>The sync server isn't reachable, so everything is saved on this device. It'll sync once you're back online.</p>`
              : !S.adminConfigured ? `<p>The Worker has no admin token yet. In your project folder, run <code>npx wrangler secret put ADMIN_TOKEN</code>, then sign in here.</p>`
              : S.authOk ? `<p>Signed in on this device. Uploads and progress sync to your Cloudflare storage.</p>
                  <div class="row" style="margin-top:12px"><button class="btn sm" id="sync-now">Sync now</button><button class="btn sm quiet" id="sign-out">Sign out</button></div>`
              : `<p style="margin-bottom:12px">Sign in with your admin token to upload decks and podcasts and sync progress across devices. Anyone can view the site; only you can change it.</p>
                  <form class="row" id="sign-in"><input type="password" id="tok" placeholder="Admin token" autocomplete="current-password" style="flex:1;min-width:200px" aria-label="Admin token"><button class="btn primary" type="submit">Sign in</button></form>`}
            <p class="small muted" id="sync-detail" style="margin-top:10px"></p>
          </div>
        </section>

        <section>
          <div class="section-h"><h2>Study</h2></div>
          <div class="card pad">
            <div class="row between">
              <div class="field" style="flex:1;min-width:220px"><label for="npd">New cards per day</label>
                <p class="small muted">Across all modules. Each new card adds a few reviews over the next weeks.</p></div>
              <input type="number" id="npd" min="0" max="999" value="${st.newPerDay}" style="width:90px">
            </div>
          </div>
          <div class="card pad">
            <div class="row between">
              <div class="field" style="flex:1;min-width:220px"><label for="ret">Target recall</label>
                <p class="small muted">How likely you should be to remember a card when it comes up. Higher means more frequent reviews.</p></div>
              <select id="ret">
                ${[[0.85, "85%, fewer reviews"], [0.9, "90%, recommended"], [0.95, "95%, more reviews"]].map(([v, l]) => `<option value="${v}" ${st.retention === v ? "selected" : ""}>${l}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="card pad">
            <div class="row between">
              <div class="field" style="flex:1;min-width:220px"><label for="theme">Appearance</label></div>
              <select id="theme">${[["auto", "Match system"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => `<option value="${v}" ${st.theme === v ? "selected" : ""}>${l}</option>`).join("")}</select>
            </div>
          </div>
        </section>

        <section>
          <div class="section-h"><h2>Backup</h2></div>
          <div class="card pad">
            <p class="small muted" style="margin-bottom:12px">A backup holds every card's text and your review history. Images and podcasts stay in storage and aren't included.</p>
            <div class="row"><button class="btn sm" id="bk-down">Download backup</button><button class="btn sm" id="bk-up">Restore from backup</button></div>
          </div>
        </section>
      </div>`;
    renderSync();

    const f = $("#sign-in");
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const tok = $("#tok").value.trim(); if (!tok) return;
      S.token = tok;
      try { await api("/api/auth", { method: "POST" }); S.authOk = true; S.syncError = null; lsSet("rd_token", tok); toast("Signed in"); await connect(); renderSettings(); }
      catch (err) { S.token = null; S.authOk = false; $("#sync-detail").textContent = err.status === 401 ? "That token didn't match. Check the value you set with wrangler secret put ADMIN_TOKEN." : err.message; }
    };
    const so = $("#sign-out"); if (so) so.onclick = () => { S.token = null; S.authOk = false; lsSet("rd_token", null); renderSync(); renderSettings(); };
    const sn = $("#sync-now"); if (sn) sn.onclick = async () => { S.syncError = null; await connect(); toast(S.syncError ? "Sync paused" : "Synced"); };

    $("#npd").onchange = async (e) => { S.user.settings.newPerDay = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0)); await saveUser(); toast("Saved"); };
    $("#ret").onchange = async (e) => { S.user.settings.retention = Number(e.target.value); await saveUser(); toast("Saved"); };
    $("#theme").onchange = async (e) => { S.user.settings.theme = e.target.value; applyTheme(); await saveUser(); };

    $("#bk-down").onclick = () => {
      const data = { app: "raddeck", version: 6, exportedAt: new Date().toISOString(), user: S.user, pods: S.pods, decks: S.decks };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      a.download = `raddeck-backup-${dayKey()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    $("#bk-up").onclick = () => {
      const inp = $("#file-backup"); inp.value = "";
      inp.onchange = async () => {
        try {
          const data = JSON.parse(await inp.files[0].text());
          if (data.app !== "raddeck" || !data.decks) throw new Error("That isn't a RadDeck backup file.");
          if (!confirm("Restore this backup? It replaces the cards and progress for every module it contains.")) return;
          S.user = normalizeUser(data.user); rebuildMods(); await saveUser();
          for (const [mid, d] of Object.entries(data.decks)) { if (!MOD[mid]) continue; S.decks[mid] = normalizeDeck(d); await saveDeck(mid); }
          S.pods = normalizePods(data.pods); await savePods();
          applyTheme(); toast("Backup restored"); renderSettings();
        } catch (e) { toast(e.message || "Couldn't read that file"); }
      };
      inp.click();
    };
  }

  /* ================= boot ================= */
  async function boot() {
    try {
      const [user, pods, outbox, decks, blobKeys, base] = await Promise.all([
        idb.get("kv", "user"), idb.get("kv", "pods"), idb.get("kv", "outbox"), idb.entries("decks"), idb.keys("blobs"), idb.get("kv", "base"),
      ]);
      if (user) S.user = normalizeUser(user);
      rebuildMods();
      if (pods) S.pods = normalizePods(pods);
      if (Array.isArray(outbox)) S.outbox = new Map(outbox);
      if (base && typeof base === "object") S.base = base;
      for (const [k, v] of decks) S.decks[k] = normalizeDeck(v);
      for (const k of blobKeys) if (String(k).startsWith("audio/")) S.localAudio.add(String(k).slice(6));
    } catch (e) {
      console.error(e);
      toast("This browser blocked local storage, so progress won't be saved here.");
    }
    if (!MODS.length) rebuildMods();
    applyTheme();
    window.addEventListener("hashchange", route);
    route();
    renderSync();
    await connect();
    // re-render with whatever came from the server, unless mid-study
    if (!location.hash.startsWith("#/study")) route();
    // Coming back to the tab (or every 2 minutes while it's open): pick up changes from other devices.
    const refresh = async () => {
      if (S.syncing || !S.online) return;
      await connect();
      const h = location.hash;
      if (h.startsWith("#/study")) { if (session && session.stale) { session.stale = false; route(); } }
      else if (h === "" || h === "#/" || h === "#/podcasts") route();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
      else if (Date.now() - S.lastSync > 60000) refresh();
    });
    setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 120000);
    window.addEventListener("online", () => connect());
  }
  boot();
})();
