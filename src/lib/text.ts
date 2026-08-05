/**
 * Front-end mirror of `src-tauri/src/text.rs::normalize`, used for filtering
 * lists that are already in memory. Same rules: strip stress marks, fold the
 * Latin/Cyrillic look-alikes, drop punctuation, collapse whitespace.
 */

const CONFUSABLES: Record<string, string> = {
  i: "і",
  a: "а",
  e: "е",
  o: "о",
  c: "с",
  p: "р",
  x: "х",
  y: "у",
};

const COMBINING = /[̀-ͯ҃-҉]/g;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

export function normalize(input: string): string {
  const folded = input
    .normalize("NFD")
    .replace(COMBINING, "")
    .toLowerCase()
    .replace(/[iaeocpxy]/g, (ch) => CONFUSABLES[ch] ?? ch);
  return folded.replace(NON_ALNUM, " ").trim();
}

/** Splits `text` around a character range so the match can be highlighted. */
export function splitAt(text: string, start: number, end: number) {
  if (start < 0 || end <= start || start >= text.length) {
    return { before: text, match: "", after: "" };
  }
  return {
    before: text.slice(0, start),
    match: text.slice(start, Math.min(end, text.length)),
    after: text.slice(Math.min(end, text.length)),
  };
}
