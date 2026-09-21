// Integration test for the reading-dashboard API against a running `wrangler dev`.
// Usage: APP_PASSWORD=… node scripts/test-api.mjs http://127.0.0.1:8787
// (the password is read from the APP_PASSWORD env var, or from the git-ignored
//  .dev.vars file — it is never hard-coded here.)
import { readFileSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:8787";
function loadPw() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  try {
    const m = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/APP_PASSWORD\s*=\s*(.+)/);
    if (m) return m[1].trim();
  } catch {}
  console.error("Set APP_PASSWORD (env var or .dev.vars) to run the API test.");
  process.exit(2);
}
const PW = loadPw();
const H = { Authorization: "Bearer " + PW, "Content-Type": "application/json" };
let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   - ${name}`);
  else { console.log(`  FAIL - ${name} ${extra}`); failures++; }
}
const j = (r) => r.json();

async function main() {
  // auth
  let r = await fetch(`${BASE}/api/books`);
  check("GET /api/books no auth -> 401", r.status === 401, `got ${r.status}`);
  r = await fetch(`${BASE}/api/books`, { headers: { Authorization: "Bearer nope" } });
  check("wrong password -> 401", r.status === 401, `got ${r.status}`);

  // books baseline
  r = await fetch(`${BASE}/api/books`, { headers: H });
  const books0 = r.ok ? await j(r) : null;
  check("GET /api/books -> 200 + array", r.status === 200 && Array.isArray(books0), `got ${r.status}`);
  const nb0 = books0.length;

  // create book
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: H, body: JSON.stringify({ title: "TDD Catalog Book", author: "QA Bot", genre: "Testing", total_pages: 300, status: "reading" }) });
  const book = r.ok ? await j(r) : null;
  check("POST /api/books -> 201 + id", r.status === 201 && book && Number.isInteger(book.id), `got ${r.status} ${JSON.stringify(book)}`);
  check("new book aggregates zeroed", book && book.pages_read === 0 && book.sessions === 0);
  const bookId = book && book.id;

  // books count +1
  r = await fetch(`${BASE}/api/books`, { headers: H });
  check("books grew by 1", (await j(r)).length === nb0 + 1);

  // update book
  r = await fetch(`${BASE}/api/books/${bookId}`, { method: "PUT", headers: H, body: JSON.stringify({ title: "TDD Catalog Book", author: "QA Bot", genre: "Testing", total_pages: 300, status: "finished", rating: 4 }) });
  const upd = r.ok ? await j(r) : null;
  check("PUT book -> status+rating updated", r.status === 200 && upd && upd.status === "finished" && upd.rating === 4, `got ${r.status} ${JSON.stringify(upd)}`);

  // add a session to that book
  r = await fetch(`${BASE}/api/entries`, { method: "POST", headers: H, body: JSON.stringify({ book_id: bookId, date: "2026-09-21", pages_read: 40, minutes_read: 45 }) });
  const sess = r.ok ? await j(r) : null;
  check("POST /api/entries (session) -> 201", r.status === 201 && sess && Number.isInteger(sess.id), `got ${r.status} ${JSON.stringify(sess)}`);
  check("session joins book title", sess && sess["Book Title"] === "TDD Catalog Book" && sess["Pages Read"] === 40);
  const sessId = sess && sess.id;

  // book now reports the session in its aggregates
  r = await fetch(`${BASE}/api/books`, { headers: H });
  const b2 = (await j(r)).find((b) => b.id === bookId);
  check("book aggregates reflect session", b2 && b2.sessions === 1 && b2.pages_read === 40, JSON.stringify(b2));

  // delete-block: book with a session cannot be deleted
  r = await fetch(`${BASE}/api/books/${bookId}`, { method: "DELETE", headers: H });
  check("DELETE book with sessions -> 409", r.status === 409, `got ${r.status}`);

  // delete session, then book deletes
  r = await fetch(`${BASE}/api/entries/${sessId}`, { method: "DELETE", headers: H });
  check("DELETE session -> 204", r.status === 204, `got ${r.status}`);
  r = await fetch(`${BASE}/api/books/${bookId}`, { method: "DELETE", headers: H });
  check("DELETE book (no sessions) -> 204", r.status === 204, `got ${r.status}`);
  r = await fetch(`${BASE}/api/books`, { headers: H });
  check("books back to baseline", (await j(r)).length === nb0);

  // validation
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: H, body: JSON.stringify({ author: "no title" }) });
  check("POST book missing title -> 400", r.status === 400, `got ${r.status}`);
  r = await fetch(`${BASE}/api/entries`, { method: "POST", headers: H, body: JSON.stringify({ date: "2026-09-21", pages_read: 5 }) });
  check("POST session missing book_id -> 400", r.status === 400, `got ${r.status}`);

  console.log(failures ? `\n${failures} FAILURE(S)` : `\nALL PASS`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("test harness error:", e); process.exit(2); });
