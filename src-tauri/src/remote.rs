//! The phone in somebody's pocket, driving the screens.
//!
//! A worship leader with a guitar cannot reach the laptop, and the person at
//! the laptop cannot always see what the leader wants next. This serves a
//! small control page over the same local network the browser screens use, so
//! any phone or tablet in the hall can pick the next song or passage and put
//! it up.
//!
//! Two things make that safe enough to leave running through a service:
//!
//! * It is off unless somebody turns it on in the settings.
//! * A device has to type a six-digit code before it can do anything. The code
//!   buys a token; every route but the pairing one demands that token, wrong
//!   codes are rate-limited, and turning the server off or changing the code
//!   throws every token away.
//!
//! It is plain HTTP on a local network — a hall's wifi, not the internet — so
//! this is a lock on the door, not a bank vault. That is the right size for
//! the problem: the risk being defended against is the youth group finding the
//! URL, not a determined attacker on the wire.

use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::http::{self, random_u64, send, send_json, Broadcast, Listener, Request};
use crate::settings::Settings;

/// The remote's own port, one along from the first web screen's.
pub const DEFAULT_PORT: u16 = 8099;

/// A token is forgotten after this long without being used. A service is a
/// morning; a phone left in a bag until next Sunday pairs again.
const SESSION_HOURS: u64 = 12;

/// Wrong codes allowed inside `ATTEMPT_WINDOW` before pairing is refused for a
/// while. Six digits is a million combinations, and at this rate working
/// through even a thousandth of them takes days.
const MAX_ATTEMPTS: usize = 8;
const ATTEMPT_WINDOW: Duration = Duration::from_secs(300);

// --- State ----------------------------------------------------------------

#[derive(Default)]
pub struct Remote {
    broadcast: Arc<Broadcast>,
    server: Mutex<Option<Listener>>,
    /// Why the server is not up, e.g. its port is taken. Shown in the
    /// settings, because a silent failure means finding out mid-service.
    error: Mutex<Option<String>>,
    /// What the console has open, in the shape the control page draws: enough
    /// to list the slides and show which one is live. Shared with the request
    /// threads, which read it while the console writes it.
    deck: Arc<Mutex<Value>>,
    /// The frame last published, kept so a deck change can wake the waiting
    /// phones without inventing a live state of its own.
    last: Mutex<Option<Value>>,
    session: Arc<Session>,
}

/// Who is allowed in, and who has been guessing.
#[derive(Default)]
struct Session {
    code: Mutex<String>,
    /// Token to when it was last used.
    tokens: Mutex<HashMap<String, Instant>>,
    failures: Mutex<Vec<Instant>>,
    /// The console's language, so the pairing screen speaks it before there is
    /// any state to read.
    language: Mutex<String>,
}

impl Session {
    /// Trades a correct code for a token. `None` when the code is wrong or too
    /// many have been wrong lately.
    fn pair(&self, offered: &str) -> Option<String> {
        {
            let mut failures = self.failures.lock().ok()?;
            failures.retain(|at| at.elapsed() < ATTEMPT_WINDOW);
            if failures.len() >= MAX_ATTEMPTS {
                return None;
            }
        }

        let expected = self.code.lock().ok()?.clone();
        // Never pairs against an empty code: that would be an open door for
        // any device that sent nothing at all.
        if expected.is_empty() || offered.trim() != expected {
            if let Ok(mut failures) = self.failures.lock() {
                failures.push(Instant::now());
            }
            return None;
        }

        let token = format!("{:016x}{:016x}", random_u64(), random_u64());
        let mut tokens = self.tokens.lock().ok()?;
        tokens.retain(|_, seen| seen.elapsed() < Duration::from_secs(SESSION_HOURS * 3600));
        tokens.insert(token.clone(), Instant::now());
        Some(token)
    }

    fn accepts(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        let Ok(mut tokens) = self.tokens.lock() else {
            return false;
        };
        match tokens.get_mut(token) {
            Some(seen) if seen.elapsed() < Duration::from_secs(SESSION_HOURS * 3600) => {
                *seen = Instant::now();
                true
            }
            // Expired rather than never known: dropped either way.
            Some(_) => {
                tokens.remove(token);
                false
            }
            None => false,
        }
    }

