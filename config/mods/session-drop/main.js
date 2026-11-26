// Where a session dragged out of the Sessions list lands. The list opens this over the whole
// window while the drag is on (a "window" overlay, no frame); releasing over a zone places the
// session there, anywhere else drops it. shared("session.drag") is the drag in flight:
// { terminal, pane, tab, name, at }; the list clears it when the button comes up over itself.
//   Right  - beside the pane you're in, side by side
//   Below  - under the pane you're in
//   Centre - go to it, where it is
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, run, panes, focused, layout, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const px = (id, fallback) => {
  const n = find(layout(), id);
  return n && !n.hidden ? n.size?.px ?? fallback : 0;
};

export default class SessionDrop extends View {
  init(_props, cx) {
    this.zone = null;
    // The drag ended somewhere this never heard of (outside the window, a key): close.
    cx.timer.every(250, () => {
      const d = shared("session.drag");
      if (!d || d.terminal !== props()?.terminal) this.close();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const d = shared("session.drag");
    if (d && d.terminal === props()?.terminal) setShared("session.drag", null);
    closeOverlay(props()?.overlay);
  }

  drop(zone) {
    const p = props() ?? {};
    const here = focused();
    const pane = panes().find((x) => x.terminal === p.terminal);
    if (zone === "go" || !here) {
      if (pane) run("pane.focus", { pane: pane.pane });
      else run("terminal.keep", { terminal: p.terminal, place: "tab" });
    } else if (here.terminal === p.terminal) {
      // Dropped beside itself: nothing to move.
    } else {
      // Out of where it is (a tab left empty closes; the terminal keeps running), then beside this
      // pane. The same in this tab or another: the new pane opens next to the one you're in.
      if (pane) run("terminal.park", { terminal: p.terminal });
      run("terminal.keep", { terminal: p.terminal, place: zone });
    }
    this.close();
  }

  render() {
    const t = theme(), p = props() ?? {};
    const zoom = settings().zoom || 1;
    const left = px("sidebar", 268) * zoom;
    const top = px("tabs", 52) * zoom;
    const name = p.name || "this session";
    // Every box here stretches by flex alone (no percentages), so the zones fill the work area.
    const zone = (id, label, hint, icon) => v_flex().id(`drop-${id}`).flex_1().min_w(0).min_h(0).items_center().justify_center().gap(8).rounded(12)
      .border_2().border_color(this.zone === id ? t.accent : t.accent + "55").bg(this.zone === id ? t.accent + "30" : t.background + "f0")
      .on_mouse_move((_e, cx) => { if (this.zone !== id) { this.zone = id; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drop(id); })
      .child(svg(icon).size(26).text_color(this.zone === id ? t.accent : t.muted))
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(label))
      .child(div().text_size(12).text_color(t.dim).child(hint));
    return div().id("session-drop").size_full().flex().flex_col()
      .pl(left + 10).pt(top + 10).pr(10).pb(38 * zoom)
      .on_mouse_up("left", () => this.close())
      .on_mouse_move((_e, cx) => { if (this.zone !== null) { this.zone = null; cx.notify(); } })
      .child(v_flex().flex_1().min_h(0).gap(10).p(10).rounded(14).bg(t.background + "cc")
        .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(`Drop ${name} to place it. Let go anywhere else to cancel.`))
        .child(div().flex().flex_row().flex_1().min_h(0).gap(10)
          .child(div().flex().flex_col().flex_1().min_w(0).gap(10)
            .child(zone("go", "Go to it", "Show it where it is", "mods/workspace-chrome/terminal.svg"))
            .child(zone("down", "Below", "Under the pane you're in", "mods/workspace-chrome/panel-bottom.svg")))
          .child(div().flex().flex_col().flex_1().min_w(0)
            .child(zone("right", "Side by side", "Beside the pane you're in", "mods/workspace-chrome/panel-right.svg")))));
  }
}
