//! Screen enumeration and the projection windows placed on them.
//!
//! v1 rebuilt every projection window on each `open_window()` call without
//! closing the old ones, leaking a fullscreen window per invocation. Here the
//! window set is reconciled against the settings: open what should exist,
//! close what should not, and reposition the rest.

use serde::Serialize;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder,
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
            let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
            let _ = window.set_size(PhysicalSize::new(size.width, size.height));
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

        window.set_position(PhysicalPosition::new(position.x, position.y))?;
        window.set_size(PhysicalSize::new(size.width, size.height))?;
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
