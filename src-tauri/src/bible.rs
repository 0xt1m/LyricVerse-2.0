//! MyBible (`.SQLite3`) reader.
//!
//! Two things v1 got wrong are fixed structurally here:
//!
//! * It wrote a `verses_search` table **into the translation file** on first
//!   open, mutating a read-only asset and taking minutes on a cold start. This
//!   module never writes to a translation; the normalised index lives in RAM.
//! * Its full-text search scanned every verse on every keystroke and returned
//!   only the first hit. Here the normalised text is computed once per
//!   translation and searches return a ranked list.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths::{safe_child, slugify_filename, unique_path};
use crate::text;

const MANIFEST: &str = "translations.json";
/// v1's manifest name, still read so an upgrade finds existing translations.
const LEGACY_MANIFEST: &str = "bible_translations.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationMeta {
    pub name: String,
    pub filename: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    pub number: i64,
    pub short_name: String,
    pub long_name: String,
    pub color: String,
    pub chapters: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerseRow {
    pub book: i64,
    pub chapter: i64,
    pub verse: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub book: i64,
    pub book_name: String,
    pub chapter: i64,
    pub verse: i64,
    pub text: String,
    pub reference: String,
    /// Character offsets of the match within `text`, for highlighting.
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub book: i64,
    pub chapter: i64,
    pub verse: i64,
    /// Inclusive end of a verse range; equals `verse` for a single verse.
    pub end_verse: i64,
}

// --- Loaded translation ---------------------------------------------------

pub struct Translation {
    books: Vec<BookInfo>,
    book_by_number: HashMap<i64, usize>,
    /// book -> ordered chapter numbers actually present in the file.
    chapters: BTreeMap<i64, Vec<i64>>,
    verses: Vec<VerseRow>,
    /// Row ranges keyed by (book, chapter), so verse lookup never scans.
    ranges: HashMap<(i64, i64), (usize, usize)>,
    normalized: Vec<String>,
}

