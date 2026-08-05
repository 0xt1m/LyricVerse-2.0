//! Screens that are a browser tab rather than a monitor.
//!
//! A hall often has a screen the operator's machine cannot reach with a cable:
//! a tablet on the sound desk, a TV in the crèche, a phone held by whoever is
//! leading. Each of those already has a browser, so LyricVerse serves the same
//! projection page over the local network and they simply open a URL.
//!
//! The server binds `0.0.0.0`, so it is reachable from every device on the
//! network — not just the machine it runs on. That is the entire point, and it
//! is also why the media route below refuses to serve anything outside the
//! app's own data directory.
//!
//! Hand-rolled HTTP rather than a web framework. The surface is four routes
//! and the alternative was an async runtime and a dependency tree larger than
//! the rest of the backend put together.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::settings::Settings;

/// Ports below 1024 need privileges and the ephemeral range is fair game for
/// anything else on the machine, so new screens are numbered from here.
pub const DEFAULT_PORT: u16 = 8088;

/// How long a poll is held open before answering with "nothing new". Long
/// enough that an idle screen is nearly silent, short enough to sit well
/// inside every proxy and phone-radio idle timeout.
const POLL_SECONDS: u64 = 25;

/// Enough for the devices in a hall several times over. The cap exists so a
/// misbehaving client cannot spawn threads without limit.
const MAX_CONNECTIONS: usize = 64;

// --- The frame every connected screen is waiting for ----------------------

/// The current state of the app, and a revision that increments whenever it
/// changes.
///
/// Screens hold a request open until the revision moves past the one they
/// already have, so a slide change reaches a tablet as fast as the network
/// allows without anyone polling on a timer.
#[derive(Default)]
pub struct Broadcast {
    frame: Mutex<Frame>,
    changed: Condvar,
}

#[derive(Default, Clone)]
struct Frame {
    revision: u64,
    /// `{settings, live, timer}`, ready to be handed out.
    state: Option<Arc<Value>>,
}

impl Broadcast {
    fn publish(&self, state: Value) {
        if let Ok(mut frame) = self.frame.lock() {
            frame.revision = frame.revision.wrapping_add(1);
            frame.state = Some(Arc::new(state));
            self.changed.notify_all();
        }
    }

    /// Waits for a revision newer than `since`, giving up after `POLL_SECONDS`
    /// and returning whatever is current.
    fn wait(&self, since: u64) -> Frame {
        let Ok(mut frame) = self.frame.lock() else {
            return Frame::default();
        };
        if frame.revision != since {
            return frame.clone();
        }
        let deadline = Duration::from_secs(POLL_SECONDS);
        let (guard, _) = self
            .changed
            .wait_timeout_while(frame, deadline, |f| f.revision == since)
            .unwrap_or_else(|err| err.into_inner());
        frame = guard;
        frame.clone()
    }
}

