import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Video } from "../api/types";
import { useStore } from "../app/store";
import { videoDeck } from "../lib/deck";
import { useFileDrop, within } from "../lib/fileDrop";
import { Icon } from "./ui/Icon";
import { Empty, Field } from "./ui/controls";
import { useContextMenu } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";

/** Kept beside the picker filter so the two cannot drift apart. */
const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv"];

/**
 * Clips, from two sources.
 *
 * An imported file plays entirely offline and under the app's control. A
 * YouTube item embeds the official player, which is the only part of
 * LyricVerse that needs the network — worth knowing before a service, so the
 * UI marks those items rather than letting them fail silently.
 */
export function VideoTab() {
  const t = useStore((s) => s.t);
  const libraryRevision = useStore((s) => s.libraryRevision);
  const deck = useStore((s) => s.deck);
  const liveIndex = useStore((s) => s.liveIndex);
  const loadDeck = useStore((s) => s.loadDeck);
  const go = useStore((s) => s.go);
  const blank = useStore((s) => s.toggleBlank);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);
  const openMenu = useContextMenu();
  const dialogs = useDialogs();

  const [videos, setVideos] = useState<Video[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const active = videos.find((video) => video.id === selected) ?? null;
  const isLive = deck?.source === "video" && liveIndex !== null && deck.slides[0]?.id === selected;

  const reload = useCallback(async () => {
    try {
      const list = await api.listVideos();
      setVideos(list);
      setSelected((current) =>
        current && list.some((video) => video.id === current) ? current : (list[0]?.id ?? null),
      );
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  useEffect(() => {
    void reload();
  }, [reload, libraryRevision]);

  const importFiles = useCallback(
    async (paths: string[]) => {
      setBusy(true);
      const failed: string[] = [];
      let last: string | null = null;
      for (const path of paths) {
        try {
          last = (await api.importVideo(path)).id;
        } catch {
          failed.push(path.split(/[\\/]/).pop() ?? path);
        }
      }
      await reload();
      if (last) setSelected(last);
      setBusy(false);
      if (failed.length > 0) toast(t("video.importFailed", { files: failed.join(", ") }), "error");
    },
    [reload, t, toast],
  );

  // The clip list is the drop target, and only it — a file let go over the
  // rail or the preview was not aimed at this tab.
  const onDrop = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      if (within(listRef, position)) void importFiles(paths);
    },
    [importFiles],
  );
  const onReject = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      if (!within(listRef, position)) return;
      toast(
        t("video.unsupported", { files: paths.map((p) => p.split(/[\\/]/).pop() ?? p).join(", ") }),
        "error",
      );
    },
    [t, toast],
  );

  const dragging = useFileDrop({
    extensions: VIDEO_EXTENSIONS,
    onDrop,
    onReject,
    enabled: !busy,
  });
  const over = !!dragging && within(listRef, dragging);

  const importFile = async () => {
    const picked = await open({
      multiple: true,
      filters: [
        { name: t("video.filter"), extensions: VIDEO_EXTENSIONS },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    if (paths.length === 0) return;
    setBusy(true);
    try {
      await importFiles(paths);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const addYoutube = async () => {
    if (!youtubeUrl.trim()) return;
    setBusy(true);
    try {
      const added = await api.addYoutubeVideo("", youtubeUrl.trim());
      setYoutubeUrl("");
      await reload();
      setSelected(added.id);
      toast(t("video.added", { name: added.name }), "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const show = async (video: Video) => {
    if (video.missing) return;
    await loadDeck(videoDeck(video));
    await go(0);
  };

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: "0 0 280px" }}>
        <div className="panel__head">
          <span className="panel__title">{t("tab.video")}</span>
          <div className="topbar__spacer" />
          <button className="btn btn--sm" onClick={() => void importFile()} disabled={busy}>
            <Icon name="plus" size={12} />
            {t("video.import")}
          </button>
        </div>
        <div
          className="panel__body"
          ref={listRef}
          style={{ outline: over ? "1px dashed var(--accent)" : undefined, outlineOffset: -6 }}
        >
          {videos.length === 0 ? (
            <Empty title={t("video.none")} hint={t("video.noneHint")} />
          ) : (
            <div className="list">
              {videos.map((video) => (
                <button
                  key={video.id}
                  className="row"
                  aria-selected={video.id === selected}
                  onClick={() => setSelected(video.id)}
                  onDoubleClick={() => void show(video)}
                  onContextMenu={(event) => {
                    setSelected(video.id);
                    openMenu(event, [
                      {
                        label: t("menu.show"),
                        icon: "eye",
                        disabled: video.missing,
                        onSelect: () => void show(video),
                      },
                      {
                        label: t("songbook.rename"),
                        icon: "pencil",
                        onSelect: () => {
                          void dialogs
                            .prompt({
                              title: t("songbook.rename"),
                              label: t("common.name"),
                              value: video.name,
                            })
                            .then((name) => {
                              if (name) {
                                return api.renameVideo(video.id, name).then(reload);
                              }
                            })
                            .catch(reportError);
                        },
                      },
                      {
                        // Saved on the clip: whether it loops is a property of
                        // the clip, not of the moment it happens to be played.
                        label: t("media.loop"),
                        checked: video.looping,
                        onSelect: () => {
                          api
                            .setVideoLooping(video.id, !video.looping)
                            .then(reload)
                            .catch(reportError);
                        },
                      },
                      "separator",
                      {
                        label: t("common.delete"),
                        icon: "trash",
                        danger: true,
                        onSelect: () => {
                          void dialogs
                            .confirm({
                              title: t("common.delete"),
                              message: t("video.deleteConfirm", { name: video.name }),
                              confirmLabel: t("common.delete"),
                              danger: true,
                            })
                            .then((ok) =>
                              ok ? api.deleteVideo(video.id, video.kind === "file").then(reload) : undefined,
                            )
                            .catch(reportError);
                        },
                      },
                    ]);
                  }}
                >
                  <span className="row__num" style={{ minWidth: "1.6em" }}>
                    <Icon name={video.kind === "youtube" ? "monitor" : "music"} size={13} />
                  </span>
                  <span className="row__main">
                    <span className="row__title">{video.name}</span>
                    <span className="row__sub">
                      {video.missing
                        ? t("video.missing")
                        : video.kind === "youtube"
                          ? t("video.youtube")
                          : t("video.file")}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="panel__foot" style={{ display: "grid", gap: 6 }}>
          <Field label={t("video.youtubeAdd")} hint={t("video.youtubeHint")}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                value={youtubeUrl}
                placeholder="https://youtu.be/…"
                spellCheck={false}
                onChange={(event) => setYoutubeUrl(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void addYoutube()}
              />
              <button
                className="btn btn--icon"
                onClick={() => void addYoutube()}
                disabled={busy || !youtubeUrl.trim()}
              >
                <Icon name="plus" />
              </button>
            </div>
          </Field>
        </div>
      </section>

      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__head">
          <span className="panel__title">{active?.name ?? ""}</span>
          <div className="topbar__spacer" />
          <button
            className="btn btn--sm btn--primary"
            onClick={() => active && void show(active)}
            disabled={!active || active.missing}
          >
            <Icon name="eye" size={12} />
            {t("menu.show")}
          </button>
          <button className="btn btn--sm" onClick={() => void blank()} disabled={!isLive}>
            <Icon name="eyeOff" size={12} />
            {t("transport.blankBtn")}
          </button>
        </div>
        <div className="panel__body">
          {!active ? (
            <Empty title={t("video.none")} hint={t("video.noneHint")} />
          ) : (
            <div style={{ padding: 14, display: "grid", gap: 12, alignContent: "start" }}>
              {/* A local file previews here; the YouTube player is only ever
                  embedded on the projection surface, never twice at once. */}
              {active.kind === "file" && active.path && !active.missing ? (
                <video
                  key={active.path}
                  src={convertFileSrc(active.path)}
                  controls
                  style={{
                    width: "100%",
                    borderRadius: 8,
                    background: "#000",
                    border: "1px solid var(--border-strong)",
                  }}
                />
              ) : (
                <div
                  className="preview__frame"
                  style={{ aspectRatio: "16 / 9", display: "grid", placeItems: "center" }}
                >
                  <div className="empty" style={{ padding: 20 }}>
                    <div className="empty__title">
                      {active.missing ? t("video.missing") : t("video.youtube")}
                    </div>
                    <div>{active.missing ? t("video.missingHint") : t("video.youtubePreview")}</div>
                  </div>
                </div>
              )}
              <div className="field__hint">{t("video.playbackHint")}</div>
            </div>
          )}
        </div>
      </section>

    </div>
  );
}
