//! Songs in and out of the app, as files.
//!
//! Two formats, for two jobs.
//!
//! **JSON** is the exact one: ids, kinds, labels and the performance order all
//! survive a round trip, so it is what a congregation backs a songbook up to
//! or hands to another congregation running this app. Many songs live in one
//! file, which is what makes a bulk export a single thing to email.
//!
//! **Text** is the interoperable one: a title, then labelled blocks, which is
//! roughly what every other piece of worship software reads and writes. One
//! song per file, as that convention expects. An order that repeats a section
//! — a chorus sung three times — cannot be shown by writing blocks alone, so
//! it is written out as a trailing `[Order]` block and read back if present.
//! Without one, the blocks are simply taken in the order they appear, which is
//! what a file from elsewhere will mean.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::songs::{self, Section, SectionKind, Song};

/// What a bulk import did, so the operator is told rather than left guessing.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    /// One entry per file that could not be read, as "name: why".
    pub failed: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongFile {
    format: String,
    version: u32,
    songs: Vec<Song>,
}

const FORMAT: &str = "lyricverse-songs";
const FORMAT_VERSION: u32 = 1;

// --- JSON -------------------------------------------------------------------

fn to_json(songs: &[Song]) -> Result<String> {
    let file = SongFile {
        format: FORMAT.into(),
        version: FORMAT_VERSION,
        songs: songs.to_vec(),
    };
    Ok(serde_json::to_string_pretty(&file)?)
}

/// Reads our own file, a bare array, or a single song.
///
/// Deliberately forgiving: someone will paste one song out of an export and
/// hand it over on its own, and refusing that on a technicality helps nobody.
fn from_json(raw: &str) -> Result<Vec<Song>> {
    if let Ok(file) = serde_json::from_str::<SongFile>(raw) {
        return Ok(file.songs);
    }
    if let Ok(list) = serde_json::from_str::<Vec<Song>>(raw) {
        return Ok(list);
    }
    match serde_json::from_str::<Song>(raw) {
        Ok(song) => Ok(vec![song]),
        Err(error) => Err(AppError::msg(format!("not a song file: {error}"))),
    }
}

// --- Text -------------------------------------------------------------------

fn label_for(section: &Section, index: usize) -> String {
    if let Some(label) = section.label.as_ref().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        return label.to_string();
    }
    match section.kind {
        SectionKind::Verse => format!("Verse {}", index + 1),
        SectionKind::Chorus => "Chorus".into(),
        SectionKind::Bridge => "Bridge".into(),
        SectionKind::Other => format!("Part {}", index + 1),
    }
}

/// Maps a label from any source onto one of our four kinds.
///
/// Matched on both languages the app is used in, and on the first word only,
/// so "Куплет 2" and "Verse 2" both land on a verse.
fn kind_for(label: &str) -> SectionKind {
    let lower = label.trim().to_lowercase();
    let head = lower.split(|c: char| c.is_whitespace() || c.is_ascii_digit()).next().unwrap_or("");
    match head {
        "verse" | "v" | "куплет" => SectionKind::Verse,
        "chorus" | "refrain" | "c" | "приспів" => SectionKind::Chorus,
        "bridge" | "b" | "брідж" | "бридж" => SectionKind::Bridge,
        _ => SectionKind::Other,
    }
}

fn to_text(song: &Song) -> String {
    let mut out = String::new();
    out.push_str(song.title.trim());
    out.push_str("\n\n");

    // Each section once, in the order it is first performed — a reader wants
    // the words, not the same chorus copied out three times.
    let mut seen: Vec<&str> = Vec::new();
    let mut labels: Vec<(String, String)> = Vec::new();
    for id in &song.order {
        if seen.contains(&id.as_str()) {
            continue;
        }
        let Some((index, section)) = song
            .sections
            .iter()
            .enumerate()
            .find(|(_, candidate)| &candidate.id == id)
        else {
            continue;
        };
        seen.push(id);
        let label = label_for(section, index);
        out.push_str(&format!("[{}]\n{}\n\n", label, section.text.trim()));
        labels.push((id.clone(), label));
    }

    // Only written when it says something the blocks do not: a repeat, or a
    // performance order that is not simply top to bottom.
    let repeats = song.order.len() != seen.len();
    if repeats {
        let names: Vec<String> = song
            .order
            .iter()
            .filter_map(|id| labels.iter().find(|(key, _)| key == id).map(|(_, l)| l.clone()))
            .collect();
        out.push_str(&format!("[Order]\n{}\n", names.join("\n")));
    }
    out.trim_end().to_string()
}

