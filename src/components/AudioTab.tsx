import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Track } from "../api/types";
import { useStore } from "../app/store";
import { useFileDrop, within } from "../lib/fileDrop";
import { formatTime } from "../lib/playback";
import { Icon } from "./ui/Icon";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";

/** Just the file name, for messages that would otherwise be a full path. */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The audio library.
 *
 * Music before a service, a bed under a prayer, a sting after a notice. None
 * of it goes to a screen, so unlike every other tab this one does not load a
 * deck — pressing a track plays it here, out of the machine the desk is
 * plugged into.
 */
export function AudioTab() {
  const t = useStore((s) => s.t);
  const libraryRevision = useStore((s) => s.libraryRevision);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);
  const current = useStore((s) => s.audioTrack);
  const playing = useStore((s) => s.audioPlaying);
  const positionMs = useStore((s) => s.audioPositionMs);
  const durationMs = useStore((s) => s.audioDurationMs);
  const playTrack = useStore((s) => s.playTrack);
  const toggleAudio = useStore((s) => s.toggleAudio);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const openMenu = useContextMenu();
  const dialogs = useDialogs();

  const reload = useCallback(() => {
    api.listTracks().then(setTracks).catch(reportError);
  }, [reportError]);

  useEffect(reload, [reload, libraryRevision]);
  useEffect(() => {
    api.supportedAudioExtensions().then(setExtensions).catch(() => {});
  }, []);

  const importFiles = useCallback(
    async (paths: string[]) => {
      setBusy(true);
      const failed: string[] = [];
      for (const path of paths) {
        try {
          await api.importTrack(path);
        } catch {
          failed.push(fileName(path));
        }
      }
      setBusy(false);
      reload();
      if (failed.length > 0) toast(t("audio.importFailed", { files: failed.join(", ") }), "error");
    },
    [reload, t, toast],
  );

  const add = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: t("audio.filter"), extensions }],
    });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    if (paths.length > 0) await importFiles(paths);
  };

  const onDrop = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      if (within(listRef, position)) void importFiles(paths);
    },
    [importFiles],
  );
  const onReject = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      if (!within(listRef, position)) return;
      toast(t("audio.unsupported", { files: paths.map(fileName).join(", ") }), "error");
    },
    [t, toast],
  );

  const dragging = useFileDrop({ extensions, onDrop, onReject, enabled: !busy });
  const over = !!dragging && within(listRef, dragging);

  const remove = async (track: Track) => {
    try {
      await api.deleteTrack(track.id, true);
      if (current?.id === track.id) useStore.getState().stopAudio();
      reload();
    } catch (error) {
      reportError(error);
    }
  };

  const rename = (track: Track) => {
    void dialogs
      .prompt({ title: t("audio.rename"), label: t("common.name"), value: track.name })
      .then((name) => {
        if (!name) return;
        api.renameTrack(track.id, name).then(reload).catch(reportError);
      });
  };

  const setLooping = (track: Track, looping: boolean) => {
    api.setTrackLooping(track.id, looping).then(reload).catch(reportError);
  };

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__head">
          <span className="panel__title">{t("tab.audio")}</span>
          <div className="topbar__spacer" />
          <span className="field__hint">{t("audio.dropHint")}</span>
        </div>

        <div className="panel__body">
          <div
            ref={listRef}
            className="tiles tiles--audio"
            style={{
              outline: over ? "1px dashed var(--accent)" : undefined,
              outlineOffset: -6,
            }}
          >
            {tracks.map((track) => {
              const isCurrent = current?.id === track.id;
              const menu: MenuEntry[] = [
                {
                  label: isCurrent && playing ? t("audio.pause") : t("audio.play"),
                  icon: isCurrent && playing ? "pause" : "play",
                  onSelect: () => (isCurrent ? toggleAudio() : playTrack(track)),
                },
                {
                  label: t("audio.loop"),
                  checked: track.looping,
                  onSelect: () => setLooping(track, !track.looping),
                },
                { label: t("audio.rename"), icon: "pencil", onSelect: () => rename(track) },
                "separator",
                {
                  label: t("common.delete"),
                  icon: "trash",
                  danger: true,
                  onSelect: () => void remove(track),
                },
              ];
              return (
                <div key={track.id} style={{ position: "relative" }}>
                  {/* No header strip: a track has a name and a state, and both
                      read better centred than pinned to a corner. */}
                  <button
                    className="tile tile--audio"
                    data-live={isCurrent || undefined}
                    aria-selected={isCurrent}
                    title={track.name}
                    onClick={() => (isCurrent ? toggleAudio() : playTrack(track))}
                    onContextMenu={(event) => openMenu(event, menu)}
                  >
                    <Icon name={isCurrent && playing ? "pause" : "play"} size={20} />
                    <span className="track__name">{track.name}</span>
                    <span className="field__hint">
                      {track.missing
                        ? t("audio.missing")
                        : isCurrent && durationMs > 0
                          ? `${formatTime(positionMs)} / ${formatTime(durationMs)}`
                          : ""}
                    </span>
                  </button>

                  {/* Loop is worth a press of its own — it is the setting most
                      often changed, and burying it in a menu would not do. */}
                  <button
                    className={track.looping ? "btn btn--icon btn--sm btn--primary" : "btn btn--icon btn--sm"}
                    title={t("audio.loop")}
                    onClick={() => setLooping(track, !track.looping)}
                    style={{ position: "absolute", top: 5, right: 30, padding: 3, minWidth: 0 }}
                  >
                    <Icon name="repeat" size={11} />
                  </button>
                  <button
                    className="btn btn--icon btn--sm btn--danger"
                    title={t("common.delete")}
                    onClick={() => void remove(track)}
                    style={{ position: "absolute", top: 5, right: 5, padding: 3, minWidth: 0 }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              );
            })}

            {/* Always last, as on the Slides tab. */}
            <button
              className="tile tile--add"
              disabled={busy}
              title={t("audio.add")}
              onClick={() => void add()}
            >
              <Icon name="plus" size={16} />
              {t("audio.add")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
