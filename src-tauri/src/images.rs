//! Reading whatever image the operator hands us.
//!
//! Formats a webview renders natively are copied through untouched — no
//! re-encode, so a carefully exported JPEG stays exactly as exported. Anything
//! else is decoded and written out as PNG, because a TIFF or a TGA would
//! otherwise land on the projector as a broken-image icon.

use std::path::Path;

use crate::error::{AppError, Result};

/// Rendered directly by every webview LyricVerse targets.
const WEB_SAFE: [&str; 8] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"];

/// Readable by the `image` crate, so they can be converted to PNG.
const CONVERTIBLE: [&str; 9] =
    ["tif", "tiff", "ico", "tga", "qoi", "pnm", "ppm", "pgm", "pbm"];

/// Apple's camera format. macOS can convert it with a tool that ships with the
/// system; elsewhere there is nothing to decode it with.
const APPLE: [&str; 2] = ["heic", "heif"];

pub fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn is_supported(path: &Path) -> bool {
    let extension = extension_of(path);
    WEB_SAFE.contains(&extension.as_str())
        || CONVERTIBLE.contains(&extension.as_str())
        || APPLE.contains(&extension.as_str())
}

/// Every extension the file pickers should offer.
pub fn supported_extensions() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = WEB_SAFE.to_vec();
    all.extend_from_slice(&CONVERTIBLE);
    all.extend_from_slice(&APPLE);
    all
}

/// The bytes to store, and the extension to store them under.
pub fn load(path: &Path) -> Result<(Vec<u8>, &'static str)> {
    let extension = extension_of(path);

    if let Some(matched) = WEB_SAFE.iter().find(|candidate| **candidate == extension) {
        return Ok((std::fs::read(path)?, matched));
    }

    if CONVERTIBLE.contains(&extension.as_str()) {
        let decoded = image::open(path).map_err(|err| {
            AppError::msg(format!("that {extension} file could not be read ({err})"))
        })?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        decoded
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|err| AppError::msg(format!("that image could not be converted ({err})")))?;
        return Ok((bytes.into_inner(), "png"));
    }

    if APPLE.contains(&extension.as_str()) {
        return load_heic(path);
    }

    Err(AppError::msg(format!(
        "{} is not an image LyricVerse can show — try PNG, JPEG or WebP",
        if extension.is_empty() { "that file".into() } else { format!(".{extension}") }
    )))
}

#[cfg(target_os = "macos")]
fn load_heic(path: &Path) -> Result<(Vec<u8>, &'static str)> {
    // `sips` ships with macOS and is the only decoder available without
    // pulling in libheif. Photos taken on an iPhone are HEIC by default, so
    // this is a common enough case to be worth handling.
    let temp = std::env::temp_dir().join(format!(
        "lyricverse-heic-{}.png",
        std::process::id()
    ));
    let status = std::process::Command::new("sips")
        .args(["-s", "format", "png"])
        .arg(path)
        .arg("--out")
        .arg(&temp)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|err| AppError::msg(format!("could not convert that HEIC image ({err})")))?;

    if !status.success() || !temp.exists() {
        return Err(AppError::msg("that HEIC image could not be converted"));
    }
    let bytes = std::fs::read(&temp)?;
    let _ = std::fs::remove_file(&temp);
    Ok((bytes, "png"))
}

#[cfg(not(target_os = "macos"))]
fn load_heic(_path: &Path) -> Result<(Vec<u8>, &'static str)> {
    Err(AppError::msg(
        "HEIC images can only be imported on macOS — export the photo as JPEG or PNG first",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn recognises_the_formats_people_actually_have() {
        for name in ["a.png", "b.JPG", "c.jpeg", "d.webp", "e.gif", "f.tiff", "g.heic"] {
            assert!(is_supported(&PathBuf::from(name)), "{name} was rejected");
        }
        for name in ["notes.txt", "deck.pptx", "clip.mp4", "noextension"] {
            assert!(!is_supported(&PathBuf::from(name)), "{name} was accepted");
        }
    }

    #[test]
    fn web_safe_files_are_passed_through_untouched() {
        let dir = std::env::temp_dir().join("lyricverse-image-passthrough");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.png");
        // Not a real PNG — pass-through must not try to decode it.
        std::fs::write(&path, b"raw bytes").unwrap();

        let (bytes, extension) = load(&path).unwrap();
        assert_eq!(extension, "png");
        assert_eq!(bytes, b"raw bytes");
    }

    #[test]
    fn an_unknown_format_explains_itself() {
        let error = load(&PathBuf::from("/tmp/whatever.xyz")).unwrap_err().to_string();
        assert!(error.contains(".xyz"), "unhelpful message: {error}");
    }
}