impl Translation {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Err(AppError::msg(format!("translation file is missing: {}", path.display())));
        }
        let conn = Connection::open(path)?;

        let mut books: Vec<(i64, String, String, String)> = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT book_number, short_name, long_name, book_color FROM books ORDER BY book_number")
                .map_err(|_| {
                    AppError::msg("that file has no `books` table — it is not a MyBible module")
                })?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ))
            })?;
            for row in rows {
                books.push(row?);
            }
        }

        let mut verses = Vec::new();
        let mut normalized = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT book_number, chapter, verse, text FROM verses ORDER BY book_number, chapter, verse")
                .map_err(|_| {
                    AppError::msg("that file has no `verses` table — it is not a MyBible module")
                })?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ))
            })?;
            for row in rows {
                let (book, chapter, verse, raw) = row?;
                // Most verses carry no markup; skipping the regex pass for
                // those cuts translation load time roughly in half.
                let clean = if raw.contains('<') { text::strip_markup(&raw) } else { raw };
                normalized.push(text::normalize(&clean));
                verses.push(VerseRow { book, chapter, verse, text: clean });
            }
        }

        let mut chapters: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
        let mut ranges: HashMap<(i64, i64), (usize, usize)> = HashMap::new();
        for (index, row) in verses.iter().enumerate() {
            let key = (row.book, row.chapter);
            ranges
                .entry(key)
                .and_modify(|range| range.1 = index + 1)
                .or_insert((index, index + 1));
            let list = chapters.entry(row.book).or_default();
            if list.last() != Some(&row.chapter) {
                list.push(row.chapter);
            }
        }

        // A translation may ship books in `books` that have no verses (or the
        // other way round); only expose what can actually be shown.
        let mut book_infos = Vec::new();
        let mut book_by_number = HashMap::new();
        for (number, short_name, long_name, color) in books {
            let count = chapters.get(&number).map(Vec::len).unwrap_or(0);
            if count == 0 {
                continue;
            }
            book_by_number.insert(number, book_infos.len());
            book_infos.push(BookInfo {
                number,
                short_name: short_name.trim().to_string(),
                long_name: if long_name.trim().is_empty() {
                    short_name.trim().to_string()
                } else {
                    long_name.trim().to_string()
                },
                color,
                chapters: count,
            });
        }

        if book_infos.is_empty() {
            return Err(AppError::msg("that translation contains no readable books"));
        }

        Ok(Self {
            books: book_infos,
            book_by_number,
            chapters,
            verses,
            ranges,
            normalized,
        })
    }

    pub fn books(&self) -> &[BookInfo] {
        &self.books
    }

    pub fn book(&self, number: i64) -> Option<&BookInfo> {
        self.book_by_number.get(&number).and_then(|i| self.books.get(*i))
    }

    /// The chapter numbers present, in order. v1 returned
    /// `len(set(chapters))` and rendered `1..=n`, which silently mislabelled
    /// every chapter in a book with a gap.
    pub fn chapters(&self, book: i64) -> Vec<i64> {
        self.chapters.get(&book).cloned().unwrap_or_default()
    }

    pub fn verses(&self, book: i64, chapter: i64) -> &[VerseRow] {
        match self.ranges.get(&(book, chapter)) {
            Some(&(start, end)) => &self.verses[start..end],
            None => &[],
        }
    }

    /// Formats "Івана 3:16" / "Івана 3:16-18" the way it appears on screen.
    pub fn reference_label(&self, reference: &Reference) -> String {
        let name = self
            .book(reference.book)
            .map(|b| b.long_name.clone())
            .unwrap_or_else(|| reference.book.to_string());
        if reference.end_verse > reference.verse {
            format!("{name} {}:{}-{}", reference.chapter, reference.verse, reference.end_verse)
        } else {
            format!("{name} {}:{}", reference.chapter, reference.verse)
        }
    }

    /// Joins a verse range into the block of text that goes on screen.
    pub fn passage_text(&self, reference: &Reference) -> String {
        let verses = self.verses(reference.book, reference.chapter);
        verses
            .iter()
            .filter(|v| v.verse >= reference.verse && v.verse <= reference.end_verse)
            .map(|v| v.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let needle = text::normalize(query);
        if needle.len() < 2 {
            return Vec::new();
        }

        let mut hits = Vec::new();
        for (index, haystack) in self.normalized.iter().enumerate() {
            let Some(offset) = haystack.find(&needle) else { continue };
            let Some(row) = self.verses.get(index) else { continue };

            // `find` gives a byte offset in normalised space; the map is by
            // character, so convert before looking the position up.
            let normalized_char_start = haystack[..offset].chars().count();
            let (_, map) = text::normalize_with_map(&row.text);
            let match_start = map.get(normalized_char_start).copied().unwrap_or(0);
            let needle_chars = needle.chars().count();
            let match_end = map
                .get(normalized_char_start + needle_chars - 1)
                .map(|i| i + 1)
                .unwrap_or(match_start);

            hits.push(SearchHit {
                book: row.book,
                book_name: self
                    .book(row.book)
                    .map(|b| b.long_name.clone())
                    .unwrap_or_default(),
                chapter: row.chapter,
                verse: row.verse,
                text: row.text.clone(),
                reference: format!(
                    "{} {}:{}",
                    self.book(row.book).map(|b| b.short_name.as_str()).unwrap_or(""),
                    row.chapter,
                    row.verse
                ),
                match_start,
                match_end,
            });

            if hits.len() >= limit {
                break;
            }
        }
        hits
    }

    /// Resolves "мт 10 10", "1 ів 2:3-5", "Іван 3:16" or just "буття".
    pub fn resolve(&self, query: &str) -> Option<Reference> {
        let query = query.trim();
        if query.is_empty() {
            return None;
        }
        let (book_part, number_part) = split_book_and_numbers(query);
        let book = self.match_book(&book_part)?;

        let numbers: Vec<i64> = number_part
            .split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect();

        let chapters = self.chapters(book);
        let chapter = numbers
            .first()
            .copied()
            .filter(|c| chapters.contains(c))
            .or_else(|| chapters.first().copied())?;

        let available = self.verses(book, chapter);
        let first_verse = available.first().map(|v| v.verse).unwrap_or(1);
        let last_verse = available.last().map(|v| v.verse).unwrap_or(1);

        let verse = numbers
            .get(1)
            .copied()
            .unwrap_or(first_verse)
            .clamp(first_verse, last_verse);

        // A third number is only a range end when a dash actually separated it.
        let end_verse = if number_part.contains('-') {
            numbers.get(2).copied().unwrap_or(verse).clamp(verse, last_verse)
        } else {
            verse
        };

        Some(Reference { book, chapter, verse, end_verse })
    }

    /// Scores every book name against the query and returns the best match.
    pub fn match_book(&self, query: &str) -> Option<i64> {
        let needle = text::normalize(query);
        if needle.is_empty() {
            return None;
        }
        // Operators type "1Ів", "1 ів" and "1 Івана" interchangeably, while
        // modules name the same book "1Ів" / "1-е Iвана". Compare the spaced
        // form, the space-free form, and finally token-by-token.
        let needle_tight = needle.replace(' ', "");
        let needle_tokens: Vec<&str> = needle.split(' ').filter(|s| !s.is_empty()).collect();
        let mut best: Option<(u8, usize, i64)> = None;

        for book in &self.books {
            for candidate in book_aliases(book) {
                let mut score = match_score(&candidate, &needle).max(match_score(&candidate, &needle_tight));
                if score == 0 && token_prefix_subsequence(&candidate, &needle_tokens) {
                    score = 2;
                }
                if score == 0 && char_subsequence(&candidate, &needle_tight) {
                    score = 1;
                }
                if score == 0 {
                    continue;
                }
                let length = candidate.chars().count();
                // Higher score wins; on a tie the shorter name wins so "ів"
                // prefers "Іван" over "Івана Богослова Об'явлення".
                let better = match best {
                    None => true,
                    Some((best_score, best_len, _)) => {
                        score > best_score || (score == best_score && length < best_len)
                    }
                };
                if better {
                    best = Some((score, length, book.number));
                }
            }
        }
        best.map(|(_, _, number)| number)
    }
}

