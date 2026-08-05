//! Image-based presentations.
//!
//! Every deck is a folder of images, whatever it was made from. PDFs are
//! rasterised page-by-page by the frontend (pdf.js) and handed here as PNGs;
//! images are copied in directly. Keeping one internal representation means
//! projection, reordering and preview never have to care about the source
//! format — and a deck that imported cleanly once cannot break later because
//! a renderer changed.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::images;
use crate::paths::{ensure_dir, safe_child, slugify_filename};

const MANIFEST: &str = "presentations.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slide {
    /// File name inside the deck's folder — the slide's identity, whether it
    /// holds a picture or words.
    pub file: String,
    /// Absolute path, so the webview can build an asset URL. Pictures only.
    pub path: PathBuf,
    /// The words, for a message slide. Stored as a `.txt` beside the images so
    /// ordering, removal and identity need no special cases at all.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub id: String,
    pub name: String,
    pub slides: Vec<Slide>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    /// Ordered file names; the order *is* the running order of the deck.
    #[serde(default)]
    slides: Vec<String>,
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

fn deck_dir(dir: &Path, id: &str) -> Result<PathBuf> {
    let path = safe_child(dir, id)?;
    ensure_dir(&path)?;
    Ok(path)
}

fn resolve(dir: &Path, id: &str, entry: &Entry) -> Result<Presentation> {
    let folder = deck_dir(dir, id)?;
    let slides = entry
        .slides
        .iter()
        .filter_map(|file| {
            let path = folder.join(file);
            // A file deleted behind the app's back must not become a blank
            // slide mid-service.
            if !path.exists() {
                return None;
            }
            let text = is_message(file).then(|| fs::read_to_string(&path).unwrap_or_default());
            Some(Slide { file: file.clone(), path, text })
        })
        .collect();
    Ok(Presentation { id: id.to_string(), name: entry.name.clone(), slides })
}

pub fn list(dir: &Path) -> Result<Vec<Presentation>> {
    let manifest = read_manifest(dir);
    let mut out = Vec::with_capacity(manifest.len());
    for (id, entry) in &manifest {
        out.push(resolve(dir, id, entry)?);
    }
    out.sort_by_key(|deck| deck.name.to_lowercase());
    Ok(out)
}

pub fn get(dir: &Path, id: &str) -> Result<Presentation> {
    let manifest = read_manifest(dir);
    let entry = manifest
        .get(id)
        .ok_or_else(|| AppError::msg(format!("presentation \"{id}\" does not exist")))?;
    resolve(dir, id, entry)
}

pub fn create(dir: &Path, name: &str) -> Result<Presentation> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("a presentation needs a name"));
    }
    let mut manifest = read_manifest(dir);

    let base = slugify_filename(name);
    let mut id = base.clone();
    let mut counter = 2;
    while manifest.contains_key(&id) {
        id = format!("{base}-{counter}");
        counter += 1;
    }

    deck_dir(dir, &id)?;
    manifest.insert(id.clone(), Entry { name: name.to_string(), slides: Vec::new() });
    write_manifest(dir, &manifest)?;
    get(dir, &id)
}

pub fn rename(dir: &Path, id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("a presentation needs a name"));
    }
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("presentation \"{id}\" does not exist")))?;
    entry.name = name.to_string();
    write_manifest(dir, &manifest)
}

pub fn remove(dir: &Path, id: &str) -> Result<()> {
    let mut manifest = read_manifest(dir);
    manifest.remove(id);
    write_manifest(dir, &manifest)?;
    let folder = safe_child(dir, id)?;
    if folder.is_dir() {
        fs::remove_dir_all(folder)?;
    }
    Ok(())
}

/// Appends an image, converting it first if the webview cannot render the
/// format directly.
pub fn add_image(dir: &Path, id: &str, source: &Path) -> Result<Presentation> {
    if !source.exists() {
        return Err(AppError::msg(format!("{} does not exist", source.display())));
    }
    let (bytes, extension) = images::load(source)?;
    append_bytes(dir, id, &bytes, extension)
}

fn is_message(file: &str) -> bool {
    file.to_ascii_lowercase().ends_with(".txt")
}

/// Appends a slide of words rather than a picture.
pub fn add_text(dir: &Path, id: &str, text: &str) -> Result<Presentation> {
    append_bytes(dir, id, text.as_bytes(), "txt")
}