/// How many lines one slide holds when a dump has to be cut up. Four lines of
/// lyric is about what a projector can show at a readable size.
const LINES_PER_SLIDE: usize = 4;

/// A song built out of a wall of pasted lyrics.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDraft {
    pub sections: Vec<Section>,
    /// Section ids in playing order. A chorus appears here as often as it is
    /// sung, but only once in `sections`.
    pub order: Vec<String>,
}

/// Turns lyrics copied off a website into a song somebody can drive.
///
/// What arrives from a lyrics site is a column of lines with the chorus
/// written out in full every time it comes round. Three things have to happen
/// for that to be usable on a Sunday:
///
/// - It is cut into slides of a few lines each, because a projector cannot
///   show forty lines and nobody can read them if it does.
/// - Blocks that repeat become *one* section used many times, so fixing a typo
///   in the chorus fixes every occurrence rather than the first of six.
/// - A block that comes round more than once is called a chorus, which is what
///   a repeated block nearly always is.
///
/// A blank line is what divides one part from the next, and nothing else is
/// guessed at: text that arrives in some other shape is arranged by the person
/// who pasted it, who can see the sections it made as they type.
///
/// Explicitly labelled text is left alone — somebody who has written `[Verse
/// 1]` has already said what they want, and guessing over the top of that
/// would be rude.
pub fn song_from_lyrics(raw: &str) -> LyricsDraft {
    let text = raw.replace("\r\n", "\n");

    if has_labels(&text) {
        let sections = sections_from_text(&text);
        let order = sections.iter().map(|section| section.id.clone()).collect();
        return LyricsDraft { sections, order };
    }

    let mut sections: Vec<Section> = Vec::new();
    let mut order: Vec<String> = Vec::new();
    // Normalised text -> the id already carrying it.
    let mut seen: BTreeMap<String, String> = BTreeMap::new();

    for block in blocks(&text) {
        for piece in split_evenly(&block, LINES_PER_SLIDE) {
            let body = piece.join("\n");
            let key = repeat_key(&body);
            if let Some(id) = seen.get(&key) {
                // The same words again: another turn of one we already have.
                order.push(id.clone());
                continue;
            }
            let id = format!("s{}", sections.len() + 1);
            seen.insert(key, id.clone());
            order.push(id.clone());
            sections.push(Section { id, kind: SectionKind::Verse, label: None, text: body });
        }
    }

    // A block that comes round again is a chorus.
    for section in &mut sections {
        if order.iter().filter(|id| **id == section.id).count() > 1 {
            section.kind = SectionKind::Chorus;
        }
    }

    LyricsDraft { sections, order }
}

fn has_labels(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() > 2
    })
}

/// The paragraphs of a dump: runs of lines with blank ones between them.
fn blocks(text: &str) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(trimmed.to_string());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Cuts a block into pieces of at most `max` lines, as evenly as they will go.
///
/// Evenly, rather than filling each piece before starting the next: a block of
/// six lines reads as three and three, not four and a widow.
fn split_evenly(lines: &[String], max: usize) -> Vec<Vec<String>> {
    if lines.len() <= max {
        return vec![lines.to_vec()];
    }
    let pieces = lines.len().div_ceil(max);
    let base = lines.len() / pieces;
    let remainder = lines.len() % pieces;

    let mut out = Vec::with_capacity(pieces);
    let mut start = 0;
    for index in 0..pieces {
        // The first `remainder` pieces take the odd line each.
        let take = base + usize::from(index < remainder);
        out.push(lines[start..start + take].to_vec());
        start += take;
    }
    out
}

/// What counts as "the same words again".
///
/// Case and spacing are ignored, and so are the asides a lyrics site puts in
/// brackets — "(sing it again)" on the last time round should not stop a
/// chorus being recognised as the chorus.
fn repeat_key(body: &str) -> String {
    let mut key = String::with_capacity(body.len());
    let mut depth = 0usize;
    let mut last_space = true;
    for ch in body.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            c if c.is_whitespace() => {
                if !last_space {
                    key.push(' ');
                    last_space = true;
                }
            }
            c if c.is_alphanumeric() => {
                key.extend(c.to_lowercase());
                last_space = false;
            }
            // Punctuation is dropped: an apostrophe or a comma that differs
            // between two turns of the same chorus is not a different chorus.
            _ => {}
        }
    }
    key.trim().to_string()
}

