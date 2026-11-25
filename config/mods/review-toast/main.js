// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action, kind }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.
// Like cmux, every toast also goes into the notification inbox (shared("inbox.log"),
// shown by the inbox mod), unless it repeats an entry review-tabs just logged (agent or session bridge).
// Settings → Notifications (shared("notify.prefs")) says which kinds pop up at all, and
// do not disturb holds them all; held ones still reach the inbox.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, shared, setShared } from "herdr";

const icon = (name) => `mods/inbox/${name}.svg`;
// Each kind in words and an icon, as the inbox shows them.
const KINDS = {
  blocked: { label: "Needs you", icon: "alert", color: "blocked" },
  done: { label: "Finished", icon: "done", color: "done" },
  bridge: { label: "Message", icon: "message", color: "accent" },
  error: { label: "Error", icon: "alert", color: "blocked" },
  warning: { label: "Warning", icon: "alert", color: "working" },
  other: { label: "Notice", icon: "info", color: "accent" },
};

let seq = 0;

// blocked, done, bridge or other: what Settings → Notifications calls it. The app names
// its agent toasts (kind); older builds only say so by their action and level.
function noteKind(p) {
  if (p.kind === "blocked" || p.kind === "done" || p.kind === "bridge" || p.kind === "other") return p.kind;
  if (p.action?.name === "agent.focus") return p.level === "error" ? "blocked" : "done";
  return "other";
}
const look = (p, kind) => KINDS[kind === "other" ? (p.level === "error" ? "error" : p.level === "warning" ? "warning" : "other") : kind];

function remember(p, kind) {
  if (!p.title && !p.body) return;
  // review-tabs logs agents and the session bridge itself.
  if (kind === "bridge" || (shared("notify.prefs") ?? {})[kind]?.inbox === false) return;
  const log = shared("inbox.log") ?? [], now = Date.now();
  const terminal = p.action?.args?.terminal;
  if (terminal && log.some(e => e.kind !== "toast" && e.terminal === terminal && now - e.at < 10000)) return;
  const entry = { id: `toast-${now}-${seq++}`, at: now, kind: "toast", note: kind, level: p.level ?? "info", title: p.title ?? "", body: p.body ?? "",
    terminal, action: p.action?.name ? { name: p.action.name, args: p.action.args ?? {} } : null, read: false };
  const keep = Number((shared("notify.prefs") ?? {}).keep) || 200;
  setShared("inbox.log", [entry, ...log].slice(0, keep));
}

export default class Toast extends View {
  init() {
    const p = props() ?? {}, prefs = shared("notify.prefs") ?? {};
    this.kind = noteKind(p);
    remember(p, this.kind);
    // Held: do not disturb, or this kind doesn't pop up.
    this.held = (prefs.quiet_until ?? 0) > Date.now() || prefs[this.kind]?.popup === false;
    if (this.held) closeOverlay(p.overlay);
  }

  render(cx) {
    if (this.held) return div();
    const t = theme();
    const p = props() ?? {};
    const k = look(p, this.kind), color = t[k.color] ?? t.accent;
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const text = (value) => p.fitHeight
      ? div().child(typeof value === "string" && value.length > 180 ? value.slice(0, 179) + "…" : value)
      : div().truncate().child(typeof value === "string" ? value.split("\n", 1)[0] : value);
    return h_flex()
      .id("toast")
      .when(p.fitHeight, (el) => el.w_full().min_h(64).flex_none().py(11))
      .when(!p.fitHeight, (el) => el.size_full())
      .pl(14)
      .pr(8)
      .gap(11)
      .items_start()
      .bg(t.popover)
      .border_l(3)
      .border_color(color)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon
        ? image(p.icon).w(18).h(18).mt(4).flex_none()
        : div().mt(1).size(28).flex_none().flex().items_center().justify_center().rounded(14).bg(color + "26").child(svg(icon(k.icon)).size(15).text_color(color)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(10.5).font_semibold().text_color(color).child(k.label.toUpperCase()))
          .child(text(login ? `${login[1]} needs a login: run` : p.title ?? "").font_semibold().text_size(13).line_height("18px").text_color(t.foreground))
          .when(!login && Boolean(p.body), (el) => el.child(text(p.body).text_size(12).line_height("16px").text_color(t.muted)))
          .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      )
      .child(div().id("toast-close").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover(s => s.bg(t.raised).text_color(t.foreground)).tooltip("Dismiss")
        .on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(p.overlay); })
        .child(svg(icon("x")).size(13)));
  }
}
