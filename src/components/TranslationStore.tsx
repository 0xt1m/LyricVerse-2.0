import { useEffect, useState } from "react";
import { EVENT, api, on } from "../api";
import type { DownloadProgress, RemoteTranslation } from "../api/types";
import { useStore } from "../app/store";
import { Icon } from "./ui/Icon";
import { Empty, Modal } from "./ui/controls";

/**
 * The translations lyricverse.app is offering, and a button to fetch one.
 *
 * The alternative is telling somebody to go and find a MyBible module on the
 * internet, which is how a machine ends up with a file nobody can vouch for —
 * or, more often, with no scripture at all until after the service.
 *
 * Nothing here is required: the list is fetched when this opens, and a hall
 * with no internet gets a plain sentence saying so and the file picker it
 * already had.
 */
export function TranslationStore({ onClose }: { onClose: () => void }) {
  const t = useStore((s) => s.t);
  const installed = useStore((s) => s.translations);
  const refreshLibrary = useStore((s) => s.refreshLibrary);
  const patchSettings = useStore((s) => s.patchSettings);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);

  const [offered, setOffered] = useState<RemoteTranslation[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  const load = () => {
    setFailed(null);
    setOffered(null);
    void api
      .listDownloadableTranslations()
      .then(setOffered)
      .catch((error: unknown) => setFailed(errorText(error)));
  };

  useEffect(load, []);

  // Reported by the backend as the bytes arrive, so a 30 MB module on a hall's
  // wi-fi is not a button that looks like it did nothing.
  useEffect(() => {
    const unlisten = on<DownloadProgress>(EVENT.download, setProgress);
    return () => void unlisten.then((off) => off());
  }, []);

  const download = async (entry: RemoteTranslation) => {
    setBusy(entry.name);
    setProgress(null);
    try {
      const meta = await api.downloadTranslation(entry);
      await refreshLibrary();
      await patchSettings({ activeTranslation: meta.name });
      toast(t("bible.imported", { name: meta.name }), "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <Modal
      title={t("bible.download")}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className="group">
        <div className="group__head">
          {t("bible.downloadFrom")}
          <div className="topbar__spacer" />
          <button className="btn btn--sm btn--icon" onClick={load} title={t("common.refresh")}>
            <Icon name="refresh" size={12} />
          </button>
        </div>
        <div className="group__body" style={{ gap: 6 }}>
          {failed && (
            <Empty
              title={t("bible.downloadFailed")}
              hint={failed}
              action={
                <button className="btn" onClick={load}>
                  <Icon name="refresh" size={13} />
                  {t("common.retry")}
                </button>
              }
            />
          )}
          {!failed && offered === null && (
            <div className="field__hint">{t("common.loading")}</div>
          )}
          {!failed && offered?.length === 0 && <div className="field__hint">{t("bible.downloadNone")}</div>}

          {offered?.map((entry) => {
            // Matched by name, which is what the app calls a translation and
            // what the catalogue promises it will be called once here.
            const have = installed.some((item) => item.name === entry.name);
            const running = busy === entry.name;
            return (
              <div
                key={entry.url}
                className="library-row"
              >
                <div className="library-row__main">
                  <div className="row__title">{entry.name}</div>
                  <div className="row__sub">
                    {[
                      entry.language.toUpperCase(),
                      entry.description,
                      entry.bytes > 0 ? megabytes(entry.bytes) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {running && progress?.name === entry.name && (
                    <div className="field__hint">
                      {megabytes(progress.received)}
                      {progress.total > 0 ? ` / ${megabytes(progress.total)}` : ""}
                    </div>
                  )}
                </div>
                {have ? (
                  <span
                    className="field__hint library-row__action"
                    style={{ display: "flex", alignItems: "center", gap: 5 }}
                  >
                    <Icon name="check" size={12} />
                    {t("bible.downloadHave")}
                  </span>
                ) : (
                  <button
                    className="btn btn--sm btn--primary library-row__action"
                    onClick={() => void download(entry)}
                    // One at a time: two modules arriving at once would fight
                    // for the same part-file, and nobody needs two before a
                    // service anyway.
                    disabled={busy !== null}
                  >
                    <Icon name="arrowDown" size={12} />
                    {running ? t("bible.downloading") : t("common.download")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="field__hint">{t("bible.downloadHint")}</div>
    </Modal>
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
