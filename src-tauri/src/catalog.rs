//! Bible translations offered for download from lyricverse.app.
//!
//! Nothing here is required for the app to work: the catalogue is a
//! convenience so a congregation setting up a new machine does not have to go
//! and find a MyBible module on the internet first. Every failure — no
//! network in the hall, the site down, a file that turns out not to be a
//! module — is reported and changes nothing on disk.
//!
//! ## What the site has to serve
//!
//! `https://lyricverse.app/translations.json`:
//!
//! ```json
//! {
//!   "translations": [
//!     {
//!       "name": "King James Version",
//!       "language": "en",
//!       "description": "Public domain",
//!       "url": "https://lyricverse.app/translations/KJV.SQLite3",
//!       "bytes": 5242880,
//!       "sha256": "optional, lower-case hex"
//!     }
//!   ]
//! }
//! ```
//!
//! `name` is what the translation is called in the app, `url` may be absolute
//! or relative to the catalogue, and everything but `name` and `url` is
//! optional. Only the text a congregation is licensed to redistribute belongs
//! there — the same rule as the library shipped inside the app.

use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::bible::{self, TranslationMeta};
use crate::error::{AppError, Result};

pub const CATALOG_URL: &str = "https://lyricverse.app/translations.json";
/// Progress while a module is coming down, so a 30 MB file on a hall's wi-fi
/// is not a button that appears to have done nothing.
pub const EVENT_PROGRESS: &str = "lyricverse://download";

/// Long enough for a slow hall connection to answer, short enough that a dead
/// host does not leave somebody staring at a spinner before a service.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(20);
/// A module is tens of megabytes; the limit is on stalling, not on size.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// Refused rather than streamed to disk. Every module worth having is far
/// under this, and without a ceiling a wrong URL could fill the disk.
const MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTranslation {
    /// What it will be called in the library.
    pub name: String,
    /// ISO code, for grouping the list. Absent is fine.
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub description: String,
    pub url: String,
    /// Uncompressed size, only ever used to tell somebody what they are about
    /// to download.
    #[serde(default)]
    pub bytes: u64,
    /// Lower-case hex. Checked when present; the transport is already HTTPS,
    /// so this is about a truncated or swapped file rather than an attacker.
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    #[serde(default)]
    translations: Vec<RemoteTranslation>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    name: String,
    received: u64,
    /// Zero when the server did not say how long the file is.
    total: u64,
}

fn client(timeout: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(concat!("LyricVerse/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| AppError::msg(format!("could not start a download: {error}")))
}

/// What the site is offering today.
pub async fn list() -> Result<Vec<RemoteTranslation>> {
    let response = client(CATALOG_TIMEOUT)?
        .get(CATALOG_URL)
        .send()
        .await
        .map_err(offline)?
        .error_for_status()
        .map_err(|error| AppError::msg(format!("lyricverse.app answered: {error}")))?;

    let catalog: Catalog = response
        .json()
        .await
        .map_err(|error| AppError::msg(format!("the list of translations is unreadable: {error}")))?;

    Ok(catalog
        .translations
        .into_iter()
        .filter(|item| !item.name.trim().is_empty() && !item.url.trim().is_empty())
        .collect())
}

/// Fetches one module and puts it in the library.
///
/// It lands in a temporary file first and is only imported once it is whole:
/// a download that dies half way through must not leave a truncated database
/// registered as a translation, which is the kind of thing that is discovered
/// on a Sunday morning.
pub async fn download(app: &AppHandle, entry: &RemoteTranslation) -> Result<TranslationMeta> {
    let dir = crate::paths::translations_dir(app)?;
    let url = absolute_url(&entry.url)?;

    let response = client(DOWNLOAD_TIMEOUT)?
        .get(url.clone())
        .send()
        .await
        .map_err(offline)?
        .error_for_status()
        .map_err(|error| AppError::msg(format!("{} could not be fetched: {error}", entry.name)))?;

    let total = response.content_length().unwrap_or(entry.bytes);
    if total > MAX_BYTES {
        return Err(AppError::msg(format!(
            "{} is {} MB, which is not a Bible module",
            entry.name,
            total / (1024 * 1024)
        )));
    }

    // Alongside the library rather than in the system temp folder: the module
    // is about to be copied into this directory anyway, and a temp file on a
    // different volume would make that copy a slow one.
    let temp = dir.join(format!(".download-{}.part", std::process::id()));
    let outcome = stream_to_file(app, response, &temp, &entry.name, total).await;
    let result = outcome.and_then(|()| {
        verify(&temp, entry.sha256.as_deref())?;
        // `import` validates the file as a MyBible module before it copies,
        // so a 404 page saved under a .SQLite3 name is refused here.
        bible::import(&dir, &temp, Some(&entry.name))
    });

    // Whatever happened, the part-file goes.
    let _ = std::fs::remove_file(&temp);
    result
}

async fn stream_to_file(
    app: &AppHandle,
    response: reqwest::Response,
    temp: &Path,
    name: &str,
    total: u64,
) -> Result<()> {
    use std::io::Write;

    let mut file = std::fs::File::create(temp)?;
    let mut received: u64 = 0;
    let mut stream = response.bytes_stream();
    // Every chunk would be hundreds of events for one file; a tick every
    // half-megabyte is smooth enough to watch and cheap enough to ignore.
    let mut announced: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| AppError::msg(format!("the download stopped: {error}")))?;
        received += chunk.len() as u64;
        if received > MAX_BYTES {
            return Err(AppError::msg("the file is larger than any Bible module"));
        }
        file.write_all(&chunk)?;
        if received - announced >= 512 * 1024 {
            announced = received;
            let _ = app.emit(
                EVENT_PROGRESS,
                Progress { name: name.to_string(), received, total },
            );
        }
    }
    file.flush()?;
    let _ = app.emit(EVENT_PROGRESS, Progress { name: name.to_string(), received, total });
    Ok(())
}

