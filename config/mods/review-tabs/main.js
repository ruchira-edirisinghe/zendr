// Herdr's tab bar (the shipped "tabs" mod, herdr-app 0.1.18, Apache-2.0). A tab's right-click
// opens review-menu (Show/Hide the file explorer, code reviewer and terminal), and each space
// remembers which of those it shows.
// Like cmux, it also keeps a notification inbox: each time an agent needs you or finishes it
// goes into shared("inbox.log"); the bell shows the unread count and opens the inbox mod.
// Commands (keys.json): review-tabs.inbox, review-tabs.jump-unread, review-tabs.color (colour this session).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, terminals, hc, notify, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, appHome, readTextFile, focused } from "herdr";

// A session's own colour (mods/session-color), by terminal address.
const SESSION_HEX = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const ownColor = (address) => { const c = (shared("zendr.features") ?? {}).session_colors !== false && address && (shared("agent.colors") ?? {})[address]; return c ? SESSION_HEX[c] ?? (c.startsWith("#") ? c : null) : null; };
// Settings → Notifications (settings.json `notifications`), read here for every mod.
const prefs = () => shared("notify.prefs") ?? {};
const keep = () => Number(prefs().keep) || 200;
let seq = 0;

// The right-side drawer (the layout's "side" stack) shows the hub or the notifications;
// a toggle shows its child there, or hides the drawer when it's already showing it.
function toggleSide(child, keep = false) {
  const side = find(layout(), "side");
  if (!side) { if (child === "notifications") openOverlay({ mod: "inbox", kind: "popup", width: 400, height: 540 }); return; }
  if (!keep && !side.hidden && side.active === child) run("layout.hide", { id: "side" });
  else { run("layout.select", { stack: "side", child }); run("layout.show", { id: "side" }); }
}
function openInbox() { toggleSide("notifications"); }
// Goes to the newest unread notification and marks it read; with none, shows the notifications.
function jumpUnread() {
  const entry = (shared("inbox.log") ?? []).find(e => !e.read);
  if (!entry) { toggleSide("notifications", true); return; }
  setShared("inbox.log", (shared("inbox.log") ?? []).map(e => e.id === entry.id ? { ...e, read: true } : e));
  if (entry.terminal) {
    if (entry.space) run("space.select", { id: entry.space });
    if (entry.tab) run("tab.select", { id: entry.tab });
    run("pane.focus", { terminal: entry.terminal });
  }
}

// Settings → Features (settings.json `features`): each on unless turned off.
const feature = (id) => (shared("zendr.features") ?? {})[id] !== false;

// Command search and Ask AI (mods/commands), for the focused terminal.
function openCommands(mode) {
  if (!feature(mode === "ai" ? "ai_command" : "command_search")) return;
  const f = focused(), pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const tab = spaces().flatMap(s => s.tabs).find(c => c.id === f?.tab);
  const name = pane?.program?.name ?? "";
  const shell = /pwsh|powershell/i.test(name) ? "PowerShell" : /cmd/i.test(name) ? "cmd.exe" : /bash|zsh|fish|\bsh\b/i.test(name) ? name : null;
  openOverlay({ mod: "commands", kind: "dialog", width: 640, height: 480,
    props: { mode, terminal: f?.terminal ?? null, cwd: f?.cwd ?? null, shell, where: tab ? label(tab, pane) : null } });
}

