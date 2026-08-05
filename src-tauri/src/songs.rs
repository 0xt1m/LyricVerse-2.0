//! Songbook storage.
//!
//! A songbook is a SQLite file with a `Songs(id, title, song_text)` table —
//! the same shape LyricVerse 1.x used, so existing books open unchanged.
//!
//! `song_text` is JSON. v1 wrote `{Couplets, Chorus, Bridges}`, which could
//! only express "chorus after every verse" and addressed bridges by a position
//! in the *rendered* list. v2 writes an explicit `sections` list plus an
//! `order` of section ids, and keeps the v1 keys alongside it so a v1 install
//! reading the same file still works.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, Result};
use crate::paths::{self, safe_child, slugify_filename, unique_path};
use crate::text;

const MANIFEST: &str = "songbooks.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SectionKind {
    Verse,
    Chorus,
    Bridge,
    /// Pre-chorus, tag, ending, intro — anything the operator labels freely.
    Other,
}

impl SectionKind {
    fn prefix(self) -> &'static str {
        match self {
            SectionKind::Verse => "v",
            SectionKind::Chorus => "c",
            SectionKind::Bridge => "b",
            SectionKind::Other => "s",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub kind: SectionKind,
    /// Optional operator-facing label, e.g. "Приспів 2".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: i64,
    pub title: String,
    pub sections: Vec<Section>,
    /// Section ids in performance order; a section may repeat.
    pub order: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongSummary {
    pub id: i64,
    pub title: String,
    pub first_line: String,
    pub section_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongbookMeta {
    pub name: String,
    pub filename: String,
    pub song_count: i64,
    /// Set when the file is missing or unreadable, so the UI can say why.
    pub error: Option<String>,
}

// --- Manifest -------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestEntry {
    filename: String,
}

type Manifest = BTreeMap<String, ManifestEntry>;

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST)
}

fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = manifest_path(dir);
    if !path.exists() {
        return Ok(Manifest::new());
    }
    let raw = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<()> {
    let path = manifest_path(dir);
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_string_pretty(manifest)?)?;
    fs::rename(&temp, &path)?;
    Ok(())
}

fn resolve(dir: &Path, name: &str) -> Result<PathBuf> {
    let manifest = read_manifest(dir)?;
    let entry = manifest
        .get(name)
        .ok_or_else(|| AppError::msg(format!("songbook \"{name}\" is not registered")))?;
    safe_child(dir, &entry.filename)
}

fn open(dir: &Path, name: &str) -> Result<Connection> {
    let path = resolve(dir, name)?;
    if !path.exists() {
        return Err(AppError::msg(format!(
            "songbook file for \"{name}\" is missing ({})",
            path.display()
        )));
    }
    let conn = Connection::open(&path)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS Songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            song_text TEXT NOT NULL
        );",
    )?;
    Ok(())
}

// --- Public API -----------------------------------------------------------

pub fn list(dir: &Path) -> Result<Vec<SongbookMeta>> {
    let manifest = read_manifest(dir)?;
    let mut out = Vec::with_capacity(manifest.len());

    for (name, entry) in manifest {
        let mut meta = SongbookMeta {
            name: name.clone(),
            filename: entry.filename.clone(),
            song_count: 0,
            error: None,
        };
        match safe_child(dir, &entry.filename) {
            Ok(path) if path.exists() => match count_songs(&path) {
                Ok(count) => meta.song_count = count,
                Err(err) => meta.error = Some(err.to_string()),
            },
            Ok(path) => meta.error = Some(format!("file not found: {}", path.display())),
            Err(err) => meta.error = Some(err.to_string()),
        }
        out.push(meta);
    }
    Ok(out)
}

fn count_songs(path: &Path) -> Result<i64> {
    let conn = Connection::open(path)?;
    ensure_schema(&conn)?;
    Ok(conn.query_row("SELECT COUNT(*) FROM Songs", [], |row| row.get(0))?)
}

