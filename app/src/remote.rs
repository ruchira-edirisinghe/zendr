//! The phone companion's server: the Zendr app on a phone reaches this computer's sessions.
//!
//! Off until `remote.pair`, which turns it on and returns what the phone scans. Plain HTTP and
//! JSON on one port (7425 unless remote.json says otherwise). Every request carries the pairing
//! token, and only Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) and this computer are
//! answered, unless `lan` is on: Tailscale encrypts the way there, a home network doesn't.
//! remote.json in the app's folder holds the switch, the port and the token; a new token
//! (`remote.pair` with `reset`) unpairs every phone.
//!
//!   GET  /api/hello                       this computer: name, OS, version
//!   GET  /api/state                       spaces, tabs and terminals with their state (`herdr-app ls`)
//!   GET  /api/read?terminal=t7&lines=80   a terminal's screen (`hc read`)
//!   POST /api/send  {terminal, text}      paste and press Enter (`hc send`)
//!   POST /api/keys  {terminal, keys}      press keys: "enter", "esc", "1", "ctrl+c" (`hc keys`)
//!   POST /api/focus {terminal}            show it on this computer
//!   GET  /api/suggest?prefix=git&limit=5  commands from the history that start that way (suggest)

use crate::mods::{self, Request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const DEFAULT_PORT: u16 = 7425;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 256 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    /// Answer this computer's home or office network too, not only Tailscale.
    pub lan: bool,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static R: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

fn config_path() -> PathBuf {
    mods::app_dir().join("remote.json")
}

pub fn load() -> Config {
    let mut c: Config = std::fs::read_to_string(config_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if c.port == 0 {
        c.port = DEFAULT_PORT;
    }
    c
}

fn save(c: &Config) -> Result<(), String> {
    let path = config_path();
    let body = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    std::fs::write(&path, body + "\n").map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    // The token is a password: only this account reads it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// At launch: serve again when it was on.
pub fn start_saved() {
    let c = load();
    if c.enabled && !c.token.is_empty() {
        if let Err(e) = start(&c) {
            tracing::warn!("phone server: {e}");
        }
    }
}

fn start(c: &Config) -> Result<(), String> {
    let mut slot = running().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(r) = slot.as_ref() {
        if r.port == c.port {
            return Ok(());
        }
        stop_running(&mut slot);
    }
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, c.port)))
        .map_err(|e| format!("cannot listen on port {}: {e}", c.port))?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::Builder::new()
        .name("zendr-phone".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                // Each request reads the config: a new token or `lan` applies at once.
                let _ = std::thread::Builder::new().name("zendr-phone-request".into()).spawn(move || handle(stream, &load()));
            }
        })
        .map_err(|e| e.to_string())?;
    *slot = Some(Running { port: c.port, stop });
    Ok(())
}

fn stop_running(slot: &mut Option<Running>) {
    if let Some(r) = slot.take() {
        r.stop.store(true, Ordering::Relaxed);
        // Wake the accept loop so it sees the flag and lets the port go.
        let _ = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, r.port)), Duration::from_millis(300));
    }
}

/// `remote.pair`: turn the server on (a token made the first time, or anew with `reset`) and
/// return what a phone needs: the link, its QR code as rows of 0/1, and the addresses.
pub fn pair(args: &Value) -> Result<Value, String> {
    let mut c = load();
    if c.token.is_empty() || args.get("reset").and_then(Value::as_bool) == Some(true) {
        c.token = token();
    }
    if let Some(lan) = args.get("lan").and_then(Value::as_bool) {
        c.lan = lan;
    }
    if let Some(port) = args.get("port").and_then(Value::as_u64) {
        c.port = u16::try_from(port).ok().filter(|p| *p >= 1024).ok_or("port: a number from 1024 to 65535")?;
    }
    c.enabled = true;
    save(&c)?;
    start(&c)?;
    let ts = tailscale();
    let mut hosts: Vec<String> = Vec::new();
    hosts.extend(ts.dns.clone());
    hosts.extend(ts.ips.clone());
    if c.lan {
        hosts.extend(lan_ip());
    }
    let name = computer_name();
    let link = format!(
        "zendr://pair?v=1&name={}&port={}&token={}&hosts={}",
        enc(&name),
        c.port,
        c.token,
        enc(&hosts.join(","))
    );
    let qr = qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::M).map_err(|e| e.to_string())?;
    let width = qr.width();
    let colors = qr.to_colors();
    let rows: Vec<String> = colors
        .chunks(width)
        .map(|row| row.iter().map(|c| if *c == qrcode::Color::Dark { '1' } else { '0' }).collect())
        .collect();
    let out = json!({
        "ok": true, "link": link, "qr": rows, "name": name, "port": c.port, "lan": c.lan,
        "hosts": hosts, "code": short_code(&c.token),
        "tailscale": { "installed": ts.installed, "online": ts.online, "dns": ts.dns, "ips": ts.ips },
    });
    // Settings → Phone reads it from here: a mod's run() gets no reply.
    mods::set_shared("remote.pairing".into(), out.clone());
    publish_status();
    Ok(out)
}

