// The code view, like VS Code's editor: open files as tabs, each in Review (the whole file with
// its uncommitted changes marked inline: added lines green, removed lines red, next and previous
// change, an overview ruler) or Edit (the built-in editor: syntax colours, find and replace,
// undo, multiple cursors, folding; Ctrl+S saves). Ctrl+wheel zooms the code, and the status
// bar shows where the cursor is, the language (click to change it), indentation, line endings
// and the zoom. An Explorer with the changed files and the repo's tree, file-type icons in their
// own colours, quick open (Ctrl+P), go to line (Ctrl+G), and Split / Code / Terminal views.
// Props (all optional): { root, path, on, tab, mode, rev, isGit } - the repo's top folder, a file
// in it, the machine, whether this view owns its tab, "review" or "edit", a commit to show the
// file's change in. Without root it uses the focused terminal's repo.
// Opened by review-changes (the Changes panel's Open full file), the git graph, the explorer
// block and the palette's Code view. Editing needs the file on this computer.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, Editor, EditorState, Input, InputState } from "gpui-base";
import { props, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, nextCommand, run, panes, focused, spaces, shared, setShared, layout, appHome } from "herdr";
import { detect, fileIcon, folderIcon, languages, loadExtras, PLAIN } from "./lang.js";

// Reads write nothing under .git, so the folder watch doesn't wake us again.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_LINES = 200000, MAX_COLUMNS = 2000, CONTEXT = 3, MAX_TABS = 24;
const rowHeight = size => Math.ceil(size * 1.8), charWidth = size => size * 0.64;
const ICON = name => `mods/review-file/icons/${name}.svg`;
const baseName = path => String(path ?? "").split("/").pop();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Paths come from git and the explorer; refuse anything that would leave the folder.
const safePath = p => typeof p === "string" && p.length > 0 && p.length < 4096 && !/^[\\/]|^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes("..");
// Per-viewer conveniences (zoom, wrap): fine to lose.
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ } },
};
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

