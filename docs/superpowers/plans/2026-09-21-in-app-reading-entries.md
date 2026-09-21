# In-App Reading Entries (D1) Implementation Plan

> **For agentic workers:** implement task-by-task; each task ends with an independently testable deliverable.

**Goal:** Replace the Google-Sheet CSV data source with a Cloudflare D1 database the dashboard reads from *and writes to* directly (add / edit / delete reading entries in the app).

**Architecture:** The existing `reading-dashboard` Worker (Static Assets) gains a small fetch handler: requests to `/api/entries*` are handled by the Worker (D1 SQL + password check); everything else is served from static assets via the `ASSETS` binding. Data lives in a D1 table `entries` whose columns mirror today's CSV headers, so the existing render pipeline keeps working. A shared password (`<APP_PASSWORD>`) gates every `/api` call server-side and doubles as the lock-screen login.

**Tech Stack:** Cloudflare Workers (Static Assets + fetch handler), D1 (SQLite), wrangler 4, vanilla JS client (Chart.js only).

**Deploy target:** Worker `reading-dashboard` on **Hussainpatel14@gmail.com's account** `028627afabf2bcb8f9dc35d1864d2d0e` → `https://reading-dashboard.hussainpatel14.workers.dev`. All remote wrangler commands run with `CLOUDFLARE_ACCOUNT_ID=028627afabf2bcb8f9dc35d1864d2d0e` so they never touch Ali's account.

**Spec:** design agreed in-conversation 2026-09-21 (summarized in this header).

## Global Constraints

- Never run remote wrangler ops against Ali's account (`87ede…`). Always set `CLOUDFLARE_ACCOUNT_ID=028627afabf2bcb8f9dc35d1864d2d0e` for remote commands.
- Password value: `<APP_PASSWORD>`. Stored as Worker secret `APP_PASSWORD` (remote) and in git-ignored `.dev.vars` (local). Never commit the password.
- Static assets served only from `./public` (not repo root) so Worker source / configs / SQL are not public.
- Client render code consumes `normalizeRow()` output unchanged; the API returns CSV-header-shaped JSON so the pipeline is untouched aside from adding an `id`.
- Same-origin API (Worker serves app + API) → no CORS handling needed.
- Do not `git commit`/`push` automatically — offer at the end (branch off `main` first).

---

## File structure (after)

```
public/index.html                 ← moved from ./index.html; client rewired to /api
src/index.js                      ← Worker: /api/entries* routes + auth + ASSETS passthrough
schema.sql                        ← entries table DDL
scripts/import-from-sheet.mjs     ← one-time: live Google Sheet CSV → import.sql
scripts/test-api.mjs              ← integration test against local `wrangler dev`
wrangler.toml                     ← + main, + [assets] binding/dir, + [[d1_databases]]
.dev.vars                         ← APP_PASSWORD=<APP_PASSWORD> (git-ignored)
.gitignore                        ← node_modules, .wrangler, .dev.vars, import.sql
package.json                      ← dev/deploy npm scripts
sample-reading-log.csv            ← kept at root (no longer served)
```

---

### Task 1: Restructure + wrangler config + D1 binding

**Files:** move `index.html`→`public/index.html`; create `src/index.js` (stub), `schema.sql`, `.dev.vars`, `.gitignore`, `package.json`; modify `wrangler.toml`.

- Move `index.html` into `public/`.
- `schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT    NOT NULL,
  book_title   TEXT    NOT NULL DEFAULT '',
  author       TEXT    NOT NULL DEFAULT '',
  genre        TEXT    NOT NULL DEFAULT '',
  pages_read   INTEGER NOT NULL DEFAULT 0,
  minutes_read INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'reading',
  rating       INTEGER,
  total_pages  INTEGER,
  cover_url    TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
```
- `wrangler.toml`:
```toml
name = "reading-dashboard"
main = "src/index.js"
compatibility_date = "2026-09-17"

[assets]
directory = "./public"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "reading-dashboard-db"
database_id = "PLACEHOLDER_SET_AFTER_CREATE"
```
- `.dev.vars`: `APP_PASSWORD=<APP_PASSWORD>`
- `.gitignore`: `node_modules/`, `.wrangler/`, `.dev.vars`, `import.sql`, `*.log`
- `package.json` scripts: `dev` (`wrangler dev`), `deploy` (`wrangler deploy`), `db:schema:local`, `db:schema:remote`.
- Create D1 remotely: `CLOUDFLARE_ACCOUNT_ID=028… npx wrangler d1 create reading-dashboard-db` → paste returned `database_id` into `wrangler.toml`.

**Deliverable:** `wrangler dev` starts; D1 exists remotely; binding resolves.

---

### Task 2: Worker API (`src/index.js`) — auth + CRUD

