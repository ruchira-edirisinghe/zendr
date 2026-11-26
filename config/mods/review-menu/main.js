// Herdr's context menus (the shipped "menu" mod, herdr-app 0.1.18, Apache-2.0), with Show/Hide
// items for the layout's file explorer, code reviewer and terminal on a tab's right-click.
// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, layout, shared } from "herdr";

// A tab's session: its agent's terminal, else its first.
// Settings → Features.
const features = () => shared("zendr.features") ?? {};
const leadTerminal = (tab) => (panes().find((p) => p.tab === tab && p.program?.agent) ?? panes().find((p) => p.tab === tab && p.terminal))?.terminal;

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}

// The layout's work blocks a tab's menu shows or hides; the last one shown stays.
const VIEWS = [["explorer", "file explorer", "panel-left"], ["code", "code reviewer", "file-text"], ["main", "terminal", "terminal"]];
function viewItems() {
  const root = layout(), present = VIEWS.filter(([id]) => findNode(root, id) && (id === "main" || features().code_view !== false));
  const shown = present.filter(([id]) => !findNode(root, id).hidden).length;
  return present.map(([id, name]) => findNode(root, id).hidden
    ? [`Show ${name}`, "layout.show", { id }]
    : shown > 1 ? [`Hide ${name}`, "layout.hide", { id }] : null).filter(Boolean);
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Rename", "pane.rename", { pane: tg.pane }],
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ...viewItems(),
        ["Rename", "tab.rename", { id: tg.id }],
        ...(leadTerminal(tg.id) && features().session_colors !== false ? [["Colour…", "color", { kind: "agent", id: leadTerminal(tg.id), name: spaces().flatMap((s) => s.tabs).find((c) => c.id === tg.id)?.name }]] : []),
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["New tab", "tab.new", { space: tg.id }],
        ["New terminal", "space.terminal", { space: tg.id }],
        ["Rename", "space.rename", { id: tg.id }],
        ["Change icon…", "icon", { id: tg.id, name: spaces().find((s) => s.id === tg.id)?.name }],
        ...(features().session_colors === false ? [] : [["Colour…", "color", { kind: "space", id: tg.id, name: spaces().find((s) => s.id === tg.id)?.name }]]),
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command, args) {
  if (command === "layout.show" || command === "layout.hide") return `mods/workspace-chrome/${command === "layout.hide" ? "minus" : (VIEWS.find(([id]) => id === args?.id)?.[2] ?? "square")}.svg`;
  if (command === "color") return "mods/session-color/palette.svg";
  if (command === "icon") return "mods/space-icon/smile.svg";
  if (command === "space.terminal") return "mods/workspace-chrome/terminal.svg";
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? (args?.direction === "down" ? "panel-bottom" : "panel-right") : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

// A new terminal in a space: beside the first terminal of the tab it shows (a new tab
// when it has none), after bringing the space up.
function newTerminal(spaceId) {
  const space = spaces().find((s) => s.id === spaceId);
  if (!space) return;
  const tab = space.tabs.find((t) => t.active) ?? space.tabs[0];
  const pane = tab && panes().find((p) => p.tab === tab.id && p.terminal);
  if (!space.active) run("space.select", { id: space.id });
  if (pane) run("pane.split", { direction: "right", pane: pane.pane });
  else run("tab.new", { space: space.id });
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else if (it[1] === "color") openOverlay({ mod: "session-color", kind: "popup", width: 268, props: it[2] });
    else if (it[1] === "icon") openOverlay({ mod: "space-icon", kind: "popup", width: 360, height: 430, props: it[2] });
    else if (it[1] === "space.terminal") newTerminal(it[2].space);
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "tab.rename" || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1], it[2])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