/// Sections parsed out of pasted text.
///
/// The same reader the `.txt` import uses, so a block copied out of a song and
/// pasted back comes home as the section it was — but without the title rule.
/// A file's first line before any block is its title; a clipboard's first line
/// is the first line of the lyric, and eating it would be a quiet way to lose
/// words.
pub fn sections_from_text(raw: &str) -> Vec<Section> {
    let text = raw.replace("\r\n", "\n");
    let labelled = text.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() > 2
    });

    if labelled {
        if let Ok(song) = from_text(&text, "") {
            return song.sections;
        }
    }

    let body = text.trim();
    if body.is_empty() {
        return Vec::new();
    }
    vec![Section {
        id: "s1".into(),
        kind: SectionKind::Verse,
        label: None,
        text: body.to_string(),
    }]
}

fn from_text(raw: &str, fallback_title: &str) -> Result<Song> {
    let text = raw.replace("\r\n", "\n");
    let mut title = String::new();
    let mut sections: Vec<Section> = Vec::new();
    let mut order_labels: Vec<String> = Vec::new();

    let mut current: Option<(String, Vec<&str>)> = None;
    let mut in_order = false;

    let flush = |current: &mut Option<(String, Vec<&str>)>, sections: &mut Vec<Section>| {
        if let Some((label, lines)) = current.take() {
            let body = lines.join("\n").trim().to_string();
            if body.is_empty() {
                return;
            }
            let index = sections.len();
            sections.push(Section {
                id: format!("s{}", index + 1),
                kind: kind_for(&label),
                label: Some(label),
                text: body,
            });
        }
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(header) = trimmed.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            flush(&mut current, &mut sections);
            if header.trim().eq_ignore_ascii_case("order") {
                in_order = true;
                continue;
            }
            in_order = false;
            current = Some((header.trim().to_string(), Vec::new()));
            continue;
        }
        if in_order {
            if !trimmed.is_empty() {
                order_labels.push(trimmed.to_string());
            }
            continue;
        }
        match current.as_mut() {
            Some((_, lines)) => lines.push(line),
            // Anything before the first block is the title. A file with no
            // blocks at all is still a song: it becomes one verse below.
            None if title.is_empty() && !trimmed.is_empty() => title = trimmed.to_string(),
            None => {}
        }
    }
    flush(&mut current, &mut sections);

    if sections.is_empty() {
        // No labelled blocks — treat the whole thing after the title as the
        // song, which is what a plain lyrics file dropped in will be.
        let body = text
            .lines()
            .skip_while(|line| line.trim().is_empty())
            .skip(if title.is_empty() { 0 } else { 1 })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if body.is_empty() {
            return Err(AppError::msg("the file has no words in it"));
        }
        sections.push(Section {
            id: "s1".into(),
            kind: SectionKind::Verse,
            label: None,
            text: body,
        });
    }

    let order: Vec<String> = if order_labels.is_empty() {
        sections.iter().map(|section| section.id.clone()).collect()
    } else {
        order_labels
            .iter()
            .filter_map(|label| {
                sections
                    .iter()
                    .find(|section| {
                        section.label.as_deref().map(str::trim).unwrap_or("").eq_ignore_ascii_case(label)
                    })
                    .map(|section| section.id.clone())
            })
            .collect()
    };
    let order = if order.is_empty() {
        sections.iter().map(|section| section.id.clone()).collect()
    } else {
        order
    };

    let title = if title.is_empty() { fallback_title.to_string() } else { title };
    Ok(Song { id: 0, title, sections, order })
}

// --- Files ------------------------------------------------------------------

/// Strips anything a filesystem would object to, so a title can name a file.
fn safe_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "song".into() } else { trimmed }
}

/// Never overwrites: a second "Amazing Grace" becomes "Amazing Grace (2)".
fn free_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{extension}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{extension}"));
        n += 1;
    }
    candidate
}

/**
 * Writes songs out.
 *
 * JSON puts everything in one file — that is what makes a bulk export
 * something you can hand over whole. Text writes one file per song, which is
 * the convention every other program expects.
 */
pub fn export(
    dir: &Path,
    book: &str,
    ids: &[i64],
    format: &str,
    destination: &Path,
) -> Result<Vec<PathBuf>> {
    let mut chosen = Vec::new();
    for id in ids {
        chosen.push(songs::get(dir, book, *id)?);
    }
    if chosen.is_empty() {
        return Err(AppError::msg("no songs to export"));
    }

    match format {
        "json" => {
            let target = if destination.is_dir() {
                free_path(destination, &safe_stem(book), "json")
            } else {
                destination.to_path_buf()
            };
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&target, to_json(&chosen)?)?;
            Ok(vec![target])
        }
        "txt" => {
            if !destination.is_dir() {
                fs::create_dir_all(destination)?;
            }
            let mut written = Vec::new();
            for song in &chosen {
                let target = free_path(destination, &safe_stem(&song.title), "txt");
                fs::write(&target, to_text(song))?;
                written.push(target);
            }
            Ok(written)
        }
        other => Err(AppError::msg(format!("unknown export format \"{other}\""))),
    }
}

