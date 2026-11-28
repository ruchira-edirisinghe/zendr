//! The phone companion's server: the Zendr app on a phone reaches this computer's sessions.
//!
//! Off until `remote.pair`, which turns it on and returns what the phone scans. Plain HTTP and
//! JSON on one port (7425 unless remote.json says otherwise). Every request carries the pairing
//! token. It listens only on this computer's Tailscale addresses and on 127.0.0.1 (and on its
//! local network address when `lan` is on: Tailscale encrypts the way there, a home network
//! doesn't), and answers only devices on this tailnet, not every 100.64.0.0/10 address
//! (carrier-grade NAT uses that range too). remote.json in the app's folder holds the switch,
//! the port and the token, the token encrypted for this account on Windows (DPAPI) and the file
//! readable only by this account elsewhere; a new token (`remote.pair` with `reset`) unpairs
//! every phone. Only Settings → Phone sees the pairing link: it isn't in shared state.
//!
//!   GET  /api/hello                       this computer: name, OS, version
//!   GET  /api/state                       spaces, tabs and terminals with their state (`herdr-app ls`)
//!   GET  /api/read?terminal=t7&lines=80   a terminal's screen (`hc read`); &styled=1 adds its
//!                                         colours (escape codes), cols and the theme's palette
//!   POST /api/send  {terminal, text}      paste and press Enter (`hc send`)
//!   POST /api/keys  {terminal, keys}      press keys: "enter", "esc", "1", "ctrl+c" (`hc keys`)
//!   POST /api/focus {terminal}            show it on this computer
//!   GET  /api/suggest?prefix=git&limit=5  commands from the history that start that way (suggest)

use crate::mods::{self, Request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_PORT: u16 = 7425;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 256 * 1024;
/// How often the server looks for new addresses to listen on (Tailscale starting after Zendr).
const REBIND_EVERY: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Default)]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    /// Answer this computer's home or office network too, not only Tailscale.
    pub lan: bool,
}

/// remote.json as written: the token is a password, so on Windows only its DPAPI-encrypted
/// form (for this account) is kept; older files' plain `token` is read and replaced.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Disk {
    enabled: bool,
    port: u16,
    #[serde(skip_serializing_if = "String::is_empty")]
    token: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    token_protected: String,
    lan: bool,
}

struct Running {
    port: u16,
    lan: bool,
    stop: Arc<AtomicBool>,
    /// Where it listens, to wake each accept loop when it stops.
    bound: Arc<Mutex<Vec<SocketAddr>>>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static R: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

fn config_path() -> PathBuf {
    mods::app_dir().join("remote.json")
}

pub fn load() -> Config {
    let disk: Disk = std::fs::read_to_string(config_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let token = if disk.token_protected.is_empty() { disk.token.clone() } else { unprotect(&disk.token_protected).unwrap_or_default() };
    let mut c = Config { enabled: disk.enabled, port: disk.port, token, lan: disk.lan };
    if c.port == 0 {
        c.port = DEFAULT_PORT;
    }
    // A token an older Zendr wrote in the clear is encrypted now.
    if !disk.token.is_empty() && protect("probe").is_some() {
        if let Err(e) = save(&c) {
            tracing::warn!("phone server: {e}");
        }
    }
    c
}

fn save(c: &Config) -> Result<(), String> {
    let path = config_path();
    let mut disk = Disk { enabled: c.enabled, port: c.port, lan: c.lan, ..Default::default() };
    if !c.token.is_empty() {
        match protect(&c.token) {
            Some(sealed) => disk.token_protected = sealed,
            None => disk.token = c.token.clone(),
        }
    }
    let body = serde_json::to_string_pretty(&disk).map_err(|e| e.to_string())?;
    std::fs::write(&path, body + "\n").map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    // The token is a password: only this account reads it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The token encrypted for this Windows account (DPAPI), as hex; None where there's no DPAPI.
#[cfg(windows)]
fn protect(secret: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData};
    let input = CRYPT_INTEGER_BLOB { cbData: u32::try_from(secret.len()).ok()?, pbData: secret.as_ptr().cast_mut() };
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input points at `secret` for its length; DPAPI only reads it. On success `out`
    // holds a LocalAlloc'd buffer of cbData bytes, freed below.
    unsafe {
        if CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
            return None;
        }
        let hex = std::slice::from_raw_parts(out.pbData, out.cbData as usize).iter().map(|b| format!("{b:02x}")).collect();
        LocalFree(out.pbData.cast());
        Some(hex)
    }
}

#[cfg(windows)]
fn unprotect(hex: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData};
    let mut sealed = (0..hex.len()).step_by(2).map(|i| hex.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect::<Option<Vec<u8>>>()?;
    let input = CRYPT_INTEGER_BLOB { cbData: u32::try_from(sealed.len()).ok()?, pbData: sealed.as_mut_ptr() };
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in protect().
    unsafe {
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
            return None;
        }
        let secret = String::from_utf8(std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec()).ok();
        LocalFree(out.pbData.cast());
        secret
    }
}

