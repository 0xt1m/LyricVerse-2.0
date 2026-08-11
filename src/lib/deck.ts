import type {
  AlignedRow,
  BookInfo,
  Deck,
  DeckSlide,
  LiveState,
  Presentation,
  Section,
  Song,
  VerseRow,
  Video,
} from "../api/types";
import { sectionLabel } from "./i18n";

/**
 * Compiles a song into the slide list the operator drives.
 *
 * v1 flattened the song differently depending on whether *any* screen happened
 * to be in stream mode, then had the standard screens reach back into a
 * parallel `song_lines` array to recover the section they belonged to. Here
 * each slide always carries both forms, so a screen just picks the one it
 * needs and the two modes can never drift apart.
 */
/**
 * The output a slide would produce.
 *
 * Used both to project a slide and to show the operator what the next key
 * press will do, so the "Next" preview cannot disagree with what actually
 * happens when they press it.
 */
export function slideToLive(
  deck: Deck,
  index: number,
  /** Names every translation on screen; ignored outside scripture. */
  translationLabel: string,
): Omit<LiveState, "revision"> | null {
  const slide = deck.slides[index];
  if (!slide) return null;
  const next = deck.slides
    .slice(index + 1)
    .find((item) => item.part.trim() !== "" || item.mediaPath);
  return {
    kind: slide.liveKind ?? deck.source,
    bodyPart: slide.part,
    title: slide.title,
    number: slide.number,
    sectionLabel: slide.sectionLabel,
    reference: slide.reference,
    translation: deck.source === "bible" ? translationLabel : "",
    // What a confidence screen shows underneath the current words.
    //
    // The next slide with *something on it*, not simply the next slide. An
    // empty section is a deliberate blank in the running order, but telling
    // the platform "coming next: nothing" helps nobody — they need the line
    // they will actually be singing after it. For a deck of pictures that
    // something is the picture, which is why both travel.
    // Carried straight through: a bible slide built by `alignedDeck`
    // knows each translation's own reference, and only the display
    // decides whether to draw them under the words.
    passages: slide.passages ?? [],
    nextUp: next?.part.trim() ? next.part : "",
    nextMediaPath: next?.mediaPath ?? null,
    sectionKind: slide.kind,
    mediaPath: slide.mediaPath ?? null,
    youtubeId: slide.youtubeId ?? null,
    cameraDeviceId: slide.cameraDeviceId ?? null,
  };
}

export function songDeck(song: Song, language: string): Deck {
  const byId = new Map(song.sections.map((section) => [section.id, section]));
  const labels = buildLabels(song.sections, song.order, language);
  const slides: DeckSlide[] = [];

  song.order.forEach((sectionId, position) => {
    const section = byId.get(sectionId);
    if (!section) return;

    const label = labels.get(sectionId) ?? "";
    const groupId = `${position}:${sectionId}`;
    const fields = {
      title: song.title,
      number: String(song.id),
      sectionLabel: label,
      reference: `${song.id} · ${song.title}`,
    };
    slides.push({
      id: groupId,
      label,
      kind: section.kind,
      part: section.text,
      ...fields,
      groupId,
    });
  });

  return { source: "song", key: `song:${song.id}`, title: `${song.id} · ${song.title}`, slides };
}

/** "Куплет 1", "Куплет 2", "Приспів" — numbered only when there is more than one. */
function buildLabels(
  sections: Section[],
  order: string[],
  language: string,
): Map<string, string> {
  const totals = new Map<string, number>();
  for (const section of sections) {
    totals.set(section.kind, (totals.get(section.kind) ?? 0) + 1);
  }

  const ordinals = new Map<string, number>();
  const labels = new Map<string, string>();
  // Number by first appearance in the running order, not by array position, so
  // a chorus-first arrangement still reads "Куплет 1, Куплет 2".
  const seen = new Set<string>();
  const sequence = [...order, ...sections.map((s) => s.id)];

  for (const id of sequence) {
    if (seen.has(id)) continue;
    seen.add(id);
    const section = sections.find((candidate) => candidate.id === id);
    if (!section) continue;
    const ordinal = (ordinals.get(section.kind) ?? 0) + 1;
    ordinals.set(section.kind, ordinal);
    labels.set(
      id,
      section.label?.trim() ||
        sectionLabel(language, section.kind, ordinal, totals.get(section.kind) ?? 1),
    );
  }
  return labels;
}

