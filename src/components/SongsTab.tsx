import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Section, SectionKind, Song, SongFormat, SongSummary } from "../api/types";
import { useStore } from "../app/store";
import { songDeck } from "../lib/deck";
import { useGridReorder } from "../lib/dragReorder";
import { useMarquee } from "../lib/marquee";
import { sectionLabel } from "../lib/i18n";
import { useTileSelection } from "../lib/selection";
import { normalize } from "../lib/text";
import { Icon } from "./ui/Icon";
import { Empty, SearchInput, useScrollIntoView } from "./ui/controls";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";
import { SongbookManager } from "./SongbookManager";

/** Long enough that typing does not thrash the disk, short enough to be safe. */
const SAVE_DELAY_MS = 600;

const KINDS: { kind: SectionKind; key: string }[] = [
  { kind: "verse", key: "editor.addVerse" },
  { kind: "chorus", key: "editor.addChorus" },
  { kind: "bridge", key: "editor.addBridge" },
  { kind: "other", key: "editor.addOther" },
];

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
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);

  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
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
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [managing, setManaging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
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

  const edit = useCallback(
    (next: Song) => {
      if (!songbook) return;
      setSong(next);
      pendingSave.current = { songbook, song: next };
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS);
    },
    [songbook, flushSave],
  );

  useEffect(() => () => void flushSave(), [flushSave]);

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

      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.select();
        return;
      }
      // `code` rather than `key`, so it is the same physical key whichever
      // keyboard layout is active — on a Ukrainian layout this is "у".
      if (event.code === "KeyE" && song && deck?.source === "song") {
        event.preventDefault();
        setEditingIndex(cursor);
        return;
      }

    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [song, deck, cursor]);

  /**
   * v1 re-ran a `SELECT *` and JSON-parsed every song on each keystroke, and
   * matched only against couplets + chorus — so searching by title silently
   * failed. Here the list is already in memory and number, title and opening
   * line are all searchable.
   */
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

  /**
   * Dragging is only offered while the list on screen *is* the book's own
   * order — no search, no favourites lifted to the top.
   *
   * The identity check is the whole rule: both memos above hand back the array
   * they were given when they have nothing to do, so this is true exactly when
   * nothing has been filtered or regrouped. Dropping a song into a filtered
   * list would mean guessing where it belongs among the songs not on screen,
   * and dropping one into a favourites-first list would write an order that
   * the favourites sort immediately overrules.
   */
  const canReorder = ordered === arranged && ordered.length > 1;

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
    carriedId.current = null;
    setCarried(null);
    if (!dragOrder || !songbook) return;
    const ids = dragOrder.map((item) => item.id);
    void patchSettings({ songOrder: { ...settings.songOrder, [songbook]: ids } }).then(() =>
      // Cleared only once the stored order is back, or the list would flick
      // to its old arrangement for a frame.
      setDragOrder(null),
    );
    // `settings.songOrder` is read, not depended on: it changes as a result of
    // this write, and re-running would queue the same save again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, dragOrder, songbook, patchSettings]);

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

  const moveSection = useCallback(
    (from: number, to: number) => {
      if (!song) return;
      const order = [...song.order];
      if (to < 0 || to >= order.length || from === to) return;
      const [moved] = order.splice(from, 1);
      if (moved === undefined) return;
      order.splice(to, 0, moved);
      edit({ ...song, order });
    },
    [song, edit],
  );

  const addSection = (kind: SectionKind) => {
    if (!song) return;
    const id = `${kind[0]}${Date.now().toString(36)}${song.sections.length}`;
    const section: Section = { id, kind, text: "" };
    edit({ ...song, sections: [...song.sections, section], order: [...song.order, id] });
    // Drop straight into the new tile — adding one is always followed by
    // typing into it.
    setEditingIndex(song.order.length);
  };

  const setSectionText = (index: number, text: string) => {
    if (!song) return;
    const id = song.order[index];
    if (!id) return;
    edit({
      ...song,
      sections: song.sections.map((section) =>
        section.id === id ? { ...section, text } : section,
      ),
    });
  };

  const setSectionKind = (index: number, kind: SectionKind) => {
    if (!song) return;
    const id = song.order[index];
    if (!id) return;
    edit({
      ...song,
      sections: song.sections.map((section) =>
        section.id === id ? { ...section, kind } : section,
      ),
    });
  };

  const repeatSection = (index: number) => {
    if (!song) return;
    const id = song.order[index];
    if (!id) return;
    const order = [...song.order];
    order.splice(index + 1, 0, id);
    edit({ ...song, order });
  };

  /**
   * Removes the given occurrences. A section whose last occurrence goes is
   * removed with it, rather than lingering as something unreachable.
   */
  /**
   * Deletes the open song once its last section has gone, and opens a
   * neighbour so the tab is never left staring at nothing.
   */
  const removeEmptySong = useCallback(async () => {
    if (!songbook || !song) return;
    // Whatever edit is queued is for a song about to cease to exist.
    pendingSave.current = null;
    setEditingIndex(null);
    try {
      await api.deleteSong(songbook, song.id);
      const remaining = songs.filter((item) => item.id !== song.id);
      const position = songs.findIndex((item) => item.id === song.id);
      // The one that takes its place in the list, or the one before it when
      // the song was last.
      const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)] ?? null;
      setSongs(remaining);
      setSong(null);
      setSelectedId(next?.id ?? null);
      if (!next) await loadDeck(null);
      toast(t("songs.removedEmpty", { title: song.title }));
    } catch (error) {
      reportError(error);
    }
  }, [songbook, song, songs, loadDeck, reportError, t, toast]);

  const removeSections = useCallback(
    (indices: number[]) => {
      if (!song || indices.length === 0) return;
      const drop = new Set(indices);
      const order = song.order.filter((_, index) => !drop.has(index));
      // A song with nothing left in it is not a song. Removing the last
      // section removes the song, rather than leaving an empty shell that
      // cannot be saved and cannot be sung.
      if (order.length === 0) {
        void removeEmptySong();
        return;
      }
      const sections = song.sections.filter((section) => order.includes(section.id));
      edit({ ...song, sections, order });
      setEditingIndex(null);
    },
    [song, edit, removeEmptySong],
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

  const newSong = async () => {
    if (!songbook) return;
    await flushSave();
    try {
      const id = await api.saveSong(songbook, {
        id: 0,
        title: t("songs.untitled"),
        sections: [{ id: "v1", kind: "verse", text: "" }],
        order: ["v1"],
      });
      setSelectedId(id);
      setEditingIndex(0);
    } catch (error) {
      reportError(error);
    }
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
  const selection = useTileSelection(songDeckActive ? deck.slides.length : 0, song?.id);

  // Delete removes the whole selection, or the highlighted section when there
  // is none. Declared here because it needs both the selection and the
  // remover, which are set up above.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTyping(event.target) || !song || !songDeckActive) return;

      const indices = selection.selected.size > 0 ? selection.ordered() : [cursor];
      if (indices.length === 0) return;
      event.preventDefault();
      void dialogs
        .confirm({
          title: t("editor.removeFromOrder"),
          message:
            indices.length > 1
              ? t("editor.removeManyConfirm", { n: indices.length })
              : t("editor.removeOneConfirm"),
          confirmLabel: t("common.delete"),
          danger: true,
        })
        .then((ok) => {
          if (ok) {
            removeSections(indices);
            selection.clear();
          }
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [song, songDeckActive, cursor, selection, dialogs, removeSections, t]);

  return (
    <>
      <div className="workspace">
        <section className="panel" style={{ flex: "0 0 300px" }}>
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
          </div>

          <div className="panel__body">
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
            <button
              className="btn btn--icon"
              title={t("songs.transfer")}
              disabled={!songbook}
              onClick={(event) =>
                openMenu(event, [
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
              <Icon name="arrowDown" />
            </button>
            <button
              className="btn btn--icon"
              onClick={() => void newSongbook()}
              title={t("songbook.new")}
            >
              <Icon name="plus" />
            </button>
            <button
              className="btn btn--icon"
              onClick={() => setManaging(true)}
              title={t("songbook.manage")}
            >
              <Icon name="folder" />
            </button>
          </div>
        </section>

        <section className="panel" style={{ flex: 1 }}>
          <div className="panel__head">
            {song ? (
              <input
                className="input"
                style={{ fontSize: 15, fontWeight: 600 }}
                value={song.title}
                placeholder={t("editor.title")}
                onChange={(event) => edit({ ...song, title: event.target.value })}
              />
            ) : (
              <span className="panel__title">{t("songs.slides")}</span>
            )}
            <button className="btn btn--sm" onClick={() => void newSong()} disabled={!songbook}>
              <Icon name="plus" size={13} />
              {t("songs.new")}
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

          <div className="panel__body">
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
                editingIndex={editingIndex}
                selection={selection}
                onShow={(index) => void go(index)}
                onEdit={setEditingIndex}
                onText={setSectionText}
                onKind={setSectionKind}
                onMove={moveSection}
                onRepeat={repeatSection}
                onRemove={removeSections}
                onAdd={addSection}
              />
            )}
          </div>

          <div className="panel__foot">
            <span className="field__hint">{t("editor.inlineHint")}</span>
          </div>
        </section>

      </div>

      {managing && <SongbookManager onClose={() => setManaging(false)} />}
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

function SectionGrid({
  slides,
  cursor,
  liveIndex,
  editingIndex,
  selection,
  onShow,
  onEdit,
  onText,
  onKind,
  onMove,
  onRepeat,
  onRemove,
  onAdd,
}: {
  slides: GridSlide[];
  cursor: number;
  liveIndex: number | null;
  editingIndex: number | null;
  selection: ReturnType<typeof useTileSelection>;
  onShow: (index: number) => void;
  onEdit: (index: number | null) => void;
  onText: (index: number, text: string) => void;
  onKind: (index: number, kind: SectionKind) => void;
  onMove: (from: number, to: number) => void;
  onRepeat: (index: number) => void;
  onRemove: (indices: number[]) => void;
  onAdd: (kind: SectionKind) => void;
}) {
  const t = useStore((s) => s.t);
  const openMenu = useContextMenu();
  const gridRef = useRef<HTMLDivElement>(null);
  const { dragging, beginPress } = useGridReorder({
    containerRef: gridRef,
    onMove,
    onClick: (index, event) => {
      if (!selection.handleClick(index, event)) onShow(index);
    },
  });

  // The "add" tile trails the sections and is not selectable.
  const marquee = useMarquee({
    containerRef: gridRef,
    count: slides.length,
    onSelect: selection.setMany,
    onClear: selection.clear,
  });

  return (
    <div ref={gridRef} className="tiles" onPointerDown={marquee.onPointerDown}>
      {slides.map((slide, index) => {
        const inSelection = selection.selected.has(index);
        const isEditing = index === editingIndex;
        return (
          <div
            key={`${slide.id}:${index}`}
            className="tile"
            aria-selected={index === cursor || inSelection}
            data-marked={(inSelection && selection.isMulti) || undefined}
            data-live={index === liveIndex}
            style={{
              opacity: dragging === index ? 0.55 : 1,
              cursor: isEditing ? "default" : dragging === index ? "grabbing" : "grab",
              touchAction: "none",
            }}
            // Dragging is off while a tile is being typed into, or the press
            // would be stolen from the caret.
            onPointerDown={(event) => {
              if (!isEditing) beginPress(event, index);
            }}
            onContextMenu={(event) =>
              openMenu(event, [
                { label: t("menu.show"), icon: "eye", onSelect: () => onShow(index) },
                { label: t("menu.editText"), icon: "pencil", onSelect: () => onEdit(index) },
                { label: t("editor.repeat"), icon: "repeat", onSelect: () => onRepeat(index) },
                "separator",
                ...KINDS.filter(({ kind }) => kind !== slide.kind).map(({ kind, key }) => ({
                  label: t("menu.makeKind", { kind: t(key) }),
                  onSelect: () => onKind(index, kind),
                })),
                "separator",
                {
                  label:
                    inSelection && selection.isMulti
                      ? t("editor.removeSelected", { n: selection.selected.size })
                      : t("editor.removeFromOrder"),
                  icon: "trash" as const,
                  danger: true,
                  onSelect: () =>
                    onRemove(
                      inSelection && selection.isMulti ? selection.ordered() : [index],
                    ),
                },
              ])
            }
          >
            <span className="tile__label" data-kind={slide.kind}>
              {slide.label}
            </span>
            {isEditing ? (
              <textarea
                className="tile__editor"
                value={slide.part}
                autoFocus
                placeholder={t("editor.sectionText")}
                onChange={(event) => onText(index, event.target.value)}
                onBlur={() => onEdit(null)}
                // Enter stays a newline — these are several lines of lyric.
                // Escape and ⌘/Ctrl+Enter both finish the edit.
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.currentTarget.blur();
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <span className={slide.part.trim() ? "tile__body" : "tile__body tile__body--dim"}>
                {slide.part.trim() || t("editor.emptySection")}
              </span>
            )}
          </div>
        );
      })}

      {/* Always last: the tile that adds another section. */}
      <button
        className="tile tile--add"
        title={t("editor.addSection")}
        onClick={(event) =>
          openMenu(
            event,
            KINDS.map(({ kind, key }) => ({
              label: t(key),
              icon: "plus" as const,
              onSelect: () => onAdd(kind),
            })),
          )
        }
      >
        <Icon name="plus" size={24} />
        <span>{t("editor.addSection")}</span>
      </button>

      {marquee.rect && <div className="marquee" style={marquee.rect} />}
    </div>
  );
}

function SongRow({
  item,
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

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName);
}
