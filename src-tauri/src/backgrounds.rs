//! Background images and videos.
//!
//! Files are copied into the user's `Backgrounds/` folder so a background
//! keeps working after the original is moved or deleted, and so the webview
//! only ever needs access to one directory.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::paths::{safe_child, slugify_filename, unique_path};

/// WKWebView (macOS) plays H.264 in `.mp4`/`.mov`; WebKitGTK also plays `.webm`.
const VIDEO_EXTENSIONS: [&str; 5] = ["mp4", "m4v", "mov", "webm", "mkv"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Video,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    pub filename: String,
    /// Absolute path, so the webview can turn it into an asset URL.
    pub path: PathBuf,
    pub kind: MediaKind,
    pub bytes: u64,
}

pub fn kind_of(path: &Path) -> Option<MediaKind> {
    let extension = crate::images::extension_of(path);
    if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Video)
    } else if crate::images::is_supported(path) {
        Some(MediaKind::Image)
    } else {
        None
    }
}

pub fn list(dir: &Path) -> Result<Vec<Background>> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else { return Ok(out) };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(kind) = kind_of(&path) else { continue };
        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else { continue };
        out.push(Background {
            filename: filename.to_string(),
            bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
            path,
            kind,
        });
    }
    out.sort_by_key(|item| item.filename.to_lowercase());
    Ok(out)
}

pub fn import(dir: &Path, source: &Path) -> Result<Background> {
    if !source.exists() {
        return Err(AppError::msg(format!("{} does not exist", source.display())));
    }
    let kind = kind_of(source).ok_or_else(|| {
        AppError::msg("unsupported file type — use a JPEG, PNG, WebP, MP4, MOV or WebM")
    })?;

    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("background");

    // Video is copied as-is; an image may need converting into something the
    // webview can actually draw.
    let target = if kind == MediaKind::Video {
        let extension = crate::images::extension_of(source);
        let target = unique_path(dir, &slugify_filename(stem), &extension);
        fs::copy(source, &target)?;
        target
    } else {
        let (bytes, extension) = crate::images::load(source)?;
        let target = unique_path(dir, &slugify_filename(stem), extension);
        fs::write(&target, bytes)?;
        target
    };

    let filename = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::msg("could not determine the background file name"))?
        .to_string();

    Ok(Background {
        bytes: fs::metadata(&target).map(|m| m.len()).unwrap_or(0),
        filename,
        path: target,
        kind,
    })
}

pub fn remove(dir: &Path, filename: &str) -> Result<()> {
    let path = safe_child(dir, filename)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
