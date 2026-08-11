// `bible` and `songs` are public so the integration tests in `tests/` can
// exercise them directly against the real seeded databases.
pub mod bible;
/// Public for the integration tests, which read it against real modules.
pub mod numbering;
pub mod songs;

mod appmenu;
mod audio;
mod backgrounds;
mod catalog;
mod display;
mod error;
mod fonts;
mod images;
mod live;
mod paths;
mod plans;
mod presentations;
mod seed;
mod settings;
mod songio;
mod text;
mod videos;
mod webscreen;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use bible::{BookInfo, Reference, SearchHit, Translation, TranslationMeta, VerseRow};
use error::{AppError, Result};
use live::{LiveInput, LiveState, Playback, Timer};
use settings::{DisplayConfig, Settings, WebScreen};
use songs::{Song, SongSummary, SongbookMeta};

pub const EVENT_LIVE: &str = "lyricverse://live";
pub const EVENT_SETTINGS: &str = "lyricverse://settings";
pub const EVENT_DISPLAYS: &str = "lyricverse://displays";
pub const EVENT_LIBRARY: &str = "lyricverse://library";
pub const EVENT_IDENTIFY: &str = "lyricverse://identify";
pub const EVENT_TIMER: &str = "lyricverse://timer";
pub const EVENT_WEB_SCREENS: &str = "lyricverse://webscreens";
pub const EVENT_PLAYBACK: &str = "lyricverse://playback";
/// A menu action the window has to carry out — one that needs a file picker or
/// knowledge of what is open, neither of which the menu handler has.
pub const EVENT_MENU: &str = "lyricverse://menu";

#[derive(Default)]
pub struct AppState {
    settings: Mutex<Settings>,
    live: Mutex<LiveState>,
    /// Parsed translations are a few MB each and take ~half a second to build,
    /// so they are kept for the lifetime of the process once opened.
    translations: Mutex<HashMap<String, Arc<Translation>>>,
    /// Independent of what is on screen: a countdown must survive the operator
    /// moving between songs.
    timer: Mutex<Option<Timer>>,
    /// How the clip on screen should be playing.
    playback: Mutex<Playback>,
}

// --- Bootstrap ------------------------------------------------------------

/// Pristine values, so "reset this section" in the UI restores exactly what a
/// fresh install would have rather than a second copy of the defaults that can
/// drift away from these ones.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    settings: Settings,
    display: DisplayConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    settings: Settings,
    displays: Vec<display::DisplayInfo>,
    live: LiveState,
    songbooks: Vec<SongbookMeta>,
    translations: Vec<TranslationMeta>,
    data_dir: PathBuf,
    version: String,
    defaults: Defaults,
    timer: Option<Timer>,
    playback: Playback,
    web_screens: Vec<webscreen::WebScreenStatus>,
}

/// Everything the console needs to draw itself, in one call.
///
/// `(async)` on purpose: a plain command runs on the main thread, so anything
/// slow inside it stops the window pumping messages and Windows paints it
/// "Not Responding". Nothing here is allowed to hold the UI hostage.
#[tauri::command(async)]
fn bootstrap(
    app: AppHandle,
    state: State<'_, AppState>,
    web: State<'_, webscreen::WebScreens>,
) -> Result<Bootstrap> {
    let displays = display::list(&app)?;
    let settings = {
        let mut guard = lock(&state.settings)?;
        if ensure_display_entries(&mut guard, &displays) {
            settings::save(&app, &guard)?;
        }
        guard.clone()
    };

    Ok(Bootstrap {
        songbooks: songs::list(&paths::songbooks_dir(&app)?)?,
        translations: bible::list(&paths::translations_dir(&app)?)?,
        live: lock(&state.live)?.clone(),
        timer: lock(&state.timer)?.clone(),
        playback: lock(&state.playback)?.clone(),
        data_dir: paths::data_dir(&app)?,
        version: app.package_info().version.to_string(),
        defaults: Defaults {
            settings: Settings::default(),
            display: DisplayConfig::default(),
        },
        web_screens: web.status(&settings),
        settings,
        displays,
    })
}

/// Adds a default configuration for any newly connected screen. Returns true
/// when something changed and the file needs rewriting.
fn ensure_display_entries(settings: &mut Settings, displays: &[display::DisplayInfo]) -> bool {
    let mut changed = false;
    for info in displays {
        // The console's own screen is never projected onto; force it off even
        // if an older settings file says otherwise.
        if info.is_primary {
            if let Some(existing) = settings.displays.get_mut(&info.id) {
                if existing.enabled {
                    existing.enabled = false;
                    changed = true;
                }
                continue;
            }
        }
        if settings.displays.contains_key(&info.id) {
            continue;
        }
        settings.displays.insert(
            info.id.clone(),
            DisplayConfig {
                // A second screen is almost always the projector.
                enabled: !info.is_primary && displays.len() > 1,
                ..DisplayConfig::default()
            },
        );
        changed = true;
    }
    changed
}