/// Rewrites the words of a message slide.
pub fn set_text(dir: &Path, id: &str, file: &str, text: &str) -> Result<Presentation> {
    if !is_message(file) {
        return Err(AppError::msg("that slide is a picture, not a message"));
    }
    let folder = deck_dir(dir, id)?;
    let path = folder.join(safe_child(Path::new(""), file)?);
    if !path.exists() {
        return Err(AppError::msg("that slide no longer exists"));
    }
    fs::write(path, text)?;
    get(dir, id)
}

/// Appends a page rasterised by the frontend. Used for PDF import.
pub fn add_page(dir: &Path, id: &str, bytes: &[u8]) -> Result<Presentation> {
    append_bytes(dir, id, bytes, "png")
}

fn append_bytes(dir: &Path, id: &str, bytes: &[u8], extension: &str) -> Result<Presentation> {
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("presentation \"{id}\" does not exist")))?;

    let folder = deck_dir(dir, id)?;
    // Numbered from a monotonic counter rather than the slide count, so
    // removing slide 3 and adding another cannot collide with an old file.
    let mut index = entry.slides.len() + 1;
    let mut file = format!("{index:04}.{extension}");
    while folder.join(&file).exists() {
        index += 1;
        file = format!("{index:04}.{extension}");
    }

    fs::write(folder.join(&file), bytes)?;
    entry.slides.push(file);
    write_manifest(dir, &manifest)?;
    get(dir, id)
}

/// Replaces the running order. Any file not named is left on disk but dropped
/// from the deck, so a mis-drag never destroys an image.
pub fn reorder(dir: &Path, id: &str, order: Vec<String>) -> Result<Presentation> {
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("presentation \"{id}\" does not exist")))?;

    let folder = deck_dir(dir, id)?;
    let mut next: Vec<String> = Vec::with_capacity(order.len());
    for file in order {
        if entry.slides.contains(&file) && folder.join(&file).exists() && !next.contains(&file) {
            next.push(file);
        }
    }
    entry.slides = next;
    write_manifest(dir, &manifest)?;
    get(dir, id)
}

pub fn remove_slide(dir: &Path, id: &str, file: &str) -> Result<Presentation> {
    let mut manifest = read_manifest(dir);
    let entry = manifest
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("presentation \"{id}\" does not exist")))?;
    entry.slides.retain(|slide| slide != file);
    write_manifest(dir, &manifest)?;

    let path = deck_dir(dir, id)?.join(safe_child(Path::new(""), file)?);
    if path.exists() {
        fs::remove_file(path)?;
    }
    get(dir, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lyricverse-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn slides_keep_the_order_they_are_given() {
        let dir = scratch("pres-order");
        let deck = create(&dir, "Announcements").unwrap();
        for _ in 0..3 {
            add_page(&dir, &deck.id, b"not-a-real-png").unwrap();
        }

        let deck = get(&dir, &deck.id).unwrap();
        let files: Vec<String> = deck.slides.iter().map(|s| s.file.clone()).collect();
        assert_eq!(files.len(), 3);

        let reversed: Vec<String> = files.iter().rev().cloned().collect();
        let deck = reorder(&dir, &deck.id, reversed.clone()).unwrap();
        assert_eq!(deck.slides.iter().map(|s| s.file.clone()).collect::<Vec<_>>(), reversed);
    }

    #[test]
    fn reorder_ignores_files_that_are_not_in_the_deck() {
        let dir = scratch("pres-reorder-guard");
        let deck = create(&dir, "Deck").unwrap();
        add_page(&dir, &deck.id, b"x").unwrap();
        let deck = reorder(&dir, &deck.id, vec!["0001.png".into(), "../evil.png".into()]).unwrap();
        assert_eq!(deck.slides.len(), 1);
    }

    #[test]
    fn removing_a_deck_takes_its_images_with_it() {
        let dir = scratch("pres-delete");
        let deck = create(&dir, "Temp").unwrap();
        add_page(&dir, &deck.id, b"x").unwrap();
        let folder = dir.join(&deck.id);
        assert!(folder.exists());
        remove(&dir, &deck.id).unwrap();
        assert!(!folder.exists());
        assert!(list(&dir).unwrap().is_empty());
    }
}
