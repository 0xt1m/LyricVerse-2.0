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
  return { id: `plan-${Date.now().toString(36)}`, name, entries: [], startsAt: "", updatedMs: 0 };
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

    // Neither a typed line nor a folder is something to show. The caller
    // checks before asking, so reaching here would mean one had been
    // double-clicked; either way there is nothing to open.
    case "custom":
    case "folder":
      return null;
  }
}

/**
 * The clock time each item begins at, and how long the plan runs.
 *
 * Items with no length of their own take no time: a plan half filled in still
 * gives sensible times for the parts somebody has thought about, rather than
 * pretending the rest are instant *and* refusing to add up.
 *
 * `startsAt` is "HH:MM". Without it there are no clock times — only lengths —
 * which is right for a plan that is a running order rather than a schedule.
 */
export function planTimes(plan: Plan): {
  /** Clock time per entry id, e.g. "10:05". Empty when the plan has no start. */
  at: Map<string, string>;
  /** Minutes per entry id — a folder's is what is under it. */
  runs: Map<string, number>;
  /** Total minutes of everything that has a length. */
  minutes: number;
  /** When the last item is expected to finish, or "" without a start time. */
  ends: string;
} {
  const at = new Map<string, string>();
  const runs = new Map<string, number>();
  const start = parseClock(plan.startsAt);
  let running = start ?? 0;
  let minutes = 0;

  /**
   * Lays out one line and everything nested under it, and says how long the
   * whole of it takes.
   *
   * A folder's own length wins when somebody has given it one: "Worship — 25
   * minutes" is a decision about the service, and what is inside fills that
   * time rather than deciding it. Adding both would count the same stretch
   * twice. With no length of its own, a folder is however long its contents
   * come to — including any folders among them.
   */
  const lay = (index: number, from: number): { length: number; next: number } => {
    const entry = plan.entries[index];
    if (!entry) return { length: 0, next: index + 1 };

    if (start !== null) at.set(entry.id, formatClock(from));

    let inside = 0;
    let cursor = index + 1;
    while (cursor < plan.entries.length && (plan.entries[cursor]?.depth ?? 0) > entry.depth) {
      const child = lay(cursor, from + inside);
      inside += child.length;
      cursor = child.next;
    }

    // A folder's own length wins when it has one; otherwise it is as long as
    // what is inside it. Everything else is simply its own length.
    const length =
      entry.kind === "folder" && cursor > index + 1
        ? entry.minutes > 0
          ? entry.minutes
          : inside
        : entry.minutes;
    runs.set(entry.id, length);
    return { length, next: cursor };
  };

  let index = 0;
  while (index < plan.entries.length) {
    const { length, next } = lay(index, running);
    running += length;
    minutes += length;
    index = next;
  }

  return { at, runs, minutes, ends: start === null ? "" : formatClock(running) };
}

