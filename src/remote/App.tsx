/**
 * The control page a phone or tablet opens.
 *
 * Built for one hand in a dark room: everything is a large target, the thing
 * being done now is at the bottom where a thumb reaches, and nothing needs two
 * hands or a careful aim. It shows what the console has open and can put a
 * different song or passage up, which is what somebody standing at the front
 * actually needs — the fine work stays at the laptop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookInfo, SongSummary, SongbookMeta, TranslationMeta, VerseRow } from "../api/types";
import { translate } from "../lib/i18n";
import { Unpaired, remote, rememberToken, storedToken, type Feed, type RemoteDeck } from "./api";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Remembered so the phone comes back to the book it was using, not to the
 *  top of a list of twelve. */
const LAST_SONGBOOK = "lyricverse.remote.songbook";
const LAST_TRANSLATION = "lyricverse.remote.translation";

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing; the choice simply does not survive a reload */
  }
}

function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function App() {
  const [token, setToken] = useState(storedToken);
  const [language, setLanguage] = useState("uk");

  useEffect(() => {
    // Asked before pairing, so the code screen is already in the console's
    // language rather than switching once the device is let in.
    void remote
      .language()
      .then((hello) => hello.language && setLanguage(hello.language))
      .catch(() => {});
  }, []);

  const t = useCallback<Translate>(
    (key, values) => translate(language, key, values),
    [language],
  );

  const unpair = useCallback(() => {
    rememberToken("");
    setToken("");
  }, []);

  if (!token) {
    return (
      <Pair
        t={t}
        onPaired={() => setToken(storedToken())}
      />
    );
  }
  return <Console t={t} onUnpaired={unpair} />;
}

// --- Pairing --------------------------------------------------------------

function Pair({ t, onPaired }: { t: Translate; onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    setBusy(true);
    setWrong(false);
    try {
      if (await remote.pair(value)) onPaired();
      else {
        setWrong(true);
        setCode("");
      }
    } catch {
      setWrong(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pair">
      <div className="pair__mark">LyricVerse</div>
      <h1 className="pair__title">{t("remote.pairTitle")}</h1>
      <p className="pair__hint">{t("remote.pairHint")}</p>

      <input
        className="pair__code"
        // A phone keyboard with digits on it, and no autocorrect trying to
        // turn six numbers into a word.
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        autoFocus
        placeholder="000000"
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
          setCode(digits);
          setWrong(false);
          // Six digits is the whole code: nobody should have to find a button
          // afterwards.
          if (digits.length === 6) void submit(digits);
        }}
      />

      {wrong && <p className="pair__wrong">{t("remote.pairWrong")}</p>}

      <button
        className="btn btn--wide"
        disabled={code.length !== 6 || busy}
        onClick={() => void submit(code)}
      >
        {t("remote.connect")}
      </button>
    </div>
  );
}

// --- The console, as a phone sees it --------------------------------------

