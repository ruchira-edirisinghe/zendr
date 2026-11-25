// A code view for reviews, like VS Code: a file with its uncommitted changes marked inline
// (added lines green, removed lines red, old and new line numbers, syntax colors, next and
// previous change, an overview ruler), an Explorer with the changed files and the repo's tree,
// and Split / Code / Terminal views of its tab.
// Props (all optional): { root, path, on, tab } - the repo's top folder, a file in it, the
// machine, and whether this view owns its tab. Without root it uses the focused terminal's repo.
// Opened by review-changes (the Changes panel's Open full file) and the palette's Code view.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { props, exec, readTextFile, watchFolder, theme, settings, window, nextCommand, run, panes, focused, spaces, shared, setShared, layout } from "herdr";

// Reads write nothing under .git, so the folder watch doesn't wake us again.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_LINES = 200000, MAX_COLUMNS = 2000, CONTEXT = 3;
const rowHeight = size => Math.ceil(size * 1.8), charWidth = size => size * 0.64;
// Text draws a tab as nothing: pad each to the next 4-column stop. One pass, for whole files.
function untab(text) {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) out += ch === "\t" ? " ".repeat(4 - out.length % 4) : ch;
  return out;
}
const clip = (text) => {
  const line = untab(text.replace(/\r$/, ""));
  return line.length > MAX_COLUMNS ? line.slice(0, MAX_COLUMNS) + " … (line truncated)" : line;
};
const wideGlyph = /[\p{Ideographic}\p{Emoji_Presentation}\p{Extended_Pictographic}ᄀ-ᅟ⺀-꓏가-힣︐-︙︰-﹯！-｠￠-￦]/gu;
function displayColumns(text) {
  if (!/[^\x00-\x7f]/.test(text)) return text.length;
  let columns = text.length;
  for (const glyph of text.match(wideGlyph) ?? []) if (glyph.length === 1) columns++;
  return columns;
}

// ---- A small highlighter: comments, strings, numbers, keywords, calls and types. ----
const KEYWORDS = new Set(("abstract and as assert async await base begin break case catch class const continue debugger def default defer del delete do "
  + "dyn elif else elsif end enum except export extends extern final finally fn for foreach from func function go goto if impl implements import in "
  + "include instanceof interface internal is lambda let local loop match mod module move mut namespace new not of or override package param pass "
  + "private protected pub public raise readonly ref return select self sizeof static struct super switch template then this throw throws trait try "
  + "type typedef typeof union unless unsafe until use using var virtual void volatile where while with yield").split(" "));
