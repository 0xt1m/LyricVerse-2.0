//! The two ways the Psalms are numbered, and how to read one against the other.
//!
//! Protestant Bibles follow the Hebrew (Masoretic) text; Orthodox and Greek
//! Catholic books follow the Greek (Septuagint). The two agree at the start and
//! the end of the Psalter and disagree in the middle, because four psalms are
//! divided differently:
//!
//! | Hebrew | Greek |
//! |---|---|
//! | 1–8 | the same |
//! | 9 + 10 | 9 |
//! | 11–113 | 10–112 |
//! | 114 + 115 | 113 |
//! | 116 | 114 + 115 |
//! | 117–146 | 116–145 |
//! | 147 | 146 + 147 |
//! | 148–150 | the same |
//!
//! That table is the only thing hardcoded here. Everything else — where inside
//! a merged psalm the join falls, and whether a superscription is counted as a
//! verse — is worked out from the verse counts of the two modules actually
//! open. It has to be: modules disagree about titles, so Ogienko's Psalm 9 runs
//! to 39 verses where the ESV's 9 and 10 together run to 38, and a number baked
//! in here would be wrong for the next pair of translations somebody opens.

use std::collections::BTreeMap;

use serde::Serialize;

/// The MyBible book number for the Psalms.
pub const PSALMS: i64 = 230;

/// How many verses Psalm 9 must hold before it is read as the Greek's merged
/// one. Hebrew Psalm 9 runs to about 20; the merged Greek psalm to about 39.
const MERGED_PSALM_9: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Numbering {
    /// The Masoretic text: most English Bibles, and modern Ukrainian
    /// translations made from the Hebrew.
    Hebrew,
    /// The Septuagint: Orthodox and Greek Catholic books, Church Slavonic, and
    /// the older Ukrainian and Russian translations.
    Greek,
}

/// Which system a module counts in, from the module itself.
///
/// Psalm 9 answers it on its own: the Greek has Hebrew 9 and 10 in one psalm,
/// so it is roughly twice as long. Nothing else is needed — the two systems
/// agree on the number of psalms (150), so counting chapters says nothing.
pub fn detect(psalm_9_verses: usize) -> Numbering {
    if psalm_9_verses >= MERGED_PSALM_9 {
        Numbering::Greek
    } else {
        Numbering::Hebrew
    }
}

/// How long each psalm is in either module, so the joins can be found rather
/// than assumed.
pub struct Lengths<'a> {
    pub hebrew: &'a dyn Fn(i64) -> i64,
    pub greek: &'a dyn Fn(i64) -> i64,
}

impl Lengths<'_> {
    /// Verses the Greek counts before Hebrew 9:1 — the superscription, in a
    /// module that numbers it.
    ///
    /// Clamped: a module whose Psalm 9 is a wildly different length from the
    /// two it should contain is not one to do arithmetic on the strength of,
    /// so the join falls back to no offset and the clamp in `align` keeps the
    /// result inside the psalm.
    fn extra_before_nine(&self) -> i64 {
        let merged = (self.greek)(9);
        let apart = (self.hebrew)(9) + (self.hebrew)(10);
        (merged - apart).clamp(0, 2)
    }

    /// Where Greek 114 gives way to 115 inside Hebrew 116, and 146 to 147
    /// inside Hebrew 147.
    fn split_at(&self, greek_first: i64) -> i64 {
        (self.greek)(greek_first).max(1)
    }
}

/// A Hebrew-numbered reference, in Greek numbering.
pub fn hebrew_to_greek(chapter: i64, verse: i64, lengths: &Lengths) -> (i64, i64) {
    match chapter {
        1..=8 | 148..=150 => (chapter, verse),
        9 => (9, verse + lengths.extra_before_nine()),
        10 => (9, verse + lengths.extra_before_nine() + (lengths.hebrew)(9)),
        11..=113 | 117..=146 => (chapter - 1, verse),
        114 => (113, verse),
        115 => (113, verse + (lengths.hebrew)(114)),
        116 => {
            let split = lengths.split_at(114);
            if verse <= split {
                (114, verse)
            } else {
                (115, verse - split)
            }
        }
        147 => {
            let split = lengths.split_at(146);
            if verse <= split {
                (146, verse)
            } else {
                (147, verse - split)
            }
        }
        _ => (chapter, verse),
    }
}

