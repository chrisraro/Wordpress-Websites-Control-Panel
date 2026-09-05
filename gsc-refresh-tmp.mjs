import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(process.env.ENV_PATH, "utf8").split(/\r?\n/)
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")]; }));
const S = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json" };
const q = (p, i) => fetch(`${S}/rest/v1/${p}`, { ...i, headers: { ...H, ...(i?.headers ?? {}) } })
  .then(r => r.text()).then(t => { try { return JSON.parse(t); } catch { return t; } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11,19) + "Z";

// The new field is collected by the deployed INVENTORY_PHP, so the deploy has
// to be live before any of this is worth running.
console.log(`${now()} waiting 180s for the Vercel deploy`);
await sleep(180000);

const sites = await q("sites?select=id,name&status=eq.connected&order=name");
const started = new Date().toISOString();
await q("jobs", { method: "POST",
  body: JSON.stringify(sites.map(s => ({ type: "snapshot_refresh", site_id: s.id, payload: {} }))) });
console.log(`${now()} queued ${sites.length} inventory refreshes`);

for (let i = 0; i < 60; i++) {
  await sleep(30000);
  const jobs = await q(`jobs?select=status&type=eq.snapshot_refresh&scheduled_for=gte.${started}`);
  const by = jobs.reduce((a,j) => { a[j.status] = (a[j.status] ?? 0) + 1; return a; }, {});
  console.log(`${now()} ${JSON.stringify(by)}`);
  if (!by.pending && !by.running) break;
}

console.log("");
for (const s of sites) {
  const [snap] = await q(`site_snapshots?select=payload,taken_at&site_id=eq.${s.id}&order=taken_at.desc&limit=1`);
  const g = snap?.payload?.gsc;
  if (!g) { console.log(`${s.name.padEnd(28)} gsc field ABSENT (snapshot ${snap?.taken_at?.slice(11,16) ?? "none"})`); continue; }
  const files = (g.files ?? []).map(f => `${f.name}${f.declared === f.name ? " [ok]" : ` [declares ${f.declared}]`}`).join(", ") || "-";
  console.log(`${s.name.padEnd(28)} files: ${files.padEnd(46)} plugin: ${g.plugin ? g.plugin.name : "-"}`);
}