/// 0 = no match, 3 = substring, 4 = prefix, 5 = exact. Lower tiers (1–2) are
/// assigned by the fuzzy fallbacks in `match_book`.
fn match_score(candidate: &str, needle: &str) -> u8 {
    if candidate.is_empty() {
        0
    } else if candidate == needle {
        5
    } else if candidate.starts_with(needle) {
        4
    } else if candidate.contains(needle) {
        3
    } else {
        0
    }
}

/// Consonant-skeleton abbreviations: "rm" → Romans, "flp" → Philippians.
///
/// Requiring the first character to line up is what keeps this useful rather
/// than chaotic — without it "rm" is also a subsequence of "Jeremiah".
fn char_subsequence(candidate: &str, needle: &str) -> bool {
    let mut needle_chars = needle.chars();
    let Some(first_needle) = needle_chars.next() else { return false };
    let mut candidate_chars = candidate.chars();
    if candidate_chars.next() != Some(first_needle) {
        return false;
    }
    for wanted in needle_chars {
        if !candidate_chars.any(|ch| ch == wanted) {
            return false;
        }
    }
    true
}

/// True when each needle token is a prefix of a distinct candidate token, in
/// order — so "1 івана" still finds a book named "1-е Iвана".
fn token_prefix_subsequence(candidate: &str, needle_tokens: &[&str]) -> bool {
    if needle_tokens.is_empty() {
        return false;
    }
    let mut tokens = candidate.split(' ').filter(|token| !token.is_empty());
    'needle: for needle in needle_tokens {
        for token in tokens.by_ref() {
            if token.starts_with(needle) {
                continue 'needle;
            }
        }
        return false;
    }
    true
}

fn book_aliases(book: &BookInfo) -> Vec<String> {
    let long = text::normalize(&book.long_name);
    let short = text::normalize(&book.short_name);
    // "1 М." and "1М" should both find Genesis.
    let short_tight = short.replace(' ', "");
    let long_tight = long.replace(' ', "");
    let mut out = vec![long, short, short_tight, long_tight];
    out.retain(|s| !s.is_empty());
    out.dedup();
    out
}

/// Splits "1 ів 2:3-5" into ("1 ів", "2:3-5") by walking back from the end
/// over the characters that can only belong to a chapter/verse expression.
fn split_book_and_numbers(query: &str) -> (String, String) {
    let chars: Vec<char> = query.chars().collect();
    let mut boundary = chars.len();
    while boundary > 0 {
        let ch = chars[boundary - 1];
        if ch.is_ascii_digit() || matches!(ch, ':' | '.' | '-' | ',' | ' ' | '\u{2013}') {
            boundary -= 1;
        } else {
            break;
        }
    }
    let book: String = chars[..boundary].iter().collect();
    let numbers: String = chars[boundary..].iter().collect();
    // "3 ів" — the leading ordinal is part of the name, not a chapter.
    (book.trim().to_string(), numbers.trim().to_string())
}

// --- Translation manifest -------------------------------------------------

type Manifest = BTreeMap<String, ManifestEntry>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestEntry {
    filename: String,
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST)
}

fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = manifest_path(dir);
    let legacy = dir.join(LEGACY_MANIFEST);
    let source = if path.exists() {
        path
    } else if legacy.exists() {
        legacy
    } else {
        return Ok(Manifest::new());
    };
    let raw = fs::read_to_string(&source)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<()> {
    let path = manifest_path(dir);
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_string_pretty(manifest)?)?;
    fs::rename(&temp, &path)?;
    Ok(())
}

pub fn ensure_manifest(dir: &Path) -> Result<()> {
    crate::paths::ensure_dir(dir)?;
    if !manifest_path(dir).exists() {
        let existing = read_manifest(dir)?;
        write_manifest(dir, &existing)?;
    }
    Ok(())
}

