//! `herdr-app do <command> [--arg value ... | json]`, `herdr-app ls`, `herdr-app commands`
//! and `herdr-app status`: drive a running window from a shell (agents, tests)
//! over `$HERDR_APP_HOME/herdr-app.sock`, one JSON line each way.
//!
//! Each request carries `"auth"`: a key the window makes anew at every start and writes to
//! herdr-app.sock.key, readable only by this account. Whoever can't read the key can't drive
//! the window, even where they can reach the socket. Only `{"raise": true}` (a second launch
//! bringing this window to the front) needs no key.

use crate::mods::{self, Request};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(windows)]
use uds_windows::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn socket() -> PathBuf {
    mods::app_dir().join("herdr-app.sock")
}

fn key_path() -> PathBuf {
    mods::app_dir().join("herdr-app.sock.key")
}

/// Writes a new key, readable only by this account (0600 on Unix; on Windows the file sits
/// in the profile, whose permissions are this account's).
fn write_key(path: &Path) -> std::io::Result<String> {
    let key = crate::remote::token();
    let _ = std::fs::remove_file(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(key.as_bytes())?;
    Ok(key)
}

fn read_key(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|k| k.trim().to_owned()).filter(|k| !k.is_empty())
}

/// Whether a request may run, and the request without its key.
fn authorize(mut cmd: Value, key: &str) -> Result<Value, &'static str> {
    if cmd == json!({ "raise": true }) {
        return Ok(cmd);
    }
    let given = cmd.as_object_mut().and_then(|o| o.remove("auth"));
    let ok = given.as_ref().and_then(Value::as_str).is_some_and(|g| {
        // Every byte compared, whatever matches.
        g.len() == key.len() && g.bytes().zip(key.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    });
    if ok { Ok(cmd) } else { Err("unauthorized: this request needs the key in herdr-app.sock.key") }
}

/// Serves the socket for this window. A live socket means another window owns this home.
pub fn listen(tx: async_channel::Sender<Request>) {
    let path = socket();
    if UnixStream::connect(&path).is_ok() {
        tracing::warn!("another Zendr is serving {}; `herdr-app do` goes there", path.display());
        return;
    }
    let key = match write_key(&key_path()) {
        Ok(k) => std::sync::Arc::new(k),
        Err(e) => return tracing::warn!("cannot write {}: {e}; `herdr-app do` is off", key_path().display()),
    };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return tracing::warn!("cannot serve {}: {e}", path.display()),
    };
    let _ = std::thread::Builder::new().name("herdr-app-control".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let (tx, key) = (tx.clone(), key.clone());
            std::thread::spawn(move || serve(stream, tx, &key));
        }
    });
}

fn serve(stream: UnixStream, tx: async_channel::Sender<Request>, key: &str) {
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return;
    }
    let request = serde_json::from_str::<Value>(&line).map_err(|e| format!("bad request: {e}")).and_then(|cmd| authorize(cmd, key).map_err(str::to_owned));
    let reply = match request {
        Ok(cmd) => {
            let timeout = Duration::from_secs(if cmd.get("shot").is_some() { 30 } else { 5 });
            let (reply_tx, reply_rx) = std::sync::mpsc::channel();
            let _ = tx.send_blocking(Request::Control { cmd, reply: reply_tx });
            reply_rx.recv_timeout(timeout).unwrap_or_else(|_| json!({ "error": "the window did not answer" }))
        }
        Err(e) => json!({ "error": e }),
    };
    let _ = (&stream).write_all(format!("{reply}\n").as_bytes());
}

/// One Herdr per home: a second launch brings the running window to the
/// front and quits. True when one is running (even one too busy to answer:
/// a second window would ring every alert twice).
pub fn raise_running() -> bool {
    raise_running_at(&socket())
}

fn raise_running_at(path: &std::path::Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(path) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if stream.write_all(format!("{}\n", json!({ "raise": true })).as_bytes()).is_ok() {
        let _ = BufReader::new(&stream).read_line(&mut String::new());
    }
    true
}