/** "10:05" as minutes past midnight, or null when it is not a time. */
export function parseClock(value: string): number | null {
  const match = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClock(total: number): string {
  // Past midnight wraps rather than reading "25:10" — a late finish is still a
  // time of day.
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Moves an entry within a plan, and works out whether it landed in a folder.
 *
 * An item takes the company it now keeps: dropped under a folder, or among
 * things already inside one, it joins them; dropped under an ordinary line it
 * is ordinary again. That is what dragging it there meant, and it saves
 * reaching for the menu afterwards.
 *
 * What makes a line a folder is having something under it, not what kind of
 * line it is. A typed line with nothing under it — "Offering", "Communion" —
 * moves into a folder like anything else. One that holds items is a folder: it
 * brings its contents with it, because dragging "Worship" somewhere else and
 * leaving its songs behind is never what anybody meant, and it stays at the
 * top level, because the plan is one level deep.
 *
 * Pure, and separate from the store, so the rule can be run and checked
 * without a running app.
 */
export function reorderEntries(entries: PlanEntry[], from: number, to: number): PlanEntry[] {
  if (from < 0 || to < 0 || from >= entries.length || to >= entries.length || from === to) {
    return entries;
  }
  const moved = entries[from];
  if (!moved) return entries;

  // A folder takes its contents with it, however deep they go: dragging
  // "Worship" somewhere else and leaving its songs behind is never what
  // anybody meant. Nothing else holds anything, so nothing else has a block.
  let span = 1;
  if (moved.kind === "folder") {
    while (from + span < entries.length && (entries[from + span]?.depth ?? 0) > moved.depth) {
      span += 1;
    }
  }

  const rest = [...entries];
  const block = rest.splice(from, span);
  // Dropping below where it came from, the indices above it have closed up.
  const at = Math.max(0, Math.min(to > from ? to - span + 1 : to, rest.length));

  /*
   * Where it landed decides how deep it is.
   *
   * Dropped straight under a typed line, it goes inside it — that is what
   * dragging it there meant. Dropped under anything else, it keeps that
   * line company at the same level. Everything nested under the moved line
   * shifts with it, so a folder carried into another folder keeps its own
   * shape inside it.
   */
  // Dropped straight under a folder, it goes inside it. Dropped under
  // anything else it keeps that line company at the same level.
  const above = rest[at - 1];
  const depth = !above ? 0 : above.kind === "folder" ? above.depth + 1 : above.depth;
  const shift = depth - moved.depth;
  const landed = shift === 0
    ? block
    : block.map((entry) => ({ ...entry, depth: Math.max(0, entry.depth + shift) }));

  rest.splice(at, 0, ...landed);
  return rest;
}

/**
 * The lines nested directly inside a folder — its own children, not their
 * children.
 */
export function childrenOf(entries: PlanEntry[], index: number): PlanEntry[] {
  const parent = entries[index];
  if (!parent) return [];
  const out: PlanEntry[] = [];
  for (let i = index + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.depth <= parent.depth) break;
    if (entry.depth === parent.depth + 1) out.push(entry);
  }
  return out;
}

/** Whether anything at all is nested under this line. */
export function holdsItems(entries: PlanEntry[], index: number): boolean {
  const parent = entries[index];
  return !!parent && (entries[index + 1]?.depth ?? 0) > parent.depth;
}

/**
 * The slide holding a given verse.
 *
 * A chapter's slides are one per verse, but not always: a parallel reading
 * merges verses that another translation runs together, and a passage picked
 * as a range is a single slide. So the verse is looked for *inside* each
 * slide's span rather than matched to its number.
 *
 * -1 when the chapter does not hold it at all.
 */
export function slideForVerse(deck: Deck, verse: number): number {
  return deck.slides.findIndex((slide) => {
    const tail = slide.id.split(":").pop() ?? "";
    const numbers = tail.split(/[-–]/).map(Number).filter(Number.isFinite);
    if (numbers.length === 0) return false;
    return verse >= Math.min(...numbers) && verse <= Math.max(...numbers);
  });
}

/**
 * Moves several lines at once, keeping the order they were in.
 *
 * The lines picked out may be scattered through the plan; they arrive together
 * at the drop, in the order they had. Each folder among them still brings its
 * contents, and the group as a whole is shifted so its shallowest line sits at
 * the level it landed on — a set carried into a folder keeps its own shape
 * inside it.
 */
export function reorderSelection(entries: PlanEntry[], ids: string[], to: number): PlanEntry[] {
  const wanted = new Set(ids);
  if (wanted.size === 0) return entries;

  // Each picked line with whatever is nested under it, and the indices those
  // occupy — a folder inside the selection is not gathered twice.
  const taken = new Set<number>();
  const blocks: PlanEntry[][] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || taken.has(index) || !wanted.has(entry.id)) continue;
    let span = 1;
    if (entry.kind === "folder") {
      while (index + span < entries.length && (entries[index + span]?.depth ?? 0) > entry.depth) {
        span += 1;
      }
    }
    const block: PlanEntry[] = [];
    for (let step = 0; step < span; step += 1) {
      const member = entries[index + step];
      if (!member) break;
      taken.add(index + step);
      block.push(member);
    }
    blocks.push(block);
  }
  if (blocks.length === 0) return entries;

  const rest = entries.filter((_, index) => !taken.has(index));

  // Where the drop lands, once the moved lines are out of the way.
  const anchor = entries[to];
  const landing = anchor && !taken.has(to)
    ? rest.findIndex((entry) => entry.id === anchor.id)
    : rest.length;
  const at = Math.max(0, Math.min(landing < 0 ? rest.length : landing, rest.length));

  const above = rest[at - 1];
  const depth = !above ? 0 : above.kind === "folder" ? above.depth + 1 : above.depth;

  /*
   * Each picked line lands at the drop's level; what was inside it keeps its
   * shape.
   *
   * Shifting the whole group by one amount only works when the group is a
   * subtree. Lines picked from here and there are not: a song from inside a
   * folder and a line from outside it, dropped together, would leave the song
   * still indented under something that is no longer above it. So the shift is
   * worked out per block, from that block's own root.
   */
  const landed = blocks.flatMap((block) => {
    const root = block[0];
    if (!root) return block;
    const shift = depth - root.depth;
    return shift === 0
      ? block
      : block.map((entry) => ({ ...entry, depth: Math.max(0, entry.depth + shift) }));
  });

  return [...rest.slice(0, at), ...landed, ...rest.slice(at)];
}
