<p align="center">
  <img src="docs/banner.png" alt="Zendr: terminals and coding agents that keep running" width="100%">
</p>

<p align="center">
  <a href="https://github.com/ruchira-edirisinghe/zendr/releases/latest"><img alt="Download" src="https://img.shields.io/github/v/release/ruchira-edirisinghe/zendr?label=download&color=3fae6a&style=for-the-badge"></a>
  <img alt="Windows x64 and ARM64" src="https://img.shields.io/badge/Windows-x64%20%7C%20ARM64-5b8def?style=for-the-badge&logo=windows">
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-8b7cf6?style=for-the-badge"></a>
  <a href="https://herdr.dev"><img alt="Made from Herdr" src="https://img.shields.io/badge/made%20from-Herdr-e3814f?style=for-the-badge"></a>
</p>

<p align="center"><b>A calm home for your terminals and coding agents.</b><br>
Every session in one list. A drawer that tells you who needs you. A code reviewer next to the agent writing the code.<br>
Terminals that keep running when the window closes.</p>

<p align="center">
  <a href="#-install">Install</a> ·
  <a href="#-a-tour">Tour</a> ·
  <a href="#-keyboard">Keys</a> ·
  <a href="#-how-it-works">How it works</a> ·
  <a href="#-build-it-yourself">Build</a> ·
  <a href="#-thanks">Thanks</a>
</p>

---

<p align="center"><img src="docs/screens/overview.png" alt="Zendr: the Sessions list, the toolbar, a terminal and the notifications drawer" width="100%"></p>

You start three Claude Code sessions, a Codex run and a dev server. An hour later one agent is waiting on a yes/no question in a tab you forgot about, one has finished, and the server is still on port 5173. **Zendr shows you all of it at a glance.** The sidebar lists every session and says what each one is doing. The toolbar tells you how many need you. One click takes you there.

