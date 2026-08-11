import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Track } from "../api/types";
import { useStore, type AudioPlayer } from "../app/store";
import { useFileDrop, within } from "../lib/fileDrop";
import { formatTime, percent, useScrub } from "../lib/playback";
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
  const players = useStore((s) => s.audioPlayers);
  const playTrack = useStore((s) => s.playTrack);
  const toggleTrack = useStore((s) => s.toggleTrack);

  /** The player for a track, when it is one of the ones sounding. */
  const playerFor = (id: string) => players.find((item) => item.track.id === id) ?? null;

  const [tracks, setTracks] = useState<Track[]>([]);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const openMenu = useContextMenu();
  const addToPlan = useStore((s) => s.addToPlan);
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
      useStore.getState().stopTrack(track.id);
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
              const player = playerFor(track.id);
              const sounding = !!player?.playing;
              const menu: MenuEntry[] = [
                {
                  label: sounding ? t("audio.pause") : t("audio.play"),
                  icon: sounding ? "pause" : "play",
                  onSelect: () => (player ? toggleTrack(track.id) : playTrack(track)),
                },
                {
                  label: t("audio.loop"),
                  checked: track.looping,
                  onSelect: () => setLooping(track, !track.looping),
                },
                {
                  label: t("plan.add"),
                  icon: "plus",
                  onSelect: () =>
                    addToPlan({
                      kind: "audio",
                      label: track.name,
                      note: "",
                      minutes: 0,
                      depth: 0,
                      collapsed: false,
                      ref: { trackId: track.id },
                    }),
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
                    data-live={!!player || undefined}
                    aria-selected={!!player}
                    title={track.name}
                    onClick={() => (player ? toggleTrack(track.id) : playTrack(track))}
                    onContextMenu={(event) => openMenu(event, menu)}
                  >
                    <Icon name={sounding ? "pause" : "play"} size={20} />
                    <span className="track__name">{track.name}</span>
                    <span className="field__hint">
                      {track.missing
                        ? t("audio.missing")
                        : player && player.durationMs > 0
                          ? `${formatTime(player.positionMs)} / ${formatTime(player.durationMs)}`
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

        <Mixer />
      </section>
    </div>
  );
}

/**
 * A fader per sounding track, across the foot of the tab.
 *
 * With several tracks at once the question stops being "what is playing" and
 * becomes "how do they sit against each other" — a bed of music has to duck
 * under a voice, and reaching for one master fader would take the voice down
 * with it. Absent entirely when nothing is playing, so the tab gives the room
 * back rather than showing an empty desk.
 */
function Mixer() {
  const t = useStore((s) => s.t);
  const players = useStore((s) => s.audioPlayers);
  const stopAllAudio = useStore((s) => s.stopAllAudio);

  if (players.length === 0) return null;

  return (
    <div className="mixer">
      <div className="mixer__head">
        <span className="panel__title">{t("audio.mixer")}</span>
        <span className="field__hint">{t("audio.playingCount", { n: players.length })}</span>
        <div className="topbar__spacer" />
        <button className="btn btn--sm" onClick={stopAllAudio}>
          <Icon name="x" size={12} />
          {t("audio.stopAll")}
        </button>
      </div>

      <div className="mixer__strips">
        {players.map((player) => (
          <MixerStrip key={player.track.id} player={player} />
        ))}
      </div>
    </div>
  );
}

/**
 * One track's strip.
 *
 * A component of its own so each has its own drafted scrub position — the
 * alternative is a hook inside a loop, which React will not have.
 */
function MixerStrip({ player }: { player: AudioPlayer }) {
  const t = useStore((s) => s.t);
  const toggleTrack = useStore((s) => s.toggleTrack);
  const stopTrack = useStore((s) => s.stopTrack);
  const setTrackVolume = useStore((s) => s.setTrackVolume);
  const seekTrack = useStore((s) => s.seekTrack);
  // The element reports its position about four times a second, and every one
  // of those would drag the thumb back to where the track actually is. The
  // draft is shown while the hand is down and the seek sent once, on release.
  const scrub = useScrub(player.positionMs, (ms) => seekTrack(player.track.id, ms));
  const level = Math.round(player.volume * 100);

  return (
    <div className="mixer__strip">
      <button
        className="btn btn--icon btn--sm"
        title={player.playing ? t("audio.pause") : t("audio.play")}
        onClick={() => toggleTrack(player.track.id)}
      >
        <Icon name={player.playing ? "pause" : "play"} size={12} />
      </button>

      <span className="mixer__name" title={player.track.name}>
        {player.track.name}
      </span>

      <input
        className="scrub mixer__scrub"
        type="range"
        min={0}
        max={Math.max(1, Math.round(player.durationMs))}
        value={Math.min(Math.round(scrub.value), Math.round(player.durationMs))}
        disabled={player.durationMs <= 0}
        style={{ "--played": `${percent(scrub.value, player.durationMs)}%` } as CSSProperties}
        onChange={(event) => scrub.onChange(Number(event.target.value))}
        onKeyUp={scrub.onKeyUp}
      />
      <span className="mixer__time">
        {formatTime(scrub.value)} / {formatTime(player.durationMs)}
      </span>

      {/* The fader needs no draft: nothing else writes the level, so the value
          shown is only ever the one the hand just set. */}
      <span className="mixer__fader">
        <Icon name={player.volume === 0 ? "volumeOff" : "volume"} size={12} />
        <input
          className="scrub mixer__volume"
          type="range"
          min={0}
          max={100}
          value={level}
          title={t("audio.volume")}
          style={{ "--played": `${level}%` } as CSSProperties}
          onChange={(event) => setTrackVolume(player.track.id, Number(event.target.value) / 100)}
        />
        <span className="mixer__level">{level}</span>
      </span>

      <button
        className="btn btn--icon btn--sm"
        title={t("audio.stop")}
        onClick={() => stopTrack(player.track.id)}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
