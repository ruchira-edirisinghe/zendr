<p align="center"><img src="docs/zendr.png" width="128" alt="Zendr"></p>

<h1 align="center">Zendr</h1>

<p align="center">A desktop terminal app for coding agents. Native on Windows ARM64, with a built-in code reviewer and cmux-style agent tracking.</p>

Zendr is made from the code of **[Herdr](https://herdr.dev)** ([herdrdev](https://github.com/herdrdev)), the software it grew out of. Herdr does the hard part: terminals that keep running in a background core, agent status, spaces and tabs, a mod system, and a GPU-rendered UI. Zendr is Herdr's desktop app built natively for Windows on ARM. It is renamed, has a new icon, and adds a code reviewer and features inspired by **[cmux](https://cmux.com)**. Thanks to both projects.

## What's in it

**From Herdr.** Spaces, tabs and split panes; terminals that survive closing or updating the app; agent status for Claude Code, Codex and others; other machines over SSH; a command palette; themes; and mods, which are small JavaScript files that can change any part of the UI.

**A simple layout.** On the left, one **Sessions** list: each space, with its sessions (its agents and shells) under it, each saying what it's doing and whether it needs you. Click a space's arrow to fold it. Along the top, a toolbar of labelled buttons: **Commands**, **Explorer**, **Code**, **Hub** and **Notifications**. Each one lights up while its panel is showing. A space opens with just the terminal. The hub and notifications share one drawer on the right. Settings → Features → Separate Agents list brings back the old Agents list.

**Code reviewer.** The **Explorer** and **Code** buttons add a VS Code-style file explorer and the code reviewer beside the terminal.
- The code reviewer shows each file whole, with changes inline. Lines are numbered as they are now; removed lines show in red without a number.
- It has syntax highlighting and a change ruler. `n`/`p` (or F7) jump between changes.
- It can show only the changed parts, or open the file in VS Code at that line.
- The toolbar, or a tab's right-click menu, shows or hides the explorer, the code reviewer and the terminal. Each space remembers its choice.
- The Changes panel can open any changed file in full, beside the terminal or in its own tab.

**Inspired by cmux:**
- **Notifications drawer.** The **Notifications** button in the toolbar shows an unread count and opens a drawer on the right. Agents that need you are pinned at the top as cards, each with **Go to it** and **Dismiss**. Everything else is a quiet timeline below, grouped by day: finished agents, session-bridge messages and other notices, each named in words with its own icon. **Mark all read** and **Pause 1h** are at the bottom. `Ctrl+Shift+I` opens the drawer; `Ctrl+Shift+U` jumps to the latest unread.
- **Notification settings.** Settings → Notifications sets, for each kind, whether it pops up, plays a sound and reaches the inbox. It also covers do not disturb, how long pop-ups stay (or until clicked), the button's badge (number, dot or nothing), how many notifications to keep, marking read when you go there, pane rings and the sidebar line.
- **Attention rings.** A pane whose agent needs you gets a tinted header with a coloured edge. Its tab lights up too.
- **A sidebar that says what each space is up to.** Under a space's name, with Space details on: the ports its programs listen on, its branch's pull request (via `gh`), its session-bridge status, and its latest unread notification.
- **Agents that say what they're doing.** Each agent in the Sessions list shows its current task (its title) and a one-line summary: the question it's asking, the step it's on, or its last message.
- **Session bridge.** The [session-bridge](https://github.com/iddhi-sulakshana/claude-mods/tree/main/claude-session-bridge) Claude Code mod lets Claude sessions message each other and hand off work. In Zendr it:
  - opens a new space for a new session (`/bridge-spawn builder build`)
  - switches to another session (`/bridge-focus`)
  - names tabs after their sessions
  - shows its status in the sidebar and its held messages in the inbox

**New in Zendr:**
- **The hub.** The **Hub** button opens a drawer on the right with every agent and what it's doing. A coordinator, a Claude Code session that plans the work and messages the others over the session bridge, is shown apart at the top. The hub lists the messages between sessions and has a box for you to message the coordinator, one agent or everyone. **Start coordinator** opens the coordinator in a new space with its brief.
- **Session colours.** Give a session one of twelve named colours, or let it use its space's. The colour tints its whole row in Sessions, its tab and its hub card; the selected one is stronger and outlined. Right-click the row, the card or the tab, or press `Ctrl+Shift+Y` for the focused session. A space's menu changes the space's colour.

**Inspired by Warp:**
- **Command search** (`Ctrl+Shift+R`, or the `</>` button in the tab bar). Your shell history and your saved workflows in one searchable list. Enter pastes the command into the terminal for you to check; Ctrl+Enter runs it.
- **Workflows.** Saved commands with `{{placeholders}}` that Zendr asks you to fill in. Save one from your history, or edit `workflows.json`.
- **Ask AI** (`Ctrl+Shift+Space`). Describe what you want, and Claude Code writes up to three commands for the terminal's shell.
- **Launch configurations** (`Ctrl+Shift+J`). Save the spaces and tabs you have open as a setup, and open it again later. Agents start again in their folders.

Warp's command blocks and its input editor aren't here: they would need changes to the terminal itself.

**Make it yours:** Settings → Features turns off anything you don't use, or **Keep it simple** turns off all the extras at once. Finished agents show in green.

A few cmux features aren't here. The in-app browser isn't possible, because Herdr's mod API has no web view. Session restore, SSH machines, a CLI and workspace number keys were already in Herdr.

## Layout of this repository

| Folder | What it is | Made from |
| --- | --- | --- |
| `app/` | The Zendr desktop app (Rust, GPUI, Direct3D on Windows) | [herdr-app](https://github.com/herdrdev/herdr-app) v0.1.18 |
| `core/` | herdr-core and its CLI `hc`, which run the terminals | [herdr-core](https://github.com/herdrdev/herdr-core) v0.1.22, with Windows ARM64 fixes |
| `tui/` | herdr, Herdr's terminal UI, with a Windows ARM64 build script | [herdr](https://github.com/herdrdev/herdr) v0.9.5 |
| `config/` | Zendr's mods, its layout and shortcuts, and `install.ps1` | New, and clones of Herdr's built-in mods |

`app/`, `core/` and `tui/` are git subtrees, and each keeps its upstream license and notices. Their full histories are on the `zendr` and `windows-arm64` branches of [herdr-app](https://github.com/ruchira-edirisinghe/herdr-app/tree/zendr), [herdr-core](https://github.com/ruchira-edirisinghe/herdr-core/tree/windows-arm64) and [herdr](https://github.com/ruchira-edirisinghe/herdr/tree/windows-arm64).

Changes from Herdr:
- **app.** The name Zendr wherever people read it, the lizard icon, a credit in Settings, a Notifications settings section the app follows (pop-up length, do not disturb, sounds by kind), and an ARM64 build-and-install script.
- **core.** A static CRT, the ARM64 ConPTY (`OpenConsole.exe`), and an installer that takes a local ARM64 build.

Internal names are unchanged, so Herdr setups and tools keep working: `herdr-app.exe`, `hc`, `~/.config/herdr-app` and the key contexts. The installer also adds a `zendr` command.

## Build and install (Windows ARM64)

You need:
- Rust (`aarch64-pc-windows-msvc`)
- Visual Studio Build Tools with the ARM64 tools, and the Windows SDK
- LLVM for ARM64 (`clang`, `libclang`)
- Zig 0.16.0, the x64 build. The native ARM64 Zig crashes on some Windows 11 builds.

The header of `app/scripts/build-windows-arm64.ps1` has the expected paths.

```powershell
git clone https://github.com/ruchira-edirisinghe/zendr
cd zendr
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

It fetches Ghostty and builds and installs herdr-core, then Zendr. Zendr appears in the Start menu. The script finishes by installing the mods and layout. To install only the mods and layout into an existing Herdr or Zendr, run `.\config\install.ps1`.

Other platforms: `app/` and `core/` build as upstream Herdr does (see their READMEs). The mods in `config/` work in any Herdr desktop app 0.1.18 or newer.

## Updating from Herdr

```powershell
git subtree pull --prefix=app https://github.com/herdrdev/herdr-app master --squash
git subtree pull --prefix=core https://github.com/herdrdev/herdr-core master --squash
```

Then rebuild.

## License

Apache License 2.0, the same as Herdr: see [LICENSE](LICENSE) and [NOTICE](NOTICE). "Herdr" is the Herdr authors' name for their software. Zendr is a separate build and is not made or endorsed by them or by cmux.