// --- Server lifecycle -----------------------------------------------------

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Server {
    fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // `accept` is blocking, so it has to be woken to notice the flag.
        let _ = TcpStream::connect(("127.0.0.1", self.port))
            .map(|stream| stream.shutdown(Shutdown::Both));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Every running web screen, keyed by screen id.
#[derive(Default)]
pub struct WebScreens {
    broadcast: Arc<Broadcast>,
    servers: Mutex<HashMap<String, Server>>,
    /// Why a screen is not serving, e.g. its port is already taken. Surfaced
    /// in the Displays tab, because a silent failure here means someone finds
    /// out mid-service.
    errors: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebScreenStatus {
    pub id: String,
    pub running: bool,
    pub port: u16,
    /// Addresses to type into a browser. The LAN one first — that is the one
    /// another device needs.
    pub urls: Vec<String>,
    pub error: Option<String>,
}

impl WebScreens {
    pub fn publish(&self, state: Value) {
        self.broadcast.publish(state);
    }

    /// Brings the running servers in line with `settings`: start what should
    /// exist, stop what should not, restart anything whose port moved.
    pub fn sync(&self, app: &AppHandle, settings: &Settings) {
        let Ok(mut servers) = self.servers.lock() else {
            return;
        };
        let wanted: HashMap<&str, u16> = settings
            .web_screens
            .iter()
            .filter(|screen| {
                settings
                    .displays
                    .get(&screen.id)
                    .map(|config| config.enabled)
                    .unwrap_or(false)
            })
            .map(|screen| (screen.id.as_str(), screen.port))
            .collect();

        // Stop anything that has been switched off, deleted, or moved port.
        let stale: Vec<String> = servers
            .iter()
            .filter(|(id, server)| wanted.get(id.as_str()) != Some(&server.port))
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(server) = servers.remove(&id) {
                server.shutdown();
            }
        }

        for (id, port) in wanted {
            if servers.contains_key(id) {
                continue;
            }
            match self.start(app, id, port) {
                Ok(server) => {
                    servers.insert(id.to_string(), server);
                    if let Ok(mut errors) = self.errors.lock() {
                        errors.remove(id);
                    }
                }
                Err(message) => {
                    if let Ok(mut errors) = self.errors.lock() {
                        errors.insert(id.to_string(), message);
                    }
                }
            }
        }
    }

    fn start(&self, app: &AppHandle, id: &str, port: u16) -> std::result::Result<Server, String> {
        // 0.0.0.0 rather than 127.0.0.1: a screen nobody else on the network
        // can open would be pointless.
        let listener = TcpListener::bind(("0.0.0.0", port))
            .map_err(|err| format!("port {port} could not be opened: {err}"))?;
        listener
            .set_nonblocking(false)
            .map_err(|err| err.to_string())?;

        let stop = Arc::new(AtomicBool::new(false));
        let ctx = Arc::new(Ctx {
            screen_id: id.to_string(),
            broadcast: Arc::clone(&self.broadcast),
            app: app.clone(),
            media_root: crate::paths::data_dir(app).ok(),
        });
        let live = Arc::new(AtomicUsize::new(0));
        let flag = Arc::clone(&stop);

        let join = std::thread::Builder::new()
            .name(format!("web-{id}"))
            .spawn(move || {
                for stream in listener.incoming() {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    if live.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    live.fetch_add(1, Ordering::SeqCst);
                    let ctx = Arc::clone(&ctx);
                    let live = Arc::clone(&live);
                    let _ = std::thread::Builder::new()
                        .name("web-conn".into())
                        .spawn(move || {
                            handle(&ctx, stream);
                            live.fetch_sub(1, Ordering::SeqCst);
                        });
                }
            })
            .map_err(|err| err.to_string())?;

        Ok(Server { port, stop, join: Some(join) })
    }

    pub fn status(&self, settings: &Settings) -> Vec<WebScreenStatus> {
        let running = self
            .servers
            .lock()
            .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let errors = self.errors.lock().map(|e| e.clone()).unwrap_or_default();
        let host = lan_address();

        settings
            .web_screens
            .iter()
            .map(|screen| {
                let is_running = running.iter().any(|id| id == &screen.id);
                let mut urls = Vec::new();
                if is_running {
                    if let Some(ip) = &host {
                        urls.push(format!("http://{ip}:{}", screen.port));
                    }
                    urls.push(format!("http://localhost:{}", screen.port));
                }
                WebScreenStatus {
                    id: screen.id.clone(),
                    running: is_running,
                    port: screen.port,
                    error: errors.get(&screen.id).cloned(),
                    urls,
                }
            })
            .collect()
    }

    pub fn shutdown_all(&self) {
        if let Ok(mut servers) = self.servers.lock() {
            for (_, server) in servers.drain() {
                server.shutdown();
            }
        }
    }
}

/// This machine's address on the local network.
///
/// Opening a UDP socket "to" a public address sends no packets — it only asks
/// the routing table which interface would be used — which is the shortest
/// portable way to find the address other devices in the hall can reach.
pub fn lan_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("203.0.113.1:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    if address.is_loopback() || address.is_unspecified() {
        return None;
    }
    Some(address)
}

// --- Request handling -----------------------------------------------------

struct Ctx {
    screen_id: String,
    broadcast: Arc<Broadcast>,
    app: AppHandle,
    media_root: Option<PathBuf>,
}

fn handle(ctx: &Ctx, mut stream: TcpStream) {
    // A poll is held open deliberately, so the read timeout has to outlast it.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(POLL_SECONDS + 15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let Some(request) = read_request(&stream) else {
        return;
    };
    if request.method != "GET" {
        let _ = send(&mut stream, 405, "text/plain", &[], b"method not allowed");
        return;
    }

    let (path, query) = split_once(&request.target, '?');
    let path = percent_decode(path);

    match path.as_str() {
        "/api/state" => api_state(ctx, &mut stream, query),
        "/api/media" => api_media(ctx, &mut stream, query, request.range),
        _ => asset(ctx, &mut stream, &path),
    }
}

