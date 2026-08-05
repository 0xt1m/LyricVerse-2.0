//! System font discovery.
//!
//! Reads family names straight out of each font file's `name` table. The
//! webview has no API for enumerating installed fonts (`queryLocalFonts` is
//! Chromium-only and absent from WKWebView), and pulling in a full font
//! library for one list would be heavy — parsing the handful of bytes we need
//! is about eighty lines.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Where each platform keeps fonts. Missing directories are skipped.
fn search_paths() -> Vec<std::path::PathBuf> {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);

    #[cfg(target_os = "macos")]
    {
        paths.push("/System/Library/Fonts".into());
        paths.push("/Library/Fonts".into());
        if let Some(home) = &home {
            paths.push(home.join("Library/Fonts"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(dir) = std::env::var_os("WINDIR") {
            paths.push(std::path::PathBuf::from(dir).join("Fonts"));
        }
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            paths.push(std::path::PathBuf::from(dir).join("Microsoft/Windows/Fonts"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        paths.push("/usr/share/fonts".into());
        paths.push("/usr/local/share/fonts".into());
        if let Some(home) = &home {
            paths.push(home.join(".local/share/fonts"));
            paths.push(home.join(".fonts"));
        }
    }
    let _ = home;
    paths
}

/// Sorted, de-duplicated family names of every readable installed font.
pub fn list() -> Vec<String> {
    let mut families: BTreeSet<String> = BTreeSet::new();
    for root in search_paths() {
        collect(&root, 0, &mut families);
    }
    families.into_iter().collect()
}

fn collect(dir: &Path, depth: usize, out: &mut BTreeSet<String>) {
    // Font directories nest a couple of levels at most; the bound stops a
    // symlink loop from turning startup into a filesystem walk.
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, depth + 1, out);
            continue;
        }
        let Some(extension) = path.extension().and_then(|e| e.to_str()) else { continue };
        if !matches!(extension.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc" | "otc") {
            continue;
        }
        if let Some(family) = family_of(&path) {
            // Apple ships internal fallback faces named ".SF Arabic",
            // ".LastResort" and so on. They are not meant to be chosen.
            if !family.starts_with('.') {
                out.insert(family);
            }
        }
    }
}

fn read_at(file: &mut File, offset: u64, length: usize) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buffer = vec![0u8; length];
    file.read_exact(&mut buffer).ok()?;
    Some(buffer)
}

fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

fn family_of(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let header = read_at(&mut file, 0, 12)?;

    // A TrueType Collection wraps several fonts; the first one names the family.
    let sfnt_offset = if &header[0..4] == b"ttcf" {
        let count = be32(&header, 8)?;
        if count == 0 {
            return None;
        }
        let offsets = read_at(&mut file, 12, 4)?;
        be32(&offsets, 0)? as u64
    } else {
        0
    };

    let directory = read_at(&mut file, sfnt_offset, 12)?;
    let tag = be32(&directory, 0)?;
    // 0x00010000 = TrueType outlines, "OTTO" = CFF outlines, "true" = older Mac.
    if !matches!(tag, 0x0001_0000 | 0x4F54_544F | 0x7472_7565) {
        return None;
    }
    let table_count = be16(&directory, 4)? as usize;
    let records = read_at(&mut file, sfnt_offset + 12, table_count * 16)?;

    let mut name_table: Option<(u64, usize)> = None;
    for index in 0..table_count {
        let base = index * 16;
        if &records[base..base + 4] == b"name" {
            name_table = Some((be32(&records, base + 8)? as u64, be32(&records, base + 12)? as usize));
            break;
        }
    }
    let (offset, length) = name_table?;
    // Guard against a corrupt length claiming hundreds of megabytes.
    let table = read_at(&mut file, offset, length.min(1 << 20))?;

    let count = be16(&table, 2)? as usize;
    let storage = be16(&table, 4)? as usize;

    // nameID 16 is the typographic family ("Helvetica Neue"); nameID 1 is the
    // legacy family, which splits weights into separate families. Prefer 16.
    let mut best: Option<(u8, String)> = None;
    for index in 0..count {
        let base = 6 + index * 12;
        let platform = be16(&table, base)?;
        let encoding = be16(&table, base + 2)?;
        let name_id = be16(&table, base + 6)?;
        if name_id != 1 && name_id != 16 {
            continue;
        }
        let value_length = be16(&table, base + 8)? as usize;
        let value_offset = be16(&table, base + 10)? as usize;
        let start = storage + value_offset;
        let bytes = table.get(start..start + value_length)?;

        let decoded = match platform {
            // Windows platform: UTF-16BE.
            3 => decode_utf16_be(bytes),
            // Mac platform, Roman encoding: effectively ASCII for family names.
            1 if encoding == 0 => bytes.iter().map(|b| *b as char).collect(),
            0 => decode_utf16_be(bytes),
            _ => continue,
        };
        let decoded = decoded.trim().to_string();
        if decoded.is_empty() || !decoded.chars().all(|c| !c.is_control()) {
            continue;
        }
        let rank = if name_id == 16 { 2 } else { 1 };
        if best.as_ref().map(|(current, _)| rank > *current).unwrap_or(true) {
            best = Some((rank, decoded));
        }
    }
    best.map(|(_, family)| family)
}

fn decode_utf16_be(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_installed_families() {
        let families = list();
        // Every supported platform ships fonts; an empty list means the parse
        // is broken rather than that the machine has none.
        assert!(!families.is_empty(), "no fonts discovered");
        assert!(families.iter().all(|name| !name.trim().is_empty()));
        assert!(families.windows(2).all(|pair| pair[0] <= pair[1]), "not sorted");
        assert!(!families.iter().any(|name| name.starts_with('.')), "internal faces leaked");
        println!("{} families, e.g. {:?}", families.len(), &families[..families.len().min(6)]);
    }
}
