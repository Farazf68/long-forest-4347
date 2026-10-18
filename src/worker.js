/**
 * RadDeck — Cloudflare Worker API
 *
 * Storage (R2 bucket bound as APP_STORAGE):
 *   flashcards/user.json          study progress + settings   (customMetadata.updatedAt)
 *   flashcards/podcasts.json      podcast schedule per module (customMetadata.updatedAt)
 *   flashcards/cards/{mid}.json   cards for one module        (customMetadata.updatedAt, count)
 *   audio/{mid}                   podcast audio for one module
 *   media/{mid}/{filename}        images referenced by that module's cards
 *
 * Reads are public. Writes need `Authorization: Bearer <ADMIN_TOKEN>`.
 * ADMIN_TOKEN is a Worker secret:  npx wrangler secret put ADMIN_TOKEN
 */

const MAX_AUDIO_BYTES = 300 * 1024 * 1024;
const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const USER_KEY = "flashcards/user.json";
const PODS_KEY = "flashcards/podcasts.json";
const CARDS_PRE = "flashcards/cards/";
const cardsKey = (mid) => `${CARDS_PRE}${mid}.json`;
const audioKey = (mid) => `audio/${mid}`;
const mediaKey = (k) => `media/${k}`;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,120}$/i;

const JSON_HDRS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HDRS, ...extra } });
}
function err(status, code, message) {
  return json({ error: code, message }, status);
}

/* ---------- auth ---------- */

function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const got = request.headers.get("authorization") || "";
  if (!got.startsWith("Bearer ")) return false;
  const tok = got.slice(7).trim();
  if (tok.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function needAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    return err(503, "not_configured", "ADMIN_TOKEN secret is not set. Run: npx wrangler secret put ADMIN_TOKEN");
  }
  if (!isAdmin(request, env)) return err(401, "unauthorized", "Sign in with the admin token to make changes.");
  return null;
}

/* ---------- helpers ---------- */

async function readJSON(env, key) {
  const obj = await env.APP_STORAGE.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

async function readBody(request, max) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > max) return { error: err(413, "too_large", `Body exceeds ${Math.round(max / 1048576)} MB`) };
  const text = await request.text();
  if (text.length > max) return { error: err(413, "too_large", `Body exceeds ${Math.round(max / 1048576)} MB`) };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: err(400, "bad_json", "Body is not valid JSON") };
  }
}

async function putJSON(env, key, data, meta = {}) {
  const updatedAt = String(data && data.updatedAt ? data.updatedAt : Date.now());
  await env.APP_STORAGE.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { updatedAt, ...meta },
  });
  return updatedAt;
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.APP_STORAGE.list({ prefix, cursor, limit: 1000, include: ["customMetadata", "httpMetadata"] });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

function safeFilename(name) {
  return String(name || "").replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
}

/* ---------- binary objects (audio / media) ---------- */

async function putBinary(request, env, key, { max, defaultType, extraMeta = {} }) {
  const len = Number(request.headers.get("content-length") || 0);
  if (!len) return err(411, "length_required", "Content-Length header is required");
  if (len > max) return err(413, "too_large", `File exceeds ${Math.round(max / 1048576)} MB`);
  const contentType = request.headers.get("content-type") || defaultType;
  let raw = request.headers.get("x-filename") || key.split("/").pop();
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  const filename = safeFilename(raw);
  await env.APP_STORAGE.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: { filename, uploadedAt: String(Date.now()), ...extraMeta },
  });
  return json({ ok: true, key, filename, size: len, contentType });
}

