//! Command suggestions, as in Warp: while you type a command at a shell prompt, the rest of
//! the command you run most often that starts that way shows in grey after the cursor, and
//! Right arrow or Tab types it in.
//!
//! The history is `command-history.json` in the app's folder: each command you run at a
//! prompt in Zendr, how often and when last. The first time, it starts from your shells'
//! own histories (PowerShell's PSReadLine, bash, zsh). Commands that start with a space
//! (the shells' "don't remember this" convention) and ones that look like they hold a
//! password or a token are never kept. Settings → Features → Command suggestions turns
//! it off.
//!
//! What a terminal sends tells the line being typed ([`Line`]); the screen confirms it (the
//! text left of the cursor ends with it, so a password prompt that echoes nothing never
//! suggests or records anything).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The most commands kept; past that, the least used and oldest go.
const MAX_COMMANDS: usize = 4000;
/// Longer lines are pastes or scripts, not commands to suggest.
const MAX_LEN: usize = 1000;
/// A command's weight halves every this many days without being run.
const HALF_LIFE_DAYS: f64 = 14.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Entry {
    command: String,
    count: u32,
    /// Seconds since 1970 it was last run.
    last: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    commands: Vec<Entry>,
}

#[derive(Default)]
pub struct History {
    entries: HashMap<String, (u32, u64)>,
    path: Option<PathBuf>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// How much a command counts: how often it was run, fading with time since the last.
fn score(count: u32, last: u64, now: u64) -> f64 {
    let days = now.saturating_sub(last) as f64 / 86400.0;
    // Never below a quarter: a command run a hundred times last year still beats one run once.
    f64::from(count) * (0.5f64.powf(days / HALF_LIFE_DAYS)).max(0.25)
}

/// Whether a line is worth remembering: not empty, not a paste, not marked private with a
/// leading space, and not holding what looks like a secret.
pub fn keepable(line: &str) -> bool {
    if line.trim().is_empty() || line.starts_with(' ') || line.len() > MAX_LEN || line.contains(['\n', '\r']) {
        return false;
    }
    let lower = line.to_ascii_lowercase();
    const SECRETS: &[&str] = &["password", "passwd", "secret", "token=", "token ", "api_key", "apikey", "api-key", "authorization:", "bearer "];
    !SECRETS.iter().any(|s| lower.contains(s))
}

impl History {
    fn at(path: PathBuf) -> History {
        let mut h = History { entries: HashMap::new(), path: Some(path.clone()) };
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                if let Ok(file) = serde_json::from_str::<File>(&text) {
                    for e in file.commands {
                        h.entries.insert(e.command, (e.count.max(1), e.last));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // The first time: start from the shells' own histories.
                for file in shell_histories() {
                    h.import(&file);
                }
                h.save();
            }
            Err(e) => tracing::warn!("cannot read {}: {e}", path.display()),
        }
        h
    }

    /// Adds a shell history file: each line a command, newest last.
    fn import(&mut self, file: &Path) {
        let Ok(bytes) = std::fs::read(file) else { return };
        let text = String::from_utf8_lossy(&bytes);
        let modified = std::fs::metadata(file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or_else(now, |d| d.as_secs());
        let lines: Vec<&str> = text.lines().collect();
        let n = lines.len() as u64;
        for (i, line) in lines.iter().enumerate() {
            let command = history_line(line);
            if !keepable(command) {
                continue;
            }
            // Older lines a little further back, so the file's order counts too.
            let last = modified.saturating_sub(n - i as u64);
            let e = self.entries.entry(command.trim_end().to_owned()).or_insert((0, 0));
            e.0 += 1;
            e.1 = e.1.max(last);
        }
    }

    pub fn record(&mut self, command: &str) {
        let command = command.trim_end();
        if !keepable(command) {
            return;
        }
        let e = self.entries.entry(command.to_owned()).or_insert((0, 0));
        e.0 = e.0.saturating_add(1);
        e.1 = now();
        self.trim();
        self.save();
    }

    fn trim(&mut self) {
        if self.entries.len() <= MAX_COMMANDS {
            return;
        }
        let now = now();
        let mut ranked: Vec<(String, f64)> = self.entries.iter().map(|(c, (n, l))| (c.clone(), score(*n, *l, now))).collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (c, _) in ranked.into_iter().skip(MAX_COMMANDS) {
            self.entries.remove(&c);
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let mut commands: Vec<Entry> = self.entries.iter().map(|(c, (n, l))| Entry { command: c.clone(), count: *n, last: *l }).collect();
        commands.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.command.cmp(&b.command)));
        let file = File { version: 1, commands };
        let Ok(body) = serde_json::to_string_pretty(&file) else { return };
        if let Err(e) = crate::persist::write_atomic(path, body + "\n") {
            tracing::warn!("cannot write {}: {e}", path.display());
        }
    }

