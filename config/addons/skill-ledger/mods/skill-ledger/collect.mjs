// Skill Ledger collector. Prints one JSON object on stdout.   node collect.mjs <dataDir>
//
// Counts how often each skill and MCP server was used, from the local logs of
//   Claude Code  ~/.claude/projects/**/*.jsonl
//   Pi           ~/.pi/agent/sessions/**/*.jsonl
// and lists what is installed, so skills that were never used show up with 0.
// No network. Reads only file names, SKILL.md front matter and the *names* of MCP servers
// (never their config values). Logs are read incrementally (byte offset per file in the cache).
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, readSync, fstatSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { categorize, OTHER, REMOVED } from "./categories.mjs";

const HOME = homedir();
const dataDir = process.argv[2];
if (!dataDir) { console.error("usage: node collect.mjs <dataDir>"); process.exit(2); }
mkdirSync(dataDir, { recursive: true });
const DAY = 86400000, now = Date.now();
const PERIODS = [7, 30, 90, 0]; // days; 0 = all time
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };

function walk(dir, match, out = [], depth = 0) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = statSync(p).isDirectory(); } catch { continue; } }
    if (isDir) { if (depth < 5) walk(p, match, out, depth + 1); } else if (match(e.name)) out.push(p);
  }
  return out;
}

// ---------- Incremental JSONL scanning ----------
const CHUNK = 4 * 1024 * 1024;
const headHash = (fd, len) => { const b = Buffer.alloc(len); const n = readSync(fd, b, 0, len, 0); return createHash("md5").update(b.subarray(0, n)).digest("hex"); };

function eachLine(fd, size, start, needles, onLine) {
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = start, consumed = start, carry = Buffer.alloc(0);
  while (pos < size) {
    const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
    if (n <= 0) break;
    pos += n;
    const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let from = 0, nl;
    while ((nl = data.indexOf(10, from)) !== -1) {
      const line = data.subarray(from, nl);
      if (line.length && needles.some((x) => line.includes(x))) onLine(line);
      from = nl + 1;
    }
    consumed += from;
    carry = Buffer.from(data.subarray(from));
  }
  return consumed; // a trailing partial line is left for the next run
}

function scanIncremental(path, prev, version, needles, onLine) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let st = prev && prev.v === version && prev.off <= size && prev.hl <= size && prev.hh === headHash(fd, prev.hl) ? prev : null;
    if (st && st.off === size) return st;
    st = st ?? { events: [] };
    st.off = eachLine(fd, size, st.off ?? 0, needles, (b) => { let d; try { d = JSON.parse(b.toString("utf8")); } catch { return; } onLine(st.events, d); });
    st.hl = Math.min(st.off, 4096); st.hh = headHash(fd, st.hl); st.v = version;
    return st;
  } finally { closeSync(fd); }
}

const saveJson = (file, obj) => { try { writeFileSync(file + ".tmp", JSON.stringify(obj)); renameSync(file + ".tmp", file); } catch {} };

// An event is [ts, kind, name, id]; kind: "s" skill, "c" slash command, "m" MCP tool call.
// `id` lets the same call, repeated by a resumed or streamed session, be counted once.
const CLAUDE_NEEDLES = [Buffer.from('"name":"Skill"'), Buffer.from('"name":"mcp__'), Buffer.from("<command-name>")];
const CMD_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;