pub fn songs(dir: &Path, book: &str) -> Result<Vec<SongSummary>> {
    let conn = open(dir, book)?;
    let mut stmt = conn.prepare("SELECT id, title, song_text FROM Songs ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (id, title, raw) = row?;
        let (sections, order) = parse_song_text(&raw);
        let first_line = order
            .first()
            .and_then(|id| sections.iter().find(|s| &s.id == id))
            .or_else(|| sections.first())
            .map(|s| text::first_line(&s.text))
            .unwrap_or_default();
        out.push(SongSummary {
            title: display_title(&title, &sections, &order, id),
            id,
            first_line,
            section_count: sections.len(),
        });
    }
    Ok(out)
}

/// Some imported books contain songs whose `title` column is empty — v1's text
/// importer took `line.split(".")[1]` for the title and produced at least one
/// blank in the shipped `ps_us.db`. A blank row is unfindable, so fall back to
/// the opening line rather than showing nothing.
fn display_title(title: &str, sections: &[Section], order: &[String], id: i64) -> String {
    let trimmed = title.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    let opening = order
        .first()
        .and_then(|section_id| sections.iter().find(|s| &s.id == section_id))
        .or_else(|| sections.first())
        .map(|section| text::first_line(&section.text))
        .unwrap_or_default();
    let opening = opening.trim_start_matches(['.', ',', '-', '—', '–', ' ']).trim();
    if opening.is_empty() {
        format!("#{id}")
    } else {
        opening.chars().take(60).collect()
    }
}

pub fn get(dir: &Path, book: &str, id: i64) -> Result<Song> {
    let conn = open(dir, book)?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT title, song_text FROM Songs WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let (title, raw) =
        row.ok_or_else(|| AppError::msg(format!("song #{id} is not in \"{book}\"")))?;
    let (sections, order) = parse_song_text(&raw);
    Ok(Song { title: display_title(&title, &sections, &order, id), id, sections, order })
}

/// Inserts when `song.id <= 0`, updates otherwise. Returns the stored id.
///
/// v1 built this statement with an f-string, so any title containing an
/// apostrophe — common in Ukrainian — either corrupted the row or failed
/// outright. Everything here is a bound parameter.
pub fn save(dir: &Path, book: &str, song: &Song) -> Result<i64> {
    let title = song.title.trim();
    if title.is_empty() {
        return Err(AppError::msg("a song needs a title"));
    }
    let (sections, order) = sanitize(&song.sections, &song.order);
    if order.is_empty() {
        return Err(AppError::msg("a song needs at least one section"));
    }

    let conn = open(dir, book)?;
    let payload = serialize_song_text(&sections, &order)?;

    if song.id > 0 {
        let changed = conn.execute(
            "UPDATE Songs SET title = ?1, song_text = ?2 WHERE id = ?3",
            params![title, payload, song.id],
        )?;
        if changed == 0 {
            return Err(AppError::msg(format!("song #{} no longer exists", song.id)));
        }
        Ok(song.id)
    } else {
        conn.execute(
            "INSERT INTO Songs (title, song_text) VALUES (?1, ?2)",
            params![title, payload],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn delete(dir: &Path, book: &str, id: i64) -> Result<()> {
    let conn = open(dir, book)?;
    let changed = conn.execute("DELETE FROM Songs WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::msg(format!("song #{id} no longer exists")));
    }
    Ok(())
}

pub fn create(dir: &Path, name: &str) -> Result<SongbookMeta> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("a songbook needs a name"));
    }
    let mut manifest = read_manifest(dir)?;
    if manifest.contains_key(name) {
        return Err(AppError::msg(format!("a songbook named \"{name}\" already exists")));
    }

    let path = unique_path(dir, &slugify_filename(name), "db");
    let conn = Connection::open(&path)?;
    ensure_schema(&conn)?;
    drop(conn);

    let filename = file_name_of(&path)?;
    manifest.insert(name.to_string(), ManifestEntry { filename: filename.clone() });
    write_manifest(dir, &manifest)?;

    Ok(SongbookMeta { name: name.to_string(), filename, song_count: 0, error: None })
}