/** A translation shown beneath the main one, for a parallel reading. */
export interface ParallelTranslation {
  name: string;
  verses: VerseRow[];
}

/**
 * Joins the same verses from every chosen translation into one block.
 *
 * Verses line up by number, which is safe because MyBible modules share the
 * same book and verse numbering. A translation missing that verse simply
 * contributes nothing rather than shifting the others out of step.
 */
/**
 * A deck from an already-aligned chapter.
 *
 * Each slide carries the whole of what it shows in every language: where one
 * translation runs two verses together, both are on the slide rather than half
 * a sentence in one of them. The reference names both numbers whenever the
 * translations disagree, which in the Psalms is most of the way through.
 */
function alignedDeck(
  book: BookInfo,
  chapter: number,
  title: string,
  rows: AlignedRow[],
  range: { start: number; end: number } | null,
): Deck {
  const body = (row: AlignedRow) =>
    [row.text, ...row.others.map((other) => other.text)]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");

  /**
   * "Psalms 23:1 · Псалми 22:1 · Псалтирь 22:1" — one reference per
   * translation on screen, in that translation's own words.
   *
   * Every one of them, not only the ones numbered differently: a reader
   * follows the reference in their own language, and "Псалми 22:1" is what
   * they can look up whether or not it happens to match the English. The book
   * name comes from the module rather than the module's own name, because
   * "Ogienko 1988 22:1" is not a reference anybody can find in a Bible.
   *
   * Identical strings are dropped, so two English modules do not print the
   * same reference twice.
   */
  const reference = (row: AlignedRow) => {
    const parts = [`${book.longName} ${row.reference}`.trim()];
    for (const other of row.others) {
      const text = `${other.book} ${other.reference}`.trim();
      if (text && !parts.includes(text)) parts.push(text);
    }
    return parts.join(" · ");
  };

  if (range && range.end > range.start) {
    const inRange = rows.filter((row) =>
      row.verses.some((verse) => verse >= range.start && verse <= range.end),
    );
    const first = inRange[0];
    const last = inRange[inRange.length - 1];
    return {
      source: "bible",
      key: `bible:${book.number}:${chapter}`,
      title,
      slides: [
        {
          id: `${book.number}:${chapter}:${range.start}-${range.end}`,
          label: `${range.start}–${range.end}`,
          kind: "scripture",
          // Each translation's own run of the passage, kept together rather
          // than interleaved verse by verse.
          part: [
            inRange.map((row) => row.text).join(" "),
            ...(first?.others ?? []).map((_, which) =>
              inRange.map((row) => row.others[which]?.text ?? "").join(" ").trim(),
            ),
          ]
            .filter((part) => part.trim())
            .join("\n\n"),
          title: book.longName,
          number: `${range.start}–${range.end}`,
          sectionLabel: "",
          reference: rangeReference(book, chapter, range, first, last),
          groupId: "range",
        },
      ],
    };
  }

  return {
    source: "bible",
    key: `bible:${book.number}:${chapter}`,
    title,
    slides: rows.map((row) => ({
      id: `${book.number}:${chapter}:${row.verses.join("-")}`,
      // Each translation's words with its own reference, for a screen that
      // puts them under the passage rather than in one line of its own.
      passages: [
        { text: row.text, reference: `${book.longName} ${row.reference}`.trim() },
        ...row.others
          .filter((other) => other.text.trim())
          .map((other) => ({
            text: other.text,
            reference: `${other.book} ${other.reference}`.trim(),
          })),
      ],
      label: row.verses.length > 1 ? row.verses.join("–") : String(row.verses[0] ?? ""),
      kind: "scripture" as const,
      part: body(row),
      summary: row.text,
      title: book.longName,
      number: row.verses.length > 1 ? row.verses.join("–") : String(row.verses[0] ?? ""),
      sectionLabel: "",
      reference: reference(row),
      groupId: `${row.verses[0] ?? 0}`,
    })),
  };
}

