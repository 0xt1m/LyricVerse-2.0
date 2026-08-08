import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useStore } from "../app/store";
import { Icon } from "./ui/Icon";
import { Modal } from "./ui/controls";
import { useContextMenu } from "./ui/ContextMenu";
import { TranslationStore } from "./TranslationStore";

/**
 * The Bible translations this machine has, added and taken away.
 *
 * The Bible tab can already add one and remove the one in use; this is the
 * view for setting a machine up, where the operator is looking at the whole
 * library at once rather than at the translation they happen to be reading.
 *
 * There is no rename here, unlike songbooks: a module's name is the one the
 * people who published it gave it, and two translations that differ only by a
 * name somebody typed are worse than none.
 */
export function TranslationManager({ onClose }: { onClose: () => void }) {
  const t = useStore((s) => s.t);
  const translations = useStore((s) => s.translations);
  const settings = useStore((s) => s.settings);
  const refreshLibrary = useStore((s) => s.refreshLibrary);
  const patchSettings = useStore((s) => s.patchSettings);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);

  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const openMenu = useContextMenu();

  const importFile = async () => {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "MyBible module", extensions: ["SQLite3", "sqlite3", "sqlite", "db"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const meta = await api.importTranslation(picked);
      await refreshLibrary();
      await patchSettings({ activeTranslation: meta.name });
      toast(t("bible.imported", { name: meta.name }), "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      // The file goes with it. Leaving it behind only looked like
      // caution: the folder is re-scanned at startup, so an unregistered
      // module came back by itself on the next launch.
      await api.deleteTranslation(removing, true);
      // Nothing else prunes the parallel list, and a name left in it would
      // come back the moment a module of the same name was imported again.
      if (settings.secondaryTranslations.includes(removing)) {
        await patchSettings({
          secondaryTranslations: settings.secondaryTranslations.filter((item) => item !== removing),
        });
      }
      setRemoving(null);
      await refreshLibrary();
      toast(t("bible.removed", { name: removing }), "success");
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <Modal
      title={t("bible.manage")}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className="group">
        <div className="group__head">{t("bible.add")}</div>
        <div className="group__body">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn--primary" onClick={() => setDownloading(true)}>
              <Icon name="arrowDown" size={13} />
              {t("bible.download")}
            </button>
            <button className="btn" onClick={() => void importFile()} disabled={busy}>
              <Icon name="folder" size={13} />
              {t("bible.import")}
            </button>
          </div>
          <div className="field__hint">{t("bible.addHint")}</div>
        </div>
      </div>

      <div className="group">
        <div className="group__head">{t("bible.translation")}</div>
        <div className="group__body" style={{ gap: 6 }}>
          {translations.length === 0 && (
            <div className="field__hint">{t("bible.noTranslations")}</div>
          )}
          {translations.map((item) => (
            <div
              key={item.name}
              onContextMenu={(event) =>
                openMenu(event, [
                  {
                    label: t("bible.remove"),
                    icon: "trash",
                    danger: true,
                    onSelect: () => setRemoving(item.name),
                  },
                ])
              }
              className="library-row"
            >
              <div className="library-row__main">
                <div className="row__title">{item.name}</div>
                {/* A broken module says so here rather than only when somebody
                    tries to read from it in front of a congregation. */}
                <div className="row__sub">{item.error ?? item.filename}</div>
              </div>
              <button
                className="btn btn--icon btn--sm btn--danger"
                onClick={() => setRemoving(item.name)}
                title={t("bible.remove")}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {downloading && <TranslationStore onClose={() => setDownloading(false)} />}

      {removing && (
        <Modal
          title={`${t("common.delete")}: ${removing}`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn--danger" onClick={() => void confirmRemove()}>
                {t("common.confirm")}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--text-muted)" }}>{t("bible.removeHint")}</p>
        </Modal>
      )}
    </Modal>
  );
}
