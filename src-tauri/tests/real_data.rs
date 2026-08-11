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

use lyricverse_lib::{bible, numbering, songs};

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

/// The Psalms are numbered two ways, and the app has to read one against the
/// other. This checks the mapping against the modules actually shipped: the
/// ESV counts in Hebrew, Ogienko 1988 in Greek.
#[test]
fn psalm_numbering_lines_up_between_the_seeded_modules() {
    let Some(dir) = seed("BibleTranslations") else {
        eprintln!("no seeded translations — skipping");
        return;
    };
    let hebrew = match bible::Translation::load(&dir.join("ESV.SQLite3")) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("ESV not staged — skipping");
            return;
        }
    };
    let greek = match bible::Translation::load(&dir.join("UBIO'88.SQLite3")) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("Ogienko not staged — skipping");
            return;
        }
    };

    let hebrew_len = |ch: i64| hebrew.verses(numbering::PSALMS, ch).len() as i64;
    let greek_len = |ch: i64| greek.verses(numbering::PSALMS, ch).len() as i64;

    // Each module says which system it counts in, without being told.
    assert_eq!(
        numbering::detect(hebrew.verses(numbering::PSALMS, 9).len()),
        numbering::Numbering::Hebrew,
        "the ESV counts in Hebrew"
    );
    assert_eq!(
        numbering::detect(greek.verses(numbering::PSALMS, 9).len()),
        numbering::Numbering::Greek,
        "Ogienko 1988 counts in Greek"
    );

    let lengths = numbering::Lengths { hebrew: &hebrew_len, greek: &greek_len };

    // The joins, on the real text.
    for (from, to) in [
        ((23, 1), (22, 1)),
        ((9, 20), (9, 21)),
        ((10, 1), (9, 22)),
        ((116, 10), (115, 1)),
        ((147, 12), (147, 1)),
        ((150, 6), (150, 6)),
    ] {
        assert_eq!(
            numbering::hebrew_to_greek(from.0, from.1, &lengths),
            to,
            "Hebrew {}:{}",
            from.0,
            from.1
        );
    }

    // Every verse of the Psalter, mapped across and back, and every mapped
    // reference actually present in the other module — the check that would
    // catch an off-by-one anywhere in the 150.
    for chapter in 1..=150 {
        for verse in 1..=hebrew_len(chapter) {
            let (gc, gv) = numbering::hebrew_to_greek(chapter, verse, &lengths);
            assert!(
                gv >= 1 && gv <= greek_len(gc),
                "Hebrew {chapter}:{verse} maps to Greek {gc}:{gv}, which is not in the module"
            );
            assert_eq!(
                numbering::greek_to_hebrew(gc, gv, &lengths),
                (chapter, verse),
                "Hebrew {chapter}:{verse} did not survive the round trip"
            );
        }
    }
}

