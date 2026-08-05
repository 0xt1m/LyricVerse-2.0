import { useEffect, useRef, useState } from "react";
import type { Playback } from "../api/types";

/**
 * Video transport.
 *
 * The console decides, every display follows. Position travels as an anchor —
 * "it was here, at this moment" — rather than a ticking number, for the same
 * reason the timer does: a clip must not need a message per frame to stay in
 * step, and a projection window opened halfway through can still work out
 * where it should be.
 */

/**
 * Where the clip should be now, in milliseconds.
 *
 * The anchor only ever counts forwards, so without knowing how long the clip
 * is there is nothing to stop it: a three-second clip read "0:08 / 0:03" while
 * looping, and "1:27 / 0:03" once it had simply been left playing. `durationMs`
 * is what bounds it — a looping clip wraps round with the picture, and one that
 * is not looping stops at its own end, where it has actually stopped.
 *
 * The bound also keeps the projection window honest: a resync that landed
 * while the count was out past the end would ask the video element to seek
 * somewhere it cannot go.
 *
 * Optional because the length is not always known — a clip whose metadata has
 * not loaded, or a YouTube embed that never reports one, falls back to the
 * unbounded count rather than to nothing.
 */
export function playbackPosition(playback: Playback, now: number, durationMs = 0): number {
  const elapsed = playback.playing ? now - playback.anchorMs : 0;
  const position = Math.max(0, playback.positionMs + elapsed);
  if (durationMs <= 0) return position;
  return playback.looping ? position % durationMs : Math.min(position, durationMs);
}

/** How far through, as a percentage — what paints a scrubber's filled part. */
export function percent(value: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

/** A new transport state stamped against the clock, ready to be sent. */
export function stamped(playback: Playback, patch: Partial<Playback>, positionMs?: number): Playback {
  const now = Date.now();
  return {
    ...playback,
    ...patch,
    positionMs: positionMs ?? playbackPosition(playback, now),
    anchorMs: now,
  };
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Commands for a YouTube embed.
 *
 * The iframe API is driven entirely by `postMessage`, so the player can be
 * controlled without pulling in Google's script — which the app's content
 * policy would have to be widened for. What cannot be had this way is the
 * player's own position, so a YouTube clip gets the buttons but no scrub bar.
 */
export function youtubeCommand(frame: HTMLIFrameElement | null, func: string, args: unknown[] = []) {
  frame?.contentWindow?.postMessage(
    JSON.stringify({ event: "command", func, args }),
    "https://www.youtube-nocookie.com",
  );
}

/**
 * A scrub bar that does not fight the player.
 *
 * The position shown is also the position being reported back four times a
 * second, so a plain controlled slider snaps out from under the thumb: drag it
 * forward, the next `timeupdate` arrives with the old value, and the thumb
 * jumps back. While a drag is in progress the reported value is ignored and
 * the drafted one shown instead, and the seek is sent once on release rather
 * than dozens of times on the way there.
 */
export function useScrub(position: number, commit: (ms: number) => void) {
  const [draft, setDraft] = useState<number | null>(null);
  const latest = useRef({ draft, commit });
  latest.current = { draft, commit };

  // The pointer is very often released outside the slider, and the element
  // never hears about it — so the end of the drag is watched on the window.
  useEffect(() => {
    if (draft === null) return;
    const end = () => {
      const value = latest.current.draft;
      setDraft(null);
      if (value !== null) latest.current.commit(value);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [draft !== null]);

  return {
    value: draft ?? position,
    scrubbing: draft !== null,
    onChange: (next: number) => setDraft(next),
    /** Arrow keys never produce a pointerup, so they commit on release. */
    onKeyUp: () => {
      if (draft === null) return;
      setDraft(null);
      commit(draft);
    },
  };
}