function Console({ t, onUnpaired }: { t: Translate; onUnpaired: () => void }) {
  const [view, setView] = useState<"now" | "songs" | "bible" | "slides">("now");
  const [feed, setFeed] = useState<Feed>({ revision: 0, deck: null, live: null });
  const [online, setOnline] = useState(false);

  // The long poll. One request is held open by the console until something
  // changes, so a slide changed at the laptop lands here at once and an idle
  // phone says nothing on the network.
  useEffect(() => {
    let stopped = false;
    let since = 0;

    const run = async () => {
      while (!stopped) {
        try {
          const next = await remote.state(since);
          if (stopped) return;
          since = next.revision;
          setFeed({ revision: next.revision, deck: next.deck, live: next.state?.live ?? null });
          setOnline(true);
        } catch (error) {
          if (error instanceof Unpaired) {
            onUnpaired();
            return;
          }
          // The laptop lid closed, the wifi dropped, the app quit. Say so and
          // keep trying: coming back on its own is the difference between a
          // remote and a page somebody has to reload.
          setOnline(false);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };

    void run();
    return () => {
      stopped = true;
    };
  }, [onUnpaired]);

  const send = useCallback(
    (command: Record<string, unknown>) => {
      void remote.send(command).catch((error) => {
        if (error instanceof Unpaired) onUnpaired();
      });
    },
    [onUnpaired],
  );

  return (
    <div className="app">
      <Header t={t} feed={feed} online={online} />

      <main className="main">
        {view === "now" && <Now t={t} deck={feed.deck} send={send} />}
        {view === "songs" && (
          <Songs
            t={t}
            onShow={(songbook, songId) => {
              send({ kind: "song", songbook, songId });
              setView("now");
            }}
            onUnpaired={onUnpaired}
          />
        )}
        {view === "slides" && (
          <Slides
            t={t}
            onShow={(presentationId) => {
              send({ kind: "presentation", presentationId });
              setView("now");
            }}
            onUnpaired={onUnpaired}
          />
        )}
        {view === "bible" && (
          <Bible
            t={t}
            onShow={(translation, book, chapter, verse) => {
              send({ kind: "bible", translation, book, chapter, verse });
              setView("now");
            }}
            onUnpaired={onUnpaired}
          />
        )}
      </main>

      <Transport t={t} deck={feed.deck} send={send} />

      <nav className="tabs">
        {(["now", "songs", "bible", "slides"] as const).map((id) => (
          <button
            key={id}
            className="tabs__tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {t(`remote.${id}`)}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Header({ t, feed, online }: { t: Translate; feed: Feed; online: boolean }) {
  const blanked = feed.deck?.blanked ?? true;
  const live = feed.live;
  const showing = !blanked && live && live.kind !== "blank";
  return (
    <header className="head">
      <span className="head__dot" data-on={online || undefined} data-live={showing || undefined} />
      <span className="head__what">
        {!online
          ? t("remote.offline")
          : showing
            ? live.reference || live.title || t("remote.now")
            : t("remote.hidden")}
      </span>
    </header>
  );
}

/** What is open at the console, slide by slide. */
function Now({
  t,
  deck,
  send,
}: {
  t: Translate;
  deck: RemoteDeck | null;
  send: (command: Record<string, unknown>) => void;
}) {
  const live = useRef<HTMLButtonElement | null>(null);

  // The live slide is brought into view as it moves, so a long chapter follows
  // itself down the screen instead of being scrolled by hand.
  useEffect(() => {
    live.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [deck?.index]);

  if (!deck || deck.slides.length === 0) {
    return <p className="empty">{t("remote.nothing")}</p>;
  }

  return (
    <>
      <h2 className="section">{deck.title}</h2>
      <ul className="list">
        {deck.slides.map((slide, index) => {
          const isLive = deck.index === index && !deck.blanked;
          return (
            <li key={index}>
              <button
                ref={isLive ? live : undefined}
                className="slide"
                data-live={isLive || undefined}
                data-kind={slide.kind}
                onClick={() => send({ kind: "go", index })}
              >
                <span className="slide__label">{slide.label}</span>
                {/* A picture has no words to show, and an empty line under
                    every slide of a deck of photographs is just a gap. */}
                {slide.text && <span className="slide__text">{slide.text}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Back, forward, and hide — the three things wanted most, always in reach. */
function Transport({
  t,
  deck,
  send,
}: {
  t: Translate;
  deck: RemoteDeck | null;
  send: (command: Record<string, unknown>) => void;
}) {
  const blanked = deck?.blanked ?? true;
  return (
    <div className="transport">
      <button className="transport__btn" onClick={() => send({ kind: "step", delta: -1 })}>
        <span aria-hidden="true">‹</span> {t("remote.previous")}
      </button>
      <button
        className="transport__btn transport__btn--hide"
        data-on={blanked || undefined}
        onClick={() => send({ kind: blanked ? "show" : "blank" })}
      >
        {blanked ? t("remote.show") : t("remote.hide")}
      </button>
      <button className="transport__btn" onClick={() => send({ kind: "step", delta: 1 })}>
        {t("remote.next")} <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

// --- Songs ----------------------------------------------------------------

function Songs({
  t,
  onShow,
  onUnpaired,
}: {
  t: Translate;
  onShow: (songbook: string, songId: number) => void;
  onUnpaired: () => void;
}) {
  const [books, setBooks] = useState<SongbookMeta[]>([]);
  const [songbook, setSongbook] = useState(recall(LAST_SONGBOOK));
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void remote
      .library()
      .then(({ songbooks }) => {
        setBooks(songbooks);
        setSongbook((current) =>
          songbooks.some((book) => book.name === current) ? current : (songbooks[0]?.name ?? ""),
        );
      })
      .catch((error) => error instanceof Unpaired && onUnpaired());
  }, [onUnpaired]);

  useEffect(() => {
    if (!songbook) return;
    remember(LAST_SONGBOOK, songbook);
    setLoading(true);
    void remote
      .songs(songbook)
      .then(({ songs }) => setSongs(songs))
      .catch((error) => error instanceof Unpaired && onUnpaired())
      .finally(() => setLoading(false));
  }, [songbook, onUnpaired]);

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return songs;
    // By number as readily as by words: an operator asked for "142" says the
    // number, and a leader remembers the first line.
    return songs.filter(
      (song) =>
        String(song.id).startsWith(needle) ||
        song.title.toLowerCase().includes(needle) ||
        song.firstLine.toLowerCase().includes(needle),
    );
  }, [songs, query]);

  return (
    <>
      <div className="picker">
        <select
          className="select"
          value={songbook}
          onChange={(event) => setSongbook(event.target.value)}
        >
          {books.map((book) => (
            <option key={book.name} value={book.name}>
              {book.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="search"
          inputMode="search"
          value={query}
          placeholder={t("remote.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {loading ? null : found.length === 0 ? (
        <p className="empty">{t("remote.noSongs")}</p>
      ) : (
        <ul className="list">
          {found.map((song) => (
            <li key={song.id}>
              <button className="row" onClick={() => onShow(songbook, song.id)}>
                <span className="row__num">{song.id}</span>
                <span className="row__main">
                  <span className="row__title">{song.title}</span>
                  <span className="row__sub">{song.firstLine}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The slide decks.
 *
 * Only names and lengths: the slides are pictures, and a phone does not need
 * to see them to choose the deck. Once one is showing, its slides are in the
 * Live list like anything else, and tapping one puts it up.
 */
function Slides({
  t,
  onShow,
  onUnpaired,
}: {
  t: Translate;
  onShow: (presentationId: string) => void;
  onUnpaired: () => void;
}) {
  const [decks, setDecks] = useState<{ id: string; name: string; slides: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void remote
      .presentations()
      .then(({ presentations }) => setDecks(presentations))
      .catch((error) => error instanceof Unpaired && onUnpaired())
      .finally(() => setLoading(false));
  }, [onUnpaired]);

  if (loading) return null;
  if (decks.length === 0) return <p className="empty">{t("remote.noSlides")}</p>;

  return (
    <ul className="list">
      {decks.map((deck) => (
        <li key={deck.id}>
          <button className="row" onClick={() => onShow(deck.id)}>
            <span className="row__main">
              <span className="row__title">{deck.name}</span>
            </span>
            <span className="row__count">{deck.slides}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// --- Bible ----------------------------------------------------------------

function Bible({
  t,
  onShow,
  onUnpaired,
}: {
  t: Translate;
  onShow: (translation: string, book: number, chapter: number, verse: number) => void;
  onUnpaired: () => void;
}) {
  const [translations, setTranslations] = useState<TranslationMeta[]>([]);
  const [translation, setTranslation] = useState(recall(LAST_TRANSLATION));
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [book, setBook] = useState<BookInfo | null>(null);
  const [chapter, setChapter] = useState<number | null>(null);
  const [verses, setVerses] = useState<VerseRow[]>([]);

  useEffect(() => {
    void remote
      .library()
      .then(({ translations }) => {
        setTranslations(translations);
        setTranslation((current) =>
          translations.some((item) => item.name === current)
            ? current
            : (translations[0]?.name ?? ""),
        );
      })
      .catch((error) => error instanceof Unpaired && onUnpaired());
  }, [onUnpaired]);

  useEffect(() => {
    if (!translation) return;
    remember(LAST_TRANSLATION, translation);
    void remote
      .books(translation)
      .then(({ books }) => setBooks(books))
      .catch((error) => error instanceof Unpaired && onUnpaired());
  }, [translation, onUnpaired]);

  useEffect(() => {
    if (!book || !chapter) return;
    void remote
      .verses(translation, book.number, chapter)
      .then(({ verses }) => setVerses(verses))
      .catch((error) => error instanceof Unpaired && onUnpaired());
  }, [translation, book, chapter, onUnpaired]);

  // One screen at a time, with a way back: a phone has no room for three
  // columns, and a passage is three taps whichever way it is arranged.
  return (
    <>
      <div className="picker">
        {book ? (
          <button
            className="btn btn--back"
            onClick={() => (chapter ? setChapter(null) : setBook(null))}
          >
            <span aria-hidden="true">‹</span>{" "}
            {chapter ? book.shortName : t("remote.books")}
          </button>
        ) : (
          <select
            className="select"
            value={translation}
            onChange={(event) => setTranslation(event.target.value)}
          >
            {translations.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        {book && chapter && (
          <span className="picker__where">
            {book.shortName} {chapter}
          </span>
        )}
      </div>

      {!book ? (
        <ul className="list">
          {books.map((item) => (
            <li key={item.number}>
              <button
                className="row"
                onClick={() => {
                  setBook(item);
                  setChapter(null);
                }}
              >
                <span className="row__main">
                  <span className="row__title">{item.longName}</span>
                </span>
                <span className="row__count">{item.chapters}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : !chapter ? (
        <div className="grid">
          {Array.from({ length: book.chapters }, (_, index) => index + 1).map((number) => (
            <button key={number} className="cell" onClick={() => setChapter(number)}>
              {number}
            </button>
          ))}
        </div>
      ) : (
        <ul className="list">
          {verses.map((verse) => (
            <li key={verse.verse}>
              <button
                className="row row--verse"
                onClick={() => onShow(translation, book.number, chapter, verse.verse)}
              >
                <span className="row__num">{verse.verse}</span>
                <span className="row__main">
                  <span className="row__text">{verse.text}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