/// What the screens actually receive for a parallel reading, on the real
/// modules: the words of both translations, and both references.
#[test]
fn a_parallel_psalm_carries_both_references() {
    let Some(dir) = seed("BibleTranslations") else {
        eprintln!("no seeded translations — skipping");
        return;
    };
    let (Ok(esv), Ok(ogienko)) = (
        bible::Translation::load(&dir.join("ESV.SQLite3")),
        bible::Translation::load(&dir.join("UBIO'88.SQLite3")),
    ) else {
        eprintln!("seeded modules not staged — skipping");
        return;
    };

    let greek_length = |ch: i64| ogienko.verses(numbering::PSALMS, ch).len() as i64;
    let greek_verses = |ch: i64| -> Vec<(i64, String)> {
        ogienko
            .verses(numbering::PSALMS, ch)
            .iter()
            .map(|row| (row.verse, row.text.clone()))
            .collect()
    };
    let hebrew_length = |ch: i64| esv.verses(numbering::PSALMS, ch).len() as i64;

    let read = |chapter: i64| {
        let primary: Vec<(i64, String)> = esv
            .verses(numbering::PSALMS, chapter)
            .iter()
            .map(|row| (row.verse, row.text.clone()))
            .collect();
        let other = numbering::Other {
            name: "Ogienko 1988".into(),
            book: ogienko.book(numbering::PSALMS).map(|b| b.long_name.clone()).unwrap_or_default(),
            numbering: numbering::detect(ogienko.verses(numbering::PSALMS, 9).len()),
            verses: &greek_verses,
            length: &greek_length,
        };
        numbering::align(
            numbering::PSALMS,
            chapter,
            numbering::detect(esv.verses(numbering::PSALMS, 9).len()),
            &hebrew_length,
            &primary,
            std::slice::from_ref(&other),
        )
    };

    // Psalm 9:1 — the ESV folds the superscription into verse 1, the Greek
    // numbers it, so one verse here answers to two there.
    let nine = read(9);
    let first = &nine[0];
    assert_eq!(first.reference, "9:1");
    let beside = &first.others[0];
    assert_eq!(beside.reference, "9:1-2", "both Greek verses belong to this slide");
    assert!(beside.shifted, "both references must show");
    assert!(!beside.book.is_empty(), "the module names the book itself");
    assert!(!beside.text.trim().is_empty(), "the Ukrainian words are on the slide");

    // Psalm 23 — the plain one-behind case.
    let twenty_three = read(23);
    assert_eq!(twenty_three[0].reference, "23:1");
    assert_eq!(twenty_three[0].others[0].reference, "22:1");
    assert!(twenty_three[0].others[0].shifted);

    // Psalm 150 — the numbering agrees again, so only one reference is shown.
    let last = read(150);
    assert_eq!(last[0].others[0].reference, "150:1");
    assert!(!last[0].others[0].shifted, "nothing to say when they agree");

    // Three translations at once: each one names the book and the verse in its
    // own terms, whether or not its numbering matches the primary's. That is
    // what the screen needs to print a reference a reader can follow in the
    // language they are reading.
    let Ok(kjv) = bible::Translation::load(&dir.join("KJV.SQLite3")) else {
        eprintln!("KJV not staged — skipping the three-way check");
        return;
    };
    let kjv_length = |ch: i64| kjv.verses(numbering::PSALMS, ch).len() as i64;
    let kjv_verses = |ch: i64| -> Vec<(i64, String)> {
        kjv.verses(numbering::PSALMS, ch)
            .iter()
            .map(|row| (row.verse, row.text.clone()))
            .collect()
    };
    let primary: Vec<(i64, String)> = esv
        .verses(numbering::PSALMS, 23)
        .iter()
        .map(|row| (row.verse, row.text.clone()))
        .collect();
    let three = numbering::align(
        numbering::PSALMS,
        23,
        numbering::detect(esv.verses(numbering::PSALMS, 9).len()),
        &hebrew_length,
        &primary,
        &[
            numbering::Other {
                name: "Ogienko 1988".into(),
                book: ogienko.book(numbering::PSALMS).map(|b| b.long_name.clone()).unwrap_or_default(),
                numbering: numbering::detect(ogienko.verses(numbering::PSALMS, 9).len()),
                verses: &greek_verses,
                length: &greek_length,
            },
            numbering::Other {
                name: "King James Version".into(),
                book: kjv.book(numbering::PSALMS).map(|b| b.long_name.clone()).unwrap_or_default(),
                numbering: numbering::detect(kjv.verses(numbering::PSALMS, 9).len()),
                verses: &kjv_verses,
                length: &kjv_length,
            },
        ],
    );

    let row = &three[0];
    assert_eq!(row.others.len(), 2, "both translations answer for this verse");
    for beside in &row.others {
        assert!(!beside.book.is_empty(), "{} names the book", beside.name);
        assert!(!beside.reference.is_empty(), "{} gives a reference", beside.name);
        assert!(!beside.text.trim().is_empty(), "{} has the words", beside.name);
    }
    // The Greek-numbered one is a psalm behind; the Hebrew-numbered one is not.
    assert_eq!(row.others[0].reference, "22:1");
    assert_eq!(row.others[1].reference, "23:1");
}
