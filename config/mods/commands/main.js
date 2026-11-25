// Command search, like Warp's: your shell history and your saved workflows in one list,
// plus Ask AI, which has Claude Code write a command from a description. Enter pastes the
// command into the terminal you came from, to check before running; Ctrl+Enter runs it.
// Workflows live in ~/.config/herdr-app/workflows.json: [{ name, command, description }],
// where {{name}} in a command is asked for when you pick it.
// Opened by review-tabs (review-tabs.command-search / ask-ai) as a dialog with
// props { mode: "history" | "workflows" | "ai", terminal, cwd, shell }.
// Settings → Features turns each part off (command_search, workflows, ai_command).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, run, hc, exec, home, appHome, readTextFile, writeTextFile, theme, shared, window, settings } from "herdr";

const icon = (name) => `mods/commands/${name}.svg`;
const MAX_HISTORY = 3000;
// Shown until you save your own (then workflows.json holds them).
const STARTER = [
  { name: "Find what's using a port", command: "Get-NetTCPConnection -LocalPort {{port}} | Select-Object -Property LocalPort, OwningProcess, @{n='Name';e={(Get-Process -Id $_.OwningProcess).ProcessName}}", description: "PowerShell" },
  { name: "Stop what's using a port", command: "Stop-Process -Id (Get-NetTCPConnection -LocalPort {{port}}).OwningProcess -Force", description: "PowerShell" },
  { name: "Undo the last commit, keep the changes", command: "git reset --soft HEAD~1", description: "git" },
  { name: "New branch from here", command: "git switch -c {{branch}}", description: "git" },
  { name: "Show the biggest files here", command: "Get-ChildItem -Recurse -File | Sort-Object Length -Descending | Select-Object -First {{count}} FullName, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}", description: "PowerShell" },
  { name: "Search the code", command: "git grep -n \"{{text}}\"", description: "git" },
];
const MODES = [["history", "History", "history"], ["workflows", "Workflows", "workflow"], ["ai", "Ask AI", "sparkles"]];

const feature = (id) => (shared("zendr.features") ?? {})[id] !== false;
const params = (command) => [...new Set([...command.matchAll(/\{\{\s*([\w -]+?)\s*\}\}/g)].map((m) => m[1]))];

// Every query word in the text, earlier and tighter matches first.
function score(text, words) {
  const low = text.toLowerCase();
  let s = 0;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i < 0) return -1;
    s += i === 0 ? 3 : 1;
  }
  return s;
}