const CONSTANTS = new Set("true false null nil None True False undefined NaN Infinity".split(" "));
const SLASH = { line: ["//"], block: [["/*", "*/"]], quotes: "\"'`", multiline: "`" };
const HASH = { line: ["#"], block: [], quotes: "\"'", multiline: "" };
const LANGS = {
  ...Object.fromEntries("js jsx ts tsx mjs cjs mts cts c h cc cpp cxx hpp hh cs java kt kts go rs swift scala dart php zig json jsonc json5 groovy gradle proto sol v".split(" ").map(e => [e, SLASH])),
  ...Object.fromEntries("css scss less".split(" ").map(e => [e, { line: [], block: [["/*", "*/"]], quotes: "\"'", multiline: "" }])),
  ...Object.fromEntries("rb sh bash zsh fish yaml yml toml r pl pm conf cfg mk nix cmake tf env gitignore dockerfile makefile".split(" ").map(e => [e, HASH])),
  py: { line: ["#"], block: [['"""', '"""', "string"], ["'''", "'''", "string"]], quotes: "\"'", multiline: "" },
  ps1: { line: ["#"], block: [["<#", "#>"]], quotes: "\"'", multiline: "" },
  psm1: { line: ["#"], block: [["<#", "#>"]], quotes: "\"'", multiline: "" },
  lua: { line: ["--"], block: [["--[[", "]]"]], quotes: "\"'", multiline: "" },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: "'\"", multiline: "" },
  hs: { line: ["--"], block: [["{-", "-}"]], quotes: "\"", multiline: "" },
  ...Object.fromEntries("html htm xml svg vue svelte xaml csproj props targets".split(" ").map(e => [e, { line: [], block: [["<!--", "-->"]], quotes: "\"'", multiline: "" }])),
};
function language(path) {
  const name = path.split("/").pop().toLowerCase();
  if (name === "dockerfile" || name === "makefile") return LANGS[name];
  return name.includes(".") ? LANGS[name.split(".").pop()] ?? null : null;
}
const NUMBER = /0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z0-9_]*/y, WORD = /[A-Za-z_$@][\w$]*/y, PLAIN = /[^A-Za-z_$@0-9"'`#/\-<{]+/y;

// One line into [{kind, text}], carrying an open block comment or string to the next line.
function tokenize(line, lang, state) {
  const out = [];
  const push = (kind, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text; else out.push({ kind, text });
  };
  let i = 0;
  while (i < line.length) {
    if (state) {
      const end = line.indexOf(state.end, i);
      if (end < 0) { push(state.kind, line.slice(i)); return [out, state]; }
      push(state.kind, line.slice(i, end + state.end.length)); i = end + state.end.length; state = null; continue;
    }
    const block = lang.block.find(([open]) => line.startsWith(open, i));
    if (block) { state = { end: block[1], kind: block[2] ?? "comment" }; push(state.kind, block[0]); i += block[0].length; continue; }
    if (lang.line.some(p => line.startsWith(p, i))) { push("comment", line.slice(i)); break; }
    const ch = line[i];
    if (lang.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      if (j < line.length) { push("string", line.slice(i, j + 1)); i = j + 1; continue; }
      if (lang.multiline.includes(ch)) { push("string", line.slice(i)); return [out, { end: ch, kind: "string" }]; }
      push("plain", ch); i++; continue; // An unclosed quote: an apostrophe or a Rust lifetime.
    }
    const prev = line[i - 1] ?? " ";
    if (ch >= "0" && ch <= "9" && !/[\w$]/.test(prev)) {
      NUMBER.lastIndex = i; const m = NUMBER.exec(line); push("number", m[0]); i += m[0].length; continue;
    }
    WORD.lastIndex = i;
    const word = /[\w$]/.test(prev) ? null : WORD.exec(line);
    if (word) {
      const w = word[0], next = line.slice(i + w.length, i + w.length + 40);
      push(KEYWORDS.has(w) ? "keyword" : CONSTANTS.has(w) ? "constant" : /^\s*\(/.test(next) ? "function" : /^[A-Z][a-z0-9]/.test(w) ? "type" : "plain", w);
      i += w.length; continue;
    }
    PLAIN.lastIndex = i;
    const run = PLAIN.exec(line);
    if (run) { push("plain", run[0]); i += run[0].length; } else { push("plain", ch); i++; }
  }
  return [out, state];
}

// The diff of the whole file (git diff -U<all>) as numbered rows.
function parseDiff(lines) {
  const rows = [];
  let old = 0, next = 0, started = false;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { old = +hunk[1]; next = +hunk[2]; started = true; continue; }
    if (!started || line.startsWith("\\")) continue; // "\ No newline at end of file"
    const kind = line[0];
    if (kind === "-") rows.push({ kind, old: old++, text: clip(line.slice(1)) });
    else if (kind === "+") rows.push({ kind, new: next++, text: clip(line.slice(1)) });
    else if (kind === " ") rows.push({ kind, old: old++, new: next++, text: clip(line.slice(1)) });
    if (rows.length >= MAX_LINES) break;
  }
  return rows;
}

// Where the person is working: the focused terminal, else a terminal in the shown space.
function place() {
  const space = spaces().find(s => s.active), f = focused(), all = panes();
  const on = space?.machine ?? null, pane = f?.pane ? all.find(p => p.pane === f.pane) : null;
  if (pane?.cwd) return { cwd: pane.cwd, on };
  const tabs = new Set((space?.tabs ?? []).map(t => t.id)), terminal = all.find(p => tabs.has(p.tab) && p.cwd);
  return { cwd: terminal?.cwd || f?.cwd || space?.folder, on };
}
// A folder's entries, as the shipped Files panel lists them (for folders outside git).
async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}
const MARK = { A: "ansi2", M: "blocked", D: "ansi1", U: "ansi1" };
// Which view holds which review-file pane (the views share one VM): pane id → { token, at }.
const claims = globalThis[Symbol.for("review-file.claims")] ??= new Map();
const TREE_ROW = 24, MAX_FILES = 100000;
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

