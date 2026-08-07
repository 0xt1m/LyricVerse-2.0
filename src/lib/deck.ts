import type {
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
    // The next slide with *words on it*, not simply the next slide. An empty
    // section is a deliberate blank in the running order, but telling the
    // platform "coming next: nothing" helps nobody — they need the line they
    // will actually be singing after it.
    nextUp: deck.slides.slice(index + 1).find((item) => item.part.trim() !== "")?.part ?? "",
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
): Deck {
  const title = `${book.longName} ${chapter}`;
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