// --- Settings -------------------------------------------------------------

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings> {
    Ok(lock(&state.settings)?.clone())
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, next: Settings) -> Result<Settings> {
    let stored = {
        let mut guard = lock(&state.settings)?;
        *guard = next;
        settings::save(&app, &guard)?;
        guard.clone()
    };
    display::sync(&app, &stored)?;
    sync_web_screens(&app, &stored);
    appmenu::sync(&app, &stored);
    let _ = app.emit(EVENT_SETTINGS, &stored);
    let _ = app.emit(EVENT_DISPLAYS, display::list(&app)?);
    Ok(stored)
}

// --- Web screens ----------------------------------------------------------

/// Pushes the current state to every browser screen that is waiting on it.
///
/// Desktop windows get this through Tauri's own event bus; a screen on the
/// far side of the network is holding a request open instead, and this is
/// what answers it.
fn publish_web(app: &AppHandle) {
    let state = app.state::<AppState>();
    let frame = (|| -> Result<serde_json::Value> {
        Ok(serde_json::json!({
            "settings": *lock(&state.settings)?,
            "live": *lock(&state.live)?,
            "timer": *lock(&state.timer)?,
            "playback": *lock(&state.playback)?,
            // A browser screen cannot call the backend to turn a stored file
            // name into a path, so the index travels with the state.
            "backgrounds": backgrounds::list(&paths::backgrounds_dir(app)?).unwrap_or_default(),
            // A timer is anchored to this machine's clock. A tablet whose own
            // clock is a minute out would otherwise count down to the wrong
            // moment, so it is told what the time is here.
            "now": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }))
    })();
    if let Ok(frame) = frame {
        app.state::<webscreen::WebScreens>().publish(frame);
    }
}

/// Starts and stops servers to match the settings, then tells the console
/// which of them came up — a port already in use is the common failure and
/// has to be visible.
fn sync_web_screens(app: &AppHandle, settings: &Settings) {
    let web = app.state::<webscreen::WebScreens>();
    web.sync(app, settings);
    publish_web(app);
    let _ = app.emit(EVENT_WEB_SCREENS, web.status(settings));
}

/// Ports are handed out sequentially so a second screen does not collide with
/// the first, and an operator never has to think about the number at all.
fn next_free_port(settings: &Settings) -> u16 {
    let mut port = webscreen::DEFAULT_PORT;
    while settings.web_screens.iter().any(|screen| screen.port == port) {
        port = port.saturating_add(1);
    }
    port
}

