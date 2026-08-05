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

    fs::write(&marker_path, serde_json::to_string_pretty(&record)?)?;
    Ok(())
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
