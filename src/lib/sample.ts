import type { LiveState } from "../api/types";

/**
 * Sample content for the layout editor.
 *
 * The editor previews the content type being arranged — showing lyrics while
 * the scripture layout is being edited would mean dragging boxes over text
 * that will never appear there.
 *
 * Each pool deliberately mixes lengths: a one-word chorus, a couple of normal
 * verses, and something long enough to stress the box. Cycling through them is
 * the fastest way to check that a layout survives real material, since the
 * body text auto-fits and a box that looks right for two words can be
 * unreadable for forty.
 */

interface SongSample {
  number: string;
  title: string;
  section: string;
  body: string;
}

interface BibleSample {
  book: string;
  chapter: number;
  verse: number;
  translation: string;
  body: string;
  /** A second translation of the same verse, for checking a parallel layout.
   *  Twice the text needs roughly twice the box, which is easy to forget
   *  until it is on the wall. */
  parallel?: { translation: string; body: string };
}

const SONGS: Record<string, SongSample[]> = {
  uk: [
    {
      number: "142",
      title: "Свята любов",
      section: "Приспів",
      body: "Свята любов Твоя, Господь,\nвіки не вичерпає глибина.",
    },
    {
      number: "7",
      title: "Велика Твоя вірність",
      section: "Куплет 2",
      body: "Велика Твоя вірність, о Боже мій!\nЩоранку нові Твої милості.",
    },
    { number: "3", title: "Алілуя", section: "Приспів", body: "Алілуя!" },
    {
      number: "358",
      title: "Як Ти великий",
      section: "Куплет 1",
      body:
        "Господь мій Бог! Коли на світ дивлюся,\n" +
        "на все, що Ти створив рукою Свою,\n" +
        "на зорі ввись, що ними світ милує,\n" +
        "і як Твій голос чути в громах гуде.",
    },
  ],
  en: [
    {
      number: "142",
      title: "Amazing Grace",
      section: "Verse 1",
      body: "Amazing grace, how sweet the sound,\nthat saved a wretch like me.",
    },
    {
      number: "7",
      title: "Great Is Thy Faithfulness",
      section: "Chorus",
      body: "Great is Thy faithfulness!\nMorning by morning new mercies I see.",
    },
    { number: "3", title: "Hallelujah", section: "Chorus", body: "Hallelujah!" },
    {
      number: "358",
      title: "How Great Thou Art",
      section: "Verse 1",
      body:
        "O Lord my God, when I in awesome wonder\n" +
        "consider all the worlds Thy hands have made,\n" +
        "I see the stars, I hear the rolling thunder,\n" +
        "Thy power throughout the universe displayed.",
    },
  ],
};

const VERSES: Record<string, BibleSample[]> = {
  uk: [
    {
      book: "Вiд Iвана",
      chapter: 3,
      verse: 16,
      translation: "Ogienko 1988",
      body:
        "Так бо Бог полюбив світ, що дав Сина Свого Однородженого, " +
        "щоб кожен, хто вірує в Нього, не згинув, але мав життя вічне.",
    },
    {
      book: "Псалми",
      chapter: 23,
      verse: 1,
      translation: "Ogienko 1988",
      body: "Господь то мій Пастир, тому в недостатку не буду.",
    },
    {
      book: "Вiд Матвiя",
      chapter: 5,
      verse: 3,
      translation: "Ogienko 1962",
      body: "Блаженні вбогі духом, бо їхнє Царство Небесне.",
      parallel: {
        translation: "King James Version",
        body: "Blessed are the poor in spirit: for theirs is the kingdom of heaven.",
      },
    },
    {
      book: "Римлян",
      chapter: 8,
      verse: 38,
      translation: "Ogienko 1988",
      body:
        "Бо я пересвідчився, що ні смерть, ні життя, ні Анголи, ні влади, " +
        "ні теперішнє, ні майбутнє, ні сили, ні висота, ні глибина, ані інше " +
        "яке створіння не зможе відлучити нас від любови Божої, яка в Христі " +
        "Ісусі, Господі нашім!",
    },
  ],
  en: [
    {
      book: "John",
      chapter: 3,
      verse: 16,
      translation: "King James Version",
      body:
        "For God so loved the world, that he gave his only begotten Son, " +
        "that whosoever believeth in him should not perish, but have everlasting life.",
    },
    {
      book: "Psalms",
      chapter: 23,
      verse: 1,
      translation: "King James Version",
      body: "The LORD is my shepherd; I shall not want.",
    },
    {
      book: "Matthew",
      chapter: 5,
      verse: 3,
      translation: "King James Version",
      body: "Blessed are the poor in spirit: for theirs is the kingdom of heaven.",
      parallel: {
        translation: "Ogienko 1988",
        body: "Блаженні вбогі духом, бо їхнє Царство Небесне.",
      },
    },
    {
      book: "Romans",
      chapter: 8,
      verse: 38,
      translation: "King James Version",
      body:
        "For I am persuaded, that neither death, nor life, nor angels, nor " +
        "principalities, nor powers, nor things present, nor things to come, " +
        "nor height, nor depth, nor any other creature, shall be able to " +
        "separate us from the love of God, which is in Christ Jesus our Lord.",
    },
  ],
};