pub fn list(dir: &Path) -> Result<Vec<TranslationMeta>> {
    let manifest = read_manifest(dir)?;
    Ok(manifest
        .into_iter()
        .map(|(name, entry)| {
            let error = match safe_child(dir, &entry.filename) {
                Ok(path) if path.exists() => None,
                Ok(path) => Some(format!("file not found: {}", path.display())),
                Err(err) => Some(err.to_string()),
            };
            TranslationMeta { name, filename: entry.filename, error }
        })
        .collect())
}

pub fn path_of(dir: &Path, name: &str) -> Result<PathBuf> {
    let manifest = read_manifest(dir)?;
    let entry = manifest
        .get(name)
        .ok_or_else(|| AppError::msg(format!("translation \"{name}\" is not registered")))?;
    safe_child(dir, &entry.filename)
}

pub fn import(dir: &Path, source: &Path, requested_name: Option<&str>) -> Result<TranslationMeta> {
    if !source.exists() {
        return Err(AppError::msg(format!("{} does not exist", source.display())));
    }
    // Validate before copying so a bad file never lands in the library.
    Translation::load(source)?;

    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("translation");
    let name = requested_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(stem)
        .to_string();

    let mut manifest = read_manifest(dir)?;
    if manifest.contains_key(&name) {
        return Err(AppError::msg(format!("a translation named \"{name}\" already exists")));
    }

    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("SQLite3")
        .to_string();
    let target = unique_path(dir, &slugify_filename(&name), &extension);
    fs::copy(source, &target)?;

    let filename = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::msg("could not determine the translation file name"))?
        .to_string();
    manifest.insert(name.clone(), ManifestEntry { filename: filename.clone() });
    write_manifest(dir, &manifest)?;

    Ok(TranslationMeta { name, filename, error: None })
}

pub fn remove(dir: &Path, name: &str, delete_file: bool) -> Result<()> {
    let mut manifest = read_manifest(dir)?;
    let entry = manifest
        .remove(name)
        .ok_or_else(|| AppError::msg(format!("translation \"{name}\" is not registered")))?;
    write_manifest(dir, &manifest)?;

    if delete_file {
        let path = safe_child(dir, &entry.filename)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// Registers MyBible files that were copied into the folder by hand.
pub fn adopt_orphans(dir: &Path) -> Result<()> {
    let mut manifest = read_manifest(dir)?;
    let known: std::collections::HashSet<String> =
        manifest.values().map(|e| e.filename.clone()).collect();
    let mut changed = false;

    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if !path.is_file() {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else { continue };
        let lower = filename.to_ascii_lowercase();
        if !(lower.ends_with(".sqlite3") || lower.ends_with(".sqlite")) || known.contains(filename) {
            continue;
        }
        let mut name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename)
            .to_string();
        let base = name.clone();
        let mut counter = 2;
        while manifest.contains_key(&name) {
            name = format!("{base} ({counter})");
            counter += 1;
        }
        manifest.insert(name, ManifestEntry { filename: filename.to_string() });
        changed = true;
    }

    if changed {
        write_manifest(dir, &manifest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_leading_ordinal_into_the_book_name() {
        assert_eq!(split_book_and_numbers("1 ів 2:3-5"), ("1 ів".into(), "2:3-5".into()));
        assert_eq!(split_book_and_numbers("мт 10 10"), ("мт".into(), "10 10".into()));
        assert_eq!(split_book_and_numbers("3 ів"), ("3 ів".into(), "".into()));
        assert_eq!(split_book_and_numbers("буття"), ("буття".into(), "".into()));
    }

    #[test]
    fn scores_exact_over_prefix_over_substring() {
        assert_eq!(match_score("іван", "іван"), 5);
        assert_eq!(match_score("іван", "ів"), 4);
        assert_eq!(match_score("від івана", "івана"), 3);
        assert_eq!(match_score("іван", "марк"), 0);
    }

    #[test]
    fn abbreviations_match_by_skipped_letters() {
        // "rm" -> Romans, typed the way an operator abbreviates.
        assert!(char_subsequence("romans", "rm"));
        assert!(char_subsequence("римлян", "рмл"));
        // Anchoring on the first letter keeps "rm" out of "jeremiah".
        assert!(!char_subsequence("jeremiah", "rm"));
        assert!(!char_subsequence("romans", "rz"));
    }

    #[test]
    fn token_matching_survives_ordinal_book_names() {
        assert!(token_prefix_subsequence("1 е івана", &["1", "івана"]));
        assert!(!token_prefix_subsequence("1 е івана", &["2", "івана"]));
    }
}
