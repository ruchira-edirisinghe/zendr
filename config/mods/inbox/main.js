// Notifications, like cmux's panel: every time an agent needed you or finished, every
// session-bridge message and every other toast, newest first, grouped by day. Filter by
// kind, go to one (click or Enter), remove one, or pause them all (do not disturb).
// The log is shared("inbox.log"), written by review-tabs (agents, the bridge) and
// review-toast (other toasts). Preferences: Settings → Notifications (settings.json
// `notifications`, read for everyone by review-tabs into shared("notify.prefs")).
// Opened as a popup: openOverlay({ mod: "inbox", kind: "popup", ... }).
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
const FILTERS = [["all", "All"], ["unread", "Unread"], ["blocked", "Needs you"], ["done", "Finished"], ["bridge", "Messages"]];
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
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
const clock = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
function day(at) {
  const d = new Date(at), today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return at >= start ? "Today" : at >= start - 86400000 ? "Yesterday" : `${d.getDate()} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]}`;
}

// Goes to where a notification came from and marks it read.
export function open(entry) {
  if (!entry) return;
  setShared("inbox.log", (shared("inbox.log") ?? []).map(e => e.id === entry.id ? { ...e, read: true } : e));
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
    try { await writeTextFile(file, JSON.stringify(person, null, 2) + "\n", raw); setShared("notify.prefs.changed", Date.now()); return true; } catch {}
  }
  return false;
}

export default class Inbox extends View {
  init(_props, cx) {
    this.at = 0;
    try { this.filter = localStorage.getItem("filter") ?? "all"; } catch { this.filter = "all"; }
    if (!FILTERS.some(([f]) => f === this.filter)) this.filter = "all";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.every(30000, cx => cx.notify()); // "5m ago" keeps moving.
  }

  close() { closeOverlay(props()?.overlay); }

  setFilter(f) { this.filter = f; this.at = 0; try { localStorage.setItem("filter", f); } catch {} }

  remove(entry) { setShared("inbox.log", (shared("inbox.log") ?? []).filter(e => e.id !== entry.id)); }

  shown(log) {
    const f = this.filter;
    return f === "all" ? log : f === "unread" ? log.filter(e => !e.read) : log.filter(e => kindOf(e) === f);
  }

