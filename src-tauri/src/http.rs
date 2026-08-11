//! The small HTTP server the app serves over the local network with.
//!
//! Two things use it: the browser screens (`webscreen`) and the phone remote
//! (`remote`). Both are a handful of routes over the LAN, so this is a
//! hand-rolled listener rather than a web framework — the alternative was an
//! async runtime and a dependency tree larger than the rest of the backend.
//!
//! Everything here binds `0.0.0.0`. That is the whole point: the devices that
//! matter are other devices in the hall. It is also why anything that reaches
//! the filesystem checks where it has landed before answering.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

/// How long a poll is held open before answering with "nothing new". Long
/// enough that an idle screen is nearly silent, short enough to sit well
/// inside every proxy and phone-radio idle timeout.
pub const POLL_SECONDS: u64 = 25;

/// Enough for the devices in a hall several times over. The cap exists so a
/// misbehaving client cannot spawn threads without limit.
const MAX_CONNECTIONS: usize = 64;

/// A request body larger than this is somebody else's problem: the ones here
/// are a pairing code and a command, both a couple of hundred bytes.
const MAX_BODY: usize = 64 * 1024;

// --- The frame every connected client is waiting for ----------------------

/// The current state of the app, and a revision that increments whenever it
/// changes.
///
/// Clients hold a request open until the revision moves past the one they
/// already have, so a slide change reaches a tablet as fast as the network
/// allows without anyone polling on a timer.
#[derive(Default)]
pub struct Broadcast {
    frame: Mutex<Frame>,
    changed: Condvar,
}

#[derive(Default, Clone)]
pub struct Frame {
    pub revision: u64,
    /// `{settings, live, timer}`, ready to be handed out.
    pub state: Option<Arc<Value>>,
}

impl Broadcast {
    pub fn publish(&self, state: Value) {
        if let Ok(mut frame) = self.frame.lock() {
            frame.revision = frame.revision.wrapping_add(1);
            frame.state = Some(Arc::new(state));
            self.changed.notify_all();
        }
    }

