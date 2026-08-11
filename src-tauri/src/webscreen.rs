//! Screens that are a browser tab rather than a monitor.
//!
//! A hall often has a screen the operator's machine cannot reach with a cable:
//! a tablet on the sound desk, a TV in the crèche, a phone held by whoever is
//! leading. Each of those already has a browser, so LyricVerse serves the same
//! projection page over the local network and they simply open a URL.
//!
//! The listener, the long poll and the plumbing all live in `http`, which the
//! phone remote uses too. What is here is the routes: the state a screen waits
//! on, and the media it draws.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::http::{
    self, lan_address, mime_for, param, send, send_owned, write_head, Broadcast, Listener, Request,
};
use crate::settings::Settings;

/// Ports below 1024 need privileges and the ephemeral range is fair game for
/// anything else on the machine, so new screens are numbered from here.
pub const DEFAULT_PORT: u16 = 8088;

// --- Servers --------------------------------------------------------------

/// Every running web screen, keyed by screen id.
#[derive(Default)]
pub struct WebScreens {
    broadcast: Arc<Broadcast>,
    servers: Mutex<HashMap<String, Listener>>,
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
            .filter(|(id, server)| wanted.get(id.as_str()) != Some(&server.port()))
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

    fn start(&self, app: &AppHandle, id: &str, port: u16) -> std::result::Result<Listener, String> {
        let ctx = Arc::new(Ctx {
            screen_id: id.to_string(),
            broadcast: Arc::clone(&self.broadcast),
            app: app.clone(),
            media_root: crate::paths::data_dir(app).ok(),
        });
        Listener::start(port, &format!("web-{id}"), move |stream, request| {
            route(&ctx, stream, request)
        })
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

// --- Request handling -----------------------------------------------------

struct Ctx {
    screen_id: String,
    broadcast: Arc<Broadcast>,
    app: AppHandle,
    media_root: Option<PathBuf>,
}

fn route(ctx: &Ctx, stream: &mut TcpStream, request: Request) {
    if request.method != "GET" {
        let _ = send(stream, 405, "text/plain", &[], b"method not allowed");
        return;
    }
    let (path, query) = request.split();

    match path.as_str() {
        "/api/state" => api_state(ctx, stream, query),
        "/api/media" => api_media(ctx, stream, query, request.range),
        _ => http::serve_asset(&ctx.app, stream, &path, "display.html"),
    }
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