    /// The best commands that start with `prefix` and go on past it, best first.
    pub fn matching(&self, prefix: &str, limit: usize) -> Vec<String> {
        if prefix.is_empty() {
            return Vec::new();
        }
        let now = now();
        let mut found: Vec<(&String, f64, u64)> = self
            .entries
            .iter()
            .filter(|(c, _)| c.len() > prefix.len() && c.starts_with(prefix))
            .map(|(c, (n, l))| (c, score(*n, *l, now), *l))
            .collect();
        found.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.2.cmp(&a.2)).then_with(|| a.0.cmp(b.0)));
        found.into_iter().take(limit).map(|(c, _, _)| c.clone()).collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.save();
    }
}

/// A line of a shell history file as the command it was: zsh's extended lines start
/// `: <time>:<duration>;`.
fn history_line(line: &str) -> &str {
    if let Some(rest) = line.strip_prefix(": ")
        && let Some((stamp, command)) = rest.split_once(';')
        && stamp.chars().all(|c| c.is_ascii_digit() || c == ':')
    {
        return command;
    }
    line
}

fn shell_histories() -> Vec<PathBuf> {
    let home = crate::mods::home();
    let mut files = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        files.push(PathBuf::from(appdata).join(r"Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt"));
    }
    files.push(home.join(".local/share/powershell/PSReadLine/ConsoleHost_history.txt"));
    files.push(home.join(".bash_history"));
    files.push(home.join(".zsh_history"));
    files.into_iter().filter(|f| f.is_file()).collect()
}

static HISTORY: Mutex<Option<History>> = Mutex::new(None);

fn path() -> PathBuf {
    crate::mods::app_dir().join("command-history.json")
}

/// Loads the history off the UI thread (the first time it reads the shells' histories).
pub fn warm() {
    let _ = std::thread::Builder::new().name("command-history".into()).spawn(|| {
        let loaded = History::at(path());
        let mut slot = HISTORY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(loaded);
        }
    });
}

/// The best command that starts with `prefix`, if the history is loaded and not busy.
pub fn suggest(prefix: &str) -> Option<String> {
    let slot = HISTORY.try_lock().ok()?;
    slot.as_ref()?.matching(prefix, 1).into_iter().next()
}

/// Up to `limit` commands that start with `prefix`, best first (the phone's reply box).
pub fn suggestions(prefix: &str, limit: usize) -> Vec<String> {
    let slot = HISTORY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    slot.as_ref().map(|h| h.matching(prefix, limit)).unwrap_or_default()
}

pub fn record(command: &str) {
    let command = command.to_owned();
    // Writing the file is off the UI thread too.
    let _ = std::thread::Builder::new().name("command-history".into()).spawn(move || {
        let mut slot = HISTORY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(h) = slot.as_mut() {
            h.record(&command);
        }
    });
}

pub fn clear() {
    let mut slot = HISTORY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    slot.get_or_insert_with(|| History { entries: HashMap::new(), path: Some(path()) }).clear();
}

/// Whether Settings → Features leaves command suggestions on (they are unless turned off).
pub fn enabled() -> bool {
    crate::mods::shared("zendr.features").and_then(|f| f.get("command_suggestions").and_then(serde_json::Value::as_bool)) != Some(false)
}

/// The same, read from settings.json: for threads other than the window's (the phone server).
pub fn enabled_in_settings() -> bool {
    let raw = std::fs::read_to_string(crate::settings::path()).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    raw.and_then(|v| v.pointer("/features/command_suggestions").and_then(serde_json::Value::as_bool)) != Some(false)
}

/// The command line being typed in one terminal, as far as the keys sent tell it. Anything
/// that edits it in ways keys can't follow (arrows, history, completion) leaves it unknown
/// until the next Enter.
#[derive(Default, Debug)]
pub struct Line {
    text: String,
    unknown: bool,
}