  iconButton(t, id, name, tip, fn) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .child(svg(icon(name)).size(14));
  }

  textButton(t, id, name, label, tip, fn) {
    return h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(11.5).text_color(t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .when(Boolean(name), el => el.child(svg(icon(name)).size(13)))
      .child(label);
  }

  row(t, e, i) {
    const k = KINDS[kindOf(e)], color = t[k.color] ?? t.accent;
    const who = e.space_name || (e.kind === "bridge" ? "Session bridge" : e.kind === "toast" ? null : "Agent");
    // An agent's title is what it's doing; a bare program name says nothing, so say what happened.
    const said = e.kind === "agent" && e.body && e.body.toLowerCase() !== (e.app ?? "").toLowerCase() && !/^(claude|codex|gemini|opencode|amp)$/i.test(e.body) ? e.body : null;
    const headline = e.kind === "agent" ? said ?? `${e.space_name ?? "An agent"} ${kindOf(e) === "blocked" ? "needs you" : "finished"}` : e.title || "Notification";
    const detail = e.kind === "agent" ? null : e.body;
    return h_flex().id(`inbox-${e.id}`).w_full().flex_none().px(10).py(8).gap(10).items_start().rounded(8).cursor_pointer()
      .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .on_click(() => { open(e); this.close(); })
      .child(div().relative().mt(1).size(28).flex_none().flex().items_center().justify_center().rounded(14).bg(color + (e.read ? "14" : "26"))
        .child(svg(icon(k.icon)).size(15).text_color(e.read ? t.dim : color))
        .when(!e.read, el => el.child(div().absolute().top(-1).right(-1).size(9).rounded(5).bg(t.accent).border_2().border_color(t.popover))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_size(10.5).font_semibold().text_color(e.read ? t.dim : color).child(k.label.toUpperCase()))
          .when(Boolean(who), el => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(`· ${who}`)))
          .child(div().flex_1())
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(e.at))))
        .child(div().text_size(12.5).line_height("17px").text_color(e.read ? t.muted : t.foreground).when(!e.read, el => el.font_semibold())
          .child(headline.length > 140 ? headline.slice(0, 139) + "…" : headline))
        .when(Boolean(detail), el => el.child(div().text_size(11.5).line_height("16px").text_color(t.muted).child(detail.length > 160 ? detail.slice(0, 159) + "…" : detail))))
      .child(this.iconButton(t, `inbox-x-${e.id}`, "x", "Remove this notification", () => this.remove(e)));
  }

  render(cx) {
    const t = theme(), log = shared("inbox.log") ?? [], prefs = shared("notify.prefs") ?? {};
    const unread = log.filter(e => !e.read).length;
    const list = this.shown(log);
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const quiet = (prefs.quiet_until ?? 0) > Date.now();
    const count = (f) => f === "all" ? log.length : f === "unread" ? unread : log.filter(e => kindOf(e) === f).length;

    // Rows with a heading wherever the day changes.
    const rows = [];
    let last = null;
    list.forEach((e, i) => {
      const d = day(e.at);
      if (d !== last) { rows.push(div().px(10).pt(rows.length ? 10 : 4).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(d.toUpperCase())); last = d; }
      rows.push(this.row(t, e, i));
    });

    return v_flex().id("inbox").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = Math.min(list.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else if (e.key === "enter") { open(list[this.at]); this.close(); }
        else if (e.key === "delete" || e.key === "backspace") { if (list[this.at]) this.remove(list[this.at]); }
        else if (e.key === "tab") { const i = FILTERS.findIndex(([f]) => f === this.filter); this.setFilter(FILTERS[(i + 1) % FILTERS.length][0]); }
        else if (e.key === "escape") this.close();
        else return;
        cx.notify();
      })
      // Header
      .child(h_flex().h(44).flex_none().pl(14).pr(8).gap(8).items_center()
        .child(svg(icon("bell")).size(15).text_color(t.muted))
        .child(div().font_semibold().text_size(13.5).child("Notifications"))
        .when(unread > 0, e => e.child(div().px(6).h(18).flex().items_center().rounded(9).bg(t.accent).text_size(10.5).font_semibold().text_color(t.accent_foreground).child(`${unread} new`)))
        .child(div().flex_1())
        .when(unread > 0, el => el.child(this.textButton(t, "inbox-read", "read", "Mark all read", "Mark every notification read", () => setShared("inbox.log", log.map(e => ({ ...e, read: true }))))))
        .child(this.iconButton(t, "inbox-clear", "trash", "Clear all notifications", () => setShared("inbox.log", [])))
        .child(this.iconButton(t, "inbox-settings", "settings", "Notification settings", () => { run("app.settings", { section: "alerts" }); this.close(); })))
      // Filters
      .child(h_flex().flex_none().px(10).pb(8).gap(4).flex_wrap().border_b(1).border_color(t.border)
        .children(FILTERS.map(([f, label]) => {
          const on = this.filter === f, n = count(f);
          return h_flex().id(`inbox-f-${f}`).h(24).px(8).gap(5).items_center().rounded(12).text_size(11.5).cursor_pointer()
            .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.accent + "88" : t.border)
            .hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.setFilter(f); cx.notify(); })
            .child(label)
            .when(n > 0, el => el.child(div().text_size(10.5).text_color(t.dim).child(String(n))));
        })))
      // Do not disturb
      .when(quiet, el => el.child(h_flex().flex_none().px(14).py(7).gap(8).items_center().bg(t.working + "18").border_b(1).border_color(t.border)
        .child(svg(icon("moon")).size(13).text_color(t.working))
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground)
          .child(prefs.quiet_until >= FOREVER ? "Do not disturb is on" : `Do not disturb until ${clock(prefs.quiet_until)}`))
        .child(this.textButton(t, "inbox-dnd-off", null, "Turn off", "Show pop-ups and play sounds again", () => changeNotes(x => { delete x.quiet_until; delete x.quiet_mode; })))))
      // List
      .child(v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scroll().p(6)
        .children(rows)
        .when(!list.length, e => e.child(v_flex().p(24).gap(6).items_center()
          .child(svg(icon(this.filter === "all" ? "bell" : "done")).size(22).text_color(t.dim))
          .child(div().text_color(t.muted).child(this.filter === "all" ? "No notifications yet" : "Nothing here"))
          .child(div().text_size(11.5).text_color(t.dim).child(this.filter === "all" ? "Agents that finish or need you show up here." : "Try another filter.")))))
      // Footer
      .child(h_flex().h(34).flex_none().px(8).gap(6).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .when(!quiet, el => el.child(this.textButton(t, "inbox-dnd", "moon", "Pause 1 hour", "Do not disturb: hold pop-ups and sounds for an hour",
          () => changeNotes(x => { x.quiet_until = Date.now() + 3600000; x.quiet_mode = "hour"; }))))
        .child(div().flex_1())
        .child(div().pr(6).child("↑↓ Enter · Del removes · Tab filters")));
  }
}