/**
 * The reference for a passage of several verses, in every translation on
 * screen: "Psalms 23:1-3 · Псалми 22:1-3".
 *
 * Built from the first and last slides of the selection rather than from the
 * primary's verse numbers, because the other translations may number them
 * differently at either end.
 */
function rangeReference(
  book: BookInfo,
  chapter: number,
  range: { start: number; end: number },
  first: AlignedRow | undefined,
  last: AlignedRow | undefined,
): string {
  const parts = [`${book.longName} ${chapter}:${range.start}-${range.end}`];
  first?.others.forEach((other, which) => {
    const opening = other.reference;
    const closing = last?.others[which]?.reference ?? opening;
    // "22:1" and "22:5-6" become "22:1-6"; a selection that crosses a psalm
    // boundary keeps both halves rather than pretending it did not.
    const [openChapter, openVerse] = opening.split(":");
    const [closeChapter, closeVerses] = closing.split(":");
    const closeVerse = (closeVerses ?? "").split("-").pop() ?? "";
    const span =
      openChapter === closeChapter
        ? `${openChapter}:${openVerse?.split("-")[0] ?? ""}-${closeVerse}`
        : `${opening}-${closing}`;
    const text = `${other.book} ${span}`.trim();
    if (text && !parts.includes(text)) parts.push(text);
  });
  return parts.join(" · ");
}

function composeText(
  primary: string,
  parallel: ParallelTranslation[],
  pick: (verses: VerseRow[]) => string,
): string {
  const blocks = [primary];
  for (const other of parallel) {
    const text = pick(other.verses).trim();
    if (text) blocks.push(text);
  }
  return blocks.join("\n\n");
}

/**
 * A chapter becomes one slide per verse. Selecting a range collapses those
 * verses into a single slide so they go up together.
 */
export function bibleDeck(
  book: BookInfo,
  chapter: number,
  verses: VerseRow[],
  range: { start: number; end: number } | null,
  parallel: ParallelTranslation[] = [],
  /**
   * The chapter already lined up across the translations on screen.
   *
   * Present whenever more than one translation is showing. It matters most in
   * the Psalms, where the Hebrew and Greek number differently for most of the
   * Psalter, so "the same chapter" in two modules can be two different psalms
   * — the backend maps the passage rather than trusting the number.
   */
  aligned: AlignedRow[] | null = null,
): Deck {
  const title = `${book.longName} ${chapter}`;
  if (aligned && aligned.length > 0) {
    return alignedDeck(book, chapter, title, aligned, range);
  }
  const joinRange = (rows: VerseRow[], from: number, to: number) =>
    rows
      .filter((v) => v.verse >= from && v.verse <= to)
      .map((v) => v.text)
      .join(" ");

  if (range && range.end > range.start) {
    const inRange = verses.filter((v) => v.verse >= range.start && v.verse <= range.end);
    const primary = inRange.map((v) => v.text).join(" ");
    const text = composeText(primary, parallel, (rows) =>
      joinRange(rows, range.start, range.end),
    );
    const reference = `${book.longName} ${chapter}:${range.start}-${range.end}`;
    return {
      source: "bible",
      key: `bible:${book.number}:${chapter}`,
      title,
      slides: [
        {
          id: `${book.number}:${chapter}:${range.start}-${range.end}`,
          label: `${range.start}–${range.end}`,
          kind: "scripture",
          part: text,
          title: book.longName,
          number: `${range.start}–${range.end}`,
          sectionLabel: "",
          reference,
          groupId: "range",
        },
      ],
    };
  }

  return {
    source: "bible",
    key: `bible:${book.number}:${chapter}`,
    title,
    slides: verses.map((verse) => ({
      id: `${book.number}:${chapter}:${verse.verse}`,
      // One translation is still a passage with a reference, so a screen set
      // to put references under the words does so here too.
      passages: [
        {
          text: verse.text,
          reference: `${book.longName} ${chapter}:${verse.verse}`,
        },
        ...parallel.map((other) => ({
          text: other.verses.find((row) => row.verse === verse.verse)?.text ?? "",
          reference: `${other.name} ${chapter}:${verse.verse}`,
        })),
      ].filter((passage) => passage.text.trim()),
      label: String(verse.verse),
      kind: "scripture" as const,
      part: composeText(
        verse.text,
        parallel,
        (rows) => rows.find((row) => row.verse === verse.verse)?.text ?? "",
      ),
      summary: verse.text,
      title: book.longName,
      number: String(verse.verse),
      sectionLabel: "",
      reference: `${book.longName} ${chapter}:${verse.verse}`,
      groupId: `${verse.verse}`,
    })),
  };
}


