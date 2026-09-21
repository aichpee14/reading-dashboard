// "Push to GitHub" — stage every change, commit, and push the current branch.
// Usage:  npm run push:github -- "your commit message"
// (message optional; defaults to a timestamped one). Never touches Cloudflare.
import { execSync } from "node:child_process";

const msg = process.argv.slice(2).join(" ").trim() ||
  `Update reading dashboard — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

function run(cmd, allowFail = false) {
  console.log("> " + cmd);
  try { execSync(cmd, { stdio: "inherit" }); }
  catch (e) { if (!allowFail) throw e; return false; }
  return true;
}

const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
run("git add -A");
// commit may be a no-op if nothing changed — that's fine
const committed = run(`git commit -m ${JSON.stringify(msg)}`, true);
if (!committed) console.log("(nothing new to commit)");
// push the current branch, setting upstream on first push
run(`git push -u origin ${branch}`);
console.log(`\n✓ Pushed branch "${branch}" to GitHub.`);
