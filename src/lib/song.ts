import type { LyricsDraft, Section } from "../api/types";

/**
 * Folds sections that say the same thing into one, repeated in the order.
 *
 * A song is held as a set of sections and an order that may name any of them
 * more than once — that is what makes a chorus sung three times one thing to
 * edit rather than three. The splitter only folds that way for lyrics with no
 * headings; given "[Chorus]" written out twice it takes them at their word and
 * returns two. Rewriting a song from the editor's words column goes through
 * exactly that path, so without this a chorus would quietly split in two the
 * first time somebody typed in it.
 *
 * Compared on the words alone, with spacing and case ignored, because that is
 * what "the same section" means to a singer. Empty sections never fold: two
 * blanks are two places waiting for different words.
 */
export function foldRepeats(draft: LyricsDraft): LyricsDraft {
  const keptFor = new Map<string, string>();
  const sections: Section[] = [];
  const rewritten = new Map<string, string>();

  for (const section of draft.sections) {
    const body = section.text.trim().replace(/\s+/g, " ").toLowerCase();
    const key = `${section.kind}:${body}`;
    const kept = body ? keptFor.get(key) : undefined;
    if (kept) {
      rewritten.set(section.id, kept);
      continue;
    }
    if (body) keptFor.set(key, section.id);
    rewritten.set(section.id, section.id);
    sections.push(section);
  }

  return { sections, order: draft.order.map((id) => rewritten.get(id) ?? id) };
}

/**
 * The roots a key can be picked from.
 *
 * Both spellings of each black note are offered rather than one chosen for
 * everybody: a band that writes E♭ does not want to read D♯ on its own sheet,
 * and which one is "right" depends on the song, not on us.
 */
export const KEY_ROOTS = [
  "C", "C♯", "D♭", "D", "D♯", "E♭", "E", "F",
  "F♯", "G♭", "G", "G♯", "A♭", "A", "A♯", "B♭", "B",
] as const;

/** Splits a stored key — "Am", "B♭", "F♯m" — into its root and its mode. */
export function splitKey(value: string): { root: string; minor: boolean } {
  const trimmed = value.trim();
  const minor = trimmed.endsWith("m") && trimmed.length > 1;
  return { root: minor ? trimmed.slice(0, -1) : trimmed, minor };
}