// Colour the focused session (mods/session-color).
function pickFocusedColor() {
  const f = focused(), address = f?.agent ?? f?.terminal;
  if (!address) return;
  const tab = spaces().flatMap(s => s.tabs).find(c => c.id === f.tab);
  const lead = panes().find(p => p.tab === f.tab && p.program?.agent) ?? panes().find(p => p.tab === f.tab);
  openOverlay({ mod: "session-color", kind: "popup", width: 268, props: { kind: "agent", id: address, name: tab ? label(tab, lead) : null } });
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    try { const saved = JSON.parse(localStorage.getItem("inbox") ?? "[]"); if (Array.isArray(saved) && !shared("inbox.log")) setShared("inbox.log", saved); } catch {}
    this.statuses = null;
    cx.timer.every(500, () => { this.record(); this.bridge(); });
    this.loadPrefs(cx);
    cx.timer.every(1500, cx => this.loadPrefs(cx));
    this.titles = {}; // terminal -> the bridge title last given to its tab
    this.handling = new Map(); // request -> when it was handled (until its label is gone)
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "inbox") openInbox();
        else if (command === "hub") { if (feature("hub")) toggleSide("hub"); }
        else if (command === "jump-unread") jumpUnread();
        else if (command === "color") pickFocusedColor();
        else if (command === "command-search") openCommands("history");
        else if (command === "ask-ai") openCommands("ai");
        else if (command === "launch") { if (feature("launch_configs")) openOverlay({ mod: "launch", kind: "dialog", width: 520, height: 460 }); }
        cx.notify();
      }
    });
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    try { this.views = JSON.parse(localStorage.getItem("views") ?? "{}"); } catch { this.views = {}; }
    if (!this.views || typeof this.views !== "object" || Array.isArray(this.views)) this.views = {};
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // Shares settings.json's notification preferences whenever the file changes.
  async loadPrefs(cx) {
    const raw = await readTextFile(`${appHome()}/settings.json`).catch(() => null);
    if (raw === this.prefsRaw) return;
    this.prefsRaw = raw;
    let person;
    try { person = JSON.parse(raw ?? "{}") ?? {}; } catch { return; } // mid-edit: keep the last
    const n = person.notifications, f = person.features;
    setShared("notify.prefs", n && typeof n === "object" ? n : {});
    // Settings → Features: what Zendr shows (all on unless turned off), for every mod.
    setShared("zendr.features", f && typeof f === "object" ? f : {});
    // The hub turned off: the drawer stops showing it.
    const side = find(layout(), "side");
    if (side && f?.hub === false && !side.hidden && side.active === "hub") run("layout.hide", { id: "side" });
    cx.notify();
  }

  // An agent turning blocked (needs you) or done (finished) is a notification. It reads
  // itself once the agent moves on (you answered it, or looked at the finished one).
  record() {
    const list = agents(), now = new Map(list.map(a => [a.address, a.status]));
    const before = this.statuses;
    this.statuses = now;
    if (!before) return;
    let log = shared("inbox.log") ?? [], changed = false;
    for (const a of list) {
      if (a.status === before.get(a.address) || (a.status !== "blocked" && a.status !== "done")) continue;
      if (prefs()[a.status]?.inbox === false) continue;
      log = [{ id: `${Date.now()}-${seq++}`, at: Date.now(), kind: "agent", space: a.space, space_name: a.space_name, tab: a.tab,
        terminal: a.address, app: a.app, status: a.status, title: a.status === "blocked" ? "Needs you" : "Finished",
        body: (a.title ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim(), read: Boolean(a.focused) }, ...log].slice(0, keep());
      changed = true;
    }
    // Looking at the agent reads its notifications too (Settings → Notifications).
    const visiting = prefs().read_on_visit !== false && window()?.active !== false ? new Set(list.filter(a => a.focused).map(a => a.address)) : new Set();
    log = log.map(e => {
      if (e.read || !e.terminal) return e;
      const s = now.get(e.terminal);
      if (!visiting.has(e.terminal) && (e.kind !== "agent" || s === e.status)) return e;
      changed = true;
      return { ...e, read: true };
    });
    if (changed) setShared("inbox.log", log);
    // Saved for the next start, whoever changed it (the inbox marks read and clears too).
    if (log !== this.savedLog) { this.savedLog = log; try { localStorage.setItem("inbox", JSON.stringify(log)); } catch {} }
  }

  // Requests from Claude Code's session-bridge mod, which runs inside a terminal and talks
  // to Zendr through that terminal's labels (`hc label <t> bridge.<what>=<json>`):
  //   bridge.title   {name}                  the tab's name (persists)
  //   bridge.notify  {id, title, body}       a notification: a toast and an inbox entry
  //   bridge.focus   {id}                    show this terminal (its space, tab and pane)
  //   bridge.spawn   {id, name, cwd, argv}   open a new space running argv in cwd
  // One-shot requests are cleared once handled. bridge.status (the sidebar line) is read
  // by review-spaces.
  bridge() {
    for (const term of terminals()) {
      const labels = term.labels ?? {}, address = term.address;
      if (!address || !Object.keys(labels).some(k => k.startsWith("bridge."))) continue;
      const parse = (key) => { try { return JSON.parse(labels[key]); } catch { return null; } };
      const done = (key) => {
        const tag = `${address} ${key} ${labels[key]}`;
        const now = Date.now();
        if (now - (this.handling.get(tag) ?? 0) < 5000) return false;
        this.handling.set(tag, now);
        for (const [k, at] of this.handling) if (now - at > 60000) this.handling.delete(k);
        hc(["label", address, `${key}=`]).catch(() => {});
        return true;
      };
      const space = labels["herdr.space"], tab = labels["herdr.tab"];
      const title = parse("bridge.title")?.name;
      if (title && tab && this.titles[address] !== title) { this.titles[address] = title; run("tab.rename", { id: tab, name: title }); }
      if (labels["bridge.notify"] && done("bridge.notify")) {
        const n = parse("bridge.notify") ?? {};
        const s = spaces().find(x => x.id === space);
        const entry = { id: `bridge-${Date.now()}-${seq++}`, at: Date.now(), kind: "bridge", space, space_name: s?.name, tab, terminal: address,
          app: "session-bridge", status: "blocked", title: n.title || "Session bridge", body: n.body ?? "", read: false };
        if (prefs().bridge?.inbox !== false) setShared("inbox.log", [entry, ...(shared("inbox.log") ?? [])].slice(0, keep()));
        notify({ title: entry.title, body: [s?.name, entry.body].filter(Boolean).join(" · "), level: "info", kind: "bridge", action: { name: "agent.focus", args: { terminal: address } } });
      }
      if (labels["bridge.focus"] && done("bridge.focus")) {
        if (space) run("space.select", { id: space });
        if (tab) run("tab.select", { id: tab });
        run("pane.focus", { terminal: address });
      }
      if (labels["bridge.spawn"] && done("bridge.spawn")) {
        const r = parse("bridge.spawn");
        if (r && Array.isArray(r.argv) && r.argv.length && typeof r.cwd === "string")
          run("space.new", { name: String(r.name || "claude").slice(0, 60), folder: r.cwd, argv: r.argv.map(String), focus: r.focus === true });
      }
    }
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // The explorer, code reviewer and terminal blocks are remembered per space, like the
  // side panel: a space opens with all three unless it was left otherwise.
  syncViews(space, root) {
    if (!space) return;
    const ids = ["explorer", "code", "main"].filter(id => find(root, id));
    if (!ids.length) return;
    const now = Object.fromEntries(ids.map(id => [id, !find(root, id).hidden]));
    if (space.id !== this.viewSpace) {
      this.viewSpace = space.id; this.viewPending = null;
      const want = Object.fromEntries(ids.map(id => [id, this.views[space.id]?.[id] ?? true]));
      if (!ids.some(id => want[id])) want[ids[ids.length - 1]] = true;
      const differ = ids.filter(id => want[id] !== now[id]);
      if (differ.length) {
        this.viewPending = { want, until: Date.now() + 1000 };
        for (const id of differ) run(want[id] ? "layout.show" : "layout.hide", { id });
        return;
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.viewPending) {
      if (ids.some(id => this.viewPending.want[id] !== now[id]) && Date.now() < this.viewPending.until) return;
      this.viewPending = null;
    }
    if (JSON.stringify(this.views[space.id]) === JSON.stringify(now)) return;
    this.views[space.id] = now;
    localStorage.setItem("views", JSON.stringify(this.views));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).when(Boolean(tip), el => el.tooltip(tip)).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      const tint = ownColor(lead?.terminal);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        // A tab whose agent needs you lights up in the attention colour, as in cmux.
        .border(1).border_color(c.status === "blocked" ? t.blocked : c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .when(!tint, el => el.hover(s => s.bg(t.hover)))
        // The session's colour tints the whole tab; the selected one is stronger and outlined.
        .when(Boolean(tint), el => el.bg(tint + (c.active ? "42" : "1c")).hover(s => s.bg(tint + (c.active ? "4d" : "2e")))
          .when(c.active && c.status !== "blocked", el => el.border_color(tint + "cc")))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "review-menu", kind: "popup", width: 220, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    const unread = (shared("inbox.log") ?? []).filter(e => !e.read).length;
    const badge = prefs().badge ?? "count", quiet = (prefs().quiet_until ?? 0) > Date.now();
    this.syncPanel(space, panel, body, enabled);
    this.syncViews(space, root);
    const side = find(root, "side");
    const sideOn = (child) => Boolean(side && !side.hidden && side.active === child);
    const viewOn = (id) => { const n = find(root, id); return Boolean(n && !n.hidden); };
    const toggle = (id, icon, label, on, tip, action, extra) => h_flex().id(`tb-${id}`).h(28).px(9).gap(6).flex_none().items_center().rounded(7)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.border : t.chrome)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_mouse_down("left", stop)
      .on_click(() => action()).child(svg(icon).size(14)).child(label).when(Boolean(extra), el => el.child(extra));
    const panelButton = (id, label, icon) => {
      const on = Boolean(panel && !panel.hidden && body?.active === id);
      return toggle(`panel-${id}`, icon, label, on, `Show or hide the ${label} panel`, () => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
      });
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", svg("mods/workspace-chrome/plus.svg").size(14), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New tab or terminal"))
      // The toolbar: every panel is a labelled toggle, lit while it's showing.
      .child(div().w(1).h(18).mx(5).flex_none().bg(t.border))
      .when(feature("command_search") || feature("ai_command"), el => el.child(toggle("commands", "mods/commands/workflow.svg", "Commands", false,
        "Command search: history, workflows and Ask AI (Ctrl+Shift+R)", () => openCommands(feature("command_search") ? "history" : "ai"))))
      .when(Boolean(find(root, "explorer")), el => el.child(toggle("explorer", "mods/workspace-chrome/panel-left.svg", "Explorer", viewOn("explorer"),
        "Show or hide the file explorer", () => run("layout.toggle", { id: "explorer" }))))
      .when(Boolean(find(root, "code")), el => el.child(toggle("code", "mods/workspace-chrome/file-text.svg", "Code", viewOn("code"),
        "Show or hide the code reviewer", () => run("layout.toggle", { id: "code" }))))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(feature("hub") && Boolean(find(root, "side")), el => el.child(toggle("hub", "mods/hub/users.svg", "Hub", sideOn("hub"),
        "The coordinator, every agent and their messages", () => toggleSide("hub"))))
      .when(feature("bell"), el => el.child(toggle("bell", "mods/review-tabs/bell.svg", "Notifications", sideOn("notifications"),
        unread ? `${unread} unread (Ctrl+Shift+I)` : "Notifications (Ctrl+Shift+I)", () => toggleSide("notifications"),
        // Settings → Notifications: a number, a dot, or nothing; a moon while do not disturb is on.
        h_flex().gap(4).items_center()
          .when(unread > 0 && badge === "count", el => el.child(div().min_w(16).h(16).px(4).rounded(8).bg(t.blocked).flex().items_center().justify_center()
            .text_size(10).font_semibold().text_color(t.background).child(unread > 99 ? "99+" : String(unread))))
          .when(unread > 0 && badge === "dot", el => el.child(div().size(7).rounded(4).bg(t.blocked)))
          .when(quiet, el => el.child(svg("mods/inbox/moon.svg").size(12).text_color(t.working))))))
      .child(div().w(1).h(18).mx(5).flex_none().bg(t.border))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/review-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/review-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/review-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
