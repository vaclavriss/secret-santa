// Self-hosted backend for "Dopisy na parapetu": letters + trash in SQLite, pictures on disk,
// live updates over Server-Sent Events. No npm dependencies (Node >= 22.13 for node:sqlite).
//
// There is no login: anyone who can open the page can write, edit, bin and restore letters.
// Deleting a letter from the bin for good needs ADMIN_KEY (open the page once with ?admin=<key>).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, "data"));
const PAGE = path.resolve(process.env.PAGE || path.join(here, "..", "index.html"));
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const MAX_DOCS = Number(process.env.MAX_DOCS || 500);            // per collection
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_MB || 8) * 1024 * 1024;
const MAX_IMAGES_TOTAL = Number(process.env.MAX_IMAGES_TOTAL_MB || 1000) * 1024 * 1024;
const WRITES_PER_MIN = Number(process.env.WRITES_PER_MIN || 60); // per client IP

const IMG_DIR = path.join(DATA_DIR, "images");
fs.mkdirSync(IMG_DIR, { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, "santa.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id));
  CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
`);
const q = {
  all: db.prepare("SELECT id, data FROM docs WHERE col = ?"),
  get: db.prepare("SELECT data FROM docs WHERE col = ? AND id = ?"),
  count: db.prepare("SELECT COUNT(*) AS n FROM docs WHERE col = ?"),
  put: db.prepare("INSERT INTO docs (col, id, data) VALUES (?, ?, ?) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data"),
  del: db.prepare("DELETE FROM docs WHERE col = ? AND id = ?"),
  imgRefs: db.prepare("SELECT COUNT(*) AS n FROM docs WHERE json_extract(data, '$.image') = ?"),
  imgGet: db.prepare("SELECT type, size FROM images WHERE id = ?"),
  imgAdd: db.prepare("INSERT INTO images (id, type, size, created) VALUES (?, ?, ?, ?)"),
  imgDel: db.prepare("DELETE FROM images WHERE id = ?"),
  imgTotal: db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM images"),
};
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/* ---------- validation ---------- */
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const bad = () => new HttpError(400, "bad_request");
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const COLS = new Set(["letters", "trash"]);
const STR = { from: 40, wish: 2000, sizes: 600, avoid: 600, author: 64, deletedBy: 64 };
const FIELDS = {
  letters: ["from", "wish", "sizes", "avoid", "image", "author", "createdAt", "updatedAt"],
  trash: ["from", "wish", "sizes", "avoid", "image", "author", "createdAt", "updatedAt", "deletedAt", "deletedBy"],
};
function clean(col, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad();
  const out = {};
  for (const k of FIELDS[col]) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    if (k in STR) {
      if (typeof v !== "string") throw bad();
      out[k] = v.slice(0, STR[k]);
    } else if (k === "image") {
      if (typeof v !== "string" || !ID_RE.test(v) || !q.imgGet.get(v)) throw bad();
      out[k] = v;
    } else {
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad();
      out[k] = v;
    }
  }
  if (!out.wish && !out.image) throw bad();
  if (!out.createdAt) out.createdAt = Date.now();
  if (col === "trash" && !out.deletedAt) out.deletedAt = Date.now();
  return out;
}
const newId = () => crypto.randomBytes(15).toString("base64url");

function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 6 && buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function isAdmin(req) {
  const k = req.headers["x-admin-key"];
  if (!ADMIN_KEY || typeof k !== "string") return false;
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- rate limit for writes ---------- */
const buckets = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    const f = req.headers["x-forwarded-for"];
    if (typeof f === "string" && f) return f.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
}
function limitWrites(req) {
  const ip = clientIp(req), now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: WRITES_PER_MIN, at: now }; buckets.set(ip, b); }
  b.tokens = Math.min(WRITES_PER_MIN, b.tokens + ((now - b.at) / 60000) * WRITES_PER_MIN);
  b.at = now;
  if (b.tokens < 1) throw new HttpError(429, "rate_limited");
  b.tokens -= 1;
}
setInterval(() => { const old = Date.now() - 120000; for (const [k, b] of buckets) if (b.at < old) buckets.delete(k); }, 60000).unref();

/* ---------- live updates (SSE) ---------- */
const streams = new Set();
function snapshot(col) {
  return JSON.stringify({ col, docs: q.all.all(col).map((r) => ({ id: r.id, data: JSON.parse(r.data) })) });
}
function broadcast(...cols) {
  for (const col of cols) {
    const msg = "event: snapshot\ndata: " + snapshot(col) + "\n\n";
    for (const res of streams) res.write(msg);
  }
}
setInterval(() => { for (const res of streams) res.write(": ping\n\n"); }, 25000).unref();

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] || 0);
    if (len > limit) { req.resume(); req.on("end", () => reject(new HttpError(413, "too_large"))); return; }
    const chunks = [];
    let n = 0, over = false;
    req.on("data", (c) => { n += c.length; if (n > limit) over = true; else chunks.push(c); });
    req.on("end", () => (over ? reject(new HttpError(413, "too_large")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 64 * 1024);
  try { return JSON.parse(buf.toString("utf8")); } catch { throw bad(); }
}
function dropImageIfUnused(id) {
  if (!id || q.imgRefs.get(id).n > 0) return false;
  q.imgDel.run(id);
  fs.rm(path.join(IMG_DIR, id), { force: true }, () => {});
  return true;
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;

  if ((url.pathname === "/" || url.pathname === "/index.html") && (m === "GET" || m === "HEAD")) {
    const html = fs.readFileSync(PAGE);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    return res.end(m === "HEAD" ? undefined : html);
  }
  if (url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }

  if (parts[0] === "_blob" && parts.length === 2 && (m === "GET" || m === "HEAD")) {
    const id = parts[1];
    const img = ID_RE.test(id) && q.imgGet.get(id);
    if (!img) return send(res, 404, { code: "not_found" });
    res.writeHead(200, {
      "Content-Type": img.type, "Content-Length": img.size,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    if (m === "HEAD") return res.end();
    return fs.createReadStream(path.join(IMG_DIR, id)).on("error", () => res.destroy()).pipe(res);
  }

  if (parts[0] !== "api") return send(res, 404, { code: "not_found" });
  const [, a, b] = parts;

  if (a === "me" && m === "GET") return send(res, 200, { admin: isAdmin(req), adminConfigured: !!ADMIN_KEY });

  if (a === "stream" && m === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    for (const col of COLS) res.write("event: snapshot\ndata: " + snapshot(col) + "\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  if (a === "images") {
    if (m === "POST" && !b) {
      limitWrites(req);
      const buf = await readBody(req, MAX_IMAGE_BYTES);
      const type = sniff(buf);
      if (!type) throw new HttpError(415, "unsupported_type");
      if (q.imgTotal.get().n + buf.length > MAX_IMAGES_TOTAL) throw new HttpError(507, "quota_or_state");
      const id = newId();
      fs.writeFileSync(path.join(IMG_DIR, id), buf);
      q.imgAdd.run(id, type, buf.length, Date.now());
      return send(res, 201, { id });
    }
    if (m === "DELETE" && b && ID_RE.test(b)) {
      limitWrites(req);
      if (!q.imgGet.get(b)) return send(res, 200, { ok: true });
      if (!dropImageIfUnused(b)) throw new HttpError(409, "in_use");
      return send(res, 200, { ok: true });
    }
  }

  if (COLS.has(a)) {
    const col = a;
    if (m === "POST" && !b) {
      limitWrites(req);
      const data = clean(col, await readJson(req));
      const id = newId();
      tx(() => {
        if (q.count.get(col).n >= MAX_DOCS) throw new HttpError(507, "quota_exceeded");
        q.put.run(col, id, JSON.stringify(data));
      });
      broadcast(col);
      return send(res, 201, { id });
    }
    if (!b || !ID_RE.test(b)) throw bad();
    if (m === "PUT") {
      limitWrites(req);
      const data = clean(col, await readJson(req));
      tx(() => {
        if (!q.get.get(col, b) && q.count.get(col).n >= MAX_DOCS) throw new HttpError(507, "quota_exceeded");
        q.put.run(col, b, JSON.stringify(data));
      });
      broadcast(col);
      return send(res, 200, { id: b });
    }
    if (m === "DELETE") {
      limitWrites(req);
      if (col === "letters") {
        // A letter never disappears outright: whatever deletes it, a copy lands in the bin.
        tx(() => {
          const row = q.get.get("letters", b);
          if (row && !q.get.get("trash", b)) q.put.run("trash", b, JSON.stringify({ ...JSON.parse(row.data), deletedAt: Date.now() }));
          q.del.run("letters", b);
        });
        broadcast("letters", "trash");
        return send(res, 200, { ok: true });
      }
      // Leaving the bin: fine when the letter is back on the sill (restore); for good only for the admin.
      const row = q.get.get("trash", b);
      if (row && !q.get.get("letters", b) && !isAdmin(req)) throw new HttpError(403, "not_granted");
      tx(() => q.del.run("trash", b));
      if (row) dropImageIfUnused(JSON.parse(row.data).image);
      broadcast("trash");
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { code: "not_found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!(e instanceof HttpError)) console.error(e);
    if (res.headersSent) return res.destroy();
    send(res, e.status || 500, { code: e.code || "internal" });
  });
});
server.requestTimeout = 60000;
server.listen(PORT, HOST, () => {
  console.log(`Dopisy na parapetu: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (data: ${DATA_DIR})`);
  if (!ADMIN_KEY) console.log("ADMIN_KEY is not set: nobody can delete letters from the bin for good.");
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
