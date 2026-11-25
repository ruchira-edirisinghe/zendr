// Colours for telling sessions apart. A session (a terminal: an agent's, or a tab's)
// can have its own colour, kept by address in shared("agent.colors"); without one it
// shows its space's (shared("space.colors"), the avatar colour every mod already uses).
// The agents list, the tabs, the hub and the pane header draw it.
// Opened as a popup: openOverlay({ mod: "session-color", kind: "popup", width: 268,
//   props: { kind: "agent" | "space", id, name } })  (id: a terminal address or space id)
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";

// The space palette's six (same values as the spaces mods' MARK), then six more.
// Names go with them, so a colour is never only a colour.
export const COLORS = [
  ["ansi6", "Teal", "#22a99a"], ["ansi3", "Orange", "#e3814f"], ["ansi4", "Blue", "#5b8def"],
  ["ansi5", "Violet", "#8b7cf6"], ["ansi2", "Green", "#3fae6a"], ["ansi1", "Pink", "#d9649a"],
  ["#e05555", "Red", "#e05555"], ["#d4a72c", "Gold", "#d4a72c"], ["#3bb6d6", "Sky", "#3bb6d6"],
  ["#8cbf3f", "Lime", "#8cbf3f"], ["#b06ad9", "Plum", "#b06ad9"], ["#8a94a6", "Slate", "#8a94a6"],
];
const HEX = Object.fromEntries(COLORS.map(([v, , hex]) => [v, hex]));
export const colorName = (v) => COLORS.find(([c]) => c === v)?.[1] ?? v;
export const hex = (v) => (v ? HEX[v] ?? (v.startsWith("#") ? v : null) : null);

export default class SessionColor extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The keyboard's place: a swatch (0-11) or "same as its space" (12). Starts on the current one.
    const p = props() ?? {};
    const now = p.kind === "space" ? (shared("space.colors") ?? {})[p.id] : (shared("agent.colors") ?? {})[p.id];
    const i = COLORS.findIndex(([c]) => c === now);
    this.at = i < 0 ? COLORS.length : i;
  }

  close() { closeOverlay(props()?.overlay); }

  pick(value) {
    const p = props() ?? {};
    if (p.kind === "space") {
      // A space always has one: "Automatic" gives back the next free palette colour.
      const all = { ...(shared("space.colors") ?? {}) };
      if (value) all[p.id] = value; else delete all[p.id];
      setShared("space.colors", all);
    } else {
      const all = { ...(shared("agent.colors") ?? {}) };
      if (value) all[p.id] = value; else delete all[p.id];
      setShared("agent.colors", all);
    }
    this.close();
  }

  render() {
    const t = theme(), p = props() ?? {};
    const space = p.kind === "space";
    const now = space ? (shared("space.colors") ?? {})[p.id] : (shared("agent.colors") ?? {})[p.id];
    const swatch = ([value, name, color]) => v_flex().id(`sc-${name}`).w(52).py(6).gap(4).items_center().rounded(8).cursor_pointer()
      .when(now === value, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).tooltip(name)
      .when(COLORS[this.at]?.[0] === value, el => el.border_1().border_color(t.accent))
      .on_click(() => this.pick(value))
      .child(div().size(24).rounded(12).bg(color).flex().items_center().justify_center()
        .when(now === value, el => el.border_2().border_color(t.foreground).child(svg("mods/session-color/check.svg").size(13).text_color("#ffffff"))))
      .child(div().text_size(10.5).text_color(now === value ? t.foreground : t.muted).child(name));
    return v_flex().id("session-color").track_focus(this.handle).w_full().p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        const last = COLORS.length;
        if (e.key === "escape") this.close();
        else if (e.key === "enter" || e.key === "space") this.pick(this.at < last ? COLORS[this.at][0] : null);
        else if (e.key === "right") this.at = Math.min(last, this.at + 1);
        else if (e.key === "left") this.at = Math.max(0, this.at - 1);
        else if (e.key === "down") this.at = Math.min(last, this.at + 4);
        else if (e.key === "up") this.at = this.at === last ? last - 4 : Math.max(0, this.at - 4);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().px(4).pt(2).gap(7).items_center()
        .child(svg("mods/session-color/palette.svg").size(14).text_color(t.muted))
        .child(div().min_w(0).truncate().font_semibold().child(`Colour for ${p.name || (space ? "this space" : "this session")}`)))
      .child(div().px(4).text_size(11).text_color(t.dim).child(space
        ? "The space's avatar, and its sessions unless they have their own."
        : "Shows on its row in Agents, its tab and its hub card."))
      .child(div().px(4).text_size(10.5).text_color(t.dim).child("Arrows and Enter work too."))
      .child(div().flex().flex_wrap().gap(2).children(COLORS.map(swatch)))
      .child(h_flex().id("sc-auto").h(30).px(8).gap(8).items_center().rounded(7).cursor_pointer().border_1()
        .border_color(this.at === COLORS.length ? t.accent : now ? t.border : t.accent + "88")
        .when(!now, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click(() => this.pick(null))
        .child(div().size(14).rounded(7).border_1().border_color(t.dim))
        .child(div().flex_1().text_size(12).child(space ? "Automatic" : "Same as its space"))
        .when(!now, el => el.child(svg("mods/session-color/check.svg").size(13).text_color(t.accent))));
  }
}