pub fn rename(dir: &Path, from: &str, to: &str) -> Result<()> {
    let to = to.trim();
    if to.is_empty() {
        return Err(AppError::msg("a songbook needs a name"));
    }
    let mut manifest = read_manifest(dir)?;
    if from != to && manifest.contains_key(to) {
        return Err(AppError::msg(format!("a songbook named \"{to}\" already exists")));
    }
    let entry = manifest
        .remove(from)
        .ok_or_else(|| AppError::msg(format!("songbook \"{from}\" is not registered")))?;
    manifest.insert(to.to_string(), entry);
    write_manifest(dir, &manifest)
}

/// Unregisters a songbook. `delete_file` also removes the `.db` from disk —
/// the UI only sets it after an explicit, separately-worded confirmation.
pub fn remove(dir: &Path, name: &str, delete_file: bool) -> Result<()> {
    let mut manifest = read_manifest(dir)?;
    let entry = manifest
        .remove(name)
        .ok_or_else(|| AppError::msg(format!("songbook \"{name}\" is not registered")))?;
    write_manifest(dir, &manifest)?;

    if delete_file {
        let path = safe_child(dir, &entry.filename)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// Copies an external songbook into the managed folder and registers it.
///
/// Accepts a LyricVerse/`.db` file or a SongPro `.sps` export. v1 advertised
/// `.sps` support but the drop handler set a label and then read an attribute
/// that was only assigned by the file-picker path, so dropping one crashed.
pub fn import(dir: &Path, source: &Path, requested_name: Option<&str>) -> Result<SongbookMeta> {
    if !source.exists() {
        return Err(AppError::msg(format!("{} does not exist", source.display())));
    }
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("songbook")
        .to_string();
    let name = requested_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&stem)
        .to_string();

    let mut manifest = read_manifest(dir)?;
    if manifest.contains_key(&name) {
        return Err(AppError::msg(format!("a songbook named \"{name}\" already exists")));
    }

    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let target = unique_path(dir, &slugify_filename(&name), "db");

    match extension.as_str() {
        "sps" => convert_songpro(source, &target)?,
        _ => {
            verify_songbook(source)?;
            fs::copy(source, &target)?;
            // Older books were created without AUTOINCREMENT / with odd
            // column order; normalising here keeps later writes predictable.
            let conn = Connection::open(&target)?;
            ensure_schema(&conn)?;
        }
    }

    let song_count = count_songs(&target)?;
    let filename = file_name_of(&target)?;
    manifest.insert(name.clone(), ManifestEntry { filename: filename.clone() });
    write_manifest(dir, &manifest)?;

    Ok(SongbookMeta { name, filename, song_count, error: None })
}

fn verify_songbook(path: &Path) -> Result<()> {
    let conn = Connection::open(path)?;
    let ok: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND lower(name)='songs'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !ok {
        return Err(AppError::msg(
            "that file has no Songs table — it is not a LyricVerse songbook",
        ));
    }
    Ok(())
}

/// SongPro `.sps` files keep lyrics as free text in `Songs.song_text`, numbered
/// by `Songs.number`, and frequently contain duplicate numbers.
fn convert_songpro(source: &Path, target: &Path) -> Result<()> {
    let src = Connection::open(source)?;
    let mut stmt = src
        .prepare("SELECT number, title, song_text FROM Songs ORDER BY number")
        .map_err(|_| AppError::msg("that .sps file does not look like a SongPro export"))?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<i64>>(0)?.unwrap_or(0),
            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        ))
    })?;

    let dest = Connection::open(target)?;
    ensure_schema(&dest)?;
    // One transaction: a 750-song book imports in well under a second rather
    // than fsync-ing per row the way v1 did.
    dest.execute_batch("BEGIN")?;

    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let (number, title, body) = row?;
        // v1 de-duplicated with a nested O(n²) scan over the whole table.
        if number > 0 && !seen.insert(number) {
            continue;
        }
        let title = title.trim();
        if title.is_empty() && body.trim().is_empty() {
            continue;
        }
        let (sections, order) = parse_plain_text(&body);
        if order.is_empty() {
            continue;
        }
        let payload = serialize_song_text(&sections, &order)?;
        if number > 0 {
            dest.execute(
                "INSERT INTO Songs (id, title, song_text) VALUES (?1, ?2, ?3)",
                params![number, title, payload],
            )?;
        } else {
            dest.execute(
                "INSERT INTO Songs (title, song_text) VALUES (?1, ?2)",
                params![title, payload],
            )?;
        }
    }
    dest.execute_batch("COMMIT")?;
    Ok(())
}

