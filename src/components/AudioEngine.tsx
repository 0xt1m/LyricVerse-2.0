import { useEffect, useRef } from "react";
import { useStore } from "../app/store";
import { mediaSrc } from "../api/net";

/**
 * The one audio element in the app.
 *
 * Mounted in the window chrome rather than on the Audio tab, so a track keeps
 * playing while the operator works somewhere else — which is the entire point
 * of background music. Everything about it is driven from the store, so the
 * tab and the transport in the title bar are two views of one player rather
 * than two players that have to be kept in step.
 */
export function AudioEngine() {
  const ref = useRef<HTMLAudioElement>(null);
  const track = useStore((s) => s.audioTrack);
  const playing = useStore((s) => s.audioPlaying);
  const positionMs = useStore((s) => s.audioPositionMs);
  const seekToken = useStore((s) => s.audioSeekToken);
  const deviceId = useStore((s) => s.settings.audioDeviceId);
  const volume = useStore((s) => s.settings.audioVolume);
  const reportAudio = useStore((s) => s.reportAudio);
  const stopAudio = useStore((s) => s.stopAudio);
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
  }, [playing, track?.id, t, toast]);

  // A scrub, as opposed to the position the element itself just reported.
  useEffect(() => {
    const node = ref.current;
    if (!node || seekToken === 0) return;
    node.currentTime = positionMs / 1000;
  }, [seekToken]);

  useEffect(() => {
    const node = ref.current;
    if (node) node.volume = Math.min(1, Math.max(0, volume));
  }, [volume, track?.id]);

  useEffect(() => {
    applySink(ref.current, deviceId);
  }, [deviceId, track?.id]);

  if (!track) return null;

  return (
    <audio
      ref={ref}
      src={mediaSrc(track.path)}
      loop={track.looping}
      onTimeUpdate={(event) =>
        reportAudio(
          event.currentTarget.currentTime * 1000,
          Number.isFinite(event.currentTarget.duration)
            ? event.currentTarget.duration * 1000
            : 0,
        )
      }
      onLoadedMetadata={(event) =>
        reportAudio(
          event.currentTarget.currentTime * 1000,
          Number.isFinite(event.currentTarget.duration)
            ? event.currentTarget.duration * 1000
            : 0,
        )
      }
      // A track that is not looping is finished with, so it clears itself
      // rather than sitting at the end pretending to be loaded.
      onEnded={() => stopAudio()}
      onError={() => {
        toast(t("audio.failed", { name: track.name }), "error");
        stopAudio();
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
