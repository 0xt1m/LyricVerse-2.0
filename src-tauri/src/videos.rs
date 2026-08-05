//! Video clips: files imported into the library, and YouTube links.
//!
//! A file is copied in so it keeps playing after the original moves. A
//! YouTube entry stores only the video id — the projection window embeds the
//! official player, which means that item alone needs the network.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths::{ensure_dir, safe_child, slugify_filename, unique_path};

const MANIFEST: &str = "videos.json";
const EXTENSIONS: [&str; 5] = ["mp4", "m4v", "mov", "webm", "mkv"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoKind {
    File,
    Youtube,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub id: String,
    pub name: String,
    pub kind: VideoKind,
    /// Absolute path for a file, absent for YouTube.
    pub path: Option<PathBuf>,
    /// The 11-character YouTube id, absent for a file.
    pub youtube_id: Option<String>,
    /// Start again at the end. Saved per clip, because whether a clip loops is
    /// a property of the clip — a background bed does, a testimony does not.
    pub looping: bool,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    kind: VideoKind,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    youtube_id: Option<String>,
    #[serde(default)]
    looping: bool,
}

type Manifest = std::collections::BTreeMap<String, Entry>;

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST)
}

fn read_manifest(dir: &Path) -> Manifest {
    fs::read_to_string(manifest_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<()> {
    ensure_dir(dir)?;
    let path = manifest_path(dir);
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_string_pretty(manifest)?)?;
    fs::rename(&temp, &path)?;
    Ok(())
}

pub fn list(dir: &Path) -> Result<Vec<Video>> {
    let manifest = read_manifest(dir);
    let mut out: Vec<Video> = manifest
        .into_iter()
        .map(|(id, entry)| {
            let path = entry
                .filename
                .as_deref()
                .and_then(|name| safe_child(dir, name).ok());
            let missing = entry.kind == VideoKind::File
                && path.as_ref().map(|p| !p.exists()).unwrap_or(true);
            Video {
                id,
                name: entry.name,
                kind: entry.kind,
                youtube_id: entry.youtube_id,
                looping: entry.looping,
                path,
                missing,
            }
        })
        .collect();
    out.sort_by_key(|video| video.name.to_lowercase());
    Ok(out)
}

fn fresh_id(manifest: &Manifest, base: &str) -> String {
    let mut id = base.to_string();
    let mut counter = 2;
    while manifest.contains_key(&id) {
        id = format!("{base}-{counter}");
        counter += 1;
    }
    id
}

pub fn import_file(dir: &Path, source: &Path) -> Result<Video> {
    ensure_dir(dir)?;
    if !source.exists() {
        return Err(AppError::msg(format!("{} does not exist", source.display())));
    }
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| EXTENSIONS.contains(&e.as_str()))
        .ok_or_else(|| AppError::msg("unsupported video — use MP4, MOV or WebM"))?;

    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let target = unique_path(dir, &slugify_filename(stem), &extension);
    fs::copy(source, &target)?;

    let filename = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::msg("could not determine the video file name"))?
        .to_string();

    let mut manifest = read_manifest(dir);
    let id = fresh_id(&manifest, &slugify_filename(stem));
    manifest.insert(
        id.clone(),
        Entry {
            name: stem.to_string(),
            kind: VideoKind::File,
            filename: Some(filename),
            youtube_id: None,
            looping: false,
        },
    );
    write_manifest(dir, &manifest)?;

    Ok(Video {
        id,
        name: stem.to_string(),
        kind: VideoKind::File,
        looping: false,
        path: Some(target),
        youtube_id: None,
        missing: false,
    })
}

/// Accepts any of the URL shapes people actually paste.
pub fn parse_youtube_id(input: &str) -> Option<String> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }

    let is_id = |candidate: &str| {
        candidate.len() == 11
            && candidate
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };

    // A bare id pasted on its own.
    if is_id(text) {
        return Some(text.to_string());
    }

    // Strip the scheme and host, then look at the shapes youtube.com uses:
    //   watch?v=ID · youtu.be/ID · embed/ID · shorts/ID · live/ID
    let without_scheme = text
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.");

    if let Some(rest) = without_scheme.split("v=").nth(1) {
        let candidate: String = rest.chars().take(11).collect();
        if is_id(&candidate) {
            return Some(candidate);
        }
    }
    for marker in ["youtu.be/", "embed/", "shorts/", "live/"] {
        if let Some(rest) = without_scheme.split(marker).nth(1) {
            let candidate: String = rest.chars().take(11).collect();
            if is_id(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn add_youtube(dir: &Path, name: &str, url: &str) -> Result<Video> {
    let youtube_id = parse_youtube_id(url)
        .ok_or_else(|| AppError::msg("that does not look like a YouTube link"))?;
    let name = if name.trim().is_empty() { youtube_id.clone() } else { name.trim().to_string() };

    let mut manifest = read_manifest(dir);
    let id = fresh_id(&manifest, &format!("yt-{youtube_id}"));
    manifest.insert(
        id.clone(),
        Entry {
            name: name.clone(),
            kind: VideoKind::Youtube,
            filename: None,
            youtube_id: Some(youtube_id.clone()),
            looping: false,
        },
    );
    write_manifest(dir, &manifest)?;

    Ok(Video {
        id,
        name,
        kind: VideoKind::Youtube,
        looping: false,
        path: None,
        youtube_id: Some(youtube_id),
        missing: false,
    })
}

pub fn set_looping(dir: &Path, id: &str, looping: bool) -> Result<()> {
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("video \"{id}\" does not exist")))?;
    entry.looping = looping;
    write_manifest(dir, &manifest)
}

pub fn rename(dir: &Path, id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("a video needs a name"));
    }
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("video \"{id}\" does not exist")))?;
    entry.name = name.to_string();
    write_manifest(dir, &manifest)
}

pub fn remove(dir: &Path, id: &str, delete_file: bool) -> Result<()> {
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .remove(id)
        .ok_or_else(|| AppError::msg(format!("video \"{id}\" does not exist")))?;
    write_manifest(dir, &manifest)?;

    if delete_file {
        if let Some(filename) = entry.filename {
            let path = safe_child(dir, &filename)?;
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_youtube_url_shape() {
        let id = "dQw4w9WgXcQ";
        for input in [
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "http://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
        ] {
            assert_eq!(parse_youtube_id(input).as_deref(), Some(id), "failed on {input}");
        }
    }

    #[test]
    fn rejects_things_that_are_not_youtube_links() {
        for input in ["", "   ", "https://vimeo.com/12345", "not a url", "https://youtu.be/short"] {
            assert_eq!(parse_youtube_id(input), None, "wrongly accepted {input:?}");
        }
    }
}