    /// Waits for a revision newer than `since`, giving up after `POLL_SECONDS`
    /// and returning whatever is current.
    pub fn wait(&self, since: u64) -> Frame {
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

/// A bound port with a thread accepting on it, and the means to stop both.
pub struct Listener {
    port: u16,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Listener {
    /// Binds `port` and answers every request with `respond`.
    ///
    /// One thread per connection, capped. Requests here are either instant or
    /// a long poll parked on a condvar, so a thread apiece costs almost
    /// nothing and needs no runtime.
    pub fn start<F>(port: u16, name: &str, respond: F) -> std::result::Result<Listener, String>
    where
        F: Fn(&mut TcpStream, Request) + Send + Sync + 'static,
    {
        // 0.0.0.0 rather than 127.0.0.1: a screen or a remote nobody else on
        // the network can open would be pointless.
        let listener = TcpListener::bind(("0.0.0.0", port))
            .map_err(|err| format!("port {port} could not be opened: {err}"))?;
        listener.set_nonblocking(false).map_err(|err| err.to_string())?;

        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let respond = Arc::new(respond);

        let join = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                let live = Arc::new(AtomicUsize::new(0));
                for stream in listener.incoming() {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(mut stream) = stream else { continue };
                    if live.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    live.fetch_add(1, Ordering::SeqCst);
                    let respond = Arc::clone(&respond);
                    let live = Arc::clone(&live);
                    let _ = std::thread::Builder::new()
                        .name("http-conn".into())
                        .spawn(move || {
                            // A poll is held open deliberately, so the read
                            // timeout has to outlast it.
                            let _ = stream
                                .set_read_timeout(Some(Duration::from_secs(POLL_SECONDS + 15)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                            if let Some(request) = read_request(&stream) {
                                respond(&mut stream, request);
                            }
                            live.fetch_sub(1, Ordering::SeqCst);
                        });
                }
            })
            .map_err(|err| err.to_string())?;

        Ok(Listener { port, stop, join: Some(join) })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // `accept` is blocking, so it has to be woken to notice the flag.
        let _ = TcpStream::connect(("127.0.0.1", self.port))
            .map(|stream| stream.shutdown(Shutdown::Both));
        if let Some(join) = self.join.take() {
            let _ = join.join();
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

// --- Requests -------------------------------------------------------------

pub struct Request {
    pub method: String,
    pub target: String,
    pub range: Option<(u64, Option<u64>)>,
    /// Present on a POST. Read here rather than by the route, because the
    /// buffered reader that has the bytes lives only this long.
    pub body: Vec<u8>,
}

impl Request {
    /// The path and the query string, with percent escapes already undone in
    /// the path.
    pub fn split(&self) -> (String, &str) {
        let (path, query) = split_once(&self.target, '?');
        (percent_decode(path), query)
    }

    /// A JSON body, or `None` when there is not one.
    pub fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

pub fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut range = None;
    let mut length = 0usize;
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
        let lower = header.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("range:") {
            range = parse_range(value.trim());
        } else if let Some(value) = lower.strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }

    let mut body = Vec::new();
    if length > 0 {
        body.resize(length.min(MAX_BODY), 0);
        if reader.read_exact(&mut body).is_err() {
            body.clear();
        }
    }
    Some(Request { method, target, range, body })
}

/// Only `bytes=start-` and `bytes=start-end` — the two forms a video element
/// actually sends. Multi-range requests are answered with the whole file,
/// which is a legal response.
pub fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
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

// --- Responses ------------------------------------------------------------

pub fn send(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> std::io::Result<()> {
    let owned: Vec<(&str, String)> = headers.iter().map(|(k, v)| (*k, (*v).to_string())).collect();
    send_owned(stream, status, content_type, &owned, body)
}

pub fn send_owned(
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

/// JSON, never cached — every route that uses it is about right now.
pub fn send_json(stream: &mut TcpStream, status: u16, value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let _ = send(
        stream,
        status,
        "application/json",
        &[("Cache-Control", "no-store")],
        &bytes,
    );
}

pub fn write_head(
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
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        429 => "Too Many Requests",
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

// --- Static files ---------------------------------------------------------

/// Serves a file out of the app bundle — the very same build the desktop
/// windows run, so a page opened in a browser is not a second implementation
/// that can drift away from the real one.
///
/// `index` is the document a bare `/` means: the projection page for a screen,
/// the control page for the remote.
pub fn serve_asset(app: &AppHandle, stream: &mut TcpStream, path: &str, index: &str) {
    let relative = match path.trim_start_matches('/') {
        "" | "index.html" => index,
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

    let found = app
        .asset_resolver()
        .get(format!("/{relative}"))
        .or_else(|| app.asset_resolver().get(relative.to_string()));
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
            b"This page has not been built yet. Run `npm run build:vite` once, \
              or use a release build.",
        );
        return;
    }

    let _ = send(stream, 404, "text/plain", &[], b"not found");
}

// --- Plumbing -------------------------------------------------------------

pub fn split_once(text: &str, separator: char) -> (&str, &str) {
    match text.split_once(separator) {
        Some((before, after)) => (before, after),
        None => (text, ""),
    }
}

pub fn param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = split_once(pair, '=');
        (key == name).then(|| percent_decode(&value.replace('+', " ")))
    })
}

pub fn percent_decode(text: &str) -> String {
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

pub fn mime_for(path: &PathBuf) -> String {
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

/// Numbers nobody can guess: a pairing code and the tokens handed out for it.
///
/// `RandomState` is seeded by the operating system — it is what makes hash
/// collisions unpredictable — so hashing a fresh one together with the clock
/// gives entropy without pulling in a random-number crate for two call sites.
pub fn random_u64() -> u64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
    );
    // A second seeded state: two calls in the same nanosecond still differ.
    hasher.write_u64(RandomState::new().build_hasher().finish());
    hasher.finish()
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
    fn a_waiting_client_is_woken_by_the_next_change() {
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

    /// A real request over a real socket: the listener, the request reader and
    /// the response writer together. Everything the phone remote does goes
    /// through this path, including the POST body that carries a pairing code.
    #[test]
    fn serves_a_request_end_to_end() {
        use std::io::Read;

        // Port 0 lets the OS pick a free one, which is what makes this safe to
        // run on a machine already serving something.
        let probe = TcpListener::bind(("127.0.0.1", 0)).expect("probe");
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let listener = Listener::start(port, "test", |stream, request| {
            let (path, query) = request.split();
            let body = String::from_utf8_lossy(&request.body).into_owned();
            send_json(
                stream,
                200,
                &serde_json::json!({
                    "method": request.method,
                    "path": path,
                    "since": param(query, "since"),
                    "body": body,
                }),
            );
        })
        .expect("listener");

        let call = |request: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            stream.write_all(request.as_bytes()).expect("write");
            let mut answer = String::new();
            stream.read_to_string(&mut answer).expect("read");
            answer
        };

        let get = call("GET /api/state?since=4 HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(get.starts_with("HTTP/1.1 200 OK"), "{get}");
        assert!(get.contains(r#""path":"/api/state""#), "{get}");
        assert!(get.contains(r#""since":"4""#), "{get}");

        // The body has to survive being read after the headers, which is the
        // part a hand-rolled reader gets wrong.
        let post = call(
            "POST /api/pair HTTP/1.1\r\nHost: x\r\nContent-Length: 17\r\n\r\n{\"code\":\"123456\"}",
        );
        assert!(post.contains(r#""method":"POST""#), "{post}");
        assert!(post.contains(r#"{\"code\":\"123456\"}"#), "{post}");

        listener.shutdown();
        // The port is free again, so a settings change that moves the remote
        // can bind the old one straight away.
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn random_numbers_do_not_repeat() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(random_u64()), "random_u64 repeated itself");
        }
    }
}
