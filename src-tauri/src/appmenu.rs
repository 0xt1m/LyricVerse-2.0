//! The app's own menus in the macOS menu bar.
//!
//! The same switches as the in-app View button, put where a Mac user
//! looks for them. Both routes write the same settings, so a tick here and a
//! tick there can never disagree — the menu is refreshed from the settings
//! whenever they change, wherever the change came from.
//!
//! macOS only. On Windows and Linux a `Menu` becomes a bar inside the window,
//! and this app has never had one; growing one on those platforms because of a
//! macOS request would be a strange trade.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

use crate::error::Result;
use crate::settings::Settings;

/// Menu id → the setting it toggles. The id is what comes back in the event,
/// and the field name is what the frontend already calls it.
pub const ITEMS: [(&str, &str); 5] = [
    ("view.statusBar", "Status bar"),
    ("view.filmstrip", "Slide strip"),
    ("view.sidePanel", "Side panel"),
    // Where that panel goes. Ticks rather than a submenu: two mutually
    // exclusive items read as a choice, and Tauri's menu has no radio item.
    ("view.sidePanel.right", "Side panel on the right"),
    ("view.sidePanel.bottom", "Side panel at the bottom"),
];

/// The Songs menu: actions rather than switches.
///
/// These cannot be carried out here — importing needs a file picker and
/// exporting needs to know which songbook is open, both of which live in the
/// window — so a click is forwarded to the frontend, which runs exactly the
/// same code the in-app button does.
pub const SONG_ITEMS: [(&str, &str); 3] = [
    ("songs.import", "Import Songs…"),
    ("songs.exportJson", "Export Songbook as JSON…"),
    ("songs.exportTxt", "Export Songbook as Text…"),
];

/// True for an id belonging to the Songs menu.
pub fn is_song_action(id: &str) -> bool {
    SONG_ITEMS.iter().any(|(item, _)| *item == id)
}

/// The check items, kept so their ticks can be re-synced later.
#[derive(Default)]
pub struct MenuChecks(Mutex<HashMap<String, CheckMenuItem<Wry>>>);

fn is_on(settings: &Settings, id: &str) -> bool {
    match id {
        "view.statusBar" => settings.show_status_bar,
        "view.filmstrip" => settings.show_filmstrip,
        "view.sidePanel" => settings.show_side_panel,
        // Anything that is not "bottom" is the default, "right".
        "view.sidePanel.bottom" => settings.side_panel_placement == "bottom",
        "view.sidePanel.right" => settings.side_panel_placement != "bottom",
        _ => true,
    }
}

/// Applies a menu click to the settings. Returns false for an id we did not
/// put there — the predefined items handle themselves.
pub fn toggle(settings: &mut Settings, id: &str) -> bool {
    match id {
        "view.statusBar" => settings.show_status_bar = !settings.show_status_bar,
        "view.filmstrip" => settings.show_filmstrip = !settings.show_filmstrip,
        "view.sidePanel" => settings.show_side_panel = !settings.show_side_panel,
        // Picking an edge is a choice, not a toggle: clicking the one already
        // ticked leaves it ticked rather than docking the panel nowhere.
        "view.sidePanel.right" => settings.side_panel_placement = "right".into(),
        "view.sidePanel.bottom" => settings.side_panel_placement = "bottom".into(),
        _ => return false,
    }
    true
}

/// Builds the menu bar: everything Tauri provides by default — including the
/// Edit menu, without which copy and paste stop working — plus our View menu.
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle, settings: &Settings) -> Result<()> {
    let menu = Menu::default(app)?;
    let view = Submenu::with_id(app, "view", "View", true)?;

    let mut checks = HashMap::new();
    for (id, label) in ITEMS {
        let item = CheckMenuItem::with_id(app, id, label, true, is_on(settings, id), None::<&str>)?;
        view.append(&item)?;
        checks.insert(id.to_string(), item);
    }

    let songs = Submenu::with_id(app, "songs", "Song", true)?;
    for (id, label) in SONG_ITEMS {
        songs.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }

    menu.append(&view)?;
    menu.append(&songs)?;
    app.set_menu(menu)?;
    *app.state::<MenuChecks>().0.lock().map_err(|_| {
        crate::error::AppError::msg("menu state poisoned")
    })? = checks;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle, _settings: &Settings) -> Result<()> {
    Ok(())
}

/// Re-ticks the menu from the settings, so a change made in the app's own View
/// button or on the Settings tab shows up here too.
pub fn sync(app: &AppHandle, settings: &Settings) {
    let Some(state) = app.try_state::<MenuChecks>() else {
        return;
    };
    let Ok(checks) = state.0.lock() else {
        return;
    };
    for (id, item) in checks.iter() {
        let _ = item.set_checked(is_on(settings, id));
    }
}