fn file_name_of(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .ok_or_else(|| AppError::msg("could not determine the songbook file name"))
}

/// Registers any `.db` in the folder that the manifest does not know about.
/// Used after seeding and whenever the user drops files in by hand.
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
        if !filename.to_ascii_lowercase().ends_with(".db") || known.contains(filename) {
            continue;
        }
        if verify_songbook(&path).is_err() {
            continue;
        }
        let mut name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename)
            .to_string();
        let mut counter = 2;
        while manifest.contains_key(&name) {
            name = format!("{} ({counter})", path.file_stem().unwrap().to_string_lossy());
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

pub fn ensure_manifest(dir: &Path) -> Result<()> {
    paths::ensure_dir(dir)?;
    if !manifest_path(dir).exists() {
        write_manifest(dir, &Manifest::new())?;
    }
    Ok(())
}

// --- song_text encoding ---------------------------------------------------

/// Drops empty sections, removes order entries pointing at nothing, and
/// guarantees every section id is unique and non-empty.
fn sanitize(sections: &[Section], order: &[String]) -> (Vec<Section>, Vec<String>) {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut clean = Vec::with_capacity(sections.len());

    for (index, section) in sections.iter().enumerate() {
        // Empty sections are kept. One is a deliberate blank in the running
        // order, and a song being written starts as exactly that — dropping
        // them made it impossible to create a song at all, since the first
        // save had nothing left to store.
        let body = section.text.trim();
        let mut id = section.id.trim().to_string();
        if id.is_empty() || used.contains(&id) {
            id = format!("{}{}", section.kind.prefix(), index + 1);
            let mut counter = index + 1;
            while used.contains(&id) {
                counter += 1;
                id = format!("{}{counter}", section.kind.prefix());
            }
        }
        used.insert(id.clone());
        remap.insert(section.id.clone(), id.clone());
        clean.push(Section {
            id,
            kind: section.kind,
            label: section.label.clone().filter(|l| !l.trim().is_empty()),
            text: body.to_string(),
        });
    }

    let mut clean_order: Vec<String> = order
        .iter()
        .filter_map(|id| remap.get(id).cloned())
        .collect();
    // A section that exists but was never sequenced still belongs in the song.
    for section in &clean {
        if !clean_order.contains(&section.id) {
            clean_order.push(section.id.clone());
        }
    }
    (clean, clean_order)
}

fn serialize_song_text(sections: &[Section], order: &[String]) -> Result<String> {
    let by_id: std::collections::HashMap<&str, &Section> =
        sections.iter().map(|s| (s.id.as_str(), s)).collect();

    // v1-compatible projection: verses in order, the first chorus, and bridges
    // addressed by their index in the rendered list.
    let mut couplets = Vec::new();
    let mut chorus = String::new();
    let mut bridges = Vec::new();
    for (index, id) in order.iter().enumerate() {
        let Some(section) = by_id.get(id.as_str()) else { continue };
        match section.kind {
            SectionKind::Verse | SectionKind::Other => couplets.push(section.text.clone()),
            SectionKind::Chorus => {
                if chorus.is_empty() {
                    chorus = section.text.clone();
                }
            }
            SectionKind::Bridge => {
                bridges.push(json!({ "text": section.text, "index": index }))
            }
        }
    }

    let mut root = Map::new();
    root.insert("Couplets".into(), Value::Array(couplets.into_iter().map(Value::String).collect()));
    root.insert("Chorus".into(), Value::String(chorus));
    root.insert("Bridges".into(), Value::Array(bridges));
    root.insert(
        "v2".into(),
        json!({ "sections": sections, "order": order }),
    );

    Ok(serde_json::to_string_pretty(&Value::Object(root))?)
}

fn parse_song_text(raw: &str) -> (Vec<Section>, Vec<String>) {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(root)) => {
            if let Some(v2) = root.get("v2") {
                if let Some(parsed) = parse_v2(v2) {
                    return parsed;
                }
            }
            parse_legacy(&root)
        }
        // Some hand-made books store the lyrics as plain text.
        _ => parse_plain_text(raw),
    }
}

