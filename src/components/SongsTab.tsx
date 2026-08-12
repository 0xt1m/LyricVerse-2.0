import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type {
  Section,
  Song,
  SongFormat,
  SongSummary,
} from "../api/types";
import { useStore } from "../app/store";
import { songDeck } from "../lib/deck";
import { useGridReorder } from "../lib/dragReorder";
import { sectionLabel } from "../lib/i18n";
import { useTileSelection } from "../lib/selection";
import { normalize } from "../lib/text";
import { Icon } from "./ui/Icon";
import { Empty, SearchInput, useScrollIntoView } from "./ui/controls";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";
import { SongDialog } from "./SongDialog";
import { SongbookManager } from "./SongbookManager";

/** Long enough that typing does not thrash the disk, short enough to be safe. */

/**
 * Songs, edited in place.
 *
 * There is no separate edit window: the grid *is* the running order, tiles are
 * dragged to reorder, E (or right-click) edits the words of the highlighted
 * one, and the tile at the end adds a section. Everything saves itself, so
 * there is no dialog to remember to confirm before a service starts.
 */
export function SongsTab() {
  const t = useStore((s) => s.t);
  const settings = useStore((s) => s.settings);
  const songbooks = useStore((s) => s.songbooks);
  const addToPlan = useStore((s) => s.addToPlan);
  const libraryRevision = useStore((s) => s.libraryRevision);
  const openMenu = useContextMenu();
  const songCommand = useStore((s) => s.songCommand);
  const clearSongCommand = useStore((s) => s.clearSongCommand);
  const deck = useStore((s) => s.deck);
  const cursor = useStore((s) => s.cursor);
  const liveIndex = useStore((s) => s.liveIndex);
  const patchSettings = useStore((s) => s.patchSettings);
  const refreshLibrary = useStore((s) => s.refreshLibrary);
  const loadDeck = useStore((s) => s.loadDeck);
  const go = useStore((s) => s.go);
  const select = useStore((s) => s.select);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);

  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [query, setQuery] = useState("");
  const bookmarks = useStore((s) => s.bookmarks);
  const remember = useStore((s) => s.remember);
  const [selectedId, setSelectedId] = useState<number | null>(bookmarks.songs.songId);
  const openRequest = useStore((s) => s.openRequest);
  const clearOpenRequest = useStore((s) => s.clearOpenRequest);

  // Opened from the plan. The songbook is switched too, since a plan may point
  // at a song in a book the operator does not currently have open.
  useEffect(() => {
    if (openRequest?.kind !== "song") return;
    const { songbook: wanted, songId } = openRequest.ref;
    if (wanted && wanted !== settings.activeSongbook) void patchSettings({ activeSongbook: wanted });
    setSelectedId(songId);
    clearOpenRequest();
  }, [openRequest, settings.activeSongbook, patchSettings, clearOpenRequest]);
  const [song, setSong] = useState<Song | null>(null);
  const [managing, setManaging] = useState(false);
  /** The song being written in the dialog: a new one, or one being rewritten. */
  const [composing, setComposing] = useState<{ song: Song | null } | null>(null);
  /**
   * Which half of the tab Delete belongs to.
   *
   * The list and the editor both hold a selection, and Delete means something
   * different in each — a song, or a section of one. Whichever was last
   * pressed is the one being worked in, which is the same rule a file manager
   * uses for a sidebar and a folder view.
   */
  const [pane, setPane] = useState<"list" | "grid">("list");
  const searchRef = useRef<HTMLInputElement>(null);
  /** The last copy made here, so pasting works even where the platform
   *  refuses to let a page read the clipboard. */
  const copied = useRef<string | null>(null);
  const dialogs = useDialogs();

  const songbook =
    settings.activeSongbook && songbooks.some((b) => b.name === settings.activeSongbook)
      ? settings.activeSongbook
      : (songbooks[0]?.name ?? null);


  // --- Auto-save ---------------------------------------------------------
  // The song is edited locally and written behind a debounce. A pending write
  // is flushed before switching away, so nothing is lost in transit.
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSave = useRef<{ songbook: string; song: Song } | null>(null);

  const flushSave = useCallback(async () => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    const pending = pendingSave.current;
    pendingSave.current = null;
    if (!pending) return;
    try {
      await api.saveSong(pending.songbook, pending.song);
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  useEffect(() => () => void flushSave(), [flushSave]);

  /** The song as it is right now, for the splitter's delayed callback — by the
   *  time it runs, the closed-over `song` may be a version behind. */
  const songRef = useRef<Song | null>(null);
  songRef.current = song;

  useEffect(() => {
    remember("songs", { songId: selectedId });
  }, [selectedId, remember]);

  // --- Loading -----------------------------------------------------------

  useEffect(() => {
    if (songbook && songbook !== settings.activeSongbook) {
      void patchSettings({ activeSongbook: songbook });
    }
  }, [songbook, settings.activeSongbook, patchSettings]);

  useEffect(() => {
    if (!songbook) {
      setSongs([]);
      return;
    }
    let cancelled = false;
    api
      .listSongs(songbook)
      .then((list) => !cancelled && setSongs(list))
      .catch((error) => !cancelled && reportError(error));
    return () => {
      cancelled = true;
    };
  }, [songbook, libraryRevision, reportError]);

  // Deliberately not keyed on `libraryRevision`: our own saves bump it, and
  // reloading mid-edit would clobber whatever is being typed.
  useEffect(() => {
    if (selectedId === null || !songbook) {
      setSong(null);
      return;
    }
    let cancelled = false;
    void flushSave().then(() =>
      api
        .getSong(songbook, selectedId)
        .then((loaded) => !cancelled && setSong(loaded))
        .catch((error) => {
          if (cancelled) return;
          setSong(null);
          reportError(error);
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [songbook, selectedId, reportError, flushSave]);

  useEffect(() => {
    if (!song) return;
    void loadDeck(songDeck(song, settings.language));
  }, [song, settings.language, loadDeck]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      // A dialog is in front of the tab and owns the keyboard while it is
      // there — Enter on its Create button must not also put a slide up.
      if (document.querySelector(".overlay")) return;

      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.select();
        return;
      }
      // Enter is the second half of "choose, then show": whatever is
      // highlighted goes to the screens.
      if (event.key === "Enter" && song && deck?.source === "song") {
        event.preventDefault();
        void go(cursor);
        return;
      }
      // `code` rather than `key`, so it is the same physical key whichever
      // keyboard layout is active — on a Ukrainian layout this is "у".
      if (event.code === "KeyE" && song && deck?.source === "song") {
        event.preventDefault();
        setComposing({ song });
        return;
      }

    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [song, deck, cursor, go]);

  /**
   * v1 re-ran a `SELECT *` and JSON-parsed every song on each keystroke, and
   * matched only against couplets + chorus — so searching by title silently
   * failed. Here the list is already in memory and number, title and opening
   * line are all searchable.
   */
  /**
   * How long the open song runs, in minutes.
   *
   * Kept in the settings rather than in the songbook: those files are the v1
   * format the old app still opens. A song nobody has timed has no entry, and
   * goes into a plan with no length rather than with a guess.
   */
  const songMinutes = songbook ? (settings.songMinutes[songbook] ?? {}) : {};

  /**
   * The key the open song is played in.
   *
   * Free text, and stored beside the minutes rather than in the songbook, for
   * the same reasons: a band writes "Am", "B♭" or "capo 2", and the songbook
   * files are still opened by v1. Blanking the field takes the entry away
   * rather than storing an empty string.
   */
  const songKeys = songbook ? (settings.songKeys[songbook] ?? {}) : {};

  /**
   * The tempo it is played at, in beats per minute.
   *
   * Clamped to something a band could actually count: a stray keypress that
   * stored 7000 would sit on the row looking like data. Blanking it, or
   * anything that is not a number, takes the entry away.
   */
  const songBpm = songbook ? (settings.songBpm[songbook] ?? {}) : {};

  /** This songbook's favourites. Ids, so a rename never loses them. */
  const favourites = useMemo(
    () => new Set(songbook ? (settings.favouriteSongs[songbook] ?? []) : []),
    [settings.favouriteSongs, songbook],
  );

  const toggleFavourite = useCallback(
    (id: number) => {
      if (!songbook) return;
      const current = settings.favouriteSongs[songbook] ?? [];
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      void patchSettings({
        favouriteSongs: { ...settings.favouriteSongs, [songbook]: next },
      });
    },
    [songbook, settings.favouriteSongs, patchSettings],
  );

  /**
   * The order the operator dragged this book into, when they have.
   *
   * A song added since — or one the order has never heard of — keeps its
   * place at the end in number order, rather than jumping to the top because
   * it is missing from a list it was never in.
   */
  const arranged = useMemo(() => {
    const wanted = songbook ? settings.songOrder[songbook] : undefined;
    if (!wanted?.length) return songs;
    const rank = new Map(wanted.map((id, index) => [id, index]));
    return [...songs].sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.id - b.id,
    );
  }, [songs, songbook, settings.songOrder]);

  const filtered = useMemo(() => {
    const raw = query.trim();
    if (!raw) return arranged;
    if (/^\d+$/.test(raw)) {
      const exact = arranged.filter((s) => String(s.id) === raw);
      const prefix = arranged.filter((s) => String(s.id).startsWith(raw) && String(s.id) !== raw);
      return [...exact, ...prefix];
    }
    const needle = normalize(raw);
    return arranged.filter(
      (s) => normalize(s.title).includes(needle) || normalize(s.firstLine).includes(needle),
    );
  }, [arranged, query]);

  /**
   * Favourites first, when asked for.
   *
   * A stable sort, so within each group the songs keep the order the search
   * put them in — the numbers stay ascending rather than being reshuffled.
   */
  const ordered = useMemo(() => {
    if (!settings.favouritesFirst || favourites.size === 0) return filtered;
    const liked = filtered.filter((item) => favourites.has(item.id));
    const rest = filtered.filter((item) => !favourites.has(item.id));
    return [...liked, ...rest];
  }, [filtered, favourites, settings.favouritesFirst]);

  /** Whether this book has been dragged into an order of its own. */
  const rearranged = !!(songbook && settings.songOrder[songbook]?.length);

  /**
   * Back to the order the songbook itself keeps — by number.
   *
   * The dragged order is only ever stored here, never written into the
   * songbook file, so forgetting it is all it takes: nothing about the songs
   * themselves changes, and the numbers were never lost in the first place.
   */
  const resetOrder = () => {
    if (!songbook) return;
    const remaining = { ...settings.songOrder };
    delete remaining[songbook];
    void patchSettings({ songOrder: remaining });
    toast(t("songs.orderReset"), "success");
  };

  /**
   * Dragging is offered on any unfiltered list.
   *
   * It used to require the list on screen to be exactly the book's own order,
   * which quietly took the handle away whenever favourites were lifted to the
   * top — a feature that vanishes without a word is one that is broken as far
   * as anybody using it is concerned. The drop is applied to the book's order
   * as a single move (see below), so the grouping on screen makes no
   * difference to what is written.
   *
   * A search is still the exception, and for a reason that cannot be worked
   * around: most of the book is not on screen, so there is no answer to where
   * between two hidden songs the dropped one belongs.
   */
  const canReorder = !query.trim() && ordered.length > 1;

  /** Held while the drag runs, so the rows follow the cursor without waiting
   *  for a round trip to the settings file for every row crossed. */
  const [dragOrder, setDragOrder] = useState<SongSummary[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const view = dragOrder ?? ordered;
  // What the first move rearranges. A ref because the move arrives from a
  // window listener that was installed before this render.
  const viewRef = useRef(view);
  viewRef.current = view;

  /**
   * The song being carried, by id.
   *
   * The reorder hook counts in row positions, and a position is only as good
   * as the agreement between the array and the DOM at that instant — which is
   * what put the wrong song in hand. The song is fixed here at the moment it
   * is picked up, so whatever the indices do, the one that moves is the one
   * that was grabbed. Only *where* it lands comes from the hook, and that is
   * a question about the cursor, which positions answer correctly.
   *
   * A ref for the logic, since a move can arrive before a render, and state
   * for the row that has to draw itself as lifted.
   */
  const carriedId = useRef<number | null>(null);
  const [carried, setCarried] = useState<number | null>(null);

  /**
   * Set on the first move of a drag and only then.
   *
   * It is what tells the save below that a drag happened at all. Seeding the
   * order on pointer-down instead — which is what this did at first — set it
   * while `dragging` was still null, so the save fired on the press, wrote
   * nothing new, and cleared the order out from under the drag that was about
   * to start. Nothing ever moved.
   */
  const moveSong = useCallback((_from: number, to: number) => {
    setDragOrder((current) => {
      const list = current ?? viewRef.current;
      const from = list.findIndex((item) => item.id === carriedId.current);
      const landing = Math.max(0, Math.min(to, list.length - 1));
      if (from < 0 || from === landing) return current;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(landing, 0, moved);
      return next;
    });
  }, []);

  const { dragging, beginPress } = useGridReorder({
    containerRef: listRef,
    onMove: moveSong,
    // A press that never travelled: put the song down again. Selecting is the
    // row's own click handler's job, not this one's.
    onClick: () => {
      carriedId.current = null;
      setCarried(null);
    },
    count: view.length,
  });

  /** Whether the press became a drag, so letting go of one that did not is
   *  not mistaken for the end of one that did. */
  const wasDragging = useRef(false);

  // Written once, when the song is let go — not on every row it crosses, which
  // would be a settings file rewritten a dozen times for one drag.
  useEffect(() => {
    if (dragging !== null) {
      wasDragging.current = true;
      return;
    }
    // Only the end of a real drag gets here. Without this guard the effect
    // also ran on the press — `dragging` is null until the pointer has
    // travelled — and put the song down before it had been picked up.
    if (!wasDragging.current) return;
    wasDragging.current = false;
    const movedId = carriedId.current;
    carriedId.current = null;
    setCarried(null);
    if (!dragOrder || !songbook || movedId === null) return;

    /*
     * One move applied to the book's own order — not the list as displayed.
     *
     * With favourites lifted to the top, what is on screen is a *grouping* of
     * the book's order, and adopting it wholesale would write that grouping
     * into the songbook: turn favourites-first off again and the favourites
     * would still be at the top, with no way to tell why. So the drop is read
     * as "this song now follows that one", and only that one song moves.
     */
    const displayed = dragOrder.map((item) => item.id);
    const landedAfter = displayed[displayed.indexOf(movedId) - 1] ?? null;
    const without = arranged.map((item) => item.id).filter((id) => id !== movedId);
    const at = landedAfter === null ? 0 : without.indexOf(landedAfter) + 1;
    const ids = [...without.slice(0, at), movedId, ...without.slice(at)];

    void patchSettings({ songOrder: { ...settings.songOrder, [songbook]: ids } }).then(() =>
      // Cleared only once the stored order is back, or the list would flick
      // to its old arrangement for a frame.
      setDragOrder(null),
    );
    // `settings.songOrder` is read, not depended on: it changes as a result of
    // this write, and re-running would queue the same save again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, dragOrder, songbook, arranged, patchSettings]);

  /**
   * Picking several songs at once, for deleting or exporting them together.
   *
   * The same helper the slide grid uses, so the conventions are the ones every
   * file manager has: a plain click picks one, ⌘-click toggles one, Shift takes
   * the range.
   *
   * Indexed against the list as displayed — filtered and favourites-first —
   * because that is what a Shift-range has to follow. Reset when the songbook
   * or the search changes, since either makes the old indices point at
   * different songs.
   */
  const picked = useTileSelection(
    ordered.length,
    // Every input to `ordered`, not just the obvious two. Starring a song or
    // turning on favourites-first reorders the list without changing its
    // length, and the selection is held as indices — so leaving those out
    // meant the rows moved while the selection stayed, and a delete would
    // take songs other than the ones highlighted.
    `${songbook}:${query}:${settings.favouritesFirst}:${favourites.size}`,
  );

  // --- Section editing ---------------------------------------------------

  /** "Куплет 1", "Приспів" — by section id, so repeats share one label. */
  const labels = useMemo(() => {
    const out = new Map<string, string>();
    if (!song) return out;
    const totals = new Map<string, number>();
    for (const section of song.sections) {
      totals.set(section.kind, (totals.get(section.kind) ?? 0) + 1);
    }
    const ordinals = new Map<string, number>();
    for (const section of song.sections) {
      const ordinal = (ordinals.get(section.kind) ?? 0) + 1;
      ordinals.set(section.kind, ordinal);
      out.set(
        section.id,
        section.label?.trim() ||
          sectionLabel(settings.language, section.kind, ordinal, totals.get(section.kind) ?? 1),
      );
    }
    return out;
  }, [song, settings.language]);

  /**
   * The picked sections as text, in the format the app exports and imports —
   * so a chorus can be pasted into another song here, or into an email, and
   * read back either way.
   */
  const copySections = useCallback(
    (indices: number[]) => {
      if (!song || indices.length === 0) return;
      const text = indices
        .map((index) => {
          const id = song.order[index];
          const section = song.sections.find((item) => item.id === id);
          if (!section) return "";
          return `[${exportLabel(song, section)}]\n${section.text.trim()}`;
        })
        .filter(Boolean)
        .join("\n\n");
      if (!text) return;
      copied.current = text;
      void navigator.clipboard.writeText(text).catch(() => {
        // Denied by the platform. The in-app copy above still works, so
        // pasting back into this window is unaffected.
      });
      toast(t("editor.copied", { n: indices.length }), "success");
    },
    [song, toast, t],
  );

  /**
   * The manager can do this too, but a name is all a new book needs, and at
   * setup — or the first time the app is opened at all — that should not mean
   * a trip through a modal.
   */
  const newSongbook = async () => {
    const wanted = await dialogs.prompt({
      title: t("songbook.new"),
      label: t("common.name"),
      placeholder: t("songbook.namePlaceholder"),
      confirmLabel: t("common.create"),
    });
    if (!wanted?.trim()) return;
    try {
      const meta = await api.createSongbook(wanted.trim());
      await refreshLibrary();
      await patchSettings({ activeSongbook: meta.name });
      toast(t("songbook.created", { name: meta.name }), "success");
    } catch (error) {
      reportError(error);
    }
  };

  /**
   * A new song is written before it exists.
   *
   * Creating an empty one and leaving somebody to fill in tiles was the long
   * way round: what they have is the words, and the dialog turns those into
   * the song in one step.
   */
  const newSong = () => {
    if (!songbook) return;
    setComposing({ song: null });
  };

  /** Deletes everything picked, after asking once rather than once each. */
  const deleteSongs = async (targets: SongSummary[]) => {
    if (!songbook || targets.length === 0) return;
    if (targets.length === 1) {
      await deleteSong(targets[0]);
      return;
    }
    const ok = await dialogs.confirm({
      title: t("songs.delete"),
      message: t("songs.deleteManyConfirm", { n: targets.length }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    pendingSave.current = null;
    const gone = new Set<number>();
    try {
      for (const target of targets) {
        await api.deleteSong(songbook, target.id);
        gone.add(target.id);
      }
    } catch (error) {
      reportError(error);
    }
    // Applied even if one of them threw, so the list matches what is actually
    // left rather than what was asked for.
    if (gone.size > 0) {
      setSongs((current) => current.filter((item) => !gone.has(item.id)));
      picked.clear();
      if (selectedId !== null && gone.has(selectedId)) {
        setSelectedId(null);
        setSong(null);
        await loadDeck(null);
      }
    }
  };

  const deleteSong = async (target?: SongSummary) => {
    const victim = target ?? (song ? { id: song.id, title: song.title } : null);
    if (!songbook || !victim) return;
    const ok = await dialogs.confirm({
      title: t("songs.delete"),
      message: t("songs.deleteConfirm", { title: victim.title }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    // Drop any queued edit for the song about to disappear.
    pendingSave.current = null;
    try {
      await api.deleteSong(songbook, victim.id);
      if (victim.id === selectedId) {
        setSelectedId(null);
        setSong(null);
        await loadDeck(null);
      }
      setSongs((current) => current.filter((item) => item.id !== victim.id));
    } catch (error) {
      reportError(error);
    }
  };

  const duplicateSong = async (id: number) => {
    if (!songbook) return;
    await flushSave();
    try {
      const source = await api.getSong(songbook, id);
      const copy = await api.saveSong(songbook, {
        ...source,
        id: 0,
        title: `${source.title} (2)`,
      });
      setSelectedId(copy);
    } catch (error) {
      reportError(error);
    }
  };

  /**
   * Reads songs in from files.
   *
   * Several at once by design — a songbook arrives as a folder of text files
   * far more often than as one — and a file that cannot be read is reported
   * rather than abandoning the rest of the batch.
   */
  const importSongs = async () => {
    if (!songbook) return;
    const picked = await open({
      multiple: true,
      filters: [
        { name: t("songs.fileFilter"), extensions: ["json", "txt"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    if (paths.length === 0) return;
    try {
      const report = await api.importSongs(songbook, paths);
      // No reload here: the backend emits its library event, which the store
      // turns into a revision bump, which the list is already keyed on.
      toast(t("songs.imported", { n: report.imported }), "success");
      // Named individually: "3 of 40 failed" without saying which is not a
      // report, it is a puzzle.
      if (report.failed.length > 0) toast(report.failed.join("\n"), "error");
    } catch (error) {
      reportError(error);
    }
  };

  /** Writes out every song in the open songbook. */
  const exportSongs = async (format: SongFormat, ids?: number[]) => {
    if (!songbook) return;
    const chosen = ids ?? songs.map((item) => item.id);
    if (chosen.length === 0) return;

    // JSON is one file, so it asks where to save it; text is a file per song,
    // so it asks for somewhere to put them.
    const destination =
      format === "json"
        ? await save({
            defaultPath: `${songbook}.json`,
            filters: [{ name: "JSON", extensions: ["json"] }],
          })
        : await open({ directory: true, multiple: false });
    if (typeof destination !== "string" || !destination) return;

    try {
      const written = await api.exportSongs(songbook, chosen, format, destination);
      toast(t("songs.exported", { n: written.length }), "success");
    } catch (error) {
      reportError(error);
    }
  };

  // Sent from the Song menu in the menu bar. It runs the same handlers the
  // buttons beside the songbook picker do, so the two cannot drift apart.
  useEffect(() => {
    if (!songCommand) return;
    clearSongCommand();
    if (songCommand === "import") void importSongs();
    else void exportSongs(songCommand === "exportJson" ? "json" : "txt");
  }, [songCommand]);

  /** The songs a bulk action should act on, given the row clicked on. */
  /** Ids of everything picked, in the order they appear. */
  const selectedIds = () =>
    picked.ordered().map((i) => ordered[i]?.id).filter((id): id is number => id !== undefined);

  const targetsFor = (item: SongSummary): SongSummary[] => {
    const index = ordered.findIndex((candidate) => candidate.id === item.id);
    if (!picked.isMulti || !picked.selected.has(index)) return [item];
    return picked.ordered().map((i) => ordered[i]).filter((x): x is SongSummary => !!x);
  };

  const songMenu = (item: SongSummary): MenuEntry[] => {
    const targets = targetsFor(item);
    if (targets.length > 1) {
      return [
        {
          label: t("songs.exportSelected", { n: targets.length }),
          icon: "copy",
          onSelect: () => void exportSongs("txt", targets.map((x) => x.id)),
        },
        {
          label: t("songs.exportSelectedJson", { n: targets.length }),
          icon: "copy",
          onSelect: () => void exportSongs("json", targets.map((x) => x.id)),
        },
        "separator",
        {
          label: t("songs.deleteSelected", { n: targets.length }),
          icon: "trash",
          danger: true,
          onSelect: () => void deleteSongs(targets),
        },
      ];
    }
    return [
    {
      label: t("songs.favourite"),
      checked: favourites.has(item.id),
      onSelect: () => toggleFavourite(item.id),
    },
    { label: t("menu.show"), icon: "eye", onSelect: () => setSelectedId(item.id) },
    {
      // Loaded here rather than relying on whichever song happens to be open:
      // a right-click acts on the row under the cursor.
      label: t("songs.edit"),
      icon: "pencil",
      onSelect: () =>
        songbook &&
        void api
          .getSong(songbook, item.id)
          .then((loaded) => setComposing({ song: loaded }))
          .catch(reportError),
    },
    {
      label: t("plan.add"),
      icon: "plus",
      // The reference, not the song: the plan looks it up again when it is
      // wanted, so a correction made tonight is in Sunday's running order.
      onSelect: () =>
        songbook &&
        addToPlan({
          kind: "song",
          label: item.title,
          note: "",
          // Whatever the song has been timed at. Still changeable in the plan
          // itself — a song can run long on a given Sunday.
          minutes: songMinutes[String(item.id)] ?? 0,
          depth: 0,
          collapsed: false,
          ref: { songbook, songId: item.id },
        }),
    },
    { label: t("menu.duplicate"), icon: "copy", onSelect: () => void duplicateSong(item.id) },
    {
      label: t("songs.exportOne"),
      icon: "copy",
      onSelect: () => void exportSongs("txt", [item.id]),
    },
    "separator",
      {
        label: t("songs.delete"),
        icon: "trash",
        danger: true,
        onSelect: () => void deleteSong(item),
      },
    ];
  };

  const songDeckActive = deck?.source === "song";

  /**
   * ⌘/Ctrl+C copies the words of the slide in hand.
   *
   * The last thing here that touches the clipboard, and it only reads: what a
   * song says is changed where it is written. Not taken while something is
   * being typed into, where it belongs to the caret.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!song || !(event.metaKey || event.ctrlKey) || isTyping(event.target)) return;
      if (event.code !== "KeyC") return;
      event.preventDefault();
      copySections([cursor]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [song, cursor, copySections]);

  /**
   * Delete over the song list removes the songs picked there.
   *
   * `deleteSongs` asks first — one song by name, several by count — so this is
   * the shortcut for the menu item, not a quicker way to lose a songbook.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTyping(event.target) || pane !== "list" || !songbook) return;

      const targets = picked.isMulti
        ? picked.ordered().map((index) => ordered[index]).filter((x): x is SongSummary => !!x)
        : ordered.filter((item) => item.id === selectedId);
      if (targets.length === 0) return;
      event.preventDefault();
      void deleteSongs(targets);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `deleteSongs` is rebuilt every render and would tear the listener down
    // each time; everything it reads is in the dependencies that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, songbook, picked, ordered, selectedId]);

  return (
    <>
      <div className="workspace">
        <section className="panel" style={{ flex: "0 1 300px", minWidth: 210 }}>
          <div className="panel__head">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t("songs.search")}
              inputRef={searchRef}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ordered[0]) {
                  setSelectedId(ordered[0].id);
                  event.currentTarget.blur();
                }
              }}
            />
          </div>

          {/* Under the search bar, as asked: one press puts the favourites at
              the top, the next puts the list back in number order. */}
          <div className="panel__actions">
            <button
              className={settings.favouritesFirst ? "btn btn--sm btn--primary" : "btn btn--sm"}
              title={t("songs.favouritesFirstHint")}
              onClick={() => void patchSettings({ favouritesFirst: !settings.favouritesFirst })}
            >
              <Icon name="star" size={12} />
              {settings.favouritesFirst ? t("songs.favouritesFirstOn") : t("songs.favouritesFirst")}
            </button>
            {favourites.size > 0 && (
              <span className="field__hint">{favourites.size}</span>
            )}
            {/* Only once there is something to undo — a button that does
                nothing is worse than no button. */}
            {rearranged && (
              <button
                className="btn btn--sm"
                title={t("songs.orderResetHint")}
                onClick={resetOrder}
              >
                <Icon name="refresh" size={12} />
                {t("songs.orderReset")}
              </button>
            )}
          </div>

          <div
            className="panel__body"
            onPointerDownCapture={() => setPane("list")}
            onContextMenu={(event) =>
              openMenu(event, [
                {
                  label: t("songs.new"),
                  icon: "plus",
                  disabled: !songbook,
                  onSelect: () => void newSong(),
                },
                {
                  label: t("songs.import"),
                  icon: "folder",
                  disabled: !songbook,
                  onSelect: () => void importSongs(),
                },
                "separator",
                {
                  label: t("songs.orderReset"),
                  icon: "refresh",
                  disabled: !rearranged,
                  onSelect: resetOrder,
                },
                "separator",
                { label: t("songbook.new"), icon: "plus", onSelect: () => void newSongbook() },
                {
                  label: t("songbook.manage"),
                  icon: "folder",
                  onSelect: () => setManaging(true),
                },
              ])
            }
          >
            {/* With no songbook there is nowhere to put a song, and the New
                song button is dead: say so here rather than leave an empty
                list that looks like a book with nothing in it. */}
            {!songbook ? (
              <Empty
                title={t("songbook.none")}
                hint={t("songbook.noneHint")}
                action={
                  <button className="btn btn--primary" onClick={() => void newSongbook()}>
                    <Icon name="plus" size={13} />
                    {t("songbook.create")}
                  </button>
                }
              />
            ) : ordered.length === 0 ? (
              <Empty
                title={songs.length === 0 ? t("songs.none") : t("songs.noMatch")}
                hint={songs.length === 0 ? t("songs.noneHint") : t("songs.noMatchHint")}
              />
            ) : (
              <div className="list" ref={listRef}>
                {view.map((item, index) => (
                  <SongRow
                    key={item.id}
                    dragging={carried === item.id}
                    onGrip={
                      canReorder
                        ? (event) => {
                            carriedId.current = item.id;
                            setCarried(item.id);
                            beginPress(event, index);
                          }
                        : undefined
                    }
                    item={item}
                    songKey={songKeys[String(item.id)]}
                    bpm={songBpm[String(item.id)]}
                    selected={item.id === selectedId}
                    marked={picked.isMulti && picked.selected.has(index)}
                    favourite={favourites.has(item.id)}
                    onSelect={(event) => {
                      // A modifier click is about building a selection, not
                      // about opening a song — so the editor stays where it is.
                      if (picked.handleClick(index, event)) return;
                      picked.selectOnly(index);
                      setSelectedId(item.id);
                    }}
                    onContextSelect={() => {
                      // Right-clicking inside a selection acts on the whole of
                      // it; outside one, it moves to the row under the cursor.
                      if (picked.isMulti && picked.selected.has(index)) return;
                      picked.selectOnly(index);
                      setSelectedId(item.id);
                    }}
                    onFavourite={() => toggleFavourite(item.id)}
                    menu={songMenu(item)}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="panel__foot">
            <select
              className="select"
              value={songbook ?? ""}
              onChange={(event) => void patchSettings({ activeSongbook: event.target.value })}
              disabled={songbooks.length === 0}
            >
              {songbooks.length === 0 && <option value="">{t("songbook.none")}</option>}
              {songbooks.map((book) => (
                <option key={book.name} value={book.name}>
                  {book.name} ({book.songCount})
                </option>
              ))}
            </select>
            {/* Two buttons, and each says what it is for: one makes things,
                one is the library. The songbook picker beside them is the
                third control here and no press should be needed to reach the
                other two. */}
            <button
              className="btn btn--icon"
              title={t("songs.newHint")}
              onClick={(event) =>
                openMenu(event, [
                  {
                    label: t("songs.new"),
                    icon: "music",
                    disabled: !songbook,
                    onSelect: () => void newSong(),
                  },
                  {
                    label: t("songbook.new"),
                    icon: "folder",
                    onSelect: () => void newSongbook(),
                  },
                ])
              }
            >
              <Icon name="plus" />
            </button>
            {/* The library: the books themselves, and moving songs in and out
                of them. Where the download button used to be, because that is
                what it was for. */}
            <button
              className="btn btn--icon"
              title={t("songbook.manage")}
              onClick={(event) =>
                openMenu(event, [
                  {
                    label: t("songbook.manage"),
                    icon: "folder",
                    onSelect: () => setManaging(true),
                  },
                  "separator",

                  { label: t("songs.import"), icon: "plus", onSelect: () => void importSongs() },
                  "separator",
                  // What is picked takes precedence over the whole book: if the
                  // operator has gone to the trouble of selecting, that is what
                  // they mean by "export".
                  ...(picked.isMulti
                    ? ([
                        {
                          label: t("songs.exportSelectedJson", { n: picked.selected.size }),
                          icon: "copy" as const,
                          onSelect: () => void exportSongs("json", selectedIds()),
                        },
                        {
                          label: t("songs.exportSelected", { n: picked.selected.size }),
                          icon: "copy" as const,
                          onSelect: () => void exportSongs("txt", selectedIds()),
                        },
                        "separator" as const,
                      ] as const)
                    : []),
                  {
                    label: t("songs.exportBookJson"),
                    icon: "copy",
                    onSelect: () => void exportSongs("json"),
                  },
                  {
                    label: t("songs.exportBookTxt"),
                    icon: "copy",
                    onSelect: () => void exportSongs("txt"),
                  },
                ])
              }
            >
              <Icon name="folder" />
            </button>
          </div>
        </section>

        <section className="panel" style={{ flex: 1 }}>
          <div className="panel__head">
            {/* Shown, not edited: a song's name belongs with its words, and
                both are changed together in the dialog behind the button on
                the right. Two places to rename one song is one too many. */}
            <span className="panel__title">
              {song ? `${song.id} · ${song.title}` : t("songs.slides")}
            </span>
            {/* Hard right, away from the title they act on: the two of them
                are the destructive end of this head, and a delete button
                nestled against a name is a delete button somebody hits. New
                songs are made from the + under the list. */}
            <div style={{ flex: 1 }} />
            <button
              className="btn btn--sm"
              disabled={!song}
              onClick={() => song && setComposing({ song })}
            >
              <Icon name="pencil" size={13} />
              {t("songs.edit")}
            </button>
            <button
              className="btn btn--sm btn--danger btn--icon"
              onClick={() => void deleteSong()}
              disabled={!song}
              title={t("songs.delete")}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>

          <div className="panel__body" onPointerDownCapture={() => setPane("grid")}>
            {!song || !songDeckActive ? (
              <Empty title={t("songs.pick")} hint={t("songs.pickHint")} />
            ) : (
              <SectionGrid
                slides={deck.slides.map((slide) => ({
                  id: slide.id,
                  kind: slide.kind,
                  part: slide.part,
                  label: labels.get(slide.groupId.split(":")[1] ?? "") ?? slide.label,
                }))}
                cursor={cursor}
                liveIndex={liveIndex}
                onShow={(index) => void go(index)}
                onSelect={select}
                onEditSong={() => song && setComposing({ song })}
              />
            )}
          </div>

          <div className="panel__foot">
            <span className="field__hint">{t("editor.inlineHint")}</span>
          </div>
        </section>

      </div>

      {managing && <SongbookManager onClose={() => setManaging(false)} />}
      {composing && songbook && (
        <SongDialog
          songbook={songbook}
          song={composing.song}
          onClose={() => setComposing(null)}
          onSaved={(id) => {
            // Straight to it, whether it was just made or just rewritten: the
            // tiles are the next thing anybody wants to see.
            setSelectedId(id);
            void refreshLibrary();
          }}
        />
      )}
    </>
  );
}

// --- The grid --------------------------------------------------------------

interface GridSlide {
  id: string;
  label: string;
  kind: string;
  part: string;
}

/**
 * The open song's slides.
 *
 * A preview and a way to drive: clicking one puts it on the screens, and that
 * is all this does. Changing what a song says, what its parts are called or
 * what order they come in happens where the song is written — the dialog
 * behind Edit, or E.
 */
function SectionGrid({
  slides,
  cursor,
  liveIndex,
  onShow,
  onSelect,
  onEditSong,
}: {
  slides: GridSlide[];
  cursor: number;
  liveIndex: number | null;
  /** Puts it on the screens. */
  onShow: (index: number) => void;
  /** Highlights it without showing it. */
  onSelect: (index: number) => void;
  /** Opens the whole song for writing — the one way in from here. */
  onEditSong: () => void;
}) {
  const t = useStore((s) => s.t);
  const openMenu = useContextMenu();

  return (
    <div className="tiles">
      {slides.map((slide, index) => {
        return (
          <div
            key={`${slide.id}:${index}`}
            className="tile"
            aria-selected={index === cursor}
            data-live={index === liveIndex}
            // Once to choose, again to show. Clicking through a song to find
            // the verse that comes next must not put each one on the wall on
            // the way past.
            onClick={() => (index === cursor ? onShow(index) : onSelect(index))}
            onContextMenu={(event) =>
              openMenu(event, [
                { label: t("menu.show"), icon: "eye", onSelect: () => onShow(index) },
                { label: t("songs.edit"), icon: "pencil", onSelect: onEditSong },
              ])
            }
          >
            <span className="tile__label" data-kind={slide.kind}>
              {slide.label}
            </span>
            <span className={slide.part.trim() ? "tile__body" : "tile__body tile__body--dim"}>
              {slide.part.trim() || t("editor.emptySection")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SongRow({
  item,
  songKey,
  bpm,
  selected,
  marked,
  favourite,
  dragging,
  onGrip,
  onSelect,
  onContextSelect,
  onFavourite,
  menu,
}: {
  item: SongSummary;
  /** The key it is played in, when somebody has set one. */
  songKey?: string;
  /** Its tempo in beats per minute, when somebody has set one. */
  bpm?: number;
  selected: boolean;
  /** One of several picked for a bulk action, rather than the one being edited. */
  marked: boolean;
  favourite: boolean;
  /** This row is the one being carried. */
  dragging?: boolean;
  /** Starts a reorder. Absent when the list is not in its own order — see
   *  `canReorder` — and the handle is then not drawn at all. */
  onGrip?: (event: React.PointerEvent) => void;
  onSelect: (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  onContextSelect: () => void;
  onFavourite: () => void;
  menu: MenuEntry[];
}) {
  const ref = useScrollIntoView(selected);
  const openMenu = useContextMenu();
  return (
    <div className="row__wrap" data-dragging={dragging || undefined}>
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        className="row"
        aria-selected={selected || marked}
        data-marked={marked || undefined}
        data-grip={onGrip ? "" : undefined}
        // The whole row drags, not only the handle: an 18px target that
        // appears on hover is easy to miss, and a press that grabs nothing
        // reads as the feature being broken. A press that never travels is
        // still a click, so selecting a song is untouched.
        onPointerDown={onGrip}
        onClick={onSelect}
        onContextMenu={(event) => {
          // Right-clicking acts on the row under the cursor, so selection
          // follows the menu rather than the other way round.
          onContextSelect();
          openMenu(event, menu);
        }}
      >
        <span className="row__num">{item.id}</span>
        <span className="row__main">
          <span className="row__title">{item.title}</span>
        </span>
        {/* After the title rather than before it: the list is read by title,
            and a column of keys down the left would push every one of them
            across for the sake of the few songs that have one. Grouped, so
            they keep clear of the star and the grip in one place rather than
            each badge fending for itself. */}
        {(songKey || bpm) && (
          <span className="row__tags">
            {songKey && <span className="row__key">{songKey}</span>}
            {bpm ? <span className="row__key row__key--bpm">{bpm}</span> : null}
          </span>
        )}
      </button>
      {onGrip && (
        <span
          className="row__grip"
          title="⠿"
          onPointerDown={onGrip}
          // Kept as its own target as well: on the row it is what tells you
          // the row can be dragged at all.
          // Not a <button>: it does nothing on click or on Enter, and one that
          // answered the keyboard would be a stop on the way to every song.
          aria-hidden="true"
        >
          <Icon name="grip" size={12} />
        </span>
      )}
      {/* Shown on hover, or always once it is a favourite — a list of stars
          nobody has pressed would be noise. */}
      <button
        className="row__star"
        data-on={favourite || undefined}
        title={favourite ? "★" : "☆"}
        onClick={(event) => {
          event.stopPropagation();
          onFavourite();
        }}
      >
        <Icon name="star" size={13} filled={favourite} />
      </button>
    </div>
  );
}

/** What a section is called in exported and copied text: the label somebody
 *  gave it, or the canonical English one the reader knows. */
function exportLabel(song: Song, section: Section): string {
  const trimmed = section.label?.trim();
  if (trimmed) return trimmed;
  if (section.kind === "verse") {
    const verses = song.sections.filter((item) => item.kind === "verse");
    return `Verse ${verses.indexOf(section) + 1}`;
  }
  return section.kind === "chorus" ? "Chorus" : section.kind === "bridge" ? "Bridge" : "Other";
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName);
}