/// A Greek-numbered reference, in Hebrew numbering.
pub fn greek_to_hebrew(chapter: i64, verse: i64, lengths: &Lengths) -> (i64, i64) {
    match chapter {
        1..=8 | 148..=150 => (chapter, verse),
        9 => {
            let extra = lengths.extra_before_nine();
            let first = (lengths.hebrew)(9);
            if verse <= extra {
                // The Greek's title verse. There is no Hebrew verse for it;
                // the psalm's opening is the nearest true thing to point at.
                (9, 1)
            } else if verse <= extra + first {
                (9, verse - extra)
            } else {
                (10, verse - extra - first)
            }
        }
        10..=112 | 116..=145 => (chapter + 1, verse),
        113 => {
            let first = (lengths.hebrew)(114);
            if verse <= first {
                (114, verse)
            } else {
                (115, verse - first)
            }
        }
        114 => (116, verse),
        115 => (116, verse + lengths.split_at(114)),
        146 => (147, verse),
        147 => (147, verse + lengths.split_at(146)),
        _ => (chapter, verse),
    }
}

/// The same reference in another module's numbering.
///
/// Only the Psalms differ, and only between the two systems — everything else
/// passes straight through, including a book both modules number the same way.
pub fn convert(
    from: Numbering,
    to: Numbering,
    book: i64,
    chapter: i64,
    verse: i64,
    lengths: &Lengths,
) -> (i64, i64) {
    if from == to || book != PSALMS {
        return (chapter, verse);
    }
    match to {
        Numbering::Greek => hebrew_to_greek(chapter, verse, lengths),
        Numbering::Hebrew => greek_to_hebrew(chapter, verse, lengths),
    }
}

/// One slide: a verse of the primary translation with the same words from
/// every other translation on screen, each under its own reference.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedRow {
    /// The primary's verse numbers on this slide — more than one only where
    /// another translation runs them together.
    pub verses: Vec<i64>,
    /// "23:1", or "23:1-2" where verses were joined.
    pub reference: String,
    pub text: String,
    pub others: Vec<AlignedOther>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedOther {
    /// The translation's name, for anything that needs to say which module
    /// this came from. The reference below reads better without it.
    pub name: String,
    /// What this module calls the book — "Псалми" beside the ESV's "Psalms".
    pub book: String,
    /// The verses in that module's own numbering — "9:1-2".
    pub reference: String,
    pub text: String,
    /// Whether that module numbers this passage differently from the primary.
    /// Both references are worth showing only when they disagree.
    pub shifted: bool,
}

/// A translation on screen beside the primary.
pub struct Other<'a> {
    pub name: String,
    /// This module's own name for the book being read.
    pub book: String,
    pub numbering: Numbering,
    /// Every verse of a chapter of the book being read, in order.
    pub verses: &'a dyn Fn(i64) -> Vec<(i64, String)>,
    /// Verses in a chapter of the *Psalms*, which is what the numbering maths
    /// needs — the joins are worked out from psalm lengths whatever book is
    /// actually on screen.
    pub length: &'a dyn Fn(i64) -> i64,
}