function claudeLine(events, d) {
  const ts = Date.parse(d.timestamp) || 0;
  const c = d.message?.content;
  if (d.type === "assistant" && Array.isArray(c)) {
    for (const b of c) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "Skill" && b.input?.skill) events.push([ts, "s", String(b.input.skill).replace(/^\//, ""), b.id]);
      else if (typeof b.name === "string" && b.name.startsWith("mcp__")) events.push([ts, "m", b.name.slice(5), b.id]);
    }
  } else if (d.type === "user") {
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
    const m = CMD_RE.exec(text);
    if (m) events.push([ts, "c", m[1], d.uuid ?? `${ts}:${m[1]}`]);
  }
}

const PI_NEEDLES = [Buffer.from('"toolCall"')];
const PI_SKILL_RE = /\/skills\/([^/]+)\/SKILL\.md$/;

function piLine(events, d) {
  const m = d.message, c = m?.content;
  if (!Array.isArray(c)) return;
  const ts = Date.parse(d.timestamp) || m.timestamp || 0;
  for (const b of c) {
    if (b?.type !== "toolCall" || typeof b.name !== "string") continue;
    if (b.name === "read") {
      const hit = PI_SKILL_RE.exec(String(b.arguments?.path ?? b.arguments?.file_path ?? ""));
      if (hit) events.push([ts, "s", hit[1], b.id]);
    } else if (b.name.includes("__")) events.push([ts, "m", b.name, b.id]);
  }
}

function collectEvents(root, cacheName, needles, lineFn) {
  if (!existsSync(root)) return null;
  const cacheFile = join(dataDir, cacheName), cache = readJson(cacheFile, { files: {} }), next = { files: {} };
  const events = [];
  for (const path of walk(root, (n) => n.endsWith(".jsonl"))) {
    let rec;
    try { rec = scanIncremental(path, cache.files[path], 1, needles, lineFn); } catch { continue; }
    next.files[path] = rec;
    events.push(...rec.events);
  }
  saveJson(cacheFile, next);
  const seen = new Set();
  return events.filter((e) => { const k = `${e[1] === "c" ? "c" : "x"}|${e[3]}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- Inventory ----------
function frontMatter(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let v = kv[2].trim();
      if (/^[>|][-+]?$/.test(v)) { v = ""; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) v += " " + lines[++i].trim(); }
      out[kv[1]] = v.replace(/^["']|["']$/g, "").trim();
    }
  }
  return out;
}

function listSkills() {
  const found = new Map(); // name -> { name, description, agents:Set }
  const add = (name, desc, agent) => {
    if (!name) return;
    const s = found.get(name) ?? { name, description: "", agents: new Set() };
    s.agents.add(agent); if (!s.description && desc) s.description = desc;
    found.set(name, s);
  };
  const scanDir = (dir, agent, prefix = "", depth = 2) => {
    for (const f of walk(dir, (n) => n === "SKILL.md", [], 5 - depth)) {
      const fm = frontMatter(f), dirName = f.split("/").slice(-2)[0];
      add(prefix + (fm?.name || dirName), fm?.description, agent);
    }
  };
  scanDir(join(HOME, ".claude", "skills"), "claude");
  scanDir(join(HOME, ".pi", "agent", "skills"), "pi");
  scanDir(join(HOME, ".agents", "skills"), "pi");
  const plugins = readJson(join(HOME, ".claude", "plugins", "installed_plugins.json"), {}).plugins ?? {};
  for (const [key, installs] of Object.entries(plugins)) for (const inst of installs ?? []) if (inst?.installPath) scanDir(join(inst.installPath, "skills"), "claude", `${key.split("@")[0]}:`);
  return found;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_");

function listMcpServers() {
  const out = []; // { agent, name }
  const claude = readJson(join(HOME, ".claude.json"), {});
  const names = new Set(Object.keys(claude.mcpServers ?? {}));
  for (const p of Object.values(claude.projects ?? {})) for (const k of Object.keys(p?.mcpServers ?? {})) names.add(k);
  for (const n of names) out.push({ agent: "claude", name: n });
  for (const n of Object.keys(readJson(join(HOME, ".pi", "agent", "mcp.json"), {}).mcpServers ?? {})) out.push({ agent: "pi", name: n });
  return out;
}

// ---------- Aggregate ----------
const periodIdx = (ts) => PERIODS.map((d) => (d === 0 || ts >= now - d * DAY ? 1 : 0));
const zeros = () => PERIODS.map(() => 0);
const bump = (arr, ts) => { const f = periodIdx(ts); for (let i = 0; i < arr.length; i++) arr[i] += f[i]; };

const inventory = listSkills();
const skillByNorm = new Map(); for (const s of inventory.values()) skillByNorm.set(norm(s.name), s.name);
const resolveSkill = (n) => (inventory.has(n) ? n : skillByNorm.get(norm(n)) ?? [...inventory.keys()].find((k) => k.endsWith(`:${n}`)) ?? null);

const usage = new Map(); // skill -> { claude:[..], claudeCmd:[..], pi:[..], last }
const uget = (name) => { let u = usage.get(name); if (!u) usage.set(name, (u = { claude: zeros(), claudeCmd: zeros(), pi: zeros(), last: 0 })); return u; };
const mcp = new Map(); // `${agent}|${server}` -> { agent, server, c:[..], tools: Map, last }

const sources = {
  claude: collectEvents(join(HOME, ".claude", "projects"), "cache-claude.json", CLAUDE_NEEDLES, claudeLine),
  pi: collectEvents(join(HOME, ".pi", "agent", "sessions"), "cache-pi.json", PI_NEEDLES, piLine),
};

for (const [agent, events] of Object.entries(sources)) {
  for (const [ts, kind, name] of events ?? []) {
    if (kind === "s" || kind === "c") {
      const real = resolveSkill(name);
      if (!real && kind === "c") continue; // a slash command that is not a skill (/model, /clear, ...)
      const u = uget(real ?? name);
      bump(kind === "c" ? u.claudeCmd : agent === "claude" ? u.claude : u.pi, ts); u.last = Math.max(u.last, ts);
    } else if (kind === "m") {
      const at = name.indexOf("__");
      const server = at > 0 ? name.slice(0, at) : name, tool = at > 0 ? name.slice(at + 2) : name;
      const key = `${agent}|${server}`;
      let m = mcp.get(key); if (!m) mcp.set(key, (m = { agent, server, c: zeros(), tools: new Map(), last: 0 }));
      bump(m.c, ts); m.last = Math.max(m.last, ts);
      const t = m.tools.get(tool) ?? zeros(); bump(t, ts); m.tools.set(tool, t);
    }
  }
}

let overrides = readJson(join(dataDir, "categories.json"), {});
if (!overrides || typeof overrides !== "object") overrides = {};

const names = new Set([...inventory.keys(), ...usage.keys()]);
const skills = [...names].map((name) => {
  const inv = inventory.get(name), u = usage.get(name);
  const total = PERIODS.map((_, i) => (u ? u.claude[i] + u.claudeCmd[i] + u.pi[i] : 0));
  return {
    name, installed: Boolean(inv), agents: inv ? [...inv.agents].sort() : [], description: (inv?.description ?? "").slice(0, 240),
    category: inv ? categorize(name, inv.description, overrides) : overrides[name] ? categorize(name, "", overrides) : REMOVED,
    n: total, claude: u?.claude ?? zeros(), claudeCmd: u?.claudeCmd ?? zeros(), pi: u?.pi ?? zeros(), last: u?.last ?? 0,
  };
});

// MCP servers: installed ones (even with no calls) plus any server seen in the logs.
const servers = new Map();
for (const m of mcp.values()) servers.set(`${m.agent}|${m.server}`, { agent: m.agent, name: m.server, installed: false, n: m.c, last: m.last, tools: [...m.tools].map(([name, n]) => ({ name, n })).sort((a, b) => b.n[3] - a.n[3]) });
for (const inv of listMcpServers()) {
  const hit = [...servers.values()].find((s) => s.agent === inv.agent && norm(s.name) === norm(inv.name));
  if (hit) hit.installed = true;
  else servers.set(`${inv.agent}|${inv.name}`, { agent: inv.agent, name: inv.name, installed: true, n: zeros(), last: 0, tools: [] });
}

// Language: data/skill-ledger/config.json {"lang":"zh"|"en"}, else the system locale.
const cfg = readJson(join(dataDir, "config.json"), {});
const lang = String(cfg.lang || Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
process.stdout.write(JSON.stringify({ at: now, lang, periods: PERIODS, skills, mcp: [...servers.values()], logs: { claude: sources.claude !== null, pi: sources.pi !== null } }));
