--c29914d823f128c3eae110ebb0832cb2db2072d6c4a3f8c73b4f688b5b09
Content-Disposition: form-data; name="worker.js"; filename="worker.js"
Content-Type: application/javascript+module

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.ts
var MAX_AUDIO_BYTES = 300 * 1024 * 1024;
var MAX_JSON_BYTES = 25 * 1024 * 1024;
var MAX_MEDIA_BYTES = 25 * 1024 * 1024;
var AUDIO_EXTS = /* @__PURE__ */ new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".flac",
  ".mp4",
  ".webm"
]);
var MEDIA_EXTS = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".avif",
  ".tif",
  ".tiff",
  ".ico"
]);
var AUDIO_KEY = /* @__PURE__ */ __name((mid) => `audio/${mid}`, "AUDIO_KEY");
var MEDIA_PRE = "media/";
var MEDIA_KEY = /* @__PURE__ */ __name((key) => `${MEDIA_PRE}${key}`, "MEDIA_KEY");
var USER_KEY = "flashcards/user.json";
var PODS_KEY = "flashcards/podcasts.json";
var DEL_KEY = "flashcards/deleted.json";
var CARDS_PRE = "flashcards/cards/";
var CARDS_KEY = /* @__PURE__ */ __name((mid) => `${CARDS_PRE}${mid}.json`, "CARDS_KEY");
async function getTombstones(env) {
  const d = await getJSON(env, DEL_KEY);
  if (d && typeof d === "object") {
    const t = d;
    return {
      cards: t.cards && typeof t.cards === "object" ? t.cards : {},
      pods: t.pods && typeof t.pods === "object" ? t.pods : {}
    };
  }
  return { cards: {}, pods: {} };
}
__name(getTombstones, "getTombstones");
async function putTombstones(env, t) {
  await env.APP_STORAGE.put(DEL_KEY, JSON.stringify(t), {
    httpMetadata: { contentType: "application/json" }
  });
}
__name(putTombstones, "putTombstones");
var JSON_HDRS = { "content-type": "application/json; charset=utf-8" };
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HDRS, ...extra }
  });
}
__name(json, "json");
function err(status, code, message) {
  return json({ error: code, message }, status);
}
__name(err, "err");
function sanitizeId(raw) {
  if (!raw) return null;
  let id;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) return null;
  if (id.includes("..")) return null;
  return id;
}
__name(sanitizeId, "sanitizeId");
function sanitizeMediaKey(raw) {
  if (!raw) return null;
  let key;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const ci = key.indexOf(":");
  if (ci <= 0) return null;
  const mid = key.slice(0, ci);
  const file = key.slice(ci + 1);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(mid)) return null;
  if (!/^[^/\\"<>\s]{1,160}$/.test(file)) return null;
  if (mid.includes("..") || file.includes("..")) return null;
  return `${mid}:${file}`;
}
__name(sanitizeMediaKey, "sanitizeMediaKey");
function guessImageMime(filename, fallback) {
  if (fallback && /^image\/[\w.+-]+$/.test(fallback)) return fallback;
  switch (extOf(filename)) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}
__name(guessImageMime, "guessImageMime");
function sanitizeFilename(name) {
  const base = (name || "audio").split(/[\\/]/).pop() || "audio";
  const clean = base.replace(/[^\w. ()-]+/g, "_").slice(0, 120);
  return clean || "audio";
}
__name(sanitizeFilename, "sanitizeFilename");
function extOf(filename) {
  const m = filename.toLowerCase().match(/\.[a-z0-9]{1,6}$/);
  return m ? m[0] : "";
}
__name(extOf, "extOf");
function guessAudioMime(filename, fallback) {
  if (fallback && /^(audio|video)\/[\w.+-]+$/.test(fallback)) {
    return fallback;
  }
  switch (extOf(filename)) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
    case ".aac":
    case ".mp4":
      return "audio/mp4";
    case ".ogg":
    case ".oga":
    case ".opus":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".webm":
      return "audio/webm";
    default:
      return "audio/mpeg";
  }
}
__name(guessAudioMime, "guessAudioMime");
function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const got = request.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!got.startsWith(prefix)) return false;
  const tok = got.slice(prefix.length).trim();
  if (tok.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
__name(isAdmin, "isAdmin");
function needAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    return err(
      503,
      "not_configured",
      "ADMIN_TOKEN secret is not set on this Worker. Run: npx wrangler secret put ADMIN_TOKEN"
    );
  }
  if (!isAdmin(request, env)) {
    return err(401, "unauthorized", "valid admin token required for uploads, edits and deletes");
  }
  return null;
}
__name(needAdmin, "needAdmin");
async function getJSON(env, key) {
  const obj = await env.APP_STORAGE.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}
