// Settings → Claude tools and Settings → Add-ons: mods from the herdr gallery that Zendr
// ships switched off. Each lives in addons/<id>/ (its mods, the author's LICENSE, a NOTICE
// and a preview), listed in addons/catalog.json. Turning one on copies its mods into mods/
// and shows it (mod.dock); turning it off takes it out of the layout and deletes the copy.
// settings.json `addons.<id>: true` remembers which are on.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, appHome, readTextFile, writeTextFile, notify, window } from "herdr";

const I = (name) => `frame/settings/${name}.svg`;
const MARK = ".zendr-addon"; // in every copied mod folder: only those are ever deleted

const WHERE = {
  open: "Opens from its button here, or from the command palette (Ctrl+Shift+P)",
  side: "Shows in the right-hand panel, beside Hub and Notifications",
  status: "Sits in the status bar along the bottom of the window",
  tab: "Opens in a tab of its own",
  pane: "Opens beside the terminal you're in",
  place: "Sits along the edge of the window",
};

const windows = () => window()?.platform === "windows";
const native = (p) => (windows() ? p.replace(/\//g, "\\") : p);

async function copyDir(from, to) {
  if (windows()) {
    // robocopy exits 0-7 when it worked.
    const r = await exec("robocopy", [native(from), native(to), "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { timeout: 60000 });
    if (r.code >= 8) throw new Error(r.stdout.trim() || r.stderr.trim() || `robocopy ${r.code}`);
  } else {
    const r = await exec("cp", ["-R", `${from}/.`, to], { timeout: 60000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "cp failed");
  }
}

async function removeDir(path) {
  const r = windows()
    ? await exec("cmd", ["/c", "rmdir", "/s", "/q", native(path)], { timeout: 60000 })
    : await exec("rm", ["-rf", path], { timeout: 60000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "could not delete the folder");
}

export function openLink(url) {
  if (windows()) exec("rundll32", ["url.dll,FileProtocolHandler", url]);
  else exec(window()?.platform === "macos" ? "open" : "xdg-open", [url]);
}

export const addonMethods = {
  async loadAddons() {
    try {
      const text = await readTextFile(`${appHome()}/addons/catalog.json`);
      this.addons = text ? JSON.parse(text).addons ?? [] : [];
      this.addonsError = text ? null : "No add-ons are installed. Run Zendr's config\\install.ps1 to add them.";
    } catch (e) {
      this.addons = [];
      this.addonsError = `addons/catalog.json: ${e?.message ?? e}`;
    }
  },

  addonOn(a) {
    return this.person.addons?.[a.id] === true;
  },

  async enableAddon(a) {
    const home = appHome();
    for (const m of a.mods) {
      const to = `${home}/mods/${m}`;
      const there = await readTextFile(`${to}/mod.json`).catch(() => null);
      const ours = await readTextFile(`${to}/${MARK}`).catch(() => null);
      if (there && ours === null) throw new Error(`You already have a mod called "${m}". Rename or remove it first.`);
      await copyDir(`${home}/addons/${a.id}/mods/${m}`, to);
      await writeTextFile(`${to}/${MARK}`, `${a.id}\n`);
    }
    if (a.show === "side") run("mod.dock", { name: a.id, into: "side" });
    else if (a.show === "status") run("mod.dock", { name: a.id, into: "status", size: a.size ?? 320 });
    else if (a.show === "place") run("mod.dock", { name: a.id });
  },

  async disableAddon(a) {
    const home = appHome();
    for (const m of a.mods) run("mod.undock", { name: m });
    for (const m of a.mods) {
      const to = `${home}/mods/${m}`;
      const ours = await readTextFile(`${to}/${MARK}`).catch(() => null);
      if (ours !== null) await removeDir(to);
    }
  },

  setAddon(a, on, cx) {
    if (this.addonBusy[a.id]) return;
    this.addonBusy[a.id] = on ? "Turning on…" : "Turning off…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (on) await this.enableAddon(a);
        else await this.disableAddon(a);
        const failed = await this.save((p) => {
          p.addons = { ...(p.addons ?? {}) };
          if (on) p.addons[a.id] = true;
          else delete p.addons[a.id];
        });
        if (failed) notify({ ...failed, level: "error" });
      } catch (e) {
        notify({ title: `${a.title}: ${on ? "not turned on" : "not turned off"}`, body: String(e?.message ?? e), level: "error" });
      }
      delete this.addonBusy[a.id];
      cx.notify();
    });
  },

  openAddon(a) {
    if (a.show === "open") run("mod.open", { name: a.id });
    else if (a.show === "side") { run("layout.show", { id: "side" }); run("layout.select", { stack: "side", child: a.id }); }
    else if (a.show === "tab") run("tab.new", { mod: a.id, name: a.title });
    else if (a.show === "pane") run("pane.split", { direction: "right", mod: a.id });
  },

  // One add-on: its preview, what it does, who made it, and its switch.
  addonCard(t, a) {
    const on = this.addonOn(a), busy = this.addonBusy[a.id];
    const canOpen = on && !busy && ["open", "side", "tab", "pane"].includes(a.show);
    const link = (id, label, url) => div().id(id).text_size(12).text_color(t.accent).cursor_pointer().hover((s) => s.underline()).on_click(() => openLink(url)).child(label);
    return h_flex().w_full().gap(14).py(14).items_start().border_b(1).border_color(t.border)
      .child(div().w(150).h(94).flex_none().rounded(8).overflow_hidden().border_1().border_color(t.border).bg(t.raised)
        .when(Boolean(a.preview), (el) => el.child(image(`addons/${a.id}/${a.preview}`).size_full())))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child(a.title))
          .when(on, (el) => el.child(div().px(6).py(1).rounded(5).bg(t.accent + "22").text_size(10.5).text_color(t.accent).child("ON"))))
        .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(a.about))
        .child(div().text_size(11.5).text_color(t.dim).child(WHERE[a.show] ?? ""))
        .when(Boolean(a.needs), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`Needs ${a.needs}.`)))
        .child(h_flex().gap(12).items_center().pt(2)
          .child(div().text_size(12).text_color(t.dim).child(`By ${a.author} · ${a.license}`))
          .child(link(`st-a-repo-${a.id}`, "Source", a.repo))
          .child(link(`st-a-gal-${a.id}`, "Gallery", a.gallery))))
      .child(v_flex().flex_none().gap(8).items_end()
        .child(h_flex().gap(8).items_center()
          .when(Boolean(busy), (el) => el.child(div().text_size(11.5).text_color(t.accent).child(busy)))
          .child(this.toggle(t, `st-a-${a.id}`, on, (_e, cx) => this.setAddon(a, !on, cx))))
        .when(canOpen, (el) => el.child(this.button(t, `st-a-open-${a.id}`, "Open", () => this.openAddon(a)))));
  },

  // What a page's search box and filters are set to, kept per page.
  addonView(kind, cx) {
    this.addonViews ??= {};
    let v = this.addonViews[kind];
    if (!v) {
      const input = InputState.new({ placeholder: kind === "claude" ? "Search Claude tools: usage, review, prompts…" : "Search add-ons: notes, run, git, games…" });
      v = this.addonViews[kind] = { input, q: "", state: "all", group: null, where: null };
      input.on("change", (_e, cx) => { v.q = input.value().trim().toLowerCase(); cx.notify(); });
    }
    return v;
  },

  addonMatches(a, v) {
    if (v.state === "on" && !this.addonOn(a)) return false;
    if (v.state === "off" && this.addonOn(a)) return false;
    if (v.group && a.group !== v.group) return false;
    if (v.where && a.show !== v.where) return false;
    if (!v.q) return true;
    const text = `${a.title} ${a.about} ${a.author} ${a.group} ${a.needs ?? ""} ${a.id}`.toLowerCase();
    return v.q.split(/\s+/).every((w) => text.includes(w));
  },

  // The search box and the rows of filter chips above the cards.
  addonFilters(t, kind, list, v) {
    const chip = (id, label, active, onClick, count) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(13).cursor_pointer()
      .border_1().border_color(active ? t.accent : t.border).bg(active ? t.accent + "22" : t.background)
      .text_size(11.5).text_color(active ? t.accent : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .child(label)
      .when(count !== undefined, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
    const onN = list.filter((a) => this.addonOn(a)).length;
    const groups = [...new Set(list.map((a) => a.group))];
    const wheres = [...new Set(list.map((a) => a.show))];
    const WHERE_SHORT = { open: "Popup", side: "Side panel", status: "Status bar", tab: "Own tab", pane: "Beside terminal", place: "Window edge" };
    const row = (label, chips) => h_flex().w_full().gap(6).items_start()
      .child(div().w(54).h(26).flex_none().flex().items_center().text_size(11).text_color(t.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().children(chips));
    const busy = Boolean(v.q || v.state !== "all" || v.group || v.where);
    return v_flex().w_full().gap(8).pb(16)
      .child(h_flex().w_full().h(34).px(10).gap(8).items_center().rounded(8).bg(t.background).border_1().border_color(v.q ? t.accent : t.input)
        .child(svg(I("search")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(v.input).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground))
        .when(busy, (el) => el.child(div().id(`st-af-clear-${kind}`).flex_none().text_size(11.5).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
          .on_click((_e, cx) => { v.input.set_value(""); v.q = ""; v.state = "all"; v.group = null; v.where = null; cx.notify(); }).child("Clear"))))
      .child(row("Show", [
        chip(`st-af-all-${kind}`, "All", v.state === "all", () => (v.state = "all"), list.length),
        chip(`st-af-on-${kind}`, "On", v.state === "on", () => (v.state = "on"), onN),
        chip(`st-af-off-${kind}`, "Off", v.state === "off", () => (v.state = "off"), list.length - onN),
      ]))
      .child(row("Topic", groups.map((g, i) => chip(`st-af-g${i}-${kind}`, g, v.group === g, () => (v.group = v.group === g ? null : g), list.filter((a) => a.group === g).length))))
      .child(row("Shows", wheres.map((w) => chip(`st-af-w-${w}-${kind}`, WHERE_SHORT[w] ?? w, v.where === w, () => (v.where = v.where === w ? null : w), list.filter((a) => a.show === w).length))));
  },

  // The page: what add-ons are, how to turn one on, then each group.
  addonsPage(t, kind) {
    const all = (this.addons ?? []).filter((a) => a.kind === kind);
    const v = this.addonView(kind);
    const list = all.filter((a) => this.addonMatches(a, v));
    const onCount = all.filter((a) => this.addonOn(a)).length;
    const claude = kind === "claude";
    const intro = claude
      ? "Tools for working with Claude Code, made by people in the Herdr community. They're all off until you turn them on."
      : "More tools from the Herdr community gallery: runners, finders, notes, monitors and a few games. They're all off until you turn them on.";
    const step = (n, title, text) => h_flex().flex_1().min_w(0).gap(10).items_start()
      .child(div().size(22).flex_none().rounded(11).bg(t.accent).flex().items_center().justify_center().text_size(11.5).font_bold().text_color(t.accent_foreground).child(String(n)))
      .child(v_flex().min_w(0).gap(2).child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title)).child(div().text_size(11.5).line_height("16px").text_color(t.dim).child(text)));
    const head = v_flex().w_full().gap(14).pb(18)
      .child(div().w_full().min_w(0).pr(12).text_size(12.5).line_height("18px").text_color(t.dim).child(`${intro} ${onCount} of ${all.length} on.`))
      .child(h_flex().w_full().gap(16).p(14).rounded(10).bg(t.raised).border_1().border_color(t.border)
        .child(step(1, "Pick one", "Read what it does and look at its picture."))
        .child(step(2, "Flip the switch", "It's added at once. No restart."))
        .child(step(3, "Open it", "With Open, the palette, or where the card says it sits.")))
      .child(div().text_size(11.5).line_height("16px").text_color(t.dim)
        .child("Each add-on is its author's work, shipped unchanged with their licence (addons/<name>/LICENSE and NOTICE.md). Turning one off removes it again; nothing else of yours is touched."));
    if (!this.addons) return v_flex().w_full().child(head).child(div().py(12).text_size(13).text_color(t.dim).child("Reading the add-ons…"));
    if (this.addonsError) return v_flex().w_full().child(head).child(div().py(12).text_size(13).text_color(t.blocked).child(this.addonsError));
    const groups = [...new Set(list.map((a) => a.group))];
    return v_flex().w_full().child(head).child(this.addonFilters(t, kind, all, v))
      .when(!list.length, (el) => el.child(div().py(24).text_size(13).text_color(t.dim).child("Nothing matches. Try other words, or Clear.")))
      .children(groups.map((g) =>
      v_flex().w_full().pb(18).child(this.heading(t, g)).children(list.filter((a) => a.group === g).map((a) => this.addonCard(t, a)))));
  },
};
