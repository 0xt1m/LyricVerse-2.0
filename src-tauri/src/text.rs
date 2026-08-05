//! Shared text handling: MyBible markup stripping and search normalisation.

use regex::Regex;
use std::sync::OnceLock;

/// Strips MyBible's inline markup so a verse renders as clean prose.
///
/// v1 applied these substitutions but left `<S>`/`<f>` fragments behind when a
/// tag spanned another tag; the patterns here are non-greedy and the final
/// sweep removes any stray angle-bracket tag that survived.
pub fn strip_markup(input: &str) -> String {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            // Strong's numbers, morphology, footnote markers: drop entirely.
            (Regex::new(r"(?is)<(S|m|f)>.*?</(S|m|f)>").unwrap(), ""),
            // Headings and pronunciation notes are editorial, not the verse.
            (Regex::new(r"(?is)<h>.*?</h>").unwrap(), ""),
            // Italics / words-of-Jesus / emphasis / transliteration: keep text.
            (Regex::new(r"(?is)<(i|J|e|t)>(.*?)</(i|J|e|t)>").unwrap(), "$2"),
            // Translator-supplied notes read better in brackets.
            (Regex::new(r"(?is)<n>(.*?)</n>").unwrap(), "[$1]"),
            // Line and page breaks become plain spaces.
            (Regex::new(r"(?i)<(br|pb)\s*/?>").unwrap(), " "),
            // Anything left over is markup we do not render.
            (Regex::new(r"<[^>]*>").unwrap(), ""),
        ]
    });

    let mut out = input.to_string();
    for (pattern, replacement) in patterns {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    collapse_whitespace(&out)
}

pub fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

/// Case-, accent- and punctuation-insensitive form used for every search in the
/// app. v1 hand-rolled a dozen `.replace()` calls per verse for the stressed
/// vowels; stripping the combining-mark range covers all of them and more.
pub fn normalize(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;

    for ch in input.chars() {
        // Combining diacriticals — Ukrainian bibles mark stress as `а` + U+0301.
        if matches!(ch, '\u{0300}'..='\u{036F}' | '\u{0483}'..='\u{0489}') {
            continue;
        }
        let ch = ch.to_lowercase().next().unwrap_or(ch);
        let ch = fold_confusable(ch);

        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch);
        } else {
            // Punctuation and whitespace alike collapse to a single space so
            // "Спасе́ння, — Господь!" matches "спасення господь".
            pending_space = true;
        }
    }
    out
}

/// Latin letters that are visually identical to Cyrillic ones are a constant
/// source of "why doesn't my search work" — typing `i` on an English layout
/// should still find `і`.
fn fold_confusable(ch: char) -> char {
    match ch {
        'i' => 'і',
        'a' => 'а',
        'e' => 'е',
        'o' => 'о',
        'c' => 'с',
        'p' => 'р',
        'x' => 'х',
        'y' => 'у',
        other => other,
    }
}

/// Same as [`normalize`] but also returns, for each character of the result,
/// the character index it came from in the input. Search highlighting needs to
/// map a hit found in normalised space back onto the text the user reads.
/// Computed only for the handful of verses actually returned as hits.
pub fn normalize_with_map(input: &str) -> (String, Vec<usize>) {
    let mut out = String::with_capacity(input.len());
    let mut map = Vec::with_capacity(input.len());
    let mut pending_space = false;

    for (index, ch) in input.chars().enumerate() {
        if matches!(ch, '\u{0300}'..='\u{036F}' | '\u{0483}'..='\u{0489}') {
            continue;
        }
        let lowered = ch.to_lowercase().next().unwrap_or(ch);
        let folded = fold_confusable(lowered);

        if folded.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
                map.push(index);
            }
            pending_space = false;
            out.push(folded);
            map.push(index);
        } else {
            pending_space = true;
        }
    }
    (out, map)
}

/// First non-empty line of a block, used for song list subtitles.
pub fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_mybible_markup() {
        let raw = "<pb/>На поча́тку Бог створив небо<f>[1]</f> та землю.";
        assert_eq!(strip_markup(raw), "На поча́тку Бог створив небо та землю.");
    }

    #[test]
    fn keeps_italic_content() {
        assert_eq!(strip_markup("і те́мрява <i>була</i> над"), "і те́мрява була над");
    }

    #[test]
    fn normalizes_stress_marks_and_punctuation() {
        assert_eq!(normalize("На поча́тку, Бог — створив!"), "на початку бог створив");
    }

    #[test]
    fn folds_latin_lookalikes() {
        // Typed on an English layout vs. a Ukrainian one — same search.
        assert_eq!(normalize("Icyc"), normalize("Ісус"));
        assert_eq!(normalize("1 Iв"), "1 ів");
    }
}
