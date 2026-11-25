// Launch configurations, like Warp's: save the spaces and tabs you have open (each tab's
// folder, its name if you gave one, and its agent if it runs one) as a setup, then open
// the whole setup again later. Kept in ~/.config/herdr-app/launch.json.
// Opened by review-tabs (review-tabs.launch) as a dialog.
// Settings → Features: launch_configs.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, run, spaces, panes, appHome, readTextFile, writeTextFile, theme } from "herdr";

const icon = (name) => `mods/launch/${name}.svg`;
// Agents a tab can start again by name.
const AGENTS = { "claude-code": ["claude"], codex: ["codex"], gemini: ["gemini"], opencode: ["opencode"], amp: ["amp"] };

function when(at) {
  const d = new Date(at);
  return `${d.getDate()} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// What's open now, as a setup.
function capture(name) {
  const all = panes();
  return {
    name,
    savedAt: Date.now(),
    spaces: spaces().filter((s) => s.name !== "~").map((s) => ({
      name: s.name,
      folder: s.folder,
      tabs: (s.tabs ?? []).map((tab) => {
        const lead = all.find((p) => p.tab === tab.id && p.program?.agent) ?? all.find((p) => p.tab === tab.id && p.terminal);
        return { name: tab.named ? tab.name : null, folder: lead?.cwd || s.folder, argv: AGENTS[lead?.program?.key] ?? null };
      }),
    })),
  };
}

export default class Launch extends View {
  init(_props, cx) {
    this.list = null;
    this.note = null;
    this.input = InputState.new({ placeholder: "Name this setup, e.g. \"Zendr work\"" });
    this.input.on("submit", (_e, cx) => this.save(cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.load(cx);
  }

  file() { return `${appHome()}/launch.json`; }

  async load(cx) {
    try { const l = JSON.parse((await readTextFile(this.file())) ?? "[]"); this.list = Array.isArray(l) ? l : []; } catch { this.list = []; }
    cx.notify();
  }

  async write(list) {
    const raw = await readTextFile(this.file()).catch(() => null);
    await writeTextFile(this.file(), JSON.stringify(list, null, 2) + "\n", raw);
    this.list = list;
  }

  async save(cx) {
    const name = this.input.value().trim() || `Setup ${when(Date.now())}`;
    const setup = capture(name);
    if (!setup.spaces.length) { this.note = "Nothing to save: open a space first."; cx.notify(); return; }
    try {
      await this.write([setup, ...(this.list ?? []).filter((s) => s.name !== name)]);
      this.input.set_value("");
      this.note = `Saved "${name}": ${setup.spaces.length} space${setup.spaces.length === 1 ? "" : "s"}.`;
    } catch (e) { this.note = `Couldn't save: ${e}`; }
    cx.notify();
  }

  async remove(setup, cx) {
    try { await this.write((this.list ?? []).filter((s) => s !== setup)); } catch (e) { this.note = `Couldn't remove: ${e}`; }
    cx.notify();
  }

  // Opens every space of the setup; tabs after a space's first follow once it exists.
  open(setup, cx) {
    const before = new Set(spaces().map((s) => s.id));
    setup.spaces.forEach((s, i) => {
      const first = s.tabs[0] ?? {};
      run("space.new", { name: s.name, folder: first.folder || s.folder, ...(first.argv ? { argv: first.argv } : {}), focus: i === 0 });
    });
    const rest = setup.spaces.filter((s) => s.tabs.length > 1);
    closeOverlay(props()?.overlay);
    if (!rest.length) return;
    cx.timer.after(1500, () => {
      const made = spaces().filter((s) => !before.has(s.id));
      for (const s of rest) {
        const space = made.find((m) => m.name === s.name);
        if (!space) continue;
        for (const tab of s.tabs.slice(1)) {
          run("tab.new", { space: space.id, folder: tab.folder || s.folder, ...(tab.argv ? { argv: tab.argv } : {}), ...(tab.name ? { name: tab.name } : {}), focus: false });
        }
      }
    });
  }

  button(t, id, name, label, tip, fn, primary = false) {
    return h_flex().id(id).h(28).px(10).gap(6).flex_none().items_center().rounded(7).text_size(12).cursor_pointer().tooltip(tip)
      .when(primary, (el) => el.bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .when(Boolean(name), (el) => el.child(svg(icon(name)).size(13)))
      .when(Boolean(label), (el) => el.child(label));
  }

  render(cx) {
    const t = theme();
    const now = capture("");
    const tabs = now.spaces.reduce((n, s) => n + s.tabs.length, 0);
    return v_flex().id("launch").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); } })
      .child(h_flex().h(46).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(icon("rocket")).size(15).text_color(t.muted))
        .child(div().font_semibold().text_size(14).child("Launch configurations")))
      // Save
      .child(v_flex().flex_none().px(16).py(12).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(11.5).text_color(t.dim).child(`Save what's open now: ${now.spaces.length} space${now.spaces.length === 1 ? "" : "s"}, ${tabs} tab${tabs === 1 ? "" : "s"}. Agents start again; other tabs open a shell in the same folder.`))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(7).bg(t.background).border_1().border_color(t.border)
            .child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
          .child(this.button(t, "launch-save", null, "Save setup", "Save the spaces and tabs open now (Enter)", (cx) => this.save(cx), true)))
        .when(Boolean(this.note), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(this.note))))
      // Saved setups
      .child(v_flex().id("launch-list").flex_1().min_h(0).overflow_y_scroll().p(8).gap(4)
        .when(this.list !== null && !this.list.length, (el) => el.child(div().p(12).text_color(t.dim).child("No setups saved yet. Name one above and press Enter.")))
        .children((this.list ?? []).map((s, i) => {
          const n = s.spaces?.length ?? 0, k = (s.spaces ?? []).reduce((m, x) => m + (x.tabs?.length ?? 0), 0);
          return h_flex().id(`launch-${i}`).w_full().flex_none().px(10).py(9).gap(10).items_center().rounded(8).hover((st) => st.bg(t.hover))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().truncate().font_semibold().child(s.name))
              .child(div().truncate().text_size(11.5).text_color(t.dim)
                .child(`${n} space${n === 1 ? "" : "s"} · ${k} tab${k === 1 ? "" : "s"} · ${(s.spaces ?? []).map((x) => x.name).join(", ")}`)))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(s.savedAt ? when(s.savedAt) : ""))
            .child(this.button(t, `launch-del-${i}`, "trash", null, "Delete this setup", (cx) => this.remove(s, cx)))
            .child(this.button(t, `launch-open-${i}`, "rocket", "Open", "Open every space and tab of this setup", (cx) => this.open(s, cx), true));
        })));
  }
}
