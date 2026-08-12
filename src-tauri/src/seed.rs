//! Population of the user's data folder from the bundled resources.
//!
//! The marker file records *which* files have already been offered rather than
//! just "seeding happened". That gives both properties we want: content the
//! user deleted never reappears, and content added by a later version still
//! arrives on upgrade.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::paths;

const MARKER: &str = ".seeded.json";
/// The songbook a brand-new install starts with.
///
/// A machine with no songbook at all cannot be given a song — there is nowhere
/// to put one — so the first run leaves one ready. Numbered rather than named:
/// that is how the books themselves are numbered, and anybody who wants a name
/// can rename it.
const STARTER_SONGBOOK: &str = "001";
/// The v1 of this mechanism wrote a plain-text `.seeded` file.
const LEGACY_MARKER: &str = ".seeded";

#[derive(Debug, Default, Serialize, Deserialize)]
struct SeedRecord {
    /// Relative paths, e.g. "Songbooks/EvPisni.db", that have been placed once.
    #[serde(default)]
    offered: BTreeSet<String>,
}

pub fn run(app: &AppHandle) -> Result<()> {
    let data_dir = paths::data_dir(app)?;
    let songbooks = paths::songbooks_dir(app)?;
    let translations = paths::translations_dir(app)?;
    paths::backgrounds_dir(app)?;

    let marker_path = data_dir.join(MARKER);
    let mut record: SeedRecord = fs::read_to_string(&marker_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    // Upgrading from the plain marker: everything already on disk counts as
    // offered, so nothing the user removed comes back.
    let legacy = data_dir.join(LEGACY_MARKER);
    if legacy.exists() {
        for (dir, prefix) in [(&songbooks, "Songbooks"), (&translations, "BibleTranslations")] {
            for entry in fs::read_dir(dir)?.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    record.offered.insert(format!("{prefix}/{name}"));
                }
            }
        }
        let _ = fs::remove_file(&legacy);
    }

    // Missing resources are not an error: a build without seed data should
    // still start, just empty.
    if let Ok(root) = app.path().resolve("resources/seed", BaseDirectory::Resource) {
        copy_library(&root.join("Songbooks"), &songbooks, "Songbooks", "songbooks.json", &mut record)?;
        copy_library(
            &root.join("BibleTranslations"),
            &translations,
            "BibleTranslations",
            "translations.json",
            &mut record,
        )?;
    }

    starter_songbook(&songbooks, &mut record);

    fs::write(&marker_path, serde_json::to_string_pretty(&record)?)?;
    Ok(())
}

/// Creates the starter songbook, once ever.
///
/// Recorded in the same marker the bundled files use, and for the same reason:
/// somebody who deletes it has deleted it, and it must not be standing there
/// again the next time the app opens. A book of that name already on the shelf
/// is left exactly as it is.
fn starter_songbook(dir: &Path, record: &mut SeedRecord) {
    let key = format!("Songbooks/{STARTER_SONGBOOK}");
    if !record.offered.insert(key) {
        return;
    }
    // `create` refuses a name already taken, which is the behaviour wanted
    // here — an upgrade that finds one is not an error worth reporting.
    let _ = crate::songs::create(dir, STARTER_SONGBOOK);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lyricverse-seed-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn a_new_install_gets_one_songbook_to_write_in() {
        let dir = scratch("starter");
        let mut record = SeedRecord::default();

        starter_songbook(&dir, &mut record);
        let books = crate::songs::list(&dir).expect("list");
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].name, STARTER_SONGBOOK);
        assert_eq!(books[0].song_count, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_it_is_final() {
        let dir = scratch("starter-deleted");
        let mut record = SeedRecord::default();
        starter_songbook(&dir, &mut record);

        // The operator removes it — the manifest is how the app knows what it
        // has, so emptying that is the removal.
        fs::write(dir.join("songbooks.json"), "{}").expect("write");

        // Every launch after that runs this again, and it must stay gone.
        starter_songbook(&dir, &mut record);
        starter_songbook(&dir, &mut record);
        assert!(crate::songs::list(&dir).expect("list").is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}

/// Copies data files that have never been offered before, then merges the
/// source manifest so entries keep their display names.
fn copy_library(
    source: &Path,
    destination: &Path,
    prefix: &str,
    manifest_name: &str,
    record: &mut SeedRecord,
) -> Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    paths::ensure_dir(destination)?;

    let mut placed = Vec::new();
    for entry in fs::read_dir(source)? {
        let path = entry?.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        if name.ends_with(".json") {
            continue;
        }
        let key = format!("{prefix}/{name}");
        if record.offered.contains(&key) {
            continue;
        }
        let target = destination.join(name);
        if !target.exists() {
            fs::copy(&path, &target)?;
        }
        record.offered.insert(key);
        placed.push(name.to_string());
    }

    if placed.is_empty() {
        return Ok(());
    }

    // Only register the entries whose file we just placed, so a manifest name
    // the user renamed is not resurrected.
    let source_manifest = read_manifest(&source.join(manifest_name));
    let manifest_path = destination.join(manifest_name);
    let mut merged = read_manifest(&manifest_path);
    let already: BTreeSet<String> = merged
        .values()
        .filter_map(|value| value.get("filename").and_then(Value::as_str).map(str::to_string))
        .collect();

    for (name, entry) in source_manifest {
        let Some(filename) = entry.get("filename").and_then(Value::as_str) else { continue };
        if placed.iter().any(|p| p == filename) && !already.contains(filename) {
            merged.entry(name).or_insert(entry);
        }
    }
    fs::write(&manifest_path, serde_json::to_string_pretty(&merged)?)?;
    Ok(())
}

fn read_manifest(path: &Path) -> BTreeMap<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}