/// The client side; returns the process exit code.
pub fn client(args: &[String]) -> i32 {
    if args == ["commands"] {
        println!("{}", serde_json::to_string_pretty(&crate::commands::listing()).unwrap());
        return 0;
    }
    let cmd = match args {
        [verb, rest @ ..] if verb == "shot" && rest.len() <= 1 => {
            let path = PathBuf::from(rest.first().map(String::as_str).unwrap_or("herdr-shot.png"));
            let path = match std::path::absolute(path) {
                Ok(path) => path,
                Err(e) => return fail(&format!("cannot resolve screenshot path: {e}")),
            };
            if path.extension().is_none_or(|ext| !ext.eq_ignore_ascii_case("png")) {
                return fail("screenshot path must end in .png");
            }
            json!({ "shot": path })
        },
        [verb] if verb == "status" => json!({ "status": true }),
        [verb] if verb == "ls" => json!({ "ls": true }),
        [verb, message] if verb == "feedback" => json!({ "do": "app.feedback", "args": { "message": message, "from": "agent" } }),
        [verb, command, rest @ ..] if verb == "do" => match parse_args(rest) {
            Ok(a) => json!({ "do": command, "args": a }),
            Err(e) => return fail(&e),
        },
        _ => return fail("usage: herdr-app ls | herdr-app commands | herdr-app status | herdr-app shot [file.png] | herdr-app do <command> [--arg value ... | json]"),
    };
    let mut cmd = cmd;
    if let (Some(o), Some(key)) = (cmd.as_object_mut(), read_key(&key_path())) {
        o.insert("auth".into(), Value::String(key));
    }
    let mut stream = match UnixStream::connect(socket()) {
        Ok(s) => s,
        Err(_) if args.first().is_some_and(|v| v == "feedback") => {
            let body = crate::feedback::draft(&args[1], "", 0, "agent", "other");
            println!("{}", serde_json::to_string_pretty(&body).unwrap_or_default());
            eprintln!("Zendr must be open to review and send this feedback. Nothing was sent; core version and layout will reflect the open window.");
            return 1;
        }
        Err(e) => return fail(&format!("no Zendr window at {}: {e}", socket().display())),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(35)));
    let mut line = String::new();
    if stream.write_all(format!("{cmd}\n").as_bytes()).is_err() || BufReader::new(&stream).read_line(&mut line).is_err() {
        return fail("the window hung up");
    }
    let reply: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    if args.first().is_some_and(|v| v == "shot") {
        if let Some(error) = reply.get("error") {
            return fail(error.as_str().unwrap_or("screenshot failed"));
        }
        let Some(path) = reply.get("path").and_then(Value::as_str) else {
            return fail("the window returned no screenshot path");
        };
        println!("{path}");
    } else {
        println!("{}", serde_json::to_string_pretty(&reply).unwrap_or_default());
    }
    if reply.get("error").is_some() { 1 } else { 0 }
}

/// `--name api --argv '["pi"]'` (values that parse as JSON are JSON), or one JSON object.
fn parse_args(rest: &[String]) -> Result<Value, String> {
    match rest {
        [] => Ok(Value::Null),
        [raw] if raw.trim_start().starts_with('{') => serde_json::from_str(raw).map_err(|e| format!("args are not JSON: {e}")),
        _ => {
            let mut out = serde_json::Map::new();
            let mut it = rest.iter();
            while let Some(flag) = it.next() {
                let key = flag.strip_prefix("--").ok_or_else(|| format!("expected --<arg>, got {flag:?}"))?;
                let value = it.next().ok_or_else(|| format!("--{key} needs a value"))?;
                let v = serde_json::from_str::<Value>(value).ok().filter(|v| !v.is_string()).unwrap_or_else(|| Value::String(value.clone()));
                out.insert(key.to_owned(), v);
            }
            Ok(Value::Object(out))
        }
    }
}

/// Encode before opening the destination: GPU errors must not truncate a good shot.
pub fn save_shot<C: gpui::AppContext>(
    window: gpui::AnyWindowHandle,
    cx: &mut C,
    path: &std::path::Path,
) -> anyhow::Result<()> {
    let image = window.render_current_to_image(cx)?;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, image.width(), image.height());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        encoder.write_header()?.write_image_data(image.as_raw())?;
    }
    // A sibling temporary file keeps publication on the same filesystem.
    let temporary = path.with_file_name(format!(".herdr-shot-{}.png", std::process::id()));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    let result = (|| -> anyhow::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn fail(message: &str) -> i32 {
    eprintln!("herdr-app: {message}");
    2
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    #[test]
    fn requests_need_the_key_except_raise() {
        let key = "k3y-0123";
        assert_eq!(authorize(json!({ "raise": true }), key), Ok(json!({ "raise": true })));
        assert_eq!(authorize(json!({ "ls": true, "auth": key }), key), Ok(json!({ "ls": true })));
        assert!(authorize(json!({ "ls": true }), key).is_err());
        assert!(authorize(json!({ "ls": true, "auth": "k3y-0124" }), key).is_err());
        assert!(authorize(json!({ "ls": true, "auth": "k3y" }), key).is_err());
        assert!(authorize(json!({ "do": "remote.pair", "auth": 1 }), key).is_err());
        // "raise" with anything else still needs the key.
        assert!(authorize(json!({ "raise": true, "do": "remote.pair" }), key).is_err());
    }

    #[test]
    fn each_start_writes_a_new_key_only_this_account_reads() {
        let dir = std::env::temp_dir().join(format!("herdr-app-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("herdr-app.sock.key");
        let first = write_key(&path).unwrap();
        let second = write_key(&path).unwrap();
        assert_ne!(first, second);
        assert_eq!(read_key(&path).as_deref(), Some(second.as_str()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn flag_values_that_parse_as_json_are_json() {
        let args: Vec<String> = ["--name", "eng-123", "--focus", "false", "--argv", r#"["claude"]"#].map(String::from).into();
        assert_eq!(parse_args(&args).unwrap(), json!({ "name": "eng-123", "focus": false, "argv": ["claude"] }));
    }

    #[test]
    fn a_second_launch_raises_the_running_window() {
        let dir = std::env::temp_dir().join(format!("herdr-app-raise-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("herdr-app.sock");
        // Nothing running: this launch opens its own window.
        assert!(!raise_running_at(&path));
        // One running: it gets asked to come to the front.
        let listener = UnixListener::bind(&path).unwrap();
        let asked = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            (&stream).write_all(b"{\"ok\":true}\n").unwrap();
            serde_json::from_str::<Value>(&line).unwrap()
        });
        assert!(raise_running_at(&path));
        assert_eq!(asked.join().unwrap(), json!({ "raise": true }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
