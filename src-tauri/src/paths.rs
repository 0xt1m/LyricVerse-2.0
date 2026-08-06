use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};

pub const SONGBOOKS_DIR: &str = "Songbooks";
pub const TRANSLATIONS_DIR: &str = "BibleTranslations";
pub const BACKGROUNDS_DIR: &str = "Backgrounds";
pub const PRESENTATIONS_DIR: &str = "Presentations";
pub const VIDEOS_DIR: &str = "Videos";
pub const AUDIO_DIR: &str = "Audio";
pub const PLANS_DIR: &str = "Plans";

/// Writable root for everything the user owns: songbooks, translations,
/// settings. Kept outside the app bundle so updating the app can never wipe a
/// congregation's data — the failure mode the v1 updater warned about.
pub fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::msg("could not resolve the application data directory"))?;
    ensure_dir(&dir)?;
    Ok(dir)
}

pub fn songbooks_dir(app: &AppHandle) -> Result<PathBuf> {
    subdir(app, SONGBOOKS_DIR)
}

pub fn translations_dir(app: &AppHandle) -> Result<PathBuf> {
    subdir(app, TRANSLATIONS_DIR)
}

pub fn backgrounds_dir(app: &AppHandle) -> Result<PathBuf> {
    subdir(app, BACKGROUNDS_DIR)
}

pub fn presentations_dir(app: &AppHandle) -> Result<PathBuf> {
    subdir(app, PRESENTATIONS_DIR)
}

pub fn videos_dir(app: &AppHandle) -> Result<PathBuf> {
    subdir(app, VIDEOS_DIR)
}

pub fn audio_dir(app: &AppHandle) -> Result<PathBuf> {
    subdir(app, AUDIO_DIR)
}

pub fn plans_dir(app: &AppHandle) -> Result<PathBuf> {
    subdir(app, PLANS_DIR)
}

pub fn settings_file(app: &AppHandle) -> Result<PathBuf> {
    Ok(data_dir(app)?.join("settings.json"))
}

fn subdir(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let dir = data_dir(app)?.join(name);
    ensure_dir(&dir)?;
    Ok(dir)
}

pub fn ensure_dir(dir: &Path) -> Result<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
    }
    Ok(())
}

/// Refuse paths that would escape the managed directory. Names arrive from the
/// manifest and from user input, so `../` and absolute paths must not slip in.
pub fn safe_child(dir: &Path, filename: &str) -> Result<PathBuf> {
    let name = Path::new(filename);
    let mut components = name.components();
    let only = components.next();
    if components.next().is_some() {
        return Err(AppError::msg(format!("invalid file name: {filename}")));
    }
    match only {
        Some(std::path::Component::Normal(part)) => Ok(dir.join(part)),
        _ => Err(AppError::msg(format!("invalid file name: {filename}"))),
    }
}

/// Turns a display name into a filesystem-safe stem, preserving Unicode letters
/// (songbooks are usually named in Ukrainian).
pub fn slugify_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "songbook".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// Appends ` (2)`, ` (3)`, … until the path is free.
pub fn unique_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{extension}"));
    let mut counter = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({counter}).{extension}"));
        counter += 1;
    }
    candidate
}
