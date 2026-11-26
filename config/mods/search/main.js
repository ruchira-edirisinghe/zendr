// Search, in two modes, opened by review-tabs as a popup with props { mode }:
//  - "all" (Alt+Space): one box for everything in Zendr: sessions, the repo's files,
//    commands (the app's and every mod's palette entries), Settings pages and features,
//    and notifications. Enter goes there, opens it or runs it.
//  - "code" (Ctrl+F): the text inside the repo's files (`git grep`), in the whole repo or
//    only the file the code view shows, with match case and regex switches. Enter opens
//    the file at that line in the code view.
// Tab switches between the two; ↑/↓ move; Esc closes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { readdir, readFile } from "fs/promises";
import { props, closeOverlay, run, exec, theme, shared, setShared, spaces, panes, focused, layout, commands, keys, appHome, settings } from "herdr";
import { fileIcon } from "./lang.js";

const ICON = (name) => `mods/review-file/icons/${name}.svg`;
const MAX_FILES = 40000;
const MAX_LINES = 600; // code matches shown
const MAX_REPOS = 60;
const slash = (p) => String(p).split("\\").join("/").replace(/\/+$/, "");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "out", "vendor", "bin", "obj"]);
const LIMITS = { session: 8, file: 10, command: 8, setting: 6, note: 5 };
const GROUP_TITLES = { session: "Sessions", file: "Files", command: "Commands", setting: "Settings", note: "Notifications", code: "Code" };

const SETTINGS = [
  ["look", "Look", "theme appearance font size layout dark light"],
  ["features", "Features", "turn off on extras simple"],
  ["claude", "Claude mods", "plugins next steps session bridge model router claude code"],
  ["machines", "Machines", "ssh remote computers"],
  ["alerts", "Notifications", "alerts sounds do not disturb popups badge"],
  ["updates", "Updates", "version release"],
  ["privacy", "Privacy", "telemetry data"],
];
const FEATURES = [
  "Hub", "Notifications button", "Source control graph", "Explorer and code view", "New terminal buttons", "Arrange blocks",
  "Space details", "What each agent is doing", "Separate Agents list", "Session colours", "Session counts",
  "Editing", "File-type icons", "Language detection", "Ctrl + mouse wheel zoom", "VS Code extensions", "Shortcut hints",
  "Always show pane buttons", "Command search", "Workflows", "Ask AI for a command", "Launch configurations",
];
const STATUS = { blocked: ["Needs you", "blocked"], working: ["Working", "working"], done: ["Done", "done"] };

