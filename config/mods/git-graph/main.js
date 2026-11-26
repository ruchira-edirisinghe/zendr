// The source control graph, like VS Code's: the shown space's commits with their branch lines,
// branch and tag labels, author and age. Click a commit to see the files it changed; click a
// file to open that change in the code view. Lives in the layout's right-side drawer
// ("side" stack, child "graph"); the toolbar's Graph button shows it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, theme, spaces, panes, focused, shared, setShared, run, layout, window } from "herdr";
import { fileIcon } from "./lang.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const LIMIT = 400, LANE = 14, ROW = 46, FILE_ROW = 28, MAX_LANES = 12;
const ICON = name => `mods/review-file/icons/${name}.svg`;
const STATUS = { A: ["Added", "ansi2"], M: ["Modified", "blocked"], D: ["Deleted", "ansi1"], R: ["Renamed", "ansi4"], C: ["Copied", "ansi4"], T: ["Type changed", "blocked"] };

// Where the person is working: the focused terminal, else a terminal in the shown space.
function place() {
  const space = spaces().find(s => s.active), f = focused(), all = panes();
  const on = space?.machine ?? null, pane = f?.pane ? all.find(p => p.pane === f.pane) : null;
  if (pane?.cwd) return { cwd: pane.cwd, on, space: space?.id };
  const tabs = new Set((space?.tabs ?? []).map(t => t.id)), terminal = all.find(p => tabs.has(p.tab) && p.cwd);
  return { cwd: terminal?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}
function since(seconds) {
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
  return `${Math.floor(s / 86400 / 365)}y`;
}

// Lanes, top to bottom: each row knows the lanes coming in (above the dot) and going out
// (below it), which lane its dot sits in, and which lanes join or leave at the dot.
function layoutGraph(commits) {
  let lanes = [];
  for (const c of commits) {
    const before = lanes.slice();
    let lane = before.indexOf(c.hash);
    if (lane < 0) { lane = before.indexOf(null); if (lane < 0) lane = before.length; }
    // Other lanes waiting for this commit end here (a branch point seen from above).
    const joins = [];
    before.forEach((h, i) => { if (h === c.hash && i !== lane) joins.push(i); });
    const after = before.slice();
    for (const i of joins) after[i] = null;
    after[lane] = c.parents[0] ?? null;
    // Further parents (a merge): an existing lane for them, else a new one.
    const forks = [];
    for (const p of c.parents.slice(1)) {
      let i = after.indexOf(p);
      if (i < 0) { i = after.indexOf(null); if (i < 0 || i === lane) i = after.length; after[i] = p; }
      forks.push(i);
    }
    while (after.length && after[after.length - 1] === null) after.pop();
    c.lane = lane; c.before = before.map(h => h !== null); c.after = after.map(h => h !== null); c.joins = joins; c.forks = forks;
    c.width = Math.min(MAX_LANES, Math.max(before.length, after.length, lane + 1));
    lanes = after;
  }
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.commits = []; this.open = null; this.files = new Map(); this.scroll = VirtualListScrollHandle.new();
    this.all = true; this.changes = 0;
    cx.timer.every(800, cx => this.follow(cx));
    // A new commit, branch or checkout: refs change. Cheap to check while the drawer shows.
    cx.timer.every(4000, cx => { if (this.visible() && window()?.active !== false) this.refresh(cx, false); });
  }

  visible() {
    const side = findNode(layout(), "side");
    return Boolean(side && !side.hidden && side.active === "graph");
  }

  follow(cx) {
    if (!this.visible() && this.root) return;
    const { cwd, on, space } = place();
    const key = JSON.stringify([space, cwd, on]);
    if (key === this.placeKey || this.resolving) return;
    this.placeKey = key;
    if (!cwd) { this.root = null; this.error = "No folder"; cx.notify(); return; }
    this.resolving = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const root = top?.code === 0 ? top.stdout.trim() : null;
        if (root !== this.root || on !== this.on) {
          this.root = root; this.on = on; this.commits = []; this.open = null; this.files = new Map(); this.stamp = null;
          this.error = root ? null : "This space's folder isn't a git repository";
          if (root) this.refresh(cx, true);
        }
      } finally { this.resolving = false; cx.notify(); }
    });
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on, timeout: 20000 }); }

  refresh(cx, force) {
    if (!this.root || this.loading) return;
    this.loading = true;
    const root = this.root;
    cx.spawn(async cx => {
      try {
        // Refs and HEAD: when they're the same, so is the graph.
        const refs = await this.git(["for-each-ref", "--format=%(objectname) %(refname)"]);
        const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]);
        const status = await this.git(["status", "--porcelain=v1", "--untracked-files=normal"]);
        if (root !== this.root) return;
        this.changes = status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
        const stamp = `${refs.stdout}|${head.stdout}|${this.all}`;
        if (!force && stamp === this.stamp) return;
        this.stamp = stamp;
        if (head.code !== 0) { this.commits = []; this.note = "No commits yet"; return; }
        const r = await this.git(["log", ...(this.all ? ["--all"] : []), "--date-order", `-n${LIMIT}`, "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e"]);
        if (root !== this.root) return;
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git log failed");
        const commits = r.stdout.split("\x1e").map(s => s.replace(/^\n/, "")).filter(Boolean).map(line => {
          const [hash, parents, author, at, refsText, subject] = line.split("\x1f");
          const refs = (refsText ?? "").split(", ").filter(Boolean).filter(x => !x.endsWith("/HEAD"));
          return { hash, parents: parents ? parents.split(" ") : [], author, at: Number(at), refs, subject: subject ?? "" };
        });
        layoutGraph(commits);
        this.commits = commits; this.note = commits.length >= LIMIT ? `The latest ${LIMIT} commits` : null; this.error = null;
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  toggle(c, cx) {
    this.open = this.open === c.hash ? null : c.hash;
    if (this.open && !this.files.has(c.hash)) {
      this.files.set(c.hash, null);
      cx.spawn(async cx => {
        const r = await this.git(["diff-tree", "-r", "--root", "--no-commit-id", "-m", "--first-parent", "--name-status", c.hash]).catch(() => null);
        const list = r?.code === 0 ? r.stdout.split("\n").filter(Boolean).slice(0, 300).map(l => {
          const [s, ...paths] = l.split("\t");
          return { status: s[0], path: paths[paths.length - 1] };
        }) : [];
        this.files.set(c.hash, list);
        cx.notify();
      });
    }
    cx.notify();
  }

  // Shows that commit's change to the file in the layout's code view.
  openFile(c, f) {
    if (f.status === "D") return;
    setShared("review-file.goto", { target: "layout", root: this.root, on: this.on, isGit: true, path: f.path, rev: c.hash, mode: "review", pin: true, at: Date.now() });
    if (findNode(layout(), "code")?.hidden) run("layout.show", { id: "code" });
  }

  lanes(c, t) {
    const colors = [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1];
    const color = i => colors[i % colors.length], x = i => i * LANE + LANE / 2, mid = ROW / 2;
    const parts = [];
    const line = (left, top, w, h, col) => parts.push(div().absolute().left(left).top(top).w(w).h(h).bg(col));
    c.before.forEach((on, i) => { if (on && i < MAX_LANES) line(x(i) - 1, 0, 2, mid, color(i)); });
    c.after.forEach((on, i) => { if (on && i < MAX_LANES) line(x(i) - 1, mid, 2, ROW - mid, color(i)); });
    // Branches joining here and merge parents leaving: a level line at the dot.
    for (const i of [...c.joins, ...c.forks]) {
      if (i >= MAX_LANES) continue;
      const a = Math.min(x(i), x(c.lane)), b = Math.max(x(i), x(c.lane));
      line(a, mid - 1, b - a, 2, color(c.joins.includes(i) ? i : i));
    }
    const merge = c.parents.length > 1, head = c.refs.some(r => r.startsWith("HEAD"));
    parts.push(div().absolute().left(x(c.lane) - 5).top(mid - 5).size(10).rounded(5).border_2().border_color(color(c.lane))
      .bg(merge ? t.background : color(c.lane)).when(head, e => e.size(12).left(x(c.lane) - 6).top(mid - 6).rounded(6).border_color(t.foreground)));
    return div().relative().flex_none().h(ROW).w(Math.max(1, c.width) * LANE + 6).children(parts);
  }

  ref(r, t) {
    const tag = r.startsWith("tag: "), head = r.startsWith("HEAD -> "), remote = !tag && !head && r.includes("/");
    const name = tag ? r.slice(5) : head ? r.slice(8) : r;
    const color = tag ? t.ansi3 : head ? t.accent : remote ? t.ansi5 : t.ansi4;
    return h_flex().flex_none().h(17).px(6).gap(4).items_center().rounded(9).bg(color + "26").text_color(color).text_size(10.5).font_medium()
      .tooltip(tag ? `Tag ${name}` : head ? `${name}: the checked-out branch` : remote ? `Remote branch ${name}` : `Branch ${name}`)
      .child(svg(ICON(tag ? "license" : "graph")).size(10)).child(div().max_w(120).truncate().child(name));
  }

  row(c, t) {
    const open = this.open === c.hash;
    const head = c.refs.some(r => r.startsWith("HEAD"));
    return h_flex().id(`commit-${c.hash}`).w_full().h(ROW).flex_none().pr(10).items_center().cursor_pointer()
      .when(open, e => e.bg(t.selected)).hover(s => s.bg(t.hover))
      .tooltip(`${c.hash.slice(0, 10)} · ${c.author} · ${new Date(c.at * 1000).toLocaleString()}\n${c.subject}\nClick to see its files`)
      .child(div().w(8).flex_none())
      .child(this.lanes(c, t))
      .child(v_flex().flex_1().min_w(0).gap(3).pl(4)
        .child(h_flex().gap(5).items_center().min_w(0)
          .children(c.refs.slice(0, 3).map(r => this.ref(r, t)))
          .when(c.refs.length > 3, e => e.child(div().text_size(10).text_color(t.dim).child(`+${c.refs.length - 3}`)))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).when(head, e => e.font_semibold()).child(c.subject || "(no message)")))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().font_family("JetBrains Mono").text_size(10.5).child(c.hash.slice(0, 7)))
          .child(div().min_w(0).truncate().child(c.author))
          .child(div().flex_none().child(`· ${since(c.at)}`))));
  }

  // One file of the open commit (each its own row, so the list's click names it).
  fileRow(it, t) {
    const { c, f, note } = it;
    // The branch lines carry on past the open commit's files.
    const colors = [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1];
    const through = div().relative().flex_none().h(FILE_ROW).w(Math.max(1, c.width) * LANE + 6)
      .children(c.after.map((on, i) => on && i < MAX_LANES ? div().absolute().left(i * LANE + LANE / 2 - 1).top(0).w(2).h(FILE_ROW).bg(colors[i % colors.length]) : null).filter(Boolean));
    const row = h_flex().id(`commit-file-${c.hash}-${f?.path ?? note}`).w_full().h(FILE_ROW).flex_none().pr(12).gap(7).items_center().bg(t.raised)
      .child(div().w(8).flex_none()).child(through);
    if (note) return row.child(div().text_size(11.5).text_color(t.dim).child(note));
    const [word, color] = STATUS[f.status] ?? ["Changed", "muted"], slash = f.path.lastIndexOf("/"), icon = fileIcon(f.path);
    return row.when(f.status !== "D", e => e.cursor_pointer().hover(s => s.bg(t.hover)))
      .tooltip(f.status === "D" ? `${f.path} was deleted` : `${word}: ${f.path}. Click to see the change.`)
      .child(svg(icon.icon).size(13).flex_none().text_color(icon.color))
      .child(div().flex_none().text_size(12).child(f.path.slice(slash + 1)))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(slash > 0 ? f.path.slice(0, slash) : ""))
      .child(div().flex_none().w(14).text_center().text_size(10.5).font_semibold().text_color(t[color]).child(f.status));
  }

  render(cx) {
    const t = theme();
    // Rows: each commit, and the open one's files under it. A row's key says which it is.
    const items = [], byKey = new Map();
    for (const c of this.commits) {
      items.push({ key: `c:${c.hash}`, c });
      if (this.open !== c.hash) continue;
      const files = this.files.get(c.hash);
      if (!Array.isArray(files)) items.push({ key: `n:${c.hash}`, c, note: "Loading…", sub: true });
      else if (!files.length) items.push({ key: `n:${c.hash}`, c, note: "No file changes", sub: true });
      else files.forEach((f, i) => items.push({ key: `f:${c.hash}:${i}`, c, f, sub: true }));
    }
    for (const it of items) byKey.set(it.key, it);
    const heights = items.map(it => it.sub ? FILE_ROW : ROW);
    const button = (id, icon, tip, action, on = false) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(on ? t.foreground : t.muted).when(on, e => e.bg(t.selected)).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click((_e, cx) => { action(cx); cx.notify(); }).child(svg(icon).size(14));
    const name = this.root ? this.root.split(/[\\/]/).pop() : "";
    return v_flex().id("git-graph").size_full().min_h(0).bg(t.background).border_l(1).border_color(t.border).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(46).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("graph")).size(16).text_color(t.accent))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(13).font_semibold().child("Source control graph"))
          .child(div().text_size(11).text_color(t.dim).truncate().child(this.root ? `${name} · ${this.commits.length} commit${this.commits.length === 1 ? "" : "s"}` : "")))
        .child(button("graph-all", ICON("files"), this.all ? "Showing every branch: click for this branch only" : "Showing this branch: click for every branch", cx => { this.all = !this.all; this.refresh(cx, true); }, this.all))
        .child(button("graph-refresh", ICON("goto"), "Reload", cx => this.refresh(cx, true))))
      .when(this.changes > 0, e => e.child(h_flex().id("graph-changes").h(34).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Show the uncommitted changes in the code view")
        .on_click(() => { run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); })
        .child(div().size(10).rounded(5).border_2().border_color(t.blocked))
        .child(div().flex_1().text_size(12).child("Uncommitted changes"))
        .child(div().px(6).h(17).rounded(9).flex().items_center().bg(t.blocked + "26").text_color(t.blocked).text_size(10.5).child(String(this.changes)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("graph-rows", items.length, heights, i => items[i].key,
          range => items.slice(range.start, range.end).map(it => it.sub ? this.fileRow(it, t) : this.row(it.c, t)))
          .on_item_click((key, cx) => {
            const it = byKey.get(key);
            if (!it) return;
            if (!it.sub) this.toggle(it.c, cx);
            else if (it.f) this.openFile(it.c, it.f);
          })
          .track_scroll(this.scroll).size_full())
        .child(Scrollbar.vertical("graph-rows").viewport_from_layout().absolute().inset_0())
        .when(!items.length, e => e.child(v_flex().absolute().inset_0().items_center().justify_center().gap(8).p(20)
          .child(svg(ICON("graph")).size(28).text_color(t.dim))
          .child(div().text_size(12.5).text_color(t.dim).child(this.error ?? this.note ?? (this.loading || this.resolving ? "Loading the history…" : "No commits to show"))))))
      .when(Boolean(this.note && items.length), e => e.child(div().px(14).py(5).flex_none().text_size(10.5).text_color(t.dim).border_t(1).border_color(t.border).child(this.note)));
  }
}
