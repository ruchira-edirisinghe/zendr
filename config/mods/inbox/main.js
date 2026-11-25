// Notifications, as a drawer on the right (the layout's "side" stack, beside the hub).
// What needs you is pinned on top as cards with Go to it / Dismiss; everything else is a
// quiet timeline below, by day. The log is shared("inbox.log"), written by review-tabs
// (agents, the session bridge) and review-toast (other toasts). Preferences: Settings →
// Notifications (shared("notify.prefs")). Opened by the toolbar's Notifications toggle
// (Ctrl+Shift+I); without a "side" drawer in the layout it opens as a popup instead.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, shared, setShared, appHome, readTextFile, writeTextFile } from "herdr";

const icon = (name) => `mods/inbox/${name}.svg`;
// Every kind says itself in words and an icon, not by colour alone.
const KINDS = {
  blocked: { label: "Needs you", icon: "alert", color: "blocked" },
  done: { label: "Finished", icon: "done", color: "done" },
  bridge: { label: "Message", icon: "message", color: "accent" },
  error: { label: "Error", icon: "alert", color: "blocked" },
  warning: { label: "Warning", icon: "alert", color: "working" },
  other: { label: "Notice", icon: "info", color: "accent" },
};
const FOREVER = 9e12;

export function kindOf(e) {
  if (e.kind === "agent") return e.status === "blocked" ? "blocked" : "done";
  if (e.kind === "bridge") return "bridge";
  if (e.kind === "toast" && (e.note === "blocked" || e.note === "done" || e.note === "bridge")) return e.note;
  // The app's agent toasts from before they were named: "<agent> needs you" / "finished".
  if (e.kind === "toast" && !e.note && e.action?.name === "agent.focus") return e.level === "error" ? "blocked" : "done";
  return e.level === "error" ? "error" : e.level === "warning" ? "warning" : "other";
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
const clock = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
function day(at) {
  const d = new Date(at), today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return at >= start ? "Earlier today" : at >= start - 86400000 ? "Yesterday" : `${d.getDate()} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]}`;
}

// What a notification says, in one line, and who it's from.
function headline(e) {
  if (e.kind !== "agent") return e.title || "Notification";
  const said = e.body && e.body.toLowerCase() !== (e.app ?? "").toLowerCase() && !/^(claude|codex|gemini|opencode|amp)$/i.test(e.body) ? e.body : null;
  return said ?? `${e.space_name ?? "An agent"} ${kindOf(e) === "blocked" ? "needs you" : "finished"}`;
}
const who = (e) => [e.space_name || (e.kind === "bridge" ? "Session bridge" : null), e.kind === "agent" ? e.app : null].filter(Boolean).join(" · ");
const detail = (e) => (e.kind === "agent" ? null : e.body || null);
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

const setLog = (fn) => setShared("inbox.log", fn(shared("inbox.log") ?? []));

// Goes to where a notification came from and marks it read.
export function open(entry) {
  if (!entry) return;
  setLog((log) => log.map((e) => (e.id === entry.id ? { ...e, read: true } : e)));
  if (entry.terminal) {
    if (entry.space) run("space.select", { id: entry.space });
    if (entry.tab) run("tab.select", { id: entry.tab });
    run("pane.focus", { terminal: entry.terminal });
  } else if (entry.action?.name) run(entry.action.name, entry.action.args ?? {});
}

// Changes settings.json's `notifications` the way the Settings screen does: only if
// nobody changed the file meanwhile.
async function changeNotes(edit) {
  const file = `${appHome()}/settings.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readTextFile(file).catch(() => null);
    let person;
    try { person = raw ? JSON.parse(raw) : {}; } catch { return false; }
    if (!person || typeof person !== "object" || Array.isArray(person)) return false;
    person.notifications = { ...(person.notifications ?? {}) };
    edit(person.notifications);
    try { await writeTextFile(file, JSON.stringify(person, null, 2) + "\n", raw); return true; } catch {}
  }
  return false;
}

export default class Inbox extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (props()?.overlay) this.handle.focus();
    cx.timer.every(30000, (cx) => cx.notify()); // "5m" keeps moving.
  }

  close() {
    if (props()?.overlay) closeOverlay(props().overlay);
    else run("layout.hide", { id: "side" });
  }

  iconButton(t, id, name, tip, fn) {
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .child(svg(icon(name)).size(15));
  }

  button(t, id, name, label, tip, fn, primary = false) {
    return h_flex().id(id).h(30).px(11).gap(6).flex_none().items_center().justify_center().rounded(7).text_size(12).cursor_pointer().tooltip(tip)
      .when(primary, (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold().hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.bg(t.raised).border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .when(Boolean(name), (el) => el.child(svg(icon(name)).size(13)))
      .child(label);
  }

  // Something waiting on you: a card you act on.
  card(t, e) {
    const k = KINDS[kindOf(e)], color = t[k.color] ?? t.accent, more = detail(e);
    return v_flex().id(`inbox-card-${e.id}`).w_full().flex_none().p(12).gap(8).rounded(10).bg(color + "14").border_1().border_color(color + "66")
      .child(h_flex().gap(8).items_center()
        .child(svg(icon(k.icon)).size(15).flex_none().text_color(color))
        .child(div().flex_none().text_size(11).font_semibold().text_color(color).child(k.label.toUpperCase()))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(who(e)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(e.at))))
      .child(div().text_size(13).line_height("18px").font_semibold().text_color(t.foreground).child(cut(headline(e), 160)))
      .when(Boolean(more), (el) => el.child(div().text_size(12).line_height("17px").text_color(t.muted).child(cut(more, 200))))
      .child(h_flex().gap(8)
        .child(this.button(t, `inbox-go-${e.id}`, null, "Go to it", "Show where this came from", () => open(e), true))
        .child(this.button(t, `inbox-dismiss-${e.id}`, null, "Dismiss", "Mark it read and move it down", () => setLog((log) => log.map((x) => (x.id === e.id ? { ...x, read: true } : x))))));
  }

  // Everything else: one quiet line each.
  line(t, e) {
    const k = KINDS[kindOf(e)], color = t[k.color] ?? t.accent, from = who(e);
    return h_flex().id(`inbox-${e.id}`).w_full().flex_none().px(10).py(8).gap(10).items_start().rounded(8).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`${k.label}. Click to go there.`)
      .on_click(() => open(e))
      .child(div().relative().mt(1).flex_none().child(svg(icon(k.icon)).size(15).text_color(e.read ? t.dim : color))
        .when(!e.read, (el) => el.child(div().absolute().top(-2).right(-3).size(7).rounded(4).bg(t.accent))))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(e.read ? t.muted : t.foreground).when(!e.read, (el) => el.font_semibold()).child(headline(e)))
        .child(div().truncate().text_size(11).text_color(t.dim).child([k.label, from].filter(Boolean).join(" · "))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(e.at)))
      .child(div().id(`inbox-x-${e.id}`).flex_none().size(20).flex().items_center().justify_center().rounded(5).text_color(t.dim)
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Remove")
        .on_click((_e, cx) => { cx.stop_propagation(); setLog((log) => log.filter((x) => x.id !== e.id)); cx.notify(); })
        .child(svg(icon("x")).size(12)));
  }

  section(t, label, count) {
    return h_flex().px(4).pt(14).pb(6).gap(6).items_center().text_size(11).font_semibold().text_color(t.dim)
      .child(label.toUpperCase()).when(count != null, (el) => el.child(div().text_color(t.dim).child(`(${count})`)));
  }

  render(cx) {
    const t = theme(), log = shared("inbox.log") ?? [], prefs = shared("notify.prefs") ?? {};
    const unread = log.filter((e) => !e.read).length;
    const quiet = (prefs.quiet_until ?? 0) > Date.now();
    const waiting = log.filter((e) => !e.read && kindOf(e) === "blocked");
    const rest = log.filter((e) => !waiting.includes(e));
    const timeline = [];
    let last = null;
    for (const e of rest) {
      const d = day(e.at);
      if (d !== last) { timeline.push(this.section(t, d)); last = d; }
      timeline.push(this.line(t, e));
    }

    return v_flex().id("inbox").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .when(!props()?.overlay, (el) => el.border_l(1).border_color(t.border))
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      // Header
      .child(h_flex().h(46).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(icon("bell")).size(16).text_color(t.muted))
        .child(div().font_semibold().text_size(14).child("Notifications"))
        .when(unread > 0, (el) => el.child(div().px(7).h(18).flex().items_center().rounded(9).bg(t.accent).text_size(10.5).font_semibold().text_color(t.accent_foreground).child(`${unread} new`)))
        .child(div().flex_1())
        .child(this.iconButton(t, "inbox-settings", "settings", "Notification settings", () => run("app.settings", { section: "alerts" })))
        .child(this.iconButton(t, "inbox-close", "x", "Close (Esc)", () => this.close())))
      // Do not disturb
      .when(quiet, (el) => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().bg(t.working + "18").border_b(1).border_color(t.border)
        .child(svg(icon("moon")).size(14).text_color(t.working))
        .child(div().flex_1().min_w(0).text_size(12).child(prefs.quiet_until >= FOREVER ? "Do not disturb is on" : `Do not disturb until ${clock(prefs.quiet_until)}`))
        .child(this.button(t, "inbox-dnd-off", null, "Turn off", "Show pop-ups and play sounds again", () => changeNotes((x) => { delete x.quiet_until; delete x.quiet_mode; })))))
      // Body
      .child(v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scroll().px(10).pb(12)
        .when(waiting.length > 0, (el) => el.child(this.section(t, "Needs you", waiting.length))
          .child(v_flex().gap(8).children(waiting.map((e) => this.card(t, e)))))
        .children(timeline)
        .when(!log.length, (el) => el.child(v_flex().pt(48).px(20).gap(8).items_center()
          .child(svg(icon("bell")).size(26).text_color(t.dim))
          .child(div().font_semibold().text_color(t.muted).child("You're all caught up"))
          .child(div().text_size(12).text_color(t.dim).text_center().child("When an agent needs you or finishes, it shows up here.")))))
      // Footer
      .child(h_flex().flex_none().p(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(this.button(t, "inbox-read", "read", "Mark all read", "Mark every notification read", () => setLog((l) => l.map((e) => ({ ...e, read: true })))))
        .when(!quiet, (el) => el.child(this.button(t, "inbox-dnd", "moon", "Pause 1h", "Do not disturb: hold pop-ups and sounds for an hour",
          () => changeNotes((x) => { x.quiet_until = Date.now() + 3600000; x.quiet_mode = "hour"; }))))
        .child(div().flex_1())
        .child(this.iconButton(t, "inbox-clear", "trash", "Clear all notifications", () => setLog(() => []))));
  }
}
