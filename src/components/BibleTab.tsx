import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { BookInfo, SearchHit, VerseRow } from "../api/types";
import { useStore } from "../app/store";
import { bibleDeck, type ParallelTranslation } from "../lib/deck";
import { normalize, splitAt } from "../lib/text";
import { Icon } from "./ui/Icon";
import { Empty, SearchInput, useDebounced, useScrollIntoView } from "./ui/controls";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";

export function BibleTab() {
  const t = useStore((s) => s.t);
  const settings = useStore((s) => s.settings);
  const translations = useStore((s) => s.translations);
  const libraryRevision = useStore((s) => s.libraryRevision);
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

  const [books, setBooks] = useState<BookInfo[]>([]);
  const [bookNumber, setBookNumber] = useState<number | null>(null);
  const [chapters, setChapters] = useState<number[]>([]);
  const [chapter, setChapter] = useState<number | null>(null);
  const [verses, setVerses] = useState<VerseRow[]>([]);
  const [parallel, setParallel] = useState<ParallelTranslation[]>([]);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);

  const [bookFilter, setBookFilter] = useState("");
  const [quick, setQuick] = useState("");
  const [textQuery, setTextQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [resolved, setResolved] = useState<string | null>(null);
  /** Bumped on every jump so the landing effect re-runs even when the target
      chapter is already open — otherwise Enter on the current chapter did
      nothing at all. */
  const [jumpToken, setJumpToken] = useState(0);
  const quickRef = useRef<HTMLInputElement>(null);
  const debouncedText = useDebounced(textQuery, 220);
  const debouncedQuick = useDebounced(quick, 180);

  const translation =
    settings.activeTranslation && translations.some((x) => x.name === settings.activeTranslation)
      ? settings.activeTranslation
      : (translations[0]?.name ?? null);

  useEffect(() => {
    if (translation && translation !== settings.activeTranslation) {
      void patchSettings({ activeTranslation: translation });
    }
  }, [translation, settings.activeTranslation, patchSettings]);

  const secondary = useMemo(
    () =>
      settings.secondaryTranslations.filter(
        (name) => name !== translation && translations.some((item) => item.name === name),
      ),
    [settings.secondaryTranslations, translation, translations],
  );

  const toggleSecondary = (name: string) =>
    void patchSettings({
      secondaryTranslations: secondary.includes(name)
        ? secondary.filter((item) => item !== name)
        : [...secondary, name],
    });

  // The same chapter from every extra translation, fetched alongside.
  useEffect(() => {
    if (bookNumber === null || chapter === null || secondary.length === 0) {
      setParallel([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      secondary.map((name) =>
        api
          .getVerses(name, bookNumber, chapter)
          .then((rows) => ({ name, verses: rows }))
          // A module missing this book contributes nothing rather than
          // failing the whole load.
          .catch(() => ({ name, verses: [] as VerseRow[] })),
      ),
    ).then((loaded) => !cancelled && setParallel(loaded));
    return () => {
      cancelled = true;
    };
  }, [secondary, bookNumber, chapter]);

  useEffect(() => {
    if (!translation) {
      setBooks([]);
      return;
    }
    let cancelled = false;
    api
      .getBooks(translation)
      .then((list) => {
        if (cancelled) return;
        setBooks(list);
        setBookNumber((current) =>
          current !== null && list.some((b) => b.number === current)
            ? current
            : (list[0]?.number ?? null),
        );
      })
      .catch((error) => !cancelled && reportError(error));
    return () => {
      cancelled = true;
    };
  }, [translation, libraryRevision, reportError]);

  useEffect(() => {
    if (!translation || bookNumber === null) {
      setChapters([]);
      return;
    }
    let cancelled = false;
    api
      .getChapters(translation, bookNumber)
      .then((list) => {
        if (cancelled) return;
        setChapters(list);
        setChapter((current) =>
          current !== null && list.includes(current) ? current : (list[0] ?? null),
        );
      })
      .catch((error) => !cancelled && reportError(error));
    return () => {
      cancelled = true;
    };
  }, [translation, bookNumber, reportError]);

  useEffect(() => {
    if (!translation || bookNumber === null || chapter === null) {
      setVerses([]);
      return;
    }
    let cancelled = false;
    api
      .getVerses(translation, bookNumber, chapter)
      .then((list) => {
        if (cancelled) return;
        setVerses(list);
      })
      .catch((error) => !cancelled && reportError(error));
    return () => {
      cancelled = true;
    };
  }, [translation, bookNumber, chapter, reportError]);

  // Full-text search runs in Rust over a pre-normalised index, so it stays
  // responsive while typing — v1 rescanned 31 000 verses per keystroke.
  useEffect(() => {
    if (!translation || debouncedText.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    api
      .searchBible(translation, debouncedText.trim(), 300)
      .then((results) => !cancelled && setHits(results))
      .catch((error) => !cancelled && reportError(error));
    return () => {
      cancelled = true;
    };
  }, [translation, debouncedText, reportError]);

  const book = useMemo(
    () => books.find((candidate) => candidate.number === bookNumber) ?? null,
    [books, bookNumber],
  );

  const filteredBooks = useMemo(() => {
    const needle = normalize(bookFilter);
    if (!needle) return books;
    return books.filter(
      (candidate) =>
        normalize(candidate.longName).includes(needle) ||
        normalize(candidate.shortName).includes(needle),
    );
  }, [books, bookFilter]);

  useEffect(() => {
    if (!book || chapter === null) return;
    void loadDeck(bibleDeck(book, chapter, verses, range, parallel));
  }, [book, chapter, verses, range, parallel, loadDeck]);

  /**
   * Navigates to a reference. `live` is false while the operator is still
   * typing — the passage is highlighted, not pushed to the screens, so a
   * half-typed reference never flashes up mid-service.
   */
  const jumpTo = async (raw: string, live: boolean) => {
    if (!translation || !raw.trim()) {
      setResolved(null);
      return;
    }
    try {
      const match = await api.resolveReference(translation, raw);
      if (!match) {
        setResolved(null);
        return;
      }
      setResolved(match.label);
      setBookNumber(match.reference.book);
      setChapter(match.reference.chapter);
      setRange(
        match.reference.endVerse > match.reference.verse
          ? { start: match.reference.verse, end: match.reference.endVerse }
          : null,
      );
      // Remember which verse to land on once the chapter's slides exist.
      pending.current = {
        book: match.reference.book,
        chapter: match.reference.chapter,
        verse: match.reference.verse,
        live,
      };
      setJumpToken((token) => token + 1);
    } catch (error) {
      reportError(error);
    }
  };

  const pending = useRef<{
    book: number;
    chapter: number;
    verse: number;
    live: boolean;
  } | null>(null);

  useEffect(() => {
    const target = pending.current;
    if (!target || !deck || deck.source !== "bible") return;

    // The deck is rebuilt asynchronously when the chapter changes, so this
    // effect may first run while `deck` is still the previous chapter. Only
    // act — and only clear the target — once the right chapter is loaded.
    const prefix = `${target.book}:${target.chapter}:`;
    if (!deck.slides[0]?.id.startsWith(prefix)) return;

    const index = deck.slides.findIndex(
      (slide) => slide.id === `${prefix}${target.verse}` || slide.id.startsWith(`${prefix}${target.verse}-`),
    );
    if (index < 0) return;

    pending.current = null;
    if (target.live) void go(index);
    else select(index);
  }, [deck, jumpToken, go, select]);

  // Resolve as the operator types, so "rm 3 23" walks the lists live.
  useEffect(() => {
    if (!debouncedQuick.trim()) {
      setResolved(null);
      return;
    }
    void jumpTo(debouncedQuick, false);
    // jumpTo changes identity every render; the debounced query is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuick, translation]);

  const showHit = (hit: SearchHit) => {
    setBookNumber(hit.book);
    setChapter(hit.chapter);
    setRange(null);
    pending.current = { book: hit.book, chapter: hit.chapter, verse: hit.verse, live: false };
    setJumpToken((token) => token + 1);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        quickRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const importTranslation = async () => {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "MyBible module", extensions: ["SQLite3", "sqlite3", "sqlite", "db"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    try {
      const meta = await api.importTranslation(picked);
      await refreshLibrary();
      await patchSettings({ activeTranslation: meta.name });
      toast(t("bible.imported", { name: meta.name }), "success");
    } catch (error) {
      reportError(error);
    }
  };

  if (translations.length === 0) {
    return (
      <div className="workspace">
        <section className="panel" style={{ flex: 1 }}>
          <Empty
            title={t("bible.noTranslations")}
            hint={t("bible.noTranslationsHint")}
            action={
              <button className="btn btn--primary" onClick={() => void importTranslation()}>
                <Icon name="plus" size={13} />
                {t("bible.import")}
              </button>
            }
          />
        </section>
      </div>
    );
  }

  const searching = debouncedText.trim().length >= 2;

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: "0 0 220px" }}>
        <div className="panel__head">
          <SearchInput value={bookFilter} onChange={setBookFilter} placeholder={t("bible.books")} />
        </div>
        <div className="panel__body">
          <div className="list">
            {filteredBooks.map((candidate) => (
              <BookRow
                key={candidate.number}
                book={candidate}
                selected={candidate.number === bookNumber}
                onSelect={() => {
                  setRange(null);
                  setBookNumber(candidate.number);
                }}
              />
            ))}
          </div>
        </div>
        <div className="panel__foot">
          <select
            className="select"
            value={translation ?? ""}
            onChange={(event) => void patchSettings({ activeTranslation: event.target.value })}
          >
            {translations.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          <button className="btn btn--icon" onClick={() => void importTranslation()} title={t("bible.import")}>
            <Icon name="plus" />
          </button>
        </div>
        {translations.length > 1 && (
          <div className="panel__foot" style={{ display: "grid", gap: 6, borderTop: 0 }}>
            <span className="field__hint">{t("bible.parallel")}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {translations
                .filter((item) => item.name !== translation && !item.error)
                .map((item) => (
                  <button
                    key={item.name}
                    className="chip"
                    data-active={secondary.includes(item.name)}
                    title={t("bible.parallelHint")}
                    onClick={() => toggleSecondary(item.name)}
                  >
                    <span className="chip__dot" />
                    {item.name}
                  </button>
                ))}
            </div>
          </div>
        )}
      </section>

      <section className="panel" style={{ flex: "0 0 76px" }}>
        <div className="panel__head" style={{ justifyContent: "center" }}>
          <span className="panel__title">{t("bible.chapters")}</span>
        </div>
        <div className="panel__body">
          <div className="list">
            {chapters.map((number) => (
              <ChapterRow
                key={number}
                number={number}
                selected={number === chapter}
                onSelect={() => {
                  setRange(null);
                  setChapter(number);
                }}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__head">
          <div className="search" style={{ flex: "0 0 190px" }}>
            <span className="search__icon">
              <Icon name="target" size={14} />
            </span>
            <input
              className="input"
              style={{ paddingLeft: 30 }}
              value={quick}
              placeholder={t("bible.quickSearch")}
              spellCheck={false}
              ref={quickRef}
              onChange={(event) => setQuick(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  // Enter commits: put the resolved passage on screen.
                  void jumpTo(quick, true);
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
          {resolved && (
            <span className="chip" data-active="true" style={{ cursor: "default" }}>
              <span className="chip__dot" />
              {resolved}
            </span>
          )}
          <SearchInput value={textQuery} onChange={setTextQuery} placeholder={t("bible.textSearch")} />
        </div>

        <div className="panel__body">
          {searching ? (
            hits.length === 0 ? (
              <Empty title={t("bible.noResults")} />
            ) : (
              <div className="list">
                <div className="panel__title" style={{ padding: "6px 10px" }}>
                  {t("bible.results", { n: hits.length })}
                </div>
                {hits.map((hit) => (
                  <button
                    key={`${hit.book}:${hit.chapter}:${hit.verse}`}
                    className="row"
                    onClick={() => showHit(hit)}
                  >
                    <span className="row__num" style={{ minWidth: "5.5em" }}>
                      {hit.reference}
                    </span>
                    <span className="row__main">
                      <Highlighted hit={hit} />
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : !deck || deck.source !== "bible" ? (
            <Empty title={t("bible.verses")} />
          ) : (
            <div className="list">
              {deck.slides.map((slide, index) => (
                <VerseRowView
                  key={slide.id}
                  label={slide.label}
                  text={slide.summary ?? slide.part}
                  selected={index === cursor}
                  live={index === liveIndex}
                  menu={[
                    { label: t("menu.show"), icon: "eye", onSelect: () => void go(index) },
                    {
                      label: t("menu.copyText"),
                      icon: "copy",
                      onSelect: () => void navigator.clipboard.writeText(slide.part),
                    },
                    {
                      label: t("menu.copyWithReference"),
                      icon: "copy",
                      onSelect: () =>
                        void navigator.clipboard.writeText(`${slide.part}\n— ${slide.reference}`),
                    },
                  ]}
                  onClick={(event) => {
                    // Shift-click extends the selection into a passage that
                    // goes on screen as one slide.
                    if (event.shiftKey && !range) {
                      const anchor = Number(deck.slides[cursor]?.label ?? slide.label);
                      const target = Number(slide.label);
                      if (Number.isFinite(anchor) && Number.isFinite(target) && anchor !== target) {
                        setRange({
                          start: Math.min(anchor, target),
                          end: Math.max(anchor, target),
                        });
                        return;
                      }
                    }
                    if (range) setRange(null);
                    void go(index);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="panel__foot">
          <span className="field__hint">
            {t("bible.quickHint")} · {t("bible.selectRange")}
          </span>
          <div className="topbar__spacer" />
          {range && (
            <button className="btn btn--sm" onClick={() => setRange(null)}>
              <Icon name="x" size={12} />
              {range.start}–{range.end}
            </button>
          )}
        </div>
      </section>

    </div>
  );
}

function BookRow({
  book,
  selected,
  onSelect,
}: {
  book: BookInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useScrollIntoView(selected);
  return (
    <button ref={ref as React.Ref<HTMLButtonElement>} className="row" aria-selected={selected} onClick={onSelect}>
      <span className="row__main">
        <span className="row__title">{book.longName}</span>
      </span>
      <span className="row__num" style={{ minWidth: 0 }}>
        {book.chapters}
      </span>
    </button>
  );
}

function ChapterRow({
  number,
  selected,
  onSelect,
}: {
  number: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useScrollIntoView(selected);
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      className="row"
      aria-selected={selected}
      onClick={onSelect}
      style={{ justifyContent: "center" }}
    >
      <span className="row__num" style={{ minWidth: 0 }}>
        {number}
      </span>
    </button>
  );
}

function VerseRowView({
  label,
  text,
  selected,
  live,
  onClick,
  menu,
}: {
  label: string;
  text: string;
  selected: boolean;
  live: boolean;
  onClick: (event: React.MouseEvent) => void;
  menu?: MenuEntry[];
}) {
  const ref = useScrollIntoView(selected);
  const openMenu = useContextMenu();
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      className="row"
      aria-selected={selected}
      onClick={onClick}
      onContextMenu={(event) => menu && openMenu(event, menu)}
      style={live ? { boxShadow: "inset 2px 0 0 var(--accent)" } : undefined}
    >
      <span className="row__num">{label}</span>
      <span className="row__main" style={{ whiteSpace: "normal" }}>
        {text}
      </span>
    </button>
  );
}

function Highlighted({ hit }: { hit: SearchHit }) {
  const { before, match, after } = splitAt(hit.text, hit.matchStart, hit.matchEnd);
  return (
    <span style={{ whiteSpace: "normal" }}>
      {before}
      {match && <mark className="mark">{match}</mark>}
      {after}
    </span>
  );
}