**Interfaces produced:** `GET /api/entries` → `[{id,"Date","Book Title","Author","Genre","Pages Read","Minutes Read","Status","Rating","Total Pages","Cover URL"}]`; `POST /api/entries` (JSON body, same field names or snake_case) → created row; `PUT /api/entries/:id` → updated row; `DELETE /api/entries/:id` → 204. All require `Authorization: Bearer <APP_PASSWORD>`.

```js
const J = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function authed(request, env) {
  const h = request.headers.get("authorization") || "";
  const pw = h.startsWith("Bearer ") ? h.slice(7) : "";
  const expected = env.APP_PASSWORD || "";
  if (!pw || pw.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < pw.length; i++) diff |= pw.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const toApi = (r) => ({
  id: r.id, "Date": r.date, "Book Title": r.book_title, "Author": r.author,
  "Genre": r.genre, "Pages Read": r.pages_read, "Minutes Read": r.minutes_read,
  "Status": r.status, "Rating": r.rating, "Total Pages": r.total_pages, "Cover URL": r.cover_url,
});

function fromBody(b) {
  const pick = (...ks) => { for (const k of ks) if (b[k] !== undefined && b[k] !== "") return b[k]; return undefined; };
  const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    date: String(pick("date", "Date") || "").slice(0, 10),
    book_title: String(pick("book_title", "Book Title", "title") || "").trim(),
    author: String(pick("author", "Author") || "").trim(),
    genre: String(pick("genre", "Genre") || "").trim(),
    pages_read: num(pick("pages_read", "Pages Read", "pages")) || 0,
    minutes_read: num(pick("minutes_read", "Minutes Read", "minutes")) || 0,
    status: String(pick("status", "Status") || "reading").trim().toLowerCase(),
    rating: num(pick("rating", "Rating")),
    total_pages: num(pick("total_pages", "Total Pages")),
    cover_url: String(pick("cover_url", "Cover URL", "cover") || "").trim(),
  };
}

async function handleApi(request, env, url) {
  if (!authed(request, env)) return J({ error: "unauthorized" }, 401);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","entries", id?]
  if (parts[1] !== "entries") return J({ error: "not found" }, 404);
  const id = parts[2] ? Number(parts[2]) : null;
  const m = request.method;

  if (m === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT * FROM entries ORDER BY date ASC, id ASC").all();
    return J(results.map(toApi));
  }
  if (m === "POST" && !id) {
    const e = fromBody(await request.json());
    if (!e.date || !e.book_title) return J({ error: "date and book_title required" }, 400);
    const { results } = await env.DB.prepare(
      `INSERT INTO entries (date,book_title,author,genre,pages_read,minutes_read,status,rating,total_pages,cover_url)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
    ).bind(e.date, e.book_title, e.author, e.genre, e.pages_read, e.minutes_read, e.status, e.rating, e.total_pages, e.cover_url).all();
    return J(toApi(results[0]), 201);
  }
  if (m === "PUT" && id) {
    const e = fromBody(await request.json());
    const { results } = await env.DB.prepare(
      `UPDATE entries SET date=?,book_title=?,author=?,genre=?,pages_read=?,minutes_read=?,status=?,rating=?,total_pages=?,cover_url=?,updated_at=datetime('now')
       WHERE id=? RETURNING *`
    ).bind(e.date, e.book_title, e.author, e.genre, e.pages_read, e.minutes_read, e.status, e.rating, e.total_pages, e.cover_url, id).all();
    if (!results.length) return J({ error: "not found" }, 404);
    return J(toApi(results[0]));
  }
  if (m === "DELETE" && id) {
    await env.DB.prepare("DELETE FROM entries WHERE id=?").bind(id).run();
    return new Response(null, { status: 204 });
  }
  return J({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
```

**Deliverable:** endpoints work against local D1.

---

### Task 3: Integration test (`scripts/test-api.mjs`) — TDD gate

Node script (run against a local `wrangler dev` base URL) asserting, in order: (1) `GET /api/entries` with no auth → 401; (2) with `Bearer <APP_PASSWORD>` → 200 + array; (3) `POST` a row → 201, id returned; (4) `GET` count increased by 1, fields round-trip; (5) `PUT` changes a field → reflected; (6) `DELETE` → 204, count back down; (7) `POST` missing date → 400. Exit non-zero on any failure.

**Run cycle:** `wrangler d1 execute reading-dashboard-db --local --file schema.sql` → start `wrangler dev` (background) → `node scripts/test-api.mjs http://127.0.0.1:8787` → expect all-pass → stop dev.

**Deliverable:** all assertions pass locally before any client work.

---

### Task 4: Client — auth becomes real login + read from API

In `public/index.html` `<script>`:
- Remove `DEFAULT_CONFIG.csvUrl`; keep `goalBooks`/`goalPages`. Add `const AUTH_KEY="reading-dashboard-auth"; let authPw = (localStorage.getItem(AUTH_KEY)||"");`.
- Add helper:
```js
function apiFetch(path, opts={}) {
  const headers = Object.assign({}, opts.headers, { "Authorization": "Bearer " + authPw });
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return fetch(path, Object.assign({}, opts, { headers }));
}
```
- Replace `initLock`: on submit, `const pw = lockInput.value; authPw = pw; const res = await apiFetch("/api/entries"); if(res.ok){ localStorage.setItem(AUTH_KEY, pw); showApp(); loadData(); } else { authPw=""; show "Incorrect password."; }`. On load: if `authPw` present → `showApp(); loadData();` (loadData reverts to lock on 401) else show lock. Delete the sha256/`UNLOCK_HASH`/`UNLOCK_KEY` path.
- Rewrite `loadData()` to `apiFetch("/api/entries")` → on 401 clear `authPw`+`AUTH_KEY`, show lock; on ok → `rows = (await res.json()).map(normalizeRow).filter(r=>r.date); rows.sort(...); renderAll();`.
- `normalizeRow`: add `id: (get(["id"]) !== "" ? Number(get(["id"])) : null),` to the returned object.
- Init block: remove `if (config.csvUrl) loadData()`; the 5-min interval calls `loadData()` only when `authPw` is set.

**Deliverable:** app loads its data from `/api/entries` after password login; existing charts/log render.

---

### Task 5: Client — Add / Edit / Delete UI

- Add a top-bar **`+ Add Entry`** button (`#addEntryBtn`) and a modal `#entryModal` (styled to match existing `.card`/`.btn-primary`) with fields: date (default today), title (`<input list="titleList">` + `<datalist id="titleList">` built from `rows`), author, genre, pages, minutes, status `<select>` (reading/finished/dnf), rating (0–5), total pages. Hidden `#entryId` for edit mode.
- On title input, prefill author/genre/total pages from the most recent `rows` entry with that title (if any).
- `#addEntryBtn` → open modal in add mode (clear + date=today). Submit handler: build body, `const id=entryId.value; const res = await apiFetch(id?`/api/entries/${id}`:"/api/entries", {method:id?"PUT":"POST", body:JSON.stringify(body)});` on ok → close modal, `loadData()`.
- `renderLog()`: add an **Actions** `<th>` and per-row `<td>` with Edit (opens modal prefilled incl. `r.id`) and Delete buttons. Delete: `if(confirm(...)){ await apiFetch(`/api/entries/${r.id}`,{method:"DELETE"}); loadData(); }`. Row buttons carry `data-id`.
- Settings panel: replace "Connect your Google Sheet" heading + remove `csvUrlInput`; keep goals; `saveSettingsBtn` no longer references csvUrl (goals persist to localStorage).

**Deliverable:** can add, edit, delete entries from the UI; log shows actions; totals/charts update after each change.

---

### Task 6: Import live Google Sheet → remote D1 (one-time)

- `scripts/import-from-sheet.mjs`: fetch the current published CSV (`https://docs.google.com/spreadsheets/d/e/2PACX-1vTBniz9kLARYxnBh-ofky-aAkJX0b1Y_MV3IDXq0ZVrBYxy94IOVVwHGz1fQq55GSY_UhlwyrBnuKx9/pub?gid=0&single=true&output=csv`), parse (quoted-field-safe), emit `import.sql` with one `INSERT` per row mapping headers → columns (status lowercased; empty rating/total_pages → NULL). SQL-escape single quotes.
- Apply: `CLOUDFLARE_ACCOUNT_ID=028… npx wrangler d1 execute reading-dashboard-db --remote --file schema.sql` then `--file import.sql`.

**Deliverable:** remote D1 seeded with existing reading history.

---

### Task 7: Deploy + verify + set secret

- `CLOUDFLARE_ACCOUNT_ID=028… npx wrangler secret put APP_PASSWORD` (value `<APP_PASSWORD>`).
- `CLOUDFLARE_ACCOUNT_ID=028… npx wrangler deploy`.
- Verify live: `GET /api/entries` 401 without auth / 200 with; open `https://reading-dashboard.hussainpatel14.workers.dev` in the Browser pane → login `<APP_PASSWORD>` → data loads → add a test entry → appears → delete it.
- Confirm repo root files (wrangler.toml, schema.sql, csv) are NOT served (404 on `/wrangler.toml`).

**Deliverable:** live site records entries directly, Google Sheet no longer used.

---

## Self-review notes
- Spec coverage: read (T4), write add/edit/delete (T2/T5), auth server-side (T2/T4), migration (T6), deploy to his account only (T1/T6/T7), no-public-source (T1/T7). ✓
- Types: API field names identical in `toApi` (T2) and `normalizeRow` get() keys (T4). `id` carried through. ✓
- Password `<APP_PASSWORD>` only in `.dev.vars` + Worker secret, never committed. ✓