Zendr is a desktop app for Windows, built from **[Herdr](https://herdr.dev)**. It runs natively on both **x64** and **ARM64** (Snapdragon, Surface Pro X and friends).

## 📦 Install

<table>
<tr><td width="60">

**1**

</td><td>

**Download the zip for your PC** from the [latest release](https://github.com/ruchira-edirisinghe/zendr/releases/latest):

| Your PC | Download |
| --- | --- |
| Intel or AMD (most PCs) | `Zendr-<version>-windows-x64.zip` |
| ARM: Snapdragon, Surface Pro X, Windows Dev Kit | `Zendr-<version>-windows-arm64.zip` |

Not sure? **Settings → System → About → System type** says *x64-based PC* or *ARM-based PC*.

</td></tr>
<tr><td>

**2**

</td><td>

**Unzip it** anywhere, for example in Downloads. Right-click the zip and choose **Extract All…**

</td></tr>
<tr><td>

**3**

</td><td>

**Run the installer.** In the extracted folder, right-click **`install.ps1`** and choose **Run with PowerShell**. Or, from a terminal in that folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

You don't need admin rights. Zendr opens when it's done.

</td></tr>
<tr><td>

**4**

</td><td>

**Say hello.** Zendr is in the Start menu. Press <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>N</kbd> for a space, type `claude` (or `codex`, `gemini`, …) and watch it appear in the Sessions list.

</td></tr>
</table>

> [!NOTE]
> The builds aren't code-signed yet. If Windows SmartScreen says *"Windows protected your PC"*, choose **More info → Run anyway**. If PowerShell won't run the script, use the `-ExecutionPolicy Bypass` command above. It applies to that one run only.

<details>
<summary><b>What the installer puts where</b></summary>

```text
%LOCALAPPDATA%\Programs\
├── herdr-app\            Zendr itself (herdr-app.exe, plus zendr.cmd for the command line)
└── herdr-core\           the background core that keeps terminals alive (hc.exe, Microsoft's ConPTY)
%USERPROFILE%\.config\herdr-app\
├── mods\                 Zendr's panels: Sessions, toolbar, hub, notifications, code reviewer, …
├── layouts\main-review.json
└── keys.json             your shortcuts (Zendr only adds its own; yours stay)
Start menu → Zendr
PATH → zendr and hc
```

The internal names come from Herdr (`herdr-app`, `hc`), so Herdr setups and tools keep working.
</details>

<details>
<summary><b>Update, or uninstall</b></summary>

**Update:** download the new zip and run its `install.ps1` again. Running terminals keep running. An open Zendr keeps working until you reopen it.

**Uninstall:**
1. Quit Zendr, and stop the core with `hc server stop`.
2. Delete `%LOCALAPPDATA%\Programs\herdr-app` and `%LOCALAPPDATA%\Programs\herdr-core`.
3. Delete **Zendr** from the Start menu folder (`%APPDATA%\Microsoft\Windows\Start Menu\Programs`).
4. Remove those two folders from your user PATH (**Edit environment variables for your account**).
5. To also remove your settings and mods, delete `%USERPROFILE%\.config\herdr-app`.
</details>

## 🦎 A tour

### The Sessions list: everything that's running, in one place

<img src="docs/screens/sessions.png" alt="The Sessions list" width="300" align="right">

The left sidebar lists your **spaces** (one per project, with an avatar colour). Under each space are its **sessions**: each agent and each shell.

Every session tells you:
- **what it is**: Claude Code's crab, Codex's mark, or a shell prompt
- **what it's doing**: its current task, and a one-line summary read from its screen (*"Running the tests…"*, *"Do you want to apply this edit?"*)
- **whether it needs you**: <kbd>Needs you</kbd> in red, a spinning **Working**, a green **Done**, or how long it's been quiet

Click a session to jump into it. Right-click to give it a colour. Fold a busy space with its arrow; a folded space still shows how many sessions it has, coloured by the most urgent.

Spaces also say what they're up to: the **ports** their programs listen on (`:5173 :8080`), their branch's **pull request** (`PR #42`), their **session-bridge** status, and their latest unread notification.

<br clear="right">

### The toolbar: one row of labelled buttons

```text
 [ Hello world ✕ ] [ api ✕ ]  + ◫ ⊟ ⇄  │  </> Commands   ▯ Explorer   ▤ Code   ⑂ Graph   👥 Hub   🔔 Notifications ③  │  ─ ▢ ✕
```

No mystery icons. Each button says what it opens and **lights up while its panel is showing**. A space starts with just the terminal, and you open the rest when you want them. Each space remembers what it had open.

Beside **+** are **new terminal to the right**, **new terminal below** and **Arrange blocks**. On a narrow window the labels fold away and the buttons keep their icons and tooltips.

### The notifications drawer: what needs you comes first

<img src="docs/screens/notifications.png" alt="The notifications drawer" width="340" align="right">

Zendr notices when an agent **stops to ask you something**, when it **finishes**, and when sessions **message each other**.

- What **needs you** is pinned at the top as a card: what it asked, where, and two buttons, **Go to it** and **Dismiss**.
- Everything else follows as a **quiet timeline**, grouped by day. Each kind is named in words and has its own icon, so nothing depends on colour alone.
- **Mark all read**, or **Pause 1h** for do not disturb.

<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>I</kbd> opens the drawer. <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>U</kbd> jumps straight to the newest unread.

A pane whose agent needs you also gets an **attention ring**: a tinted header with a coloured edge, so you spot it in a split. Finished work shows in **green**.

<br clear="right">

### The hub: a coordinator for your agents

<img src="docs/screens/hub.png" alt="The hub" width="340" align="right">

Running several agents on one job? The **Hub** drawer shows them together, with the **coordinator** apart at the top.

The coordinator is a Claude Code session that plans the work and hands parts of it to the others over the **[session bridge](https://github.com/iddhi-sulakshana/claude-mods/tree/main/claude-session-bridge)**. **Start coordinator** opens one in a new space with its brief.

Below the coordinator are every agent's card and the **messages between sessions**. At the bottom is a box for **you** to message the coordinator, one agent or everyone.

<br clear="right">

```mermaid
flowchart LR
    you(["🧑 You"]) -- "message box" --> hub["🦎 Zendr hub"]
    hub --> coord["🧭 Coordinator<br/>(Claude Code)"]
    coord -- "session bridge" --> a1["🤖 Agent: api"]
    coord -- "session bridge" --> a2["🤖 Agent: web"]
    a1 -- "done / question" --> coord
    a2 -- "done / question" --> coord
    a1 & a2 & coord -. "status, summaries" .-> hub
```

### A code editor beside your agent

<p align="center"><img src="docs/screens/code.png" alt="The explorer, the code editor and the terminal side by side" width="100%"></p>

Click **Explorer** and **Code** in the toolbar, and the space becomes a small IDE built for working alongside an agent:

- a **VS Code-style explorer** with the repo's changed files on top and the full tree below, each file with a **Seti-style icon** for its type
- **tabs**: a single click previews a file, a double click (or an edit) keeps it open
- **Review** mode shows each file whole with its changes inline: removed lines in red, a ruler beside the scrollbar, <kbd>N</kbd> / <kbd>P</kbd> (or <kbd>F7</kbd>) to jump between changes and **Changes only** to fold the rest away
- **Edit** mode is a real editor: <kbd>Ctrl</kbd> <kbd>S</kbd> saves (line endings kept), and if the agent changes the file meanwhile you choose whose version wins
- **language detection** from the file name, a shebang (`#!/usr/bin/env python3`), a modeline or the content itself; click the language in the status bar to change it
- <kbd>Ctrl</kbd> + **mouse wheel** zooms the code in and out, to see more lines or fewer
- **Split editor** opens a second code view beside the first, and the toolbar's split buttons open more terminals. Open as many as you like.
- **VS Code** opens the file at the line you're reading

| Keys in the editor | Does |
| --- | --- |
| <kbd>Ctrl</kbd> <kbd>P</kbd> | Quick open a file (`:42` goes to a line, `>` runs an editor command) |
| <kbd>Ctrl</kbd> <kbd>G</kbd> | Go to line |
| <kbd>Ctrl</kbd> <kbd>F</kbd> / <kbd>Ctrl</kbd> <kbd>H</kbd> | Find / replace |
| <kbd>Ctrl</kbd> <kbd>/</kbd> | Comment or uncomment the lines |
| <kbd>Ctrl</kbd> <kbd>]</kbd> / <kbd>[</kbd> | Indent / outdent |
| <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> | Add a cursor above / below |
| <kbd>Alt</kbd> <kbd>Z</kbd> | Word wrap |
| <kbd>Ctrl</kbd> <kbd>E</kbd> | Switch between Review and Edit |
| <kbd>Ctrl</kbd> <kbd>\</kbd> | Split the editor |
| <kbd>Ctrl</kbd> <kbd>W</kbd> | Close the tab |
| <kbd>F1</kbd> | Every editor shortcut |

### The source control graph

Click **Graph** in the toolbar for the repo's history in the right drawer: each commit on its **branch line**, with merges and forks drawn between them, and **branch and tag pills**. Uncommitted changes sit at the top. Click a commit to see its files, and click a file to open **that commit's change** in the code view. **All branches** shows the other branches too, and the graph refreshes itself when you commit.

### VS Code extensions

Already set up VS Code just the way you like it? Open **VS Code extensions** from the command palette (or the puzzle button in the code view's tabs). Zendr reads the extensions you have installed, built-in ones included, and lets you use:

- their **colour themes**, for the whole app (light or dark), with the theme's own **code colours** in the editor
- their **languages**, so files they know get detected and named in Zendr too

Zendr runs no extension code. It only reads the themes and language lists the extensions describe.

### Arrange the blocks

Want the drawer below the terminals instead of beside them? Click **Arrange blocks** in the toolbar (or run it from the command palette). Every block in the work area turns into a card:

- drag a card onto **another block's edge** to put it on that side: drop it on the bottom edge and it sits **below**
- drop it in the **middle** of a block to **swap** the two
- a highlight shows where it will land before you let go
- <kbd>Esc</kbd> or **Done** when you're finished

The new arrangement is saved to your layout and comes back next time.

### Colours, so you can tell sessions apart

<img src="docs/screens/colours.png" alt="The session colour picker" width="280" align="right">

Give any session one of **twelve named colours**, or let it use its space's colour. The colour tints its whole row in Sessions, its tab and its hub card. The one you're in is brighter and outlined.

Right-click a session, a tab or a hub card, or press <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Y</kbd>. Arrow keys and <kbd>Enter</kbd> work in the picker too.

<br clear="right">

### Warp-style power tools

<p align="center"><img src="docs/screens/commands.png" alt="Command search, open on Ask AI" width="640"></p>

| | |
| --- | --- |
| **Command search** <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>R</kbd> | Your shell history and saved workflows, in one searchable list. <kbd>Enter</kbd> pastes the command for you to check; <kbd>Ctrl</kbd> <kbd>Enter</kbd> runs it. |
| **Workflows** | Saved commands with `{{placeholders}}`. Zendr asks you to fill them in. Save one from history, or edit `workflows.json`. |
| **Ask AI** <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Space</kbd> | Say what you want (*"find files over 100 MB"*) and Claude Code writes up to three commands for your shell. |
| **Launch configurations** <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>J</kbd> | Save your open spaces and tabs as a setup. Open it again tomorrow, and your agents start back up in their folders. |

### Make it yours, or keep it simple

<p align="center"><img src="docs/screens/features.png" alt="Settings: Features" width="80%"></p>

**Settings → Features** has a switch for every extra, so Zendr can be as busy or as quiet as you like:

- **panels and toolbar**: the hub, the Notifications button, the source control graph, the explorer and code view, the new-terminal buttons and Arrange blocks
- **sidebar**: space details, agent summaries, session colours, session counts and the separate Agents list
- **code view**: editing (off makes it read-only), file-type icons, language detection, Ctrl + wheel zoom, VS Code extensions, shortcut hints and pane buttons
- **Warp-style tools**: each one on its own

**Keep it simple** turns all the extras off at once, and **Turn all on** brings them back.

**Settings → Claude mods** looks after the three [claude-mods](https://github.com/iddhi-sulakshana/claude-mods) plugins for Claude Code: **Next steps** (suggested next prompts as buttons), the **Session bridge** (sessions message each other; the hub uses it) and the **Model router** (each turn gets a matching reasoning effort). Turn each one on or off (Zendr installs it the first time), and open **Options** to change its settings. New Claude Code sessions pick up the changes.

**Settings → Notifications** sets, for each kind of notification, whether it pops up, plays a sound and goes to the drawer. It also covers do not disturb, how long pop-ups stay, the badge (number, dot or nothing), how many notifications to keep, and whether rings and sidebar lines show.

## ⌨ Keyboard

| Keys | Does |
| --- | --- |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>N</kbd> | New space |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>T</kbd> | New tab |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>O</kbd> / <kbd>E</kbd> | Split right / down |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Z</kbd> | Zoom a pane |
| <kbd>Alt</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> | Previous / next agent |
| <kbd>Alt</kbd> <kbd>1</kbd>…<kbd>9</kbd> · <kbd>Ctrl</kbd> <kbd>1</kbd>…<kbd>9</kbd> | Go to a space · a tab |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>I</kbd> | Notifications drawer |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>U</kbd> | Jump to the newest unread |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Y</kbd> | Colour the session you're in |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>R</kbd> | Command search |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Space</kbd> | Ask AI for a command |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>J</kbd> | Launch configurations |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>P</kbd> | Command palette: every command, by name |
| <kbd>Ctrl</kbd> <kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>B</kbd> | Show or hide the sidebar |
| <kbd>Ctrl</kbd> <kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd> | Zoom the whole app in / out / back |

Change any of them in `%USERPROFILE%\.config\herdr-app\keys.json`.

## 🧠 How it works

```mermaid
flowchart TB
    subgraph app["🦎 Zendr (herdr-app.exe)"]
        direction LR
        ui["GPU-rendered UI<br/>GPUI · Direct3D"]
        mods["Mods (JavaScript)<br/>Sessions · toolbar · hub ·<br/>notifications · code reviewer"]
        ui --- mods
    end
    subgraph core["⚙ herdr-core (hc.exe), runs in the background"]
        direction LR
        terms["Terminals<br/>Ghostty VT + ConPTY"]
        status["Agent status<br/>Claude Code · Codex · Gemini · …"]
    end
    app <-- "local connection" --> core
    core --> shells["Your shells and agents"]
    cli["zendr / hc CLI"] --> core
    cli --> app
```

- **The core keeps your terminals.** Close Zendr, update it, or restart it: your agents keep working in `herdr-core`. When Zendr comes back, they're all still there.
- **Everything you see is a mod.** The Sessions list, the toolbar, the drawers and the code reviewer are small JavaScript files in `~\.config\herdr-app\mods`. They hot-reload when you edit them, so you can change any of them.
- **Agents are recognised by the core.** It knows Claude Code, Codex, Gemini, OpenCode, Amp and others, and reports when each one is working, waiting on you or done.

## 🔨 Build it yourself

You need:
- **Rust**, with the target you're building (`rustup target add x86_64-pc-windows-msvc` or `aarch64-pc-windows-msvc`)
- **Visual Studio Build Tools**, with the C++ tools for that architecture and the Windows SDK
- **LLVM** (`clang`, `libclang`)
- **Zig 0.16.0**. On ARM64, use the x64 Zig; the native ARM64 one crashes on some Windows 11 builds.

Paths are listed at the top of `app/scripts/build-windows-arm64.ps1`.

```powershell
git clone https://github.com/ruchira-edirisinghe/zendr
cd zendr

# Build and install on this PC (ARM64)
powershell -ExecutionPolicy Bypass -File .\build.ps1

# Or make an installable zip, for either architecture, from either kind of PC
powershell -ExecutionPolicy Bypass -File .\package.ps1 -Arch x64     # dist\Zendr-<version>-windows-x64.zip
powershell -ExecutionPolicy Bypass -File .\package.ps1 -Arch arm64   # dist\Zendr-<version>-windows-arm64.zip
```

Already have Herdr? `.\config\install.ps1` adds only Zendr's mods, layout and shortcuts.

<details>
<summary><b>What's in this repository</b></summary>

| Folder | What it is | Made from |
| --- | --- | --- |
| `app/` | The Zendr desktop app (Rust, GPUI, Direct3D) | [herdr-app](https://github.com/herdrdev/herdr-app) v0.1.18 |
| `core/` | herdr-core and its CLI `hc`, which run the terminals | [herdr-core](https://github.com/herdrdev/herdr-core) v0.1.22, with Windows ARM64 fixes |
| `tui/` | herdr, Herdr's terminal UI, with a Windows ARM64 build script | [herdr](https://github.com/herdrdev/herdr) v0.9.5 |
| `config/` | Zendr's mods, layout, shortcuts and `install.ps1` | New, and clones of Herdr's built-in mods |
| `packaging/` | The installer that goes in each release zip | New |
| `build.ps1`, `package.ps1` | Build and install here, or build a release zip | New |

`app/`, `core/` and `tui/` are git subtrees, and each keeps its upstream license and notices. Their full histories are on the `zendr` and `windows-arm64` branches of [herdr-app](https://github.com/ruchira-edirisinghe/herdr-app/tree/zendr), [herdr-core](https://github.com/ruchira-edirisinghe/herdr-core/tree/windows-arm64) and [herdr](https://github.com/ruchira-edirisinghe/herdr/tree/windows-arm64).

**Changes from Herdr:**
- **app:** the name Zendr and the pixel-iguana logo; Settings sections for Notifications (which the app follows: pop-up length, do not disturb, sounds by kind) and Features; green for finished agents; and Windows build scripts.
- **core:** a static CRT, Microsoft's ConPTY for each architecture, and an installer that takes a local zip.

To update from Herdr:

```powershell
git subtree pull --prefix=app https://github.com/herdrdev/herdr-app master --squash
git subtree pull --prefix=core https://github.com/herdrdev/herdr-core master --squash
```
</details>

## 💚 Thanks

Zendr stands on two projects:

- **[Herdr](https://herdr.dev)** ([herdrdev](https://github.com/herdrdev)) is the software Zendr is made from. Herdr does the hard part: terminals that keep running in a background core, agent status, spaces and tabs, the mod system and the GPU-rendered UI. Zendr is Herdr's desktop app, renamed, with a new face and a set of mods.
- **[cmux](https://cmux.com)** by Manaflow inspired the notifications, attention rings, the sidebar's status lines and agent summaries. No cmux code is included.
- **[Warp](https://www.warp.dev)** inspired command search, workflows, Ask AI and launch configurations. No Warp code is included.

## License

Apache License 2.0, the same as Herdr: see [LICENSE](LICENSE) and [NOTICE](NOTICE). "Herdr" is the Herdr authors' name for their software. Zendr is a separate build, not made or endorsed by the Herdr authors, Manaflow or Warp.