    /// Called when the code changes or the server stops. Every paired device
    /// has to pair again — which is the point of changing the code.
    fn forget_everyone(&self) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.clear();
        }
        if let Ok(mut failures) = self.failures.lock() {
            failures.clear();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: u16,
    /// Addresses to type into a phone. The LAN one first — that is the only
    /// one another device can reach.
    pub urls: Vec<String>,
    pub error: Option<String>,
    /// How many devices are paired right now.
    pub devices: usize,
}

impl Remote {
    /// Brings the server in line with the settings: on, off, or moved port.
    pub fn sync(&self, app: &AppHandle, settings: &Settings) {
        if let Ok(mut language) = self.session.language.lock() {
            *language = settings.language.clone();
        }

        // A changed code invalidates everything issued under the old one.
        let changed = match self.session.code.lock() {
            Ok(mut code) => {
                let changed = *code != settings.remote_code;
                if changed {
                    *code = settings.remote_code.clone();
                }
                changed
            }
            Err(_) => false,
        };
        if changed {
            self.session.forget_everyone();
        }

        let Ok(mut server) = self.server.lock() else {
            return;
        };

        let wanted = settings.remote_enabled.then_some(settings.remote_port);
        let running = server.as_ref().map(|listener| listener.port());
        if running == wanted {
            return;
        }

        if let Some(listener) = server.take() {
            listener.shutdown();
            self.session.forget_everyone();
        }
        let Some(port) = wanted else {
            if let Ok(mut error) = self.error.lock() {
                *error = None;
            }
            return;
        };

        match self.start(app, port) {
            Ok(listener) => {
                *server = Some(listener);
                if let Ok(mut error) = self.error.lock() {
                    *error = None;
                }
            }
            Err(message) => {
                if let Ok(mut error) = self.error.lock() {
                    *error = Some(message);
                }
            }
        }
    }

    fn start(&self, app: &AppHandle, port: u16) -> std::result::Result<Listener, String> {
        let ctx = Arc::new(Ctx {
            app: app.clone(),
            broadcast: Arc::clone(&self.broadcast),
            session: Arc::clone(&self.session),
            deck: Arc::clone(&self.deck),
        });
        Listener::start(port, "remote", move |stream, request| route(&ctx, stream, request))
    }

    /// The frame the web screens are given, kept for the phones as well.
    pub fn publish(&self, state: Value) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(state.clone());
        }
        self.broadcast.publish(state);
    }

    /// What the console has open. Waking the phones on this too is the whole
    /// difference between a remote that lists the song being worked on and one
    /// that lists whatever was open a minute ago.
    pub fn set_deck(&self, deck: Value) {
        if let Ok(mut current) = self.deck.lock() {
            if *current == deck {
                return;
            }
            *current = deck;
        }
        let last = self.last.lock().ok().and_then(|f| f.clone());
        self.broadcast.publish(last.unwrap_or(Value::Null));
    }

    pub fn status(&self, settings: &Settings) -> RemoteStatus {
        let port = self
            .server
            .lock()
            .ok()
            .and_then(|server| server.as_ref().map(|listener| listener.port()));
        let mut urls = Vec::new();
        if let Some(port) = port {
            if let Some(ip) = http::lan_address() {
                urls.push(format!("http://{ip}:{port}"));
            }
            urls.push(format!("http://localhost:{port}"));
        }
        RemoteStatus {
            running: port.is_some(),
            port: port.unwrap_or(settings.remote_port),
            urls,
            error: self.error.lock().ok().and_then(|e| e.clone()),
            devices: self.session.tokens.lock().map(|t| t.len()).unwrap_or(0),
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut server) = self.server.lock() {
            if let Some(listener) = server.take() {
                listener.shutdown();
            }
        }
        self.session.forget_everyone();
    }
}

// --- Requests -------------------------------------------------------------