/**
 * Reads songs in, from any mixture of files.
 *
 * A file that cannot be read does not stop the rest: importing forty songs and
 * losing the lot because one was malformed is not a trade anyone would take,
 * so the failures are collected and reported alongside the successes.
 */
pub fn import(dir: &Path, book: &str, paths: &[PathBuf]) -> Result<ImportReport> {
    let mut report = ImportReport::default();

    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        let outcome = (|| -> Result<usize> {
            let raw = fs::read_to_string(path)?;
            let extension = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            let parsed = if extension == "json" {
                from_json(&raw)?
            } else {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled");
                vec![from_text(&raw, stem)?]
            };

            let mut count = 0;
            for song in parsed {
                // Always inserted, never matched against what is already
                // there: an import must not quietly overwrite a song someone
                // has since edited.
                songs::save(dir, book, &Song { id: 0, ..song })?;
                count += 1;
            }
            Ok(count)
        })();

        match outcome {
            Ok(count) => report.imported += count,
            Err(error) => report.failed.push(format!("{name}: {error}")),
        }
    }

    if report.imported == 0 && !report.failed.is_empty() {
        return Err(AppError::msg(report.failed.join("; ")));
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A column of lines with no blank lines and no headings — what a lyrics
    /// site gives you — is cut into slides of at most four lines.
    #[test]
    fn a_wall_of_lyrics_is_cut_into_readable_slides() {
        let raw = (1..=10).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        let draft = song_from_lyrics(&raw);
        assert_eq!(draft.order.len(), 3, "ten lines make three slides");
        for section in &draft.sections {
            assert!(
                section.text.lines().count() <= LINES_PER_SLIDE,
                "no slide holds more than {LINES_PER_SLIDE} lines: {:?}",
                section.text
            );
        }
        // Evenly, not four-four-two.
        let counts: Vec<usize> =
            draft.sections.iter().map(|s| s.text.lines().count()).collect();
        assert_eq!(counts, vec![4, 3, 3]);
    }

    /// The whole point: a chorus written out five times becomes one section
    /// sung five times, so correcting it once corrects it everywhere.
    #[test]
    fn a_repeated_block_becomes_one_chorus_used_many_times() {
        let verse = "aaa\nbbb";
        let chorus = "ccc\nddd";
        let raw = format!("{chorus}\n\n{verse}\n\n{chorus}\n\n{chorus}");
        let draft = song_from_lyrics(&raw);

        assert_eq!(draft.sections.len(), 2, "one chorus and one verse");
        assert_eq!(draft.order.len(), 4, "sung four times between them");
        let repeated = draft.sections.iter().find(|s| s.text == chorus).unwrap();
        assert_eq!(repeated.kind, SectionKind::Chorus);
        assert_eq!(draft.order.iter().filter(|id| **id == repeated.id).count(), 3);
        let once = draft.sections.iter().find(|s| s.text == verse).unwrap();
        assert_eq!(once.kind, SectionKind::Verse, "sung once, so not a chorus");
    }

    /// The last time round a lyrics site writes "(sing it again)" after the
    /// line. It is the same chorus.
    #[test]
    fn an_aside_in_brackets_does_not_hide_a_repeat() {
        let raw = "hold me now\nand steady me\n\nhold me now (sing it)\nand steady me";
        let draft = song_from_lyrics(raw);
        assert_eq!(draft.sections.len(), 1);
        assert_eq!(draft.order.len(), 2);
        // The words are kept exactly as they came, aside and all.
        assert!(draft.sections[0].text.contains("hold me now"));
    }

    /// Somebody who has written the headings themselves has already said what
    /// they want; nothing is guessed over the top of it.
    #[test]
    fn labelled_text_is_left_as_written() {
        let draft = song_from_lyrics("[Chorus]\none\ntwo\nthree\nfour\nfive\nsix");
        assert_eq!(draft.sections.len(), 1, "not cut up");
        assert_eq!(draft.sections[0].kind, SectionKind::Chorus);
        assert_eq!(draft.sections[0].text.lines().count(), 6);
    }

    #[test]
    fn pasting_an_empty_page_makes_an_empty_song() {
        let draft = song_from_lyrics("\n   \n\n");
        assert!(draft.sections.is_empty());
        assert!(draft.order.is_empty());
    }

    #[test]
    fn pasted_blocks_come_back_as_the_sections_they_were() {
        let sections = sections_from_text("[Chorus]\nholy, holy\n\n[Verse 2]\nline one\nline two\n");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].kind, SectionKind::Chorus);
        assert_eq!(sections[0].text, "holy, holy");
        assert_eq!(sections[1].kind, SectionKind::Verse);
        assert_eq!(sections[1].text, "line one\nline two");
    }

    /// Lyrics copied from anywhere else: one verse, with every line kept. The
    /// file reader would have taken the first line for a title.
    #[test]
    fn pasted_plain_text_keeps_its_first_line() {
        let sections = sections_from_text("Amazing grace\nhow sweet the sound");
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].text, "Amazing grace\nhow sweet the sound");
    }

    #[test]
    fn pasting_nothing_adds_nothing() {
        assert!(sections_from_text("   \n\n ").is_empty());
    }

    fn song() -> Song {
        Song {
            id: 7,
            title: "A Title".into(),
            sections: vec![
                Section { id: "v1".into(), kind: SectionKind::Verse, label: None, text: "one\ntwo".into() },
                Section { id: "c1".into(), kind: SectionKind::Chorus, label: None, text: "three".into() },
            ],
            // The chorus comes round again, which is the case plain blocks
            // cannot express on their own.
            order: vec!["v1".into(), "c1".into(), "v1".into(), "c1".into()],
        }
    }

    #[test]
    fn json_survives_a_round_trip_exactly() {
        let original = song();
        let back = from_json(&to_json(&[original.clone()]).expect("write")).expect("read");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].title, original.title);
        assert_eq!(back[0].order, original.order);
        assert_eq!(back[0].sections.len(), 2);
        assert_eq!(back[0].sections[0].text, "one\ntwo");
        assert_eq!(back[0].sections[1].kind, SectionKind::Chorus);
    }

    #[test]
    fn json_also_reads_a_bare_array_or_a_lone_song() {
        let one = serde_json::to_string(&song()).expect("write");
        assert_eq!(from_json(&one).expect("lone").len(), 1);
        let many = serde_json::to_string(&vec![song(), song()]).expect("write");
        assert_eq!(from_json(&many).expect("array").len(), 2);
        assert!(from_json("{\"nope\":1}").is_err());
    }

    #[test]
    fn text_keeps_the_words_the_kinds_and_a_repeating_order() {
        let written = to_text(&song());
        // Each section written once, however often it is performed.
        assert_eq!(written.matches("[Verse 1]").count(), 1);
        assert!(written.contains("[Chorus]"));
        assert!(written.contains("[Order]"));

        let back = from_text(&written, "fallback").expect("read");
        assert_eq!(back.title, "A Title");
        assert_eq!(back.sections.len(), 2);
        assert_eq!(back.sections[0].kind, SectionKind::Verse);
        assert_eq!(back.sections[1].kind, SectionKind::Chorus);
        assert_eq!(back.sections[0].text, "one\ntwo");
        // Four performances, two sections.
        assert_eq!(back.order.len(), 4);
        assert_eq!(back.order[0], back.order[2]);
        assert_eq!(back.order[1], back.order[3]);
    }

    #[test]
    fn text_without_an_order_block_plays_top_to_bottom() {
        let written = "Title\n\n[Verse 1]\na\n\n[Chorus]\nb\n";
        let back = from_text(written, "fallback").expect("read");
        assert_eq!(back.order.len(), 2);
        assert_eq!(back.order[0], back.sections[0].id);
    }

    #[test]
    fn a_plain_lyrics_file_still_imports() {
        // No labelled blocks at all, which is what a file from a text editor
        // or an email will look like.
        let back = from_text("Title\n\nsome words\nmore words\n", "fallback").expect("read");
        assert_eq!(back.title, "Title");
        assert_eq!(back.sections.len(), 1);
        assert_eq!(back.sections[0].kind, SectionKind::Verse);
        assert!(back.sections[0].text.contains("more words"));

        // A file with nothing in it is an error rather than an empty song.
        assert!(from_text("   \n\n", "fallback").is_err());
    }

    #[test]
    fn labels_are_recognised_in_both_languages() {
        assert_eq!(kind_for("Verse 2"), SectionKind::Verse);
        assert_eq!(kind_for("Куплет 2"), SectionKind::Verse);
        assert_eq!(kind_for("Приспів"), SectionKind::Chorus);
        assert_eq!(kind_for("Bridge"), SectionKind::Bridge);
        assert_eq!(kind_for("Tag"), SectionKind::Other);
    }

    #[test]
    fn a_title_can_always_name_a_file() {
        assert_eq!(safe_stem("A/B: C?"), "A_B_ C_");
        assert_eq!(safe_stem("   "), "song");
        assert_eq!(safe_stem("..."), "song");
    }
}