#[tauri::command]
fn add_web_screen(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Settings> {
    let stored = {
        let mut guard = lock(&state.settings)?;
        let port = next_free_port(&guard);
        let id = format!("web-{}", uid());
        let name = if name.trim().is_empty() { format!("Web screen :{port}") } else { name };
        guard.web_screens.push(WebScreen { id: id.clone(), name, port });
        // On by default: an operator who just added a screen wants its address,
        // and the address only exists once the server is listening.
        guard.displays.insert(id, DisplayConfig { enabled: true, ..DisplayConfig::default() });
        settings::save(&app, &guard)?;
        guard.clone()
    };
    sync_web_screens(&app, &stored);
    let _ = app.emit(EVENT_SETTINGS, &stored);
    Ok(stored)
}

#[tauri::command]
fn update_web_screen(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    port: Option<u16>,
) -> Result<Settings> {
    let stored = {
        let mut guard = lock(&state.settings)?;
        // A port two screens share would leave one of them silently dead.
        if let Some(port) = port {
            if port < 1024 {
                return Err(AppError::msg("choose a port of 1024 or above"));
            }
            if guard.web_screens.iter().any(|s| s.port == port && s.id != id) {
                return Err(AppError::msg("another web screen already uses that port"));
            }
        }
        let Some(screen) = guard.web_screens.iter_mut().find(|s| s.id == id) else {
            return Err(AppError::msg("that web screen no longer exists"));
        };
        if let Some(name) = name {
            screen.name = name;
        }
        if let Some(port) = port {
            screen.port = port;
        }
        settings::save(&app, &guard)?;
        guard.clone()
    };
    sync_web_screens(&app, &stored);
    let _ = app.emit(EVENT_SETTINGS, &stored);
    Ok(stored)
}

#[tauri::command]
fn remove_web_screen(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Settings> {
    let stored = {
        let mut guard = lock(&state.settings)?;
        guard.web_screens.retain(|screen| screen.id != id);
        guard.displays.remove(&id);
        settings::save(&app, &guard)?;
        guard.clone()
    };
    sync_web_screens(&app, &stored);
    let _ = app.emit(EVENT_SETTINGS, &stored);
    Ok(stored)
}

/// This machine's address on the network, for the URLs on the Displays tab.
///
/// Worked out lazily rather than at startup: it opens a UDP socket to find
/// which interface would carry the traffic, and on Windows that can raise a
/// firewall prompt which blocks until somebody answers it. Booting the app
/// must never wait on the network stack.
#[tauri::command(async)]
fn lan_address() -> Option<String> {
    webscreen::lan_address().map(|ip| ip.to_string())
}

#[tauri::command]
fn list_web_screens(
    state: State<'_, AppState>,
    web: State<'_, webscreen::WebScreens>,
) -> Result<Vec<webscreen::WebScreenStatus>> {
    let settings = lock(&state.settings)?.clone();
    Ok(web.status(&settings))
}

/// Short, unique and readable in a settings file. Not a UUID: it only has to
/// be distinct among the handful of screens one operator adds.
fn uid() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

// --- Displays -------------------------------------------------------------

#[tauri::command]
fn list_displays(app: AppHandle) -> Result<Vec<display::DisplayInfo>> {
    display::list(&app)
}

#[tauri::command]
fn sync_displays(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<display::DisplayInfo>> {
    let displays = display::list(&app)?;
    let settings = {
        let mut guard = lock(&state.settings)?;
        if ensure_display_entries(&mut guard, &displays) {
            settings::save(&app, &guard)?;
        }
        guard.clone()
    };
    display::sync(&app, &settings)?;
    let refreshed = display::list(&app)?;
    let _ = app.emit(EVENT_SETTINGS, &settings);
    let _ = app.emit(EVENT_DISPLAYS, &refreshed);
    Ok(refreshed)
}

/// Opens a normal window rendering a screen's configuration, for checking a
/// layout without a projector attached.
#[tauri::command]
fn open_test_window(app: AppHandle, display_id: String) -> Result<()> {
    display::open_test(&app, &display_id)
}

/// Briefly names each screen on the screen itself, so the operator knows which
/// physical projector "Display 2" is.
#[tauri::command]
fn identify_displays(app: AppHandle) -> Result<()> {
    let _ = app.emit(EVENT_IDENTIFY, ());
    Ok(())
}

// --- Live output ----------------------------------------------------------

#[tauri::command]
fn get_live(state: State<'_, AppState>) -> Result<LiveState> {
    Ok(lock(&state.live)?.clone())
}

#[tauri::command]
fn set_live(app: AppHandle, state: State<'_, AppState>, input: LiveInput) -> Result<LiveState> {
    let next = {
        let mut guard = lock(&state.live)?;
        let revision = guard.revision.wrapping_add(1);
        *guard = LiveState {
            kind: input.kind,
            body_part: input.body_part,
            title: input.title,
            number: input.number,
            section_label: input.section_label,
            reference: input.reference,
            translation: input.translation,
            passages: input.passages,
            next_up: input.next_up,
            next_media_path: input.next_media_path,
            section_kind: input.section_kind,
            media_path: input.media_path,
            youtube_id: input.youtube_id,
            camera_device_id: input.camera_device_id,
            revision,
        };
        guard.clone()
    };
    // A clip put on screen starts from its beginning, playing. Without this it
    // would inherit wherever the previous one was paused.
    let playback = {
        let mut guard = lock(&state.playback)?;
        let revision = guard.revision.wrapping_add(1);
        *guard = Playback { revision, ..Playback::default() };
        guard.clone()
    };
    let _ = app.emit(EVENT_LIVE, &next);
    let _ = app.emit(EVENT_PLAYBACK, &playback);
    publish_web(&app);
    Ok(next)
}

#[tauri::command]
fn blank(app: AppHandle, state: State<'_, AppState>) -> Result<LiveState> {
    let next = {
        let mut guard = lock(&state.live)?;
        let revision = guard.revision.wrapping_add(1);
        *guard = LiveState { revision, ..LiveState::default() };
        guard.clone()
    };
    let _ = app.emit(EVENT_LIVE, &next);
    publish_web(&app);
    Ok(next)
}

// --- Songbooks ------------------------------------------------------------

#[tauri::command]
fn list_songbooks(app: AppHandle) -> Result<Vec<SongbookMeta>> {
    songs::list(&paths::songbooks_dir(&app)?)
}

#[tauri::command]
fn list_songs(app: AppHandle, songbook: String) -> Result<Vec<SongSummary>> {
    songs::songs(&paths::songbooks_dir(&app)?, &songbook)
}

#[tauri::command]
fn get_song(app: AppHandle, songbook: String, id: i64) -> Result<Song> {
    songs::get(&paths::songbooks_dir(&app)?, &songbook, id)
}

#[tauri::command]
fn save_song(app: AppHandle, songbook: String, song: Song) -> Result<i64> {
    let id = songs::save(&paths::songbooks_dir(&app)?, &songbook, &song)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(id)
}

#[tauri::command]
fn delete_song(app: AppHandle, songbook: String, id: i64) -> Result<()> {
    songs::delete(&paths::songbooks_dir(&app)?, &songbook, id)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

/// Sections out of pasted text, read by the same parser the `.txt` import
/// uses — so what a section becomes on the way back in is decided in one
/// place, not two.
/// A whole song out of lyrics pasted from a website: cut into slides, with
/// the repeats folded into one section each.
#[tauri::command]
fn parse_lyrics(text: String) -> Result<songio::LyricsDraft> {
    Ok(songio::song_from_lyrics(&text))
}

#[tauri::command]
fn parse_sections(text: String) -> Result<Vec<songs::Section>> {
    Ok(songio::sections_from_text(&text))
}

#[tauri::command]
fn create_songbook(app: AppHandle, name: String) -> Result<SongbookMeta> {
    let meta = songs::create(&paths::songbooks_dir(&app)?, &name)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(meta)
}

#[tauri::command]
async fn import_songbook(
    app: AppHandle,
    path: String,
    name: Option<String>,
) -> Result<SongbookMeta> {
    let meta = songs::import(
        &paths::songbooks_dir(&app)?,
        std::path::Path::new(&path),
        name.as_deref(),
    )?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(meta)
}

#[tauri::command]
fn rename_songbook(app: AppHandle, from: String, to: String) -> Result<()> {
    songs::rename(&paths::songbooks_dir(&app)?, &from, &to)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
fn delete_songbook(app: AppHandle, name: String, delete_file: bool) -> Result<()> {
    songs::remove(&paths::songbooks_dir(&app)?, &name, delete_file)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

// --- Bible ----------------------------------------------------------------

fn translation(
    app: &AppHandle,
    state: &State<'_, AppState>,
    name: &str,
) -> Result<Arc<Translation>> {
    let mut cache = lock(&state.translations)?;
    if let Some(found) = cache.get(name) {
        return Ok(Arc::clone(found));
    }
    let path = bible::path_of(&paths::translations_dir(app)?, name)?;
    let loaded = Arc::new(Translation::load(&path)?);
    cache.insert(name.to_string(), Arc::clone(&loaded));
    Ok(loaded)
}

/// A chapter of the primary translation, lined up with the same passage in
/// every other translation on screen.
///
/// This is what makes a parallel reading trustworthy in the Psalms: the two
/// numbering systems disagree from Psalm 9 to Psalm 147, so fetching "the same
/// chapter" from each module puts different psalms side by side. Each module
/// says which system it counts in, and the passage is mapped rather than
/// assumed.
#[tauri::command(async)]
fn get_parallel_chapter(
    app: AppHandle,
    state: State<'_, AppState>,
    primary: String,
    others: Vec<String>,
    book: i64,
    chapter: i64,
) -> Result<Vec<numbering::AlignedRow>> {
    let lead = translation(&app, &state, &primary)?;
    // A module that will not open is left out rather than failing the read —
    // the passage in the translations that do open is still worth showing.
    let loaded: Vec<(String, Arc<Translation>)> = others
        .iter()
        .filter(|name| **name != primary)
        .filter_map(|name| {
            translation(&app, &state, name).ok().map(|found| (name.clone(), found))
        })
        .collect();

    let psalm_nine = |t: &Translation| t.verses(numbering::PSALMS, 9).len();
    let lead_numbering = numbering::detect(psalm_nine(&lead));
    let lead_length = |ch: i64| lead.verses(numbering::PSALMS, ch).len() as i64;
    let lead_verses: Vec<(i64, String)> =
        lead.verses(book, chapter).iter().map(|v| (v.verse, v.text.clone())).collect();

    // Boxed so the borrows below outlive the call into `align`.
    type Verses<'a> = Box<dyn Fn(i64) -> Vec<(i64, String)> + 'a>;
    type Length<'a> = Box<dyn Fn(i64) -> i64 + 'a>;
    let closures: Vec<(Verses, Length)> = loaded
        .iter()
        .map(|(_, found)| {
            let for_verses = Arc::clone(found);
            let for_length = Arc::clone(found);
            // The whole chapter of the book being read: the alignment works
            // from the verses a module actually has rather than from a count.
            let verses: Verses = Box::new(move |ch: i64| {
                for_verses
                    .verses(book, ch)
                    .iter()
                    .map(|row| (row.verse, row.text.clone()))
                    .collect()
            });
            let length: Length =
                Box::new(move |ch: i64| for_length.verses(numbering::PSALMS, ch).len() as i64);
            (verses, length)
        })
        .collect();

    let others: Vec<numbering::Other> = loaded
        .iter()
        .zip(closures.iter())
        .map(|((name, found), (verses, length))| numbering::Other {
            name: name.clone(),
            // This module's own name for the book — "Псалми" beside the ESV's
            // "Psalms", which is what a second reference should read as.
            book: found
                .book(book)
                .map(|info| info.long_name.clone())
                .unwrap_or_default(),
            numbering: numbering::detect(psalm_nine(found)),
            verses: verses.as_ref(),
            length: length.as_ref(),
        })
        .collect();

    Ok(numbering::align(
        book,
        chapter,
        lead_numbering,
        &lead_length,
        &lead_verses,
        &others,
    ))
}

#[tauri::command]
fn list_translations(app: AppHandle) -> Result<Vec<TranslationMeta>> {
    bible::list(&paths::translations_dir(&app)?)
}

#[tauri::command]
async fn get_books(
    app: AppHandle,
    state: State<'_, AppState>,
    translation_name: String,
) -> Result<Vec<BookInfo>> {
    Ok(translation(&app, &state, &translation_name)?.books().to_vec())
}

#[tauri::command]
async fn get_chapters(
    app: AppHandle,
    state: State<'_, AppState>,
    translation_name: String,
    book: i64,
) -> Result<Vec<i64>> {
    Ok(translation(&app, &state, &translation_name)?.chapters(book))
}

#[tauri::command]
async fn get_verses(
    app: AppHandle,
    state: State<'_, AppState>,
    translation_name: String,
    book: i64,
    chapter: i64,
) -> Result<Vec<VerseRow>> {
    Ok(translation(&app, &state, &translation_name)?
        .verses(book, chapter)
        .to_vec())
}

#[tauri::command]
async fn search_bible(
    app: AppHandle,
    state: State<'_, AppState>,
    translation_name: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>> {
    Ok(translation(&app, &state, &translation_name)?.search(&query, limit.unwrap_or(200)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedReference {
    reference: Reference,
    label: String,
    text: String,
}

#[tauri::command]
async fn resolve_reference(
    app: AppHandle,
    state: State<'_, AppState>,
    translation_name: String,
    query: String,
) -> Result<Option<ResolvedReference>> {
    let translation = translation(&app, &state, &translation_name)?;
    Ok(translation.resolve(&query).map(|reference| ResolvedReference {
        label: translation.reference_label(&reference),
        text: translation.passage_text(&reference),
        reference,
    }))
}

/// Text + label for an arbitrary verse range, used when the operator selects a
/// span in the verse list.
#[tauri::command]
async fn get_passage(
    app: AppHandle,
    state: State<'_, AppState>,
    translation_name: String,
    reference: Reference,
) -> Result<ResolvedReference> {
    let translation = translation(&app, &state, &translation_name)?;
    Ok(ResolvedReference {
        label: translation.reference_label(&reference),
        text: translation.passage_text(&reference),
        reference,
    })
}

#[tauri::command]
async fn import_translation(
    app: AppHandle,
    path: String,
    name: Option<String>,
) -> Result<TranslationMeta> {
    let meta = bible::import(
        &paths::translations_dir(&app)?,
        std::path::Path::new(&path),
        name.as_deref(),
    )?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(meta)
}

/// The translations lyricverse.app is offering. Network work, so `async`:
/// a plain command would hold the main thread and paint the window as
/// "Not Responding" while a slow site answers.
#[tauri::command(async)]
async fn list_downloadable_translations() -> Result<Vec<catalog::RemoteTranslation>> {
    catalog::list().await
}

#[tauri::command(async)]
async fn download_translation(
    app: AppHandle,
    entry: catalog::RemoteTranslation,
) -> Result<TranslationMeta> {
    let meta = catalog::download(&app, &entry).await?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(meta)
}

#[tauri::command]
fn delete_translation(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    delete_file: bool,
) -> Result<()> {
    bible::remove(&paths::translations_dir(&app)?, &name, delete_file)?;
    lock(&state.translations)?.remove(&name);
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

// --- Misc -----------------------------------------------------------------

/// Shows the app's data folder in the system file manager.
///
/// Copying the path to the clipboard is not the same thing: dropping a MyBible
/// module or a backup of a songbook in there by hand means having the folder
/// actually open, and on macOS the path is inside `~/Library`, which the Finder
/// hides from anybody who has not learnt the keystroke for it.
#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<()> {
    let dir = paths::data_dir(&app)?;

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    // Spawned, not waited on. Explorer returns a non-zero exit code even when
    // it has done exactly what was asked, and no file manager anywhere is
    // worth holding the console still for.
    command.arg(&dir).spawn()?;
    Ok(())
}

// --- Timer ----------------------------------------------------------------

#[tauri::command]
fn get_timer(state: State<'_, AppState>) -> Result<Option<Timer>> {
    Ok(lock(&state.timer)?.clone())
}

/// Displays tick the clock themselves from the anchor, so this is called when
/// the operator changes something — not once a second.
#[tauri::command]
fn set_timer(app: AppHandle, state: State<'_, AppState>, timer: Option<Timer>) -> Result<()> {
    *lock(&state.timer)? = timer.clone();
    let _ = app.emit(EVENT_TIMER, timer);
    publish_web(&app);
    Ok(())
}

// --- Video transport ------------------------------------------------------

#[tauri::command]
fn get_playback(state: State<'_, AppState>) -> Result<Playback> {
    Ok(lock(&state.playback)?.clone())
}

/// Displays follow this: play, pause, seek, mute, loop.
#[tauri::command]
fn set_playback(app: AppHandle, state: State<'_, AppState>, playback: Playback) -> Result<Playback> {
    let next = {
        let mut guard = lock(&state.playback)?;
        let revision = guard.revision.wrapping_add(1);
        *guard = Playback { revision, ..playback };
        guard.clone()
    };
    let _ = app.emit(EVENT_PLAYBACK, &next);
    publish_web(&app);
    Ok(next)
}

// --- Presentations --------------------------------------------------------

#[tauri::command]
fn list_presentations(app: AppHandle) -> Result<Vec<presentations::Presentation>> {
    presentations::list(&paths::presentations_dir(&app)?)
}

#[tauri::command]
fn create_presentation(app: AppHandle, name: String) -> Result<presentations::Presentation> {
    let deck = presentations::create(&paths::presentations_dir(&app)?, &name)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(deck)
}

#[tauri::command]
fn rename_presentation(app: AppHandle, id: String, name: String) -> Result<()> {
    presentations::rename(&paths::presentations_dir(&app)?, &id, &name)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
fn delete_presentation(app: AppHandle, id: String) -> Result<()> {
    presentations::remove(&paths::presentations_dir(&app)?, &id)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
async fn add_presentation_image(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<presentations::Presentation> {
    let deck = presentations::add_image(
        &paths::presentations_dir(&app)?,
        &id,
        std::path::Path::new(&path),
    )?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(deck)
}

/// One rasterised PDF page, PNG bytes straight from the frontend's canvas.
///
/// Base64 rather than a byte array: serde would otherwise turn a 3 MB image
/// into a JSON array of three million numbers.
#[tauri::command]
async fn add_presentation_page(
    app: AppHandle,
    id: String,
    data: String,
) -> Result<presentations::Presentation> {
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|_| AppError::msg("that page could not be decoded"))?;
    presentations::add_page(&paths::presentations_dir(&app)?, &id, &bytes)
}

/// Reads a file the operator picked in a dialog, for the PDF importer.
///
/// Done here rather than with the filesystem plugin so the app never has to
/// hand the webview a broad read scope over the disk.
#[tauri::command]
async fn read_file_base64(path: String) -> Result<String> {
    let path = std::path::PathBuf::from(path);
    let allowed = matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("pdf")
    );
    if !allowed {
        return Err(AppError::msg("only PDF files can be read this way"));
    }
    let bytes = std::fs::read(&path)?;
    Ok(BASE64.encode(bytes))
}

#[tauri::command]
fn add_presentation_text(
    app: AppHandle,
    id: String,
    text: String,
) -> Result<presentations::Presentation> {
    let deck = presentations::add_text(&paths::presentations_dir(&app)?, &id, &text)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(deck)
}

#[tauri::command]
fn set_presentation_text(
    app: AppHandle,
    id: String,
    file: String,
    text: String,
) -> Result<presentations::Presentation> {
    presentations::set_text(&paths::presentations_dir(&app)?, &id, &file, &text)
}

#[tauri::command]
fn reorder_presentation(
    app: AppHandle,
    id: String,
    order: Vec<String>,
) -> Result<presentations::Presentation> {
    let deck = presentations::reorder(&paths::presentations_dir(&app)?, &id, order)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(deck)
}

#[tauri::command]
fn remove_presentation_slide(
    app: AppHandle,
    id: String,
    file: String,
) -> Result<presentations::Presentation> {
    let deck = presentations::remove_slide(&paths::presentations_dir(&app)?, &id, &file)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(deck)
}

// --- Audio ----------------------------------------------------------------

#[tauri::command]
fn list_tracks(app: AppHandle) -> Result<Vec<audio::Track>> {
    audio::list(&paths::audio_dir(&app)?)
}

#[tauri::command]
async fn import_track(app: AppHandle, path: String) -> Result<audio::Track> {
    let track = audio::import(&paths::audio_dir(&app)?, std::path::Path::new(&path))?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(track)
}

#[tauri::command]
fn rename_track(app: AppHandle, id: String, name: String) -> Result<()> {
    audio::rename(&paths::audio_dir(&app)?, &id, &name)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
fn set_track_looping(app: AppHandle, id: String, looping: bool) -> Result<()> {
    audio::set_looping(&paths::audio_dir(&app)?, &id, looping)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

// --- Songs in and out -----------------------------------------------------

#[tauri::command]
fn export_songs(
    app: AppHandle,
    songbook: String,
    ids: Vec<i64>,
    format: String,
    destination: String,
) -> Result<Vec<String>> {
    let written = songio::export(
        &paths::songbooks_dir(&app)?,
        &songbook,
        &ids,
        &format,
        std::path::Path::new(&destination),
    )?;
    Ok(written.iter().map(|path| path.to_string_lossy().into_owned()).collect())
}

#[tauri::command]
fn import_songs(
    app: AppHandle,
    songbook: String,
    paths: Vec<String>,
) -> Result<songio::ImportReport> {
    let files: Vec<std::path::PathBuf> = paths.into_iter().map(std::path::PathBuf::from).collect();
    let report = songio::import(&paths::songbooks_dir(&app)?, &songbook, &files)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(report)
}

// --- Service plans --------------------------------------------------------

#[tauri::command]
fn list_plans(app: AppHandle) -> Result<Vec<plans::Plan>> {
    plans::list(&paths::plans_dir(&app)?)
}

#[tauri::command]
fn save_plan(app: AppHandle, plan: plans::Plan) -> Result<plans::Plan> {
    let saved = plans::save(&paths::plans_dir(&app)?, plan)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(saved)
}

#[tauri::command]
fn delete_plan(app: AppHandle, id: String) -> Result<()> {
    plans::remove(&paths::plans_dir(&app)?, &id)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
fn set_track_volume(app: AppHandle, id: String, volume: f64) -> Result<()> {
    audio::set_volume(&paths::audio_dir(&app)?, &id, volume)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
fn delete_track(app: AppHandle, id: String, delete_file: bool) -> Result<()> {
    audio::remove(&paths::audio_dir(&app)?, &id, delete_file)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

/// Every audio extension the pickers should offer, so the filter lists cannot
/// drift from what the importer accepts.
#[tauri::command]
fn supported_audio_extensions() -> Vec<&'static str> {
    audio::supported_extensions()
}

// --- Videos ---------------------------------------------------------------

#[tauri::command]
fn list_videos(app: AppHandle) -> Result<Vec<videos::Video>> {
    videos::list(&paths::videos_dir(&app)?)
}

#[tauri::command]
async fn import_video(app: AppHandle, path: String) -> Result<videos::Video> {
    let video = videos::import_file(&paths::videos_dir(&app)?, std::path::Path::new(&path))?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(video)
}

#[tauri::command]
fn add_youtube_video(app: AppHandle, name: String, url: String) -> Result<videos::Video> {
    let video = videos::add_youtube(&paths::videos_dir(&app)?, &name, &url)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(video)
}

#[tauri::command]
fn set_video_looping(app: AppHandle, id: String, looping: bool) -> Result<()> {
    videos::set_looping(&paths::videos_dir(&app)?, &id, looping)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
fn rename_video(app: AppHandle, id: String, name: String) -> Result<()> {
    videos::rename(&paths::videos_dir(&app)?, &id, &name)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

#[tauri::command]
fn delete_video(app: AppHandle, id: String, delete_file: bool) -> Result<()> {
    videos::remove(&paths::videos_dir(&app)?, &id, delete_file)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

// --- Backgrounds ----------------------------------------------------------

/// Every image extension the pickers should offer, so the frontend's filter
/// lists cannot drift from what the importer actually accepts.
#[tauri::command]
fn supported_image_extensions() -> Vec<&'static str> {
    images::supported_extensions()
}

#[tauri::command]
fn list_backgrounds(app: AppHandle) -> Result<Vec<backgrounds::Background>> {
    backgrounds::list(&paths::backgrounds_dir(&app)?)
}

#[tauri::command]
async fn import_background(app: AppHandle, path: String) -> Result<backgrounds::Background> {
    let meta = backgrounds::import(
        &paths::backgrounds_dir(&app)?,
        std::path::Path::new(&path),
    )?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(meta)
}

#[tauri::command]
fn delete_background(app: AppHandle, filename: String) -> Result<()> {
    backgrounds::remove(&paths::backgrounds_dir(&app)?, &filename)?;
    let _ = app.emit(EVENT_LIBRARY, ());
    Ok(())
}

/// Family names of every font installed on this machine, for the layout
/// editor's font picker.
#[tauri::command]
async fn list_fonts() -> Result<Vec<String>> {
    Ok(fonts::list())
}

#[tauri::command]
fn get_data_dir(app: AppHandle) -> Result<PathBuf> {
    paths::data_dir(&app)
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| AppError::msg("internal state was poisoned by an earlier error"))
}

// --- Entry point ----------------------------------------------------------

pub fn run() {
    // Installed here rather than left to whichever dependency reaches TLS
    // first: both the updater and the translation catalogue build a client
    // that refuses to start without one, and "no process-level
    // CryptoProvider" is a poor thing to discover on a Sunday.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The updater checks a signed manifest on GitHub; `process` is what
        // lets the app restart itself once an update has been applied.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(webscreen::WebScreens::default())
        .manage(appmenu::MenuChecks::default())
        .on_menu_event(|app, event| {
            // The menu bar writes the same settings the in-app View button
            // does, and goes down the same save-and-broadcast path — so every
            // window and every screen hears about it either way.
            let id = event.id().as_ref().to_string();
            // Actions go to the window rather than being carried out here.
            if appmenu::is_song_action(&id) {
                let _ = app.emit(EVENT_MENU, &id);
                return;
            }
            let state = app.state::<AppState>();
            let Ok(mut guard) = state.settings.lock() else { return };
            if !appmenu::toggle(&mut guard, &id) {
                return;
            }
            let stored = guard.clone();
            drop(guard);
            let _ = settings::save(app, &stored);
            appmenu::sync(app, &stored);
            let _ = app.emit(EVENT_SETTINGS, &stored);
        })
        .setup(|app| {
            let handle = app.handle().clone();

            seed::run(&handle)?;
            let songbooks_dir = paths::songbooks_dir(&handle)?;
            songs::ensure_manifest(&songbooks_dir)?;
            songs::adopt_orphans(&songbooks_dir)?;
            paths::presentations_dir(&handle)?;
            paths::videos_dir(&handle)?;
            paths::audio_dir(&handle)?;
            let translations_dir = paths::translations_dir(&handle)?;
            bible::ensure_manifest(&translations_dir)?;
            bible::adopt_orphans(&translations_dir)?;

            let loaded = settings::load(&handle)?;
            // `load` repairs an older schema in memory; write it back so the
            // file on disk matches what the app is actually using.
            let migrated = loaded.version != settings::SETTINGS_VERSION;
            let displays = display::list(&handle)?;
            let state = handle.state::<AppState>();
            let stored = {
                let mut guard = state
                    .settings
                    .lock()
                    .map_err(|_| AppError::msg("settings state poisoned"))?;
                *guard = loaded;
                if ensure_display_entries(&mut guard, &displays) || migrated {
                    settings::save(&handle, &guard)?;
                }
                display::sync(&handle, &guard)?;
                guard.clone()
            };
            // Outside the block on purpose: publishing the first frame takes
            // the settings lock itself, and a `std::sync::Mutex` taken twice on
            // one thread does not politely fail — it stops the thread dead.
            sync_web_screens(&handle, &stored);
            appmenu::install(&handle, &stored)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the console ends the service: take the projections down
            // with it rather than leaving orphaned fullscreen windows.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                && window.label() == display::CONTROL_WINDOW
            {
                let app = window.app_handle().clone();
                display::close_all(&app);
                app.state::<webscreen::WebScreens>().shutdown_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_settings,
            save_settings,
            list_displays,
            sync_displays,
            identify_displays,
            open_test_window,
            open_data_folder,
            get_live,
            set_live,
            blank,
            list_songbooks,
            list_songs,
            get_song,
            save_song,
            delete_song,
            create_songbook,
            parse_sections,
            parse_lyrics,
            import_songbook,
            rename_songbook,
            delete_songbook,
            list_translations,
            get_books,
            get_chapters,
            get_verses,
            get_parallel_chapter,
            search_bible,
            resolve_reference,
            get_passage,
            import_translation,
            delete_translation,
            list_downloadable_translations,
            download_translation,
            get_timer,
            set_timer,
            get_playback,
            set_playback,
            list_presentations,
            create_presentation,
            rename_presentation,
            delete_presentation,
            add_presentation_image,
            add_presentation_page,
            read_file_base64,
            add_presentation_text,
            set_presentation_text,
            reorder_presentation,
            remove_presentation_slide,
            list_tracks,
            import_track,
            rename_track,
            set_track_looping,
            set_track_volume,
            delete_track,
            export_songs,
            import_songs,
            list_plans,
            save_plan,
            delete_plan,
            supported_audio_extensions,
            list_videos,
            set_video_looping,
            import_video,
            add_youtube_video,
            rename_video,
            delete_video,
            supported_image_extensions,
            list_backgrounds,
            import_background,
            delete_background,
            list_fonts,
            get_data_dir,
            add_web_screen,
            update_web_screen,
            remove_web_screen,
            list_web_screens,
            lan_address,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LyricVerse");
}