/// Lines up a chapter of the primary with the same passage in every other
/// translation, whichever way each of them numbers the Psalms.
///
/// Verses are joined onto one slide where another translation runs them
/// together, so a slide always carries the whole of what it is showing in
/// every language rather than half a sentence in one of them.
pub fn align(
    book: i64,
    chapter: i64,
    primary_numbering: Numbering,
    primary_length: &dyn Fn(i64) -> i64,
    primary_verses: &[(i64, String)],
    others: &[Other],
) -> Vec<AlignedRow> {
    // Every verse each translation has for each verse of the primary.
    //
    // Worked out by reading the other translation's verses and asking where
    // *they* belong, not only by mapping the primary's forwards. A verse the
    // primary does not have — the Greek numbers the superscription of Psalm 9,
    // the ESV folds it into verse 1 — has nothing mapping to it from this side
    // and would otherwise never be shown at all.
    struct Prepared {
        /// For each verse of the primary, the other's verses that belong with
        /// it: usually one, two where the other divides them differently.
        places: Vec<Vec<(i64, i64)>>,
        texts: BTreeMap<(i64, i64), String>,
    }

    let prepared: Vec<Prepared> = others
        .iter()
        .map(|other| {
            let lengths = lengths_for(primary_numbering, primary_length, other.length);
            let forward = |verse: i64| {
                convert(primary_numbering, other.numbering, book, chapter, verse, &lengths)
            };

            // The chapters of the other translation this one touches: one, or
            // two where a psalm is divided differently.
            let mut chapters: Vec<i64> =
                primary_verses.iter().map(|(verse, _)| forward(*verse).0).collect();
            chapters.dedup();

            let mut buckets: BTreeMap<i64, Vec<(i64, i64)>> = BTreeMap::new();
            let mut texts: BTreeMap<(i64, i64), String> = BTreeMap::new();
            for target in chapters {
                // Driven by the verses the module actually has, so nothing
                // depends on guessing how long a chapter is.
                for (verse, text) in (other.verses)(target) {
                    let (back_chapter, back_verse) = convert(
                        other.numbering,
                        primary_numbering,
                        book,
                        target,
                        verse,
                        &lengths,
                    );
                    if back_chapter == chapter {
                        buckets.entry(back_verse).or_default().push((target, verse));
                    }
                    texts.insert((target, verse), text);
                }
            }

            let places = primary_verses
                .iter()
                .map(|(verse, _)| {
                    buckets.get(verse).cloned().unwrap_or_else(|| vec![forward(*verse)])
                })
                .collect();
            Prepared { places, texts }
        })
        .collect();

    // A slide breaks wherever every translation agrees a new verse begins. Two
    // primary verses that share a verse in any translation stay together, or
    // that translation's words would be cut in half across two slides.
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for index in 0..primary_verses.len() {
        let joined = index > 0
            && prepared.iter().any(|other| {
                other.places[index].iter().any(|place| other.places[index - 1].contains(place))
            });
        match rows.last_mut() {
            Some(group) if joined => group.push(index),
            _ => rows.push(vec![index]),
        }
    }

    rows.into_iter()
        .map(|group| {
            let verses: Vec<i64> = group.iter().map(|i| primary_verses[*i].0).collect();
            let text = group
                .iter()
                .map(|i| primary_verses[*i].1.as_str())
                .collect::<Vec<_>>()
                .join(" ");

            let others = others
                .iter()
                .enumerate()
                .map(|(which, other)| {
                    let places: Vec<(i64, i64)> = dedup(
                        group.iter().flat_map(|i| prepared[which].places[*i].clone()).collect(),
                    );
                    let text = places
                        .iter()
                        .filter_map(|place| prepared[which].texts.get(place).cloned())
                        .collect::<Vec<_>>()
                        .join(" ");
                    // Simply whether the two references read differently.
                    // Comparing the first verse alone was not enough: one
                    // verse answered by two is 9:1 against 9:1-2, the same
                    // number to start with and a different passage — which is
                    // the very place both references need to be on screen.
                    let reference = label(&places);
                    let shifted = reference != span(chapter, &verses);
                    AlignedOther {
                        name: other.name.clone(),
                        book: other.book.clone(),
                        reference,
                        text,
                        shifted,
                    }
                })
                .collect();

            AlignedRow {
                reference: span(chapter, &verses),
                verses,
                text,
                others,
            }
        })
        .collect()
}

