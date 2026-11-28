// App-owned settings mod. Writes changes immediately; no Save step.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, Popup } from "gpui-base";
import { exec, hc, run, theme, themes, fonts, updates, telemetry, settings, layouts, shared, setShared, appHome, readTextFile, writeTextFile, playSound, props, closeOverlay, notify, window } from "herdr";

import { addonMethods } from "./addons.js";
import { phoneMethods } from "./phone.js";

const I = (name) => `frame/settings/${name}.svg`;

const SECTIONS = [
  { id: "look", title: "Look", icon: "palette" },
  { id: "features", title: "Features", icon: "sliders" },
  { id: "claude", title: "Claude mods", icon: "puzzle" },
  { id: "claude-tools", title: "Claude tools", icon: "sparkles" },
  { id: "addons", title: "Add-ons", icon: "blocks" },
  ...(window()?.platform === "macos" ? [{ id: "keyboard", title: "Keyboard", icon: "keyboard" }] : []),
  { id: "machines", title: "Machines", icon: "server" },
  { id: "phone", title: "Phone", icon: "phone" },
  { id: "alerts", title: "Notifications", icon: "bell" },
  { id: "updates", title: "Updates", icon: "refresh" },
  { id: "privacy", title: "Privacy", icon: "shield" },
];

const LOOKS = { main: "Zendr", terminals: "Terminals", win98: "Zendr 98" };
const APPEARANCES = [
  [null, "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

// Settings → Notifications: what each kind of notification does (settings.json
// `notifications.<kind>.popup|sound|inbox`, all on unless turned off).
const NOTE_KINDS = [
  ["blocked", "An agent needs you", "It's waiting for your answer or approval.", true],
  ["done", "An agent finished", "Only when you aren't looking at it.", true],
  ["bridge", "Session messages", "From Claude Code sessions on the session bridge.", false],
  ["other", "Other notices", "Errors, updates and messages from mods.", false],
];
// Settings → Features: what Zendr shows (settings.json `features.<id>`). Each is on
// unless turned off, except those marked `off`. [id, title, about, off?]
const FEATURE_GROUPS = [
  ["Panels and toolbar", [
    ["hub", "Hub", "The Hub button in the toolbar and its drawer: the coordinator, every agent, and the messages between sessions."],
    ["bell", "Notifications button", "The Notifications button in the toolbar, with its unread count and the drawer."],
    ["graph", "Source control graph", "The Graph button in the toolbar and its drawer: commits, branch lines, and each commit's files."],
    ["code_view", "Explorer and code view", "The Explorer and Code buttons, and the code view beside the terminal."],
    ["split_buttons", "New terminal buttons", "The toolbar buttons that open a terminal to the right or below. The keys work either way."],
    ["arrange", "Arrange blocks", "The toolbar button that turns the panels into cards you drag to new places."],
  ]],
  ["Sidebar and sessions", [
    ["space_details", "Space details", "Under each space: the ports its programs listen on, its pull request and its session-bridge status."],
    ["agent_summaries", "What each agent is doing", "Each agent's current task and a one-line summary in the Sessions list."],
    ["agents_list", "Separate Agents list", "List agents again in their own section under the spaces, by priority or by space, instead of inside each space.", true],
    ["session_colors", "Session colours", "A colour on each session's row, tab and hub card."],
    ["session_counts", "Session counts", "How many sessions each space has, and in all, beside the names. A folded space keeps its count."],
  ]],
  ["Code view and panes", [
    ["code_edit", "Editing", "Edit mode in the code view: change files and save them. Off: the code view only shows files and their changes."],
    ["file_icons", "File-type icons", "A coloured icon for each file's type in the explorer, the tabs, Changes and the graph."],
    ["lang_detect", "Language detection", "Tell a file's language from a shebang, a modeline or its content when its name doesn't say."],
    ["code_zoom", "Ctrl + mouse wheel zoom", "Make the code bigger or smaller with Ctrl and the mouse wheel, to see fewer or more lines."],
    ["vscode_ext", "VS Code extensions", "Use the colour themes, code colours and languages of the VS Code extensions you have installed."],
    ["hints", "Shortcut hints", "The line of keyboard shortcuts under the code view."],
    ["pane_buttons", "Always show pane buttons", "Show a pane's header buttons all the time, not only when the pointer is over it.", true],
  ]],
  ["Warp-style tools", [
    ["command_suggestions", "Command suggestions (→ or Tab)", "While you type at a shell prompt, the command you run most often that starts that way shows in grey after the cursor. Press → or Tab to use it. Learned from the commands you run, starting from your shell's history; Clear command suggestions in the command palette forgets them."],
    ["command_search", "Command search (Ctrl+Shift+R)", "Search your shell history and saved workflows, then paste one into the terminal or run it."],
    ["workflows", "Workflows", "Saved commands with {{placeholders}}, in Command search."],
    ["ai_command", "Ask AI for a command (Ctrl+Shift+Space)", "Describe what you want; Claude Code writes the command. Uses your Claude account."],
    ["launch_configs", "Launch configurations (Ctrl+Shift+J)", "Save your spaces and tabs as a setup, and open it again later."],
  ]],
];

// Settings → Claude mods: Claude Code plugins from the claude-mods marketplace,
// installed for this user (`claude plugin ...`). [name, title, about]
const CLAUDE_MARKET = "claude-mods";
// The Windows and Zendr support, until it's merged upstream: pinned to a reviewed commit,
// so a push to the branch can't change what runs in everyone's Claude Code. Moving the
// pin is a Zendr release.
const CLAUDE_MARKET_URL = "https://github.com/ruchira-edirisinghe/claude-mods.git";
const CLAUDE_MARKET_REF = "48c8af7a2593bbeb97c5b0d1f26a80ab88a4f423";
const CLAUDE_MARKET_SOURCE = `${CLAUDE_MARKET_URL}#${CLAUDE_MARKET_REF}`;
const DONE_WORDS = { "Turning off…": "Turned off", "Turning on…": "Turned on", "Installing…": "Installed", "Saving options…": "Saved" };
const CLAUDE_MODS = [
  ["next-steps", "Next steps", "After each reply, suggested next steps as buttons above the prompt. Press 1 to 4 in an empty prompt box, or click one."],
  ["session-bridge", "Session bridge", "Running sessions message each other and hand off context, so one can plan or review while another builds. The hub uses it."],
  ["model-router", "Model router", "Sorts each turn into mechanical, ordinary or hard, and gives it a matching reasoning effort (and model, if you allow it)."],
];
// `claude` with `input` on its stdin (exec has none): through the shell, with
// the input passed as an argument, never as code.
function claudeWithInput(args, input) {
  if (window()?.platform === "windows") {
    const quoted = (v) => `'${String(v).replace(/'/g, "''")}'`;
    return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `& { param($in) $in | claude ${args.map(quoted).join(" ")} } ${quoted(input)}`], { timeout: 60000 });
  }
  return exec("sh", ["-c", 'input="$1"; shift; printf "%s" "$input" | claude "$@"', "sh", input, ...args], { timeout: 60000 });
}

// Do not disturb ends at quiet_until (ms); "always" is far enough away.
const FOREVER = 9e12;
const clock = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

// What the app uses when settings.json names no font (settings.rs).
const DEFAULT_FONT = "JetBrains Mono";
const DEFAULT_UI_FONT = "Google Sans";

