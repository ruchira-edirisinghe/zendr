// VS Code extensions in Zendr: the parts an extension declares, used without VS Code.
//   Themes     A colour theme becomes a Zendr theme (themes/vscode-<name>.json): the window,
//              the terminal's 16 colours, and the code view's syntax colours (vscode/syntax.json).
//   Languages  Languages and file associations (vscode/languages.json) teach the code view
//              new file types, for its language picker, status bar and icons.
// Extensions that run code (commands, language servers, debuggers, views) need VS Code's
// extension host, a Node.js runtime with the whole VS Code API, which Zendr doesn't have;
// they're listed, marked as such, and can be opened in VS Code.
// Found in: ~/.vscode/extensions (and Insiders, VSCodium, Cursor), plus VS Code's built-ins.
// Opened with `mod.open vscode` (the palette's "VS Code extensions", the code view's button).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { props, closeOverlay, exec, readTextFile, writeTextFile, home, appHome, theme, settings, window, run, shared, setShared } from "herdr";

const ICON = name => `mods/review-file/icons/${name}.svg`;
const MAX_EXTENSIONS = 400, MAX_INCLUDES = 4;

// JSON with comments and trailing commas (VS Code's own files), as plain JSON.
function parseJsonc(text) {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === "\"") inString = false;
      i++; continue;
    }
    if (ch === "\"") { inString = true; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    out += ch; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
const join = (...parts) => parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
const dirname = p => p.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
// A theme file's include (relative to `from`), kept inside its extension's folder `base`.
function inside(base, rel, from = base) {
  const parts = [];
  for (const seg of join(from, rel).split("/")) {
    if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg);
  }
  const path = parts.join("/"), root = base.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return path.startsWith(root) ? path : null;
}
const hex6 = v => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const hexAny = v => typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
function expand(v) {
  if (!hexAny(v)) return null;
  let h = v.slice(1);
  if (h.length <= 4) h = [...h].map(c => c + c).join("");
  return "#" + h.toLowerCase();
}
// #rrggbbaa over a background, as #rrggbb.
function solid(v, bg) {
  const h = expand(v);
  if (!h) return null;
  if (h.length === 7) return h;
  const a = parseInt(h.slice(7, 9), 16) / 255, b = expand(bg) ?? "#000000";
  const mix = i => Math.round(parseInt(h.slice(i, i + 2), 16) * a + parseInt(b.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, "0");
  return "#" + mix(1) + mix(3) + mix(5);
}
const DARK = ["#1e1e1e", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#cccccc", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"];
const LIGHT = ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"];
const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

// The syntax colour for each kind of token: the first scope a rule colours, most specific first.
const SCOPES = {
  keyword: ["keyword.control", "keyword", "storage.modifier", "storage"],
  string: ["string.quoted", "string"],
  comment: ["comment.line", "comment"],
  function: ["entity.name.function", "support.function", "meta.function-call"],
  type: ["entity.name.type", "entity.name.class", "support.type", "support.class", "storage.type"],
  number: ["constant.numeric", "constant"],
  constant: ["constant.language", "support.constant", "constant"],
  boolean: ["constant.language.boolean", "constant.language"],
  variable: ["variable.other", "variable"],
  operator: ["keyword.operator"],
};
function syntaxColors(tokenColors, fg) {
  const rules = [];
  for (const r of Array.isArray(tokenColors) ? tokenColors : []) {
    const color = expand(r?.settings?.foreground);
    if (!color) continue;
    const scopes = Array.isArray(r.scope) ? r.scope : typeof r.scope === "string" ? r.scope.split(",") : [];
    for (const s of scopes) rules.push([s.trim(), color.slice(0, 7)]);
  }
  const out = {};
  for (const [kind, wanted] of Object.entries(SCOPES)) {
    for (const scope of wanted) {
      // An exact rule, else one for a parent scope ("keyword" covers "keyword.control").
      const hit = rules.find(([s]) => s === scope) ?? rules.find(([s]) => scope.startsWith(s + ".") && !s.includes(" "));
      if (hit && hit[1] !== fg) { out[kind] = hit[1]; break; }
    }
  }
  return out;
}

export default class VsCode extends View {
  init(_props, cx) {
    this.extensions = []; this.tab = "themes"; this.busy = null; this.message = null; this.loading = true;
    this.query = InputState.new({ placeholder: "Search extensions, themes and languages" });
    this.query.on("change", (_e, cx) => cx.notify());
    this.query.focus();
    this.windows = window()?.platform === "windows";
    cx.spawn(async cx => {
      try { await this.scan(); } catch (e) { this.message = { error: true, text: String(e?.message ?? e) }; }
      this.loading = false;
      const saved = await readTextFile(`${appHome()}/vscode/languages.json`).catch(() => null);
      try { const d = saved && JSON.parse(saved); this.languagesOn = Boolean(d && d.enabled !== false); this.languageCount = d?.languages?.length ?? 0; } catch { this.languagesOn = false; }
      const syn = await readTextFile(`${appHome()}/vscode/syntax.json`).catch(() => null);
      try { const d = syn && JSON.parse(syn); this.syntaxFrom = d?.enabled !== false ? d?.name ?? null : null; } catch { this.syntaxFrom = null; }
      cx.notify();
    });
  }

  // Folders holding extensions: the user's (several VS Code builds) and VS Code's built-ins.
  async roots() {
    const h = home().replace(/\\/g, "/");
    const out = [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf"].map(d => ({ path: `${h}/${d}/extensions`, builtin: false }));
    if (this.windows) {
      const local = h + "/AppData/Local/Programs";
      for (const base of [`${local}/Microsoft VS Code`, `${local}/Microsoft VS Code Insiders`, "C:/Program Files/Microsoft VS Code"]) {
        out.push({ path: `${base}/resources/app/extensions`, builtin: true });
        // Newer installs keep the app in a folder named after the build.
        for (const d of await this.list(base)) out.push({ path: `${base}/${d}/resources/app/extensions`, builtin: true });
      }
    } else {
      for (const p of ["/Applications/Visual Studio Code.app/Contents/Resources/app/extensions", "/usr/share/code/resources/app/extensions", "/opt/visual-studio-code/resources/app/extensions", "/usr/lib/code/extensions"]) out.push({ path: p, builtin: true });
    }
    return out;
  }

  // A folder's sub-folders. PowerShell gets the path as a single-quoted literal (its quotes,
  // curly ones included, doubled), the way the Files panel passes paths; sh as an argument.
  async list(path) {
    try {
      const literal = "'" + path.replace(/['‘’‚‛]/g, "$&$&") + "'";
      const r = this.windows
        ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) if (Test-Path -LiteralPath $p -PathType Container) { Get-ChildItem -LiteralPath $p -Directory -Name } } " + literal], { timeout: 15000 })
        : await exec("sh", ["-c", 'for d in "$1"/*/; do [ -d "$d" ] && basename "$d"; done', "list", path], { timeout: 15000 });
      return r.code === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 2000) : [];
    } catch { return []; }
  }

  async scan() {
    const found = new Map();
    for (const root of await this.roots()) {
      for (const dir of await this.list(root.path)) {
        if (found.size >= MAX_EXTENSIONS) break;
        if (dir.startsWith(".")) continue;
        const folder = `${root.path}/${dir}`;
        const text = await readTextFile(`${folder}/package.json`).catch(() => null);
        if (!text) continue;
        let pkg;
        try { pkg = JSON.parse(text); } catch { continue; }
        const c = pkg.contributes ?? {};
        const themes = (Array.isArray(c.themes) ? c.themes : []).filter(t => t && typeof t.path === "string");
        const languages = (Array.isArray(c.languages) ? c.languages : []).filter(l => l && typeof l.id === "string");
        // Built-ins with nothing for Zendr are noise.
        if (root.builtin && !themes.length && !languages.length) continue;
        let nls = null;
        if (JSON.stringify(pkg).includes("\"%")) {
          const n = await readTextFile(`${folder}/package.nls.json`).catch(() => null);
          try { nls = n ? JSON.parse(n) : null; } catch { nls = null; }
        }
        const word = v => typeof v === "string" && /^%.+%$/.test(v) ? (nls?.[v.slice(1, -1)]?.message ?? nls?.[v.slice(1, -1)] ?? v) : v;
        const id = `${pkg.publisher ?? "vscode"}.${pkg.name ?? dir}`.toLowerCase();
        const ext = {
          id, folder, builtin: root.builtin, version: String(pkg.version ?? ""),
          name: String(word(pkg.displayName) || pkg.name || dir), publisher: String(pkg.publisher ?? (root.builtin ? "Built in" : "")),
          description: String(word(pkg.description) ?? ""),
          themes: themes.map(t => ({ label: String(word(t.label) || t.id || t.path), ui: t.uiTheme ?? "vs-dark", path: t.path })),
          languages: languages.map(l => ({ id: l.id, name: String(word(l.aliases?.[0]) || l.id), extensions: l.extensions ?? [], filenames: l.filenames ?? [] })),
          grammars: Array.isArray(c.grammars) ? c.grammars.length : 0, snippets: Array.isArray(c.snippets) ? c.snippets.length : 0,
          runs: Boolean(pkg.main || pkg.browser), commands: Array.isArray(c.commands) ? c.commands.length : 0,
        };
        // Several versions of one extension: keep the newest.
        const old = found.get(id);
        if (!old || (!ext.builtin && old.builtin) || ext.version.localeCompare(old.version, undefined, { numeric: true }) > 0) found.set(id, ext);
      }
    }
    this.extensions = [...found.values()].sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  }

  // Reads a theme file, following its "include" chain (inside the extension's folder).
  async loadTheme(ext, rel) {
    let colors = {}, tokens = [], type = null, path = inside(ext.folder, rel), depth = 0;
    const chain = [];
    while (path && depth++ < MAX_INCLUDES) {
      const text = await readTextFile(path);
      if (text === null) throw new Error(`Can't read ${rel}`);
      const data = parseJsonc(text);
      chain.unshift(data);
      path = typeof data.include === "string" ? inside(ext.folder, data.include, dirname(path)) : null;
    }
    for (const d of chain) {
      colors = { ...colors, ...(d.colors ?? {}) };
      tokens = [...tokens, ...(Array.isArray(d.tokenColors) ? d.tokenColors : [])];
      type = d.type ?? type;
    }
    return { colors, tokens, type };
  }

  // A VS Code theme, as a Zendr theme plus code colours, and switches to it.
  async applyTheme(ext, t) {
    const { colors: k, tokens, type } = await this.loadTheme(ext, t.path);
    const light = (type ?? (t.ui === "vs" || t.ui === "hc-light" ? "light" : "dark")) === "light";
    const fallback = light ? LIGHT : DARK;
    const bg = solid(k["editor.background"], light ? "#ffffff" : "#000000") ?? solid(k["terminal.background"], "#000000") ?? (light ? "#ffffff" : "#1e1e1e");
    const fg = solid(k["editor.foreground"], bg) ?? solid(k.foreground, bg) ?? solid(k["terminal.foreground"], bg) ?? (light ? "#333333" : "#d4d4d4");
    const ansi = [];
    for (let i = 0; i < 16; i++) ansi.push(solid(k[`terminal.ansi${i < 8 ? "" : "Bright"}${ANSI[i % 8]}`], bg) ?? fallback[i]);
    const out = {
      background: bg, foreground: fg,
      selection: solid(k["editor.selectionBackground"], bg) ?? solid(k["terminal.selectionBackground"], bg) ?? (light ? "#add6ff" : "#264f78"),
      cursor: solid(k["editorCursor.foreground"], bg) ?? solid(k["terminalCursor.foreground"], bg) ?? fg,
      ansi, colors: {},
    };
    // The window's own colours, where the theme sets them.
    const pick = (key, ...names) => { for (const n of names) { const v = expand(k[n]); if (v) { out.colors[key] = v; return; } } };
    pick("accent", "focusBorder", "button.background", "activityBarBadge.background");
    pick("chrome", "sideBar.background", "titleBar.activeBackground");
    pick("border", "panel.border", "sideBar.border", "editorGroup.border", "contrastBorder");
    pick("selected", "list.activeSelectionBackground", "list.inactiveSelectionBackground");
    pick("hover", "list.hoverBackground");
    for (const key of Object.keys(out.colors)) if (out.colors[key].length === 9 && key === "chrome") out.colors[key] = solid(out.colors[key], bg);
    const slug = ("vscode-" + t.label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const dir = appHome();
    await this.write(`${dir}/themes/${slug}.json`, JSON.stringify(out, null, 2) + "\n");
    await this.write(`${dir}/vscode/syntax.json`, JSON.stringify({ name: t.label, from: ext.id, enabled: true, colors: syntaxColors(tokens, fg) }, null, 2) + "\n");
    run("app.theme", { name: slug });
    // Zendr keeps a light and a dark theme and shows one by appearance: show the one just picked.
    await this.setAppearance(light ? "light" : "dark");
    this.syntaxFrom = t.label;
    return slug;
  }

  async setAppearance(want) {
    const path = `${appHome()}/settings.json`, text = await readTextFile(path).catch(() => null);
    if (text === null) return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    if (data.appearance === want) return;
    data.appearance = want;
    await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", text).catch(() => null);
  }

  // Writes a file of ours, whatever was there (these are generated).
  async write(path, text) {
    const old = await readTextFile(path).catch(() => null);
    await writeTextFile(path, text, old);
  }

  async setLanguages(on) {
    const languages = [];
    if (on) for (const ext of this.extensions) for (const l of ext.languages) {
      if (!l.extensions.length && !l.filenames.length && ext.builtin) continue;
      languages.push({ id: l.id, name: l.name, extensions: l.extensions.slice(0, 50), filenames: l.filenames.slice(0, 50), from: ext.id });
    }
    await this.write(`${appHome()}/vscode/languages.json`, JSON.stringify({ enabled: on, languages }, null, 2) + "\n");
    this.languagesOn = on; this.languageCount = languages.length;
  }

  async resetSyntax() {
    await this.write(`${appHome()}/vscode/syntax.json`, JSON.stringify({ enabled: false }, null, 2) + "\n");
    this.syntaxFrom = null;
  }

  act(label, fn, cx) {
    if (this.busy) return;
    this.busy = label; this.message = null;
    cx.spawn(async cx => {
      try { const text = await fn(); if (text) this.message = { text }; }
      catch (e) { this.message = { error: true, text: String(e?.message ?? e).slice(0, 300) }; }
      finally { this.busy = null; cx.notify(); }
    });
    cx.notify();
  }

  close() { const id = props()?.overlay; if (id) closeOverlay(id); }

  render(cx) {
    const t = theme(), q = this.query.value().trim().toLowerCase();
    const match = (...words) => !q || words.some(w => String(w ?? "").toLowerCase().includes(q));
    const tabs = [["themes", "Themes"], ["languages", "Languages"], ["all", "All extensions"]];
    const pill = (text, color) => div().flex_none().h(18).px(7).rounded(9).flex().items_center().text_size(10.5).bg(color + "22").text_color(color).child(text);
    const button = (id, label, action, { accent = false, enabled = true, tip } = {}) => div().id(id).h(28).px(11).flex().flex_none().items_center().rounded(7).text_size(12)
      .border_1().border_color(accent ? t.accent : t.border).when(accent, e => e.bg(t.accent).text_color(t.accent_foreground ?? t.background))
      .when(!enabled, e => e.opacity(0.5)).when(Boolean(tip), e => e.tooltip(tip))
      .when(enabled, e => e.cursor_pointer().hover(s => s.opacity(0.85)).on_click((_e, cx) => action(cx))).child(label);
    let body;
    // Settings → Features: VS Code extensions turned off.
    if ((shared("zendr.features") ?? {}).vscode_ext === false) body = [v_flex().p(24).gap(12).items_start()
      .child(div().text_size(13).text_color(t.foreground).child("VS Code extensions are turned off."))
      .child(div().text_size(12).text_color(t.dim).child("Zendr isn't using their themes, code colours or languages. Turn them on again in Settings → Features."))
      .child(button("vs-open-features", "Open Settings → Features", () => { closeOverlay(); run("app.settings", { section: "features" }); }, { accent: true }))];
    else if (this.loading) body = [div().p(24).text_color(t.dim).child("Looking for VS Code and its extensions…")];
    else if (this.tab === "themes") {
      const rows = [];
      for (const ext of this.extensions) for (const th of ext.themes) if (match(th.label, ext.name)) rows.push([ext, th]);
      body = rows.slice(0, 300).map(([ext, th], i) => h_flex().id(`theme-${i}`).min_h(52).px(14).py(8).gap(12).items_center().rounded(8).hover(s => s.bg(t.hover))
        .child(div().size(30).flex_none().rounded(7).border_1().border_color(t.border).bg(th.ui === "vs" || th.ui === "hc-light" ? "#f5f5f5" : "#1e1e1e")
          .flex().items_center().justify_center().child(svg(ICON("css")).size(14).text_color(th.ui === "vs" || th.ui === "hc-light" ? "#333333" : "#cccccc")))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(13).font_medium().truncate().child(th.label))
          .child(div().text_size(11).text_color(t.dim).truncate().child(`${ext.name}${ext.builtin ? " · built into VS Code" : ` · ${ext.publisher}`}`)))
        .child(pill(th.ui === "vs" ? "Light" : th.ui === "hc-black" || th.ui === "hc-light" ? "High contrast" : "Dark", t.muted))
        .when(this.syntaxFrom === th.label, e => e.child(pill("In use", t.ansi2)))
        .child(button(`use-${i}`, this.busy === th.label ? "Applying…" : "Use",
          cx => this.act(th.label, async () => { await this.applyTheme(ext, th); return `${th.label} is on: the window, the terminal and the code colours (code tabs opened from now).`; }, cx),
          { accent: true, enabled: !this.busy, tip: "Make this Zendr's theme" })));
      if (!rows.length) body = [div().p(24).text_color(t.dim).child(this.extensions.length ? "No theme matches" : "No VS Code found on this computer")];
    } else if (this.tab === "languages") {
      const rows = [];
      for (const ext of this.extensions) for (const l of ext.languages) if ((l.extensions.length || l.filenames.length) && match(l.name, l.id, ext.name, ...l.extensions)) rows.push([ext, l]);
      body = [v_flex().gap(8).p(14).mb(6).rounded(10).border_1().border_color(t.border).bg(t.raised)
        .child(h_flex().gap(10).items_center()
          .child(v_flex().flex_1().gap(2)
            .child(div().text_size(13).font_semibold().child("Use VS Code's file types"))
            .child(div().text_size(11.5).text_color(t.dim).child("The code view learns every language and file name these extensions know: its picker, status bar and icons. Highlighting uses Zendr's built-in grammars.")))
          .child(button("languages-toggle", this.busy === "languages" ? "Saving…" : this.languagesOn ? "Turn off" : "Turn on",
            cx => this.act("languages", async () => { await this.setLanguages(!this.languagesOn); return this.languagesOn ? `${this.languageCount} languages added: reopen the code view's files to use them.` : "VS Code's file types are off."; }, cx),
            { accent: !this.languagesOn, enabled: !this.busy })))
        .when(Boolean(this.languagesOn), e => e.child(div().text_size(11).text_color(t.ansi2).child(`On: ${this.languageCount} languages`))),
      ...rows.slice(0, 300).map(([ext, l], i) => h_flex().id(`lang-${i}`).h(38).px(14).gap(10).items_center().rounded(8).hover(s => s.bg(t.hover))
        .child(svg(ICON("code")).size(14).flex_none().text_color(t.muted))
        .child(div().w(170).flex_none().truncate().text_size(12.5).child(l.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child([...l.extensions, ...l.filenames].slice(0, 8).join("  ")))
        .child(div().flex_none().max_w(160).truncate().text_size(10.5).text_color(t.dim).child(ext.name)))];
    } else {
      const rows = this.extensions.filter(e => match(e.name, e.publisher, e.description, e.id));
      body = rows.map((ext, i) => v_flex().id(`ext-${i}`).px(14).py(10).gap(6).rounded(8).hover(s => s.bg(t.hover))
        .child(h_flex().gap(8).items_center()
          .child(svg(ICON("puzzle")).size(15).flex_none().text_color(ext.builtin ? t.dim : t.accent))
          .child(div().text_size(13).font_medium().truncate().child(ext.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${ext.publisher}${ext.version ? ` · ${ext.version}` : ""}`))
          .child(div().flex_1())
          .when(ext.themes.length > 0, e => e.child(pill(`${ext.themes.length} theme${ext.themes.length === 1 ? "" : "s"} ✓`, t.ansi2)))
          .when(ext.languages.length > 0, e => e.child(pill(`${ext.languages.length} language${ext.languages.length === 1 ? "" : "s"} ✓`, t.ansi2)))
          .when(ext.runs, e => e.child(pill("Needs VS Code", t.blocked))))
        .when(Boolean(ext.description), e => e.child(div().text_size(11.5).text_color(t.dim).child(ext.description.slice(0, 220))))
        .when(ext.runs, e => e.child(div().text_size(11).text_color(t.muted)
          .child(`Its ${ext.commands ? `${ext.commands} commands and ` : ""}features run inside VS Code's extension host, which Zendr doesn't have. Zendr uses what it declares.`))));
      if (!rows.length) body = [div().p(24).text_color(t.dim).child(this.extensions.length ? "No extension matches" : "No VS Code extensions found on this computer")];
    }
    const counts = { themes: this.extensions.reduce((n, e) => n + e.themes.length, 0), languages: this.extensions.reduce((n, e) => n + e.languages.length, 0), all: this.extensions.length };
    return v_flex().id("vscode").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5).rounded(12).overflow_hidden()
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(h_flex().h(56).flex_none().px(18).gap(12).items_center().border_b(1).border_color(t.border)
        .child(div().size(32).rounded(8).bg(t.accent + "22").flex().items_center().justify_center().child(svg(ICON("puzzle")).size(17).text_color(t.accent)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(15).font_semibold().child("VS Code extensions"))
          .child(div().text_size(11.5).text_color(t.dim).child("Themes, code colours and file types from the extensions you have")))
        .child(div().id("vscode-close").size(28).flex().items_center().justify_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click(() => this.close()).child(svg(ICON("close")).size(13))))
      .child(h_flex().flex_none().px(18).pt(12).gap(10).items_center()
        .child(h_flex().flex_1().h(34).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border)
          .child(svg(ICON("search")).size(14).text_color(t.dim)).child(Input.new(this.query).flex_1().h_full().text_size(12.5)))
        .when(Boolean(this.syntaxFrom), e => e.child(button("reset-syntax", "Default code colours", cx => this.act("reset", async () => { await this.resetSyntax(); return "The code view uses the theme's terminal colours again (new tabs)."; }, cx), { tip: `Code colours come from ${this.syntaxFrom}` }))))
      .child(h_flex().flex_none().px(18).pt(10).gap(4).border_b(1).border_color(t.border)
        .children(tabs.map(([id, label]) => h_flex().id(`tab-${id}`).h(34).px(12).gap(6).items_center().cursor_pointer().text_size(12.5)
          .text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, e => e.border_b(2).border_color(t.accent)).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.tab = id; cx.notify(); })
          .child(label).child(div().text_size(10.5).text_color(t.dim).child(String(counts[id]))))))
      .when(Boolean(this.message), e => e.child(div().mx(18).mt(10).px(12).py(8).rounded(8).text_size(12)
        .bg((this.message.error ? t.ansi1 : t.ansi2) + "1f").text_color(this.message.error ? t.ansi1 : t.foreground).child(this.message.text)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("vscode-list").absolute().inset_0().overflow_y_scroll().px(8).py(8).gap(2).children(body))
        .child(Scrollbar.vertical("vscode-list").absolute().inset_0()))
      .child(h_flex().h(34).flex_none().px(18).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("Extensions that run code (commands, language servers, debuggers) need VS Code itself: Zendr uses the themes and file types they declare."));
  }
}
