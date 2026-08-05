import { convertFileSrc } from "@tauri-apps/api/core";
import type { Background, LiveState, Playback, Settings, Timer } from "./types";

/**
 * The projection page runs in two very different places: a Tauri window on
 * this machine, and an ordinary browser tab on someone's tablet. Everything
 * above this module is written once and works in both; this is the seam.
 */
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * A URL an `<img>` or `<video>` can load for a file on this machine.
 *
 * In a Tauri window that is the asset protocol. In a browser it is the little
 * media route the web-screen server exposes, which serves nothing outside the
 * app's own data directory.
 */
export function mediaSrc(path: string): string {
  return IS_TAURI ? convertFileSrc(path) : `/api/media?path=${encodeURIComponent(path)}`;
}

export interface WebFrameState {
  settings: Settings;
  live: LiveState;
  timer: Timer | null;
  playback: Playback | null;
  backgrounds: Background[];
  /** The host's clock when this frame was built, in epoch milliseconds. */
  now: number;
}

export interface WebFrame {
  revision: number;
  /** Which screen this server is, so the page can find its own preset. */
  screenId: string;
  state: WebFrameState | null;
}

/**
 * Asks for the next state and waits for it.
 *
 * The server holds the request open until something actually changes, so a
 * screen sitting on the same slide for an hour makes about two requests, and a
 * slide change arrives as fast as the network can carry it. No polling
 * interval to trade latency against traffic.
 */
export async function pollFrame(since: number, signal?: AbortSignal): Promise<WebFrame> {
  const response = await fetch(`/api/state?since=${since}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`state request failed: ${response.status}`);
  return (await response.json()) as WebFrame;
}
