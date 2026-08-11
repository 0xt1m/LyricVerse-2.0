import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Video } from "../api/types";
import { useStore } from "../app/store";
import { videoDeck } from "../lib/deck";
import { useFileDrop, within } from "../lib/fileDrop";
import { formatTime, percent, playbackPosition, useScrub } from "../lib/playback";
import { useNow } from "../lib/timer";
import { Icon } from "./ui/Icon";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";
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
  const live = useStore((s) => s.live);
  const loadDeck = useStore((s) => s.loadDeck);
  const go = useStore((s) => s.go);
  const blank = useStore((s) => s.toggleBlank);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);
  const openMenu = useContextMenu();
  const addToPlan = useStore((s) => s.addToPlan);
  const dialogs = useDialogs();
  const playback = useStore((s) => s.playback);
  const patchPlayback = useStore((s) => s.patchPlayback);

  const [videos, setVideos] = useState<Video[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Clips the operator has asked to *hear* in their own tile, by id.
   *
   * The set is of the exceptions because silence is the default: a preview
   * that spoke up on its own would talk over the service every time a tile
   * scrolled into view.
   *
   * Only about the preview. Once a clip is live its sound is the room's, and
   * the same button reaches for the shared transport instead — every control
   * on a tile drives the screens when the clip is on them, and the tile when
   * it is not.
   */
  const [audible, setAudible] = useState<ReadonlySet<string>>(new Set());

  /**
   * Whether this clip is the one the screens are actually showing.
   *
   * Asked of the live state, not of the loaded deck. The deck is only whatever
   * the operator has open in front of them: cue up the next song while a clip
   * is still running and `deck.source` stops being "video", at which point a
   * deck-based test says the clip is not live — so its tile quietly went back
   * to being a local player, and pausing it moved nothing on the screens or on
   * a web screen. What is on the output is the only thing that can answer this.
   *
   * There is no selection to track any more either: every tile is its own
   * player and carries its own "show", so nothing here depends on which one
   * was clicked last.
   */
  const isLive = (video: Video) =>
    live.kind === "video" &&
    (video.kind === "youtube"
      ? !!video.youtubeId && live.youtubeId === video.youtubeId
      : !!video.path && live.mediaPath === video.path);
  const anyLive = live.kind === "video";

  const isMuted = (video: Video) =>
    isLive(video) ? playback.muted : !audible.has(video.id);

  const toggleMuted = (video: Video) => {
    if (isLive(video)) {
      void patchPlayback({ muted: !playback.muted });
      return;
    }
    setAudible((current) => {
      const next = new Set(current);
      if (!next.delete(video.id)) next.add(video.id);
      return next;
    });
  };

  const reload = useCallback(async () => {
    try {
      setVideos(await api.listVideos());
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
      for (const path of paths) {
        try {
          await api.importVideo(path);
        } catch {
          failed.push(path.split(/[\\/]/).pop() ?? path);
        }
      }
      await reload();
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

  /** Asks for a link, then adds it. Reached from the "+" tile like everything
   *  else — a permanent URL box at the foot of the list was a whole panel row
   *  spent on something used once a month. */
  const addYoutube = async () => {
    const url = await dialogs.prompt({
      title: t("video.youtubeAdd"),
      label: t("video.youtubeUrl"),
      placeholder: "https://youtu.be/…",
      confirmLabel: t("common.add"),
    });
    if (!url?.trim()) return;
    setBusy(true);
    try {
      const added = await api.addYoutubeVideo("", url.trim());
      await reload();
      toast(t("video.added", { name: added.name }), "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = (video: Video) => {
    void dialogs
      .confirm({
        title: t("common.delete"),
        message: t("video.deleteConfirm", { name: video.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      })
      .then((ok) => (ok ? api.deleteVideo(video.id, video.kind === "file").then(reload) : undefined))
      .catch(reportError);
  };

  const setLooping = (video: Video) => {
    api.setVideoLooping(video.id, !video.looping).then(reload).catch(reportError);
  };

  const rename = (video: Video) => {
    void dialogs
      .prompt({ title: t("songbook.rename"), label: t("common.name"), value: video.name })
      .then((name) => (name ? api.renameVideo(video.id, name).then(reload) : undefined))
      .catch(reportError);
  };

  const show = async (video: Video) => {
    if (video.missing) return;
    await loadDeck(videoDeck(video));
    await go(0);
  };

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__head">
          <span className="panel__title">{t("tab.video")}</span>
          <div className="topbar__spacer" />
          <span className="field__hint">{t("video.dropHint")}</span>
          <button className="btn btn--sm" onClick={() => void blank()} disabled={!anyLive}>
            <Icon name="eyeOff" size={12} />
            {t("transport.blankBtn")}
          </button>
        </div>
        <div className="panel__body">
          <div
            ref={listRef}
            className="tiles tiles--video"
            style={{
              outline: over ? "1px dashed var(--accent)" : undefined,
              outlineOffset: -6,
            }}
          >
            {videos.map((video) => {
              const live = isLive(video);
              const playable = video.kind === "file" && !!video.path && !video.missing;
              const menu: MenuEntry[] = [
                {
                  label: t("menu.show"),
                  icon: "eye",
                  disabled: video.missing,
                  onSelect: () => void show(video),
                },
                {
                  label: t("plan.add"),
                  icon: "plus",
                  onSelect: () =>
                    addToPlan({
                      kind: "video",
                      label: video.name,
                      note: "",
                      minutes: 0,
                      depth: 0,
                      collapsed: false,
                      ref: { videoId: video.id },
                    }),
                },
                { label: t("songbook.rename"), icon: "pencil", onSelect: () => rename(video) },
                {
                  // Saved on the clip: whether it loops is a property of the
                  // clip, not of the moment it happens to be played.
                  label: t("media.loop"),
                  checked: video.looping,
                  onSelect: () => setLooping(video),
                },
                "separator",
                {
                  label: t("common.delete"),
                  icon: "trash",
                  danger: true,
                  onSelect: () => remove(video),
                },
              ];
              return (
                <div
                  key={video.id}
                  className="tile tile--video"
                  data-live={live || undefined}
                  title={t("video.showHint")}
                  onDoubleClick={() => void show(video)}
                  onContextMenu={(event) => openMenu(event, menu)}
                >
                  <div className="tile__media">
                    {/* The clip plays where it sits. A YouTube item cannot:
                        embedding it here would mean a second player running
                        against the one on the projection surface, and the
                        network to feed both. */}
                    {playable ? (
                      <TilePlayer src={convertFileSrc(video.path!)} live={live} muted={isMuted(video)} />
                    ) : (
                      <div className="empty" style={{ padding: 14 }}>
                        <div className="empty__title">
                          {video.missing ? t("video.missing") : t("video.youtube")}
                        </div>
                        <div>
                          {video.missing ? t("video.missingHint") : t("video.youtubePreview")}
                        </div>
                      </div>
                    )}

                    {/* Delete stays over the picture — it is not something to
                        put within a slip of the buttons you actually use. */}
                    <button
                      className="btn btn--icon btn--sm btn--danger"
                      title={t("common.delete")}
                      onClick={() => remove(video)}
                      style={{ position: "absolute", top: 6, right: 6, padding: 3, minWidth: 0 }}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </div>

                  <div className="tile__foot">
                    <span className="track__name" title={video.name}>
                      {video.name}
                    </span>
                    <button
                      className={
                        isMuted(video)
                          ? "btn btn--sm btn--icon btn--primary"
                          : "btn btn--sm btn--icon"
                      }
                      title={t("media.mute")}
                      onClick={() => toggleMuted(video)}
                    >
                      <Icon name={isMuted(video) ? "volumeOff" : "volume"} size={12} />
                    </button>
                    {/* Beside "show", because the two are decided together: you
                        set a clip to loop at the moment you send it out. */}
                    <button
                      className={
                        video.looping
                          ? "btn btn--sm btn--icon btn--primary"
                          : "btn btn--sm btn--icon"
                      }
                      title={t("media.loop")}
                      onClick={() => setLooping(video)}
                    >
                      <Icon name="repeat" size={12} />
                    </button>
                    {/* Lit while this clip is the one on screen, like the loop
                        and mute buttons beside it — and pressing it again is
                        how you take it off, rather than hunting for Blank. */}
                    <button
                      className={live ? "btn btn--sm btn--icon btn--primary" : "btn btn--sm btn--icon"}
                      title={live ? t("media.stop") : t("menu.show")}
                      disabled={video.missing}
                      onClick={() => (live ? void blank() : void show(video))}
                    >
                      <Icon name={live ? "eyeOff" : "eye"} size={12} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Always last, as on the audio tab. Both sources live behind it, so
                there is one place to add a clip rather than a button up in the
                header and a URL box down in the foot. */}
            <button
              className="tile tile--add"
              disabled={busy}
              title={t("video.add")}
              onClick={(event) =>
                openMenu(event, [
                  { label: t("video.import"), icon: "folder", onSelect: () => void importFile() },
                  {
                    label: t("video.youtubeAdd"),
                    icon: "monitor",
                    onSelect: () => void addYoutube(),
                  },
                ])
              }
            >
              <Icon name="plus" size={16} />
              {t("video.add")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * A clip playing inside its own tile.
 *
 * The element's native controls are off. WKWebView draws the macOS player
 * chrome for them — a full transport with volume, AirPlay and
 * picture-in-picture — which is far too much furniture for a tile this size and
 * a different visual language from everything around it. What is left is what a
 * confidence check actually needs: press it, watch it, scrub it. The bar is the
 * same scrubber the top transport uses, so the two read as one app.
 */
function TilePlayer({
  src,
  live,
  muted,
}: {
  src: string;
  live: boolean;
  muted: boolean;
}) {
  const t = useStore((s) => s.t);
  const playback = useStore((s) => s.playback);
  const patchPlayback = useStore((s) => s.patchPlayback);
  const ref = useRef<HTMLVideoElement>(null);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localPosition, setLocalPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  // While this clip is the one on the screens, the tile is a window onto the
  // shared transport rather than a second player. Pausing in the top bar has to
  // stop the picture here too — otherwise the operator sits watching something
  // the room is not.
  const now = useNow(live && playback.playing);
  const playing = live ? playback.playing : localPlaying;
  const position = live ? playbackPosition(playback, now, duration) : localPosition;

  useEffect(() => {
    const node = ref.current;
    if (!node || !live) return;
    const wanted = playbackPosition(playback, Date.now(), duration) / 1000;
    // The same third of a second the projection surface allows: below what
    // anyone can see, above the jitter of decoding and of two clocks.
    if (Math.abs(node.currentTime - wanted) > 0.34) node.currentTime = wanted;
    node.loop = playback.looping;
    if (playback.playing) void node.play().catch(() => {});
    else node.pause();
  }, [
    live,
    duration,
    playback.revision,
    playback.playing,
    playback.looping,
    playback.positionMs,
    playback.anchorMs,
  ]);

  const toggle = () => {
    // Live, this drives every screen; idle, only the tile. Same button either
    // way, because it is the same question — is this clip running?
    if (live) {
      void patchPlayback({ playing: !playback.playing });
      return;
    }
    const node = ref.current;
    if (!node) return;
    // Asked of the element rather than of our own `playing`, which is a report
    // of what the element did and can lag a frame behind it.
    if (node.paused) void node.play().catch(() => {});
    else node.pause();
  };

  // A double-click on the tile sends the clip to the screens, so a click on the
  // picture cannot act the instant it lands — the clip would start playing here
  // on its way to going live, which is exactly the thing being asked for
  // instead. Held for a moment, and dropped if the second click arrives.
  const pendingClick = useRef<number | undefined>(undefined);
  const cancelPendingClick = () => window.clearTimeout(pendingClick.current);
  const onPictureClick = () => {
    cancelPendingClick();
    pendingClick.current = window.setTimeout(toggle, 220);
  };
  useEffect(() => cancelPendingClick, []);

  const seek = (ms: number) => {
    if (live) {
      void patchPlayback({}, ms);
      return;
    }
    const node = ref.current;
    if (node) node.currentTime = ms / 1000;
    // Set here too: `timeupdate` fires about four times a second, and waiting
    // for it would leave the thumb lagging behind the drag.
    setLocalPosition(ms);
  };

  /**
   * The bar, drafted while dragging and committed on release.
   *
   * The position shown here is also the position being reported back — four
   * times a second by the element, or on every tick of the transport clock
   * while live. Fed straight into a controlled slider, each of those arrives
   * with the pre-drag value and yanks the thumb back out from under the
   * pointer; live, it also stamped a fresh anchor and fired an IPC call per
   * pointer move.
   */
  const scrub = useScrub(position, (ms) => seek(ms));

  return (
    <>
      <video
        ref={ref}
        src={src}
        preload="metadata"
        // Live, always silent here: the projection window is playing this same
        // clip out of this same machine, and two at once is an echo. The tile's
        // own mute button then speaks for the room instead.
        muted={live || muted}
        style={{ cursor: "pointer" }}
        onClick={onPictureClick}
        // Not stopped: the tile above is what actually shows the clip.
        onDoubleClick={cancelPendingClick}
        onPlay={() => setLocalPlaying(true)}
        onPause={() => setLocalPlaying(false)}
        onEnded={() => setLocalPlaying(false)}
        onTimeUpdate={(event) => setLocalPosition(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(event) => {
          const length = event.currentTarget.duration;
          setDuration(Number.isFinite(length) ? length * 1000 : 0);
        }}
      />
      <div className="tileplayer">
        <button
          className="tileplayer__btn"
          title={playing ? t("media.pause") : t("media.play")}
          onClick={toggle}
        >
          <Icon name={playing ? "pause" : "play"} size={11} />
        </button>
        <input
          className="scrub tileplayer__scrub"
          type="range"
          min={0}
          max={Math.max(1, Math.round(duration))}
          value={Math.min(Math.round(scrub.value), Math.round(duration))}
          disabled={duration <= 0}
          style={{ "--played": `${percent(scrub.value, duration)}%` } as CSSProperties}
          onChange={(event) => scrub.onChange(Number(event.target.value))}
          onKeyUp={scrub.onKeyUp}
        />
        <span className="tileplayer__time">{formatTime(scrub.value)}</span>
      </div>
    </>
  );
}
