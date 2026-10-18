/* RadDeck — Anki .apkg importer (runs in the browser; also loadable in Node for tests).
 *
 * parseApkg(arrayBuffer, { openZip, SQL, fzstd }) ->
 *   { cards: [{ front, back, tags, nid }], media: [{ name, read: () => Promise<Uint8Array> }], notes, notetypes }
 *
 * Handles legacy packages (collection.anki2 / .anki21, JSON media map) and
 * current ones (collection.anki21b compressed with zstd, protobuf media map).
 * Basic note types render front/back fields from the first template; cloze
 * note types produce one card per cloze number.
 */
(function (root) {
  "use strict";

  /* ---------- tiny protobuf reader ---------- */
  function readVarint(buf, pos) {
    let result = 0, shift = 0, b;
    do {
      b = buf[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (b & 0x80);
    return [result, pos];
  }
  function pbFields(buf) {
    const out = [];
    let pos = 0;
    while (pos < buf.length) {
      let key; [key, pos] = readVarint(buf, pos);
      const field = Math.floor(key / 8), wire = key % 8;
      if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); out.push({ field, wire, value: v }); }
      else if (wire === 1) { out.push({ field, wire, value: buf.subarray(pos, pos + 8) }); pos += 8; }
      else if (wire === 2) { let len; [len, pos] = readVarint(buf, pos); out.push({ field, wire, value: buf.subarray(pos, pos + len) }); pos += len; }
      else if (wire === 5) { out.push({ field, wire, value: buf.subarray(pos, pos + 4) }); pos += 4; }
      else throw new Error("Unsupported protobuf wire type " + wire);
    }
    return out;
  }
  const utf8 = (b) => new TextDecoder().decode(b);
  const isZstd = (b) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

  /* ---------- template helpers ---------- */
  const SPECIAL = new Set(["FrontSide", "Tags", "Type", "Deck", "Subdeck", "Card", "CardFlag"]);
  function fieldsInTemplate(tmpl) {
    const names = [];
    const re = /\{\{([^{}]+)\}\}/g;
    let m;
    while ((m = re.exec(tmpl || ""))) {
      let tok = m[1].trim();
      if (/^[#^/]/.test(tok)) continue; // conditionals
      tok = tok.split(":").pop().trim(); // strip modifiers like cloze:, hint:, type:
      if (!tok || SPECIAL.has(tok)) continue;
      if (!names.includes(tok)) names.push(tok);
    }
    return names;
  }
  function clozeFieldInTemplate(tmpl) {
    const m = /\{\{\s*cloze:([^{}]+)\}\}/.exec(tmpl || "");
    return m ? m[1].trim() : null;
  }

  function stripSound(html) {
    return String(html || "").replace(/\[sound:[^\]]*\]/g, "");
  }
  function isBlank(html) {
    return !String(html || "").replace(/<br\s*\/?>/gi, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim();
  }
  function mediaNamesIn(html) {
    const names = [];
    const re = /<(?:img|audio|video|source)\b[^>]*\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(html || ""))) {
      const src = m[1] ?? m[2] ?? m[3];
      if (/^(https?:|data:|\/)/i.test(src)) continue;
      try { names.push(decodeURIComponent(src)); } catch { names.push(src); }
    }
    return names;
  }

  /* ---------- cloze rendering ---------- */
  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
  function clozeNumbers(text) {
    const s = new Set();
    let m;
    CLOZE_RE.lastIndex = 0;
    while ((m = CLOZE_RE.exec(text))) s.add(Number(m[1]));
    return [...s].sort((a, b) => a - b);
  }
  function renderCloze(text, n, reveal) {
    return text.replace(CLOZE_RE, (_, num, answer, hint) => {
      if (Number(num) !== n) return answer;
      if (reveal) return `<span class="cloze">${answer}</span>`;
      return `<span class="cloze cloze-gap">${hint ? hint : "…"}</span>`;
    });
  }

  function fieldBlock(label, html, showLabel) {
    return showLabel ? `<div class="fld"><div class="fld-name">${label}</div>${html}</div>` : html;
  }

  /* ---------- schema readers ---------- */
  function tableExists(db, name) {
    const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
    return r.length > 0 && r[0].values.length > 0;
  }
  function rows(db, sql) {
    const r = db.exec(sql);
    if (!r.length) return [];
    const cols = r[0].columns;
    return r[0].values.map((v) => Object.fromEntries(v.map((x, i) => [cols[i], x])));
  }

  function readNotetypes(db) {
    const types = {};
    let fromTables = false;
    if (tableExists(db, "notetypes") && tableExists(db, "fields")) {
      for (const nt of rows(db, "SELECT id, name, config FROM notetypes")) {
        let cloze = false;
        try {
          const kind = pbFields(nt.config).find((f) => f.field === 1 && f.wire === 0);
          cloze = Boolean(kind && kind.value === 1);
        } catch { /* ignore */ }
        types[String(nt.id)] = { name: nt.name, cloze, fields: [], templates: [] };
      }
      for (const f of rows(db, "SELECT ntid, ord, name FROM fields ORDER BY ntid, ord")) {
        const t = types[String(f.ntid)];
        if (t) t.fields.push(f.name);
      }
      if (tableExists(db, "templates")) {
        for (const t of rows(db, "SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord")) {
          const nt = types[String(t.ntid)];
          if (!nt) continue;
          let q = "", a = "";
          try {
            for (const f of pbFields(t.config)) {
              if (f.field === 1 && f.wire === 2) q = utf8(f.value);
              if (f.field === 2 && f.wire === 2) a = utf8(f.value);
            }
          } catch { /* ignore */ }
          nt.templates.push({ name: t.name, qfmt: q, afmt: a });
        }
      }
      fromTables = Object.values(types).some((t) => t.fields.length);
    }
    if (!fromTables) {
      const col = rows(db, "SELECT models FROM col LIMIT 1")[0];
      const models = col && col.models ? JSON.parse(col.models) : {};
      for (const [id, m] of Object.entries(models)) {
        types[String(id)] = {
          name: m.name,
          cloze: m.type === 1,
          fields: (m.flds || []).slice().sort((a, b) => a.ord - b.ord).map((f) => f.name),
          templates: (m.tmpls || []).slice().sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
        };
      }
    }
    return types;
  }

  /* ---------- note -> cards ---------- */
  function cardsForNote(note, nt) {
    const vals = String(note.flds).split("\x1f").map(stripSound);
    const names = nt && nt.fields.length ? nt.fields : vals.map((_, i) => `Field ${i + 1}`);
    const byName = {};
    names.forEach((n, i) => { byName[n] = vals[i] || ""; });
    const tags = String(note.tags || "").trim().split(/\s+/).filter(Boolean);
    const out = [];

    const looksCloze = (nt && nt.cloze) || vals.some((v) => /\{\{c\d+::/.test(v));
    if (looksCloze) {
      let cf = nt && nt.templates[0] ? clozeFieldInTemplate(nt.templates[0].qfmt) : null;
      if (!cf || !(cf in byName)) cf = names.find((n) => /\{\{c\d+::/.test(byName[n])) || names[0];
      const text = byName[cf] || "";
      const extras = names.filter((n) => n !== cf && !isBlank(byName[n]));
      const extraHtml = extras.map((n) => fieldBlock(n, byName[n], true)).join("");
      for (const n of clozeNumbers(text)) {
        out.push({
          nid: String(note.id), ord: n, tags,
          front: renderCloze(text, n, false),
          back: renderCloze(text, n, true) + (extraHtml ? `<div class="extra">${extraHtml}</div>` : ""),
        });
      }
      return out;
    }

    const templates = nt && nt.templates.length ? nt.templates : [null];
    templates.forEach((t, ti) => {
      let frontNames = t ? fieldsInTemplate(t.qfmt).filter((n) => n in byName) : [];
      let backNames = t ? fieldsInTemplate(t.afmt).filter((n) => n in byName && !frontNames.includes(n)) : [];
      if (!frontNames.length) { frontNames = [names[0]]; backNames = names.slice(1); }
      if (!backNames.length) backNames = names.filter((n) => !frontNames.includes(n));
      const fParts = frontNames.filter((n) => !isBlank(byName[n]));
      const bParts = backNames.filter((n) => !isBlank(byName[n]));
      if (!fParts.length) return; // template produces an empty front for this note
      const front = fParts.map((n) => fieldBlock(n, byName[n], fParts.length > 1)).join("");
      const back = bParts.map((n) => fieldBlock(n, byName[n], bParts.length > 1)).join("");
      out.push({ nid: String(note.id), ord: ti, tags, front, back: back || "<i>No answer side</i>" });
    });
    return out;
  }

  /* ---------- media map ---------- */
  async function readMediaMap(zip, fzstd) {
    if (!zip.has("media")) return {};
    const bytes = await zip.read("media");
    try {
      const txt = utf8(bytes);
      const obj = JSON.parse(txt);
      if (obj && typeof obj === "object") return obj; // { "0": "name.jpg" }
    } catch { /* not JSON: new format */ }
    let raw = bytes;
    if (isZstd(bytes)) {
      if (!fzstd) throw new Error("This package uses zstd compression and the decompressor did not load.");
      raw = fzstd.decompress(bytes);
    }
    const map = {};
    let i = 0;
    for (const entry of pbFields(raw)) {
      if (entry.field !== 1 || entry.wire !== 2) continue;
      const name = pbFields(entry.value).find((f) => f.field === 1 && f.wire === 2);
      if (name) map[String(i)] = utf8(name.value);
      i++;
    }
    return map;
  }

  /* ---------- main ---------- */
  async function parseApkg(buffer, libs) {
    const { openZip, SQL, fzstd } = libs;
    const zip = openZip(buffer);
    const pick = ["collection.anki21b", "collection.anki21", "collection.anki2"].find((n) => zip.has(n) && zip.size(n) > 0);
    if (!pick) throw new Error("Not an Anki package: no collection file inside the zip.");
    let dbBytes = await zip.read(pick);
    if (isZstd(dbBytes)) {
      if (!fzstd) throw new Error("This package uses zstd compression and the decompressor did not load.");
      dbBytes = fzstd.decompress(dbBytes);
    }
    const db = new SQL.Database(dbBytes);
    let cards = [];
    let notes = [];
    let notetypes = {};
    try {
      notetypes = readNotetypes(db);
      notes = rows(db, "SELECT id, mid, flds, tags FROM notes ORDER BY id");
      for (const n of notes) cards.push(...cardsForNote(n, notetypes[String(n.mid)]));
    } finally {
      db.close();
    }

    const map = await readMediaMap(zip, fzstd);
    const used = new Set();
    for (const c of cards) for (const n of mediaNamesIn(c.front + c.back)) used.add(n);
    const media = [];
    for (const [idx, name] of Object.entries(map)) {
      if (!used.has(name)) continue;
      if (!zip.has(idx)) continue;
      media.push({ name, read: () => zip.read(idx) });
    }
    return { cards, media, notes: notes.length, notetypes: Object.values(notetypes).map((t) => t.name) };
  }

  /* ---------- plain text (tab / comma separated) ---------- */
  function parseText(text) {
    const cards = [];
    const lines = String(text).replace(/\r/g, "").split("\n");
    for (let line of lines) {
      if (!line.trim() || line.startsWith("#")) continue;
      let parts;
      if (line.includes("\t")) parts = line.split("\t");
      else {
        parts = [];
        let cur = "", q = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
          else if (ch === "," && !q) { parts.push(cur); cur = ""; }
          else cur += ch;
        }
        parts.push(cur);
      }
      parts = parts.map((p) => p.trim().replace(/^"(.*)"$/s, "$1"));
      if (parts.length < 2 || !parts[0]) continue;
      cards.push({ front: parts[0], back: parts.slice(1).filter(Boolean).join("<br>"), tags: [] });
    }
    return { cards, media: [] };
  }

  root.AnkiImport = { parseApkg, parseText, mediaNamesIn };
})(typeof window !== "undefined" ? window : globalThis);