struct Ctx {
    app: AppHandle,
    broadcast: Arc<Broadcast>,
    session: Arc<Session>,
    deck: Arc<Mutex<Value>>,
}

fn route(ctx: &Ctx, stream: &mut TcpStream, request: Request) {
    let (path, query) = request.split();

    // The pairing screen is served, and pairs, before any token exists.
    match (request.method.as_str(), path.as_str()) {
        ("GET", "/api/hello") => {
            let language = ctx.session.language.lock().map(|l| l.clone()).unwrap_or_default();
            send_json(stream, 200, &json!({ "app": "lyricverse", "language": language }));
            return;
        }
        ("POST", "/api/pair") => {
            let offered = request
                .json()
                .and_then(|body| body.get("code").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            match ctx.session.pair(&offered) {
                Some(token) => send_json(stream, 200, &json!({ "token": token })),
                None => send_json(stream, 403, &json!({ "error": "code" })),
            }
            return;
        }
        _ => {}
    }

    if !path.starts_with("/api/") {
        if request.method != "GET" {
            let _ = send(stream, 405, "text/plain", &[], b"method not allowed");
            return;
        }
        http::serve_asset(&ctx.app, stream, &path, "remote.html");
        return;
    }

    // Everything past here needs a paired device.
    let token = http::param(query, "token")
        .or_else(|| request.json().and_then(|b| b.get("token").and_then(Value::as_str).map(str::to_owned)))
        .unwrap_or_default();
    if !ctx.session.accepts(&token) {
        send_json(stream, 401, &json!({ "error": "token" }));
        return;
    }

    match (request.method.as_str(), path.as_str()) {
        ("GET", "/api/state") => state(ctx, stream, query),
        ("GET", "/api/library") => library(ctx, stream),
        ("GET", "/api/songs") => songs(ctx, stream, query),
        ("GET", "/api/presentations") => presentations(ctx, stream),
        ("GET", "/api/books") => books(ctx, stream, query),
        ("GET", "/api/verses") => verses(ctx, stream, query),
        ("POST", "/api/command") => command(ctx, stream, request),
        _ => send_json(stream, 404, &json!({ "error": "route" })),
    }
}

/// Held open until something changes, exactly as a browser screen's is.
fn state(ctx: &Ctx, stream: &mut TcpStream, query: &str) {
    let since: u64 = http::param(query, "since").and_then(|v| v.parse().ok()).unwrap_or(0);
    let frame = ctx.broadcast.wait(since);
    let deck = ctx.deck.lock().map(|d| d.clone()).unwrap_or(Value::Null);
    send_json(
        stream,
        200,
        &json!({
            "revision": frame.revision,
            "state": frame.state.as_deref().cloned().unwrap_or(Value::Null),
            "deck": deck,
        }),
    );
}

/// The songbooks and translations a phone can choose from.
fn library(ctx: &Ctx, stream: &mut TcpStream) {
    let songbooks = crate::paths::songbooks_dir(&ctx.app)
        .and_then(|dir| crate::songs::list(&dir))
        .unwrap_or_default();
    let translations = crate::paths::translations_dir(&ctx.app)
        .and_then(|dir| crate::bible::list(&dir))
        .unwrap_or_default();
    send_json(
        stream,
        200,
        &json!({
            "songbooks": songbooks,
            "translations": translations,
        }),
    );
}

fn songs(ctx: &Ctx, stream: &mut TcpStream, query: &str) {
    let Some(book) = http::param(query, "songbook") else {
        send_json(stream, 400, &json!({ "error": "songbook" }));
        return;
    };
    match crate::paths::songbooks_dir(&ctx.app).and_then(|dir| crate::songs::songs(&dir, &book)) {
        Ok(list) => send_json(stream, 200, &json!({ "songs": list })),
        Err(error) => send_json(stream, 200, &json!({ "songs": [], "error": error.to_string() })),
    }
}

/// The slide decks, by name and length.
///
/// The slides themselves do not travel: they are pictures, and what a phone
/// needs is a list to choose from — the deck it picks then arrives through the
/// state feed like anything else the console has open.
fn presentations(ctx: &Ctx, stream: &mut TcpStream) {
    let decks = crate::paths::presentations_dir(&ctx.app)
        .and_then(|dir| crate::presentations::list(&dir))
        .unwrap_or_default();
    let summary: Vec<Value> = decks
        .iter()
        .map(|deck| json!({ "id": deck.id, "name": deck.name, "slides": deck.slides.len() }))
        .collect();
    send_json(stream, 200, &json!({ "presentations": summary }));
}

fn books(ctx: &Ctx, stream: &mut TcpStream, query: &str) {
    let Some(name) = http::param(query, "translation") else {
        send_json(stream, 400, &json!({ "error": "translation" }));
        return;
    };
    match crate::translation_for(&ctx.app, &name) {
        // Each book carries its own chapter count, which is all a phone needs
        // to draw the grid — no request per book.
        Ok(translation) => send_json(stream, 200, &json!({ "books": translation.books() })),
        Err(error) => send_json(stream, 200, &json!({ "books": [], "error": error.to_string() })),
    }
}

fn verses(ctx: &Ctx, stream: &mut TcpStream, query: &str) {
    let name = http::param(query, "translation").unwrap_or_default();
    let book: i64 = http::param(query, "book").and_then(|v| v.parse().ok()).unwrap_or(0);
    let chapter: i64 = http::param(query, "chapter").and_then(|v| v.parse().ok()).unwrap_or(0);
    match crate::translation_for(&ctx.app, &name) {
        Ok(translation) => {
            let verses = translation.verses(book, chapter).to_vec();
            send_json(stream, 200, &json!({ "verses": verses }));
        }
        Err(error) => send_json(stream, 200, &json!({ "verses": [], "error": error.to_string() })),
    }
}

/// Hands the console something to do.
///
/// Nothing is carried out here. Showing a song means building its deck out of
/// the settings as they stand — which layout, which parallel translations, how
/// many lines to a slide — and all of that lives in the console. A remote that
/// reimplemented any of it would be a second app to keep in step.
fn command(ctx: &Ctx, stream: &mut TcpStream, request: Request) {
    let Some(mut body) = request.json() else {
        send_json(stream, 400, &json!({ "error": "body" }));
        return;
    };
    // The token got the request this far and has no business travelling on
    // into the console's event bus.
    if let Some(object) = body.as_object_mut() {
        object.remove("token");
    }
    if body.get("kind").and_then(Value::as_str).is_none() {
        send_json(stream, 400, &json!({ "error": "kind" }));
        return;
    }
    let _ = ctx.app.emit(crate::EVENT_REMOTE, &body);
    send_json(stream, 200, &json!({ "ok": true }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(code: &str) -> Session {
        let session = Session::default();
        *session.code.lock().unwrap() = code.to_string();
        session
    }

    #[test]
    fn a_correct_code_is_the_only_way_in() {
        let session = session("123456");
        assert!(session.pair("000000").is_none());
        let token = session.pair("123456").expect("paired");
        assert!(session.accepts(&token));
        assert!(!session.accepts("something else"));
        // Whitespace from a phone keyboard is not a wrong code.
        assert!(session.pair(" 123456 ").is_some());
    }

    #[test]
    fn an_empty_code_pairs_with_nobody() {
        // A server that has not been given a code must not accept the empty
        // string, which is exactly what a client sending nothing offers.
        let session = session("");
        assert!(session.pair("").is_none());
        assert!(session.pair("000000").is_none());
    }

    #[test]
    fn guessing_is_cut_off() {
        let session = session("123456");
        for _ in 0..MAX_ATTEMPTS {
            assert!(session.pair("000000").is_none());
        }
        // Even the right code is refused once the window is full — the guesser
        // does not get a free pass for stumbling onto it.
        assert!(session.pair("123456").is_none());
    }

    #[test]
    fn changing_the_code_unpairs_every_device() {
        let session = session("123456");
        let token = session.pair("123456").expect("paired");
        assert!(session.accepts(&token));
        session.forget_everyone();
        assert!(!session.accepts(&token));
    }
}