impl Line {
    pub fn typed(&mut self, text: &str) {
        if self.unknown {
            return;
        }
        if text.chars().any(char::is_control) || self.text.len() + text.len() > MAX_LEN {
            self.unknown = true;
            return;
        }
        self.text.push_str(text);
    }

    pub fn backspace(&mut self) {
        if !self.unknown {
            self.text.pop();
        }
    }

    /// A new, empty line (after Enter or Ctrl+C).
    pub fn reset(&mut self) {
        self.text.clear();
        self.unknown = false;
    }

    pub fn lose_track(&mut self) {
        self.unknown = true;
        self.text.clear();
    }

    /// What's typed so far, when it's known.
    pub fn text(&self) -> Option<&str> {
        (!self.unknown).then_some(self.text.as_str())
    }
}

/// What a key does to the line being typed.
pub enum KeyEffect {
    /// Types this text.
    Text(String),
    Backspace,
    /// Runs the line (Enter).
    Submit,
    /// Abandons it (Ctrl+C).
    Cancel,
    /// Changes it in a way the keys don't tell.
    Unknown,
    /// Doesn't touch it (a modifier on its own).
    Nothing,
}

/// `key`, `text` and modifiers as GPUI reports a key press.
pub fn key_effect(key: &str, text: Option<&str>, control: bool, alt: bool, platform: bool) -> KeyEffect {
    if matches!(key, "shift" | "control" | "alt" | "platform" | "function" | "capslock") {
        return KeyEffect::Nothing;
    }
    let plain = !control && !alt && !platform;
    match key {
        "enter" if plain => KeyEffect::Submit,
        "backspace" if plain => KeyEffect::Backspace,
        "c" if control && !alt && !platform => KeyEffect::Cancel,
        "space" if plain => KeyEffect::Text(" ".into()),
        _ if plain => match text {
            Some(t) if !t.is_empty() && !t.chars().any(char::is_control) => KeyEffect::Text(t.to_owned()),
            _ => KeyEffect::Unknown,
        },
        _ => KeyEffect::Unknown,
    }
}

/// What a terminal shows on the cursor's row (and the few rows before it, for a command
/// that wrapped): whether `typed` is what's left of the cursor and nothing is right of it.
/// `rows`: each row's cells' text (empty for blanks and the tail half of wide characters).
pub fn on_screen(rows: &[Vec<&str>], cursor: (usize, usize), typed: &str) -> bool {
    let (cx, cy) = cursor;
    let Some(row) = rows.get(cy) else { return false };
    if row.iter().skip(cx).any(|t| !t.trim().is_empty()) {
        return false;
    }
    let mut left = String::new();
    for r in rows.iter().take(cy).skip(cy.saturating_sub(3)) {
        left.push_str(&row_text(r, r.len()));
    }
    left.push_str(&row_text(row, cx));
    left.ends_with(typed)
}

fn row_text(row: &[&str], upto: usize) -> String {
    let mut s = String::new();
    let mut tail = false;
    for t in row.iter().take(upto) {
        if t.is_empty() {
            // A wide character's tail half adds nothing; a blank cell is a space.
            if !tail {
                s.push(' ');
            }
            tail = false;
        } else {
            s.push_str(t);
            tail = t.chars().any(is_wide);
        }
    }
    s
}

