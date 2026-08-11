//! Screen enumeration and the projection windows placed on them.
//!
//! v1 rebuilt every projection window on each `open_window()` call without
//! closing the old ones, leaking a fullscreen window per invocation. Here the
//! window set is reconciled against the settings: open what should exist,
//! close what should not, and reposition the rest.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::error::Result;
use crate::settings::Settings;

pub const WINDOW_PREFIX: &str = "display-";
/// Test windows are labelled `test-display-0`. They deliberately do NOT share
/// the `display-` prefix, so `sync` never treats one as a projection window.
pub const TEST_PREFIX: &str = "test-";
pub const CONTROL_WINDOW: &str = "control";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// Stable key used in settings and as the window label.
    pub id: String,
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
    /// Whether a projection window is currently open on this screen.
    pub is_open: bool,
}

pub fn display_id(index: usize) -> String {
    format!("{WINDOW_PREFIX}{index}")
}

/// The rectangle each projection window is currently being held to, keyed by
/// label. An entry means a settling thread is already running for it, so a
/// burst of `sync` calls cannot pile them up — and because the thread reads the
/// target back out of here, a screen that changes resolution mid-settle is
/// followed rather than fought.
type Rect = (PhysicalPosition<i32>, PhysicalSize<u32>);
static SETTLING: Mutex<BTreeMap<String, Rect>> = Mutex::new(BTreeMap::new());

/// How long a window is watched after being placed, and how often — gaps in
/// milliseconds between checks. Long enough to outlast the window manager
/// having its own say (see `cover`), short enough to be over before anybody
/// puts a slide up.
const SETTLE_CHECKS: [u64; 4] = [60, 150, 350, 700];

fn set_rect(window: &WebviewWindow, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) {
    let _ = window.set_position(position);
    let _ = window.set_size(size);
}

/// Whether the window is exactly over its screen. `inner_size` rather than
/// `outer_size` because the inner size is what was asked for — comparing
/// against an outer size the platform derives from it would never agree, and
/// the correction below would run every time for nothing.
fn covers(window: &WebviewWindow, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> bool {
    matches!(
        (window.outer_position(), window.inner_size()),
        (Ok(at), Ok(inner)) if at == position && inner == size
    )
}

/// Lifts a projection window above the menu bar.
///
/// macOS draws the menu bar over ordinary windows, and "always on top" is not
/// high enough: it puts a window at the floating level, which is below the
/// menu bar's. On a projector that means the operator's own menu across the
/// top of the scripture, which is what this is here to stop.
///
/// The level is raised just past the one the menu bar uses, not to the top of
/// the stack — a projection window has no business sitting over a system
/// alert.
#[cfg(target_os = "macos")]
fn raise_above_menu_bar(window: &WebviewWindow) {
    use objc::{msg_send, sel, sel_impl};

    // NSStatusWindowLevel is 25, and the menu bar sits just below it.
    const ABOVE_MENU_BAR: i64 = 26;

    let Ok(handle) = window.ns_window() else { return };
    if handle.is_null() {
        return;
    }
    unsafe {
        let ns_window = handle as *mut objc::runtime::Object;
        let _: () = msg_send![ns_window, setLevel: ABOVE_MENU_BAR];
    }
}

/// Every other platform stacks a borderless always-on-top window over its own
/// task bar without help.
#[cfg(not(target_os = "macos"))]
fn raise_above_menu_bar(_window: &WebviewWindow) {}

/// Puts the window over the whole of a screen — and makes sure it stayed there.
///
/// Setting the position and then the size is not enough on its own. Both are
/// requests to the window manager, and what happens next can undo them:
///
/// - Windows sends `WM_DPICHANGED` when a window crosses to a monitor with
///   different scaling, and resizes it to suit — a window built against the
///   console's DPI and then moved to the projector is rescaled *after* these
///   calls return, so the size asked for here is overwritten a moment later.
/// - macOS nudges a new window clear of the menu bar rather than letting it sit
///   at the very top of a screen.
///
/// Either leaves the projection a few pixels short: a black band down an edge,
/// which is exactly what nobody wants on a wall. So the rectangle is asserted
/// again as the window settles, and the last word is ours.
fn cover(window: &WebviewWindow, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) {
    raise_above_menu_bar(window);
    set_rect(window, position, size);

    let label = window.label().to_string();
    {
        let Ok(mut settling) = SETTLING.lock() else { return };
        // A thread is already watching this window: leave it the new target
        // and let it carry on, rather than starting a second one that would
        // pull against it.
        if settling.insert(label.clone(), (position, size)).is_some() {
            return;
        }
    }

    let window = window.clone();
    thread::spawn(move || {
        for delay in SETTLE_CHECKS {
            thread::sleep(Duration::from_millis(delay));
            let Some(target) = SETTLING.lock().ok().and_then(|s| s.get(&label).copied()) else {
                return;
            };
            // Re-applying a size the window already has is not free — it
            // relayouts the webview, and a stage mid-song would visibly jump.
            if !covers(&window, target.0, target.1) {
                set_rect(&window, target.0, target.1);
            }
        }
        let target = SETTLING.lock().ok().and_then(|mut s| s.remove(&label));
        // Still short of the screen after all that. Nothing more can be done
        // from here, but say so: the numbers name the platform's own idea of
        // the window, which is the only way to tell a refused size from a
        // monitor that reports a resolution it is not running at.
        if let Some((position, size)) = target {
            if !covers(&window, position, size) {
                eprintln!(
                    "[display] {label}: asked for {}×{} at ({}, {}), got {:?} at {:?}",
                    size.width,
                    size.height,
                    position.x,
                    position.y,
                    window.inner_size().ok(),
                    window.outer_position().ok(),
                );
            }
        }
    });
}

/// Monitors in a stable left-to-right, top-to-bottom order so display ids do
/// not shuffle between launches.
fn ordered_monitors(app: &AppHandle) -> Result<Vec<Monitor>> {
    let mut monitors = app.available_monitors()?;
    monitors.sort_by_key(|m| (m.position().x, m.position().y));
    Ok(monitors)
}

fn primary_origin(app: &AppHandle) -> Option<(i32, i32)> {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.position().x, m.position().y))
}