/// `remote.stop`: no more answers; paired phones keep their token for when it's on again.
pub fn stop() -> Result<Value, String> {
    let mut c = load();
    c.enabled = false;
    save(&c)?;
    stop_running(&mut running().lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    mods::set_shared("remote.pairing".into(), Value::Null);
    publish_status();
    Ok(json!({ "ok": true }))
}

/// `remote.status`: whether it's on and where it answers.
pub fn status() -> Value {
    let c = load();
    let on = running().lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_some();
    json!({ "enabled": c.enabled, "running": on, "port": c.port, "lan": c.lan, "paired": !c.token.is_empty() })
}

/// The status where mods read it (shared `remote.status`).
pub fn publish_status() -> Value {
    let s = status();
    mods::set_shared("remote.status".into(), s.clone());
    s
}

// The token's first characters, shown on both screens so a person can match the two.
fn short_code(token: &str) -> String {
    token.chars().take(6).collect::<String>().to_uppercase()
}

fn token() -> String {
    let mut bytes = [0u8; 24];
    fill_random(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
fn fill_random(buf: &mut [u8]) {
    use windows_sys::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};
    // SAFETY: the buffer is valid for its length; no algorithm handle with the system RNG flag.
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    assert!(status >= 0, "BCryptGenRandom failed: {status}");
}

#[cfg(unix)]
fn fill_random(buf: &mut [u8]) {
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).expect("read /dev/urandom");
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(v) => {
                    out.push(v);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct Tailscale {
    installed: bool,
    online: bool,
    dns: Option<String>,
    ips: Vec<String>,
}

fn tailscale() -> Tailscale {
    let candidates: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files\Tailscale\tailscale.exe", "tailscale"]
    } else if cfg!(target_os = "macos") {
        &["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "tailscale"]
    } else {
        &["tailscale"]
    };
    for bin in candidates {
        let Ok(out) = crate::spawn::command(bin).args(["status", "--json"]).output() else { continue };
        let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
        let me = &v["Self"];
        let online = v["BackendState"] == "Running";
        let dns = me["DNSName"].as_str().map(|d| d.trim_end_matches('.').to_owned()).filter(|d| online && !d.is_empty());
        let ips = if online {
            me["TailscaleIPs"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|ip| !ip.contains(':')).map(str::to_owned).collect()
        } else {
            Vec::new()
        };
        return Tailscale { installed: true, online, dns, ips };
    }
    Tailscale { installed: false, online: false, dns: None, ips: Vec::new() }
}

/// This computer's address on its local network: the one a route out would leave from
/// (a UDP "connect" sends nothing).
fn lan_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then(|| ip.to_string())
}

fn computer_name() -> String {
    let env = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().filter(|s| !s.is_empty());
    env.or_else(|| {
        let out = crate::spawn::command("hostname").output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|s| !s.is_empty())
    })
    .unwrap_or_else(|| "This computer".into())
}

/// Who may connect: Tailscale and this computer; with `lan`, private networks too.
pub fn allowed(ip: IpAddr, lan: bool) -> bool {
    let ip = ip.to_canonical();
    if ip.is_loopback() {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            let tailscale = o[0] == 100 && (o[1] & 0xC0) == 64;
            tailscale || (lan && (v4.is_private() || v4.is_link_local()))
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            let tailscale = s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0;
            tailscale || (lan && ((s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80))
        }
    }
}

fn same(a: &str, b: &str) -> bool {
    // Every byte compared, whatever matches: the time taken says nothing about the token.
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

struct Req {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    auth: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Result<Req, (u16, String)> {
    let mut r = BufReader::new(stream);
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        let n = r.by_ref().take((MAX_HEAD - head.len()) as u64 + 1).read_until(b'\n', &mut line).map_err(|e| (400, e.to_string()))?;
        if n == 0 {
            return Err((400, "closed".into()));
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEAD {
            return Err((431, "headers too large".into()));
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.lines();
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or_default().to_owned();
    let target = parts.next().unwrap_or_default();
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let query = q.split('&').filter(|p| !p.is_empty()).map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (dec(k), dec(v))
    });
    let (mut auth, mut length) = (None, 0usize);
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "authorization" => auth = v.strip_prefix("Bearer ").map(str::to_owned),
            "content-length" => length = v.parse().map_err(|_| (400, "bad content-length".to_owned()))?,
            _ => {}
        }
    }
    if length > MAX_BODY {
        return Err((413, "body too large".into()));
    }
    let mut body = vec![0; length];
    r.read_exact(&mut body).map_err(|e| (400, e.to_string()))?;
    Ok(Req { method, path: path.to_owned(), query: query.collect(), auth, body })
}

fn respond(mut stream: &TcpStream, code: u16, body: &Value) {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let body = body.to_string();
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn handle(stream: TcpStream, c: &Config) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let Ok(peer) = stream.peer_addr() else { return };
    if !c.enabled || !allowed(peer.ip(), c.lan) {
        return respond(&stream, 403, &json!({ "error": "this computer only answers over Tailscale" }));
    }
    let req = match read_request(&stream) {
        Ok(r) => r,
        Err((code, e)) => return respond(&stream, code, &json!({ "error": e })),
    };
    if c.token.is_empty() || !req.auth.as_deref().is_some_and(|t| same(t, &c.token)) {
        // Slow down guessing.
        std::thread::sleep(Duration::from_millis(400));
        return respond(&stream, 401, &json!({ "error": "not paired: scan this computer's code again" }));
    }
    let (code, body) = route(&req);
    respond(&stream, code, &body);
}

fn route(req: &Req) -> (u16, Value) {
    let body: Value = if req.body.is_empty() { Value::Null } else { serde_json::from_slice(&req.body).unwrap_or(Value::Null) };
    let q = |k: &str| req.query.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
    let terminal = || -> Result<String, (u16, Value)> {
        let t = q("terminal").or_else(|| body.get("terminal").and_then(Value::as_str)).unwrap_or_default();
        valid_terminal(t).then(|| t.to_owned()).ok_or((400, json!({ "error": "terminal: an address like t7" })))
    };
    let result = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/hello") => Ok((
            200,
            json!({ "app": "zendr", "version": env!("CARGO_PKG_VERSION"), "name": computer_name(), "os": std::env::consts::OS }),
        )),
        ("GET", "/api/state") => Ok(control(json!({ "ls": true }))),
        ("GET", "/api/read") => terminal().map(|t| {
            let lines = q("lines").and_then(|l| l.parse::<u32>().ok()).unwrap_or(60).min(2000).to_string();
            hc(&["read", "--json", "--lines", &lines, "--", &t])
        }),
        ("POST", "/api/send") => terminal().and_then(|t| {
            let text = body.get("text").and_then(Value::as_str).unwrap_or_default();
            if text.is_empty() || text.len() > 16 * 1024 {
                return Err((400, json!({ "error": "text: 1 to 16384 bytes" })));
            }
            let mut args = vec!["send", "--json"];
            if body.get("force").and_then(Value::as_bool) == Some(true) {
                args.push("--force");
            }
            args.extend(["--", &t, text]);
            Ok(hc(&args))
        }),
        ("POST", "/api/keys") => terminal().and_then(|t| {
            let keys: Vec<&str> = body.get("keys").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            if keys.is_empty() || keys.len() > 20 || !keys.iter().all(|k| valid_key(k)) {
                return Err((400, json!({ "error": "keys: 1 to 20 keys like enter, esc, up, 1, ctrl+c" })));
            }
            let mut args = vec!["keys", "--json", "--", &t];
            args.extend(keys);
            Ok(hc(&args))
        }),
        ("POST", "/api/focus") => terminal().map(|t| control(json!({ "do": "pane.focus", "args": { "terminal": t } }))),
        ("GET", "/api/suggest") => {
            let prefix = q("prefix").unwrap_or_default();
            let limit = q("limit").and_then(|l| l.parse::<usize>().ok()).unwrap_or(5).clamp(1, 20);
            let list = if crate::suggest::enabled_in_settings() && prefix.len() <= 1000 { crate::suggest::suggestions(prefix, limit) } else { Vec::new() };
            Ok((200, json!({ "suggestions": list })))
        }
        _ => Err((404, json!({ "error": "no such route" }))),
    };
    result.unwrap_or_else(|e| e)
}