struct Request {
    method: String,
    target: String,
    range: Option<(u64, Option<u64>)>,
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut range = None;
    loop {
        let mut header = String::new();
        // A client that vanishes mid-request must not hold the thread.
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some(value) = header.strip_prefix("Range:").or_else(|| header.strip_prefix("range:"))
        {
            range = parse_range(value.trim());
        }
    }
    Some(Request { method, target, range })
}

/// Only `bytes=start-` and `bytes=start-end` — the two forms a video element
/// actually sends. Multi-range requests are answered with the whole file,
/// which is a legal response.
fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = split_once(spec, '-');
    let start: u64 = start.trim().parse().ok()?;
    let end = end.trim();
    let end = if end.is_empty() { None } else { Some(end.parse().ok()?) };
    Some((start, end))
}

// --- Routes ---------------------------------------------------------------

fn api_state(ctx: &Ctx, stream: &mut TcpStream, query: &str) {
    let since: u64 = param(query, "since").and_then(|v| v.parse().ok()).unwrap_or(0);
    let frame = ctx.broadcast.wait(since);

    let state = frame
        .state
        .as_deref()
        .cloned()
        .unwrap_or(Value::Null);
    let body = serde_json::json!({
        "revision": frame.revision,
        "screenId": ctx.screen_id,
        "state": state,
    });
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    // Never cached: the whole point is that it is different every time.
    let _ = send(stream, 200, "application/json", &[("Cache-Control", "no-store")], &bytes);
}

/// Serves a background, slide or clip out of the app's data directory.
///
/// The path arrives from the client, so it is resolved and then checked to be
/// inside the data directory. Without that this would be an open file server
/// for the whole machine, offered to the entire network.
fn api_media(ctx: &Ctx, stream: &mut TcpStream, query: &str, range: Option<(u64, Option<u64>)>) {
    let Some(root) = ctx.media_root.as_ref() else {
        let _ = send(stream, 500, "text/plain", &[], b"no data directory");
        return;
    };
    let Some(requested) = param(query, "path") else {
        let _ = send(stream, 400, "text/plain", &[], b"missing path");
        return;
    };

    let path = PathBuf::from(requested);
    let resolved = path.canonicalize().ok();
    let root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let Some(resolved) = resolved.filter(|p| p.starts_with(&root) && p.is_file()) else {
        let _ = send(stream, 404, "text/plain", &[], b"not found");
        return;
    };

    let Ok(mut file) = std::fs::File::open(&resolved) else {
        let _ = send(stream, 404, "text/plain", &[], b"not found");
        return;
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = mime_for(&resolved);

    // Byte ranges are not an optimisation here: Safari will not play a video
    // at all from a server that cannot seek.
    let (status, start, length) = match range {
        Some((start, end)) if start < total => {
            let end = end.unwrap_or(total - 1).min(total - 1);
            (206, start, end.saturating_sub(start) + 1)
        }
        Some(_) => {
            let headers = [("Content-Range", format!("bytes */{total}"))];
            let _ = send_owned(stream, 416, "text/plain", &headers, b"");
            return;
        }
        None => (200, 0, total),
    };

    let mut headers = vec![
        ("Accept-Ranges", "bytes".to_string()),
        ("Cache-Control", "public, max-age=3600".to_string()),
    ];
    if status == 206 {
        let end = start + length - 1;
        headers.push(("Content-Range", format!("bytes {start}-{end}/{total}")));
    }

    if file.seek(SeekFrom::Start(start)).is_err() {
        let _ = send(stream, 500, "text/plain", &[], b"seek failed");
        return;
    }
    if write_head(stream, status, &mime, &headers, length).is_err() {
        return;
    }
    // Streamed in chunks: a service video is comfortably larger than the
    // memory it would be polite to allocate for one request.
    let mut remaining = length;
    let mut buffer = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        match file.read(&mut buffer[..want]) {
            Ok(0) => break,
            Ok(read) => {
                if stream.write_all(&buffer[..read]).is_err() {
                    return;
                }
                remaining -= read as u64;
            }
            Err(_) => return,
        }
    }
    let _ = stream.flush();
}