/** How many samples each pool holds, so the caller can cycle through them. */
export const SAMPLE_COUNT = 4;

function pool<T>(table: Record<string, T[]>, language: string): T[] {
  return table[language] ?? table.en!;
}

/** The following sample, so a "next up" element has something to show. */
function t_next(kind: "song" | "bible" | "media" | "timer", language: string, variant: number): string {
  const items = kind === "bible" ? pool(VERSES, language) : pool(SONGS, language);
  const next = items[(Math.abs(variant) + 1) % items.length]!;
  return next.body.split("\n")[0] ?? next.body;
}

export function sampleLive(
  kind: "song" | "bible" | "media" | "timer",
  language: string,
  variant = 0,
): LiveState {
  if (kind === "timer") {
    // The digits come from the timer itself; the body is the optional caption
    // underneath, so the editor shows something to position.
    return {
      kind: "timer",
      bodyPart: language === "uk" ? "Служба починається" : "The service is about to begin",
      title: "",
      number: "",
      sectionLabel: "",
      reference: "",
      translation: "",
      nextUp: "",
      sectionKind: "",
      mediaPath: null,
      youtubeId: null,
      revision: 0,
    };
  }

  if (kind === "media") {
    // Shown as a message slide, because that is the only part of this layout
    // with words to arrange — a picture or a clip fills the screen itself.
    return {
      kind: "message",
      bodyPart:
        language === "uk"
          ? "Ласкаво просимо!\nЗустріч молоді — у пʼятницю о 18:00"
          : "Welcome!\nYouth meeting — Friday at 6pm",
      title: "",
      number: "",
      sectionLabel: "",
      reference: "",
      translation: "",
      nextUp: "",
      sectionKind: "",
      mediaPath: null,
      youtubeId: null,
      revision: 0,
    };
  }

  if (kind === "bible") {
    const items = pool(VERSES, language);
    const sample = items[Math.abs(variant) % items.length]!;
    // A parallel sample is composed exactly as the deck composes a real one:
    // the translations stacked with a blank line between them.
    const body = sample.parallel
      ? `${sample.body}\n\n${sample.parallel.body}`
      : sample.body;
    const translation = sample.parallel
      ? `${sample.translation} · ${sample.parallel.translation}`
      : sample.translation;

    return {
      kind: "bible",
      bodyPart: body,
      title: sample.book,
      number: String(sample.verse),
      sectionLabel: "",
      reference: `${sample.book} ${sample.chapter}:${sample.verse}`,
      translation,
      nextUp: t_next(kind, language, variant),
      sectionKind: "scripture",
      mediaPath: null,
      youtubeId: null,
      revision: 0,
    };
  }

  const items = pool(SONGS, language);
  const sample = items[Math.abs(variant) % items.length]!;
  return {
    kind: "song",
    bodyPart: sample.body,
    title: sample.title,
    number: sample.number,
    sectionLabel: sample.section,
    reference: `${sample.number} · ${sample.title}`,
    translation: "",
    nextUp: t_next(kind, language, variant),
    sectionKind: "chorus",
    mediaPath: null,
    youtubeId: null,
    revision: 0,
  };
}