// Every query word in the text, in any order; earlier, word-start and tighter matches rank higher.
function score(text, words) {
  if (!words.length) return 1;
  const low = text.toLowerCase();
  let s = 0;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i < 0) return -1;
    s += i === 0 ? 6 : /[\s/._-]/.test(low[i - 1]) ? 4 : 1;
  }
  return s - low.length / 200;
}

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export default class Search extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.mode === "code" ? "code" : "all";
    this.query = "";
    this.at = 0;
    this.scope = _props?.scope === "file" ? "file" : "repo"; // code: "repo" | "file"
    this.matchCase = false;
    this.regex = false;
    this.files = [];
    this.commandList = [];
    this.code = { query: null, rows: [], note: null, busy: false, more: false };
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: this.placeholder() });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; this.schedule(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
    // Alive, for review-tabs: the same key again closes this popup.
    const beat = () => setShared("search.open", { id: props()?.overlay, mode: this.mode, alive: Date.now() });
    beat();
    cx.timer.every(500, beat);
    // Where to search: the code view's repo, else the focused terminal's.
    const f = focused(), space = spaces().find((s) => s.id === f?.space);
    this.on = space?.machine ?? null;
    this.current = shared("review-file.current");
    cx.spawn(async (cx) => {
      await this.findRoot(f?.cwd ?? space?.folder ?? null);
      cx.notify();
      await Promise.all([this.loadFiles(), this.loadCommands()]);
      cx.notify();
      if (this.mode === "code" && this.query) this.runCode(cx);
    });
  }

  placeholder() {
    return this.mode === "code" ? "Search the code (Tab: search everything)" : "Search sessions, files, commands, settings… (Tab: search code)";
  }

  async findRoot(cwd) {
    const cur = this.current?.root;
    const dir = cur || cwd;
    this.root = dir;
    this.isGit = false;
    if (!dir) return;
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, on: this.on, timeout: 8000 }).catch(() => null);
    if (r?.code === 0 && r.stdout.trim()) { this.root = r.stdout.trim().replace(/\\/g, "/"); this.isGit = true; }
    // A plain folder (say, one that holds many projects): search the git repos inside it, each
    // with its own .gitignore. Grepping the whole folder would crawl every node_modules.
    this.repos = this.isGit ? [""] : this.on ? [] : await this.findRepos(this.root);
    // The code view's file, from this root (the repo's top can sit above the code view's folder).
    this.filePath = null;
    if (this.current?.root && this.current?.path) {
      const full = `${slash(this.current.root)}/${this.current.path}`, base = `${slash(this.root)}/`;
      if (full.toLowerCase().startsWith(base.toLowerCase())) this.filePath = full.slice(base.length);
    }
  }

  // Git repos up to three folders down (relative paths; "" is the root itself).
  async findRepos(root) {
    const repos = [];
    const isDir = (e) => (typeof e.isDirectory === "function" ? e.isDirectory() : !!e.isDirectory);
    const walk = async (rel, depth) => {
      if (repos.length >= MAX_REPOS) return;
      let ents = [];
      try { ents = await readdir(rel ? `${root}/${rel}` : root, { withFileTypes: true }); } catch { return; }
      if (ents.some((e) => e.name === ".git")) { repos.push(rel); return; }
      if (depth >= 3) return;
      const dirs = ents.filter((e) => isDir(e) && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name));
      await Promise.all(dirs.map((e) => walk(rel ? `${rel}/${e.name}` : e.name, depth + 1)));
    };
    await walk("", 0);
    return repos.sort();
  }

  // Runs git in each repo at once; the results keep their repo's path from the search root.
  async eachRepo(repos, args, timeout) {
    return Promise.all(repos.map(async (rel) => {
      const r = await exec("git", args(rel), { cwd: rel ? `${this.root}/${rel}` : this.root, on: this.on, timeout }).catch((e) => ({ code: 2, stdout: "", stderr: String(e?.message ?? e) }));
      return { rel, ...r };
    }));
  }

  async loadFiles() {
    if (!this.root) return;
    const out = await this.eachRepo(this.repos ?? [], () => ["ls-files", "--cached", "--others", "--exclude-standard"], 20000);
    const files = [];
    for (const r of out) {
      if (r.code !== 0) continue;
      for (const l of r.stdout.split("\n")) { const f = l.trim(); if (f) files.push(r.rel ? `${r.rel}/${f}` : f); }
    }
    this.files = [...new Set(files)].slice(0, MAX_FILES);
  }

  // The app's commands that need nothing more, and every mod's palette entries, with their keys.
  async loadCommands() {
    const bound = {};
    for (const k of keys()) if (!bound[k.action]) bound[k.action] = k.keys;
    const list = [];
    for (const c of commands()) {
      if (c.args.some((a) => a.required)) continue;
      list.push({ title: c.about.replace(/\.$/, ""), command: c.name, args: {}, words: c.name.replace(/[._]/g, " "), key: bound[c.name] });
    }
    const dir = `${appHome()}/mods`;
    let names = [];
    try { names = (await readdir(dir)).filter((n) => !n.startsWith(".")); } catch { /* none */ }
    for (const mod of names) {
      try {
        const entries = JSON.parse(await readFile(`${dir}/${mod}/mod.json`, "utf8")).palette;
        for (const e of Array.isArray(entries) ? entries : []) {
          if (!e?.title || !e.command || e.command === "review-tabs.search") continue;
          list.push({ title: e.title, command: e.command, args: e.args ?? {}, words: e.words ?? "", key: bound[e.command] });
        }
      } catch { /* unreadable: skipped */ }
    }
    this.commandList = list;
  }

  // ---- results ----------------------------------------------------------

  allItems() {
    const q = this.query.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
    const groups = { session: [], file: [], command: [], setting: [], note: [] };
    const sessionCount = spaces().reduce((n, s) => n + s.tabs.length, 0);
    for (const s of spaces()) for (const tab of s.tabs) {
      const agentNames = panes().filter((p) => p.tab === tab.id).map((p) => p.program?.name ?? "").join(" ");
      const sc = score(`${tab.name} ${s.name} ${agentNames} ${tab.status ?? ""}`, words);
      if (sc < 0) continue;
      const urgent = tab.status === "blocked" ? 5 : tab.status === "done" ? 2 : 0;
      groups.session.push({ kind: "session", score: sc + urgent, title: tab.name, detail: s.name + (s.machine ? ` · ${s.machine}` : ""), status: tab.status, tab: tab.id });
    }
    if (words.length) {
      for (const path of this.files) {
        const sc = score(path, words);
        if (sc >= 0) groups.file.push({ kind: "file", score: sc + (score(baseName(path), words) >= 0 ? 3 : 0), title: baseName(path), detail: dirName(path), path });
        if (groups.file.length > 400) break;
      }
    }
    for (const c of this.commandList) {
      const sc = score(`${c.title} ${c.words} ${c.command}`, words);
      if (sc >= 0 && words.length) groups.command.push({ kind: "command", score: sc, title: c.title, detail: c.key ?? "", command: c });
    }
    if (words.length) {
      for (const [section, title, extra] of SETTINGS) {
        const sc = score(`${title} settings ${extra}`, words);
        if (sc >= 0) groups.setting.push({ kind: "setting", score: sc + 1, title: `Settings → ${title}`, detail: "", section });
      }
      for (const name of FEATURES) {
        const sc = score(`${name} feature switch`, words);
        if (sc >= 0) groups.setting.push({ kind: "setting", score: sc, title: name, detail: "Settings → Features", section: "features" });
      }
      for (const n of (shared("inbox.log") ?? []).slice(0, 200)) {
        const sc = score(`${n.title ?? ""} ${n.body ?? ""} ${n.space_name ?? ""}`, words);
        if (sc >= 0) groups.note.push({ kind: "note", score: sc, title: n.title || "Notification", detail: n.body ?? "", note: n });
      }
    }
    const out = [];
    if (words.length) out.push({ kind: "code", title: `Search the code for “${this.query.trim()}”`, detail: "Ctrl+F" });
    for (const g of ["session", "file", "command", "setting", "note"]) {
      const list = groups[g].sort((a, b) => b.score - a.score).slice(0, words.length ? LIMITS[g] : g === "session" ? 12 : 0);
      if (list.length) out.push({ head: GROUP_TITLES[g] + (g === "session" && !words.length ? ` · ${sessionCount}` : "") }, ...list);
    }
    return out;
  }

  // ---- code search ------------------------------------------------------

  schedule(cx) {
    if (this.mode !== "code") return;
    const at = (this.typedAt = Date.now());
    cx.timer.after(220, (cx) => { if (this.typedAt === at) this.runCode(cx); });
  }

  runCode(cx) {
    const q = this.query;
    if (!q.trim() || !this.root) { this.code = { query: q, rows: [], note: null, busy: false, more: false }; cx.notify(); return; }
    const file = this.scope === "file" ? this.filePath : null;
    // One file: the repo that holds it (or the bare folder). Otherwise every repo.
    const owner = file ? (this.repos ?? []).filter((rel) => !rel || file.startsWith(`${rel}/`)).sort((a, b) => b.length - a.length)[0] : null;
    const repos = file ? [owner ?? ""] : this.repos ?? [];
    if (!repos.length) { this.code = { query: q, rows: [], note: "No git repos in this folder to search. Open a terminal or a file inside a project.", busy: false, more: false }; cx.notify(); return; }
    const args = (rel) => {
      const a = ["grep", "-n", "-I", "--no-color", "-m", "200"];
      if (file && owner == null) a.push("--no-index");
      else if (!file) a.push("--untracked");
      if (!this.matchCase) a.push("-i");
      a.push(this.regex ? "-E" : "-F", "-e", q, "--");
      if (file) a.push(rel ? file.slice(rel.length + 1) : file);
      return a;
    };
    this.code = { ...this.code, busy: true };
    const ask = (this.codeAsk = (this.codeAsk ?? 0) + 1);
    cx.spawn(async (cx) => {
      const out = await this.eachRepo(repos, args, 30000);
      if (ask !== this.codeAsk) return;
      const lines = [];
      for (const r of out) for (const l of r.stdout.split("\n")) if (l) lines.push(r.rel ? `${r.rel}/${l}` : l);
      const r = out.find((x) => x.code > 1) ?? { code: 0, stderr: "" };
      const rows = [];
      let last = null, files = 0;
      for (const l of lines.slice(0, MAX_LINES)) {
        const m = /^(.*?):(\d+):(.*)$/.exec(l);
        if (!m) continue;
        const [, path, line, text] = m;
        if (path !== last) { rows.push({ kind: "codefile", title: baseName(path), detail: dirName(path), path }); last = path; files++; }
        rows.push({ kind: "match", path, line: Number(line), text: text.replace(/\t/g, "  ").slice(0, 400) });
      }
      const note = r.code > 1 ? (r.stderr.trim().split("\n")[0] || "git grep failed") : !rows.length ? `Nothing matches “${q}”${file ? ` in ${baseName(file)}` : ""}.` : null;
      this.code = { query: q, rows, note, busy: false, more: lines.length > MAX_LINES, count: Math.min(lines.length, MAX_LINES), files };
      this.at = Math.min(this.at, Math.max(0, rows.length - 1));
      cx.notify();
    });
  }

  items() {
    return this.mode === "code" ? this.code.rows : this.allItems();
  }

  // ---- actions ----------------------------------------------------------

  close() { setShared("search.open", null); closeOverlay(props()?.overlay); }

  setMode(mode, cx) {
    this.mode = mode;
    this.at = 0;
    this.input.set_placeholder?.(this.placeholder());
    if (mode === "code") this.runCode(cx);
    this.input.focus();
    cx.notify();
  }

  enter(cx) {
    const list = this.items().filter((it) => !it.head);
    const it = list[this.at];
    if (it) this.pick(it, cx);
  }

  pick(it, cx) {
    if (it.kind === "code") { this.setMode("code", cx); return; }
    this.close();
    if (it.kind === "session") run("tab.select", { id: it.tab });
    else if (it.kind === "file" || it.kind === "codefile") this.openFile(it.path, null);
    else if (it.kind === "match") this.openFile(it.path, it.line);
    else if (it.kind === "command") run(it.command.command, it.command.args ?? {});
    else if (it.kind === "setting") run("app.settings", { section: it.section });
    else if (it.kind === "note") { if (it.note.tab) run("tab.select", { id: it.note.tab }); else run("review-tabs.inbox"); }
  }

  // In the layout's code view (shown if hidden), else one beside the terminal.
  openFile(path, line) {
    const file = { root: this.root, path, on: this.on, isGit: this.isGit };
    const block = (function find(node) {
      if (node?.id === "code" && node.content?.mod === "review-file") return node;
      for (const child of node?.children ?? []) { const found = find(child); if (found) return found; }
      return null;
    })(layout());
    const tab = focused()?.tab, view = tab && panes().find((p) => p.tab === tab && p.mod === "review-file");
    const at = Date.now();
    if (block) {
      if (block.hidden) run("layout.show", { id: "code" });
      setShared("review-file.goto", { ...file, target: "layout", pin: true, line: line ?? undefined, at });
    } else if (view) setShared("review-file.goto", { ...file, tab, pin: true, line: line ?? undefined, at });
    else run("pane.split", { direction: "right", mod: "review-file", props: { ...file, line } });
  }

  move(by, list, cx) {
    const pickable = list.filter((it) => !it.head).length;
    this.at = Math.max(0, Math.min(pickable - 1, this.at + by));
    // The child index of the selected row (group titles are children too).
    let n = -1, child = 0;
    for (let i = 0; i < list.length; i++) { if (!list[i].head) n++; if (n === this.at) { child = i; break; } }
    this.scroll.scroll_to_item(child);
    cx.notify();
  }

  // ---- view -------------------------------------------------------------

  highlight(text, t) {
    const q = this.code.query ?? "";
    let start = -1, len = 0;
    if (this.regex) {
      try { const m = new RegExp(q, this.matchCase ? "" : "i").exec(text); if (m) { start = m.index; len = m[0].length; } } catch { /* no highlight */ }
    } else {
      start = (this.matchCase ? text : text.toLowerCase()).indexOf(this.matchCase ? q : q.toLowerCase());
      len = q.length;
    }
    const trimmed = text.trimStart(), cut = text.length - trimmed.length;
    if (start < 0 || !len) return h_flex().min_w(0).child(div().truncate().child(trimmed));
    const s = Math.max(0, start - cut), lead = trimmed.slice(0, s);
    // Long lines keep the match in view.
    const before = lead.length > 60 ? "…" + lead.slice(-50) : lead;
    return h_flex().min_w(0).overflow_hidden()
      .child(div().flex_none().child(before))
      .child(div().flex_none().rounded(3).bg(t.accent + "40").text_color(t.foreground).child(trimmed.slice(s, s + len)))
      .child(div().truncate().child(trimmed.slice(s + len)));
  }

  chip(t, id, label, on, tip, action) {
    return div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(11.5).cursor_pointer().tooltip(tip)
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "22" : t.popover).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => action(cx)).child(label);
  }

  render(cx) {
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono";
    const list = this.items();
    const pickable = list.filter((it) => !it.head).length;
    this.at = Math.min(this.at, Math.max(0, pickable - 1));
    let n = -1;
    const fileName = this.current?.path ? baseName(this.current.path) : null;
    const row = (it, i) => {
      if (it.head) return div().h(26).flex_none().px(12).pt(8).text_size(10.5).font_semibold().text_color(t.dim).child(it.head.toUpperCase());
      const idx = ++n, on = idx === this.at;
      const base = h_flex().id(`srch-${i}`).w_full().flex_none().px(10).gap(10).items_center().rounded(7).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pick(it, cx));
      if (it.kind === "match") {
        return base.h(26).pl(34).font_family(mono).text_size(12)
          .child(div().w(42).flex_none().text_color(t.dim).child(String(it.line)))
          .child(div().flex_1().min_w(0).text_color(t.muted).child(this.highlight(it.text, t)));
      }
      let glyph, color = t.muted;
      if (it.kind === "session") { glyph = ICON("terminal"); color = it.status === "blocked" ? t.blocked : it.status === "working" ? t.working ?? t.accent : it.status === "done" ? t.done ?? t.accent : t.muted; }
      else if (it.kind === "file" || it.kind === "codefile") { const f = fileIcon(it.path); glyph = f.icon; color = f.color; }
      else if (it.kind === "command") glyph = ICON("keyboard");
      else if (it.kind === "setting") glyph = ICON("gear");
      else if (it.kind === "note") glyph = "mods/review-tabs/bell.svg";
      else if (it.kind === "code") { glyph = ICON("search"); color = t.accent; }
      const status = STATUS[it.status];
      return base.h(it.kind === "codefile" ? 30 : 36)
        .child(svg(glyph).size(15).flex_none().text_color(color))
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().max_w(340).truncate().text_size(13).text_color(t.foreground).when(it.kind === "codefile", (el) => el.font_semibold()).child(it.title))
          .when(Boolean(it.detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(it.detail))))
        .when(Boolean(status), (el) => el.child(div().flex_none().h(18).px(7).rounded(9).flex().items_center().text_size(10.5)
          .bg((t[status[1]] ?? t.accent) + "22").text_color(t[status[1]] ?? t.accent).child(status[0])));
    };
    const codeInfo = this.mode !== "code" ? null
      : this.code.busy ? "Searching…"
      : this.code.note ? this.code.note
      : this.code.rows.length ? `${this.code.count}${this.code.more ? "+" : ""} matches in ${this.code.files} file${this.code.files === 1 ? "" : "s"}${this.code.more ? " (showing the first)" : ""}`
      : this.root ? `In ${baseName(this.root) || this.root}${this.isGit ? "" : ` · ${this.repos?.length ?? 0} repos`}${this.scope === "file" && fileName ? ` · ${fileName}` : ""}` : "Open a terminal or a file in a folder to search its code.";
    return v_flex().id("search").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "down") this.move(1, list, cx);
        else if (e.key === "up") this.move(-1, list, cx);
        else if (e.key === "pagedown") this.move(10, list, cx);
        else if (e.key === "pageup") this.move(-10, list, cx);
        else if (e.key === "enter") this.enter(cx);
        else if (e.key === "tab") this.setMode(this.mode === "code" ? "all" : "code", cx);
        else if (e.keystroke === "alt-c" && this.mode === "code") { this.matchCase = !this.matchCase; this.runCode(cx); }
        else if (e.keystroke === "alt-r" && this.mode === "code") { this.regex = !this.regex; this.runCode(cx); }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      // Modes
      .child(h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .children([["all", "Everything", "search", "Alt+Space"], ["code", "Code", "code", "Ctrl+F"]].map(([m, label, ic, key]) => {
          const on = this.mode === m;
          return h_flex().id(`srch-mode-${m}`).h(28).px(10).gap(6).items_center().rounded(7).cursor_pointer().text_size(12)
            .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.setMode(m, cx))
            .child(svg(ICON(ic)).size(13)).child(label).child(div().text_size(10.5).text_color(t.dim).child(key));
        }))
        .child(div().flex_1())
        .when(this.mode === "code", (el) => el
          .when(Boolean(fileName), (el) => el
            .child(this.chip(t, "srch-scope-repo", "Whole repo", this.scope === "repo", "Search every file in the repo", (cx) => { this.scope = "repo"; this.runCode(cx); cx.notify(); }))
            .child(this.chip(t, "srch-scope-file", "This file", this.scope === "file", `Search only ${fileName}`, (cx) => { this.scope = "file"; this.runCode(cx); cx.notify(); })))
          .child(this.chip(t, "srch-case", "Aa", this.matchCase, "Match case (Alt+C)", (cx) => { this.matchCase = !this.matchCase; this.runCode(cx); cx.notify(); }))
          .child(this.chip(t, "srch-regex", ".*", this.regex, "Regular expression (Alt+R)", (cx) => { this.regex = !this.regex; this.runCode(cx); cx.notify(); }))))
      // Box
      .child(h_flex().flex_none().px(12).py(10).gap(8).items_center()
        .child(svg(ICON(this.mode === "code" ? "code" : "search")).size(15).text_color(t.dim))
        .child(div().flex_1().min_w(0).h(32).px(9).flex().items_center().rounded(8).bg(t.background).border_1().border_color(t.accent)
          .child(Input.new(this.input).h_full().text_size(13.5).text_color(t.foreground))))
      .when(Boolean(codeInfo), (el) => el.child(div().px(16).pb(6).text_size(11.5).text_color(this.code.note && this.mode === "code" ? t.muted : t.dim).child(codeInfo)))
      // Results
      .child(v_flex().id("srch-list").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.scroll).px(6).pb(6)
        .children(list.map(row))
        .when(!list.length && this.mode === "all", (el) => el.child(div().p(20).text_color(t.dim)
          .child(this.query.trim() ? "Nothing matches." : "Type to search your sessions, the repo's files, commands and settings."))))
      // Footer
      .child(h_flex().h(30).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("↑↓ move").child("Enter: open").child("Tab: " + (this.mode === "code" ? "search everything" : "search code")).child(div().flex_1())
        .child(this.root ? baseName(this.root) : ""));
  }
}