fn valid_terminal(t: &str) -> bool {
    !t.is_empty() && t.len() <= 80 && !t.starts_with('-') && t.chars().all(|c| c.is_alphanumeric() || "._-/".contains(c))
}

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 24 && !k.starts_with('-') && k.chars().all(|c| c.is_ascii_alphanumeric() || "+_-".contains(c))
}

/// Asks the window, as `herdr-app ls` and `herdr-app do` do.
fn control(cmd: Value) -> (u16, Value) {
    let Some(tx) = mods::request_sender() else { return (502, json!({ "error": "Zendr isn't ready" })) };
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    if tx.send_blocking(Request::Control { cmd, reply: reply_tx }).is_err() {
        return (502, json!({ "error": "Zendr is closing" }));
    }
    match reply_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(v) if v.get("error").is_some() => (502, v),
        Ok(v) => (200, v),
        Err(_) => (502, json!({ "error": "the window did not answer" })),
    }
}

/// Runs the core's CLI (`hc read`, `hc send`, `hc keys`) and passes on its JSON.
fn hc(args: &[&str]) -> (u16, Value) {
    let out = match crate::spawn::command(crate::core_bin::path()).args(args).output() {
        Ok(o) => o,
        Err(e) => return (502, json!({ "error": format!("cannot run the core: {e}") })),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let value = serde_json::from_str::<Value>(text.trim()).unwrap_or_else(|_| json!({ "output": text.trim() }));
    if out.status.success() {
        (200, value)
    } else {
        // The core says what went wrong as JSON on stderr: pass that on as it is.
        let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        let err_json = serde_json::from_str::<Value>(&err).ok().filter(|v| v.get("error").is_some());
        let body = if value.get("error").is_some() {
            value
        } else if let Some(v) = err_json {
            v
        } else {
            json!({ "error": if err.is_empty() { text.trim().to_owned() } else { err } })
        };
        (502, body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tailscale_and_this_computer_unless_lan() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(allowed(ip("127.0.0.1"), false));
        assert!(allowed(ip("::1"), false));
        assert!(allowed(ip("100.101.102.103"), false));
        assert!(allowed(ip("100.127.255.1"), false));
        assert!(!allowed(ip("100.128.0.1"), false));
        assert!(!allowed(ip("100.63.0.1"), false));
        assert!(allowed(ip("fd7a:115c:a1e0::1"), false));
        assert!(allowed(ip("::ffff:100.100.1.1"), false));
        assert!(!allowed(ip("192.168.1.20"), false));
        assert!(allowed(ip("192.168.1.20"), true));
        assert!(allowed(ip("10.0.0.5"), true));
        assert!(!allowed(ip("8.8.8.8"), true));
        assert!(!allowed(ip("2001:db8::1"), true));
    }

    #[test]
    fn decodes_queries_and_refuses_flag_like_input() {
        assert_eq!(dec("t%201+x"), "t 1 x");
        assert_eq!(dec("100%"), "100%");
        assert_eq!(dec("%zz"), "%zz");
        assert!(valid_terminal("t1w") && valid_terminal("vps/t7"));
        assert!(!valid_terminal("--force") && !valid_terminal("") && !valid_terminal("a b"));
        assert!(valid_key("ctrl+c") && valid_key("1") && !valid_key("-x"));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }
}