__name(getJSON, "getJSON");
async function putJSON(request, env, key) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_JSON_BYTES) return err(413, "too_large", "JSON body exceeds 25 MB");
  let data;
  try {
    data = await request.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  await env.APP_STORAGE.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" }
  });
  return json({ ok: true, key });
}
__name(putJSON, "putJSON");
async function allCards(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.APP_STORAGE.list({ prefix: CARDS_PRE, cursor, limit: 1e3 });
    for (const item of page.objects) {
      const data = await getJSON(env, item.key);
      if (data && typeof data === "object" && Array.isArray(data.cards)) {
        out.push(...data.cards);
      }
    }
    cursor = page.truncated ? page.cursor : void 0;
  } while (cursor);
  return out;
}
__name(allCards, "allCards");
async function listAudio(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.APP_STORAGE.list({ prefix: "audio/", cursor, limit: 1e3 });
    for (const o of page.objects) {
      const head = await env.APP_STORAGE.head(o.key);
      items.push({
        id: o.key.slice("audio/".length),
        size: o.size,
        uploaded: o.uploaded.toISOString(),
        filename: head?.customMetadata?.filename || o.key,
        contentType: head?.httpMetadata?.contentType || "audio/mpeg"
      });
    }
    cursor = page.truncated ? page.cursor : void 0;
  } while (cursor);
  return json({ audio: items });
}
__name(listAudio, "listAudio");
async function uploadAudio(request, env, mid) {
  const filename = sanitizeFilename(request.headers.get("x-filename"));
  const ext = extOf(filename);
  if (ext && !AUDIO_EXTS.has(ext)) {
    return err(415, "bad_type", `unsupported audio extension "${ext}"`);
  }
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_AUDIO_BYTES) return err(413, "too_large", "audio exceeds 300 MB");
  if (!request.body) return err(400, "empty", "no audio bytes received");
  const existing = await env.APP_STORAGE.head(AUDIO_KEY(mid));
  const overwrite = (request.headers.get("x-overwrite") || "").toLowerCase() === "true";
  if (existing && !overwrite) {
    return err(
      409,
      "exists",
      `audio for "${mid}" already exists \u2014 resend with header x-overwrite: true to replace it`
    );
  }
  const contentType = guessAudioMime(filename, request.headers.get("content-type"));
  await env.APP_STORAGE.put(AUDIO_KEY(mid), request.body, {
    httpMetadata: { contentType, contentDisposition: `inline; filename="${filename}"` },
    customMetadata: { filename }
  });
  return json({ ok: true, key: AUDIO_KEY(mid), size: len, contentType });
}
__name(uploadAudio, "uploadAudio");
async function getAudio(request, env, mid) {
  const key = AUDIO_KEY(mid);
  const rangeHdr = request.headers.get("range");
  if (rangeHdr) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHdr.trim());
    if (!m || m[1] === "" && m[2] === "") {
      return new Response("bad range", { status: 416, headers: { "content-range": "bytes */*" } });
    }
    const head = await env.APP_STORAGE.head(key);
    if (!head) return err(404, "not_found", `no audio stored for "${mid}"`);
    const size = head.size;
    let start, end;
    if (m[1] === "") {
      const n = Math.min(parseInt(m[2], 10), size);
      start = size - n;
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start > end || start >= size) {
      return new Response("range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` }
      });
    }
    const obj2 = await env.APP_STORAGE.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj2 || !obj2.body) return err(404, "not_found", `no audio stored for "${mid}"`);
    const ct2 = obj2.httpMetadata?.contentType || "audio/mpeg";
    return new Response(obj2.body, {
      status: 206,
      headers: {
        "content-type": ct2,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=3600",
        "content-disposition": `inline; filename="${obj2.customMetadata?.filename || mid}"`
      }
    });
  }
  const obj = await env.APP_STORAGE.get(key);
  if (!obj || !obj.body) return err(404, "not_found", `no audio stored for "${mid}"`);
  const ct = obj.httpMetadata?.contentType || "audio/mpeg";
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": ct,
      "content-length": String(obj.size),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="${obj.customMetadata?.filename || mid}"`
    }
  });
}
__name(getAudio, "getAudio");
async function deleteAudio(env, mid) {
  await env.APP_STORAGE.delete(AUDIO_KEY(mid));
  return json({ ok: true, deleted: AUDIO_KEY(mid) });
}
__name(deleteAudio, "deleteAudio");
async function listMedia(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.APP_STORAGE.list({ prefix: MEDIA_PRE, cursor, limit: 1e3 });
    for (const o of page.objects) {
      const head = await env.APP_STORAGE.head(o.key);
      items.push({
        key: o.key.slice(MEDIA_PRE.length),
        size: o.size,
        uploaded: o.uploaded.toISOString(),
        contentType: head?.httpMetadata?.contentType || "application/octet-stream"
      });
    }
    cursor = page.truncated ? page.cursor : void 0;
  } while (cursor);
  return json({ media: items });
}
__name(listMedia, "listMedia");
async function uploadMedia(request, env, key) {
  const filename = key.slice(key.indexOf(":") + 1);
  const ext = extOf(filename);
  if (!ext || !MEDIA_EXTS.has(ext)) {
    return err(415, "bad_type", `unsupported media extension "${ext || "(none)"}" \u2014 images only`);
  }
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_MEDIA_BYTES) return err(413, "too_large", "media file exceeds 25 MB");
  if (!request.body) return err(400, "empty", "no media bytes received");
  const existing = await env.APP_STORAGE.head(MEDIA_KEY(key));
  const overwrite = (request.headers.get("x-overwrite") || "").toLowerCase() === "true";
  if (existing && !overwrite) {
    return err(
      409,
      "exists",
      `media "${key}" already exists \u2014 resend with header x-overwrite: true to replace it`
    );
  }
  const contentType = guessImageMime(filename, request.headers.get("content-type"));
  await env.APP_STORAGE.put(MEDIA_KEY(key), request.body, {
    httpMetadata: { contentType },
    customMetadata: { filename }
  });
  return json({ ok: true, key: MEDIA_KEY(key), size: len, contentType });
}
__name(uploadMedia, "uploadMedia");
async function getMedia(env, key) {
  const obj = await env.APP_STORAGE.get(MEDIA_KEY(key));
  if (!obj || !obj.body) return err(404, "not_found", `no media stored for "${key}"`);
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "content-length": String(obj.size),
      /* keyed by content-addressable moduleId:filename — safe to cache hard */
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}
__name(getMedia, "getMedia");
async function deleteMedia(env, key) {
  await env.APP_STORAGE.delete(MEDIA_KEY(key));
  return json({ ok: true, deleted: MEDIA_KEY(key) });
}
__name(deleteMedia, "deleteMedia");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    if (path === "/api/health") {
      return json({ ok: true, service: "raddeck", time: (/* @__PURE__ */ new Date()).toISOString() });
    }
    if (path === "/api/flashcards") {
      const [user, pods, cardsPage] = await Promise.all([
        env.APP_STORAGE.head(USER_KEY),
        env.APP_STORAGE.head(PODS_KEY),
        env.APP_STORAGE.list({ prefix: CARDS_PRE, limit: 1e3 })
      ]);
      return json({
        user: user ? { size: user.size, uploaded: user.uploaded.toISOString() } : null,
        podcasts: pods ? { size: pods.size, uploaded: pods.uploaded.toISOString() } : null,
        decks: cardsPage.objects.map((o) => ({
          id: o.key.slice(CARDS_PRE.length, -".json".length),
          size: o.size,
          uploaded: o.uploaded.toISOString()
        }))
      });
    }
    if (path === "/api/flashcards/cards" && method === "GET") {
      return json(await allCards(env));
    }
    if (path === "/api/flashcards/podcasts") {
      if (method === "GET") return json(await getJSON(env, PODS_KEY) ?? {});
      if (method === "PUT") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        const resp = await putJSON(request, env, PODS_KEY);
        if (resp.ok) {
          try {
            const body = await getJSON(env, PODS_KEY);
            const t = await getTombstones(env);
            let changed = false;
            if (body && typeof body === "object") {
              for (const mid of Object.keys(body)) {
                if (mid in t.pods) {
                  delete t.pods[mid];
                  changed = true;
                }
              }
            }
            if (changed) await putTombstones(env, t);
          } catch {
          }
        }
        return resp;
      }
    }
    if (path === "/api/flashcards/deleted" && method === "GET") {
      return json(await getTombstones(env));
    }
    if (path === "/api/flashcards/user") {
      if (method === "GET") return json(await getJSON(env, USER_KEY));
      if (method === "PUT") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        return putJSON(request, env, USER_KEY);
      }
    }
    let mm = path.match(/^\/api\/flashcards\/cards\/([^/]+)$/);
    if (mm) {
      const mid = sanitizeId(mm[1]);
      if (!mid) return err(400, "bad_id", "invalid module id");
      if (method === "GET") return json(await getJSON(env, CARDS_KEY(mid)) ?? { cards: [] });
      if (method === "PUT") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        const len = Number(request.headers.get("content-length") || "0");
        if (len > MAX_JSON_BYTES) return err(413, "too_large", "deck exceeds 25 MB");
        let data;
        try {
          data = await request.json();
        } catch {
          return err(400, "bad_json", "body must be JSON: { cards: [...] }");
        }
        if (!data || typeof data !== "object" || !Array.isArray(data.cards)) {
          return err(400, "bad_shape", "deck body must look like { cards: [...] }");
        }
        await env.APP_STORAGE.put(CARDS_KEY(mid), JSON.stringify(data), {
          httpMetadata: { contentType: "application/json" }
        });
        const t = await getTombstones(env);
        if (mid in t.cards) {
          delete t.cards[mid];
          await putTombstones(env, t);
        }
        return json({ ok: true, key: CARDS_KEY(mid), count: data.cards.length });
      }
      if (method === "DELETE") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        await env.APP_STORAGE.delete(CARDS_KEY(mid));
        const t = await getTombstones(env);
        t.cards[mid] = Date.now();
        await putTombstones(env, t);
        return json({ ok: true, deleted: CARDS_KEY(mid) });
      }
    }
    mm = path.match(/^\/api\/flashcards\/podcasts\/([^/]+)$/);
    if (mm) {
      const mid = sanitizeId(mm[1]);
      if (!mid) return err(400, "bad_id", "invalid module id");
      if (method === "DELETE") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        const pods = await getJSON(env, PODS_KEY);
        if (pods && typeof pods === "object" && mid in pods) {
          delete pods[mid];
          await env.APP_STORAGE.put(PODS_KEY, JSON.stringify(pods), {
            httpMetadata: { contentType: "application/json" }
          });
        }
        const t = await getTombstones(env);
        t.pods[mid] = Date.now();
        await putTombstones(env, t);
        return json({ ok: true, removed: mid });
      }
    }
    if (path === "/api/audio" && method === "GET") return listAudio(env);
    mm = path.match(/^\/api\/audio\/([^/]+)$/);
    if (mm) {
      const mid = sanitizeId(mm[1]);
      if (!mid) return err(400, "bad_id", "invalid module id");
      if (method === "GET" || method === "HEAD") return getAudio(request, env, mid);
      if (method === "PUT") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        return uploadAudio(request, env, mid);
      }
      if (method === "DELETE") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        return deleteAudio(env, mid);
      }
    }
    if (path === "/api/media" && method === "GET") return listMedia(env);
    mm = path.match(/^\/api\/media\/([^/]+)$/);
    if (mm) {
      const mkey = sanitizeMediaKey(mm[1]);
      if (!mkey) return err(400, "bad_key", "invalid media key (expected <moduleId>:<filename>)");
      if (method === "GET" || method === "HEAD") return getMedia(env, mkey);
      if (method === "PUT") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        return uploadMedia(request, env, mkey);
      }
      if (method === "DELETE") {
        const gate = needAdmin(request, env);
        if (gate) return gate;
        return deleteMedia(env, mkey);
      }
    }
    if (path.startsWith("/api/")) return err(404, "not_found", `no route: ${method} ${path}`);
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map

--c29914d823f128c3eae110ebb0832cb2db2072d6c4a3f8c73b4f688b5b09--
