// An emoji for a space's avatar, in place of its first letter. Kept by space id in
// shared("space.icons"); the Sessions list, the old spaces list and the space picker draw it.
// Opened as a popup: openOverlay({ mod: "space-icon", kind: "popup", width: 360, height: 420,
//   props: { id, name } })
// Emoji names and groups: unicode-emoji-json 0.9.0 by Mu-An Chiou (MIT, see LICENSE-unicode-emoji-json),
// kept to Emoji 15.0 so Windows' Segoe UI Emoji can draw every one.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, appHome, readTextFile } from "herdr";

const COLS = 9;
const RECENT_MAX = 18;
const MAX_HITS = 180;

export default class SpaceIcon extends View {
  init(_props, cx) {
    this.groups = [];
    this.group = -1; // -1: recent (or the first group when there are none)
    this.query = "";
    this.at = 0;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search emoji: rocket, bug, fire…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value().trim().toLowerCase(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { const e = this.shown()[this.at]; if (e) this.pick(e[0]); });
    this.input.focus();
    cx.timer.after(250, () => this.input.focus());
    cx.spawn(async (cx) => {
      try { this.groups = JSON.parse(await readTextFile(`${appHome()}/mods/space-icon/emoji.json`)); } catch { this.groups = []; }
      if (!this.recent().length) this.group = 0;
      cx.notify();
    });
  }

  recent() { return shared("space.icons.recent") ?? []; }

  // What the grid shows now: search hits, the recent ones, or one group.
  shown() {
    if (this.query) {
      const words = this.query.split(/\s+/);
      const hits = [];
      for (const g of this.groups) for (const e of g.emoji) {
        if (words.every((w) => e[1].includes(w))) { hits.push(e); if (hits.length >= MAX_HITS) return hits; }
      }
      return hits;
    }
    if (this.group < 0) return this.recent().map((e) => [e, "recent"]);
    return this.groups[this.group]?.emoji ?? [];
  }

  close() { closeOverlay(props()?.overlay); }

  pick(emoji) {
    const p = props() ?? {};
    const all = { ...(shared("space.icons") ?? {}) };
    if (emoji) all[p.id] = emoji; else delete all[p.id];
    setShared("space.icons", all);
    if (emoji) setShared("space.icons.recent", [emoji, ...this.recent().filter((e) => e !== emoji)].slice(0, RECENT_MAX));
    this.close();
  }

  move(by, cx) {
    const n = this.shown().length;
    if (!n) return;
    this.at = Math.max(0, Math.min(n - 1, this.at + by));
    this.scroll.scroll_to_item(Math.floor(this.at / COLS));
    cx.notify();
  }

  render() {
    const t = theme(), p = props() ?? {};
    const now = (shared("space.icons") ?? {})[p.id];
    const list = this.shown();
    const rows = [];
    for (let i = 0; i < list.length; i += COLS) rows.push(list.slice(i, i + COLS));
    const cell = (e, i) => div().id(`si-${i}`).size(34).flex_none().rounded(7).flex().items_center().justify_center().cursor_pointer()
      .text_size(20).tooltip(e[1] === "recent" ? e[0] : e[1])
      .when(e[0] === now, (el) => el.bg(t.selected))
      .when(i === this.at, (el) => el.border_1().border_color(t.accent))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.pick(e[0]))
      .child(e[0]);
    const tab = (i, label, glyph) => div().id(`sig-${i}`).size(28).flex_none().rounded(6).flex().items_center().justify_center().cursor_pointer()
      .text_size(15).tooltip(label)
      .when(!this.query && this.group === i, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.group = i; this.at = 0; this.input.set_value(""); this.query = ""; this.scroll.scroll_to_item(0); cx.notify(); })
      .child(glyph);
    const title = this.query ? `${list.length}${list.length >= MAX_HITS ? "+" : ""} found` : this.group < 0 ? "Recently used" : this.groups[this.group]?.name ?? "";
    return v_flex().id("space-icon").size_full().bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "right") this.move(1, cx);
        else if (e.key === "left") this.move(-1, cx);
        else if (e.key === "down") this.move(COLS, cx);
        else if (e.key === "up") this.move(-COLS, cx);
        else return;
        cx.stop_propagation();
      })
      // Head
      .child(h_flex().flex_none().px(12).pt(10).pb(4).gap(8).items_center()
        .child(h_flex().size(26).flex_none().rounded(7).bg(t.accent).items_center().justify_center().text_size(now ? 15 : 12).font_bold().text_color("#ffffff")
          .child(now ?? ([...(p.name || "?")][0] ?? "?").toUpperCase()))
        .child(v_flex().min_w(0).flex_1()
          .child(div().truncate().font_semibold().child(`Icon for ${p.name || "this space"}`))
          .child(div().text_size(11).text_color(t.dim).child("Shows on the space in Sessions and the space picker."))))
      // Search
      .child(div().flex_none().mx(12).my(6).h(30).px(9).flex().items_center().rounded(8).bg(t.background).border_1().border_color(t.accent)
        .child(Input.new(this.input).h_full().text_size(13).text_color(t.foreground)))
      // Groups
      .child(h_flex().flex_none().px(10).gap(1).flex_wrap()
        .when(this.recent().length > 0, (el) => el.child(tab(-1, "Recently used", "🕘")))
        .children(this.groups.map((g, i) => tab(i, g.name, g.emoji[0]?.[0] ?? "?"))))
      .child(div().flex_none().px(14).pt(6).pb(2).text_size(10.5).text_color(t.dim).child(title.toUpperCase()))
      // Grid
      .child(v_flex().id("si-grid").h(252).flex_none().overflow_y_scroll().track_scroll(this.scroll).px(10).pb(6)
        .children(rows.map((r, ri) => h_flex().gap(1).children(r.map((e, ci) => cell(e, ri * COLS + ci)))))
        .when(!list.length, (el) => el.child(div().p(16).text_color(t.dim).child(this.groups.length ? "No emoji has that name." : "Loading emoji…"))))
      // Footer
      .child(h_flex().flex_none().h(38).px(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(h_flex().id("si-letter").h(26).px(9).gap(6).items_center().rounded(6).cursor_pointer().border_1().border_color(now ? t.border : t.accent)
          .hover((s) => s.bg(t.hover)).on_click(() => this.pick(null))
          .child(div().text_size(11.5).child("Use the first letter")))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child("Arrows, Enter, Esc")));
  }
}
