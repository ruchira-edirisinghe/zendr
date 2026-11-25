// The session hub: the coordinator and every agent at a glance, what each is doing, the
// messages between them (Claude Code's session-bridge mod), and a box to message any of
// them as you. A right-side panel of the main-review layout.
//
// Sessions find each other through ~/.claude/session-bridge (see the session-bridge
// README): sessions/<id>.json per live session, inbox/<name>/<id>.json for messages,
// events/<id>.json per sent message. The hub reads those, and sends by writing a message
// into a session's inbox, which its bridge picks up within 2 seconds.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, spaces, focused, run, home, exec, readTextFile, writeTextFile, theme, shared, window } from "herdr";

// Who the hub sends as: the person at the keyboard.
const ME = { id: "hub", name: "ruchira", role: "human" };
const STALE_MS = 30000;
const FEED_MAX = 150;
const COORDINATOR = "coordinator";
// Every status says itself in words, not by colour alone.
const STATUS = { working: ["Working", "working"], blocked: ["Needs you", "blocked"], done: ["Done", "done"], idle: ["Idle", "dim"] };
const BRIEF = [
  "You are the coordinator of the Claude Code sessions on this computer, connected through the session bridge.",
  "Use bridge_peers to see the other sessions (name, role, folder), bridge_send to give them work, ask questions or ask for status,",
  "and bridge_handoff for larger pieces of work. Each instruction must stand on its own: the others can't see this conversation.",
  "Ruchira, the person you work for, watches every session in Zendr's hub and may message you or any agent directly.",
  "Start by listing the peers and asking Ruchira what to work on.",
].join(" ");

const slash = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const root = () => `${slash(home())}/.claude/session-bridge`;
const windows = () => window()?.platform === "windows";
const newId = () => `${Date.now()}-${Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0")}`;
const isCoordinator = (p) => p?.role === COORDINATOR || p?.name === COORDINATOR;

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

