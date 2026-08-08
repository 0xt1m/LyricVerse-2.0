import { useEffect, useState } from "react";
import { api } from "../api";
import type { LyricsDraft } from "../api/types";
import { useStore } from "../app/store";
import { Icon } from "./ui/Icon";
import { Field, Modal, useDebounced } from "./ui/controls";

/**
 * A song from a wall of pasted lyrics.
 *
 * What a lyrics site gives you is one unbroken column: no headings, no blank
 * lines, and the chorus written out in full every time it comes round. Typing
 * that into slides by hand is half an hour nobody has on a Saturday night.
 *
 * The words are pasted into the box below and the backend cuts them into
 * slides, folds the repeats into one section each, and calls a block that
 * comes round more than once a chorus. The summary says what it did *before*
 * anything is saved, because a guess the operator cannot see is a guess they
 * cannot correct — and every part of it can still be edited afterwards like
 * any other song.
 */
export function PasteLyricsDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  /** Given the title and what the words became. */
  onCreate: (title: string, draft: LyricsDraft) => Promise<void>;
}) {
  const t = useStore((s) => s.t);
  const reportError = useStore((s) => s.reportError);

  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [draft, setDraft] = useState<LyricsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  // Parsing runs in the backend, so it waits for a pause in the typing rather
  // than going once per keystroke.
  const settled = useDebounced(lyrics, 250);

  useEffect(() => {
    if (!settled.trim()) {
      setDraft(null);
      return;
    }
    let cancelled = false;
    void api
      .parseLyrics(settled)
      .then((result) => !cancelled && setDraft(result))
      .catch(() => !cancelled && setDraft(null));
    return () => {
      cancelled = true;
    };
  }, [settled]);

  const create = async () => {
    if (!draft || draft.sections.length === 0) return;
    setBusy(true);
    try {
      await onCreate(title.trim() || t("songs.untitled"), draft);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  // A section standing in the order more than once is one the splitter
  // recognised coming round again.
  const repeats = draft
    ? draft.order.length - new Set(draft.order).size
    : 0;

  return (
    <Modal
      title={t("songs.pasteLyrics")}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void create()}
            disabled={busy || !draft || draft.sections.length === 0}
          >
            <Icon name="plus" size={13} />
            {t("songs.pasteCreate")}
          </button>
        </>
      }
    >
      <Field label={t("common.name")}>
        <input
          className="input"
          value={title}
          placeholder={t("songs.untitled")}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>

      <Field label={t("songs.pasteWords")} hint={t("songs.pasteHint")}>
        <textarea
          className="textarea"
          style={{ minHeight: 170, fontFamily: "inherit" }}
          value={lyrics}
          autoFocus
          spellCheck={false}
          placeholder={t("songs.pastePlaceholder")}
          onChange={(event) => setLyrics(event.target.value)}
        />
      </Field>

      {/* Its own scroll box: a long song must not push the words being pasted,
          or the Create button, off the dialog. */}
      {draft && draft.sections.length > 0 && (
        <div className="group group--scroll" style={{ maxHeight: 260 }}>
          <div className="group__head">
            {t("songs.pasteSummary", { slides: draft.order.length, parts: draft.sections.length })}
            <div className="topbar__spacer" />
            {repeats > 0 && (
              <span className="field__hint">{t("songs.pasteRepeats", { n: repeats })}</span>
            )}
          </div>
          <div className="group__body paste-preview">
            {draft.order.map((id, index) => {
              const section = draft.sections.find((item) => item.id === id);
              if (!section) return null;
              const lines = section.text.split("\n");
              return (
                <div key={`${id}:${index}`} className="paste-card">
                  <div className="paste-card__head">
                    <span className="tile__label" data-kind={section.kind}>
                      {t(`editor.add${section.kind === "chorus" ? "Chorus" : "Verse"}`)}
                    </span>
                    <span className="paste-card__index">{index + 1}</span>
                  </div>
                  <div className="paste-card__body">{lines.slice(0, 2).join(" / ")}</div>
                  <div className="field__hint">{t("songs.pasteLines", { n: lines.length })}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
