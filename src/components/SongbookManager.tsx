import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useStore } from "../app/store";
import { Icon } from "./ui/Icon";
import { Field, Modal, Switch } from "./ui/controls";
import { useContextMenu } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";

export function SongbookManager({ onClose }: { onClose: () => void }) {
  const t = useStore((s) => s.t);
  const songbooks = useStore((s) => s.songbooks);
  const refreshLibrary = useStore((s) => s.refreshLibrary);
  const patchSettings = useStore((s) => s.patchSettings);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const openMenu = useContextMenu();
  const dialogs = useDialogs();
  const [deleteFile, setDeleteFile] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const meta = await api.createSongbook(name.trim());
      setName("");
      await refreshLibrary();
      await patchSettings({ activeSongbook: meta.name });
      toast(t("songbook.created", { name: meta.name }), "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async () => {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Songbook", extensions: ["db", "sps", "sqlite", "sqlite3"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const meta = await api.importSongbook(picked, name.trim() || undefined);
      setName("");
      await refreshLibrary();
      await patchSettings({ activeSongbook: meta.name });
      toast(t("songbook.imported", { name: meta.name, n: meta.songCount }), "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (from: string) => {
    const to = await dialogs.prompt({
      title: t("songbook.rename"),
      label: t("common.name"),
      value: from,
    });
    if (!to || to === from) return;
    try {
      await api.renameSongbook(from, to);
      await refreshLibrary();
      await patchSettings({ activeSongbook: to });
    } catch (error) {
      reportError(error);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await api.deleteSongbook(removing, deleteFile);
      setRemoving(null);
      setDeleteFile(false);
      await refreshLibrary();
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <Modal
      title={t("songbook.manage")}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className="group">
        <div className="group__head">{t("songbook.new")}</div>
        <div className="group__body">
          <Field label={t("common.name")}>
            <input
              className="input"
              value={name}
              placeholder={t("songbook.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void create()}
            />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              <Icon name="plus" size={13} />
              {t("common.create")}
            </button>
            <button className="btn" onClick={() => void importFile()} disabled={busy}>
              <Icon name="folder" size={13} />
              {t("songbook.import")}
            </button>
          </div>
          <div className="field__hint">
            .db (LyricVerse) · .sps (SongPro)
          </div>
        </div>
      </div>

      <div className="group">
        <div className="group__head">{t("songbook.label")}</div>
        <div className="group__body" style={{ gap: 6 }}>
          {songbooks.length === 0 && <div className="field__hint">{t("songbook.none")}</div>}
          {songbooks.map((book) => (
            <div
              key={book.name}
              onContextMenu={(event) =>
                openMenu(event, [
                  {
                    label: t("songbook.rename"),
                    icon: "pencil",
                    onSelect: () => void rename(book.name),
                  },
                  "separator",
                  {
                    label: t("songbook.remove"),
                    icon: "trash",
                    danger: true,
                    onSelect: () => setRemoving(book.name),
                  },
                ])
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--panel-sunken)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row__title">{book.name}</div>
                <div className="row__sub">
                  {book.error ?? `${book.filename} · ${t("songs.count", { n: book.songCount })}`}
                </div>
              </div>
              <button className="btn btn--icon btn--sm" onClick={() => void rename(book.name)}>
                <Icon name="pencil" size={12} />
              </button>
              <button
                className="btn btn--icon btn--sm btn--danger"
                onClick={() => setRemoving(book.name)}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

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
          <p style={{ margin: 0, color: "var(--text-muted)" }}>{t("songbook.remove")}</p>
          {/* Unregistering and erasing are separate, deliberate acts: a
              mis-click must not destroy a congregation's songs. */}
          <Switch checked={deleteFile} onChange={setDeleteFile} label={t("songbook.removeFile")} />
        </Modal>
      )}
    </Modal>
  );
}