export default class Settings extends View {
  init(_props, cx) {
    const asked = props()?.section;
    this.section = SECTIONS.some((s) => s.id === asked) ? asked : "look";
    this.picking = null; // "font" | "ui_font" while its list is open
    this.filter = "";
    this.fontInput = InputState.new({ placeholder: "Type to search fonts" });
    this.fontInput.on("change", (_e, cx) => { this.filter = this.fontInput.value(); cx.notify(); });
    this.renameInput = InputState.new();
    this.renameInput.on("focus", (_e, cx) => { this.renameFocused = true; cx.notify(); });
    this.renameInput.on("blur", (_e, cx) => { this.renameFocused = false; cx.notify(); });
    this.renameInput.on("change", (_e, cx) => { if (this.machineEdit?.action === "rename") this.machineEdit.name = this.renameInput.value(); cx.notify(); });
    this.renameInput.on("submit", (_e, cx) => {
      const edit = this.machineEdit;
      if (edit?.action === "rename") this.machineAction(edit.machine, "rename", cx, edit.name);
    });
    this.person = {};
    this.raw = null;
    this.previews = {}; // layout name -> its "preview" picture
    this.previewsOf = "";
    this.showData = false;
    this.machineList = null;
    this.machineLoading = false;
    this.machineError = null;
    this.machineBusy = {};
    this.machineResults = {};
    this.machineEdit = null;
    this.machineNotice = null;
    this.claude = null; // { plugins, configs, error } once read
    this.claudeBusy = {}; // name -> what it's doing
    this.claudeDone = {}; // name -> { text, until }: what just happened, said in place
    this.claudeOpen = null; // the plugin whose options show
    this.claudeInputs = {}; // "<name>.<key>" -> InputState for free-text options
    this.addons = null; // addons/catalog.json's list once read
    this.addonsError = null;
    this.addonBusy = {}; // id -> what it's doing
    this.addonView("claude"); this.addonView("general"); // their search boxes (inputs are made here, never in render)
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      await this.load();
      if (this.section === "machines") await this.loadMachines();
      if (this.section === "claude") await this.loadClaude();
      if (this.section === "claude-tools" || this.section === "addons") await this.loadAddons();
      if (this.section === "phone") this.loadPhone();
      cx.notify();
    });
    // After "Check now": follow the look (the answer comes from the app), then
    // "Up to date" for a moment.
    cx.timer.every(300, (cx) => {
      // A Claude mod's "Saved ✓" goes back to its state after a moment.
      const over = Object.entries(this.claudeDone).filter(([, d]) => d.until <= Date.now());
      if (over.length) { for (const [name] of over) delete this.claudeDone[name]; cx.notify(); }
      if (!this.asked) return;
      if (updates().checking) this.asked = Date.now();
      else if (Date.now() - this.asked >= 3000) this.asked = null;
      cx.notify();
    });
    cx.timer.every(3000, (cx) => {
      if (this.section !== "machines") return;
      cx.spawn(async (cx) => {
        await this.loadMachines();
        cx.notify();
      });
    });
  }

  file() {
    return `${appHome()}/settings.json`;
  }

  // Each layout file may name a picture of itself (`"preview"` on its root).
  loadPreviews(names, cx) {
    this.previewsOf = names.join("\n");
    cx.spawn(async (cx) => {
      const found = {};
      for (const name of names) {
        try {
          const preview = JSON.parse((await readTextFile(`${appHome()}/layouts/${name}.json`)) ?? "{}").preview;
          if (typeof preview === "string" && preview) found[name] = preview;
        } catch {}
      }
      this.previews = found;
      cx.notify();
    });
  }

  // `broken`: settings.json doesn't parse (mid-edit), or isn't an object, so
  // nothing may be written over it.
  async load() {
    this.raw = await readTextFile(this.file());
    try {
      const person = this.raw ? JSON.parse(this.raw) : {};
      this.broken = !person || typeof person !== "object" || Array.isArray(person);
      this.person = this.broken ? {} : person;
    } catch {
      this.person = {};
      this.broken = true;
    }
  }

  // Changes settings.json the way an agent would: read, change, write back
  // only if nobody changed it meanwhile (else read again and redo). Says so
  // when it couldn't.
  change(edit, cx) {
    cx.spawn(async (cx) => {
      const failed = await this.save(edit);
      if (failed) notify({ ...failed, level: "error" });
      cx.notify();
    });
  }

  // The toast saying why `edit` wasn't written, or null once it is.
  async save(edit) {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      let next;
      try {
        await this.load();
        if (this.broken) return { title: "settings.json has errors: fix it first" };
        next = JSON.parse(JSON.stringify(this.person));
        edit(next);
      } catch (e) {
        return { title: "Cannot read settings.json", body: String(e?.message ?? e) };
      }
      try {
        await writeTextFile(this.file(), JSON.stringify(next, null, 2) + "\n", this.raw);
        this.person = next;
        return null;
      } catch (e) {
        error = e;
      }
    }
    return { title: "Not saved to settings.json", body: String(error?.message ?? error) };
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Pieces ---------------------------------------------------------------

  heading(t, text) {
    return div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  // One setting: what it is on the left, the control on the right.
  row(t, title, about, control) {
    return h_flex()
      .w_full()
      .gap(16)
      .py(12)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(14).text_color(t.foreground).child(title))
          .when(Boolean(about), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about))),
      )
      .child(div().flex_none().child(control));
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .px(12)
      .py(5)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(label);
  }

  // − value +
  stepper(t, id, value, onMinus, onPlus) {
    const b = (k, label, f) =>
      div()
        .id(`${id}-${k}`)
        .w(28)
        .h(28)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_size(15)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(f)
        .child(label);
    return h_flex()
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .overflow_hidden()
      .child(b("minus", "\u2212", onMinus))
      .child(div().w(54).text_size(13).text_color(t.foreground).flex().justify_center().child(value))
      .child(b("plus", "+", onPlus));
  }

  toggle(t, id, on, onClick) {
    return div()
      .id(id)
      .w(36)
      .h(20)
      .rounded(10)
      .p(2)
      .cursor_pointer()
      .bg(on ? t.accent : t.hover)
      .flex()
      .when(on, (el) => el.justify_end())
      .on_click(onClick)
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  // Look -----------------------------------------------------------------

  // A small drawing of each layout, in the theme's colors (as the welcome draws them).
  preview(t, name) {
    const row = () => div().flex().flex_row();
    const col = () => div().flex().flex_col();
    const term = (bg = t.background, edge = t.border) => div().flex_1().rounded(2).bg(bg).border_1().border_color(edge);
    const line = (w, c = t.dim) => div().h(3).w(w).flex_none().rounded(2).bg(c);
    const lines = (n, c) => col().gap(4).p(5).children([...Array(n)].map((_, i) => line(i % 2 ? 22 : 32, c)));
    const frame = (el) => el.size_full().rounded(6).overflow_hidden().border_1().border_color(t.border).bg(t.surface);
    if (name === "main")
      return frame(row())
        .child(col().w(42).border_r(1).border_color(t.border).child(lines(4)))
        .child(
          col()
            .flex_1()
            .child(row().h(11).gap(2).p(2).border_b(1).border_color(t.border).child(div().w(20).rounded(2).bg(t.accent)).child(div().w(16).rounded(2).bg(t.raised)).child(div().w(16).rounded(2).bg(t.raised)))
            .child(row().flex_1().p(4).gap(3).child(term()).child(term())),
        );
    if (name === "terminals") {
      const card = () => col().flex_1().rounded(4).border_1().border_color("#2c2f34").bg("#17191c").child(row().h(7).px(3).items_center().border_b(1).border_color("#25282c").child(line(14, "#5d6168")));
      return frame(col())
        .bg("#131619")
        .p(4)
        .gap(4)
        .child(row().h(10).gap(3).p(1).rounded(4).bg("#1d1f22").child(div().w(30).rounded(3).bg("#34373c").border_1().border_color("#4a4d53")).child(div().w(30)))
        .child(row().flex_1().gap(4).child(card()).child(card()));
    }
    // A layout of the person's own: a plain frame.
    return frame(col()).child(row().h(11).border_b(1).border_color(t.border)).child(row().flex_1().p(4).child(term()));
  }

  layoutPicker(t, cx) {
    const current = shared("layout") ?? "main";
    // Shipped looks in the welcome's order, then the person's own; new files show up by themselves.
    const shipped = Object.keys(LOOKS);
    const rank = (n) => (shipped.includes(n) ? shipped.indexOf(n) : shipped.length);
    const names = [...layouts()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (names.join("\n") !== this.previewsOf) this.loadPreviews(names, cx);
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        names.map((name) => {
          const on = name === current;
          return v_flex()
            .id(`st-l-${name}`)
            .w(124)
            .gap(6)
            .p(6)
            .rounded(10)
            .border_2()
            .border_color(on ? t.accent : "#00000000")
            .bg(on ? t.raised : "#00000000")
            .cursor_pointer()
            .hover((s) => s.bg(t.raised))
            .on_click((_e, cx) => {
              run("layout.switch", { name });
              cx.notify();
            })
            .child(
              div()
                .h(62)
                .w_full()
                .overflow_hidden()
                .child(
                  this.previews[name]
                    ? image(this.previews[name]).w_full().h(62).rounded(6).border_1().border_color(t.border)
                    : this.preview(t, name),
                ),
            )
            .child(
              h_flex()
                .gap(5)
                .items_center()
                .child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).child(LOOKS[name] ?? name))
                .when(on, (el) => el.child(svg(I("check")).size(12).text_color(t.accent))),
            );
        }),
      );
  }

  appearancePicker(t, cx) {
    const now = this.person.appearance ?? null;
    return h_flex()
      .p(2)
      .gap(2)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .children(
        APPEARANCES.map(([value, label]) =>
          div()
            .id(`st-ap-${label}`)
            .px(12)
            .py(4)
            .rounded(6)
            .text_size(13)
            .cursor_pointer()
            .when(now === value, (el) => el.bg(t.raised).text_color(t.foreground).border_1().border_color(t.border))
            .when(now !== value, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) =>
              this.change((p) => {
                if (value === null) delete p.appearance;
                else p.appearance = value;
              }, cx),
            )
            .child(label),
        ),
      );
  }

  themePicker(t, light) {
    const s = settings();
    const current = light ? s.theme_light : s.theme_dark;
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        // A theme named like a layout (themes/win98.json) is that layout's own.
        themes()
          .filter((x) => Boolean(x.light) === light && (x.name === shared("layout") || !layouts().includes(x.name)))
          .map(({ name, colors: c }) => {
          const on = name === current;
          const label = name.replace(/-/g, " ");
          const dot = (color) => div().w(8).h(8).rounded(4).bg(color);
          return v_flex()
            .id(`st-t-${name}`)
            .w(124)
            .gap(6)
            .p(6)
            .rounded(10)
            .border_2()
            .border_color(on ? t.accent : "#00000000")
            .cursor_pointer()
            .hover((s) => s.bg(t.raised))
            .on_click((_e, cx) => {
              run("app.theme", { name });
              cx.notify();
            })
            .child(
              v_flex()
                .h(46)
                .w_full()
                .p(7)
                .gap(6)
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(c.background)
                .child(div().h(4).w(44).rounded(2).bg(c.terminal_foreground))
                .child(h_flex().gap(4).child(dot(c.accent)).child(dot(c.ansi1)).child(dot(c.ansi2)).child(dot(c.ansi3)).child(dot(c.ansi5))),
            )
            .child(
              h_flex()
                .w_full()
                .min_w(0)
                .gap(5)
                .items_center()
                .child(div().min_w(0).truncate().tooltip(label).text_size(12.5).text_color(on ? t.foreground : t.muted).child(label))
                .when(on, (el) => el.child(svg(I("check")).size(12).flex_none().text_color(t.accent))),
            );
        }),
      );
  }

  // The font in use, written in itself; a click opens the list.
  fontButton(t, which, family, def) {
    const open = this.picking === which;
    const trigger = div()
      .id(`st-f-${which}`)
      .w(220)
      .px(12)
      .py(6)
      .rounded(7)
      .border_1()
      .border_color(open ? t.accent : t.border)
      .bg(t.raised)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.picking = open ? null : which;
        this.filter = "";
        this.fontInput.set_value("");
        if (this.picking) this.fontInput.focus();
        else this.handle.focus();
        cx.notify();
      })
      .child(div().font_family(family).text_size(13.5).text_color(t.foreground).child(family));
    return Popup.new(`st-fp-${which}`, trigger)
      .when(open, (el) => el.content(this.fontList(t, which, def)));
  }

  fontList(t, which, def) {
    const q = this.filter.toLowerCase();
    const matches = fonts().filter((f) => f.toLowerCase().includes(q)).slice(0, 200);
    const choose = (name, cx) => {
      this.change((p) => {
        if (name === null) delete p[which];
        else p[which] = name;
      }, cx);
      this.picking = null;
      this.handle.focus();
      cx.notify();
    };
    const item = (id, label, family, onClick) =>
      div()
        .id(id)
        .px(10)
        .py(5)
        .rounded(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(div().font_family(family).text_size(13.5).text_color(t.foreground).child(label));
    return v_flex()
      .id(`st-font-list-${which}`)
      .w(360)
      .on_mouse_down_out((_e, cx) => {
        this.picking = null;
        this.handle.focus();
        cx.notify();
      })
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      // Let the child's native scroll run before stopping the page's wheel event.
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(
        div()
          .px(12)
          .py(8)
          .border_b(1)
          .border_color(t.border)
          .text_size(13)
          .child(Input.new(this.fontInput).h(28).text_color(t.foreground)),
      )
      .child(
        div()
          .id(`st-fl-${which}`)
          .h(200)
          .p(4)
          .overflow_y_scrollbar()
          .when(!q, (el) => el.child(item(`st-fd-${which}`, `Default (${def})`, def, (_e, cx) => choose(null, cx))))
          .children(matches.map((f, i) => item(`st-fi-${which}-${i}`, f, f, (_e, cx) => choose(f, cx)))),
      );
  }

  look(t, cx) {
    const s = settings();
    const p = this.person;
    // Numbers come back from the host as 32-bit floats: 1.1 reads as 1.100000023841858.
    const same = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-4 : a === b);
    const own = (key, composed, def) => !same(p[key] ?? def, composed);
    const size = (key, value, d, cx) => this.change((q) => (q[key] = Math.max(8, Math.min(32, (q[key] ?? value) + d))), cx);
    const step = (key, value, d, lo, hi, cx) => this.change((q) => (q[key] = Math.round(Math.max(lo, Math.min(hi, (q[key] ?? value) + d)) * 100) / 100), cx);
    const fontRow = (which, sizeKey, title, family, def, sizeNow) =>
      v_flex()
        .w_full()
        .child(
          this.row(
            t,
            title,
            own(which, family, def) ? "This layout sets its own; yours shows in the others." : null,
            h_flex()
              .gap(8)
              .items_center()
              .child(this.fontButton(t, which, family, def))
              // The panels' text follows zoom: they size their rows to it.
              .when(Boolean(sizeKey), (el) => el.child(this.stepper(t, `st-${sizeKey}`, `${Math.round(sizeNow)}`, (_e, cx) => size(sizeKey, sizeNow, -1, cx), (_e, cx) => size(sizeKey, sizeNow, 1, cx)))),
          ),
        );
    return v_flex()
      .w_full()
      .child(this.heading(t, "Layout"))
      .child(this.layoutPicker(t, cx))
      .child(div().h(18))
      .child(this.heading(t, "Theme"))
      .child(this.row(t, "Appearance", "Light or dark, or as your system is now.", this.appearancePicker(t, cx)))
      .child(div().pt(12).pb(8).text_size(12.5).text_color(t.dim).child("For the layout you're in: each layout keeps its own light and dark theme."))
      .child(div().pb(6).text_size(12.5).font_medium().text_color(t.muted).child("Dark"))
      .child(this.themePicker(t, false))
      .child(div().pt(10).pb(6).text_size(12.5).font_medium().text_color(t.muted).child("Light"))
      .child(this.themePicker(t, true))
      .child(div().h(18))
      .child(this.heading(t, "Size and fonts"))
      .child(
        this.row(
          t,
          "Zoom",
          "Everything: terminals, panels, text.",
          h_flex()
            .gap(8)
            .items_center()
            .child(this.stepper(t, "st-zoom", `${Math.round(s.zoom * 100)}%`, () => run("app.zoom_out"), () => run("app.zoom_in")))
            .child(this.button(t, "st-zoom-reset", "Reset", () => run("app.zoom_reset"))),
        ),
      )
      .child(fontRow("font", "font_size", "Terminal font", s.font_family, DEFAULT_FONT, s.font_size))
      .child(
        this.row(
          t,
          "Terminal font weight",
          own("font_weight", s.font_weight, 500) ? "This layout sets its own; yours shows in the others." : `Bold text is ${s.font_weight_bold ?? 700} (font_weight_bold in settings.json).`,
          this.stepper(t, "st-font_weight", `${s.font_weight}`, (_e, cx) => step("font_weight", s.font_weight, -100, 100, 900, cx), (_e, cx) => step("font_weight", s.font_weight, 100, 100, 900, cx)),
        ),
      )
      .children([
        ["terminal_line_height", "Terminal line height", 0.8, 2, 0.1],
        ["terminal_cell_width", "Terminal cell width", 0.8, 2, 0.05],
        ["terminal_scroll_speed", "Terminal scroll speed", 0.1, 5, 0.1],
      ].map(([key, title, min, max, step]) => {
        const by = (d) => (_e, cx) => this.change((q) => (q[key] = Math.max(min, Math.min(max, Math.round(Math.round(((q[key] ?? s[key]) + d) / step) * step * 100) / 100))), cx);
        return this.row(
          t, title,
          own(key, s[key], 1) ? "This layout sets its own; yours shows in the others." : null,
          this.stepper(t, `st-${key}`, `${Math.round(s[key] * 100)}%`, by(-step), by(step)),
        );
      }))
      .child(fontRow("ui_font", null, "Interface font", s.ui_font_family, DEFAULT_UI_FONT));
  }

  keyboard(t) {
    const choices = [
      ["auto", "Automatic (Alt on US keyboards)"],
      ["on", "Alt"],
      ["off", "Types characters"],
      ["left", "Left Option is Alt"],
      ["right", "Right Option is Alt"],
    ];
    return v_flex()
      .w_full()
      .child(this.heading(t, "Option key"))
      .child(div().pb(12).text_size(13).text_color(t.dim).child("Use Option for terminal shortcuts or to type accents and special characters."))
      .children(choices.map(([value, label]) => {
        const on = (this.person.option_as_alt ?? "auto") === value;
        return h_flex()
          .id(`st-option-${value}`)
          .gap(10)
          .px(12)
          .py(10)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.change((p) => { p.option_as_alt = value; }, cx))
          .child(div().text_color(on ? t.accent : t.muted).child(on ? "◉" : "○"))
          .child(div().text_size(14).text_color(t.foreground).child(label));
      }));
  }

  // Machines -------------------------------------------------------------

  async loadMachines() {
    if (this.machineLoading) return;
    this.machineLoading = true;
    try {
      const r = await hc(["machine", "ls", "--json"]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || "Couldn't read machines.");
      const list = JSON.parse(r.stdout).machines;
      if (!Array.isArray(list)) throw new Error("Couldn't read machines.");
      this.machineList = list.filter((m) => !m.temporary);
      this.machineError = null;
    } catch (e) {
      this.machineError = String(e);
    } finally {
      this.machineLoading = false;
    }
  }

  machineAction(machine, action, cx, name) {
    if (this.machineBusy[machine]) return;
    if (action === "rename" && (!name?.trim() || name.trim() === machine)) return;
    this.machineBusy[machine] = action;
    delete this.machineResults[machine];
    this.machineEdit = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = ["machine", action, machine];
        if (action === "rename") args.push(name.trim());
        const r = await hc(args);
        let payload = null;
        try { payload = JSON.parse(r.stdout || r.stderr); } catch {}
        if (r.code !== 0) throw new Error(payload?.error?.message || (r.stderr || r.stdout || "It didn't work.").trim());
        const message = action === "update"
          ? `Updated ${machine}${payload?.version ? ` to hc ${payload.version}` : ""}; its terminals kept running.`
          : action === "rename" ? `Renamed ${machine} to ${name.trim()}.` : `Removed ${machine}; its terminals keep running there.`;
        if (action === "update") this.machineResults[machine] = { message, ok: true };
        else this.machineNotice = message;
      } catch (e) {
        this.machineResults[machine] = { message: String(e), ok: false };
      } finally {
        delete this.machineBusy[machine];
      }
      await this.loadMachines();
      cx.notify();
    });
  }

  olderCore(remote, local) {
    const parse = (v) => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(v ?? "");
    const a = parse(remote), b = parse(local);
    if (!a || !b) return false;
    for (let i = 1; i <= 3; i++) {
      if (+a[i] !== +b[i]) return +a[i] < +b[i];
    }
    if (!a[4] || !b[4]) return Boolean(a[4] && !b[4]);
    const x = a[4].split("."), y = b[4].split(".");
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      if (x[i] === undefined || y[i] === undefined) return x[i] === undefined;
      const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
      return xn && yn ? +x[i] < +y[i] : xn !== yn ? xn : x[i] < y[i];
    }
    return false;
  }

  machineRow(t, m, localVersion) {
    const busy = this.machineBusy[m.name];
    const edit = this.machineEdit?.machine === m.name ? this.machineEdit : null;
    const state = String(m.state ?? "unknown").replace(/[_-]/g, " ");
    const color = ["connected", "online"].includes(m.state) ? t.ansi2 : ["connecting", "reconnecting"].includes(m.state) ? t.working : t.blocked;
    const result = this.machineResults[m.name];
    const controls = h_flex().gap(6).items_center();
    if (busy) controls.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child(div().text_size(12).text_color(t.muted).child(busy === "update" ? "Updating…" : busy === "rename" ? "Renaming…" : "Removing…"));
    else {
      if (this.olderCore(m.version, localVersion)) controls.child(this.button(t, `st-m-update-${m.name}`, "Update", (_e, cx) => this.machineAction(m.name, "update", cx)));
      for (const [action, label] of [["rename", "Rename"], ["rm", "Remove"]]) {
        controls.child(this.button(t, `st-m-${action}-${m.name}`, label, (_e, cx) => {
          this.machineEdit = { machine: m.name, action, name: m.name };
          if (action === "rename") {
            this.renameInput.set_value(m.name);
            this.renameInput.set_selected_range({ start: 0, end: encodeURIComponent(m.name).replace(/%[0-9A-F]{2}/g, "_").length });
            this.renameFocused = true;
            this.renameInput.focus();
          }
          cx.notify();
        }));
      }
    }
    const row = v_flex().w_full().py(12).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().w(7).h(7).flex_none().rounded(4).bg(color))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(14).text_color(t.foreground).child(m.name))
          .child(div().text_size(12.5).text_color(t.dim).child(`${m.target ?? ""} · ${state} · ${m.version ? `hc ${m.version}` : "hc version unknown"}`)))
        .when(m.keeps_running_after_logout === false, el => el.child(div().id(`st-m-logout-${m.name}`)
          .text_color(t.blocked).cursor_pointer().tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click(() => run("mod.open", { name: "machine-add" })).child("⚠")))
        .child(controls.flex_none()));
    if (m.state === "needs_login") {
      const command = `hc machine login ${m.name}`;
      row.child(v_flex().gap(5)
        .child(div().text_size(12.5).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(command))
          .child(this.button(t, `st-m-login-copy-${m.name}`, this.copiedLogin === command ? "Copied" : "Copy", (_e, cx) => {
            cx.write_to_clipboard(command);
            this.copiedLogin = command;
            cx.notify();
          }))));
    }
    if (busy === "update") row.child(div().text_size(12.5).text_color(t.dim).child("Copying this computer's herdr-core. Its terminals keep running."));
    if (edit && !busy) {
      const cancel = this.button(t, `st-m-cancel-${m.name}`, "Cancel", (_e, cx) => { this.machineEdit = null; this.handle.focus(); cx.notify(); });
      if (edit.action === "rm") row.child(v_flex().gap(8)
        .child(div().text_size(12.5).text_color(t.muted).child(`Remove ${m.name}? Its terminals keep running there.`))
        .child(h_flex().gap(6).child(cancel).child(this.button(t, `st-m-confirm-${m.name}`, "Remove machine", (_e, cx) => this.machineAction(m.name, "rm", cx)))));
      else row.child(v_flex().gap(6)
        .child(div().text_size(12).text_color(t.dim).child("New name (addresses using the old name stop working)"))
        .child(h_flex().gap(6).items_center()
          .child(Input.new(this.renameInput).flex_1().min_w(0).h(32).px(10).rounded(7).border_1().border_color(this.renameFocused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground))
          .child(cancel).child(this.button(t, `st-m-save-${m.name}`, "Save", (_e, cx) => this.machineAction(m.name, "rename", cx, edit.name)))));
    }
    if (result) row.child(div().text_size(12.5).text_color(result.ok ? t.ansi2 : t.blocked).child(result.message));
    return row;
  }

  machines(t) {
    const version = updates().core.version;
    return v_flex().w_full()
      .child(this.heading(t, "Machines"))
      .child(div().pb(8).text_size(12.5).line_height("18px").text_color(t.dim).child("Your computers, reached over ssh. Their terminals keep running when you disconnect."))
      .child(this.row(t, "This computer", `Connected · ${version ? `hc ${version}` : "hc version unknown"}`, div().w(7).h(7).rounded(4).bg(t.ansi2)))
      .children((this.machineList ?? []).map((m) => this.machineRow(t, m, version)))
      .when(this.machineList === null && !this.machineError, (el) => el.child(h_flex().py(14).gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child(div().text_size(12.5).text_color(t.dim).child("Reading machines…"))))
      .when(this.machineList?.length === 0, (el) => el.child(div().py(14).text_size(12.5).text_color(t.dim).child("No other machines yet.")))
      .when(Boolean(this.machineError), (el) => el.child(div().py(10).text_size(12.5).text_color(t.blocked).child(this.machineError)))
      .when(Boolean(this.machineNotice), (el) => el.child(div().py(10).text_size(12.5).text_color(t.ansi2).child(this.machineNotice)))
      .child(h_flex().pt(16).child(this.button(t, "st-m-add", "Add a machine", () => run("mod.open", { name: "machine-add" }))));
  }

  // Alerts ---------------------------------------------------------------

  // Claude mods ------------------------------------------------------------

  // Reads which claude-mods plugins are installed and on, and their options.
  async loadClaude() {
    let list;
    try {
      const r = await exec("claude", ["plugin", "list", "--json"], { timeout: 60000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `claude exited with ${r.code}`);
      list = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
    } catch (e) {
      this.claude = { plugins: {}, configs: {}, error: /ENOENT|not found|cannot find|No such file/i.test(String(e?.message ?? e))
        ? "Claude Code isn't installed (no `claude` command). Install it from claude.com/claude-code, then come back."
        : `Couldn't ask Claude Code: ${String(e?.message ?? e).slice(0, 300)}` };
      return;
    }
    const plugins = {}, configs = {};
    for (const [name] of CLAUDE_MODS) {
      const p = list.find((x) => x.id === `${name}@${CLAUDE_MARKET}`);
      if (!p) continue;
      plugins[name] = { id: p.id, enabled: p.enabled !== false, version: p.version };
      if (!p.hasUserConfig) continue;
      try {
        const r = await exec("claude", ["plugin", "configure", p.id, "--json"], { timeout: 60000 });
        const c = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
        if (c?.schema) configs[name] = { schema: c.schema, inputs: c.inputs ?? {} };
      } catch { /* its options stay hidden */ }
    }
    this.claude = { plugins, configs, error: null };
    for (const [name, c] of Object.entries(configs)) {
      for (const [key, field] of Object.entries(c.schema)) {
        if (field.type !== "string" || field.options) continue;
        const id = `${name}.${key}`;
        if (!this.claudeInputs[id]) {
          const input = InputState.new({ placeholder: String(field.default ?? "") });
          const saveIt = (_e, cx) => {
            const value = input.value().trim();
            if (value !== (this.claude?.configs[name]?.inputs[key] ?? "")) this.configureClaude(name, { [key]: value }, cx);
          };
          input.on("blur", saveIt);
          input.on("submit", saveIt);
          this.claudeInputs[id] = input;
        }
        this.claudeInputs[id].set_value(String(c.inputs[key] ?? ""));
      }
    }
  }

  // Runs `claude plugin ...` steps for one plugin, then reads everything again.
  claudeAct(name, doing, steps, cx) {
    if (this.claudeBusy[name]) return;
    this.claudeBusy[name] = doing;
    cx.notify();
    cx.spawn(async (cx) => {
      const title = CLAUDE_MODS.find(([n]) => n === name)[1];
      try {
        for (const step of steps) {
          const r = await step();
          if (r && r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `claude exited with ${r.code}`);
        }
        this.claudeDone[name] = { text: DONE_WORDS[doing] ?? "Done", until: Date.now() + 3000 };
      } catch (e) {
        notify({ title: `Couldn't change ${title}`, body: String(e?.message ?? e).slice(0, 400), level: "error" });
      }
      delete this.claudeBusy[name];
      await this.loadClaude();
      cx.notify();
    });
  }

  setClaudePlugin(name, on, cx) {
    const p = this.claude?.plugins[name];
    const id = `${name}@${CLAUDE_MARKET}`;
    if (!on) return this.claudeAct(name, "Turning off…", [() => exec("claude", ["plugin", "disable", id, "--scope", "user"], { timeout: 60000 })], cx);
    if (p) return this.claudeAct(name, "Turning on…", [() => exec("claude", ["plugin", "enable", id, "--scope", "user"], { timeout: 60000 })], cx);
    this.claudeAct(name, "Installing…", [
      async () => {
        const r = await exec("claude", ["plugin", "marketplace", "list", "--json"], { timeout: 60000 });
        let known = false;
        try { known = JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).some((m) => m.name === CLAUDE_MARKET); } catch { /* add it */ }
        return known ? null : exec("claude", ["plugin", "marketplace", "add", CLAUDE_MARKET_SOURCE], { timeout: 180000 });
      },
      () => exec("claude", ["plugin", "install", id, "--scope", "user"], { timeout: 180000 }),
    ], cx);
  }

  configureClaude(name, values, cx) {
    const c = this.claude?.configs[name];
    if (c) Object.assign(c.inputs, values);
    this.claudeAct(name, "Saving options…", [() => claudeWithInput(["plugin", "configure", `${name}@${CLAUDE_MARKET}`, "--values-stdin"], JSON.stringify(values))], cx);
  }

  claudeMods(t) {
    const c = this.claude;
    const intro = div().pb(14).text_size(12.5).line_height("18px").text_color(t.dim)
      .child("Claude Code plugins that Zendr works with. They run inside Claude Code, in every session you start here or in another terminal. Changes reach new sessions; restart running ones.");
    if (!c) return v_flex().w_full().child(intro).child(div().py(12).text_size(13).text_color(t.dim).child("Asking Claude Code…"));
    if (c.error) return v_flex().w_full().child(intro).child(div().py(12).text_size(13).text_color(t.blocked).child(c.error));
    return v_flex().w_full().child(intro).children(CLAUDE_MODS.map(([name, title, about]) => {
      const p = c.plugins[name], busy = this.claudeBusy[name], cfg = c.configs[name];
      const done = this.claudeDone[name]?.until > Date.now() ? `${this.claudeDone[name].text} ✓` : null;
      const state = busy ?? done ?? (!p ? "Not installed" : p.enabled ? `On · v${p.version}` : `Off · v${p.version}`);
      const control = h_flex().gap(10).items_center()
        .child(div().text_size(11.5).text_color(busy || done || p?.enabled ? t.accent : t.dim).child(state))
        .when(Boolean(p && cfg), (el) => el.child(this.button(t, `st-c-opt-${name}`, this.claudeOpen === name ? "Hide options" : "Options", (_e, cx) => { this.claudeOpen = this.claudeOpen === name ? null : name; cx.notify(); })))
        .child(this.toggle(t, `st-c-${name}`, Boolean(p?.enabled), (_e, cx) => this.setClaudePlugin(name, !p?.enabled, cx)));
      const card = v_flex().w_full().child(this.row(t, title, about, control));
      if (this.claudeOpen !== name || !cfg) return card;
      return card.child(v_flex().w_full().pl(18).pb(10).border_l(2).border_color(t.accent + "55").children(Object.entries(cfg.schema).map(([key, field]) => {
        const now = String(cfg.inputs[key] ?? "") || String(field.default ?? "");
        let input;
        if (field.type === "boolean") input = this.toggle(t, `st-c-${name}-${key}`, now === "true", (_e, cx) => this.configureClaude(name, { [key]: now === "true" ? "false" : "true" }, cx));
        else if (field.options) input = this.choice(t, `st-c-${name}-${key}`, field.options.map((o) => [o, o]), now, (v, cx) => this.configureClaude(name, { [key]: v }, cx));
        else input = div().w(240).px(8).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(13)
          .child(Input.new(this.claudeInputs[`${name}.${key}`]).h(28).text_color(t.foreground));
        return this.row(t, field.title ?? key, field.description, input);
      })));
    }));
  }

  // Features ---------------------------------------------------------------

  features(t) {
    const f = this.person.features ?? {};
    const all = FEATURE_GROUPS.flatMap(([, list]) => list);
    const onCount = all.filter(([id, , , off]) => (off ? f[id] === true : f[id] !== false)).length;
    const setAll = (on, cx) =>
      this.change((p) => {
        p.features = { ...(p.features ?? {}) };
        for (const [id, , , off] of all) {
          if (off) continue;
          if (on) delete p.features[id];
          else p.features[id] = false;
        }
        setShared("zendr.features.changed", Date.now());
      }, cx);
    return v_flex()
      .w_full()
      .child(
        h_flex()
          .w_full()
          .pb(14)
          .gap(10)
          .items_center()
          .child(div().flex_1().text_size(12.5).line_height("18px").text_color(t.dim).child(`Turn off anything you don't use. ${onCount} of ${all.length} are on. Changes apply at once.`))
          .child(this.button(t, "st-f-all-on", "Turn all on", (_e, cx) => setAll(true, cx)))
          .child(this.button(t, "st-f-all-off", "Keep it simple", (_e, cx) => setAll(false, cx))),
      )
      .children(
        FEATURE_GROUPS.map(([group, list]) =>
          v_flex()
            .w_full()
            .pb(18)
            .child(this.heading(t, group))
            .children(
              list.map(([id, title, about, off]) => {
                const on = off ? f[id] === true : f[id] !== false;
                return this.row(
                  t,
                  title,
                  about,
                  this.toggle(t, `st-f-${id}`, on, (_e, cx) =>
                    this.change((p) => {
                      p.features = { ...(p.features ?? {}) };
                      if (off ? !on : on) p.features[id] = off ? true : false;
                      else delete p.features[id];
                      setShared("zendr.features.changed", Date.now());
                    }, cx),
                  ),
                );
              }),
            ),
        ),
      )
      .child(
        v_flex()
          .w_full()
          .pb(18)
          .child(this.heading(t, "Claude Code mods"))
          .child(this.row(t, "Next steps, session bridge and model router", "Claude Code plugins Zendr works with. Turn each on or off and set its options.",
            this.button(t, "st-f-claude", "Open Claude mods", (_e, cx) => { this.section = "claude"; cx.spawn(async (cx) => { await this.loadClaude(); cx.notify(); }); cx.notify(); })))
          .child(this.row(t, "Claude tools and add-ons from the community", "Dozens of tools from the Herdr gallery, all off until you pick them: usage limits, session search, prompt timelines, runners, notes and more.",
            h_flex().gap(8)
              .child(this.button(t, "st-f-tools", "Claude tools", (_e, cx) => { this.section = "claude-tools"; cx.spawn(async (cx) => { await this.loadAddons(); cx.notify(); }); cx.notify(); }))
              .child(this.button(t, "st-f-addons", "Add-ons", (_e, cx) => { this.section = "addons"; cx.spawn(async (cx) => { await this.loadAddons(); cx.notify(); }); cx.notify(); })))),
      );
  }

  // One of a few: [value, label] pairs, the chosen one raised.
  choice(t, id, options, now, pick) {
    return h_flex()
      .p(2)
      .gap(2)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .children(
        options.map(([value, label]) =>
          div()
            .id(`${id}-${value}`)
            .px(10)
            .py(4)
            .rounded(6)
            .text_size(12.5)
            .cursor_pointer()
            .when(now === value, (el) => el.bg(t.raised).text_color(t.foreground).border_1().border_color(t.border))
            .when(now !== value, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => pick(value, cx))
            .child(label),
        ),
      );
  }

  // Changes settings.json's `notifications` (the app and the notification mods read it).
  changeNotes(edit, cx) {
    this.change((p) => {
      p.notifications = { ...(p.notifications ?? {}) };
      edit(p.notifications);
      setShared("notify.prefs.changed", Date.now());
    }, cx);
  }

  // Pop-up, sound and inbox, for each kind of notification.
  noteTable(t, n, soundsOn) {
    const col = (child) => div().w(64).flex_none().flex().justify_center().child(child);
    return v_flex()
      .w_full()
      .child(
        h_flex()
          .w_full()
          .gap(12)
          .pb(8)
          .border_b(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.dim)
          .child(div().flex_1().child("When"))
          .children(["Pop-up", "Sound", "Inbox"].map((l) => col(l))),
      )
      .children(
        NOTE_KINDS.map(([kind, title, about, hasSound]) => {
          const p = n[kind] ?? {};
          const flip = (what, on) => (_e, cx) => this.changeNotes((x) => (x[kind] = { ...(x[kind] ?? {}), [what]: !on }), cx);
          const cell = (what) => {
            const on = p[what] !== false;
            return col(this.toggle(t, `st-n-${kind}-${what}`, on, flip(what, on)));
          };
          return h_flex()
            .w_full()
            .gap(12)
            .py(10)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(3)
                .child(div().text_size(14).text_color(t.foreground).child(title))
                .child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about)),
            )
            .child(cell("popup"))
            .child(hasSound ? div().when(!soundsOn, (el) => el.opacity(0.4)).child(cell("sound")) : col(div().text_color(t.dim).child("—")))
            .child(cell("inbox"));
        }),
      );
  }

  alerts(t) {
    const sounds = this.person.sounds ?? {};
    const on = sounds.enabled !== false;
    const n = this.person.notifications ?? {};
    const file = (f) => (f ? f.split(/[\\/]/).pop() : "Zendr's sound");
    const quietUntil = n.quiet_until ?? 0;
    const quiet = quietUntil > Date.now();
    const quietNow = !quiet ? "off" : n.quiet_mode ?? (quietUntil >= FOREVER ? "always" : "hour");
    const setQuiet = (mode, cx) =>
      this.changeNotes((x) => {
        const now = new Date();
        const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() >= 8 ? 1 : 0), 8).getTime();
        const until = { off: null, hour: Date.now() + 3600000, morning, always: FOREVER }[mode];
        if (until) Object.assign(x, { quiet_until: until, quiet_mode: mode });
        else { delete x.quiet_until; delete x.quiet_mode; }
      }, cx);
    return v_flex()
      .w_full()
      .child(this.heading(t, "What to tell you"))
      .child(this.noteTable(t, n, on))
      .child(
        this.row(
          t,
          "Do not disturb",
          quiet
            ? quietUntil >= FOREVER ? "On until you turn it off. Notifications still go to the inbox." : `On until ${clock(quietUntil)}. Notifications still go to the inbox.`
            : "Holds pop-ups and sounds. Notifications still go to the inbox.",
          this.choice(t, "st-n-quiet", [["off", "Off"], ["hour", "1 hour"], ["morning", "Until 8:00"], ["always", "Until I turn it off"]], quietNow, setQuiet),
        ),
      )
      .child(div().h(18))
      .child(this.heading(t, "Pop-ups"))
      .child(
        this.row(
          t,
          "Show each pop-up for",
          "Errors and warnings stay a little longer. Click a pop-up to go to where it came from.",
          this.choice(t, "st-n-secs", [[3, "3 s"], [5, "5 s"], [8, "8 s"], [15, "15 s"], [0, "Until clicked"]], n.toast_seconds ?? 5, (v, cx) => this.changeNotes((x) => (x.toast_seconds = v), cx)),
        ),
      )
      .child(
        this.row(
          t,
          "Try it",
          "Shows a pop-up the way notifications look now.",
          this.button(t, "st-n-test", "Send a test", () => notify({ title: "This is a notification", body: "Click it to go to where it came from.", level: "info", kind: "other" })),
        ),
      )
      .child(div().h(18))
      .child(this.heading(t, "Inbox"))
      .child(
        this.row(
          t,
          "Bell badge",
          "What the bell in the tab bar shows while some notifications are unread.",
          this.choice(t, "st-n-badge", [["count", "Number"], ["dot", "Dot"], ["off", "Nothing"]], n.badge ?? "count", (v, cx) => this.changeNotes((x) => (x.badge = v), cx)),
        ),
      )
      .child(
        this.row(
          t,
          "Mark read when you go there",
          "Opening the agent a notification is about marks it read.",
          this.toggle(t, "st-n-visit", n.read_on_visit !== false, (_e, cx) => this.changeNotes((x) => (x.read_on_visit = n.read_on_visit === false), cx)),
        ),
      )
      .child(
        this.row(
          t,
          "Keep",
          "The newest notifications the inbox keeps.",
          this.choice(t, "st-n-keep", [[50, "50"], [200, "200"], [500, "500"]], n.keep ?? 200, (v, cx) => this.changeNotes((x) => (x.keep = v), cx)),
        ),
      )
      .child(this.row(t, "Clear the inbox", "Removes every notification in it now.", this.button(t, "st-n-clear", "Clear", () => setShared("inbox.log", []))))
      .child(div().h(18))
      .child(this.heading(t, "Highlights"))
      .child(
        this.row(
          t,
          "Ring panes that need you",
          "A coloured edge on a terminal whose agent needs you or just finished.",
          this.toggle(t, "st-n-rings", n.rings !== false, (_e, cx) => this.changeNotes((x) => (x.rings = n.rings === false), cx)),
        ),
      )
      .child(
        this.row(
          t,
          "Latest notification under each space",
          "In the sidebar, below the space's name.",
          this.toggle(t, "st-n-sidebar", n.sidebar_note !== false, (_e, cx) => this.changeNotes((x) => (x.sidebar_note = n.sidebar_note === false), cx)),
        ),
      )
      .child(div().h(18))
      .child(this.heading(t, "Sounds"))
      .child(
        this.row(
          t,
          "Play sounds",
          "Turn off every sound at once. The Sound column above picks them one by one.",
          this.toggle(t, "st-sounds", on, (_e, cx) => this.change((p) => (p.sounds = { ...(p.sounds ?? {}), enabled: !on }), cx)),
        ),
      )
      .child(this.row(t, "An agent needs you", file(sounds.blocked), this.button(t, "st-play-blocked", "Play", () => playSound("blocked"))))
      .child(this.row(t, "An agent finished", file(sounds.done), this.button(t, "st-play-done", "Play", () => playSound("done"))))
      .child(div().pt(12).text_size(12.5).line_height("18px").text_color(t.dim).child("Want your own sounds? Ask your agent to set sounds.done and sounds.blocked in settings.json to an MP3."));
  }

  // Updates --------------------------------------------------------------

  updates(t) {
    const u = updates();
    const at = (secs) => {
      const d = new Date(secs * 1000);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const checked = u.checked ? ` Checked at ${at(u.checked)}.` : "";
    const result = u.checking ? "Checking\u2026" : u.checked
      ? `Up to date.${checked}`
      : "No successful check. Check your connection and try again.";
    // Pressed: "Checking\u2026" while it looks, then "Up to date" for a moment
    // (a find changes the row instead). One per row: an element shows once.
    const asked = this.asked && Date.now() - this.asked < 3000;
    const check = (id) =>
      !u.checks
        ? null
        : u.checking && this.asked
          ? div().px(12).py(5).text_size(13).text_color(t.dim).child("Checking\u2026")
          : asked && u.checked && !u.checking
            ? div().px(12).py(5).text_size(13).text_color(t.ansi2).child("\u2713 Up to date")
            : this.button(t, id, "Check now", (_e, cx) => {
                this.asked = Date.now();
                run("app.check_updates");
                cx.notify();
              });
    const primary = (id, label, f) =>
      div().id(id).px(12).py(5).rounded(7).cursor_pointer().bg(t.accent).text_color(t.accent_foreground).text_size(13).font_semibold().hover((s) => s.opacity(0.9)).on_click(f).child(label);
    const app = !u.app.updates
      ? ["A build from source: it updates with git, not here.", null]
      : u.app.ready
        ? [`${u.app.ready} is ready. Restart to switch now; it also switches when you quit.`, primary("st-app-update", "Restart to update", () => run("app.update"))]
        : [result, check("st-check-app")];
    const c = u.core;
    const core = c.managed
      ? [`Managed by ${c.managed}: update it there.${c.ready ? ` ${c.ready} is available.` : ""}`, u.checks ? check("st-check-core") : null]
      : c.updating
        ? ["Updating\u2026 your terminals keep running.", null]
        : c.error
          ? [`The update failed: ${c.error}`, primary("st-core-retry", "Try again", () => run("app.update_core"))]
          : c.ready
            ? [`${c.ready} is ready. Your terminals keep running through it.`, primary("st-core-update", "Update herdr-core", () => run("app.update_core"))]
            : u.checks
              ? [result, check("st-check-core")]
              : ["Not checked: a build from source looks for no updates.", null];
    return v_flex()
      .w_full()
      .child(this.heading(t, "Zendr"))
      .child(this.row(t, `Zendr ${u.app.version}`, app[0], h_flex().gap(8).flex_none()
        .child(this.button(t, "st-whats-new", "What's new", () => { closeOverlay(props()?.overlay); run("app.whats_new"); }))
        .when(Boolean(app[1]), (el) => el.child(app[1]))))
      .child(div().pt(8).text_size(12.5).line_height("18px").text_color(t.dim)
        .child("Zendr is made from Herdr's code (github.com/herdrdev, Apache-2.0), the software it grew from, with features inspired by cmux (cmux.com). Thanks to both."))
      .child(div().h(18))
      .child(this.heading(t, "herdr-core"))
      .child(this.row(t, `herdr-core ${c.version ?? ""}`, core[0], core[1] ?? div()))
      .child(div().pt(12).text_size(12.5).line_height("18px").text_color(t.dim).child("Zendr looks for both every hour and tells you in the corner. herdr-core runs your terminals, so they keep running through its updates."));
  }


  // Privacy --------------------------------------------------------------

  // A report as it goes out, one line per line of JSON.
  report(t, id, title, about, report) {
    const lines = JSON.stringify(report, null, 2).split("\n");
    return v_flex()
      .w_full()
      .pt(14)
      .gap(4)
      .child(div().text_size(13.5).text_color(t.foreground).child(title))
      .when(Boolean(about), (el) => el.child(div().text_size(12.5).text_color(t.dim).child(about)))
      .child(
        v_flex()
          .id(id)
          .mt(4)
          .w_full()
          .p(10)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .children(lines.map((l) => div().font_family(DEFAULT_FONT).text_size(12).line_height("17px").text_color(t.muted).whitespace_nowrap().child(l || " "))),
      );
  }

  privacy(t) {
    const s = telemetry();
    const on = s ? s.setting : this.person.telemetry !== false;
    const at = (secs) => new Date(secs * 1000).toLocaleString();
    const why = s?.off_because ? `Off for now: ${s.off_because} is set where Zendr started.` : null;
    const body = v_flex()
      .w_full()
      .child(this.heading(t, "Usage data"))
      .child(
        this.row(
          t,
          "Share anonymous usage data",
          why ?? "Once a day: which agents and features you use, how many spaces and tabs, your system and Zendr's version. Never what's in your terminals, never names of files, folders or projects.",
          this.toggle(t, "st-telemetry", on, (_e, cx) =>
            this.change((p) => {
              if (on) p.telemetry = false;
              else delete p.telemetry;
            }, cx),
          ),
        ),
      )
      .child(
        this.row(
          t,
          "What we send",
          s && !s.sends ? "This build never sends: it's built from source. You can still see what a release would send." : "Exactly what leaves your computer, word for word.",
          this.button(t, "st-telemetry-show", this.showData ? "Hide" : "Show", (_e, cx) => {
            this.showData = !this.showData;
            cx.notify();
          }),
        ),
      );
    if (!this.showData) return body;
    if (!s?.enabled) return body.child(div().pt(14).text_size(13).text_color(t.dim).child("Nothing is collected or sent while it's off."));
    return body
      .children(s.queued.map((r, i) => this.report(t, `st-tq-${i}`, `Waiting to send: ${r.day}`, "Sent as is, soon.", r)))
      .when(Boolean(s.draft), (el) => el.child(this.report(t, "st-td", "Today so far", "A draft: it changes until the day ends (UTC), then goes out once.", s.draft)))
      .when(Boolean(s.last_sent), (el) => el.child(this.report(t, "st-tl", `Last sent: ${s.last_sent.report.day}`, `Sent ${at(s.last_sent.at)}.`, s.last_sent.report)));
  }

  // ----------------------------------------------------------------------

  render(cx) {
    const t = theme();
    const u = updates();
    const waiting = Boolean(u.app.ready || (u.core.ready && !u.core.managed));
    const nav = v_flex()
      .flex_none()
      .w(190)
      .p(10)
      .gap(2)
      .border_r(1)
      .border_color(t.border)
      .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("Settings"))
      .children(
        SECTIONS.map((s) => {
          const on = s.id === this.section;
          return h_flex()
            .id(`st-s-${s.id}`)
            .gap(10)
            .px(10)
            .py(7)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(on ? t.raised : "#00000000")
            .hover((st) => st.bg(t.raised))
            .on_click((_e, cx) => {
              this.section = s.id;
              this.picking = null;
              this.machineEdit = null;
              this.handle.focus();
              if (s.id === "machines") cx.spawn(async (cx) => { await this.loadMachines(); cx.notify(); });
              if (s.id === "claude") cx.spawn(async (cx) => { await this.loadClaude(); cx.notify(); });
              if (s.id === "claude-tools" || s.id === "addons") cx.spawn(async (cx) => { await this.loadAddons(); cx.notify(); });
              if (s.id === "phone") this.loadPhone();
              cx.notify();
            })
            .child(svg(I(s.icon)).size(15).text_color(on ? t.accent : t.dim))
            .child(div().flex_1().text_size(13.5).text_color(on ? t.foreground : t.muted).child(s.title))
            .when(s.id === "updates" && waiting, (el) => el.child(div().w(7).h(7).rounded(4).bg(t.accent)));
        }),
      );
    return h_flex()
      .id("settings")
      .track_focus(this.handle)
      .when(Boolean(this.picking), (el) => el.on_action("overlay.close", (_e, cx) => {
        this.picking = null;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      }))
      .w_full()
      .h(620)
      .min_h(0)
      .items_start()
      .on_key_down((e, cx) => {
        const k = e.key;
        if (this.machineEdit) {
          if (k === "escape") this.machineEdit = null;
          else return;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "escape") {
          if (this.picking) this.picking = null;
          else return this.close();
          this.handle.focus();
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(nav.h_full().child(div().flex_1()).child(this.button(t, "st-feedback", "Send feedback", () => { closeOverlay(props()?.overlay); run("app.feedback"); })))
      .child(
        // A bar that always shows: the pages are taller than the dialog and
        // people should see that they scroll.
        div()
          .relative()
          .flex_1()
          .min_w(0)
          .h_full()
          .child(
            div()
              .id("st-body")
              .size_full()
              .overflow_y_scroll()
              // Padding inside, not on the scroll area: there it counts as
              // content and a page that fits still shows a bar.
              .child(
                div()
                  .px(28)
                  .py(22)
                  .child(
                    this.section === "look"
                      ? this.look(t, cx)
                      : this.section === "keyboard"
                        ? this.keyboard(t)
                      : this.section === "machines"
                        ? this.machines(t)
                      : this.section === "features"
                        ? this.features(t)
                      : this.section === "claude"
                        ? this.claudeMods(t)
                      : this.section === "claude-tools"
                        ? this.addonsPage(t, "claude")
                      : this.section === "addons"
                        ? this.addonsPage(t, "general")
                      : this.section === "phone"
                        ? this.phonePage(t)
                      : this.section === "alerts"
                        ? this.alerts(t)
                        : this.section === "privacy"
                          ? this.privacy(t)
                          : this.updates(t),
                  ),
              ),
          )
          .child(Scrollbar.vertical("st-body").mode("always").absolute().inset_0()),
      );
  }
}

Object.assign(Settings.prototype, addonMethods, phoneMethods);