fn parse_v2(value: &Value) -> Option<(Vec<Section>, Vec<String>)> {
    let sections: Vec<Section> = serde_json::from_value(value.get("sections")?.clone()).ok()?;
    let order: Vec<String> = serde_json::from_value(value.get("order")?.clone()).ok()?;
    if sections.is_empty() {
        return None;
    }
    Some(sanitize(&sections, &order))
}

/// v1 shape: verses, one repeating chorus, and bridges pinned to a position in
/// the rendered list.
fn parse_legacy(root: &Map<String, Value>) -> (Vec<Section>, Vec<String>) {
    let couplets: Vec<String> = root
        .get("Couplets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // v1 crashed here when `Chorus` was JSON null rather than "".
    let chorus = root
        .get("Chorus")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    let mut sections = Vec::new();
    let mut order = Vec::new();

    let chorus_id = "c1".to_string();
    if !chorus.is_empty() {
        sections.push(Section {
            id: chorus_id.clone(),
            kind: SectionKind::Chorus,
            label: None,
            text: chorus,
        });
    }

    for (index, verse) in couplets.iter().enumerate() {
        let id = format!("v{}", index + 1);
        sections.push(Section {
            id: id.clone(),
            kind: SectionKind::Verse,
            label: None,
            text: verse.clone(),
        });
        order.push(id);
        if !sections.is_empty() && sections.iter().any(|s| s.id == chorus_id) {
            order.push(chorus_id.clone());
        }
    }

    if let Some(bridges) = root.get("Bridges").and_then(Value::as_array) {
        for (index, bridge) in bridges.iter().enumerate() {
            let body = bridge
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if body.is_empty() {
                continue;
            }
            let id = format!("b{}", index + 1);
            sections.push(Section {
                id: id.clone(),
                kind: SectionKind::Bridge,
                label: None,
                text: body,
            });
            let at = bridge
                .get("index")
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(order.len())
                .min(order.len());
            order.insert(at, id);
        }
    }

    sanitize(&sections, &order)
}

/// Best-effort split of unstructured lyrics. Recognises the section headers
/// LyricVerse 1.x looked for, and falls back to blank-line separated blocks.
fn parse_plain_text(raw: &str) -> (Vec<Section>, Vec<String>) {
    let body = raw.replace("\r\n", "\n").replace('\r', "\n");
    let body = body.trim();
    if body.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut blocks: Vec<(SectionKind, Vec<String>)> = Vec::new();
    let mut has_headers = false;

    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(kind) = header_kind(trimmed) {
            has_headers = true;
            blocks.push((kind, Vec::new()));
            // "Куплет 1: Слава Богу" — keep whatever followed the header.
            if let Some(rest) = trimmed.split_once(':').map(|(_, rest)| rest.trim()) {
                if !rest.is_empty() {
                    if let Some(block) = blocks.last_mut() {
                        block.1.push(rest.to_string());
                    }
                }
            }
            continue;
        }
        if blocks.is_empty() {
            blocks.push((SectionKind::Verse, Vec::new()));
        }
        if let Some(block) = blocks.last_mut() {
            block.1.push(trimmed.to_string());
        }
    }

    if !has_headers {
        blocks = body
            .split("\n\n")
            .map(|chunk| {
                (
                    SectionKind::Verse,
                    chunk.lines().map(|l| l.trim().to_string()).collect::<Vec<_>>(),
                )
            })
            .collect();
    }

    let mut sections = Vec::new();
    let mut order = Vec::new();
    let mut chorus_id: Option<String> = None;

    for (kind, lines) in blocks {
        let content = lines.join("\n").trim().to_string();
        if content.is_empty() {
            continue;
        }
        // A repeated chorus is one section shown many times, not many copies.
        if kind == SectionKind::Chorus {
            if let Some(existing) = &chorus_id {
                order.push(existing.clone());
                continue;
            }
        }
        let id = format!("{}{}", kind.prefix(), sections.len() + 1);
        if kind == SectionKind::Chorus {
            chorus_id = Some(id.clone());
        }
        sections.push(Section { id: id.clone(), kind, label: None, text: content });
        order.push(id);
    }

    sanitize(&sections, &order)
}

