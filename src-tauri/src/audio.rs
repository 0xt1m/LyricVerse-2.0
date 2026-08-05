//! Audio tracks: files imported into the library.
//!
//! Deliberately the same shape as `videos.rs` — a manifest beside the copied
//! files — because they are the same problem. A file is copied in so it keeps
//! playing after the original moves, and so the webview needs read access to
//! one directory rather than the disk.
//!
//! Unlike a clip, a track plays in the operator's own window rather than on a
//! screen: the machine running the console is the one plugged into the desk.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths::{ensure_dir, safe_child, slugify_filename, unique_path};

const MANIFEST: &str = "audio.json";
/// What a webview can decode without help. AAC and ALAC arrive as `.m4a`, so
/// the container is listed rather than the codec.
const EXTENSIONS: [&str; 7] = ["mp3", "m4a", "aac", "wav", "aiff", "flac", "ogg"];

pub fn supported_extensions() -> Vec<&'static str> {
    EXTENSIONS.to_vec()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    /// Start again at the end. Saved per track, since whether a piece loops is
    /// a property of the piece — a bed of music does, a sting does not.
    pub looping: bool,
    /// The file is gone from under us; kept in the list so it can be seen and
    /// removed rather than silently vanishing.
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    filename: String,
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

pub fn list(dir: &Path) -> Result<Vec<Track>> {
    let manifest = read_manifest(dir);
    let mut out: Vec<Track> = manifest
        .into_iter()
        .filter_map(|(id, entry)| {
            let path = safe_child(dir, &entry.filename).ok()?;
            Some(Track {
                id,
                missing: !path.exists(),
                name: entry.name,
                looping: entry.looping,
                path,
            })
        })
        .collect();
    out.sort_by_key(|track| track.name.to_lowercase());
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

pub fn import(dir: &Path, source: &Path) -> Result<Track> {
    ensure_dir(dir)?;
    if !source.exists() {
        return Err(AppError::msg(format!("{} does not exist", source.display())));
    }
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| EXTENSIONS.contains(&e.as_str()))
        .ok_or_else(|| {
            AppError::msg(format!(
                "unsupported audio — use {}",
                EXTENSIONS.join(", ").to_uppercase()
            ))
        })?;

    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
    let target = unique_path(dir, &slugify_filename(stem), &extension);
    fs::copy(source, &target)?;

    let filename = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::msg("could not determine the audio file name"))?
        .to_string();

    let mut manifest = read_manifest(dir);
    let id = fresh_id(&manifest, &slugify_filename(stem));
    manifest.insert(
        id.clone(),
        Entry { name: stem.to_string(), filename, looping: false },
    );
    write_manifest(dir, &manifest)?;

    Ok(Track {
        id,
        name: stem.to_string(),
        path: target,
        looping: false,
        missing: false,
    })
}

pub fn rename(dir: &Path, id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("a track needs a name"));
    }
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("track \"{id}\" does not exist")))?;
    entry.name = name.to_string();
    write_manifest(dir, &manifest)
}

pub fn set_looping(dir: &Path, id: &str, looping: bool) -> Result<()> {
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("track \"{id}\" does not exist")))?;
    entry.looping = looping;
    write_manifest(dir, &manifest)
}

pub fn remove(dir: &Path, id: &str, delete_file: bool) -> Result<()> {
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .remove(id)
        .ok_or_else(|| AppError::msg(format!("track \"{id}\" does not exist")))?;
    write_manifest(dir, &manifest)?;

    if delete_file {
        let path = safe_child(dir, &entry.filename)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lyricverse-audio-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        ensure_dir(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn imports_renames_and_remembers_looping() {
        let dir = temp();
        let source = dir.join("Quiet Bed.mp3");
        fs::write(&source, b"not really audio").expect("write");

        let track = import(&dir, &source).expect("import");
        assert_eq!(track.name, "Quiet Bed");
        assert!(!track.looping);
        // The original is copied, never moved.
        assert!(source.exists());

        set_looping(&dir, &track.id, true).expect("loop");
        rename(&dir, &track.id, "Prelude").expect("rename");

        let listed = list(&dir).expect("list");
        let found = listed.iter().find(|t| t.id == track.id).expect("present");
        assert_eq!(found.name, "Prelude");
        assert!(found.looping);
        assert!(!found.missing);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_format_the_webview_cannot_play() {
        let dir = temp();
        let source = dir.join("clip.mp4");
        fs::write(&source, b"video").expect("write");
        assert!(import(&dir, &source).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deleted_file_is_listed_as_missing_rather_than_disappearing() {
        let dir = temp();
        let source = dir.join("Sting.wav");
        fs::write(&source, b"x").expect("write");
        let track = import(&dir, &source).expect("import");

        fs::remove_file(&track.path).expect("delete");
        let listed = list(&dir).expect("list");
        assert!(listed.iter().any(|t| t.id == track.id && t.missing));

        fs::remove_dir_all(&dir).ok();
    }
}