export default class ReviewFile extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.root = p.root ?? null; this.on = p.on ?? null; this.path = p.path ?? null; this.ownsTab = Boolean(p.tab);
    // part: "explorer" or "code" is a layout block that follows the shown space, not a pane.
    this.part = p.part === "explorer" || p.part === "code" ? p.part : null;
    this.isGit = true; this.dirEntries = new Map(); this.spaceStates = new Map();
    this.token = Math.random().toString(36).slice(2); this.tab = null; this.gotoAt = shared("review-file.goto")?.at ?? 0;
    if (!this.part) this.identify();
    this.rows = []; this.view = []; this.hunks = []; this.add = 0; this.del = 0; this.longest = 0;
    this.compact = false; this.at = -1; this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.changes = []; this.marks = {}; this.markedDirs = new Set(); this.tree = null; this.treeRows = []; this.openDirs = new Set();
    this.start(cx);
    cx.timer.every(500, cx => {
      if (this.part) this.followSpace(cx);
      else {
        const known = this.paneId;
        if (this.identify()?.pane !== known) cx.notify(); // Keeps the claim; redraws once found.
      }
      const active = window()?.active !== false, refocused = active && this.active === false;
      this.active = active;
      if (active && !this.loading && (refocused || (this.dirtyAt && Date.now() >= this.dirtyAt))) { this.load(cx); this.loadFiles(cx, refocused); }
      // The ruler needs the list's height, known only after a layout: redraw once it changes.
      if (this.scroll.viewport_size().height !== this.rulerHeight) cx.notify();
    });
    // Key bindings in keys.json: review-file.next, .prev, .compact, .explorer, .code, .reload.
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "next") this.step(1, cx);
        else if (command === "prev") this.step(-1, cx);
        else if (command === "compact") this.toggleCompact(cx);
        else if (command === "explorer") this.toggleExplorer();
        else if (command === "split") this.showSplit(cx);
        else if (command === "code-only") this.showCode(cx);
        else if (command === "terminal-only") this.showTerminal(cx);
        else if (command === "code") this.openInCode(cx);
        else if (command === "reload" && !this.loading) { this.load(cx); this.loadFiles(cx, true); }
        else if (command === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  // A layout block shows the shown space: its repo, else its folder. Each space keeps
  // its own open file and folders.
  followSpace(cx) {
    const space = spaces().find(s => s.active), { cwd, on } = place();
    const key = JSON.stringify([space?.id, cwd, on]);
    if (key === this.placeKey || this.resolving) return;
    this.placeKey = key;
    if (!cwd) return;
    this.resolving = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const isGit = top?.code === 0, root = isGit ? top.stdout.trim() : cwd;
        if (root !== this.root || space?.id !== this.spaceId || on !== this.on) this.reroot({ root, on, isGit, spaceId: space?.id }, cx);
      } finally { this.resolving = false; cx.notify(); }
    });
  }

  reroot({ root, on, isGit, spaceId }, cx) {
    if (this.spaceId) this.spaceStates.set(this.spaceId, { root: this.root, path: this.path, openDirs: this.openDirs, compact: this.compact });
    const saved = this.spaceStates.get(spaceId), same = saved?.root === root;
    this.spaceId = spaceId; this.root = root; this.on = on; this.isGit = isGit;
    this.path = same ? saved.path : null; this.openDirs = same ? saved.openDirs : new Set(); this.compact = same ? saved.compact : false;
    this.tree = null; this.dirEntries = new Map(); this.treeRows = []; this.changes = []; this.marks = {}; this.markedDirs = new Set();
    this.first = true; this.at = -1; this.note = null; this.error = null; this.toast = null; this.treeError = null;
    this.autoOpen = !this.path; this.generation = (this.generation ?? 0) + 1; this.loading = false;
    this.setRows([]);
    if (this.part === "code") setShared("review-file.current", { root, path: this.path });
    this.begin(cx);
  }

  // Opened without a repo (the palette): use the repo of the folder the person works in.
  start(cx) {
    if (this.part) { this.followSpace(cx); return; }
    if (this.root) { this.begin(cx); return; }
    const { cwd, on } = place();
    if (!cwd) { this.error = "No folder: open this from a terminal's folder"; return; }
    cx.spawn(async cx => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      if (top?.code === 0) { this.root = top.stdout.trim(); this.on = on; this.begin(cx); }
      else this.error = "Not a git repository: " + cwd;
      cx.notify();
    });
  }

  begin(cx) {
    if (this.part !== "explorer") this.load(cx);
    this.loadFiles(cx, true);
    this.watch(cx);
  }

  get explorer() { return this.part ? this.part === "explorer" : shared("review-file.explorer") ?? true; }
  // Narrow panes (a split) hide the Explorer until asked for, as VS Code's does.
  get narrow() { return (this.width ?? 1000) < 760; }
  get showExplorer() { return this.part ? false : this.narrow ? this.explorer && this.forceExplorer === true : this.explorer; }
  toggleExplorer() {
    if (this.narrow && this.explorer) this.forceExplorer = !this.forceExplorer;
    else { setShared("review-file.explorer", !this.explorer); this.forceExplorer = true; }
  }

  // A save anywhere in the repo: the diff, the changed files and the tree may all differ.
  watch(cx) {
    this.watching?.pending?.cancel();
    this.watching = null;
    if (this.on || !this.root) return;
    const state = this.watching = { root: this.root };
    cx.spawn(async cx => {
      try {
        while (this.watching === state) {
          state.pending = watchFolder(state.root);
          const changed = await state.pending;
          if (this.watching !== state) break;
          if (changed.some(p => !/[\\/]\.git([\\/]|$)/.test(p))) this.dirtyAt = Date.now() + 300; // Let a save settle.
        }
      } catch { /* The folder went away; the window refocus check still reloads. */ }
    });
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }

  // The changed files (git status) and, every few seconds at most, every file for the tree.
  loadFiles(cx, full) {
    if (!this.root || this.filesLoading) return;
    this.filesLoading = true;
    const root = this.root, tree = full || !this.tree || Date.now() - (this.treeAt ?? 0) > 5000;
    cx.spawn(async cx => {
      try {
        if (!this.isGit) {
          if (!this.explorer) return;
          for (const dir of ["", ...this.openDirs]) {
            if (root !== this.root) return;
            try { this.dirEntries.set(dir, await this.listFolder(dir)); }
            catch (e) { if (!dir) throw e; }
          }
          this.flatten();
          return;
        }
        const status = await this.git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (root !== this.root) return;
        if (status.code === 0) {
          const changes = [], marks = {}, dirs = new Set();
          for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, 5000)) {
            const xy = entry.slice(0, 2), path = entry.slice(3);
            const s = xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy.includes("D") ? "D" : xy === "??" || xy.includes("A") ? "A" : "M";
            changes.push({ path, status: s }); marks[path] = s;
            for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) dirs.add(path.slice(0, i));
          }
          this.changes = changes.sort((a, b) => byName(a.path, b.path)); this.marks = marks; this.markedDirs = dirs;
        }
        if (tree && this.explorer) {
          const listed = await this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
          if (root !== this.root || listed.code !== 0) return;
          const files = [...new Set(listed.stdout.split("\0").filter(Boolean))].slice(0, MAX_FILES);
          this.limited = files.length >= MAX_FILES;
          this.tree = this.buildTree(files); this.treeAt = Date.now();
          this.reveal(this.path);
        }
        this.flatten();
      } catch (e) { this.treeError = String(e?.message ?? e); }
      finally {
        this.filesLoading = false;
        // A space with changes opens its first changed file, as the Changes panel does.
        if (this.part === "code" && this.autoOpen && !this.path && this.changes.length) { this.autoOpen = false; this.openPath(this.changes[0].path, cx); }
        cx.notify();
      }
    });
  }

  async listFolder(dir) {
    const entries = await directory(dir ? `${this.root}/${dir}` : this.root, this.on);
    return entries.slice(0, 500).sort((a, b) => Number(b.dir) - Number(a.dir) || byName(a.name, b.name));
  }

  buildTree(files) {
    const top = { dirs: new Map(), files: [] };
    for (const path of files) {
      const parts = path.split("/");
      let node = top;
      for (let i = 0; i < parts.length - 1; i++) {
        let next = node.dirs.get(parts[i]);
        if (!next) { next = { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] }; node.dirs.set(parts[i], next); }
        node = next;
      }
      node.files.push(path);
    }
    return top;
  }

  // The tree rows on screen: open folders' contents, folders first, as VS Code lists them.
  flatten() {
    const out = [];
    const walk = (node, depth) => {
      for (const dir of [...node.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
        const open = this.openDirs.has(dir.path);
        out.push({ dir: true, name: dir.name, path: dir.path, depth, open });
        if (open) walk(dir, depth + 1);
      }
      for (const path of [...node.files].sort(byName)) out.push({ dir: false, name: path.slice(path.lastIndexOf("/") + 1), path, depth });
    };
    if (this.isGit && this.tree) walk(this.tree, 0);
    if (!this.isGit) {
      const list = (dir, depth) => {
        for (const e of this.dirEntries.get(dir) ?? []) {
          const path = dir ? `${dir}/${e.name}` : e.name, open = e.dir && this.openDirs.has(path);
          out.push({ dir: e.dir, name: e.name, path, depth, open });
          if (open) list(path, depth + 1);
        }
      };
      list("", 0);
    }
    this.treeRows = out;
  }

  reveal(path) {
    if (!path) return;
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) this.openDirs.add(path.slice(0, i));
  }

  toggleDir(path, cx) {
    if (this.openDirs.has(path)) { for (const d of [...this.openDirs]) if (d === path || d.startsWith(path + "/")) this.openDirs.delete(d); }
    else {
      this.openDirs.add(path);
      if (!this.isGit && !this.dirEntries.has(path)) {
        const root = this.root;
        cx.spawn(async cx => {
          try { const entries = await this.listFolder(path); if (root === this.root) this.dirEntries.set(path, entries); }
          catch (e) { this.treeError = String(e?.message ?? e); }
          this.flatten(); cx.notify();
        });
      }
    }
    this.flatten(); cx.notify();
  }

  // Shows another file in this view (the Explorer, the Changes list, or the Changes panel).
  openPath(path, cx) {
    if (!path) return;
    if (this.part === "explorer") {
      this.path = path; this.flatten();
      setShared("review-file.goto", { target: "layout", root: this.root, on: this.on, isGit: this.isGit, path, at: Date.now() });
      if (findNode(layout(), "code")?.hidden) run("layout.show", { id: "code" });
      cx.notify();
      return;
    }
    this.path = path; this.first = true; this.at = -1; this.note = null; this.error = null; this.toast = null;
    this.setRows([]); this.reveal(path); this.flatten();
    if (this.ownsTab) run("tab.rename", { id: this.tab, name: path.split("/").pop() });
    if (this.part === "code") setShared("review-file.current", { root: this.root, path });
    this.load(cx);
    cx.notify();
  }

  load(cx) {
    const root = this.root, path = this.path, on = this.on, isGit = this.isGit;
    this.dirtyAt = 0;
    if (!root || !path) return;
    this.loading = true;
    const generation = this.generation = (this.generation ?? 0) + 1;
    cx.spawn(async cx => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const hasHead = isGit && (await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
        let rows = null, note = null;
        if (hasHead) {
          const r = await git(["diff", "HEAD", "--unified=1000000", "--no-ext-diff", "--no-textconv", "--no-color", "--", path]);
          if (r.code !== 0) throw new Error(r.stderr.trim() || "git diff failed");
          const lines = r.stdout.replace(/\n$/, "").split("\n");
          if (lines.some(l => l.startsWith("@@"))) rows = parseDiff(lines);
          else if (r.stdout.includes("Binary files")) note = "Binary file · no text view";
        }
        if (!rows && !note) {
          // Untracked, new in a repo without commits, or unchanged: read it from disk.
          const tracked = hasHead && (await git(["ls-files", "--error-unmatch", "--", path])).code === 0;
          const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
          if (text === null) note = "This file is gone or can't be read";
          else if (text.includes("\0")) note = "Binary file · no text view";
          else {
            const lines = text.replace(/\n$/, "").split("\n").slice(0, MAX_LINES);
            rows = lines.map((line, i) => tracked || !isGit ? { kind: " ", old: i + 1, new: i + 1, text: clip(line) } : { kind: "+", new: i + 1, text: clip(line) });
            if (tracked) note = "No uncommitted changes in this file";
          }
        }
        if (generation !== this.generation) return;
        this.note = note; this.error = null;
        this.setRows(rows ?? []);
        if (this.first !== false) {
          this.first = false;
          if (this.hunks.length) this.jump(0); else this.scroll.scroll_to_item(0, "top");
        }
        cx.notify();
        await this.highlight(generation, cx);
      } catch (e) {
        if (generation === this.generation) this.error = String(e?.message ?? e);
      } finally {
        if (generation === this.generation) this.loading = false;
        cx.notify();
      }
    });
  }

  setRows(rows) {
    this.rows = rows;
    this.add = rows.filter(r => r.kind === "+").length;
    this.del = rows.filter(r => r.kind === "-").length;
    this.longest = rows.reduce((n, r) => Math.max(n, displayColumns(r.text)), 0);
    this.gutterChars = Math.max(3, String(rows.reduce((n, r) => Math.max(n, r.old ?? 0, r.new ?? 0), 0)).length);
    this.layoutRows();
  }

  // The rows on screen: all of them, or the changes with a few lines around each.
  layoutRows() {
    const rows = this.rows;
    let view = rows;
    if (this.compact) {
      const keep = new Uint8Array(rows.length);
      rows.forEach((r, i) => {
        if (r.kind === " ") return;
        for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) keep[j] = 1;
      });
      view = [];
      let skipped = 0;
      rows.forEach((r, i) => {
        if (keep[i]) {
          if (skipped) view.push({ kind: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
          skipped = 0; view.push(r);
        } else skipped++;
      });
      if (skipped) view.push({ kind: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
    }
    this.view = view;
    // Each run of changed lines is one change: its first row, length, and whether it adds, removes or both.
    this.hunks = [];
    view.forEach((r, i) => {
      if (r.kind !== "+" && r.kind !== "-") return;
      const last = this.hunks[this.hunks.length - 1];
      if (last && last.start + last.length === i) { last.length++; last.kinds.add(r.kind); }
      else this.hunks.push({ start: i, length: 1, kinds: new Set([r.kind]) });
    });
    this.at = Math.min(this.at, this.hunks.length - 1);
  }

  // Colors the rows in slices, so a long file never holds up the window.
  async highlight(generation, cx) {
    const lang = language(this.path ?? "");
    if (!lang) return;
    let oldState = null, newState = null;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const [tokens, state] = tokenize(row.text, lang, row.kind === "-" ? oldState : newState);
      row.tokens = tokens;
      if (row.kind !== "+") oldState = state;
      if (row.kind !== "-") newState = state;
      if (i % 500 === 499) {
        cx.notify();
        await cx.sleep(1);
        if (generation !== this.generation) return;
      }
    }
  }

  visibleRows() {
    const rh = rowHeight(settings().font_size), top = Math.floor(this.scroll.offset().y / rh);
    return { top, count: Math.max(1, Math.floor(this.scroll.viewport_size().height / rh)) };
  }

  jump(index) {
    if (!this.hunks.length) return;
    this.at = (index + this.hunks.length) % this.hunks.length;
    this.scroll.scroll_to_item(this.hunks[this.at].start, "center");
  }

  step(by, cx) {
    if (!this.hunks.length) return;
    const { top, count } = this.visibleRows(), current = this.hunks[this.at];
    if (current && current.start >= top && current.start < top + count) this.jump(this.at + by);
    else {
      // Scrolled away since the last jump: go from what's on screen now.
      const middle = top + count / 2;
      let index = -1;
      this.hunks.forEach((h, i) => { if (by > 0 ? index < 0 && h.start > middle : h.start < middle) index = i; });
      this.jump(index < 0 ? (by > 0 ? 0 : this.hunks.length - 1) : index);
    }
    cx.notify();
  }

  toggleCompact(cx) {
    const { top } = this.visibleRows(), anchor = this.view[top];
    this.compact = !this.compact; this.layoutRows();
    const index = anchor ? this.view.indexOf(anchor) : -1;
    if (index >= 0) this.scroll.scroll_to_item(index, "top");
    else if (this.hunks.length) this.jump(Math.max(0, this.at));
    cx.notify();
  }

  // ---- Split, code only, terminal only: this pane and the terminals in its tab. ----
  // A mod pane isn't told its own id. Each view claims one review-file pane no live view
  // holds (claims are refreshed every tick, so a closed or reloaded view's lapse), the
  // focused one first, then the only one left, then the only one in the shown tab.
  identify() {
    const all = panes(), now = Date.now();
    let mine = this.paneId ? all.find(p => p.pane === this.paneId) : null;
    if (!mine) {
      const free = all.filter(p => {
        const claim = p.mod === "review-file" && claims.get(p.pane);
        return p.mod === "review-file" && (!claim || claim.token === this.token || now - claim.at > 2000);
      });
      const f = focused(), inTab = free.filter(p => p.tab === f?.tab);
      mine = free.find(p => p.pane === f?.pane) ?? (free.length === 1 ? free[0] : inTab.length === 1 ? inTab[0] : null);
    }
    if (!mine) return null;
    this.paneId = mine.pane; this.tab = mine.tab;
    claims.set(mine.pane, { token: this.token, at: now });
    return mine;
  }

  panesHere() {
    const mine = this.identify();
    if (!mine) return null;
    const same = panes().filter(p => p.tab === mine.tab);
    return { mine, same, zoomed: same.find(p => p.zoomed) ?? null, terminal: same.find(p => p.terminal) ?? null };
  }

  mode() {
    if (this.part) return findNode(layout(), "main")?.hidden ? "code" : "split";
    const here = this.panesHere();
    if (!here) return null;
    return here.mine.zoomed || here.same.length === 1 ? "code" : "split";
  }

  // A terminal below the code, when the tab has none (the view was opened as its own tab).
  addTerminal(pane) { run("pane.split", { direction: "down", pane }); }

  showSplit(cx) {
    if (this.part) { run("layout.show", { id: "main" }); run("layout.show", { id: "code" }); return; }
    const here = this.panesHere();
    if (!here) return;
    if (here.zoomed) run("pane.zoom", { pane: here.zoomed.pane });
    else if (!here.terminal) this.addTerminal(here.mine.pane);
    cx.notify();
  }

  showCode(cx) {
    if (this.part) { run("layout.show", { id: "code" }); run("layout.hide", { id: "main" }); return; }
    const here = this.panesHere();
    if (!here || here.mine.zoomed || here.same.length < 2) return;
    run("pane.zoom", { pane: here.mine.pane });
    cx.notify();
  }

  showTerminal(cx) {
    // In the layout, the tab's right-click menu brings the code reviewer back.
    if (this.part) { run("layout.show", { id: "main" }); run("layout.hide", { id: "code" }); return; }
    const here = this.panesHere();
    if (!here) return;
    if (here.mine.zoomed) run("pane.zoom", { pane: here.mine.pane });
    if (here.terminal) { run("pane.zoom", { pane: here.terminal.pane }); return; }
    const tab = here.mine.tab;
    this.addTerminal(here.mine.pane);
    cx.spawn(async cx => {
      for (let i = 0; i < 30; i++) {
        await cx.sleep(100);
        const terminal = panes().find(p => p.tab === tab && p.terminal);
        if (terminal) { run("pane.zoom", { pane: terminal.pane }); return; }
      }
    });
  }

  // Opens VS Code at the line in the middle of the view (or the current change).
  openInCode(cx) {
    if (!this.root) return;
    const root = this.root, path = this.path ?? "", { top, count } = this.visibleRows();
    const current = this.hunks[this.at];
    const from = current && current.start >= top && current.start < top + count ? current.start : top + Math.floor(count / 2);
    let line = 1;
    for (let i = Math.min(from, this.view.length - 1); i >= 0; i--) if (this.view[i]?.new) { line = this.view[i].new; break; }
    const windows = window()?.platform === "windows", file = (path ? `${root}/${path}` : root).replace(/\//g, windows ? "\\" : "/");
    cx.spawn(async cx => {
      try {
        const r = await exec(windows ? "code.cmd" : "code", path ? ["--reuse-window", "--goto", `${file}:${line}`] : ["--reuse-window", file], { cwd: root });
        this.toast = r.code === 0 ? null : (r.stderr.trim() || `code exited with ${r.code}`);
      } catch (e) { this.toast = `Can't start VS Code: ${e?.message ?? e}`; }
      cx.notify();
    });
  }

  gutter(size) { return Math.ceil(this.gutterChars * charWidth(size)) + 8; }

  row(r, t, size) {
    const rh = rowHeight(size), colors = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
    if (r.kind === "…") return div().w_full().h(rh).flex_none().px(12).flex().items_center().bg(t.raised).text_color(t.dim).text_size(Math.max(10, size - 1)).child(`⋯ ${r.text}`);
    const added = r.kind === "+", removed = r.kind === "-", tint = added ? t.ansi2 : removed ? t.ansi1 : null;
    const code = r.tokens
      ? h_flex().flex_1().min_w(0).whitespace_nowrap().children(r.tokens.map(tok => div().flex_none().text_color(colors[tok.kind] ?? t.foreground).child(tok.text)))
      : div().flex_1().min_w(0).whitespace_nowrap().child(r.text || " ");
    return h_flex().w_full().h(rh).flex_none().when(Boolean(tint), e => e.bg(tint + "1c"))
      .child(div().w(3).h_full().flex_none().when(Boolean(tint), e => e.bg(tint)))
      // One column: the line's number in the file as it is now. A removed line has none (its "−" and colour say so).
      .child(div().w(this.gutter(size)).flex_none().text_right().text_color(added ? t.ansi2 : t.dim).child(r.new === undefined ? "" : String(r.new)))
      .child(div().w(22).flex_none().text_center().text_color(tint ?? t.dim).child(added ? "+" : removed ? "−" : ""))
      .child(code);
  }

  // Marks beside the scrollbar for each change, like VS Code's overview ruler. Click one to go there.
  ruler(t) {
    const height = this.rulerHeight = this.scroll.viewport_size().height;
    if (!height || !this.view.length) return [];
    // A file shorter than the view: marks sit beside their lines, not stretched over the height.
    const total = Math.max(this.view.length, height / rowHeight(settings().font_size));
    return this.hunks.map((h, i) => {
      const color = h.kinds.size > 1 ? t.blocked : h.kinds.has("+") ? t.ansi2 : t.ansi1;
      return div().id(`ruler-${i}`).absolute().right(0).w(6).rounded(1).cursor_pointer().bg(color)
        .top(Math.floor(h.start / total * height)).h(Math.max(3, Math.round(h.length / total * height)))
        .on_click((_e, cx) => { this.jump(i); cx.notify(); });
    });
  }

  // A button: an icon (mods/... svg) and/or words, and a tooltip saying what it does.
  button(t, id, label, action, enabled = true, active = false, { icon, tip } = {}) {
    return div().id(id).h(26).px(label ? 9 : 6).gap(5).flex().flex_none().items_center().rounded(6).border_1().border_color(active ? t.accent : t.border).text_size(11)
      .when(active, e => e.bg(t.selected)).when(Boolean(tip), e => e.tooltip(tip))
      .text_color(enabled ? t.foreground : t.dim).when(enabled, e => e.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => action(cx)))
      .when(Boolean(icon), e => e.child(svg(icon).size(13))).when(Boolean(label), e => e.child(label));
  }

  // One of Split / Code / Terminal, like a segmented control.
  modes(t) {
    const mode = this.mode();
    const segment = (id, label, value, action, icon, tip) => div().id(id).h_full().px(9).gap(5).flex().items_center().cursor_pointer().tooltip(tip)
      .when(mode === value, e => e.bg(t.selected).text_color(t.foreground)).hover(s => s.bg(t.hover)).on_click((_e, cx) => action(cx))
      .child(svg(icon).size(12)).child(label);
    return h_flex().h(26).flex_none().rounded(6).overflow_hidden().border_1().border_color(t.border).text_size(11).text_color(t.muted)
      .child(segment("mode-split", "Split", "split", cx => this.showSplit(cx), "mods/workspace-chrome/panel-right.svg", "Code beside the terminal"))
      .child(div().w(1).h_full().bg(t.border))
      .child(segment("mode-code", "Code", "code", cx => this.showCode(cx), "mods/workspace-chrome/file-text.svg", "Only the code"))
      .child(div().w(1).h_full().bg(t.border))
      .child(segment("mode-terminal", "Terminal", "terminal", cx => this.showTerminal(cx), "mods/workspace-chrome/terminal.svg", "Only the terminal"));
  }

  explorerPane(t, full = false) {
    const name = this.root ? this.root.split(/[\\/]/).pop() : "";
    const fileRow = (id, path, label, depth, mark, dim) => h_flex().id(id).w_full().h(TREE_ROW).flex_none().pl(8 + depth * 14).pr(8).gap(6).items_center().cursor_pointer()
      .when(path === this.path, e => e.bg(t.selected)).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.openPath(path, cx))
      .child(svg("mods/files/file.svg").size(13).flex_none().text_color(t.dim))
      .child(h_flex().flex_1().min_w(0).child(div().truncate().text_color(mark ? t[MARK[mark]] : t.foreground).child(label))
        .when(Boolean(dim), e => e.child(div().pl(6).truncate().text_size(10).text_color(t.dim).child(dim))))
      .when(Boolean(mark), e => e.child(div().flex_none().text_size(10).text_color(t[MARK[mark]]).child(mark)));
    const treeRow = (r) => r.dir
      ? h_flex().id(`dir-${r.path}`).w_full().h(TREE_ROW).flex_none().pl(8 + r.depth * 14).pr(8).gap(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleDir(r.path, cx))
          .child(svg(`mods/files/chevron-${r.open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
          .child(svg("mods/files/folder.svg").size(13).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(r.name))
          .when(this.markedDirs.has(r.path), e => e.child(div().w(6).h(6).flex_none().rounded(3).bg(t.blocked)))
      : fileRow(`file-${r.path}`, r.path, r.name, r.depth, this.marks[r.path]);
    // overflow_y_scrollbar() wraps its element, so both lists sit absolutely in a sized box.
    const shown = this.changes.slice(0, 500);
    return v_flex().when(full, e => e.size_full()).when(!full, e => e.w(260).flex_none().h_full().border_r(1).border_color(t.border))
      .min_h(0).bg(t.chrome ?? t.background).text_size(12)
      .child(h_flex().h(30).flex_none().px(12).items_center().text_size(10).text_color(t.dim).child("EXPLORER"))
      .when(this.isGit, e => e.child(h_flex().h(24).flex_none().px(12).items_center().text_size(10).font_semibold().text_color(t.muted).child(`CHANGES (${this.changes.length})`))
      .child(div().flex_none().h(Math.min(200, Math.max(1, shown.length) * TREE_ROW)).relative()
        .child(v_flex().id("review-changes-list").absolute().inset_0().overflow_y_scroll()
          .children(shown.map(c => {
            const slash = c.path.lastIndexOf("/");
            return fileRow(`change-${c.path}`, c.path, c.path.slice(slash + 1), 0, c.status, slash > 0 ? c.path.slice(0, slash) : "");
          }))
          .when(!shown.length, e => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("No uncommitted changes"))))))
      .child(h_flex().h(24).flex_none().px(12).mt(6).items_center().border_t(1).border_color(t.border).text_size(10).font_semibold().text_color(t.muted).child(name.toUpperCase()))
      .child(div().flex_1().min_h(0).relative()
        // A plain list like the Files panel's: open folders only, at most 5,000 rows.
        .child(v_flex().id("review-tree").absolute().inset_0().overflow_y_scroll().pb(8).children(this.treeRows.slice(0, 5000).map(treeRow))
          .when(this.treeRows.length > 5000, e => e.child(div().px(12).py(4).text_size(10).text_color(t.dim).child("Showing the first 5,000 rows: close some folders"))))
        .child(Scrollbar.vertical("review-tree").absolute().inset_0())
        .when(!this.treeRows.length, e => e.child(div().absolute().top(4).px(12).text_size(11).text_color(t.dim).child(this.treeError || (this.filesLoading ? "Loading files…" : "No files")))))
      .when(Boolean(this.limited), e => e.child(div().px(12).py(4).text_size(10).text_color(t.dim).child("Showing the first 100,000 files")));
  }

  // The layout's left block: the shown space's files. Opening one shows it in the code block.
  renderExplorer(cx) {
    const t = theme(), current = shared("review-file.current");
    if (current?.root === this.root && current.path !== this.path) { this.path = current.path; this.reveal(this.path); this.flatten(); }
    return v_flex().id("review-explorer-block").size_full().min_h(0).rounded(10).overflow_hidden().border_1().border_color(t.border)
      .bg(t.chrome ?? t.background).text_color(t.foreground)
      .when(Boolean(this.error), e => e.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.error)))
      .child(this.explorerPane(t, true));
  }

  render(cx) {
    // The Changes panel or the layout's explorer asks a code view to show another file:
    // the one in the asking tab, or the layout's code block.
    const goto = shared("review-file.goto");
    if (goto && goto.at > this.gotoAt && (this.part === "code" ? goto.target === "layout" : !this.part && goto.target !== "layout" && goto.tab === this.tab)) {
      this.gotoAt = goto.at;
      if (goto.root !== this.root) {
        this.root = goto.root; this.on = goto.on ?? null; this.isGit = goto.isGit ?? true;
        this.tree = null; this.dirEntries = new Map(); this.openDirs = new Set(); this.loadFiles(cx, true); this.watch(cx);
      }
      this.openPath(goto.path, cx);
    }
    if (this.part === "explorer") return this.renderExplorer(cx);
    const t = theme(), s = settings(), size = s.font_size, path = this.path;
    const parts = (path ?? "").split("/"), name = parts.pop(), status = path ? this.marks[path] ?? "" : "";
    const hasChanges = this.hunks.length > 0, explorer = this.showExplorer;
    return v_flex().id("review-file").size_full().min_h(0).when(Boolean(this.part), e => e.rounded(10).overflow_hidden().border_1().border_color(t.border)).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => {
        const width = size.width / (settings().zoom || 1);
        if (Math.abs(width - (this.width ?? 0)) > 1) { this.width = width; cx.notify(); }
      })
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "n" || k === "f7" || k === "alt-down") { this.step(1, cx); cx.stop_propagation(); }
        else if (k === "p" || k === "shift-n" || k === "shift-f7" || k === "alt-up") { this.step(-1, cx); cx.stop_propagation(); }
        else if (k === "c") { this.toggleCompact(cx); cx.stop_propagation(); }
        else if (k === "e" || k === "ctrl-b") { if (this.part) run("layout.toggle", { id: "explorer" }); else this.toggleExplorer(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().min_h(42).flex_none().flex_wrap().px(10).py(7).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.part
          ? this.button(t, "review-explorer", "Files", () => run("layout.toggle", { id: "explorer" }), true, !findNode(layout(), "explorer")?.hidden, { icon: "mods/workspace-chrome/panel-left.svg", tip: "Show or hide the file explorer (E)" })
          : this.button(t, "review-explorer", "Files", cx => { this.toggleExplorer(); cx.notify(); }, true, explorer, { icon: "mods/workspace-chrome/panel-left.svg", tip: "Show or hide the file explorer (E)" }))
        .when(Boolean(status), e => e.child(div().text_size(11).text_color(t[MARK[status]]).child(status)))
        .child(h_flex().flex_1().min_w(140).overflow_hidden().child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().font_semibold().flex_none().child(name || "Pick a file in the Explorer")))
        .when(Boolean(path), e => e
          .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${this.add}`)).child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${this.del}`))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(hasChanges ? `${this.at >= 0 ? this.at + 1 : "–"}/${this.hunks.length}` : ""))
          .child(this.button(t, "review-prev", null, cx => this.step(-1, cx), hasChanges, false, { icon: "mods/review-file/arrow-up.svg", tip: "Previous change (P or Shift+F7)" }))
          .child(this.button(t, "review-next", null, cx => this.step(1, cx), hasChanges, false, { icon: "mods/review-file/arrow-down.svg", tip: "Next change (N or F7)" }))
          .child(this.button(t, "review-compact", this.compact ? "Full file" : "Changes only", cx => this.toggleCompact(cx), hasChanges, false, { icon: this.compact ? "mods/workspace-chrome/file-text.svg" : "mods/review-file/list.svg", tip: this.compact ? "Show the whole file (C)" : "Show only the changed parts (C)" })))
        .child(this.modes(t))
        .when(!this.on, e => e.child(this.button(t, "review-code", "VS Code", cx => this.openInCode(cx), true, false, { icon: "mods/review-file/external.svg", tip: "Open this file in VS Code at this line" }))))
      .when(Boolean(this.error || this.note || this.toast), e => e.child(div().px(14).py(4).flex_none().text_size(11).border_b(1).border_color(t.border)
        .text_color(this.error || this.toast ? t.ansi1 : t.dim).child(this.error || this.toast || this.note)))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .when(explorer, e => e.child(this.explorerPane(t)))
        .child(div().flex_1().min_w(0).h_full().relative().font_family(s.font_family ?? "JetBrains Mono").text_size(size)
          .child(div().id("review-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(Math.max(300, this.longest * charWidth(size) + this.gutter(size) + 60)).h_full()
              .child(v_virtual_list("review-rows", this.view.length, rowHeight(size), (i) => String(i),
                (range) => this.view.slice(range.start, range.end).map(r => this.row(r, t, size))).track_scroll(this.scroll).size_full())))
          .child(Scrollbar.vertical("review-rows").viewport_from_layout().absolute().inset_0())
          .child(div().absolute().top(0).bottom(0).right(12).w(6).children(this.ruler(t)))
          .when(!this.view.length, e => e.child(div().absolute().top(8).px(14).text_color(t.dim)
            .child(this.loading ? "Loading…" : path ? "" : this.root ? "Pick a file in the Explorer (Files) to view it" : "")))))
      // Settings → Features → Shortcut hints.
      .when((shared("zendr.features") ?? {}).hints !== false, e => e.child(h_flex().h(24).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(10).text_color(t.dim).overflow_hidden()
        .child("N / F7: next change").child("P: previous").child("C: changes only").child("E: files").child(this.part ? "Right-click a tab to show or hide parts" : "Ctrl+Shift+Z: back to split")));
  }
}
