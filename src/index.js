// reading-dashboard Worker
// - /api/books*    -> books catalog CRUD (password-gated)
// - /api/entries*  -> reading sessions CRUD, each attached to a book (password-gated)
// - everything else -> static assets (public/) via the ASSETS binding

const J = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// Constant-time-ish shared-password check. Requires "Authorization: Bearer <pw>".
function authed(request, env) {
  const h = request.headers.get("authorization") || "";
  const pw = h.startsWith("Bearer ") ? h.slice(7) : "";
  const expected = env.APP_PASSWORD || "";
  if (!pw || !expected || pw.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < pw.length; i++) diff |= pw.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const pickFrom = (b, ...ks) => {
  for (const k of ks) if (b[k] !== undefined && b[k] !== null && b[k] !== "") return b[k];
  return undefined;
};

// ---- Books ----
const VALID_STATUS = new Set(["to-read", "reading", "finished", "dnf"]);
function fromBookBody(b) {
  let st = String(pickFrom(b, "status", "Status") || "reading").trim().toLowerCase();
  if (st.includes("finish")) st = "finished";
  else if (st.includes("dnf")) st = "dnf";
  else if (st.includes("to-read") || st.includes("to read") || st === "toread") st = "to-read";
  else st = "reading";
  return {
    title: String(pickFrom(b, "title", "Title", "book_title", "Book Title") || "").trim(),
    author: String(pickFrom(b, "author", "Author") || "").trim(),
    genre: String(pickFrom(b, "genre", "Genre") || "").trim(),
    total_pages: num(pickFrom(b, "total_pages", "Total Pages")),
    status: VALID_STATUS.has(st) ? st : "reading",
    rating: num(pickFrom(b, "rating", "Rating")),
    cover_url: String(pickFrom(b, "cover_url", "Cover URL", "cover") || "").trim(),
  };
}
const toBookApi = (r) => ({
  id: r.id, title: r.title, author: r.author, genre: r.genre,
  total_pages: r.total_pages, status: r.status, rating: r.rating, cover_url: r.cover_url,
  pages_read: r.pages_read || 0, minutes: r.minutes || 0, sessions: r.sessions || 0,
  last_read: r.last_read || null,
});
const BOOK_AGG = `
  SELECT b.*,
    COALESCE(SUM(e.pages_read),0)   AS pages_read,
    COALESCE(SUM(e.minutes_read),0) AS minutes,
    COUNT(e.id)                     AS sessions,
    MAX(e.date)                     AS last_read
  FROM books b LEFT JOIN entries e ON e.book_id = b.id`;

async function handleBooks(request, env, id) {
  const m = request.method.toUpperCase();

  if (m === "GET" && !id) {
    const { results } = await env.DB.prepare(`${BOOK_AGG} GROUP BY b.id ORDER BY b.title COLLATE NOCASE ASC`).all();
    return J(results.map(toBookApi));
  }
  if (m === "POST" && !id) {
    const e = fromBookBody(await request.json());
    if (!e.title) return J({ error: "title is required" }, 400);
    const { results } = await env.DB.prepare(
      `INSERT INTO books (title,author,genre,total_pages,status,rating,cover_url) VALUES (?,?,?,?,?,?,?) RETURNING *`
    ).bind(e.title, e.author, e.genre, e.total_pages, e.status, e.rating, e.cover_url).all();
    return J(toBookApi(results[0]), 201);
  }
  if (m === "PUT" && id) {
    const e = fromBookBody(await request.json());
    if (!e.title) return J({ error: "title is required" }, 400);
    const { results } = await env.DB.prepare(
      `UPDATE books SET title=?,author=?,genre=?,total_pages=?,status=?,rating=?,cover_url=?,updated_at=datetime('now')
       WHERE id=? RETURNING *`
    ).bind(e.title, e.author, e.genre, e.total_pages, e.status, e.rating, e.cover_url, id).all();
    if (!results.length) return J({ error: "not found" }, 404);
    return J(toBookApi(results[0]));
  }
  if (m === "DELETE" && id) {
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE book_id=?").bind(id).first();
    if (cnt && cnt.n > 0) return J({ error: "has_sessions", sessions: cnt.n }, 409);
    await env.DB.prepare("DELETE FROM books WHERE id=?").bind(id).run();
    return new Response(null, { status: 204 });
  }
  return J({ error: "method not allowed" }, 405);
}

// ---- Sessions (entries) ----
function fromSessionBody(b) {
  return {
    book_id: num(pickFrom(b, "book_id", "Book Id", "bookId")),
    date: String(pickFrom(b, "date", "Date") || "").slice(0, 10),
    pages_read: num(pickFrom(b, "pages_read", "Pages Read", "pages")) || 0,
    minutes_read: num(pickFrom(b, "minutes_read", "Minutes Read", "minutes")) || 0,
  };
}
// Session -> the flat CSV-header shape the client's normalizeRow() already understands,
// with the book's fields joined in so existing charts keep working.
const toSessionApi = (r) => ({
  id: r.id, book_id: r.book_id,
  Date: r.date, "Book Title": r.title, Author: r.author, Genre: r.genre,
  "Pages Read": r.pages_read, "Minutes Read": r.minutes_read,
  Status: r.status, Rating: r.rating, "Total Pages": r.total_pages, "Cover URL": r.cover_url,
});
const SESSION_JOIN = `
  SELECT e.id, e.book_id, e.date, e.pages_read, e.minutes_read,
    b.title, b.author, b.genre, b.status, b.rating, b.total_pages, b.cover_url
  FROM entries e JOIN books b ON b.id = e.book_id`;

async function handleSessions(request, env, id) {
  const m = request.method.toUpperCase();

  if (m === "GET" && !id) {
    const { results } = await env.DB.prepare(`${SESSION_JOIN} ORDER BY e.date ASC, e.id ASC`).all();
    return J(results.map(toSessionApi));
  }
  if (m === "POST" && !id) {
    const e = fromSessionBody(await request.json());
    if (!e.book_id || !e.date) return J({ error: "book_id and date are required" }, 400);
    const book = await env.DB.prepare("SELECT id FROM books WHERE id=?").bind(e.book_id).first();
    if (!book) return J({ error: "book not found" }, 400);
    const ins = await env.DB.prepare(
      `INSERT INTO entries (book_id,date,pages_read,minutes_read) VALUES (?,?,?,?) RETURNING id`
    ).bind(e.book_id, e.date, e.pages_read, e.minutes_read).first();
    const { results } = await env.DB.prepare(`${SESSION_JOIN} WHERE e.id=?`).bind(ins.id).all();
    return J(toSessionApi(results[0]), 201);
  }
  if (m === "PUT" && id) {
    const e = fromSessionBody(await request.json());
    if (!e.book_id || !e.date) return J({ error: "book_id and date are required" }, 400);
    const upd = await env.DB.prepare(
      `UPDATE entries SET book_id=?,date=?,pages_read=?,minutes_read=?,updated_at=datetime('now') WHERE id=?`
    ).bind(e.book_id, e.date, e.pages_read, e.minutes_read, id).run();
    if (!upd.meta || upd.meta.changes === 0) return J({ error: "not found" }, 404);
    const { results } = await env.DB.prepare(`${SESSION_JOIN} WHERE e.id=?`).bind(id).all();
    return J(toSessionApi(results[0]));
  }
  if (m === "DELETE" && id) {
    await env.DB.prepare("DELETE FROM entries WHERE id=?").bind(id).run();
    return new Response(null, { status: 204 });
  }
  return J({ error: "method not allowed" }, 405);
}

async function handleApi(request, env, url) {
  if (!authed(request, env)) return J({ error: "unauthorized" }, 401);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", resource, id?]
  const resource = parts[1];
  const id = parts[2] ? Number(parts[2]) : null;
  if (parts[2] && !Number.isInteger(id)) return J({ error: "bad id" }, 400);
  try {
    if (resource === "books") return await handleBooks(request, env, id);
    if (resource === "entries") return await handleSessions(request, env, id);
    return J({ error: "not found" }, 404);
  } catch (err) {
    return J({ error: "server error", detail: String((err && err.message) || err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
