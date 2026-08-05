//! Integration checks against the seeded songbooks and MyBible modules.
//!
//! These run over the real data staged by `scripts/prepare-resources.mjs`, so
//! they catch the things unit tests on synthetic input cannot: a songbook whose
//! `song_text` is not the shape we expect, a translation with chapter gaps, a
//! reference the parser mis-reads.
//!
//! Skipped (not failed) when the seed folder is absent, so a fresh clone that
//! has not run `prepare-resources` still passes `cargo test`.

use std::path::{Path, PathBuf};

use lyricverse_lib::{bible, songs};

fn seed(kind: &str) -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/seed").join(kind);
    dir.is_dir().then_some(dir)
}

#[test]
fn every_song_in_every_seeded_songbook_parses() {
    let Some(dir) = seed("Songbooks") else {
        eprintln!("no seeded songbooks — skipping");
        return;
    };

    let books = songs::list(&dir).expect("list songbooks");
    assert!(!books.is_empty(), "expected at least one seeded songbook");

    let mut total = 0;
    for book in &books {
        assert!(book.error.is_none(), "{}: {:?}", book.name, book.error);

        let summaries = songs::songs(&dir, &book.name).expect("list songs");
        assert_eq!(
            summaries.len() as i64,
            book.song_count,
            "{} reported {} songs but listed {}",
            book.name,
            book.song_count,
            summaries.len()
        );

        for summary in &summaries {
            let song = songs::get(&dir, &book.name, summary.id)
                .unwrap_or_else(|err| panic!("{} #{}: {err}", book.name, summary.id));

            assert!(!song.title.trim().is_empty(), "{} #{} has no title", book.name, song.id);
            // Every id in the running order must resolve to a real section —
            // this is exactly the invariant v1's bridge-by-index format broke.
            for id in &song.order {
                assert!(
                    song.sections.iter().any(|section| &section.id == id),
                    "{} #{}: order references missing section {id}",
                    book.name,
                    song.id
                );
            }
            assert!(
                !song.order.is_empty(),
                "{} #{} ({}) produced no slides",
                book.name,
                song.id,
                song.title
            );
            total += 1;
        }
    }
    println!("parsed {total} songs across {} songbooks", books.len());
    assert!(total > 100, "expected the real songbooks, got only {total} songs");
}

#[test]
fn seeded_translations_load_and_search() {
    let Some(dir) = seed("BibleTranslations") else {
        eprintln!("no seeded translations — skipping");
        return;
    };

    let translations = bible::list(&dir).expect("list translations");
    assert!(!translations.is_empty(), "expected at least one seeded translation");

    for meta in &translations {
        assert!(meta.error.is_none(), "{}: {:?}", meta.name, meta.error);
        let path = bible::path_of(&dir, &meta.name).expect("resolve path");
        let translation = bible::Translation::load(&path).expect("load translation");

        let books = translation.books();
        assert!(books.len() >= 27, "{} only exposed {} books", meta.name, books.len());

        // Every advertised chapter must actually contain verses.
        for book in books {
            let chapters = translation.chapters(book.number);
            assert_eq!(chapters.len(), book.chapters, "{} chapter count mismatch", book.long_name);
            for chapter in &chapters {
                assert!(
                    !translation.verses(book.number, *chapter).is_empty(),
                    "{} {}:{} is empty",
                    meta.name,
                    book.long_name,
                    chapter
                );
            }
        }

        // Markup must not survive into what goes on screen.
        for book in books.iter().take(5) {
            for verse in translation.verses(book.number, translation.chapters(book.number)[0]) {
                assert!(
                    !verse.text.contains('<') && !verse.text.contains("</"),
                    "{} {} left markup in: {}",
                    meta.name,
                    book.long_name,
                    verse.text
                );
            }
        }

        // Probe with the module's own opening words, so the check works
        // whatever language it is in.
        let first_book = &books[0];
        let opening = &translation.verses(first_book.number, translation.chapters(first_book.number)[0])[0];
        let probe = opening.text.split_whitespace().take(3).collect::<Vec<_>>().join(" ");

        let hits = translation.search(&probe, 10);
        assert!(!hits.is_empty(), "{}: search for {probe:?} found nothing", meta.name);
        for hit in &hits {
            assert!(hit.match_end > hit.match_start, "empty highlight range");
            assert!(hit.match_end <= hit.text.chars().count() + 1, "highlight out of range");
        }

        // The Ukrainian modules mark stress as a combining acute; typing the
        // word without it must still find the verse. v1 hand-listed every
        // stressed vowel to work around this.
        if meta.name.contains("Ogienko") {
            assert!(
                !translation.search("на початку", 5).is_empty(),
                "{}: accent-insensitive search found nothing",
                meta.name
            );
        }

        println!(
            "{}: {} books, search for {probe:?} -> {} hits (first: {})",
            meta.name,
            books.len(),
            hits.len(),
            hits[0].reference
        );
    }
}

#[test]
fn quick_references_resolve_the_way_an_operator_types_them() {
    let Some(dir) = seed("BibleTranslations") else {
        eprintln!("no seeded translations — skipping");
        return;
    };
    let all = bible::list(&dir).expect("list");

    let load = |needle: &str| {
        all.iter().find(|meta| meta.name.contains(needle)).map(|meta| {
            let path = bible::path_of(&dir, &meta.name).expect("path");
            bible::Translation::load(&path).expect("load")
        })
    };

    // Each module is queried in its own language — book matching works off the
    // names the module itself ships.
    if let Some(english) = load("King James") {
        // Includes the terse abbreviations an operator actually types.
        for query in [
            "john 3:16", "gen 1:1", "1 john 2:3", "revelation 22:1", "psalms 23",
            "rm 3 23", "rom 8:28", "1 co 13:4-7", "mt 5 3",
        ] {
            let reference = english
                .resolve(query)
                .unwrap_or_else(|| panic!("could not resolve {query:?}"));
            assert!(!english.passage_text(&reference).trim().is_empty());
            println!("{query:>16}  ->  {}", english.reference_label(&reference));
        }
    }

    let translation = load("Ogienko").expect("a Ukrainian module");

    // The forms v1 accepted, plus the ones it choked on (colons, ranges,
    // Latin-keyboard "i", and books whose name starts with a digit).
    for query in ["мт 10 10", "мт 10:10", "Iв 3:16", "ів 3 16", "1 ів 2:3", "буття 1:1"] {
        let reference = translation
            .resolve(query)
            .unwrap_or_else(|| panic!("could not resolve {query:?}"));
        let text = translation.passage_text(&reference);
        assert!(!text.trim().is_empty(), "{query:?} resolved to an empty passage");
        println!("{query:>12}  ->  {}", translation.reference_label(&reference));
    }

    // A range must produce more text than the single verse it starts from.
    let single = translation.resolve("ів 3:16").expect("single verse");
    let range = translation.resolve("ів 3:16-18").expect("verse range");
    assert_eq!(range.verse, 16);
    assert_eq!(range.end_verse, 18);
    assert!(
        translation.passage_text(&range).len() > translation.passage_text(&single).len(),
        "the range did not include the extra verses"
    );

    // Nonsense must fail cleanly rather than land on a wrong book.
    assert!(translation.resolve("zzzz 1:1").is_none());
}