async function listDir(path) {
  const r = windows()
    ? await exec("cmd", ["/d", "/c", "dir", "/b", path.replace(/\//g, "\\")], { timeout: 5000 }).catch(() => null)
    : await exec("ls", ["-1", path], { timeout: 5000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
}

async function makeDir(path) {
  if (windows()) await exec("cmd", ["/d", "/c", "mkdir", path.replace(/\//g, "\\")], { timeout: 5000 }).catch(() => null);
  else await exec("mkdir", ["-p", path], { timeout: 5000 }).catch(() => null);
}

export default class Hub extends View {
  init(_props, cx) {
    this.peers = [];
    this.bridge = null; // false: no session-bridge folder (the mod isn't installed)
    try { this.feed = JSON.parse(localStorage.getItem("feed") ?? "[]"); } catch { this.feed = []; }
    if (!Array.isArray(this.feed)) this.feed = [];
    this.to = COORDINATOR;
    this.error = null;
    this.input = InputState.new({ placeholder: "Message the coordinator…" });
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(2500, cx => { if (window()?.visible !== false) this.refresh(cx); });
    cx.timer.every(30000, cx => cx.notify()); // "5m" keeps moving.
  }

  // Reads the live sessions and any new sent-message records.
  async refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    try {
      const dir = root();
      const sessions = await listDir(`${dir}/sessions`);
      const peers = [];
      for (const name of sessions.filter(n => n.endsWith(".json"))) {
        try { const p = JSON.parse(await readTextFile(`${dir}/sessions/${name}`) ?? "null"); if (p?.name) peers.push(p); } catch {}
      }
      const now = Date.now();
      const live = peers.filter(p => now - (p.updatedAt ?? 0) < STALE_MS).sort((a, b) => a.name.localeCompare(b.name));
      const known = new Set(this.feed.map(e => e.id));
      let added = 0;
      for (const name of (await listDir(`${dir}/events`)).filter(n => n.endsWith(".json") && !known.has(n.slice(0, -5)))) {
        try { const e = JSON.parse(await readTextFile(`${dir}/events/${name}`) ?? "null"); if (e?.id && !known.has(e.id)) { this.feed.push(e); added++; } } catch {}
      }
      if (added) {
        this.feed.sort((a, b) => a.at - b.at);
        this.feed = this.feed.slice(-FEED_MAX);
        try { localStorage.setItem("feed", JSON.stringify(this.feed)); } catch {}
      }
      const bridge = sessions.length > 0 || (await readTextFile(`${dir}/.hub`).catch(() => null)) !== null || (await listDir(dir)).length > 0;
      if (added || bridge !== this.bridge || JSON.stringify(live) !== JSON.stringify(this.peers)) {
        this.peers = live; this.bridge = bridge; cx.notify();
      }
    } finally { this.busy = false; }
  }

  // Writes a message into each recipient's inbox, as the bridge itself queues one.
  async deliver(names, body, kind = "message") {
    const dir = root(), at = Date.now();
    for (const name of names) {
      const message = { id: newId(), kind, from: { ...ME, cwd: slash(home()) }, to: name, body, createdAt: at };
      await makeDir(`${dir}/inbox/${name}`);
      await writeTextFile(`${dir}/inbox/${name}/${message.id}.json`, JSON.stringify(message), null);
    }
    const event = { v: 1, id: newId(), at, kind, from: { id: ME.id, name: ME.name }, to: names, preview: body.replace(/\s+/g, " ").slice(0, 80) };
    await makeDir(`${dir}/events`);
    await writeTextFile(`${dir}/events/${event.id}.json`, JSON.stringify(event), null).catch(() => null);
  }

  async send(cx) {
    const body = this.input.value().trim();
    if (!body) return;
    const names = this.to === "*" ? this.peers.map(p => p.name) : [this.to];
    if (!names.length) { this.error = "No session is on the bridge to send to."; cx.notify(); return; }
    try {
      await this.deliver(names, body);
      this.input.set_value("");
      this.error = null;
      await this.refresh(cx);
    } catch (e) { this.error = `Couldn't send: ${e}`; }
    cx.notify();
  }

  // A new space running Claude Code as the coordinator, with its brief waiting in its inbox.
  async startCoordinator(cx) {
    const folder = focused()?.cwd ?? home();
    const env = `CLAUDE_SESSION_BRIDGE_NAME=${COORDINATOR} CLAUDE_SESSION_BRIDGE_ROLE=${COORDINATOR}`;
    const argv = windows()
      ? ["powershell", "-NoLogo", "-NoExit", "-Command", `$env:CLAUDE_SESSION_BRIDGE_NAME='${COORDINATOR}'; $env:CLAUDE_SESSION_BRIDGE_ROLE='${COORDINATOR}'; claude`]
      : ["/bin/sh", "-lc", `${env} claude`];
    await this.deliver([COORDINATOR], BRIEF).catch(() => null);
    run("space.new", { name: "Coordinator", folder, argv, focus: true });
    this.to = COORDINATOR;
    cx.notify();
  }

  // Shows an agent's terminal: its space, then its pane.
  show(address) {
    const term = terminals().find(t => t.address === address);
    const space = term?.labels?.["herdr.space"] ?? agents().find(a => a.address === address)?.space;
    if (space) run("space.select", { id: space });
    run("pane.focus", { terminal: address });
  }

  // Everyone the hub lists: Zendr's agents, each with its bridge name if it has one, then
  // bridge sessions that run outside Zendr.
  people() {
    const list = agents(), summaries = shared("agents.summaries") ?? {};
    const byTerminal = new Map(this.peers.filter(p => p.zendr?.terminal).map(p => [p.zendr.terminal, p]));
    const rows = list.map(a => {
      const peer = byTerminal.get(a.address);
      return { key: a.address, address: a.address, peer, name: peer?.name ?? a.space_name ?? a.title, role: peer?.role,
        space: a.space_name, status: a.status, title: (a.title ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim(),
        summary: summaries[a.address] ?? null, app: a.program?.name };
    });
    const shown = new Set(rows.filter(r => r.peer).map(r => r.peer.id));
    for (const p of this.peers) if (!shown.has(p.id)) rows.push({ key: p.id, peer: p, name: p.name, role: p.role, space: slash(p.cwd).split("/").pop(), status: null, title: "", summary: null });
    return rows;
  }

  statusPill(t, status) {
    const [label, color] = STATUS[status] ?? ["Not in Zendr", "dim"];
    return h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(5).bg(t[color] + "22").text_size(10.5).font_semibold().text_color(t[color])
      .when(status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).spin(900)))
      .child(label);
  }

  card(t, r, lead) {
    const title = r.title && r.title !== r.app && r.title !== r.name ? r.title : null;
    const selected = r.peer && this.to === r.peer.name;
    return v_flex().id(`hub-${r.key}`).w_full().flex_none().p(10).gap(4).rounded(9).border_1()
      .border_color(lead ? t.accent : r.status === "blocked" ? t.blocked : selected ? t.accent + "88" : t.border)
      .bg(lead ? t.accent + "12" : t.raised).cursor_pointer().hover(s => s.bg(t.hover))
      .tooltip(r.address ? "Show this agent's terminal" : "Runs outside Zendr")
      .on_click(() => { if (r.address) this.show(r.address); })
      .child(h_flex().gap(7).items_center()
        .when(lead, el => el.child(svg("mods/hub/crown.svg").size(14).flex_none().text_color(t.accent)))
        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(r.name ?? "agent"))
        .when(Boolean(r.role && r.role !== "general" && r.role !== COORDINATOR), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(r.role)))
        .child(div().flex_1())
        .child(this.statusPill(t, r.status)))
      .when(Boolean(r.space), el => el.child(div().truncate().text_size(11).text_color(t.dim).child(r.peer ? `${r.space}` : `${r.space} · not on the bridge`)))
      .when(Boolean(title), el => el.child(div().truncate().text_size(12).text_color(t.muted).child(title)))
      .when(Boolean(r.summary), el => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(r.summary)))
      .when(Boolean(r.peer), el => el.child(h_flex().pt(2).gap(6)
        .child(this.button(t, `hub-msg-${r.key}`, "mods/hub/send.svg", selected ? "Messaging" : "Message", `Write to ${r.peer.name}`, () => this.target(r.peer.name), selected))));
  }

  target(name) {
    this.to = name;
    this.input.set_placeholder?.(name === "*" ? "Message every agent…" : `Message ${name}…`);
    this.input.focus?.();
  }

  button(t, id, icon, label, tip, fn, on = false) {
    return h_flex().id(id).flex_none().h(24).px(8).gap(5).items_center().rounded(6).text_size(11.5)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).border_1().border_color(t.border)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .when(Boolean(icon), el => el.child(svg(icon).size(12)))
      .child(label);
  }

  section(t, label, extra) {
    return h_flex().px(2).pt(10).pb(4).gap(6).items_center().text_size(10.5).font_semibold().text_color(t.dim).child(label.toUpperCase()).when(Boolean(extra), el => el.child(extra));
  }

  render(cx) {
    const t = theme();
    const rows = this.people();
    const lead = rows.find(r => isCoordinator(r.peer));
    const others = rows.filter(r => r !== lead);
    const onBridge = this.peers.length;
    const names = [...new Set(this.peers.map(p => p.name))];
    if (this.to !== "*" && this.to !== COORDINATOR && !names.includes(this.to)) this.to = lead ? COORDINATOR : names[0] ?? COORDINATOR;
    const chip = (name, label) => this.button(t, `hub-to-${name}`, null, label, name === "*" ? "Send to every session on the bridge" : `Send to ${name}`, () => this.target(name), this.to === name);

    return v_flex().id("hub").size_full().min_h(0).bg(t.background).border_l(1).border_color(t.border).text_color(t.foreground).text_size(12.5)
      // Header
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/hub/users.svg").size(15).text_color(t.muted))
        .child(div().font_semibold().child("Hub"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(`${rows.length} agent${rows.length === 1 ? "" : "s"} · ${onBridge} on the bridge`)))
      .child(v_flex().id("hub-body").flex_1().min_h(0).overflow_y_scroll().px(10).pb(10)
        // Coordinator
        .child(this.section(t, "Coordinator"))
        .child(lead ? this.card(t, lead, true) : v_flex().w_full().p(10).gap(8).rounded(9).border_1().border_color(t.border).bg(t.raised)
          .child(div().text_size(12).text_color(t.muted).child(this.bridge === false
            ? "The session bridge isn't set up yet. Install the session-bridge mod in Claude Code, then start a coordinator here."
            : "No coordinator yet. A coordinator is a Claude Code session that plans the work and messages the other agents for you."))
          .child(h_flex().child(this.button(t, "hub-start", "mods/hub/crown.svg", "Start coordinator", "Open a new space running Claude Code as the coordinator", (cx) => this.startCoordinator(cx), true))))
        // Agents
        .child(this.section(t, "Agents", others.length ? div().text_color(t.dim).child(String(others.length)) : null))
        .when(!others.length, el => el.child(div().px(2).text_size(12).text_color(t.dim).child("No agents running. Start Claude Code in any space.")))
        .children(others.map(r => div().pb(6).child(this.card(t, r, false))))
        // Messages
        .child(this.section(t, "Messages"))
        .when(!this.feed.length, el => el.child(div().px(2).text_size(12).text_color(t.dim).child("Messages between sessions appear here.")))
        .children(this.feed.slice(-40).map(e => v_flex().w_full().flex_none().px(8).py(6).gap(2).rounded(7).hover(s => s.bg(t.hover))
          .child(h_flex().gap(5).items_center().text_size(11)
            .child(div().font_semibold().text_color(e.from?.name === ME.name ? t.accent : t.foreground).child(e.from?.name === ME.name ? "You" : e.from?.name ?? "?"))
            .child(div().text_color(t.dim).child("→"))
            .child(div().min_w(0).truncate().text_color(t.muted).child((e.to ?? []).join(", ")))
            .when(e.kind && e.kind !== "message", el => el.child(div().flex_none().px(5).rounded(4).bg(t.chrome).text_size(10).text_color(t.dim).child(e.kind)))
            .child(div().flex_1())
            .child(div().flex_none().text_color(t.dim).child(ago(e.at))))
          .child(div().truncate().text_size(12).text_color(t.foreground).child(e.preview ?? "")))))
      // Composer
      .child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.chrome)
        .child(h_flex().gap(5).flex_wrap().items_center()
          .child(div().text_size(11).text_color(t.dim).child("To"))
          .child(chip(COORDINATOR, "Coordinator"))
          .children(names.filter(n => n !== COORDINATOR).map(n => chip(n, n)))
          .when(names.length > 1, el => el.child(chip("*", "Everyone"))))
        .child(h_flex().gap(6).items_center()
          .child(div().id("hub-input").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).bg(t.background).border_1()
            .border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
          .child(h_flex().id("hub-send").flex_none().h(32).px(12).gap(6).items_center().rounded(8).bg(t.accent).text_color(t.accent_foreground ?? t.background)
            .text_size(12).font_semibold().cursor_pointer().hover(s => s.opacity(0.9)).tooltip("Send (Enter)")
            .on_click((_e, cx) => this.send(cx))
            .child(svg("mods/hub/send.svg").size(13)).child("Send")))
        .child(div().text_size(10.5).text_color(this.error ? t.blocked : t.dim).child(this.error ?? `Sends as you (${ME.name}). Agents read it as a message from a peer.`)));
  }
}