/**
 * A presentation is a deck of images, so it drives the same transport, the
 * same keyboard shortcuts and the same preview as a song does.
 */
export function presentationDeck(presentation: Presentation): Deck {
  return {
    source: "image",
    key: `presentation:${presentation.id}`,
    title: presentation.name,
    slides: presentation.slides.map((slide, index) => ({
      id: `${presentation.id}:${slide.file}`,
      label: String(index + 1),
      kind: "other" as const,
      // A message slide carries words and no picture, and asks to be drawn
      // with the text layout rather than filling the screen with an image.
      part: slide.text ?? "",
      title: presentation.name,
      number: String(index + 1),
      sectionLabel: "",
      reference: presentation.name,
      groupId: presentation.id,
      ...(slide.text === null
        ? { mediaPath: slide.path }
        : { liveKind: "message" as const, mediaPath: null }),
    })),
  };
}

/** A clip is a one-slide deck — showing it is just going live on slide one. */
export function videoDeck(video: Video): Deck {
  return {
    source: "video",
    key: `video:${video.id}`,
    title: video.name,
    slides: [
      {
        id: video.id,
        label: video.name,
        kind: "other",
        part: "",
        title: video.name,
        number: "",
        sectionLabel: "",
        reference: video.name,
        groupId: video.id,
        mediaPath: video.path,
        youtubeId: video.youtubeId,
        looping: video.looping,
      },
    ],
  };
}


/**
 * The timer as the content itself, for a foyer screen counting down to the
 * start. A one-slide deck, so showing and blanking it work exactly like any
 * other item.
 */
/**
 * A live camera, as something to show.
 *
 * One slide, like a clip: there is nothing to step through. The picture itself
 * never travels — the deck carries only which camera to open, and each screen
 * opens it locally.
 */
export function cameraDeck(deviceId: string, name: string): Deck {
  return {
    source: "camera",
    key: `camera:${deviceId || "default"}`,
    title: name,
    slides: [
      {
        id: deviceId || "default",
        label: name,
        kind: "other",
        part: "",
        title: name,
        number: "",
        sectionLabel: "",
        reference: name,
        groupId: deviceId || "default",
        cameraDeviceId: deviceId,
      },
    ],
  };
}

export function timerDeck(caption: string, title: string): Deck {
  return {
    source: "timer",
    key: "timer",
    title,
    slides: [
      {
        id: "timer",
        label: title,
        kind: "other",
        // The digits are drawn by the timer element; this is the caption.
        part: caption,
        title,
        number: "",
        sectionLabel: "",
        reference: "",
        groupId: "timer",
      },
    ],
  };
}