async function getBinary(request, env, key, { cacheControl }) {
  const range = request.headers.get("range");
  const head = await env.APP_STORAGE.head(key);
  if (!head) return err(404, "not_found", "Nothing stored here");
  const size = head.size;
  const ct = head.httpMetadata?.contentType || "application/octet-stream";
  const base = {
    "content-type": ct,
    "accept-ranges": "bytes",
    "cache-control": cacheControl,
    "content-disposition": `inline; filename="${head.customMetadata?.filename || key.split("/").pop()}"`,
    etag: head.httpEtag,
  };

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { ...base, "content-length": String(size) } });
  }

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
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
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    const obj = await env.APP_STORAGE.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return err(404, "not_found", "Nothing stored here");
    return new Response(obj.body, {
      status: 206,
      headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
    });
  }

  const obj = await env.APP_STORAGE.get(key);
  if (!obj) return err(404, "not_found", "Nothing stored here");
  return new Response(obj.body, { status: 200, headers: { ...base, "content-length": String(size) } });
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (path === "/api/health") {
        return json({ ok: true, adminConfigured: Boolean(env.ADMIN_TOKEN), time: Date.now() });
      }

      if (path === "/api/auth" && method === "POST") {
        const bad = needAdmin(request, env);
        return bad || json({ ok: true });
      }

      /* manifest: what exists on the server and when it last changed */
      if (path === "/api/flashcards" && method === "GET") {
        const [user, pods, cardObjs, audioObjs] = await Promise.all([
          env.APP_STORAGE.head(USER_KEY),
          env.APP_STORAGE.head(PODS_KEY),
          listAll(env, CARDS_PRE),
          listAll(env, "audio/"),
        ]);
        const cards = {};
        for (const o of cardObjs) {
          const mid = o.key.slice(CARDS_PRE.length).replace(/\.json$/, "");
          cards[mid] = { updatedAt: Number(o.customMetadata?.updatedAt || 0), count: Number(o.customMetadata?.count || 0) };
        }
        const audio = {};
        for (const o of audioObjs) {
          audio[o.key.slice(6)] = {
            size: o.size,
            filename: o.customMetadata?.filename || null,
            contentType: o.httpMetadata?.contentType || null,
            uploadedAt: Number(o.customMetadata?.uploadedAt || 0),
          };
        }
        return json({
          user: user ? { updatedAt: Number(user.customMetadata?.updatedAt || 0) } : null,
          podcasts: pods ? { updatedAt: Number(pods.customMetadata?.updatedAt || 0) } : null,
          cards,
          audio,
        });
      }

      if (path === "/api/flashcards/user" || path === "/api/flashcards/podcasts") {
        const key = path.endsWith("user") ? USER_KEY : PODS_KEY;
        if (method === "GET") return json((await readJSON(env, key)) ?? null);
        if (method === "PUT") {
          const bad = needAdmin(request, env);
          if (bad) return bad;
          const { data, error } = await readBody(request, MAX_JSON_BYTES);
          if (error) return error;
          if (!data || typeof data !== "object") return err(400, "bad_body", "Expected a JSON object");
          const updatedAt = await putJSON(env, key, data);
          return json({ ok: true, updatedAt: Number(updatedAt) });
        }
        return err(405, "method_not_allowed", `${method} not allowed`);
      }

      let m = /^\/api\/flashcards\/cards\/([^/]+)$/.exec(path);
      if (m) {
        const mid = decodeURIComponent(m[1]);
        if (!ID_RE.test(mid)) return err(400, "bad_id", "Invalid module id");
        if (method === "GET") return json((await readJSON(env, cardsKey(mid))) ?? { cards: [], updatedAt: 0 });
        if (method === "PUT") {
          const bad = needAdmin(request, env);
          if (bad) return bad;
          const { data, error } = await readBody(request, MAX_JSON_BYTES);
          if (error) return error;
          if (!data || !Array.isArray(data.cards)) return err(400, "bad_body", "Expected { cards: [...] }");
          const updatedAt = await putJSON(env, cardsKey(mid), data, { count: String(data.cards.length) });
          return json({ ok: true, updatedAt: Number(updatedAt), count: data.cards.length });
        }
        if (method === "DELETE") {
          const bad = needAdmin(request, env);
          if (bad) return bad;
          await env.APP_STORAGE.delete(cardsKey(mid));
          const media = await listAll(env, mediaKey(mid + "/"));
          if (media.length) await env.APP_STORAGE.delete(media.map((o) => o.key));
          return json({ ok: true, deletedMedia: media.length });
        }
        return err(405, "method_not_allowed", `${method} not allowed`);
      }

      m = /^\/api\/audio\/([^/]+)$/.exec(path);
      if (m) {
        const mid = decodeURIComponent(m[1]);
        if (!ID_RE.test(mid)) return err(400, "bad_id", "Invalid module id");
        if (method === "GET" || method === "HEAD") {
          return getBinary(request, env, audioKey(mid), { cacheControl: "public, max-age=3600" });
        }
        if (method === "PUT") {
          const bad = needAdmin(request, env);
          if (bad) return bad;
          return putBinary(request, env, audioKey(mid), { max: MAX_AUDIO_BYTES, defaultType: "audio/mpeg" });
        }
        if (method === "DELETE") {
          const bad = needAdmin(request, env);
          if (bad) return bad;
          await env.APP_STORAGE.delete(audioKey(mid));
          return json({ ok: true });
        }
        return err(405, "method_not_allowed", `${method} not allowed`);
      }

      m = /^\/api\/media\/(.+)$/.exec(path);
      if (m) {
        const key = decodeURIComponent(m[1]);
        if (key.includes("..") || key.length > 400) return err(400, "bad_key", "Invalid media key");
        if (method === "GET" || method === "HEAD") {
          return getBinary(request, env, mediaKey(key), { cacheControl: "public, max-age=31536000, immutable" });
        }
        if (method === "PUT") {
          const bad = needAdmin(request, env);
          if (bad) return bad;
          return putBinary(request, env, mediaKey(key), { max: MAX_MEDIA_BYTES, defaultType: "application/octet-stream" });
        }
        if (method === "DELETE") {
          const bad = needAdmin(request, env);
          if (bad) return bad;
          await env.APP_STORAGE.delete(mediaKey(key));
          return json({ ok: true });
        }
        return err(405, "method_not_allowed", `${method} not allowed`);
      }

      return err(404, "not_found", `No route: ${method} ${path}`);
    } catch (e) {
      return err(500, "server_error", e && e.message ? e.message : "Unexpected error");
    }
  },
};