// ---- Review mode's small highlighter: comments, strings, numbers, keywords, calls and types. ----
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
  ...Object.fromEntries("rb sh bash zsh fish yaml yml toml r pl pm conf cfg mk nix cmake tf env gitignore dockerfile makefile ex exs".split(" ").map(e => [e, HASH])),
  py: { line: ["#"], block: [['"""', '"""', "string"], ["'''", "'''", "string"]], quotes: "\"'", multiline: "" },
  ps1: { line: ["#"], block: [["<#", "#>"]], quotes: "\"'", multiline: "" },
  psm1: { line: ["#"], block: [["<#", "#>"]], quotes: "\"'", multiline: "" },
  lua: { line: ["--"], block: [["--[[", "]]"]], quotes: "\"'", multiline: "" },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: "'\"", multiline: "" },
  hs: { line: ["--"], block: [["{-", "-}"]], quotes: "\"", multiline: "" },
  ...Object.fromEntries("html htm xml svg vue svelte xaml csproj props targets md".split(" ").map(e => [e, { line: [], block: [["<!--", "-->"]], quotes: "\"'", multiline: "" }])),
};
// The tokenizer for a detected language: its extensions first, then the grammar it borrows.
function grammar(lang) {
  for (const e of lang?.exts ?? []) if (LANGS[e]) return LANGS[e];
  return LANGS[lang?.editor] ?? null;
}
const NUMBER = /0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z0-9_]*/y, WORD = /[A-Za-z_$@][\w$]*/y, PLAIN_RUN = /[^A-Za-z_$@0-9"'`#/\-<{]+/y;

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
    PLAIN_RUN.lastIndex = i;
    const run = PLAIN_RUN.exec(line);
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

// ---- Edit mode helpers ----
// The comment a language's lines take (Ctrl+/), or [open, close] for languages with only blocks.
const COMMENT = { latex: "%", erlang: "%", ini: ";", bat: "REM", clojure: ";;", ocaml: ["(*", "*)"], css: ["/*", "*/"] };
for (const id of "javascript javascriptreact typescript typescriptreact jsonc c cpp csharp java kotlin swift scala dart go rust php zig proto less scss".split(" ")) COMMENT[id] = "//";
for (const id of "python ruby shellscript powershell yaml toml dockerfile makefile cmake r perl elixir nix terraform dotenv ignore git graphql".split(" ")) COMMENT[id] = "#";
for (const id of "sql lua haskell".split(" ")) COMMENT[id] = "--";
for (const id of "html xml svg vue svelte markdown".split(" ")) COMMENT[id] = ["<!--", "-->"];

// Tabs or spaces, and how many: from the most common step between indented lines.
function guessIndent(text) {
  let tabs = 0, spaces = 0, prev = 0, seen = 0;
  const steps = {};
  for (const line of text.split("\n")) {
    if (++seen > 3000) break;
    if (!line.trim()) continue;
    const n = line.length - line.trimStart().length;
    if (line[0] === "\t") tabs++; else if (n) spaces++;
    const d = Math.abs(n - prev);
    if (line[0] !== "\t" && d >= 2 && d <= 8) steps[d] = (steps[d] ?? 0) + 1;
    prev = n;
  }
  if (tabs > spaces) return { hard: true, size: 4 };
  const best = Object.entries(steps).sort((a, b) => b[1] - a[1])[0];
  return { hard: false, size: best ? Number(best[0]) : 2 };
}
function lineStarts(text) {
  const out = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}
function position(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}
// A loose match for quick open: every letter in order, scored for runs and the file name.
function fuzzy(query, path) {
  const q = query.toLowerCase(), p = path.toLowerCase(), slash = p.lastIndexOf("/");
  if (!q) return 1;
  const exact = p.indexOf(q);
  if (exact >= 0) return 1000 - p.length + (exact > slash ? 500 : 0);
  let i = 0, score = 0, run = 0;
  for (let j = 0; j < p.length && i < q.length; j++) {
    if (p[j] === q[i]) { i++; run++; score += run * 2 + (j > slash ? 3 : 0); } else run = 0;
  }
  return i === q.length ? score - p.length * 0.1 : -1;
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
const MARK_WORD = { A: "Added", M: "Modified", D: "Deleted", U: "Conflict" };
// Which view holds which review-file pane (the views share one VM): pane id → { token, at }.
const claims = globalThis[Symbol.for("review-file.claims")] ??= new Map();
const TREE_ROW = 26, MAX_FILES = 100000;
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

// The shortcuts sheet (F1), in groups.
const SHORTCUTS = [
  ["Files", [["Ctrl+P", "Quick open a file"], ["Ctrl+W", "Close the tab"], ["Ctrl+\\", "Split the editor"], ["Ctrl+B", "Show or hide the files"]]],
  ["Editing", [["Ctrl+S", "Save"], ["Ctrl+E", "Switch Review / Edit"], ["Ctrl+F", "Find"], ["Ctrl+H", "Replace"], ["Ctrl+/", "Comment the lines"], ["Ctrl+G", "Go to line"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Ctrl+Alt+↑ ↓", "Add a cursor"], ["Tab / Shift+Tab", "Indent / outdent"], ["Alt+Z", "Wrap long lines"]]],
  ["Reviewing", [["N or F7", "Next change"], ["P or Shift+F7", "Previous change"], ["C", "Only the changed parts"], ["E", "Show or hide the files"]]],
  ["View", [["Ctrl+wheel", "Zoom the code in or out"], ["F1", "This sheet"], ["Esc", "Close a box"]]],
];

export default class ReviewFile extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.root = p.root ?? null; this.on = p.on ?? null; this.ownsTab = Boolean(p.tab);
    // part: "explorer" or "code" is a layout block that follows the shown space, not a pane.
    this.part = p.part === "explorer" || p.part === "code" ? p.part : null;
    this.isGit = p.isGit ?? true; this.dirEntries = new Map(); this.spaceStates = new Map();
    this.initial = safePath(p.path) ? { path: p.path, mode: p.mode, rev: p.rev, line: p.line } : null;
    this.tabs = []; this.current = null; this.path = null;
    this.zoom = store.get("review-file.zoom", 0); this.wrap = store.get("review-file.wrap", false);
    this.token = Math.random().toString(36).slice(2); this.paneTab = null; this.gotoAt = shared("review-file.goto")?.at ?? 0;
    if (!this.part) this.identify();
    this.rows = []; this.view = []; this.hunks = []; this.add = 0; this.del = 0; this.longest = 0;
    this.compact = false; this.at = -1; this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.changes = []; this.marks = {}; this.markedDirs = new Set(); this.tree = null; this.treeRows = []; this.openDirs = new Set(); this.allFiles = [];
    this.start(cx);
    // VS Code's languages and colours, when mods/vscode has imported them.
    cx.spawn(async cx => {
      await loadExtras().catch(() => 0);
      const text = await readTextFile(`${appHome()}/vscode/syntax.json`).catch(() => null);
      try { const data = text && JSON.parse(text); if (data && data.enabled !== false && data.colors) this.vsSyntax = data.colors; } catch { /* ignored */ }
      for (const tab of this.tabs) if (!tab.langForced) tab.lang = detect(tab.path);
      cx.notify();
    });
    cx.timer.every(500, cx => {
      if (this.part) this.followSpace(cx);
      else {
        const known = this.paneId;
        if (this.identify()?.pane !== known) cx.notify(); // Keeps the claim; redraws once found.
      }
      const active = window()?.active !== false, refocused = active && this.active === false;
      this.active = active;
      if (active && !this.loading && (refocused || (this.dirtyAt && Date.now() >= this.dirtyAt))) { this.refresh(cx); this.loadFiles(cx, refocused); }
      // The ruler needs the list's height, known only after a layout: redraw once it changes.
      if (this.scroll.viewport_size().height !== this.rulerHeight) cx.notify();
      if (this.flashed && Date.now() > this.flashed.until) { this.flashed = null; cx.notify(); }
    });
    // The status bar's Ln/Col: the editor tells nobody when its cursor moves.
    cx.timer.every(150, cx => this.trackCursor(cx));
    // Key bindings in keys.json (and `herdr-app do review-file.<name>`): next, prev, compact,
    // explorer, split, code-only, terminal-only, code, reload, focus, save, quick-open,
    // goto-line, find, close-tab, mode, zoom-in, zoom-out, zoom-reset, split-editor, keys, wrap, comment.
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (!this.commandTarget()) continue;
        const actions = {
          next: () => this.step(1, cx), prev: () => this.step(-1, cx), compact: () => this.toggleCompact(cx),
          explorer: () => this.toggleExplorer(), split: () => this.showSplit(cx), "code-only": () => this.showCode(cx),
          "terminal-only": () => this.showTerminal(cx), code: () => this.openInCode(cx),
          reload: () => { if (!this.loading) { this.refresh(cx); this.loadFiles(cx, true); } },
          focus: () => this.focusCode(cx), save: () => this.save(cx), "quick-open": () => this.openPalette("files", cx),
          "goto-line": () => this.openPalette("line", cx), find: () => this.openPalette("find", cx),
          language: () => this.openPalette("lang", cx), "close-tab": () => this.current && this.closeTab(this.current, cx),
          mode: () => this.setMode(this.current?.mode === "edit" ? "review" : "edit", cx),
          "zoom-in": () => this.setZoom(this.zoom + 1, cx), "zoom-out": () => this.setZoom(this.zoom - 1, cx), "zoom-reset": () => this.setZoom(0, cx),
          "split-editor": () => this.splitEditor(), keys: () => { this.showKeys = !this.showKeys; }, wrap: () => this.toggleWrap(cx),
          comment: () => this.toggleComment(),
        };
        actions[command]?.();
        cx.notify();
      }
    });
  }

  // Commands go to one view: a focused code pane, else the layout's code block.
  commandTarget() {
    if (this.part === "explorer") return false;
    const f = focused();
    if (this.part) return !panes().some(p => p.mod === "review-file" && p.pane === f?.pane);
    return f?.pane === this.paneId;
  }

  // A layout block shows the shown space: its repo, else its folder. Each space keeps
  // its own open tabs and folders.
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
    if (this.spaceId) this.spaceStates.set(this.spaceId, { root: this.root, tabs: this.tabs, current: this.current, openDirs: this.openDirs, compact: this.compact });
    const saved = this.spaceStates.get(spaceId), same = saved?.root === root;
    if (saved && !same) saved.tabs.forEach(t => this.release(t));
    this.spaceId = spaceId; this.root = root; this.on = on; this.isGit = isGit;
    this.tabs = same ? saved.tabs : []; this.current = same ? saved.current : null; this.path = this.current?.path ?? null;
    this.openDirs = same ? saved.openDirs : new Set(); this.compact = same ? saved.compact : false;
    this.tree = null; this.dirEntries = new Map(); this.treeRows = []; this.changes = []; this.marks = {}; this.markedDirs = new Set(); this.allFiles = [];
    this.first = true; this.at = -1; this.note = null; this.error = null; this.toast = null; this.treeError = null; this.palette = null;
    this.autoOpen = !this.current; this.generation = (this.generation ?? 0) + 1; this.loading = false;
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
      else { this.root = cwd; this.on = on; this.isGit = false; this.begin(cx); }
      cx.notify();
    });
  }

  begin(cx) {
    if (this.part !== "explorer") {
      if (this.initial) { const i = this.initial; this.initial = null; this.openPath(i.path, cx, { mode: i.mode, rev: i.rev, line: i.line, pin: true }); }
      else if (this.current) this.activate(this.current, cx);
    }
    this.loadFiles(cx, true);
    this.watch(cx);
  }

  get explorer() { return this.part ? this.part === "explorer" : shared("review-file.explorer") ?? true; }
  // Narrow panes (a split) hide the Explorer until asked for, as VS Code's does.
  get narrow() { return (this.width ?? 1000) < 760; }
  get showExplorer() { return this.part ? false : this.narrow ? this.explorer && this.forceExplorer === true : this.explorer; }
  get mode() { return this.current?.mode ?? "review"; }
  toggleExplorer() {
    if (this.part) { run("layout.toggle", { id: "explorer" }); return; }
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
        if (tree) {
          const listed = await this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
          if (root !== this.root || listed.code !== 0) return;
          const files = [...new Set(listed.stdout.split("\0").filter(Boolean))].slice(0, MAX_FILES);
          this.limited = files.length >= MAX_FILES;
          this.allFiles = files;
          this.tree = this.buildTree(files); this.treeAt = Date.now();
          this.reveal(this.path);
        }
        this.flatten();
      } catch (e) { this.treeError = String(e?.message ?? e); }
      finally {
        this.filesLoading = false;
        // A space with changes opens its first changed file, as the Changes panel does.
        if (this.part === "code" && this.autoOpen && !this.current && this.changes.length) { this.autoOpen = false; this.openPath(this.changes[0].path, cx, { mode: "review" }); }
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

  collapseAll(cx) { this.openDirs = new Set(); this.flatten(); cx.notify(); }

  // ---- Tabs ----
  // Shows a file (the Explorer, the Changes list, the Changes panel, the git graph). A single
  // click opens a preview tab (in italics) that the next one replaces; a double click, an edit
  // or a save keeps it. opts: { mode, rev, pin, line }.
  openPath(path, cx, opts = {}) {
    if (!path) return;
    if (!safePath(path)) { this.toast = "That path is outside this folder"; cx.notify(); return; }
    if (this.part === "explorer") {
      this.path = path; this.flatten();
      setShared("review-file.goto", { target: "layout", root: this.root, on: this.on, isGit: this.isGit, path, mode: opts.mode, pin: opts.pin, at: Date.now() });
      if (findNode(layout(), "code")?.hidden) run("layout.show", { id: "code" });
      cx.notify();
      return;
    }
    const key = opts.rev ? `${opts.rev}:${path}` : path;
    let tab = this.tabs.find(t => t.key === key);
    if (!tab) {
      tab = {
        key, path, rev: opts.rev ?? null, preview: !opts.pin, lang: detect(path), langForced: false, editor: null, dirty: false,
        mode: opts.rev ? "review" : opts.mode ?? (this.isGit && this.marks[path] ? "review" : "edit"),
      };
      const preview = this.tabs.findIndex(t => t.preview && !t.dirty && t !== this.current);
      const currentPreview = this.current?.preview && !this.current.dirty ? this.tabs.indexOf(this.current) : -1;
      const replace = opts.pin ? -1 : currentPreview >= 0 ? currentPreview : preview;
      if (replace >= 0) { this.release(this.tabs[replace]); this.tabs.splice(replace, 1, tab); }
      else {
        const at = this.current ? this.tabs.indexOf(this.current) + 1 : this.tabs.length;
        this.tabs.splice(at, 0, tab);
      }
      // Too many tabs: the oldest saved ones go.
      while (this.tabs.length > MAX_TABS) {
        const old = this.tabs.find(t => !t.dirty && t !== tab);
        if (!old) break;
        this.release(old); this.tabs.splice(this.tabs.indexOf(old), 1);
      }
    } else {
      if (opts.pin) tab.preview = false;
      if (opts.mode && !tab.rev) tab.mode = opts.mode;
    }
    this.activate(tab, cx, opts.line);
  }

  activate(tab, cx, line) {
    this.current = tab; this.path = tab.path; tab.confirmClose = false;
    this.first = true; this.at = -1; this.note = null; this.error = null; this.toast = null; this.find = null;
    this.setRows([]); this.reveal(tab.path); this.flatten();
    if (this.ownsTab) run("tab.rename", { id: this.paneTab, name: baseName(tab.path) });
    // A code pane is named after its file, in the pane's header.
    if (!this.part && this.paneId) run("pane.rename", { pane: this.paneId, name: `Code · ${baseName(tab.path)}` });
    if (this.part === "code") setShared("review-file.current", { root: this.root, path: tab.path });
    this.pendingLine = line ?? null;
    this.show(tab, cx);
    cx.notify();
  }

  show(tab, cx) {
    if (tab.mode === "edit") {
      if (!tab.editor) { if (!tab.loading) this.loadEditor(tab, cx); }
      else { this.applyLine(tab); this.focusEditor(tab, cx); this.checkDisk(tab, cx); }
    } else this.load(cx);
  }

  release(tab) {
    try { tab?.editor?.release(); } catch { /* already gone */ }
    if (tab) tab.editor = null;
  }

  // Closing a tab with unsaved edits asks first: a second close discards them.
  closeTab(tab, cx) {
    if (tab.dirty && !tab.confirmClose) {
      tab.confirmClose = true;
      if (this.current !== tab) this.activate(tab, cx);
      this.toast = `${baseName(tab.path)} has unsaved changes. Save them (Ctrl+S), or close it again to discard them.`;
      cx.notify();
      return;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1); this.release(tab);
    if (this.current === tab) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)] ?? null;
      if (next) this.activate(next, cx);
      else {
        this.current = null; this.path = null; this.note = null; this.error = null; this.toast = null; this.setRows([]); this.flatten();
        if (this.part === "code") setShared("review-file.current", { root: this.root, path: null });
      }
    }
    cx.notify();
  }

  cycleTab(by, cx) {
    if (this.tabs.length < 2 || !this.current) return;
    const i = this.tabs.indexOf(this.current);
    this.activate(this.tabs[(i + by + this.tabs.length) % this.tabs.length], cx);
  }

  setMode(mode, cx) {
    const tab = this.current;
    if (!tab || tab.mode === mode) return;
    if (tab.rev && mode === "edit") { this.flash("A commit's change can only be reviewed"); return; }
    const line = tab.mode === "edit" ? tab.cursor?.line : this.currentLine();
    tab.mode = mode; this.first = true; this.pendingLine = line ?? null;
    this.show(tab, cx);
    if (mode === "review") this.handle.focus();
    cx.notify();
  }

  // ---- Review mode ----
  refresh(cx) {
    this.dirtyAt = 0;
    const tab = this.current;
    if (tab?.mode === "edit") this.checkDisk(tab, cx); else this.load(cx);
  }

  load(cx) {
    const root = this.root, path = this.path, on = this.on, isGit = this.isGit, rev = this.current?.rev ?? null;
    this.dirtyAt = 0;
    if (!root || !path || this.current?.mode === "edit") return;
    this.loading = true;
    const generation = this.generation = (this.generation ?? 0) + 1;
    cx.spawn(async cx => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        let rows = null, note = null;
        if (rev) {
          // One commit's change to the file, against its first parent.
          const r = await git(["diff-tree", "-p", "--root", "--no-commit-id", "-m", "--first-parent", "--unified=1000000", "--no-ext-diff", "--no-textconv", "--no-color", rev, "--", path]);
          if (r.code !== 0) throw new Error(r.stderr.trim() || "git diff-tree failed");
          const lines = r.stdout.replace(/\n$/, "").split("\n");
          if (lines.some(l => l.startsWith("@@"))) rows = parseDiff(lines);
          else note = r.stdout.includes("Binary files") ? "Binary file · no text view" : "That commit didn't change this file's text";
        } else {
          const hasHead = isGit && (await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
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
            const text = await readTextFile(`${root}/${path}`, { on }).catch(e => { throw new Error(/1 ?MiB|too large/i.test(String(e)) ? "This file is over 1 MB: too big to show" : String(e?.message ?? e)); });
            if (text === null) note = "This file is gone or can't be read";
            else if (text.includes("\0")) note = "Binary file · no text view";
            else {
              const lines = text.replace(/\n$/, "").split("\n").slice(0, MAX_LINES);
              rows = lines.map((line, i) => tracked || !isGit ? { kind: " ", old: i + 1, new: i + 1, text: clip(line) } : { kind: "+", new: i + 1, text: clip(line) });
              if (tracked) note = "No uncommitted changes in this file. Ctrl+E edits it.";
              if (!this.current?.langForced && this.current?.lang === PLAIN) this.current.lang = detect(path, text);
            }
          }
        }
        if (generation !== this.generation) return;
        if (this.current?.dirty) note = "Showing the saved file: you have unsaved edits (Ctrl+S saves them)";
        this.note = note; this.error = null;
        this.setRows(rows ?? []);
        if (this.first !== false) {
          this.first = false;
          const at = this.pendingLine ? this.view.findIndex(r => r.new >= this.pendingLine) : -1;
          this.pendingLine = null;
          if (at >= 0) this.scroll.scroll_to_item(at, "center");
          else if (this.hunks.length) this.jump(0); else this.scroll.scroll_to_item(0, "top");
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
    if (this.find) this.runFind();
  }

  // Colors the rows in slices, so a long file never holds up the window.
  async highlight(generation, cx) {
    const lang = grammar(this.current?.lang);
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
    const rh = rowHeight(this.fontSize()), top = Math.floor(this.scroll.offset().y / rh);
    return { top, count: Math.max(1, Math.floor(this.scroll.viewport_size().height / rh)) };
  }

  // The file's line in the middle of the view (or at the current change).
  currentLine() {
    const { top, count } = this.visibleRows(), current = this.hunks[this.at];
    const from = current && current.start >= top && current.start < top + count ? current.start : top + Math.floor(count / 2);
    for (let i = Math.min(from, this.view.length - 1); i >= 0; i--) if (this.view[i]?.new) return this.view[i].new;
    return 1;
  }

  jump(index) {
    if (!this.hunks.length) return;
    this.at = (index + this.hunks.length) % this.hunks.length;
    this.scroll.scroll_to_item(this.hunks[this.at].start, "center");
  }

  step(by, cx) {
    if (!this.hunks.length || this.mode === "edit") return;
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
    if (this.mode === "edit") return;
    const { top } = this.visibleRows(), anchor = this.view[top];
    this.compact = !this.compact; this.layoutRows();
    const index = anchor ? this.view.indexOf(anchor) : -1;
    if (index >= 0) this.scroll.scroll_to_item(index, "top");
    else if (this.hunks.length) this.jump(Math.max(0, this.at));
    cx.notify();
  }

  // Find in Review mode: the rows holding the words; Enter goes through them.
  runFind() {
    const q = (this.find?.query ?? "").toLowerCase();
    const hits = [];
    if (q) this.view.forEach((r, i) => { if (r.kind !== "…" && r.text.toLowerCase().includes(q)) hits.push(i); });
    this.find.hits = hits; this.find.set = new Set(hits);
    this.find.at = Math.min(this.find.at ?? 0, Math.max(0, hits.length - 1));
  }
  findStep(by) {
    const f = this.find;
    if (!f?.hits?.length) return;
    f.at = (f.at + by + f.hits.length) % f.hits.length;
    this.scroll.scroll_to_item(f.hits[f.at], "center");
  }

  // ---- Edit mode ----
  loadEditor(tab, cx) {
    const root = this.root, on = this.on;
    tab.loading = true; tab.note = null;
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(`${root}/${tab.path}`, { on });
        if (raw === null) { tab.note = "This file is gone or can't be read"; return; }
        if (raw.includes("\0")) { tab.note = "Binary file · it can't be edited here"; return; }
        if (!this.tabs.includes(tab) || root !== this.root) return;
        this.makeEditor(tab, raw);
        if (this.current === tab) { this.applyLine(tab); this.focusEditor(tab, cx); }
      } catch (e) {
        const text = String(e?.message ?? e);
        tab.note = /1 ?MiB|too large|limit/i.test(text) ? "This file is over 1 MB: too big to edit here" : text;
      } finally { tab.loading = false; cx.notify(); }
    });
  }

  makeEditor(tab, raw) {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n", text = eol === "\r\n" ? raw.replace(/\r\n/g, "\n") : raw;
    if (!tab.langForced) tab.lang = detect(tab.path, text);
    tab.indent = guessIndent(text); tab.eol = eol; tab.raw = raw; tab.saved = text; tab.dirty = false; tab.lines = null; tab.sel = null;
    // writeTextFile writes on this computer only, so another machine's files are read-only.
    tab.readonly = Boolean(this.on);
    const s = settings();
    tab.editor = EditorState.new({
      language: tab.lang.editor || "txt", value: text, font_family: s.font_family ?? "JetBrains Mono", font_size: this.fontSize(),
      line_numbers: true, folding: true, readonly: tab.readonly, soft_wrap: this.wrap, tab_size: tab.indent.size, hard_tabs: tab.indent.hard,
      syntax: this.syntax(theme()),
    });
    tab.editor.on("change", (_e, cx) => {
      if (this.quiet) return;
      tab.lines = null;
      const dirty = tab.editor.value() !== tab.saved;
      if (dirty) tab.preview = false;
      if (dirty !== tab.dirty) { tab.dirty = dirty; tab.confirmClose = false; cx.notify(); }
    });
  }

  focusEditor(tab, cx) {
    if (!tab?.editor) return;
    tab.editor.focus();
    cx.spawn(async cx => { await cx.sleep(40); if (this.current === tab && tab.editor && !this.palette) tab.editor.focus(); });
  }
  focusCode(cx) { if (this.mode === "edit") this.focusEditor(this.current, cx); else this.handle.focus(); }

  applyLine(tab) {
    const line = this.pendingLine;
    this.pendingLine = null;
    if (!line || !tab.editor) return;
    const starts = tab.lines ??= lineStarts(tab.editor.value());
    const off = starts[clamp(line, 1, starts.length) - 1];
    tab.editor.set_selected_range({ start: off, end: off });
  }

  trackCursor(cx) {
    const tab = this.current;
    if (!tab?.editor || tab.mode !== "edit") return;
    const r = tab.editor.selected_range();
    if (tab.sel && r.start === tab.sel.start && r.end === tab.sel.end && tab.lines) return;
    tab.sel = r;
    tab.lines ??= lineStarts(tab.editor.value());
    tab.cursor = position(tab.lines, r.end); tab.selected = Math.abs(r.end - r.start);
    cx.notify();
  }

  // The file changed on disk: take it in when there's nothing unsaved, else ask.
  checkDisk(tab, cx) {
    if (!tab?.editor || tab.rev || tab.checking) return;
    const root = this.root, on = this.on;
    tab.checking = true;
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(`${root}/${tab.path}`, { on }).catch(() => undefined);
        if (raw === undefined || raw === tab.raw || !tab.editor) return;
        if (raw === null) { tab.conflict = "gone"; return; }
        if (tab.dirty) { tab.conflict = "disk"; return; }
        this.takeDisk(tab, raw);
      } finally { tab.checking = false; cx.notify(); }
    });
  }

  takeDisk(tab, raw) {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n", text = eol === "\r\n" ? raw.replace(/\r\n/g, "\n") : raw;
    const r = tab.editor.selected_range();
    this.quiet = true;
    try { tab.editor.set_value(text); } finally { this.quiet = false; }
    tab.editor.set_selected_range({ start: Math.min(r.start, text.length), end: Math.min(r.end, text.length) });
    tab.raw = raw; tab.saved = text; tab.eol = eol; tab.dirty = false; tab.conflict = null; tab.lines = null; tab.sel = null;
  }

  reloadFromDisk(tab, cx) {
    const root = this.root, on = this.on;
    cx.spawn(async cx => {
      const raw = await readTextFile(`${root}/${tab.path}`, { on }).catch(() => null);
      if (raw !== null && tab.editor) this.takeDisk(tab, raw);
      cx.notify();
    });
  }

  // Keep my version: the next save replaces what's on disk now.
  keepMine(tab, cx) {
    const root = this.root, on = this.on;
    cx.spawn(async cx => {
      const raw = await readTextFile(`${root}/${tab.path}`, { on }).catch(() => null);
      tab.raw = raw; tab.conflict = null; tab.dirty = true;
      cx.notify();
    });
  }

  // Ctrl+S: writes only if the file is still what was read, so nothing on disk is lost unseen.
  save(cx) {
    const tab = this.current;
    if (!tab?.editor) { if (tab && tab.mode !== "edit") this.flash("Switch to Edit (Ctrl+E) to change this file"); return; }
    if (tab.readonly) { this.flash("Files on another machine are read-only here"); return; }
    const value = tab.editor.value(), out = tab.eol === "\r\n" ? value.replace(/\r?\n/g, "\r\n") : value;
    const root = this.root, name = baseName(tab.path);
    cx.spawn(async cx => {
      try {
        await writeTextFile(`${root}/${tab.path}`, out, tab.raw ?? null);
        tab.raw = out; tab.saved = value; tab.dirty = tab.editor ? tab.editor.value() !== value : false;
        tab.conflict = null; tab.preview = false; tab.confirmClose = false; this.toast = null;
        this.flash(`Saved ${name}`);
        this.dirtyAt = Date.now() + 300;
      } catch (e) {
        tab.conflict = "save";
        this.toast = `${name} changed on disk since it was opened, so it wasn't saved. ${String(e?.message ?? e)}`.slice(0, 300);
      }
      cx.notify();
    });
  }

  // Ctrl+/: comments the selected lines out, or back in when they all are.
  toggleComment() {
    const tab = this.current, ed = tab?.editor;
    if (!ed || tab.readonly || tab.mode !== "edit") return;
    const c = COMMENT[tab.lang?.id];
    if (!c) { this.flash(`${tab.lang?.name ?? "This file"} has no comments`); return; }
    const text = ed.value(), r = ed.selected_range();
    const from = Math.min(r.start, r.end), to = Math.max(r.start, r.end);
    const a = text.lastIndexOf("\n", from - 1) + 1;
    const end = to > from && text[to - 1] === "\n" ? to - 1 : to;
    let b = text.indexOf("\n", end); if (b < 0) b = text.length;
    const block = text.slice(a, b), lines = block.split("\n");
    let out;
    if (Array.isArray(c)) {
      const [open, close] = c, inner = block.trim();
      if (inner.startsWith(open) && inner.endsWith(close)) {
        const lead = block.slice(0, block.indexOf(open)), body = inner.slice(open.length, inner.length - close.length);
        out = lead + body.replace(/^ /, "").replace(/ $/, "");
      } else {
        const lead = block.slice(0, block.length - block.trimStart().length);
        out = lead + open + " " + block.trimStart() + " " + close;
      }
    } else {
      const body = lines.filter(l => l.trim());
      const done = body.length > 0 && body.every(l => l.trimStart().startsWith(c));
      const indent = Math.min(...body.map(l => l.length - l.trimStart().length));
      const esc = c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      out = lines.map(l => !l.trim() ? l : done ? l.replace(new RegExp(`^(\\s*)${esc} ?`), "$1") : l.slice(0, indent) + c + " " + l.slice(indent)).join("\n");
    }
    ed.set_selected_range({ start: a, end: b });
    ed.replace(out);
    ed.set_selected_range({ start: a, end: a + out.length });
  }

  toggleWrap(cx) {
    this.wrap = !this.wrap; store.set("review-file.wrap", this.wrap);
    for (const tab of this.tabs) tab.editor?.set_soft_wrap(this.wrap);
    this.flash(this.wrap ? "Long lines wrap" : "Long lines scroll sideways");
    cx.notify();
  }

  // Indentation: 2 spaces → 4 → 8 → tabs → 2 spaces.
  cycleIndent(cx) {
    const tab = this.current;
    if (!tab?.editor) return;
    const order = [[false, 2], [false, 4], [false, 8], [true, 4]];
    const i = order.findIndex(([h, s]) => h === tab.indent.hard && (h || s === tab.indent.size));
    const [hard, size] = order[(i + 1) % order.length];
    tab.indent = { hard, size }; tab.editor.set_tab_size(size, hard);
    cx.notify();
  }

  // Line endings: switching marks the file changed, and Ctrl+S writes them.
  toggleEol(cx) {
    const tab = this.current;
    if (!tab?.editor || tab.readonly) return;
    tab.eol = tab.eol === "\r\n" ? "\n" : "\r\n"; tab.dirty = true; tab.preview = false; tab.saved = null;
    cx.notify();
  }

  setLanguage(lang, cx) {
    const tab = this.current;
    if (!tab || !lang) return;
    tab.lang = lang; tab.langForced = true;
    tab.editor?.set_language(lang.editor || "txt");
    if (tab.mode === "review") { this.rows.forEach(r => { r.tokens = null; }); this.highlight(this.generation, cx); }
    cx.notify();
  }

  // ---- Zoom: Ctrl+wheel over the code, or the status bar's − and +. ----
  fontSize() { return clamp(Math.round((settings().font_size || 13) + this.zoom), 7, 40); }
  setZoom(zoom, cx) {
    const base = settings().font_size || 13;
    this.zoom = clamp(Math.round(zoom), 7 - base, 40 - base);
    store.set("review-file.zoom", this.zoom);
    cx.notify();
  }
  wheel(e, cx) {
    if (!e.modifiers?.control && !e.modifiers?.platform) return;
    let steps = 0;
    const lines = e.delta_lines?.y;
    if (lines) steps = Math.sign(lines);
    else {
      this.wheelSum = (this.wheelSum ?? 0) + (e.delta?.y ?? 0);
      while (Math.abs(this.wheelSum) >= 24) { const s = Math.sign(this.wheelSum); steps += s; this.wheelSum -= s * 24; }
    }
    if (steps) {
      const anchor = this.mode === "review" ? this.visibleRows().top : -1;
      this.setZoom(this.zoom + steps, cx);
      if (anchor >= 0) this.scroll.scroll_to_item(anchor, "top");
    }
    try { cx.stop_propagation(); } catch { /* not every handler can */ }
  }

  flash(text) { this.flashed = { text, until: Date.now() + 3500 }; }

  // ---- Boxes over the code: quick open, go to line, find, language. ----
  openPalette(kind, cx) {
    if (this.part === "explorer") return;
    if (kind === "find" && this.mode === "edit") { this.focusEditor(this.current, cx); this.flash("Press Ctrl+F again to search in the editor"); return; }
    if ((kind === "line" || kind === "find" || kind === "lang") && !this.current) return;
    this.palette?.input?.release();
    const placeholder = { files: "Search files by name", line: `Go to line (1 to ${this.lineCount()}), or line:column`, find: "Find in this file", lang: "Pick the language" }[kind];
    const input = InputState.new({ placeholder, value: kind === "find" ? this.find?.query ?? "" : "" });
    this.palette = { kind, input, at: 0, items: [] };
    if (kind === "find") this.find ??= { query: "", at: 0, hits: [], set: new Set() };
    input.on("change", (_e, cx) => {
      if (!this.palette || this.palette.input !== input) return;
      this.palette.at = 0;
      if (kind === "find") { this.find.query = input.value(); this.find.at = 0; this.runFind(); this.findStep(0); }
      this.fillPalette(); cx.notify();
    });
    this.fillPalette();
    input.focus();
    cx.spawn(async cx => { await cx.sleep(40); if (this.palette?.input === input) input.focus(); });
    cx.notify();
  }

  lineCount() {
    const tab = this.current;
    if (tab?.editor) return (tab.lines ??= lineStarts(tab.editor.value())).length;
    return this.rows.reduce((n, r) => Math.max(n, r.new ?? 0), 0) || 1;
  }

  fillPalette() {
    const p = this.palette;
    if (!p) return;
    const q = p.input.value().trim();
    if (p.kind === "files") {
      const files = this.isGit ? this.allFiles : this.treeRows.filter(r => !r.dir).map(r => r.path);
      const open = this.tabs.map(t => t.path);
      if (!q) p.items = [...new Set([...open, ...this.changes.map(c => c.path), ...files])].slice(0, 12).map(path => ({ path }));
      else {
        const scored = [];
        for (const path of files) { const s = fuzzy(q, path); if (s > 0) scored.push([s + (open.includes(path) ? 50 : 0), path]); }
        p.items = scored.sort((a, b) => b[0] - a[0]).slice(0, 12).map(([, path]) => ({ path }));
      }
    } else if (p.kind === "lang") {
      const ql = q.toLowerCase();
      p.items = languages().filter(l => !ql || l.name.toLowerCase().includes(ql) || l.id.includes(ql) || l.exts.includes(ql)).slice(0, 12).map(lang => ({ lang }));
    } else p.items = [];
    p.at = clamp(p.at, 0, Math.max(0, p.items.length - 1));
  }

  closePalette(cx) {
    this.palette?.input?.release();
    this.palette = null;
    this.focusCode(cx);
    cx.notify();
  }

  choosePalette(back, cx) {
    const p = this.palette;
    if (!p) return;
    if (p.kind === "find") { this.findStep(back ? -1 : 1); cx.notify(); return; }
    if (p.kind === "line") {
      const m = /^(\d+)(?::(\d+))?$/.exec(p.input.value().trim());
      this.closePalette(cx);
      if (m) this.goToLine(Number(m[1]), Number(m[2] ?? 1), cx);
      return;
    }
    const item = p.items[p.at];
    this.closePalette(cx);
    if (!item) return;
    if (p.kind === "files") this.openPath(item.path, cx, { pin: true });
    else if (p.kind === "lang") this.setLanguage(item.lang, cx);
  }

  goToLine(line, col, cx) {
    const tab = this.current;
    if (tab?.editor && tab.mode === "edit") {
      const starts = tab.lines ??= lineStarts(tab.editor.value());
      const at = clamp(line, 1, starts.length) - 1, end = at + 1 < starts.length ? starts[at + 1] - 1 : tab.editor.value().length;
      const off = Math.min(starts[at] + Math.max(0, col - 1), end);
      tab.editor.set_selected_range({ start: off, end: off });
      this.focusEditor(tab, cx);
    } else {
      const index = this.view.findIndex(r => r.new >= line);
      if (index >= 0) this.scroll.scroll_to_item(index, "center");
    }
    cx.notify();
  }

  // ---- More code views: another editor beside the terminal, showing this file. ----
  splitEditor() {
    if (!this.root) return;
    const p = { root: this.root, on: this.on, isGit: this.isGit, path: this.path ?? undefined, mode: this.current?.mode, rev: this.current?.rev ?? undefined };
    if (this.part) { run("layout.show", { id: "main" }); run("pane.split", { direction: "right", mod: "review-file", props: p }); }
    else run("pane.split", { direction: "right", pane: this.paneId, mod: "review-file", props: p });
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
    this.paneId = mine.pane; this.paneTab = mine.tab;
    claims.set(mine.pane, { token: this.token, at: now });
    return mine;
  }

  panesHere() {
    const mine = this.identify();
    if (!mine) return null;
    const same = panes().filter(p => p.tab === mine.tab);
    return { mine, same, zoomed: same.find(p => p.zoomed) ?? null, terminal: same.find(p => p.terminal) ?? null };
  }

  viewMode() {
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

  // Opens VS Code at this line, through a vscode:// link the system hands to VS Code: no
  // shell ever reads the file's name, so names like "a&b.txt" can't run anything.
  openInCode(cx) {
    if (!this.root) return;
    const tab = this.current, line = tab?.mode === "edit" ? tab.cursor?.line ?? 1 : this.currentLine();
    const file = (this.path ? `${this.root}/${this.path}` : this.root).replace(/\\/g, "/");
    const url = "vscode://file" + (file.startsWith("/") ? "" : "/") + encodeURI(file).replace(/[#?]/g, c => encodeURIComponent(c)) + (this.path ? `:${line}` : "");
    const platform = window()?.platform;
    const [cmd, args] = platform === "windows" ? ["explorer.exe", [url]] : platform === "macos" ? ["open", [url]] : ["xdg-open", [url]];
    cx.spawn(async cx => {
      try {
        const r = await exec(cmd, args, { timeout: 15000 });
        // explorer.exe reports 1 even when it opened the link.
        this.toast = platform === "windows" || r.code === 0 ? null : (r.stderr.trim() || `${cmd} exited with ${r.code}`);
      } catch (e) { this.toast = `Can't open VS Code: ${e?.message ?? e}`; }
      cx.notify();
    });
  }

  // ---- Drawing ----
  // The editor's colours: VS Code's (mods/vscode), else the terminal theme's.
  syntax(t) {
    const base = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 };
    const out = { ...base, ...(this.vsSyntax ?? {}) };
    for (const k of Object.keys(out)) if (typeof out[k] !== "string" || !/^#[0-9a-f]{3,8}$/i.test(out[k])) delete out[k];
    return out;
  }

  gutter(size) { return Math.ceil(this.gutterChars * charWidth(size)) + 8; }

  row(r, t, size, index, colors) {
    const rh = rowHeight(size);
    if (r.kind === "…") return div().w_full().h(rh).flex_none().px(12).flex().items_center().bg(t.raised).text_color(t.dim).text_size(Math.max(10, size - 1)).child(`⋯ ${r.text}`);
    const added = r.kind === "+", removed = r.kind === "-", tint = added ? t.ansi2 : removed ? t.ansi1 : null;
    const hit = this.find?.set?.has(index), here = hit && this.find.hits[this.find.at] === index;
    const code = r.tokens
      ? h_flex().flex_1().min_w(0).whitespace_nowrap().children(r.tokens.map(tok => div().flex_none().text_color(colors[tok.kind] ?? t.foreground).child(tok.text)))
      : div().flex_1().min_w(0).whitespace_nowrap().child(r.text || " ");
    return h_flex().w_full().h(rh).flex_none().when(Boolean(tint), e => e.bg(tint + "1c"))
      .when(Boolean(hit), e => e.bg(t.ansi3 + (here ? "55" : "26")))
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
    const total = Math.max(this.view.length, height / rowHeight(this.fontSize()));
    return this.hunks.map((h, i) => {
      const color = h.kinds.size > 1 ? t.blocked : h.kinds.has("+") ? t.ansi2 : t.ansi1;
      return div().id(`ruler-${i}`).absolute().right(0).w(6).rounded(1).cursor_pointer().bg(color)
        .top(Math.floor(h.start / total * height)).h(Math.max(3, Math.round(h.length / total * height)))
        .on_click((_e, cx) => { this.jump(i); cx.notify(); });
    });
  }

  // A button: an icon and/or words, and a tooltip saying what it does.
  button(t, id, label, action, enabled = true, active = false, { icon, tip, accent } = {}) {
    return div().id(id).h(28).px(label ? 10 : 7).gap(6).flex().flex_none().items_center().rounded(7).border_1().text_size(11.5)
      .border_color(active ? t.accent : accent ? t.accent : t.border)
      .when(active, e => e.bg(t.selected)).when(Boolean(accent) && enabled, e => e.bg(t.accent).text_color(t.accent_foreground ?? t.background))
      .when(Boolean(tip), e => e.tooltip(tip))
      .when(!accent || !enabled, e => e.text_color(enabled ? t.foreground : t.dim))
      .when(enabled, e => e.cursor_pointer().hover(s => s.bg(accent ? t.accent : t.hover).opacity(accent ? 0.9 : 1)).on_click((_e, cx) => action(cx)))
      .when(Boolean(icon), e => e.child(svg(icon).size(14))).when(Boolean(label), e => e.child(label));
  }

  // A segmented control: [[id, label, icon, tip, on, action, enabled]].
  segments(t, items) {
    const out = h_flex().h(28).flex_none().rounded(7).overflow_hidden().border_1().border_color(t.border).text_size(11.5).text_color(t.muted);
    items.forEach(([id, label, icon, tip, on, action, enabled = true], i) => {
      if (i) out.child(div().w(1).h_full().bg(t.border));
      out.child(div().id(id).h_full().px(10).gap(6).flex().items_center().tooltip(tip)
        .when(on, e => e.bg(t.selected).text_color(t.foreground))
        .when(enabled, e => e.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => action(cx)))
        .when(!enabled, e => e.opacity(0.45))
        .child(svg(icon).size(13)).when(!this.narrow, e => e.child(label)));
    });
    return out;
  }

  // One of Split / Code / Terminal.
  modes(t) {
    const mode = this.viewMode();
    return this.segments(t, [
      ["mode-split", "Split", "mods/workspace-chrome/panel-right.svg", "Code beside the terminal", mode === "split", cx => this.showSplit(cx)],
      ["mode-code", "Code", "mods/workspace-chrome/file-text.svg", "Only the code", mode === "code", cx => this.showCode(cx)],
      ["mode-terminal", "Terminal", "mods/workspace-chrome/terminal.svg", "Only the terminal", mode === "terminal", cx => this.showTerminal(cx)],
    ]);
  }

  // A file's icon; a file whose name says nothing takes its detected language's.
  fileGlyph(path, size = 14, lang = null) {
    let f = fileIcon(path);
    if (lang && lang !== PLAIN && f.icon.endsWith("/file.svg")) f = { icon: lang.icon, color: lang.color };
    return svg(f.icon).size(size).flex_none().text_color(f.color);
  }

  explorerPane(t, full = false) {
    const name = this.root ? this.root.split(/[\\/]/).pop() : "";
    const dirty = new Set(this.tabs.filter(x => x.dirty).map(x => x.path));
    const fileRow = (id, path, label, depth, mark, dim, mode) => h_flex().id(id).w_full().h(TREE_ROW).flex_none().pl(10 + depth * 14).pr(10).gap(7).items_center().cursor_pointer().rounded(6)
      .when(path === this.path, e => e.bg(t.selected)).hover(s => s.bg(t.hover))
      .tooltip(`${path}${mark ? ` · ${MARK_WORD[mark]}` : ""}. Click to preview, double-click to keep it open.`)
      .on_click((e, cx) => this.openPath(path, cx, { mode, pin: e.click_count >= 2 }))
      .child(this.fileGlyph(path))
      .child(h_flex().flex_1().min_w(0).child(div().truncate().text_color(mark ? t[MARK[mark]] : t.foreground).child(label))
        .when(Boolean(dim), e => e.child(div().pl(6).truncate().text_size(10.5).text_color(t.dim).child(dim))))
      .when(dirty.has(path), e => e.child(div().size(7).flex_none().rounded(4).bg(t.foreground).tooltip("Unsaved changes")))
      .when(Boolean(mark), e => e.child(div().flex_none().w(14).text_center().text_size(10.5).font_semibold().text_color(t[MARK[mark]]).child(mark)));
    const treeRow = (r) => r.dir
      ? h_flex().id(`dir-${r.path}`).w_full().h(TREE_ROW).flex_none().pl(10 + r.depth * 14).pr(10).gap(6).items_center().cursor_pointer().rounded(6).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleDir(r.path, cx))
          .child(svg(`mods/files/chevron-${r.open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
          .child(svg(folderIcon(r.open)).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(r.name))
          .when(this.markedDirs.has(r.path), e => e.child(div().w(6).h(6).flex_none().rounded(3).bg(t.blocked).tooltip("Has changes")))
      : fileRow(`file-${r.path}`, r.path, r.name, r.depth, this.marks[r.path], null, "edit");
    const section = (label, extra) => h_flex().h(28).flex_none().px(12).gap(6).items_center().text_size(10.5).font_semibold().text_color(t.muted)
      .child(div().flex_1().truncate().child(label)).when(Boolean(extra), e => e.child(extra));
    const tool = (id, icon, tip, action) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => action(cx)).child(svg(icon).size(13));
    // overflow_y_scrollbar() wraps its element, so both lists sit absolutely in a sized box.
    const shown = this.changes.slice(0, 500);
    return v_flex().when(full, e => e.size_full()).when(!full, e => e.w(270).flex_none().h_full().border_r(1).border_color(t.border))
      .min_h(0).bg(t.chrome ?? t.background).text_size(12.5)
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("files")).size(14).text_color(t.muted))
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("EXPLORER"))
        .child(tool("rf-quick-open", ICON("search"), "Quick open a file (Ctrl+P)", cx => this.part === "explorer" ? setShared("review-file.ask", { what: "quick-open", at: Date.now() }) : this.openPalette("files", cx)))
        .child(tool("rf-collapse", "mods/files/chevron-right.svg", "Close every folder", cx => this.collapseAll(cx)))
        .child(tool("rf-refresh", ICON("goto"), "Reload the files", cx => this.loadFiles(cx, true))))
      .when(this.isGit, e => e.child(section(`CHANGES`, div().px(6).h(16).rounded(8).flex().items_center().bg(this.changes.length ? t.blocked + "26" : t.raised)
          .text_color(this.changes.length ? t.blocked : t.dim).child(String(this.changes.length))))
        .child(div().flex_none().h(Math.min(220, Math.max(1, shown.length) * TREE_ROW) + 4).relative()
          .child(v_flex().id("review-changes-list").absolute().inset_0().px(4).overflow_y_scroll()
            .children(shown.map(c => {
              const slash = c.path.lastIndexOf("/");
              return fileRow(`change-${c.path}`, c.path, c.path.slice(slash + 1), 0, c.status, slash > 0 ? c.path.slice(0, slash) : "", "review");
            }))
            .when(!shown.length, e => e.child(div().px(10).py(5).text_size(11.5).text_color(t.dim).child("No uncommitted changes")))))
        .child(div().h(1).mx(12).mt(6).flex_none().bg(t.border)))
      .child(section(name.toUpperCase(), null))
      .child(div().flex_1().min_h(0).relative()
        // A plain list like the Files panel's: open folders only, at most 5,000 rows.
        .child(v_flex().id("review-tree").absolute().inset_0().px(4).overflow_y_scroll().pb(8).children(this.treeRows.slice(0, 5000).map(treeRow))
          .when(this.treeRows.length > 5000, e => e.child(div().px(12).py(4).text_size(10).text_color(t.dim).child("Showing the first 5,000 rows: close some folders"))))
        .child(Scrollbar.vertical("review-tree").absolute().inset_0())
        .when(!this.treeRows.length, e => e.child(div().absolute().top(4).px(12).text_size(11.5).text_color(t.dim).child(this.treeError || (this.filesLoading ? "Loading files…" : "No files")))))
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

  // The open files, VS Code style: icon, name (italic while a preview), a dot while unsaved.
  tabStrip(t) {
    const item = (tab) => {
      const on = tab === this.current, name = baseName(tab.path);
      const close = div().id(`rf-close-${tab.key}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(on ? t.muted : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tab.dirty ? "Unsaved changes: close (Ctrl+W)" : "Close (Ctrl+W)")
        .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(tab, cx); })
        .child(tab.dirty ? div().size(8).rounded(4).bg(on ? t.foreground : t.muted) : svg(ICON("close")).size(11));
      return h_flex().id(`rf-tab-${tab.key}`).h_full().pl(12).pr(6).gap(7).flex_none().items_center().cursor_pointer().relative()
        .bg(on ? t.background : t.chrome ?? t.background).text_color(on ? t.foreground : t.muted)
        .border_r(1).border_color(t.border).hover(s => s.text_color(t.foreground))
        .tooltip(`${tab.path}${tab.rev ? ` at ${tab.rev.slice(0, 8)}` : ""}${tab.preview ? " · preview (double-click to keep)" : ""}`)
        .on_click((e, cx) => { if (e.click_count >= 2) tab.preview = false; if (tab !== this.current) this.activate(tab, cx); cx.notify(); })
        .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); this.closeTab(tab, cx); })
        .when(on, e => e.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
        .child(this.fileGlyph(tab.path, 14, tab.lang))
        .child(div().max_w(180).truncate().text_size(12.5).when(tab.preview, e => e.italic()).child(name))
        .when(Boolean(tab.rev), e => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`@${tab.rev.slice(0, 7)}`)))
        .when(tab.mode === "review" && !tab.rev && Boolean(this.marks[tab.path]), e => e.child(div().flex_none().text_size(10.5).font_semibold().text_color(t[MARK[this.marks[tab.path]]]).child(this.marks[tab.path])))
        .child(close);
    };
    const action = (id, icon, tip, fn) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => fn(cx)).child(svg(icon).size(14));
    return h_flex().w_full().min_w(0).h(36).flex_none().items_stretch().bg(t.chrome ?? t.background).border_b(1).border_color(t.border)
      .child(h_flex().id("rf-tabs").flex_1().min_w(0).h_full().items_stretch().overflow_x_scrollbar().children(this.tabs.map(item))
        .when(!this.tabs.length, e => e.child(h_flex().px(14).items_center().text_size(12).text_color(t.dim).child("No open files"))))
      .child(h_flex().flex_none().px(6).gap(2).items_center().border_l(1).border_color(t.border)
        .child(action("rf-open", ICON("search"), "Quick open a file (Ctrl+P)", cx => this.openPalette("files", cx)))
        .child(action("rf-split", ICON("split"), "Split the editor: this file in another code view (Ctrl+\\)", () => this.splitEditor()))
        .child(action("rf-keys", ICON("keyboard"), "Keyboard shortcuts (F1)", cx => { this.showKeys = !this.showKeys; cx.notify(); })));
  }

  // The file's path, its state, Review / Edit, and what each mode can do.
  toolbar(t) {
    const tab = this.current, path = this.path, mode = this.mode;
    const parts = (path ?? "").split("/"), name = parts.pop(), status = path && !tab?.rev ? this.marks[path] ?? "" : "";
    const hasChanges = this.hunks.length > 0;
    return h_flex().w_full().min_w(0).min_h(44).flex_none().flex_wrap().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(this.part
        ? this.button(t, "review-explorer", this.narrow ? null : "Files", () => run("layout.toggle", { id: "explorer" }), true, !findNode(layout(), "explorer")?.hidden, { icon: "mods/workspace-chrome/panel-left.svg", tip: "Show or hide the file explorer (Ctrl+B)" })
        : this.button(t, "review-explorer", this.narrow ? null : "Files", cx => { this.toggleExplorer(); cx.notify(); }, true, this.showExplorer, { icon: "mods/workspace-chrome/panel-left.svg", tip: "Show or hide the file explorer (Ctrl+B)" }))
      // Breadcrumbs: the folders dim, the file bold, then its state.
      .child(h_flex().flex_1().min_w(140).gap(6).items_center().overflow_hidden()
        .when(Boolean(path), e => e.child(this.fileGlyph(path, 15, tab?.lang)))
        .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join(" / ") + " / " : ""))
        .child(div().font_semibold().flex_none().child(name || "Open a file"))
        .when(Boolean(status), e => e.child(div().flex_none().px(6).h(18).rounded(5).flex().items_center().text_size(10.5).font_semibold()
          .bg(t[MARK[status]] + "22").text_color(t[MARK[status]]).child(MARK_WORD[status])))
        .when(Boolean(tab?.dirty), e => e.child(div().flex_none().px(6).h(18).rounded(5).flex().items_center().text_size(10.5).font_semibold().bg(t.raised).text_color(t.foreground).child("Unsaved")))
        .when(Boolean(tab?.readonly), e => e.child(div().flex_none().px(6).h(18).rounded(5).flex().items_center().text_size(10.5).bg(t.raised).text_color(t.dim).child("Read-only"))))
      .when(Boolean(tab), e => e.child(this.segments(t, [
        ["rf-mode-review", "Review", ICON("diff"), "See the changes inline (Ctrl+E)", mode === "review", cx => this.setMode("review", cx)],
        ["rf-mode-edit", "Edit", ICON("pencil"), tab?.rev ? "A commit's change can only be reviewed" : "Edit the file (Ctrl+E)", mode === "edit", cx => this.setMode("edit", cx), !tab?.rev],
      ])))
      .when(Boolean(tab) && mode === "review", e => e
        .child(h_flex().flex_none().gap(6).items_center().text_size(11.5)
          .child(div().text_color(t.ansi2).child(`+${this.add}`)).child(div().text_color(t.ansi1).child(`−${this.del}`)))
        .child(this.button(t, "review-prev", null, cx => this.step(-1, cx), hasChanges, false, { icon: "mods/review-file/arrow-up.svg", tip: "Previous change (P or Shift+F7)" }))
        .child(this.button(t, "review-next", null, cx => this.step(1, cx), hasChanges, false, { icon: "mods/review-file/arrow-down.svg", tip: "Next change (N or F7)" }))
        .child(this.button(t, "review-compact", this.narrow ? null : this.compact ? "Full file" : "Changes only", cx => this.toggleCompact(cx), hasChanges, false, { icon: this.compact ? "mods/workspace-chrome/file-text.svg" : "mods/review-file/list.svg", tip: this.compact ? "Show the whole file (C)" : "Show only the changed parts (C)" })))
      .when(Boolean(tab) && mode === "edit" && !tab?.readonly, e => e
        .child(this.button(t, "rf-save", this.narrow ? null : "Save", cx => this.save(cx), Boolean(tab?.dirty), false, { icon: ICON("save"), tip: "Save (Ctrl+S)", accent: Boolean(tab?.dirty) })))
      .child(div().w(1).h(20).flex_none().bg(t.border))
      .child(this.modes(t))
      .when(!this.on, e => e.child(this.button(t, "review-code", null, cx => this.openInCode(cx), Boolean(this.root), false, { icon: "mods/review-file/external.svg", tip: "Open in VS Code at this line" })));
  }

  // The banner under the toolbar: a conflict to resolve, an error, a note or a passing message.
  banner(t) {
    const tab = this.current, conflict = tab?.conflict;
    const link = (id, label, action) => div().id(id).px(8).h(22).flex().items_center().rounded(5).border_1().border_color(t.border).text_color(t.foreground)
      .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => { action(cx); cx.notify(); }).child(label);
    const bar = (color, text) => h_flex().px(14).py(6).gap(10).flex_none().items_center().text_size(11.5).border_b(1).border_color(t.border).bg(color + "14")
      .child(div().w(3).h(16).flex_none().rounded(2).bg(color)).child(div().flex_1().min_w(0).text_color(t.foreground).child(text));
    if (conflict === "disk") return bar(t.blocked, `${baseName(tab.path)} changed on disk while you were editing it.`)
      .child(link("rf-take-disk", "Load theirs", cx => this.reloadFromDisk(tab, cx))).child(link("rf-keep-mine", "Keep mine", cx => this.keepMine(tab, cx)));
    if (conflict === "save") return bar(t.ansi1, this.toast ?? "This file changed on disk, so it wasn't saved.")
      .child(link("rf-overwrite", "Overwrite it", cx => { this.keepMine(tab, cx); cx.spawn(async cx => { await cx.sleep(150); this.save(cx); }); }))
      .child(link("rf-take-disk", "Load theirs", cx => this.reloadFromDisk(tab, cx)));
    if (conflict === "gone") return bar(t.ansi1, `${baseName(tab.path)} was deleted or moved. Saving writes it again.`)
      .child(link("rf-gone-ok", "OK", () => { tab.conflict = null; tab.raw = null; tab.dirty = true; }));
    const text = this.error || this.toast || (tab?.mode === "edit" ? tab?.note : this.note);
    if (text) return bar(this.error || this.toast ? t.ansi1 : t.dim, text);
    if (this.flashed) return bar(t.accent, this.flashed.text);
    return null;
  }

  statusBar(t) {
    const tab = this.current, mode = this.mode;
    const item = (id, label, tip, action, color) => div().id(id).h_full().px(8).flex().items_center().gap(5).flex_none().text_color(color ?? t.muted)
      .when(Boolean(tip), e => e.tooltip(tip)).when(Boolean(action), e => e.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { action(cx); cx.notify(); }))
      .child(label);
    const size = this.fontSize(), base = settings().font_size || 13, percent = Math.round(size / base * 100);
    const lines = mode === "edit" ? (tab?.lines?.length ?? 0) : this.rows.filter(r => r.new !== undefined).length;
    const roomy = (this.width ?? 1000) >= 760;
    const left = h_flex().flex_1().h_full().items_center().min_w(0).overflow_hidden();
    if (tab) {
      left.child(h_flex().h(18).px(7).mx(6).flex_none().rounded(5).items_center().gap(5).text_size(10.5).font_semibold()
        .bg((mode === "edit" ? t.accent : t.ansi4) + "26").text_color(mode === "edit" ? t.accent : t.ansi4)
        .child(svg(ICON(mode === "edit" ? "pencil" : "diff")).size(11)).child(mode === "edit" ? "EDIT" : "REVIEW"));
      if (mode === "edit") left.child(item("rf-pos", tab.cursor ? `Ln ${tab.cursor.line}, Col ${tab.cursor.col}${tab.selected ? ` (${tab.selected} selected)` : ""}` : "Ln 1, Col 1", "Go to line (Ctrl+G)", cx => this.openPalette("line", cx)));
      else left.child(item("rf-change", this.hunks.length ? `Change ${this.at >= 0 ? this.at + 1 : "–"} of ${this.hunks.length}` : "No changes", "Next change (N or F7)", cx => this.step(1, cx)));
      if (lines && roomy) left.child(item("rf-lines", `${lines.toLocaleString()} lines`, null, null, t.dim));
      if (this.find?.query && mode === "review") left.child(item("rf-find", `${this.find.hits?.length ? this.find.at + 1 : 0}/${this.find.hits?.length ?? 0} found`, "Find (Ctrl+F)", cx => this.openPalette("find", cx)));
    } else if ((shared("zendr.features") ?? {}).hints !== false) left.child(div().px(12).text_color(t.dim).truncate().child("Ctrl+P opens a file · F1 lists the shortcuts"));
    const right = h_flex().h_full().items_center().flex_none();
    if (tab?.editor && mode === "edit") {
      right.child(item("rf-indent", tab.indent?.hard ? "Tabs" : `Spaces: ${tab.indent?.size ?? 2}`, "Indentation: click to change", cx => this.cycleIndent(cx)))
        .child(item("rf-eol", tab.eol === "\r\n" ? "CRLF" : "LF", "Line endings: click to switch (then save)", cx => this.toggleEol(cx)))
        .when(roomy, e => e.child(item("rf-wrap", this.wrap ? "Wrap: on" : "Wrap: off", "Wrap long lines (Alt+Z)", cx => this.toggleWrap(cx))));
    }
    if (tab) {
      if (roomy) right.child(item("rf-encoding", "UTF-8", null, null, t.dim));
      right.child(item("rf-lang", h_flex().gap(6).items_center().child(this.fileGlyph(tab.path, 12, tab.lang)).child(tab.lang?.name ?? "Plain Text"),
          `${tab.langForced ? "Chosen" : "Detected"}: ${tab.lang?.name ?? "Plain Text"}. Click to pick another.`, cx => this.openPalette("lang", cx)));
    }
    right.child(div().w(1).h(14).mx(4).bg(t.border))
      .when(roomy, e => e.child(item("rf-zoom-out", svg(ICON("zoom-out")).size(13), "Smaller code (Ctrl+wheel down)", cx => this.setZoom(this.zoom - 1, cx))))
      .child(item("rf-zoom", `${percent}%`, "Code size: Ctrl+wheel over the code zooms. Click to reset.", cx => this.setZoom(0, cx), this.zoom ? t.foreground : t.muted))
      .when(roomy, e => e.child(item("rf-zoom-in", svg(ICON("zoom-in")).size(13), "Bigger code (Ctrl+wheel up)", cx => this.setZoom(this.zoom + 1, cx)))
        .child(item("rf-keys-status", svg(ICON("keyboard")).size(13), "Keyboard shortcuts (F1)", () => { this.showKeys = !this.showKeys; })));
    return h_flex().w_full().min_w(0).h(26).flex_none().justify_between().items_center().text_size(11).bg(t.chrome ?? t.background).border_t(1).border_color(t.border)
      .child(left).child(right);
  }

  // Nothing open: what to do next.
  welcome(t) {
    const shown = this.changes.slice(0, 6);
    const key = (k) => div().px(6).h(20).flex().items_center().rounded(5).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.foreground).child(k);
    return v_flex().size_full().items_center().justify_center().gap(16).p(24).text_color(t.foreground)
      .child(div().size(56).rounded(16).bg(t.raised).flex().items_center().justify_center().child(svg(ICON("files")).size(26).text_color(t.muted)))
      .child(v_flex().items_center().gap(4)
        .child(div().text_size(16).font_semibold().child(this.root ? "No file open" : this.loading ? "Loading…" : "No folder yet"))
        .child(div().text_size(12.5).text_color(t.dim).child(this.root ? "Pick a file in the explorer, or search for one." : "Open this from a terminal in a project folder.")))
      .when(Boolean(this.root), e => e.child(h_flex().gap(8)
        .child(this.button(t, "rf-welcome-open", "Quick open", cx => this.openPalette("files", cx), true, false, { icon: ICON("search"), tip: "Ctrl+P", accent: true }))
        .child(this.button(t, "rf-welcome-files", "Show files", cx => { this.toggleExplorer(); cx.notify(); }, true, false, { icon: "mods/workspace-chrome/panel-left.svg" }))))
      .when(shown.length > 0, e => e.child(v_flex().w(360).max_w_full().gap(2).p(6).rounded(10).border_1().border_color(t.border).bg(t.chrome ?? t.background)
        .child(div().px(8).py(4).text_size(10.5).font_semibold().text_color(t.muted).child(`CHANGED FILES (${this.changes.length})`))
        .children(shown.map(c => h_flex().id(`rf-welcome-${c.path}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.openPath(c.path, cx, { mode: "review", pin: true }))
          .child(this.fileGlyph(c.path)).child(div().flex_1().min_w(0).truncate().text_size(12.5).child(c.path))
          .child(div().text_size(10.5).font_semibold().text_color(t[MARK[c.status]]).child(c.status))))))
      .child(h_flex().gap(14).flex_wrap().justify_center().text_size(11.5).text_color(t.dim)
        .child(h_flex().gap(6).items_center().child(key("Ctrl+P")).child("Open"))
        .child(h_flex().gap(6).items_center().child(key("Ctrl+E")).child("Review / Edit"))
        .child(h_flex().gap(6).items_center().child(key("Ctrl+wheel")).child("Zoom"))
        .child(h_flex().gap(6).items_center().child(key("F1")).child("All shortcuts")));
  }

  paletteView(t) {
    const p = this.palette;
    const title = { files: "Open a file", line: "Go to line", find: "Find in this file", lang: "Language" }[p.kind];
    const icon = { files: ICON("search"), line: ICON("goto"), find: ICON("search"), lang: ICON("code") }[p.kind];
    const rows = p.items.map((it, i) => {
      const on = i === p.at;
      const row = h_flex().id(`rf-pal-${i}`).h(30).px(10).gap(9).items_center().rounded(6).cursor_pointer().when(on, e => e.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { p.at = i; this.choosePalette(false, cx); });
      if (it.path) {
        const slash = it.path.lastIndexOf("/");
        return row.child(this.fileGlyph(it.path)).child(div().flex_none().text_size(12.5).child(it.path.slice(slash + 1)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(slash > 0 ? it.path.slice(0, slash) : ""))
          .when(this.tabs.some(x => x.path === it.path), e => e.child(div().text_size(10.5).text_color(t.dim).child("open")));
      }
      return row.child(svg(it.lang.icon).size(14).flex_none().text_color(it.lang.color)).child(div().flex_1().text_size(12.5).child(it.lang.name))
        .child(div().text_size(10.5).text_color(t.dim).child(it.lang.exts.slice(0, 3).map(x => "." + x).join(" ")))
        .when(it.lang === this.current?.lang, e => e.child(div().text_size(10.5).text_color(t.accent).child("current")));
    });
    const hint = p.kind === "find" ? `${this.find?.hits?.length ?? 0} found · Enter: next · Shift+Enter: previous · Esc: close`
      : p.kind === "line" ? "Enter: go · Esc: close" : "↑ ↓ to choose · Enter: open · Esc: close";
    return div().absolute().top(10).left(0).right(0).flex().justify_center().px(16)
      .child(v_flex().id("rf-palette").w_full().max_w(580).rounded(10).border_1().border_color(t.border).bg(t.raised ?? t.background).shadow_lg().overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().h(40).px(12).gap(9).items_center().border_b(1).border_color(t.border)
          .child(svg(icon).size(15).flex_none().text_color(t.muted))
          .child(div().flex_none().text_size(11).font_semibold().text_color(t.muted).child(title))
          .child(Input.new(p.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .when(rows.length > 0, e => e.child(v_flex().p(4).gap(1).children(rows)))
        .when(p.kind === "files" && !rows.length, e => e.child(div().px(14).py(10).text_size(12).text_color(t.dim).child("No file by that name")))
        .child(div().px(12).py(6).text_size(10.5).text_color(t.dim).border_t(1).border_color(t.border).child(hint)));
  }

  keysView(t) {
    const key = (k) => div().px(6).h(20).flex().flex_none().items_center().rounded(5).border_1().border_color(t.border).bg(t.background).text_size(11).text_color(t.foreground).child(k);
    return div().absolute().inset_0().flex().items_center().justify_center().bg("#00000066").p(16)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.showKeys = false; cx.notify(); })
      .child(v_flex().id("rf-keys-sheet").w(620).max_w_full().max_h_full().rounded(12).border_1().border_color(t.border).bg(t.raised ?? t.background).shadow_lg().overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().h(44).px(16).gap(10).items_center().border_b(1).border_color(t.border)
          .child(svg(ICON("keyboard")).size(16).text_color(t.muted)).child(div().flex_1().text_size(14).font_semibold().child("Code view shortcuts"))
          .child(div().id("rf-keys-close").size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { this.showKeys = false; cx.notify(); }).child(svg(ICON("close")).size(12))))
        .child(h_flex().id("rf-keys-body").flex_wrap().items_start().p(16).gap(18).overflow_y_scroll()
          .children(SHORTCUTS.map(([group, list]) => v_flex().w(270).gap(6)
            .child(div().text_size(10.5).font_semibold().text_color(t.muted).child(group.toUpperCase()))
            .children(list.map(([k, what]) => h_flex().gap(10).items_center().justify_between()
              .child(div().text_size(12).text_color(t.foreground).child(what)).child(key(k))))))));
  }

  // Keys while the code view has the keyboard. Key bindings (keys.json) come first, so the
  // app's Ctrl+Tab, Ctrl+= and friends keep working; letters only act in Review mode, where
  // nothing is typed.
  keys(e, cx) {
    const k = e.keystroke, mode = this.mode, p = this.palette;
    const done = () => { cx.stop_propagation(); cx.notify(); };
    if (p) {
      if (k === "escape") { this.closePalette(cx); return done(); }
      if (k === "down" || k === "up") { p.at = clamp(p.at + (k === "down" ? 1 : -1), 0, Math.max(0, p.items.length - 1)); return done(); }
      if (k === "enter" || k === "shift-enter") { this.choosePalette(k === "shift-enter", cx); return done(); }
    }
    if (this.showKeys && (k === "escape" || k === "f1")) { this.showKeys = false; return done(); }
    const global = {
      "ctrl-s": () => this.save(cx), "ctrl-p": () => this.openPalette("files", cx), "ctrl-g": () => this.openPalette("line", cx),
      "ctrl-w": () => this.current && this.closeTab(this.current, cx), "ctrl-/": () => this.toggleComment(), "alt-z": () => this.toggleWrap(cx),
      "f1": () => { this.showKeys = true; }, "ctrl-e": () => this.setMode(mode === "edit" ? "review" : "edit", cx),
      "ctrl-f": () => this.openPalette("find", cx), "ctrl-\\": () => this.splitEditor(), "ctrl-b": () => this.toggleExplorer(),
      "ctrl-alt-pagedown": () => this.cycleTab(1, cx), "ctrl-alt-pageup": () => this.cycleTab(-1, cx),
    };
    if (global[k]) { global[k](); return done(); }
    if (mode !== "review" || p) return;
    const review = {
      n: () => this.step(1, cx), f7: () => this.step(1, cx), p: () => this.step(-1, cx), "shift-n": () => this.step(-1, cx), "shift-f7": () => this.step(-1, cx),
      c: () => this.toggleCompact(cx), e: () => this.toggleExplorer(), f3: () => this.findStep(1), "shift-f3": () => this.findStep(-1),
      escape: () => { this.find = null; },
    };
    if (review[k]) { review[k](); done(); }
  }

  render(cx) {
    // The Changes panel, the git graph or the layout's explorer asks a code view to show another
    // file: the one in the asking tab, or the layout's code block.
    const goto = shared("review-file.goto");
    if (goto && goto.at > this.gotoAt && (this.part === "code" ? goto.target === "layout" : !this.part && goto.target !== "layout" && goto.tab === this.paneTab)) {
      this.gotoAt = goto.at;
      if (goto.root && goto.root !== this.root) {
        this.root = goto.root; this.on = goto.on ?? null; this.isGit = goto.isGit ?? true;
        this.tree = null; this.dirEntries = new Map(); this.openDirs = new Set(); this.loadFiles(cx, true); this.watch(cx);
      }
      this.openPath(goto.path, cx, { mode: goto.mode, pin: goto.pin, rev: goto.rev, line: goto.line });
    }
    if (this.part === "explorer") return this.renderExplorer(cx);
    // The explorer block's search button asks the code block for quick open.
    const ask = shared("review-file.ask");
    if (this.part === "code" && ask && ask.at > (this.askAt ?? 0)) { this.askAt = ask.at; if (ask.what === "quick-open") this.openPalette("files", cx); }
    const t = theme(), s = settings(), size = this.fontSize(), tab = this.current, mode = this.mode;
    const explorer = this.showExplorer, colors = this.syntax(t), banner = this.banner(t);
    const code = !tab ? this.welcome(t)
      : mode === "edit"
        ? (tab.editor
          ? div().size_full().min_w(0).overflow_hidden().child(Editor.new(tab.editor).font_family(s.font_family ?? "JetBrains Mono").text_size(size).size_full())
          : div().size_full().flex().items_center().justify_center().text_color(t.dim).text_size(12.5).child(tab.loading ? "Opening…" : tab.note ?? ""))
        : div().size_full().relative().font_family(s.font_family ?? "JetBrains Mono").text_size(size)
          .child(div().id("review-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(Math.max(300, this.longest * charWidth(size) + this.gutter(size) + 60)).h_full()
              .child(v_virtual_list("review-rows", this.view.length, rowHeight(size), (i) => String(i),
                (range) => this.view.slice(range.start, range.end).map((r, j) => this.row(r, t, size, range.start + j, colors))).track_scroll(this.scroll).size_full())))
          .child(Scrollbar.vertical("review-rows").viewport_from_layout().absolute().inset_0())
          .child(div().absolute().top(0).bottom(0).right(12).w(6).children(this.ruler(t)))
          .when(!this.view.length, e => e.child(div().absolute().top(10).px(16).text_color(t.dim).text_size(12.5).child(this.loading ? "Loading…" : "")));
    return v_flex().id("review-file").size_full().min_h(0).min_w(0).overflow_hidden().when(Boolean(this.part), e => e.rounded(10).overflow_hidden().border_1().border_color(t.border))
      .bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => {
        const width = size.width / (settings().zoom || 1);
        if (Math.abs(width - (this.width ?? 0)) > 1) { this.width = width; cx.notify(); }
      })
      // Review mode takes the keyboard on a click; Edit mode leaves it with the editor.
      .on_mouse_down("left", () => { if (this.mode === "review" && !this.palette) this.handle.focus(); })
      .on_key_down((e, cx) => this.keys(e, cx))
      .child(this.tabStrip(t))
      .child(this.toolbar(t))
      .when(Boolean(banner), e => e.child(banner))
      .child(h_flex().flex_1().min_h(0).min_w(0).w_full().items_stretch()
        .when(explorer, e => e.child(this.explorerPane(t)))
        .child(div().flex_1().min_w(0).h_full().relative()
          .on_scroll_wheel((e, cx) => this.wheel(e, cx))
          .child(code)
          .when(Boolean(this.palette), e => e.child(this.paletteView(t)))
          .when(Boolean(this.showKeys), e => e.child(this.keysView(t)))))
      .child(this.statusBar(t));
  }
}