/// The operator's own screen is never a projection target. A borderless,
/// always-on-top, full-screen window over the console would hide the controls
/// used to dismiss it — so the answer is to not open one in the first place.
fn is_primary(monitor: &Monitor, primary: Option<(i32, i32)>) -> bool {
    primary == Some((monitor.position().x, monitor.position().y))
}

pub fn list(app: &AppHandle) -> Result<Vec<DisplayInfo>> {
    let primary = primary_origin(app);

    Ok(ordered_monitors(app)?
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            let position = monitor.position();
            let size = monitor.size();
            let id = display_id(index);
            DisplayInfo {
                is_open: app.get_webview_window(&id).is_some(),
                index,
                name: monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("Display {}", index + 1)),
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale_factor: monitor.scale_factor(),
                is_primary: is_primary(&monitor, primary),
                id,
            }
        })
        .collect())
}

/// Brings the open projection windows in line with `settings`.
pub fn sync(app: &AppHandle, settings: &Settings) -> Result<()> {
    let monitors = ordered_monitors(app)?;
    let primary = primary_origin(app);

    // Only screens that are both enabled and not the console's own may host a
    // projection window. Checking here — rather than only in the UI — means a
    // hand-edited or stale settings file cannot cover the operator's screen.
    let projectable: Vec<String> = monitors
        .iter()
        .enumerate()
        .filter(|(index, monitor)| {
            !is_primary(monitor, primary)
                && settings
                    .displays
                    .get(&display_id(*index))
                    .map(|c| c.enabled)
                    .unwrap_or(false)
        })
        .map(|(index, _)| display_id(index))
        .collect();

    // Close windows whose screen was unplugged, switched off, or became primary.
    for window in app.webview_windows().values() {
        let label = window.label().to_string();
        if label.starts_with(WINDOW_PREFIX) && !projectable.contains(&label) {
            let _ = window.close();
        }
    }

    for (index, monitor) in monitors.iter().enumerate() {
        let id = display_id(index);
        if !projectable.contains(&id) {
            continue;
        }
        let position = *monitor.position();
        let size = *monitor.size();

        if let Some(window) = app.get_webview_window(&id) {
            // The screen may have been rearranged or changed resolution.
            cover(&window, position, size);
            let _ = window.show();
            continue;
        }

        // Borderless + exactly monitor-sized rather than OS fullscreen: on
        // macOS a real fullscreen window creates its own Space, which yanks
        // the operator away from the console every time it opens.
        let logical = LogicalSize::new(
            size.width as f64 / monitor.scale_factor(),
            size.height as f64 / monitor.scale_factor(),
        );
        let window = WebviewWindowBuilder::new(app, &id, WebviewUrl::App("display.html".into()))
            .title("LyricVerse")
            .inner_size(logical.width, logical.height)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(false)
            .visible(false)
            .build()?;

        cover(&window, position, size);
        window.show()?;
    }

    // Opening a borderless always-on-top window steals focus on some window
    // managers; hand it straight back to the operator console.
    if let Some(control) = app.get_webview_window(CONTROL_WINDOW) {
        let _ = control.set_focus();
    }
    Ok(())
}

/// Opens (or focuses) an ordinary, resizable window showing exactly what a
/// given screen's configuration produces.
///
/// Essential when the operator has one monitor: the real projection surface is
/// borderless and full-screen, so without this there is no way to check a
/// layout before a service — which is how v1 was used, by pushing settings to
/// the projector and looking up at the wall.
pub fn open_test(app: &AppHandle, display_id: &str) -> Result<()> {
    let label = format!("{TEST_PREFIX}{display_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("display.html".into()))
        .title(format!("LyricVerse — {display_id}"))
        .inner_size(960.0, 540.0)
        .min_inner_size(320.0, 180.0)
        .resizable(true)
        .decorations(true)
        .center()
        .build()?;
    let _ = window.set_focus();
    Ok(())
}

/// Closes every projection and test window, e.g. on shutdown.
pub fn close_all(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let label = window.label();
        if label.starts_with(WINDOW_PREFIX) || label.starts_with(TEST_PREFIX) {
            let _ = window.close();
        }
    }
}
