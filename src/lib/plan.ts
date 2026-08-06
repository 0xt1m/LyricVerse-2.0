import { api } from "../api";
import type { Deck, Plan, PlanEntry, Settings, Track } from "../api/types";
import { bibleDeck, presentationDeck, songDeck, videoDeck, type ParallelTranslation } from "./deck";

/**
 * Turning a plan entry back into something projectable.
 *
 * The plan stores references, so this is where they are looked up again — a
 * song is re-read from its songbook, a passage re-fetched from its
 * translation. That is the whole point of storing references: what the plan
 * puts on screen on Sunday is the corrected song, not the one as it stood when
 * somebody added it on Thursday.
 *
 * Audio is the odd one out, as it is everywhere else in this app: a track does
 * not go to a screen, so it comes back as a track to play rather than a deck.
 */
export type PlanAction =
  | { kind: "deck"; deck: Deck }
  | { kind: "track"; track: Track };

let planSeq = 0;

/** Ids only have to be unique within one plan, and only for React's benefit. */
export function planEntryId(): string {
  return `entry-${Date.now().toString(36)}-${(planSeq += 1).toString(36)}`;
}

export function newPlan(name: string): Plan {
  return { id: `plan-${Date.now().toString(36)}`, name, entries: [], updatedMs: 0 };
}

/**
 * Looks an entry up in the library it came from.
 *
 * Returns null when the thing is no longer there — a song deleted, a clip
 * removed — which the caller reports rather than failing silently. The entry
 * stays in the plan either way: an operator wants to see that something is
 * missing, not to have the line quietly disappear the morning it is needed.
 */
export async function resolvePlanEntry(
  entry: PlanEntry,
  settings: Settings,
): Promise<PlanAction | null> {
  switch (entry.kind) {
    case "song": {
      const song = await api.getSong(entry.ref.songbook, entry.ref.songId);
      return song ? { kind: "deck", deck: songDeck(song, settings.language) } : null;
    }

    case "bible": {
      const { translation, book: bookNumber, chapter, start, end } = entry.ref;
      const books = await api.getBooks(translation);
      const book = books.find((candidate) => candidate.number === bookNumber);
      if (!book) return null;
      const verses = await api.getVerses(translation, bookNumber, chapter);

      // The parallel translations are read from the settings as they stand
      // now, not from the plan. Which translations sit side by side is a
      // property of how the service is being run today, not of the passage.
      const parallel: ParallelTranslation[] = [];
      for (const name of settings.secondaryTranslations) {
        if (!name || name === translation) continue;
        try {
          parallel.push({ name, verses: await api.getVerses(name, bookNumber, chapter) });
        } catch {
          // A translation removed since the plan was made is simply not shown
          // alongside; the passage itself is still perfectly projectable.
        }
      }

      const range = end > start ? { start, end } : null;
      return { kind: "deck", deck: bibleDeck(book, chapter, verses, range, parallel) };
    }

    case "presentation": {
      const found = (await api.listPresentations()).find(
        (item) => item.id === entry.ref.presentationId,
      );
      return found ? { kind: "deck", deck: presentationDeck(found) } : null;
    }

    case "video": {
      const found = (await api.listVideos()).find((item) => item.id === entry.ref.videoId);
      return found ? { kind: "deck", deck: videoDeck(found) } : null;
    }

    case "audio": {
      const found = (await api.listTracks()).find((item) => item.id === entry.ref.trackId);
      return found ? { kind: "track", track: found } : null;
    }
  }
}