/// The projection page and its bundle — the very same build the desktop
/// windows run, so a browser screen is not a second implementation that can
/// drift away from the real one.
fn asset(ctx: &Ctx, stream: &mut TcpStream, path: &str) {
    let relative = match path.trim_start_matches('/') {
        "" | "index.html" => "display.html",
        other => other,
    };
    // Nothing above the bundle root, whatever the client asks for.
    if Path::new(relative)
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        let _ = send(stream, 403, "text/plain", &[], b"forbidden");
        return;
    }

    let found = ctx
        .app
        .asset_resolver()
        .get(format!("/{relative}"))
        .or_else(|| ctx.app.asset_resolver().get(relative.to_string()));
    if let Some(found) = found {
        let mime = found.mime_type.clone();
        let _ = send(stream, 200, &mime, &[("Cache-Control", "no-cache")], &found.bytes);
        return;
    }

    // In a dev build the bundle is served by Vite and is not embedded, so fall
    // back to whatever `npm run build:vite` last produced.
    if cfg!(debug_assertions) {
        let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist").join(relative);
        if let Ok(bytes) = std::fs::read(&dist) {
            let mime = mime_for(&dist);
            let _ = send(stream, 200, &mime, &[("Cache-Control", "no-cache")], &bytes);
            return;
        }
        let _ = send(
            stream,
            503,
            "text/plain",
            &[],
            b"The projection page has not been built yet. Run `npm run build:vite` once, \
              or use a release build.",
        );
        return;
    }

    let _ = send(stream, 404, "text/plain", &[], b"not found");
}

// --- Plumbing -------------------------------------------------------------

fn write_head(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    headers: &[(&str, String)],
    length: u64,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {length}\r\n\
         Connection: close\r\n"
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())
}

fn send(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> std::io::Result<()> {
    let owned: Vec<(&str, String)> =
        headers.iter().map(|(k, v)| (*k, (*v).to_string())).collect();
    send_owned(stream, status, content_type, &owned, body)
}

fn send_owned(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    write_head(stream, status, content_type, headers, body.len() as u64)?;
    stream.write_all(body)?;
    stream.flush()
}

fn split_once(text: &str, separator: char) -> (&str, &str) {
    match text.split_once(separator) {
        Some((before, after)) => (before, after),
        None => (text, ""),
    }
}

fn param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = split_once(pair, '=');
        (key == name).then(|| percent_decode(&value.replace('+', " ")))
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_for(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes_including_utf8() {
        assert_eq!(percent_decode("/api/media"), "/api/media");
        assert_eq!(percent_decode("a%20b"), "a b");
        // A Ukrainian songbook name round-trips through the query string.
        assert_eq!(percent_decode("%D0%9F%D1%96%D1%81%D0%BD%D1%96"), "Пісні");
        // A stray percent is left alone rather than eating the next character.
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn reads_the_query_parameters_a_screen_sends() {
        assert_eq!(param("since=7", "since").as_deref(), Some("7"));
        assert_eq!(param("a=1&path=%2Ftmp%2Fx.png", "path").as_deref(), Some("/tmp/x.png"));
        assert_eq!(param("since=7", "path"), None);
    }

    #[test]
    fn parses_the_range_headers_a_video_element_sends() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=200-1023"), Some((200, Some(1023))));
        // Multi-range and nonsense both mean "just send the file".
        assert_eq!(parse_range("bytes=0-1,8-9"), None);
        assert_eq!(parse_range("chapters=1"), None);
    }

    #[test]
    fn a_waiting_screen_is_woken_by_the_next_change() {
        let broadcast = Arc::new(Broadcast::default());
        broadcast.publish(serde_json::json!({"live": "one"}));
        let first = broadcast.wait(0);
        assert_eq!(first.revision, 1);

        let background = Arc::clone(&broadcast);
        let waiter = std::thread::spawn(move || background.wait(1));
        std::thread::sleep(Duration::from_millis(50));
        broadcast.publish(serde_json::json!({"live": "two"}));

        let second = waiter.join().expect("waiter");
        assert_eq!(second.revision, 2);
        assert_eq!(second.state.unwrap()["live"], "two");
    }
}
