# LyricVerse 2.0

Song and Scripture presentation for worship services — a rewrite of the PyQt5
LyricVerse 1.x in **Tauri + React + TypeScript**, with a **Rust** backend.

Project lyrics and Bible passages onto any number of screens, each with its own
independent layout, including a chroma-key lower-third mode for live streaming.

---

## Installing it

Grab the latest build from
[Releases](https://github.com/0xt1m/LyricVerse-2.0/releases) and pick the file
for your machine:

| Machine | Download |
|---|---|
| Mac, Apple silicon (M1 and later) | `LyricVerse_<version>_aarch64.dmg` |
| Mac, Intel | `LyricVerse_<version>_x64.dmg` |
| Windows | `LyricVerse_<version>_x64-setup.exe` |
| Linux | `LyricVerse_<version>_amd64.AppImage` |

The `.tar.gz` files alongside them are for the built-in updater, not for
installing by hand — ignore them.

Once installed, the app looks after its own updates: it checks on startup,
downloads a new version quietly in the background, and applies it when you
quit, so an update can never interrupt a service.

### macOS will refuse to open it the first time

The builds are not yet signed with an Apple Developer ID, so Gatekeeper blocks
them with *"LyricVerse is damaged and can't be opened"* — misleading wording;
the app is fine, macOS simply cannot identify who built it. Once, after
installing:

```bash
xattr -dr com.apple.quarantine /Applications/LyricVerse.app
```

Then open it normally. This is not needed again, including after updates.

### It starts empty

No songbooks or Bible translations ship with the app — they belong to your
congregation, not to the program. Add your own from **Settings → Songbooks and
translations**, or import songs from files with **Song → Import Songs…** in the
menu bar. A public-domain King James Version is included to start with.

---

## Running it

```bash
cd "LyricVerse 2.0"
npm install
npm run dev          # operator console, with hot reload
```

`npm run build` produces a signed-ready `.app`/`.dmg` (macOS), `.msi` (Windows)
or `.deb`/`.AppImage` (Linux) in `src-tauri/target/release/bundle/`.

Requirements: **Node 18+** and a **Rust** toolchain (`rustup`). On macOS you also
need the Xcode command-line tools.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript, no emit |
| `npm run prepare-resources` | Stages seed data into `src-tauri/resources/` (runs automatically before `dev`/`build`) |
| `npm run build-english-bible` | Regenerates the bundled KJV module |
| `cargo test` (in `src-tauri/`) | 18 unit tests + 3 integration tests over the real databases |

---

## How it is put together

```
src-tauri/src/
  lib.rs        Tauri commands, app state, event fan-out
  songs.rs      Songbook SQLite store: parse, CRUD, .db/.sps import
  bible.rs      MyBible reader: books, chapters, verses, search, references
  settings.rs   Per-screen layouts and styling, atomically persisted
  fonts.rs      System font discovery (parses each font's `name` table)
  display.rs    Monitor enumeration and projection-window reconciliation
  live.rs       What is currently on screen
  seed.rs       First-run/upgrade population of the user's data folder
  text.rs       Markup stripping and search normalisation
  paths.rs      Path safety, data-folder layout

src/
  api/          Typed `invoke` wrappers mirroring the Rust structs
  app/          Store (zustand), shell, transport bar, shortcuts
  components/   Songs / Bible / Displays / Settings tabs, editors, previews
  display/      The projection surface — Stage + auto-fitting text
  lib/          Deck compilation, i18n, text normalisation
```

### The deck model

Songs and scripture both compile to a common `Deck` of slides, each carrying
**both** the whole section (for standard screens) and a single line (for
stream screens). The transport controls, keyboard shortcuts and preview
therefore work identically in either tab, and the two rendering modes cannot
drift apart.

### Selected vs. live

The highlighted slide and the slide on screen are tracked separately. Typing a
reference into the Bible quick-search walks the lists without pushing anything
to the projector; <kbd>Enter</kbd>, a click, or the transport buttons commit it.

### Content types

| Tab | What it projects |
| --- | --- |
| Songs | lyrics from the songbooks |
| Bible | passages from a MyBible module |
| Slides | image decks — PDFs rasterised at import, or photographs |
| Video | imported clips, or a YouTube link |
| Timer | a countdown, count-up or clock overlaid on any screen |

All of them compile to the same `Deck` of slides, so the transport controls,
keyboard shortcuts and previews work identically everywhere.

PDFs are rendered to PNGs **once, at import**. That costs a little disk but
means a deck that imported cleanly can never render differently later — no
renderer version, missing font or lazy page load can surprise anyone
mid-service. PowerPoint and Keynote are exported to PDF by the app that made
them; re-rendering their XML in a webview looks compatible right up to the
point where it silently mangles a slide.

A YouTube item embeds the official player and is the only part of LyricVerse
that needs the network — the UI marks those items so it is obvious before a
service rather than during one.

### Screens and layouts

Each connected monitor gets an independent configuration: standard (full-screen
text on a solid background) or stream (a lower-third band over a chroma-key
fill). **Every geometry value is a percentage of the target screen**, so a look
tuned on one projector survives being sent to a different resolution.

A screen renders with a **preset** — a complete named look. Three ship with the
app (**Standard**, **Stream**, **Confidence**) and any number can be created,
duplicated, renamed or reset; built-ins cannot be deleted. Presets are shared,
so editing one changes every screen using it, and the picker shows how many
that is.

What used to be the `standard`/`stream` mode enum is now a per-preset switch —
*keep the background fixed*, which is what a chroma key requires. They were
only ever two points in the same space.

Each preset holds three independent **layouts** — songs, scripture, and
slides/video — because they want different things on screen. A layout is a set of
elements, each with its own box, font and visibility:

| Element | Songs | Scripture |
| --- | --- | --- |
| `body` | the lyrics | the passage |
| `title` | song title | book name |
| `number` | song number | verse number |
| `sectionLabel` | "Куплет 2" | — |
| `reference` | — | "Івана 3:16" |
| `translation` | — | translation name |

Everything except `body` is off by default and switched on per screen, so the
projector can show just lyrics while the stream overlay also carries the number
and the section label.

**Displays → the example screen** is a live editor: drag an element to move it,
drag a corner to resize, and it snaps to the edges, centres and thirds. Hold
<kbd>Shift</kbd> while resizing to keep the box's proportions, or <kbd>Alt</kbd>
to place it freely. The canvas renders the *same* `Stage`
component the projector does at the screen's real aspect ratio, so the
auto-fitted type size, wrapping and shadows are exactly what the room will see.

There is deliberately **no font-size setting**. Text is always drawn as large
as its box allows — the box *is* the size control. Resize it on the example
screen and the type follows, so a forty-word verse and a two-word chorus both
fill the frame without overflowing it.

A **Sample** button cycles through four pieces of test content per type,
deliberately mixed in length (a one-word chorus up to a four-line verse), so a
layout can be checked against real material before a service.

A standard-mode screen can sit its text over a **background image or looping
video** (JPEG, PNG, WebP, GIF · MP4, MOV, WebM). The **active** and **blanked**
states each get their own backdrop, so a screen can carry an idle loop between
items and switch to a different still behind the lyrics. Each has its own fit
(cover / contain / stretch) and dim slider to keep text legible over busy
footage.

Imported files are copied into the app's `Backgrounds/` folder — so a
background keeps working after the original is moved, and the webview's asset
scope stays limited to that one directory. Stream mode deliberately offers no
media: its fill has to stay one flat colour for the video switcher to key on.

Every section of the editor has a **reset** button that restores just that
group — font, colour, alignment, position, shadow, background, or the whole
layout — to the values a fresh install would have. Those defaults come from the
backend (`Bootstrap.defaults`) rather than being a second copy in the UI that
could drift.

Fonts are read from the machine's own font files (`src-tauri/src/fonts.rs`
parses each file's `name` table), so the picker lists every family actually
installed — the webview has no API for this.

The operator's own screen is never projected onto — a borderless, always-on-top,
full-screen window over the console would hide the controls needed to dismiss
it. Its style can still be edited and checked with **Displays → Test window**,
which opens an ordinary resizable window rendering the exact same output.

### Web screens

Not every screen in a hall has a cable to the operator's machine. **Displays →
+** adds a *web screen*: LyricVerse serves the projection page over the local
network and any device — a tablet on the sound desk, a TV with a browser, a
phone held by whoever is leading — opens it at `http://<this machine>:8088`.

It is the **same document the projection windows run**, so a browser screen
gets the operator's layout exactly, down to the auto-fitted type size, rather
than a second implementation that can drift. Only the transport differs: a
held-open request instead of Tauri's event bus. The server keeps each request
open until something changes, so an idle screen makes about two requests a
minute and a slide change arrives as fast as the network carries it.

A web screen is a screen like any other: it has an entry in `displays`, so it
picks a preset, appears in the previews and gets the whole layout editor for
free. It is arranged against 16:9, since it has no size of its own.

`src-tauri/src/webscreen.rs` is a hand-rolled HTTP server — four routes did not
justify an async runtime and a dependency tree larger than the rest of the
backend. Points worth knowing:

- It binds `0.0.0.0`, on purpose: a screen only this machine could open would
  be pointless. Anyone on the network who knows the port can watch the output.
- `/api/media` resolves the requested path and then checks it is inside the
  app's data directory, so it is not an open file server for the whole disk.
- It answers byte-range requests, because Safari will not play a video at all
  from a server that cannot seek.
- Timers are anchored to the host's clock, so each frame carries the host's
  time and the browser corrects for its own clock being out.
- Fonts come from the viewing device. A preset naming a font that a tablet does
  not have falls back to its sans-serif.
- In a `npm run dev` build the bundle is not embedded, so a web screen serves
  whatever `npm run build:vite` last produced. Release builds serve themselves.

### Data

Everything the user owns lives outside the app bundle:

```
~/Library/Application Support/app.lyricverse.desktop/    (macOS)
  Songbooks/          *.db + songbooks.json
  BibleTranslations/  *.SQLite3 + translations.json
  Backgrounds/        imported images and videos
  settings.json
  .seeded.json        which bundled files have been offered
```

Updating the app can never touch it — the failure mode v1's own source code
warned about (`main.py`: *"My updater is gonna mess up all the settings and
songbooks"*).

`.seeded.json` records *which* files have been placed, so content the user
deleted never reappears while content added by a later version still arrives.

### File formats

Songbooks keep v1's `Songs(id, title, song_text)` SQLite shape, so existing
books open unchanged. `song_text` is written with both the v1 keys
(`Couplets`/`Chorus`/`Bridges`) **and** a `v2` block holding explicit sections
plus a running order — v1 can still read files v2 has written.

Bible translations are standard [MyBible](https://mybible.zone) `.SQLite3`
modules. Bundled: Ogienko 1962, Ogienko 1988, and a King James Version built
from public-domain text by `scripts/build-english-bible.mjs`.

---

## What changed from 1.x

### Bugs fixed

| # | v1 behaviour | Fix |
| --- | --- | --- |
| 1 | `INSERT INTO Songs … VALUES ('{title}', '{text}')` built by f-string — any apostrophe (common in Ukrainian titles) corrupted the row or failed | All SQL uses bound parameters |
| 2 | Dragging a `.sps` file onto the "Add songbook" window set a label, then read `self.selected_file_path`, which only the file-picker path ever assigned → `AttributeError`. `importSongsFromSP` was dead code | One import path handles `.db` and `.sps`; SongPro conversion is implemented and covered by the tests |
| 3 | Song search matched only couplets + chorus — **searching by title silently failed** — and crashed on `Chorus: null` | Searches number, title and opening line; null-safe parsing |
| 4 | `if A and B or C` in `keyPressEvent` parsed as `(A and B) or C`, so Enter on the Songs tab could fire the Bible action | Per-tab handlers, no ambiguous precedence |
| 5 | `open_window()` rebuilt every projection window without closing the old ones — one leaked full-screen window per call | `display::sync` reconciles: opens what should exist, closes what should not, repositions the rest |
| 6 | Opening a translation **wrote a `verses_search` table into the Bible file** and loaded all 31 000 verses twice | Never writes to a translation; the normalised index is built once in memory |
| 7 | Bible search rescanned every verse on each keystroke and returned only the first hit | Pre-normalised index, ranked result list, debounced |
| 8 | Stress marks were handled by a hand-written list of a dozen `.replace()` calls per verse | Strips the whole combining-diacritical range; also folds Latin/Cyrillic look-alikes so `i` finds `і` |
| 9 | `count_of_chapters` returned `len(set(chapters))` and rendered `1..n` — mislabelling every chapter in a book with a gap | Lists the chapter numbers actually present |
| 10 | `SmartLabel.ownWordWrap` stepped the font size by 2 and re-wrapped by hand at each step, inserting literal newlines | Binary search over ~9 layout passes; the browser wraps |
| 11 | Bridges were addressed by index into the *rendered* list, so the position shifted with the chorus | Explicit section ids and a running order; an integration test asserts every order entry resolves |
| 12 | `setCurrentRow(song.number - 1)` assumed song ids were contiguous from 1 | Selection is by id |
| 13 | `disconnect(self.show_song)` without a guard threw when not connected; the code was littered with `try/except: pass` around signal juggling | Declarative React state; no manual signal bookkeeping |
| 14 | `open("Bible_translations/…")` vs. the real `bible_translations/` — worked only on case-insensitive filesystems | One resolved path constant |
| 15 | Absolute pixel positions (`info_position: {x: 1400, y: 950}`) silently mis-placed everything at a different resolution | All geometry is a percentage of the screen |
| 16 | No way to delete a song or a songbook | Both, with the destructive "also erase the file" step opted into separately |
| 17 | Song #606 of the shipped `ps_us.db` has an empty title (v1's importer took `line.split(".")[1]`) and rendered as a blank, unfindable row | Falls back to the opening line |
| 18 | Book matching missed `1 ів` against a module naming the book `1-е Iвана` | Exact → prefix → substring → token-prefix → abbreviation matching |

### New

- **Live preview** of every enabled screen, rendered by the same component the
  projector uses, so what you see is what the room sees. v1 had none — settings
  were checked by pushing them to the projector mid-service.
- **Test window** for setting up a layout with no projector attached.
- **Quick reference search** — `rm 3 23`, `jn 3:16-18`, `1 co 13:4-7`, `мт 10 10`.
- **Verse ranges** — shift-click, or type a range, to put a passage up as one slide.
- **Full-text Bible search** with ranked results and match highlighting.
- **Song editor** whose single list *is* the running order: drag a section to
  move it, repeat it, or drop it. A repeated chorus stays one piece of text in
  several places. v1 hard-coded chorus-after-verse.
- **Keyboard transport** — <kbd>Space</kbd>/<kbd>→</kbd> next, <kbd>←</kbd> previous,
  <kbd>Esc</kbd>/<kbd>B</kbd> blank, <kbd>/</kbd> search, <kbd>⌘1–4</kbd> tabs.
- **Visual layout editor** — drag and resize each element on an example screen,
  with snapping, numeric entry, per-element font, weight, colour, opacity,
  alignment and shadow.
- **Content toggles** — choose per screen whether the song title, number,
  section label, scripture reference, verse number and translation appear.
- **System font picker** with a live sample, listing every installed family.
- **Image and video backgrounds** for both the active and blanked states, with fit and dimming.
- **Per-section resets** sourced from the backend's own defaults.
- **Right-click menus** on songs, slides, verses, songbooks, screens, layout
  elements and backgrounds — show, edit, duplicate, copy, hide, delete.
- **Bilingual UI** (Ukrainian / English), switchable in Settings.
- **Identify screens** — flashes each screen's name on the screen itself.
- One editor instead of v1's two near-identical 270-line add/edit windows whose
  logic had already diverged.

### Tests

`cargo test` runs 18 unit tests plus 3 integration tests that exercise the real
shipped data: all **1 555 songs across 3 songbooks** parse with a valid running
order, all **3 translations** load with every advertised chapter populated and
no residual markup, and the reference parser resolves the abbreviations an
operator actually types. Two of the bugs above (#17, #18) were found by those
tests rather than by reading the code.
