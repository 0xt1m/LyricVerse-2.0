import { useEffect, useRef } from "react";
import { useStore, type AudioPlayer } from "../app/store";
import { mediaSrc } from "../api/net";

/**
 * Every track sounding, one element each.
 *
 * Mounted in the window chrome rather than on the Audio tab, so a track keeps
 * playing while the operator works somewhere else — which is the entire point
 * of background music. Everything about it is driven from the store, so the
 * tab, the mixer and the transport in the title bar are views of one player
 * rather than several that have to be kept in step.
 *
 * One element per track rather than one shared element: a bed of music under a
 * prayer with a sting fired over it needs two things making sound at once, and
 * each wants its own position and its own level.
 */
export function AudioEngine() {
  const players = useStore((s) => s.audioPlayers);
  return (
    <>
      {players.map((player) => (
        <Voice key={player.track.id} player={player} />
      ))}
    </>
  );
}

function Voice({ player }: { player: AudioPlayer }) {
  const ref = useRef<HTMLAudioElement>(null);
  const { track, playing, positionMs, seekToken, volume } = player;
  const deviceId = useStore((s) => s.settings.audioDeviceId);
  const master = useStore((s) => s.settings.audioVolume);
  const reportAudio = useStore((s) => s.reportAudio);
  const stopTrack = useStore((s) => s.stopTrack);
  const toast = useStore((s) => s.toast);
  const t = useStore((s) => s.t);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (playing) {
      // Autoplay can be refused; say so rather than leaving a dead button.
      void node.play().catch(() => toast(t("audio.blocked"), "error"));
    } else {
      node.pause();
    }
  }, [playing, track.id, t, toast]);

  // A scrub, as opposed to the position the element itself just reported.
  useEffect(() => {
    const node = ref.current;
    if (!node || seekToken === 0) return;
    node.currentTime = positionMs / 1000;
  }, [seekToken]);

  // The track's own level under the master. The fader on the mixer rides one
  // track; the one in Settings rides the lot.
  useEffect(() => {
    const node = ref.current;
    if (node) node.volume = Math.min(1, Math.max(0, volume * master));
  }, [volume, master, track.id]);

  useEffect(() => {
    applySink(ref.current, deviceId);
  }, [deviceId, track.id]);

  const report = (node: HTMLAudioElement) =>
    reportAudio(
      track.id,
      node.currentTime * 1000,
      Number.isFinite(node.duration) ? node.duration * 1000 : 0,
    );

  return (
    <audio
      ref={ref}
      src={mediaSrc(track.path)}
      loop={track.looping}
      onTimeUpdate={(event) => report(event.currentTarget)}
      onLoadedMetadata={(event) => report(event.currentTarget)}
      // A track that is not looping is finished with, so it takes itself off
      // the mixer rather than sitting at the end pretending to be loaded.
      onEnded={() => stopTrack(track.id)}
      onError={() => {
        toast(t("audio.failed", { name: track.name }), "error");
        stopTrack(track.id);
      }}
    />
  );
}

/**
 * Routes an element to a chosen sound device.
 *
 * `setSinkId` is not implemented everywhere — notably it has been absent from
 * WebKit for most of its life — so this is written as best-effort and the
 * Settings tab tells the operator plainly when the platform cannot do it,
 * rather than offering a control that quietly does nothing.
 */
export function applySink(node: HTMLMediaElement | null, deviceId: string) {
  if (!node || !canRouteAudio()) return;
  const sinkable = node as HTMLMediaElement & { setSinkId(id: string): Promise<void> };
  void sinkable.setSinkId(deviceId).catch(() => {});
}

export function canRouteAudio(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}
