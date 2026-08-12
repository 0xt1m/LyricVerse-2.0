import { useEffect, useMemo, useRef, useState } from "react";
import { useGridReorder } from "../lib/dragReorder";
import { api } from "../api";
import type { LyricsDraft, Song } from "../api/types";
import { useStore } from "../app/store";
import { sectionLabel } from "../lib/i18n";
import { KEY_ROOTS, foldRepeats, splitKey } from "../lib/song";
import { useContextMenu } from "./ui/ContextMenu";
import { Icon } from "./ui/Icon";
import { Modal, useDebounced } from "./ui/controls";

/**
 * Writing a song: the words on the left, the sections they make on the right.
 *
 * One dialog for a new song and for an existing one, because they are the same
 * job — a song is its words, and everything else about it follows from where
 * the blank lines fall. Typing or pasting into the left column re-cuts the
 * song, and the right column shows what that will be *before* anything is
 * saved: a guess the operator cannot see is a guess they cannot correct.
 *
 * The tiles here are a preview and nothing more. Re-kinding a section, moving
 * one, splitting one by hand — that is the editor in the tab, where there is
 * room for it.
 */
export function SongDialog({
  songbook,
  song,
  onClose,
  onSaved,
}: {
  songbook: string;
  /** The song being rewritten, or null for a new one. */
  song: Song | null;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const t = useStore((s) => s.t);
  const openMenu = useContextMenu();
  const language = useStore((s) => s.settings.language);
  const reportError = useStore((s) => s.reportError);

  const settings = useStore((s) => s.settings);
  const patchSettings = useStore((s) => s.patchSettings);

  const [title, setTitle] = useState(song?.title ?? "");
  // The key and the tempo live in the settings rather than in the songbook —
  // those files are the v1 format the old app still opens — so they are read
  // and written by song id, and a new song only gets one once it is saved.
  const [songKey, setSongKey] = useState(
    () => (song ? (settings.songKeys[songbook]?.[String(song.id)] ?? "") : ""),
  );
  const [bpm, setBpm] = useState(() =>
    song ? String(settings.songBpm[songbook]?.[String(song.id)] ?? "") : "",
  );
  const [minutes, setMinutes] = useState(() =>
    song ? String(settings.songMinutes[songbook]?.[String(song.id)] ?? "") : "",
  );
  const [words, setWords] = useState(() => (song ? asWords(song, language) : ""));
  const [draft, setDraft] = useState<LyricsDraft | null>(null);
  const [busy, setBusy] = useState(false);

  // The splitting runs in the backend, so it waits for a pause in the typing
  // rather than going once per keystroke.
  const settled = useDebounced(words, 250);

  useEffect(() => {
    if (!settled.trim()) {
      setDraft(null);
      return;
    }
    let cancelled = false;
    void api
      .parseLyrics(settled)
      // A chorus written out twice is one section sung twice, not two
      // sections — which is what makes it one thing to edit afterwards.
      .then((result) => !cancelled && setDraft(foldRepeats(result)))
      .catch(() => !cancelled && setDraft(null));
    return () => {
      cancelled = true;
    };
  }, [settled]);

  /** The preview tiles: each section once, labelled as the app will label it. */
  const tiles = useMemo(() => {
    if (!draft) return [];
    const totals = new Map<string, number>();
    for (const section of draft.sections) {
      totals.set(section.kind, (totals.get(section.kind) ?? 0) + 1);
    }
    const ordinals = new Map<string, number>();
    return draft.sections.map((section) => {
      const ordinal = (ordinals.get(section.kind) ?? 0) + 1;
      ordinals.set(section.kind, ordinal);
      return {
        id: section.id,
        kind: section.kind,
        text: section.text,
        label:
          section.label?.trim() ||
          sectionLabel(language, section.kind, ordinal, totals.get(section.kind) ?? 1),
        // How often it is sung. Worth saying: it is the one thing the splitter
        // decided that is not visible in the words themselves.
        times: draft.order.filter((id) => id === section.id).length,
      };
    });
  }, [draft, language]);

  /**
   * Enough of a song to keep: a name, or some words.
   *
   * Neither means there is nothing to save — and a row in the list with no
   * title and no words is a thing somebody has to find and delete later.
   */
  const canSave = title.trim().length > 0 || words.trim().length > 0;
  /** Set when a click outside was refused, so the dialog says why. */
  const [blocked, setBlocked] = useState(false);

  const { root, minor } = splitKey(songKey);
  // Anything from the old free-text field that is not one of the roots —
  // "capo 2", say — keeps an option of its own rather than being dropped.
  const foreign = root && !KEY_ROOTS.includes(root as (typeof KEY_ROOTS)[number]) ? root : "";

  const box = useRef<HTMLTextAreaElement>(null);

  /**
   * Undo, over the words.
   *
   * A browser can undo typing on its own, but not a section dragged to a new
   * place, split, duplicated or deleted — those rewrite the box from the
   * outside, and the native stack knows nothing about them. Since half the
   * edits here are of that kind, the whole lot is kept here instead: every
   * change pushes what the words were, and ⌘Z walks back through them.
   *
   * Typing is gathered up rather than kept keystroke by keystroke — undoing a
   * sentence one letter at a time is not undo, it is waiting.
   */
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastPush = useRef(0);

  const write = (next: string, { typing = false } = {}) => {
    const now = performance.now();
    if (!typing || now - lastPush.current > TYPING_GAP_MS) {
      past.current = [...past.current.slice(-HISTORY), words];
      lastPush.current = now;
    }
    future.current = [];
    setWords(next);
    setBlocked(false);
  };

  const step = (back: boolean) => {
    const from = back ? past : future;
    const to = back ? future : past;
    const previous = from.current.pop();
    if (previous === undefined) return;
    to.current.push(words);
    // A jump backwards is not typing, so the next keystroke starts its own
    // entry rather than being folded into whatever was undone.
    lastPush.current = 0;
    setWords(previous);
    setShown(null);
    setBlocked(false);
  };
  /** Where the caret sits in the words, so Split knows if it is inside a part
   *  rather than at one end of one. */
  const [caret, setCaret] = useState(0);

  /**
   * Starts a new part, named, where the caret is.
   *
   * The heading is what tells the splitter where one section ends and the next
   * begins, and typing brackets by hand is both fiddly and easy to get subtly
   * wrong. Verses are numbered from the ones already written, so pressing
   * Verse four times gives four verses rather than four of the first.
   *
   * Where the caret is, so a part can be pushed into the middle of a song
   * already written. With the caret nowhere — nobody has clicked into the box
   * yet — the end of the song is what "here" means.
   */
  const addHeading = (kind: string) => {
    const existing = words.match(/^\s*\[[^\]]+\]/gm) ?? [];
    const base = sectionLabel(language, kind, 1, 1);
    const ordinal = existing.filter((line) => line.includes(base)).length + 1;
    // Only verses are numbered: a song has one chorus that comes round, and
    // "[Chorus 1]" would make two of it.
    const heading = kind === "verse" ? `[${base} ${ordinal}]` : `[${base}]`;

    const field = box.current;
    const at = field && document.activeElement === field ? field.selectionStart : words.length;
    // The blank lines around it are what make it a section rather than a line
    // in the middle of the one above.
    const before = words.slice(0, at).replace(/\s+$/, "");
    const after = words.slice(at).replace(/^\s+/, "");
    const opening = `${before ? `${before}\n\n` : ""}${heading}\n`;
    write(`${opening}${after ? `\n${after}` : ""}`);

    // The caret follows it: what is wanted next is the words underneath.
    window.setTimeout(() => {
      if (!field) return;
      field.focus();
      field.setSelectionRange(opening.length, opening.length);
    }, 0);
  };

  /**
   * Cuts the part the caret is in, in two.
   *
   * A long verse that wants to be two slides, or a chorus with a tag on the
   * end: the split is a blank line, because a blank line is what divides one
   * part from the next everywhere else here. The second half repeats the
   * heading of the first, so a chorus cut in two is two choruses rather than a
   * chorus and a verse.
   */
  const splitHere = () => {
    const before = words.slice(0, caret).replace(/\s+$/, "");
    const after = words.slice(caret).replace(/^\s+/, "");
    if (!before || !after) return;
    // The heading the caret is under: the last one written above it.
    const heading = (before.match(/^\s*\[[^\]]+\]/gm) ?? []).pop()?.trim() ?? "";
    const opening = `${before}\n\n${heading ? `${heading}\n` : ""}`;
    write(`${opening}${after}`);
    window.setTimeout(() => {
      const field = box.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(opening.length, opening.length);
      setCaret(opening.length);
    }, 0);
  };

  /** True when the caret has words on both sides of it inside one part. */
  const canSplit =
    words.slice(0, caret).trim().length > 0 && words.slice(caret).trim().length > 0;

  /**
   * The words as blocks, and where a section's block sits among them.
   *
   * Both the actions below work on the text rather than on the preview,
   * because the text is what the song is made of here — the tiles are what it
   * came to. A section standing in the order twice is found at its first
   * block, which is the one somebody pointing at it means.
   */
  const blocksOf = () => words.split(/\n{2,}/);

  /**
   * Writes a section out again, straight after itself.
   *
   * Left as it is, the two identical blocks fold back into one section sung
   * twice — the tile says ×2 — and edited, the copy becomes a section of its
   * own. Both are what somebody means by "again", and which one they meant is
   * decided by what they type next rather than by a choice up front.
   */
  const duplicate = (text: string) => {
    const blocks = blocksOf();
    const at = blocks.findIndex((block) => bare(block) === bare(text));
    if (at < 0) return;
    blocks.splice(at + 1, 0, blocks[at]!);
    write(blocks.join("\n\n"));
  };

  /** Takes a section out of the song. Its words go with it. */
  const removeBlock = (text: string) => {
    const blocks = blocksOf();
    const at = blocks.findIndex((block) => bare(block) === bare(text));
    if (at < 0) return;
    blocks.splice(at, 1);
    write(blocks.join("\n\n"));
  };

  /** Moves a section one place up or down the song. */
  const moveBlock = (text: string, delta: number) => {
    const blocks = blocksOf();
    const at = blocks.findIndex((block) => bare(block) === bare(text));
    const to = at + delta;
    if (at < 0 || to < 0 || to >= blocks.length) return;
    const [moved] = blocks.splice(at, 1);
    blocks.splice(to, 0, moved!);
    write(blocks.join("\n\n"));
  };

  /**
   * Dragging a tile to a new place in the song.
   *
   * The words are still what is saved, so a drag rewrites them — but the
   * splitter answers on a delay, and a preview that only caught up 250ms later
   * would slide about under the pointer. So the tiles are reordered here at
   * once and the splitter's answer replaces them when it arrives, which it
   * will agree with.
   */
  const [shown, setShown] = useState<typeof tiles | null>(null);
  useEffect(() => setShown(null), [draft]);
  const view = shown ?? tiles;

  const tilesRef = useRef<HTMLDivElement>(null);
  /** The words as they were when the current drag started, pushed onto the
   *  history the first time that drag actually moves something. */
  const beforeDrag = useRef("");
  const dragPushed = useRef(false);

  const { dragging, beginPress } = useGridReorder({
    containerRef: tilesRef,
    onMove: (from, to) => {
      const moved = view[from];
      const onto = view[to];
      if (!moved || !onto) return;
      if (!dragPushed.current) {
        past.current = [...past.current.slice(-HISTORY), beforeDrag.current];
        future.current = [];
        lastPush.current = 0;
        dragPushed.current = true;
      }
      // Written against the words as they are *now*: several moves can land
      // between two renders while the pointer is travelling.
      setWords((current) => {
        const blocks = current.split(/\n{2,}/);
        const at = blocks.findIndex((block) => bare(block) === bare(moved.text));
        const target = blocks.findIndex((block) => bare(block) === bare(onto.text));
        if (at < 0 || target < 0) return current;
        const [taken] = blocks.splice(at, 1);
        blocks.splice(target, 0, taken!);
        return blocks.join("\n\n");
      });
      const next = [...view];
      const [taken] = next.splice(from, 1);
      next.splice(to, 0, taken!);
      setShown(next);
      setBlocked(false);
    },
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.code !== "KeyZ") return;
      // The small fields — title, key, tempo, length — are ordinary inputs
      // with an undo of their own that works. Only the words need this.
      const target = event.target as HTMLElement | null;
      if (target && target !== box.current && /^(INPUT|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      step(!event.shiftKey);
    };
    // Capture, because a textarea would otherwise undo through its own stack
    // first and put back something this one knows nothing about.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const save = async () => {
    setBusy(true);
    try {
      // An empty song is allowed: somebody may want the place first and the
      // words later, and the tab's editor is where they will type them.
      const sections = draft?.sections ?? [{ id: "v1", kind: "verse" as const, text: "" }];
      const order = draft?.order ?? ["v1"];
      const id = await api.saveSong(songbook, {
        id: song?.id ?? 0,
        title: title.trim() || t("songs.untitled"),
        sections,
        order,
      });
      // Written against the id, which for a new song is only known now.
      const keys = { ...(settings.songKeys[songbook] ?? {}) };
      const tempos = { ...(settings.songBpm[songbook] ?? {}) };
      const lengths = { ...(settings.songMinutes[songbook] ?? {}) };
      const tempo = Number.parseInt(bpm, 10);
      const length = Number.parseInt(minutes, 10);
      if (songKey.trim()) keys[String(id)] = songKey.trim();
      else delete keys[String(id)];
      if (Number.isFinite(tempo) && tempo > 0) tempos[String(id)] = Math.min(tempo, 400);
      else delete tempos[String(id)];
      // Cleared means "nobody has timed it", which is not the same as zero:
      // the plan then gives the line no length rather than a length of none.
      if (Number.isFinite(length) && length > 0) lengths[String(id)] = length;
      else delete lengths[String(id)];
      await patchSettings({
        songKeys: { ...settings.songKeys, [songbook]: keys },
        songBpm: { ...settings.songBpm, [songbook]: tempos },
        songMinutes: { ...settings.songMinutes, [songbook]: lengths },
      });

      onSaved(id);
      onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={song ? t("songs.edit") : t("songs.new")}
      large
      fill
      onClose={onClose}
      // Clicking past the edge of a dialog somebody has been writing in means
      // "I am done", not "throw that away" — so it saves. With nothing worth
      // saving it holds the dialog open and says what is missing; Cancel is
      // the way out that discards.
      onDismiss={() => (canSave ? void save() : setBlocked(true))}
      footer={
        <>
          <span className={blocked ? "field__hint field__hint--error" : "field__hint"}>
            {blocked
              ? t("songs.formNeeds")
              : draft
                ? t("songs.formSummary", {
                    sections: draft.sections.length,
                    slides: draft.order.length,
                  })
                : t("songs.formEmpty")}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !canSave}
            onClick={() => void save()}
          >
            {song ? t("common.save") : t("songs.create")}
          </button>
        </>
      }
    >
      <div className="songform">
        <div className="songform__words">
          <input
            className="input"
            style={{ fontSize: 15, fontWeight: 600 }}
            value={title}
            autoFocus
            placeholder={t("editor.title")}
            onChange={(event) => {
              setTitle(event.target.value);
              setBlocked(false);
            }}
          />
          {/* What the band needs, beside the title it belongs to. */}
          <div className="songform__meta">
            <span className="song__key" title={t("songs.keyHint")}>
              <select
                className="select"
                value={root}
                onChange={(event) =>
                  setSongKey(event.target.value ? event.target.value + (minor ? "m" : "") : "")
                }
              >
                <option value="">{t("songs.keyShort")}</option>
                {foreign && <option value={foreign}>{foreign}</option>}
                {KEY_ROOTS.map((note) => (
                  <option key={note} value={note}>
                    {note}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="song__minor"
                data-on={minor || undefined}
                disabled={!root}
                title={t("songs.keyMinor")}
                aria-pressed={minor}
                onClick={() => setSongKey(root + (minor ? "" : "m"))}
              >
                m
              </button>
            </span>
            <label className="song__field" title={t("songs.bpmHint")}>
              <input
                className="input song__number"
                inputMode="numeric"
                maxLength={3}
                value={bpm}
                onChange={(event) => setBpm(event.target.value.replace(/\D/g, ""))}
              />
              <span className="song__unit">{t("songs.bpmShort")}</span>
            </label>
            {/* How long it runs, which the plan uses as the line's length. */}
            <label className="song__field" title={t("songs.minutesHint")}>
              <input
                className="input song__number"
                inputMode="numeric"
                maxLength={3}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value.replace(/\D/g, ""))}
              />
              <span className="song__unit">{t("songs.minutesShort")}</span>
            </label>
          </div>
          <textarea
            ref={box}
            className="textarea songform__text"
            value={words}
            placeholder={t("editor.lyricsPlaceholder")}
            spellCheck={false}
            onChange={(event) => {
              write(event.target.value, { typing: true });
              setCaret(event.target.selectionStart);
            }}
            // Fires for every way the caret can move — typing, clicking, the
            // arrow keys — which is what Split has to follow.
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          />
          {/* What can be added, under the box it is added to. */}
          <div className="songform__adds">
            {KINDS.map(({ kind, key }) => (
              <button key={kind} type="button" className="btn btn--sm" onClick={() => addHeading(kind)}>
                <Icon name="plus" size={11} />
                {t(key)}
              </button>
            ))}
            {/* Cutting a part in two is the other half of arranging a song by
                typing, and it acts where the caret is, so it sits with the
                buttons that also do. */}
            <button
              type="button"
              className="btn btn--sm"
              disabled={!canSplit}
              title={t("editor.splitHint")}
              onClick={splitHere}
            >
              <Icon name="chevronDown" size={11} />
              {t("editor.split")}
            </button>
          </div>
          <span className="field__hint">{t("editor.lyricsHint")}</span>
        </div>

        <div className="songform__tiles" ref={tilesRef}>
          {view.length === 0 ? (
            <div className="songform__blank">{t("songs.formHint")}</div>
          ) : (
            view.map((tile, index) => (
              <div
                key={tile.id}
                className="songform__tile"
                data-kind={tile.kind}
                data-dragging={dragging === index || undefined}
                // The whole tile drags: an 18px handle that appears on hover
                // is easy to miss, and a press that grabs nothing reads as the
                // feature being broken.
                onPointerDown={(event) => {
                  beforeDrag.current = words;
                  dragPushed.current = false;
                  beginPress(event, index);
                }}
                onContextMenu={(event) =>
                  openMenu(event, [
                    {
                      label: t("menu.duplicate"),
                      icon: "copy",
                      onSelect: () => duplicate(tile.text),
                    },
                    {
                      label: t("editor.moveUp"),
                      icon: "arrowUp",
                      onSelect: () => moveBlock(tile.text, -1),
                    },
                    {
                      label: t("editor.moveDown"),
                      icon: "arrowDown",
                      onSelect: () => moveBlock(tile.text, 1),
                    },
                    "separator",
                    {
                      label: t("common.delete"),
                      icon: "trash",
                      danger: true,
                      onSelect: () => removeBlock(tile.text),
                    },
                  ])
                }
              >
                <div className="songform__tileHead">
                  <span>{tile.label}</span>
                  {/* Only when it comes round again — "×1" on every tile would
                      be noise on the ones that do not. */}
                  {tile.times > 1 && <span className="songform__times">×{tile.times}</span>}
                  <div style={{ flex: 1 }} />
                  {/* Up, down and again — the whole of arranging a song, on
                      the tile being arranged. */}
                  <button
                    type="button"
                    className="songform__act"
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("editor.moveUp")}
                    onClick={() => moveBlock(tile.text, -1)}
                  >
                    <Icon name="arrowUp" size={12} />
                  </button>
                  <button
                    type="button"
                    className="songform__act"
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("editor.moveDown")}
                    onClick={() => moveBlock(tile.text, 1)}
                  >
                    <Icon name="arrowDown" size={12} />
                  </button>
                  <button
                    type="button"
                    className="songform__act"
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("menu.duplicate")}
                    onClick={() => duplicate(tile.text)}
                  >
                    <Icon name="copy" size={12} />
                  </button>
                  <button
                    type="button"
                    className="songform__act songform__act--danger"
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("common.delete")}
                    onClick={() => removeBlock(tile.text)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
                <div className="songform__tileText">{tile.text}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

/** How many steps back the words can be walked. Far more than anybody uses in
 *  one sitting, and a few hundred strings costs nothing. */
const HISTORY = 200;

/** Typing inside this of the last entry joins it rather than making its own —
 *  so undo takes back a phrase, not a letter. */
const TYPING_GAP_MS = 700;

/** The parts a song is made of, in the order the buttons offer them. */
const KINDS: { kind: string; key: string }[] = [
  { kind: "verse", key: "editor.addVerse" },
  { kind: "chorus", key: "editor.addChorus" },
  { kind: "bridge", key: "editor.addBridge" },
  { kind: "other", key: "editor.addOther" },
];

/** A block's words, without its heading and without spacing or case — how one
 *  block is recognised as the same part as another. */
function bare(block: string): string {
  return block
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * A song written out as words, the way somebody would type or paste it.
 *
 * Every repeat is written out in full rather than named once: that is how
 * lyrics arrive from a website and how a person would type them, and it is
 * what `foldRepeats` turns back into one section sung twice. Anything else
 * would mean opening a song here and saving it lost its repeats.
 */
function asWords(song: Song, language: string): string {
  const totals = new Map<string, number>();
  for (const section of song.sections) {
    totals.set(section.kind, (totals.get(section.kind) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const section of song.sections) {
    const ordinal = (ordinals.get(section.kind) ?? 0) + 1;
    ordinals.set(section.kind, ordinal);
    labels.set(
      section.id,
      section.label?.trim() ||
        sectionLabel(language, section.kind, ordinal, totals.get(section.kind) ?? 1),
    );
  }

  return song.order
    .map((id) => {
      const section = song.sections.find((candidate) => candidate.id === id);
      if (!section) return "";
      return `[${labels.get(id) ?? ""}]\n${section.text.trim()}`;
    })
    .filter(Boolean)
    .join("\n\n");
}