fn header_kind(line: &str) -> Option<SectionKind> {
    let normalized = text::normalize(line);
    if normalized.is_empty() || normalized.split_whitespace().count() > 3 {
        return None;
    }
    // Headers are short and start with the keyword: "Куплет 2", "#Припев".
    let first = normalized.split_whitespace().next()?;
    match first {
        "куплет" | "verse" => Some(SectionKind::Verse),
        "приспів" | "приспив" | "припев" | "chorus" | "refrain" => Some(SectionKind::Chorus),
        "брідж" | "бридж" | "бридge" | "bridge" => Some(SectionKind::Bridge),
        "проігриш" | "тег" | "tag" | "ending" | "outro" | "intro" => Some(SectionKind::Other),
        _ => None,
    }
}

#[cfg(test)]
mod tests_sections {
    use super::*;

    fn section(id: &str, text: &str) -> Section {
        Section { id: id.into(), kind: SectionKind::Verse, label: None, text: text.into() }
    }

    #[test]
    fn a_brand_new_song_survives_its_first_save() {
        // What the "new song" button sends: one section, no words yet.
        let (sections, order) = sanitize(&[section("v1", "")], &["v1".to_string()]);
        assert_eq!(sections.len(), 1, "the only section must not be discarded");
        assert_eq!(order, vec!["v1".to_string()]);
    }

    #[test]
    fn a_blank_between_two_verses_keeps_its_place() {
        let (sections, order) = sanitize(
            &[section("v1", "First"), section("v2", ""), section("v3", "Third")],
            &["v1".into(), "v2".into(), "v3".into()],
        );
        assert_eq!(order, vec!["v1".to_string(), "v2".to_string(), "v3".to_string()]);
        assert_eq!(sections[1].text, "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_round_trip_keeps_chorus_between_verses() {
        let raw = r#"{"Couplets":["one","two"],"Chorus":"ref","Bridges":[]}"#;
        let (sections, order) = parse_song_text(raw);
        assert_eq!(sections.len(), 3);
        let texts: Vec<&str> = order
            .iter()
            .map(|id| sections.iter().find(|s| &s.id == id).unwrap().text.as_str())
            .collect();
        assert_eq!(texts, vec!["one", "ref", "two", "ref"]);
    }

    #[test]
    fn null_chorus_does_not_panic() {
        let raw = r#"{"Couplets":["one"],"Chorus":null,"Bridges":[]}"#;
        let (sections, order) = parse_song_text(raw);
        assert_eq!(sections.len(), 1);
        assert_eq!(order.len(), 1);
    }

    #[test]
    fn v2_is_preferred_and_survives_a_round_trip() {
        let sections = vec![
            Section { id: "v1".into(), kind: SectionKind::Verse, label: None, text: "a".into() },
            Section { id: "c1".into(), kind: SectionKind::Chorus, label: None, text: "b".into() },
        ];
        let order = vec!["c1".to_string(), "v1".to_string(), "c1".to_string()];
        let encoded = serialize_song_text(&sections, &order).unwrap();
        let (back_sections, back_order) = parse_song_text(&encoded);
        assert_eq!(back_order, order);
        assert_eq!(back_sections.len(), 2);
    }

    #[test]
    fn plain_text_headers_are_recognised() {
        let raw = "Куплет 1\nline a\nline b\n\nПриспів\nref\n\nКуплет 2\nline c\n\nПриспів\nref";
        let (sections, order) = parse_plain_text(raw);
        // The chorus is stored once and referenced twice.
        assert_eq!(sections.len(), 3);
        assert_eq!(order.len(), 4);
        assert_eq!(order[1], order[3]);
    }

    #[test]
    fn plain_text_without_headers_splits_on_blank_lines() {
        let (sections, order) = parse_plain_text("a1\na2\n\nb1\nb2");
        assert_eq!(sections.len(), 2);
        assert_eq!(order.len(), 2);
    }
}