/// East Asian wide and emoji: the ones that take two cells.
pub fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F | 0x2E80..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F |
        0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 | 0x1F300..=0x1F64F | 0x1F900..=0x1F9FF | 0x20000..=0x3FFFD)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(lines: &[&str]) -> History {
        let mut h = History::default();
        for l in lines {
            h.record(l);
        }
        h
    }

    #[test]
    fn the_most_used_command_wins_and_the_newest_breaks_a_tie() {
        let h = history(&["git status", "git push", "git status", "git commit -m x", "git status"]);
        assert_eq!(h.matching("git ", 1), ["git status"]);
        assert_eq!(h.matching("git p", 3), ["git push"]);
        assert_eq!(h.matching("git status", 1), Vec::<String>::new(), "nothing past what's typed");
        assert!(h.matching("", 5).is_empty());
    }

    #[test]
    fn old_commands_fade_but_never_below_a_quarter() {
        let now = 1_000_000_000;
        assert!(score(1, now, now) > score(1, now - 30 * 86400, now));
        assert_eq!(score(100, 0, now), 25.0);
        assert!(score(100, 0, now) > score(3, now, now));
    }

    #[test]
    fn private_and_secret_lines_are_not_kept() {
        assert!(keepable("cargo build --release"));
        assert!(!keepable(" rm -rf secret-stuff"), "a leading space keeps it private");
        assert!(!keepable("export API_KEY=abc"));
        assert!(!keepable("mysql --password hunter2"));
        assert!(!keepable("curl -H 'Authorization: Bearer x'"));
        assert!(!keepable("echo a\necho b"));
        assert!(!keepable("   "));
    }

    #[test]
    fn zsh_extended_history_lines_lose_their_stamp() {
        assert_eq!(history_line(": 1700000000:0;git log"), "git log");
        assert_eq!(history_line("git log"), "git log");
        assert_eq!(history_line(": not a stamp;x"), ": not a stamp;x");
    }

    #[test]
    fn imports_a_shell_history_once_counting_repeats() {
        let dir = std::env::temp_dir().join(format!("zendr-suggest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shell = dir.join("history.txt");
        std::fs::write(&shell, "ls\nnpm run dev\nnpm test\nnpm run dev\n").unwrap();
        let mut h = History::default();
        h.import(&shell);
        assert_eq!(h.matching("npm ", 2), ["npm run dev", "npm test"]);
        assert_eq!(h.matching("l", 1), ["ls"]);
        // Saved and read back the same.
        h.path = Some(dir.join("command-history.json"));
        h.save();
        let back = History::at(dir.join("command-history.json"));
        assert_eq!(back.matching("npm ", 2), ["npm run dev", "npm test"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_line_follows_typing_until_something_it_cannot_follow() {
        let mut l = Line::default();
        l.typed("git");
        l.typed(" ");
        l.typed("st");
        l.backspace();
        assert_eq!(l.text(), Some("git s"));
        l.lose_track();
        l.typed("x");
        assert_eq!(l.text(), None);
        l.reset();
        assert_eq!(l.text(), Some(""));
        l.typed("\u{1b}[A");
        assert_eq!(l.text(), None, "an escape sequence isn't typing");
    }

    #[test]
    fn keys_map_to_what_they_do_to_the_line() {
        assert!(matches!(key_effect("a", Some("a"), false, false, false), KeyEffect::Text(t) if t == "a"));
        assert!(matches!(key_effect("space", Some(" "), false, false, false), KeyEffect::Text(t) if t == " "));
        assert!(matches!(key_effect("enter", None, false, false, false), KeyEffect::Submit));
        assert!(matches!(key_effect("backspace", None, false, false, false), KeyEffect::Backspace));
        assert!(matches!(key_effect("c", Some("c"), true, false, false), KeyEffect::Cancel));
        assert!(matches!(key_effect("up", None, false, false, false), KeyEffect::Unknown));
        assert!(matches!(key_effect("tab", None, false, false, false), KeyEffect::Unknown));
        assert!(matches!(key_effect("r", Some("r"), true, false, false), KeyEffect::Unknown));
        assert!(matches!(key_effect("shift", None, false, false, false), KeyEffect::Nothing));
    }

    #[test]
    fn the_screen_must_show_what_was_typed_with_nothing_after_it() {
        let row = |s: &str, width: usize| -> Vec<&'static str> {
            let mut v: Vec<&'static str> = s.chars().map(|c| &*Box::leak(c.to_string().into_boxed_str())).collect();
            v.resize(width, "");
            v
        };
        let rows = vec![row("PS C:\\> git st", 20)];
        assert!(on_screen(&rows, (14, 0), "git st"));
        assert!(!on_screen(&rows, (14, 0), "git sx"), "not what was typed");
        assert!(!on_screen(&rows, (10, 0), "git"), "text right of the cursor");
        // A password prompt shows nothing of what's typed.
        assert!(!on_screen(&[row("Password: ", 20)], (10, 0), "hunter2"));
        // Spaces may be blank cells.
        let mut spaced = row("$ ls", 10);
        spaced[4] = "";
        assert!(on_screen(&[spaced], (5, 0), "ls "));
        // A command that wrapped onto the next row.
        let rows = vec![row("$ echo abcde", 12), row("fgh", 12)];
        assert!(on_screen(&rows, (3, 1), "echo abcdefgh"));
    }
}