/// The lengths the mapping needs, whichever way round the two systems are.
fn lengths_for<'a>(
    primary: Numbering,
    primary_length: &'a dyn Fn(i64) -> i64,
    other_length: &'a dyn Fn(i64) -> i64,
) -> Lengths<'a> {
    match primary {
        Numbering::Hebrew => Lengths { hebrew: primary_length, greek: other_length },
        Numbering::Greek => Lengths { hebrew: other_length, greek: primary_length },
    }
}

fn dedup(mut places: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    places.dedup();
    places
}

fn span(chapter: i64, verses: &[i64]) -> String {
    match (verses.first(), verses.last()) {
        (Some(first), Some(last)) if first != last => format!("{chapter}:{first}-{last}"),
        (Some(only), _) => format!("{chapter}:{only}"),
        _ => chapter.to_string(),
    }
}

fn label(places: &[(i64, i64)]) -> String {
    match (places.first(), places.last()) {
        (Some((chapter, first)), Some((last_chapter, last))) if chapter == last_chapter => {
            if first == last {
                format!("{chapter}:{first}")
            } else {
                format!("{chapter}:{first}-{last}")
            }
        }
        // A slide that straddles two psalms in the other numbering.
        (Some((chapter, first)), Some((last_chapter, last))) => {
            format!("{chapter}:{first}-{last_chapter}:{last}")
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verse counts close to the real ones: the ESV for the Hebrew side, and
    /// Ogienko 1988 for the Greek, including its numbered superscription in
    /// Psalm 9.
    fn lengths() -> (impl Fn(i64) -> i64, impl Fn(i64) -> i64) {
        let hebrew = |ch: i64| match ch {
            9 => 20,
            10 => 18,
            114 => 8,
            115 => 18,
            116 => 19,
            147 => 20,
            150 => 6,
            _ => 10,
        };
        let greek = |ch: i64| match ch {
            9 => 39,
            113 => 26,
            114 => 9,
            115 => 10,
            146 => 11,
            147 => 9,
            150 => 6,
            _ => 10,
        };
        (hebrew, greek)
    }

    fn both(f: impl Fn(&Lengths)) {
        let (hebrew, greek) = lengths();
        f(&Lengths { hebrew: &hebrew, greek: &greek });
    }

    /// Psalm 9 verse 1, read in a Hebrew-numbered translation with a
    /// Greek-numbered one beside it.
    ///
    /// The Greek numbers the superscription as its own verse and the ESV folds
    /// it into verse 1, so one verse on the left answers to two on the right.
    /// Both have to be on the slide, and the reference has to say so.
    #[test]
    fn a_verse_answered_by_two_shows_both_and_says_so() {
        let (hebrew, greek) = lengths();
        // A Greek psalm 9 of 39 verses: a title, then the psalm.
        let greek_verses = |chapter: i64| -> Vec<(i64, String)> {
            if chapter == 9 {
                (1..=39).map(|v| (v, format!("greek {v}"))).collect()
            } else {
                Vec::new()
            }
        };
        let other = Other {
            name: "Ogienko 1988".into(),
            book: "Псалми".into(),
            numbering: Numbering::Greek,
            verses: &greek_verses,
            length: &greek,
        };

        let primary: Vec<(i64, String)> =
            (1..=20).map(|v| (v, format!("hebrew {v}"))).collect();
        let rows = align(PSALMS, 9, Numbering::Hebrew, &hebrew, &primary, &[other]);

        let first = &rows[0];
        assert_eq!(first.verses, vec![1], "the primary still shows one verse");
        assert_eq!(first.reference, "9:1");

        let beside = &first.others[0];
        assert_eq!(beside.reference, "9:1-2", "the title and the first line together");
        assert_eq!(beside.text, "greek 1 greek 2", "both verses are on the slide");
        assert_eq!(beside.book, "Псалми", "the module's own name for the book");
        assert!(beside.shifted, "the numbering differs, so both references show");

        // And the rest of the psalm stays one-for-one, one verse further on.
        assert_eq!(rows[1].others[0].reference, "9:3");
        assert_eq!(rows.last().unwrap().others[0].reference, "9:21");
    }

    #[test]
    fn psalm_nine_is_told_apart_by_its_length() {
        assert_eq!(detect(20), Numbering::Hebrew);
        assert_eq!(detect(39), Numbering::Greek);
    }

    /// Every boundary in the table, in both directions, including the verse
    /// either side of each join.
    #[test]
    fn the_joins_fall_where_the_psalter_puts_them() {
        both(|l| {
            for (hebrew, greek) in [
                // Untouched at either end of the Psalter.
                ((1, 1), (1, 1)),
                ((8, 9), (8, 9)),
                ((148, 1), (148, 1)),
                ((150, 6), (150, 6)),
                // Hebrew 9 and 10 are one psalm in the Greek, which also
                // numbers the title — so its verses run one further along.
                ((9, 1), (9, 2)),
                ((9, 20), (9, 21)),
                ((10, 1), (9, 22)),
                ((10, 18), (9, 39)),
                // One behind, all the way to 113.
                ((11, 1), (10, 1)),
                ((23, 1), (22, 1)),
                ((113, 9), (112, 9)),
                // Hebrew 114 and 115 are one psalm in the Greek.
                ((114, 1), (113, 1)),
                ((114, 8), (113, 8)),
                ((115, 1), (113, 9)),
                ((115, 18), (113, 26)),
                // Hebrew 116 is two psalms in the Greek.
                ((116, 9), (114, 9)),
                ((116, 10), (115, 1)),
                ((116, 19), (115, 10)),
                // One behind again.
                ((117, 1), (116, 1)),
                ((146, 10), (145, 10)),
                // Hebrew 147 is two psalms in the Greek.
                ((147, 11), (146, 11)),
                ((147, 12), (147, 1)),
                ((147, 20), (147, 9)),
            ] {
                assert_eq!(
                    hebrew_to_greek(hebrew.0, hebrew.1, l),
                    greek,
                    "Hebrew {}:{} should be Greek {}:{}",
                    hebrew.0,
                    hebrew.1,
                    greek.0,
                    greek.1
                );
                assert_eq!(
                    greek_to_hebrew(greek.0, greek.1, l),
                    hebrew,
                    "Greek {}:{} should be Hebrew {}:{}",
                    greek.0,
                    greek.1,
                    hebrew.0,
                    hebrew.1
                );
            }
        });
    }

    /// The Greek's title verse has no Hebrew counterpart; it points at the
    /// opening of the psalm rather than at nothing.
    #[test]
    fn the_greek_title_verse_points_at_the_psalms_opening() {
        both(|l| assert_eq!(greek_to_hebrew(9, 1, l), (9, 1)));
    }

    /// Round-tripping every verse of the Psalter returns where it started,
    /// apart from the one verse the Greek has and the Hebrew does not.
    #[test]
    fn every_verse_survives_the_round_trip() {
        both(|l| {
            for chapter in 1..=150 {
                for verse in 1..=((l.hebrew)(chapter)) {
                    let (gc, gv) = hebrew_to_greek(chapter, verse, l);
                    assert_eq!(
                        greek_to_hebrew(gc, gv, l),
                        (chapter, verse),
                        "Hebrew {chapter}:{verse} went to Greek {gc}:{gv} and came back wrong"
                    );
                }
            }
        });
    }

    #[test]
    fn nothing_outside_the_psalms_is_touched() {
        both(|l| {
            // John 3:16 is John 3:16 in both.
            assert_eq!(convert(Numbering::Hebrew, Numbering::Greek, 500, 3, 16, l), (3, 16));
            // And two modules in the same system are left alone.
            assert_eq!(convert(Numbering::Greek, Numbering::Greek, PSALMS, 23, 1, l), (23, 1));
        });
    }
}
