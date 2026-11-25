// Notifications, like cmux's panel: every time an agent needed you or finished, and every
// toast, newest first. Unread ones are marked; click one (or Enter) to go there.
// The log is shared("inbox.log"), written by review-tabs (agents) and review-toast (toasts).
// Opened as a popup or dialog: openOverlay({ mod: "inbox", ... }).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, shared, setShared } from "herdr";

const DOT = { blocked: "blocked", done: "done", error: "blocked", warning: "working", success: "done", info: "accent" };

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// Goes to where a notification came from and marks it read.
export function open(entry) {
  if (!entry) return;
  const log = (shared("inbox.log") ?? []).map(e => e.id === entry.id ? { ...e, read: true } : e);
  setShared("inbox.log", log);
  if (entry.terminal) {
    if (entry.space) run("space.select", { id: entry.space });
    if (entry.tab) run("tab.select", { id: entry.tab });
    run("pane.focus", { terminal: entry.terminal });
  } else if (entry.action?.name) run(entry.action.name, entry.action.args ?? {});
}

export default class Inbox extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.every(30000, cx => cx.notify()); // "5m ago" keeps moving.
  }

  close() { closeOverlay(props()?.overlay); }

  render(cx) {
    const t = theme(), log = shared("inbox.log") ?? [], unread = log.filter(e => !e.read).length;
    this.at = Math.min(this.at, Math.max(0, log.length - 1));
    const action = (id, label, fn) => div().id(id).px(8).h(24).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { fn(); cx.notify(); }).child(label);
    return v_flex().id("inbox").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = Math.min(log.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else if (e.key === "enter") { open(log[this.at]); this.close(); }
        else if (e.key === "escape") this.close();
        else return;
        cx.notify();
      })
      .child(h_flex().h(40).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Notifications"))
        .when(unread > 0, e => e.child(div().px(6).h(18).flex().items_center().rounded(9).bg(t.accent).text_size(10.5).text_color(t.accent_foreground).child(String(unread))))
        .child(div().flex_1())
        .child(action("inbox-read", "Mark all read", () => setShared("inbox.log", log.map(e => ({ ...e, read: true })))))
        .child(action("inbox-clear", "Clear", () => setShared("inbox.log", []))))
      .child(v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scroll().p(5)
        .children(log.map((e, i) => h_flex().id(`inbox-${e.id}`).w_full().flex_none().px(8).py(7).gap(9).items_start().rounded(7).cursor_pointer()
          .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .on_click(() => { open(e); this.close(); })
          .child(div().mt(5).size(7).flex_none().rounded(4).bg(e.read ? t.border : t[DOT[e.status ?? e.level] ?? "accent"]))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(h_flex().gap(6).child(div().flex_1().min_w(0).truncate().font_semibold().text_color(e.read ? t.muted : t.foreground).child(e.title || "Notification"))
              .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(e.at))))
            .when(Boolean(e.body), el => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(e.body)))
            .when(Boolean(e.space_name), el => el.child(div().truncate().text_size(10.5).text_color(t.dim).child([e.space_name, e.app].filter(Boolean).join(" · ")))))))
        .when(!log.length, e => e.child(div().p(16).text_color(t.dim).child("No notifications yet. Agents that finish or need you show up here."))))
      .child(h_flex().h(26).flex_none().px(12).gap(12).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("Ctrl+Shift+U: latest unread").child("Ctrl+Shift+I: this panel"));
  }
}