#[cfg(not(windows))]
fn protect(_secret: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
fn unprotect(_sealed: &str) -> Option<String> {
    None
}

/// At launch: serve again when it was on.
pub fn start_saved() {
    // Older Zendrs kept the pairing link, token included, in shared state (shared.json).
    mods::set_shared("remote.pairing".into(), Value::Null);
    let c = load();
    if c.enabled && !c.token.is_empty() {
        if let Err(e) = start(&c) {
            tracing::warn!("phone server: {e}");
        }
    }
}

/// Where to listen: this computer, its Tailscale addresses, and with `lan` its local address.
fn addresses(lan: bool) -> Vec<IpAddr> {
    let mut out = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
    out.extend(tailnet().me.iter().copied());
    if lan {
        out.extend(lan_ip().and_then(|ip| ip.parse::<IpAddr>().ok()));
    }
    out
}

fn start(c: &Config) -> Result<(), String> {
    let mut slot = running().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(r) = slot.as_ref() {
        if (r.port, r.lan) == (c.port, c.lan) {
            return Ok(());
        }
        stop_running(&mut slot);
    }
    // This computer's own address first, so a taken port is said at once.
    let local = SocketAddr::from((Ipv4Addr::LOCALHOST, c.port));
    let listener = TcpListener::bind(local).map_err(|e| format!("cannot listen on port {}: {e}", c.port))?;
    let stop = Arc::new(AtomicBool::new(false));
    let bound = Arc::new(Mutex::new(vec![local]));
    accept(listener, stop.clone())?;
    let (port, lan, flag, list) = (c.port, c.lan, stop.clone(), bound.clone());
    std::thread::Builder::new()
        .name("zendr-phone-addresses".into())
        .spawn(move || {
            let mut warned = HashSet::new();
            while !flag.load(Ordering::Relaxed) {
                for ip in addresses(lan) {
                    let addr = SocketAddr::new(ip, port);
                    if list.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains(&addr) {
                        continue;
                    }
                    match TcpListener::bind(addr) {
                        Ok(l) => {
                            if accept(l, flag.clone()).is_ok() {
                                list.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(addr);
                            }
                        }
                        Err(e) => {
                            if warned.insert(addr) {
                                tracing::warn!("phone server: cannot listen on {addr}: {e}");
                            }
                        }
                    }
                }
                let until = Instant::now() + REBIND_EVERY;
                while Instant::now() < until && !flag.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    *slot = Some(Running { port: c.port, lan: c.lan, stop, bound });
    Ok(())
}

/// Answers connections on `listener` until `stop`.
fn accept(listener: TcpListener, stop: Arc<AtomicBool>) -> Result<(), String> {
    std::thread::Builder::new()
        .name("zendr-phone".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                // Each request reads the config: a new token or `lan` applies at once.
                let _ = std::thread::Builder::new().name("zendr-phone-request".into()).spawn(move || handle(stream, &load()));
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn stop_running(slot: &mut Option<Running>) {
    if let Some(r) = slot.take() {
        r.stop.store(true, Ordering::Relaxed);
        // Wake each accept loop so it sees the flag and lets its address go.
        for addr in r.bound.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter() {
            let _ = TcpStream::connect_timeout(addr, Duration::from_millis(300));
        }
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
    let ts = tailnet_within(Duration::ZERO);
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
        "tailscale": { "installed": ts.installed, "online": ts.online, "dns": ts.dns.clone(), "ips": ts.ips.clone() },
    });
    // Settings → Phone reads it with phonePairing() (a mod's run() gets no reply). Not in
    // shared state, which every mod reads and shared.json keeps.
    *last_pairing().lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(out.clone());
    PAIRINGS.fetch_add(1, Ordering::Relaxed);
    publish_status();
    Ok(out)
}

static PAIRINGS: AtomicU64 = AtomicU64::new(0);

fn last_pairing() -> &'static Mutex<Option<Value>> {
    static P: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

/// What the last `remote.pair` returned while the server is on, for Settings → Phone only.
pub fn pairing() -> Value {
    last_pairing().lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone().unwrap_or(Value::Null)
}

/// `remote.stop`: no more answers; paired phones keep their token for when it's on again.
pub fn stop() -> Result<Value, String> {
    let mut c = load();
    c.enabled = false;
    save(&c)?;
    stop_running(&mut running().lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    last_pairing().lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
    PAIRINGS.fetch_add(1, Ordering::Relaxed);
    publish_status();
    Ok(json!({ "ok": true }))
}

/// `remote.status`: whether it's on and where it answers.
pub fn status() -> Value {
    let c = load();
    let on = running().lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_some();
    // `pairing` changes with each pairing code, so Settings → Phone shows the new one.
    json!({ "enabled": c.enabled, "running": on, "port": c.port, "lan": c.lan, "paired": !c.token.is_empty(), "pairing": PAIRINGS.load(Ordering::Relaxed) })
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
    /// This computer's Tailscale addresses, IPv6 too.
    me: Vec<IpAddr>,
    /// Every device on this tailnet, this computer included.
    members: HashSet<IpAddr>,
}

fn tailscale_ips(node: &Value) -> impl Iterator<Item = IpAddr> + '_ {
    node["TailscaleIPs"].as_array().into_iter().flatten().filter_map(Value::as_str).filter_map(|ip| ip.parse().ok())
}

/// This computer's tailnet, asked of Tailscale at most every `max_age`.
fn tailnet_within(max_age: Duration) -> Arc<Tailscale> {
    static CACHE: Mutex<Option<(Instant, Arc<Tailscale>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((_, t)) = cache.as_ref().filter(|(at, _)| at.elapsed() < max_age) {
        return t.clone();
    }
    let t = Arc::new(tailscale());
    *cache = Some((Instant::now(), t.clone()));
    t
}

fn tailnet() -> Arc<Tailscale> {
    tailnet_within(REBIND_EVERY)
}

/// Whether `ip` is a device on this tailnet. An address it doesn't know asks Tailscale again,
/// at most every few seconds, so a phone that just joined gets in.
fn tailnet_member(ip: IpAddr) -> bool {
    tailnet().members.contains(&ip) || tailnet_within(Duration::from_secs(3)).members.contains(&ip)
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
        let (ips, me_ips, members) = if online {
            let mine: Vec<IpAddr> = tailscale_ips(me).collect();
            let mut members: HashSet<IpAddr> = mine.iter().copied().collect();
            members.extend(v["Peer"].as_object().into_iter().flat_map(|peers| peers.values()).flat_map(tailscale_ips));
            (mine.iter().filter(|ip| ip.is_ipv4()).map(IpAddr::to_string).collect(), mine, members)
        } else {
            (Vec::new(), Vec::new(), HashSet::new())
        };
        return Tailscale { installed: true, online, dns, ips, me: me_ips, members };
    }
    Tailscale { installed: false, online: false, dns: None, ips: Vec::new(), me: Vec::new(), members: HashSet::new() }
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
    allowed_with(ip, lan, tailnet_member)
}

/// `allowed`, with `member` saying which addresses are on this tailnet. Tailscale's ranges
/// alone aren't enough: carrier-grade NAT hands out 100.64.0.0/10 addresses too.
fn allowed_with(ip: IpAddr, lan: bool, member: impl Fn(IpAddr) -> bool) -> bool {
    let ip = ip.to_canonical();
    if ip.is_loopback() {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            let tailscale = o[0] == 100 && (o[1] & 0xC0) == 64;
            (tailscale && member(ip)) || (lan && (v4.is_private() || v4.is_link_local()))
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            let tailscale = s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0;
            (tailscale && member(ip)) || (lan && ((s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80))
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
            let lines = q("lines").and_then(|l| l.parse::<u32>().ok()).unwrap_or(60).min(2000);
            // With colours when the window shows that terminal; else the core's plain text.
            if q("styled").as_deref() == Some("1") {
                if let (200, mut screen) = control(json!({ "do": "terminal.screen", "args": { "terminal": t, "lines": lines } })) {
                    screen["styled"] = json!(true);
                    return (200, screen);
                }
            }
            hc(&["read", "--json", "--lines", &lines.to_string(), "--", &t])
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
    fn only_this_tailnet_and_this_computer_unless_lan() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let tailnet: HashSet<IpAddr> = ["100.101.102.103", "100.127.255.1", "100.100.1.1", "fd7a:115c:a1e0::1"].map(ip).into();
        let allowed = |s: &str, lan: bool| allowed_with(ip(s), lan, |a| tailnet.contains(&a));
        assert!(allowed("127.0.0.1", false));
        assert!(allowed("::1", false));
        assert!(allowed("100.101.102.103", false));
        assert!(allowed("100.127.255.1", false));
        assert!(allowed("fd7a:115c:a1e0::1", false));
        assert!(allowed("::ffff:100.100.1.1", false));
        // Tailscale's range, but not a device on this tailnet: carrier-grade NAT.
        assert!(!allowed("100.64.0.9", false));
        assert!(!allowed("100.64.0.9", true));
        assert!(!allowed("fd7a:115c:a1e0::9", false));
        assert!(!allowed("100.128.0.1", false));
        assert!(!allowed("100.63.0.1", false));
        assert!(!allowed("192.168.1.20", false));
        assert!(allowed("192.168.1.20", true));
        assert!(allowed("10.0.0.5", true));
        assert!(!allowed("8.8.8.8", true));
        assert!(!allowed("2001:db8::1", true));
    }

    #[test]
    fn reads_the_tailnet_from_tailscale_status() {
        let v = json!({
            "BackendState": "Running",
            "Self": { "DNSName": "pc.tail1.ts.net.", "TailscaleIPs": ["100.80.1.2", "fd7a:115c:a1e0::2"] },
            "Peer": { "k1": { "TailscaleIPs": ["100.90.3.4"] }, "k2": { "TailscaleIPs": ["100.91.5.6", "fd7a:115c:a1e0::6"] } },
        });
        let mine: Vec<IpAddr> = tailscale_ips(&v["Self"]).collect();
        assert_eq!(mine, ["100.80.1.2".parse::<IpAddr>().unwrap(), "fd7a:115c:a1e0::2".parse().unwrap()]);
        let peers: Vec<IpAddr> = v["Peer"].as_object().unwrap().values().flat_map(tailscale_ips).collect();
        assert_eq!(peers.len(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn the_token_is_kept_encrypted_and_reads_back() {
        let sealed = protect("0123abcd").unwrap();
        assert!(!sealed.contains("0123abcd"));
        assert_eq!(unprotect(&sealed).as_deref(), Some("0123abcd"));
        assert_eq!(unprotect("zz"), None);
        assert_eq!(unprotect("00ff"), None);
    }

    #[test]
    fn remote_json_never_holds_the_token_in_the_clear_where_it_can_be_encrypted() {
        let disk = Disk { enabled: true, port: 7425, token: String::new(), token_protected: "abcd".into(), lan: false };
        let text = serde_json::to_string(&disk).unwrap();
        assert!(!text.contains("\"token\""), "{text}");
        // An older file's plain token still reads.
        let old: Disk = serde_json::from_str(r#"{"enabled":true,"port":7425,"token":"feed","lan":false}"#).unwrap();
        assert_eq!(old.token, "feed");
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