export default class Commands extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = MODES.some(([m]) => m === p.mode) ? p.mode : "history";
    this.query = "";
    this.at = 0;
    this.history = [];
    this.workflows = null; // null until read; STARTER when there's no file
    this.answers = [];
    this.asking = false;
    this.filling = null; // { item, names, values, i } while asking for {{placeholders}}
    this.note = null;
    this.input = InputState.new({ placeholder: this.placeholder() });
    this.input.on("change", (_e, cx) => { if (!this.filling) { this.query = this.input.value(); this.at = 0; } cx.notify(); });
    this.input.on("submit", (_e, cx) => this.enter(false, cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.load(cx);
  }

  placeholder() {
    if (this.filling) return `Value for ${this.filling.names[this.filling.i]}`;
    return this.mode === "ai" ? "Describe the command, e.g. \"delete node_modules folders under here\"" : this.mode === "workflows" ? "Search workflows…" : "Search your shell history…";
  }

  setMode(mode, cx) {
    this.mode = mode; this.at = 0; this.filling = null; this.note = null;
    this.input.set_value("");
    this.query = "";
    this.input.set_placeholder?.(this.placeholder());
    this.input.focus();
    cx?.notify();
  }

  async load(cx) {
    // PowerShell's history (PSReadLine), then bash's, newest first, each command once.
    const files = window()?.platform === "windows"
      ? [`${home()}/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt`, `${home()}/.bash_history`]
      : [`${home()}/.zsh_history`, `${home()}/.bash_history`];
    const seen = new Set(), list = [];
    for (const f of files) {
      const text = await readTextFile(f).catch(() => null);
      if (!text) continue;
      const lines = text.split(/\r?\n/).map((l) => l.replace(/^: \d+:\d+;/, "").trim()).filter((l) => l.length > 1);
      for (let i = lines.length - 1; i >= 0 && list.length < MAX_HISTORY; i--) {
        if (seen.has(lines[i])) continue;
        seen.add(lines[i]);
        list.push({ command: lines[i], from: f.includes("PSReadLine") ? "PowerShell" : f.includes("zsh") ? "zsh" : "bash" });
      }
    }
    this.history = list;
    try {
      const saved = JSON.parse((await readTextFile(`${appHome()}/workflows.json`)) ?? "null");
      this.workflows = Array.isArray(saved) ? saved.filter((w) => w && typeof w.command === "string") : STARTER;
    } catch { this.workflows = STARTER; }
    cx.notify();
  }

  async saveWorkflows(list) {
    const file = `${appHome()}/workflows.json`;
    const raw = await readTextFile(file).catch(() => null);
    await writeTextFile(file, JSON.stringify(list, null, 2) + "\n", raw);
    this.workflows = list;
  }

  items() {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (this.mode === "ai") return this.answers.map((command) => ({ command, from: "AI" }));
    const source = this.mode === "workflows" ? this.workflows ?? [] : this.history;
    if (!words.length) return source.slice(0, 200);
    return source
      .map((it) => [it, score(`${it.name ?? ""} ${it.command} ${it.description ?? ""}`, words)])
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([it]) => it);
  }

  close() { closeOverlay(props()?.overlay); }

  // Pastes into (or runs in) the terminal Command search was opened from.
  deliver(command, now, cx) {
    const terminal = props()?.terminal;
    this.close();
    if (!terminal) return;
    if (now) { hc(["send", terminal, command]).catch(() => {}); return; }
    cx.write_to_clipboard(command);
    run("pane.focus", { terminal });
    run("terminal.paste");
  }

  enter(now, cx) {
    if (Date.now() - (this.lastEnter ?? 0) < 120) return; // the key and the input's submit both come
    this.lastEnter = Date.now();
    if (this.filling) {
      const f = this.filling;
      f.values[f.names[f.i]] = this.input.value();
      if (++f.i < f.names.length) { this.input.set_value(""); this.input.set_placeholder?.(this.placeholder()); cx.notify(); return; }
      const command = f.item.command.replace(/\{\{\s*([\w -]+?)\s*\}\}/g, (_m, n) => f.values[n] ?? "");
      this.filling = null;
      this.deliver(command, f.now, cx);
      return;
    }
    if (this.mode === "ai" && (this.answers.length === 0 || this.asked !== this.query.trim())) { this.ask(cx); return; }
    const it = this.items()[this.at];
    if (!it) return;
    this.pick(it, now, cx);
  }

  pick(it, now, cx) {
    const names = params(it.command);
    if (names.length) {
      this.filling = { item: it, names, values: {}, i: 0, now };
      this.input.set_value("");
      this.input.set_placeholder?.(this.placeholder());
      this.input.focus();
      cx.notify();
      return;
    }
    this.deliver(it.command, now, cx);
  }

  // Claude Code writes up to three commands for the description, for the terminal's shell.
  async ask(cx) {
    const q = this.query.trim();
    if (!q || this.asking) return;
    if (!feature("ai_command")) { this.note = "Ask AI is turned off in Settings → Features."; cx.notify(); return; }
    this.asking = true; this.note = null; this.answers = []; this.asked = q; cx.notify();
    const p = props() ?? {};
    const shell = p.shell || (window()?.platform === "windows" ? "PowerShell" : "bash");
    const prompt = `Write a ${shell} command that does this: ${q}\nThe working folder is ${p.cwd || "unknown"}. `
      + "Reply with one to three alternative commands, one per line, best first. No explanations, numbering, quotes around the whole line, or code fences.";
    const r = await exec("claude", ["-p", prompt, "--model", "haiku"], { cwd: p.cwd || home(), timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
    this.asking = false;
    if (r.code !== 0) this.note = `Claude Code didn't answer: ${(r.stderr || r.stdout || "").trim().split("\n")[0] || "is it installed and signed in?"}`;
    else {
      this.answers = r.stdout.split(/\r?\n/).map((l) => l.replace(/^```\w*|```$/g, "").replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").replace(/^`(.*)`$/, "$1").trim()).filter(Boolean).slice(0, 3);
      if (!this.answers.length) this.note = "No command came back. Try describing it another way.";
    }
    this.at = 0;
    cx.notify();
  }

  async saveAsWorkflow(it, cx) {
    const list = [...(this.workflows ?? STARTER)];
    if (list.some((w) => w.command === it.command)) { this.note = "That's already a workflow."; cx.notify(); return; }
    list.unshift({ name: it.command.length > 60 ? it.command.slice(0, 57) + "…" : it.command, command: it.command, description: it.from ?? "" });
    try { await this.saveWorkflows(list); this.note = "Saved to Workflows. Edit workflows.json to name it or add {{placeholders}}."; }
    catch (e) { this.note = `Couldn't save: ${e}`; }
    cx.notify();
  }

  async editWorkflows(cx) {
    const file = `${appHome()}/workflows.json`;
    if ((await readTextFile(file).catch(() => null)) === null) await this.saveWorkflows(this.workflows ?? STARTER).catch(() => {});
    const path = window()?.platform === "windows" ? file.replace(/\//g, "\\") : file;
    const code = await exec("code", [path], { timeout: 8000 }).catch(() => null);
    if (code?.code !== 0) await exec(window()?.platform === "windows" ? "notepad" : "open", [path], { timeout: 8000 }).catch(() => null);
    this.close();
  }

  smallButton(t, id, name, label, tip, fn) {
    return h_flex().id(id).h(24).px(7).gap(5).flex_none().items_center().rounded(6).text_size(11).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .child(svg(icon(name)).size(12)).when(Boolean(label), (el) => el.child(label));
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    if (!feature("command_search") && this.mode !== "ai") this.mode = "ai";
    const modes = MODES.filter(([m]) => (m === "ai" ? feature("ai_command") : m === "workflows" ? feature("workflows") && feature("command_search") : feature("command_search")));
    const list = this.filling ? [] : this.items();
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const empty = this.mode === "ai"
      ? (this.asking ? "Asking Claude Code…" : "Describe what you want to do, then press Enter.")
      : this.mode === "workflows" ? (this.workflows === null ? "Loading…" : "No workflows match.") : (this.history.length ? "Nothing in your history matches." : "No shell history found yet.");

    return v_flex().id("commands").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (e.key === "escape") { if (this.filling) { this.filling = null; this.input.set_value(this.query); } else this.close(); }
        else if (e.key === "down") this.at = Math.min(list.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else if (k === "ctrl-enter") this.enter(true, cx);
        else if (e.key === "enter") this.enter(false, cx);
        else if (e.key === "tab") { const i = modes.findIndex(([m]) => m === this.mode); this.setMode(modes[(i + 1) % modes.length][0]); }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      // Modes
      .child(h_flex().h(44).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .children(modes.map(([m, label, ic]) => {
          const on = this.mode === m;
          return h_flex().id(`cmd-mode-${m}`).h(28).px(10).gap(6).items_center().rounded(7).cursor_pointer().text_size(12)
            .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.setMode(m, cx))
            .child(svg(icon(ic)).size(13)).child(label);
        }))
        .child(div().flex_1())
        .when(this.mode === "workflows", (el) => el.child(this.smallButton(t, "cmd-edit", "edit", "Edit", "Open workflows.json to add, rename or remove workflows", (cx) => this.editWorkflows(cx)))))
      // Search
      .child(h_flex().flex_none().px(12).py(10).gap(8).items_center()
        .child(svg(icon(this.filling ? "edit" : this.mode === "ai" ? "sparkles" : "history")).size(14).text_color(this.filling ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(7).bg(t.background).border_1().border_color(t.accent)
          .child(Input.new(this.input).h_full().text_size(13).text_color(t.foreground))))
      .when(Boolean(this.filling), (el) => el.child(div().px(14).pb(8).text_size(11.5).text_color(t.muted)
        .child(`${this.filling.item.name ?? this.filling.item.command}: ${this.filling.i + 1} of ${this.filling.names.length}. Enter for the next, Esc to go back.`)))
      .when(Boolean(this.note), (el) => el.child(div().px(14).pb(8).text_size(11.5).text_color(t.muted).child(this.note)))
      // List
      .child(v_flex().id("cmd-list").flex_1().min_h(0).overflow_y_scroll().px(6).pb(6)
        .children(list.map((it, i) => h_flex().id(`cmd-${i}`).w_full().flex_none().px(10).py(7).gap(10).items_center().rounded(7).cursor_pointer()
          .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(it, false, cx))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .when(Boolean(it.name), (el) => el.child(div().truncate().font_semibold().child(it.name)))
            .child(div().truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(it.name ? t.muted : t.foreground).child(it.command)))
          .when(i === this.at, (el) => el
            .when(this.mode !== "workflows" && feature("workflows"), (el) => el.child(this.smallButton(t, `cmd-save-${i}`, "save", null, "Save as a workflow", (cx) => this.saveAsWorkflow(it, cx))))
            .child(this.smallButton(t, `cmd-paste-${i}`, "paste", "Paste", "Paste into the terminal to check first (Enter)", (cx) => this.pick(it, false, cx)))
            .child(this.smallButton(t, `cmd-run-${i}`, "play", "Run", "Run it now (Ctrl+Enter)", (cx) => this.pick(it, true, cx))))))
        .when(!list.length && !this.filling, (el) => el.child(div().p(20).text_color(t.dim).child(empty))))
      // Footer
      .child(h_flex().h(30).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("Enter: paste to check").child("Ctrl+Enter: run").child("Tab: History / Workflows / Ask AI").child(div().flex_1())
        .child(p.terminal ? `into ${p.where ?? p.terminal}` : "no terminal focused"));
  }
}