/// Checks the file against the checksum the catalogue gave, when it gave one.
fn verify(path: &Path, expected: Option<&str>) -> Result<()> {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(AppError::msg(
            "the downloaded file does not match its checksum — it arrived damaged",
        ));
    }
    Ok(())
}

/// Resolves a catalogue entry's URL, which may be relative to the catalogue
/// itself, and refuses anything that is not HTTPS.
fn absolute_url(raw: &str) -> Result<reqwest::Url> {
    let base = reqwest::Url::parse(CATALOG_URL)
        .map_err(|_| AppError::msg("the catalogue address is not a URL"))?;
    let url = base
        .join(raw.trim())
        .map_err(|_| AppError::msg(format!("\"{raw}\" is not a usable address")))?;
    if url.scheme() != "https" {
        return Err(AppError::msg("translations are only downloaded over https"));
    }
    Ok(url)
}

/// The common case by a wide margin, and worth saying plainly: a hall with no
/// internet is not a fault anybody needs a stack trace for.
fn offline(error: reqwest::Error) -> AppError {
    if error.is_connect() || error.is_timeout() {
        return AppError::msg("could not reach lyricverse.app — check the internet connection");
    }
    AppError::msg(format!("could not reach lyricverse.app: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_and_relative_urls_resolve_against_the_catalogue() {
        assert_eq!(
            absolute_url("translations/KJV.SQLite3").unwrap().as_str(),
            "https://lyricverse.app/translations/KJV.SQLite3"
        );
        assert_eq!(
            absolute_url("https://lyricverse.app/x.SQLite3").unwrap().as_str(),
            "https://lyricverse.app/x.SQLite3"
        );
        // Plain http would be a module nobody can vouch for, and `file:` would
        // read the machine's own disk on the site's say-so.
        assert!(absolute_url("http://lyricverse.app/x.SQLite3").is_err());
        assert!(absolute_url("file:///etc/passwd").is_err());
    }

    /// Proves the TLS stack actually works — that the crypto provider is
    /// installed and the root certificates resolve — rather than only that
    /// the code compiles.
    ///
    /// `#[ignore]` because it needs the internet: run it with
    /// `cargo test -- --ignored` when touching anything in this file.
    #[tokio::test]
    #[ignore]
    async fn reaches_the_site_over_tls() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let response = client(CATALOG_TIMEOUT)
            .unwrap()
            .get("https://lyricverse.app/")
            .send()
            .await
            .expect("lyricverse.app is reachable over https");
        assert!(response.status().is_success());
    }
}
