import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Section, SectionKind, Song, SongSummary } from "../api/types";
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
  const libraryRevision = useStore((s) => s.libraryRevision);
  const deck = useStore((s) => s.deck);
  const cursor = useStore((s) => s.cursor);
  const liveIndex = useStore((s) => s.liveIndex);
  const patchSettings = useStore((s) => s.patchSettings);
  const loadDeck = useStore((s) => s.loadDeck);
  const go = useStore((s) => s.go);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);

  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
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

  const filtered = useMemo(() => {
    const raw = query.trim();
    if (!raw) return songs;
    if (/^\d+$/.test(raw)) {
      const exact = songs.filter((s) => String(s.id) === raw);
      const prefix = songs.filter((s) => String(s.id).startsWith(raw) && String(s.id) !== raw);
      return [...exact, ...prefix];
    }
    const needle = normalize(raw);
    return songs.filter(
      (s) => normalize(s.title).includes(needle) || normalize(s.firstLine).includes(needle),
    );
  }, [songs, query]);

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

  const songMenu = (item: SongSummary): MenuEntry[] => [
    {
      label: t("songs.favourite"),
      checked: favourites.has(item.id),
      onSelect: () => toggleFavourite(item.id),
    },
    { label: t("menu.show"), icon: "eye", onSelect: () => setSelectedId(item.id) },
    { label: t("menu.duplicate"), icon: "copy", onSelect: () => void duplicateSong(item.id) },
    "separator",
    { label: t("songs.delete"), icon: "trash", danger: true, onSelect: () => void deleteSong(item) },
  ];

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
            {ordered.length === 0 ? (
              <Empty
                title={songs.length === 0 ? t("songs.none") : t("songs.noMatch")}
                hint={songs.length === 0 ? t("songs.noneHint") : t("songs.noMatchHint")}
              />
            ) : (
              <div className="list">
                {ordered.map((item) => (
                  <SongRow
                    key={item.id}
                    item={item}
                    selected={item.id === selectedId}
                    favourite={favourites.has(item.id)}
                    onSelect={() => setSelectedId(item.id)}
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
  favourite,
  onSelect,
  onFavourite,
  menu,
}: {
  item: SongSummary;
  selected: boolean;
  favourite: boolean;
  onSelect: () => void;
  onFavourite: () => void;
  menu: MenuEntry[];
}) {
  const ref = useScrollIntoView(selected);
  const openMenu = useContextMenu();
  return (
    <div className="row__wrap">
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        className="row"
        aria-selected={selected}
        onClick={onSelect}
        onContextMenu={(event) => {
          // Right-clicking acts on the row under the cursor, so selection
          // follows the menu rather than the other way round.
          onSelect();
          openMenu(event, menu);
        }}
      >
        <span className="row__num">{item.id}</span>
        <span className="row__main">
          <span className="row__title">{item.title}</span>
        </span>
      </button>
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
