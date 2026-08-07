import { useEffect, useState } from "react";
import { EVENT, api, on } from "../api";
import { IS_TAURI, mediaSrc } from "../api/net";
import type { Background } from "../api/types";

/**
 * Shared background index.
 *
 * Settings store only a file name, but every window — the console, the
 * previews and each projection surface — needs the absolute path turned into
 * an `asset:` URL the webview is allowed to load. Rather than thread that
 * through as props, the list is cached per window and refreshed whenever the
 * library changes.
 */

let cache: Background[] | null = null;
let inFlight: Promise<Background[]> | null = null;
const listeners = new Set<(items: Background[]) => void>();
let subscribed = false;

async function load(force = false): Promise<Background[]> {
  if (cache && !force) return cache;
  if (!inFlight || force) {
    inFlight = api
      .listBackgrounds()
      .then((items) => {
        cache = items;
        inFlight = null;
        for (const listener of listeners) listener(items);
        return items;
      })
      .catch(() => {
        inFlight = null;
        return cache ?? [];
      });
  }
  return inFlight;
}

function subscribe(listener: (items: Background[]) => void) {
  listeners.add(listener);
  // A browser screen has no backend to ask; its index arrives with the state
  // it is already receiving, through `seedBackgrounds`.
  if (!IS_TAURI) {
    listener(cache ?? []);
    return () => {
      listeners.delete(listener);
    };
  }
  if (!subscribed) {
    subscribed = true;
    void on(EVENT.library, () => void load(true));
  }
  void load().then(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBackgrounds(): Background[] {
  const [items, setItems] = useState<Background[]>(cache ?? []);
  useEffect(() => subscribe(setItems), []);
  return items;
}

export interface ResolvedMedia {
  url: string;
  kind: "image" | "video";
}

/** Turns a stored file name into something an `<img>`/`<video>` can load. */
export function useBackgroundMedia(filename: string | null): ResolvedMedia | null {
  const items = useBackgrounds();
  if (!filename) return null;
  const found = items.find((item) => item.filename === filename);
  if (!found) return null;
  return { url: mediaSrc(found.path), kind: found.kind };
}

/** Fills the index from outside, for windows that cannot call the backend. */
export function seedBackgrounds(items: Background[]) {
  cache = items;
  for (const listener of listeners) listener(items);
}

export function refreshBackgrounds() {
  return load(true);
}

/**
 * A background that is a live camera rather than a stored file.
 *
 * The grid holds plain strings — `#rrggbb` for a colour, a file name for a
 * picture or clip — so a camera needs a marker of its own that can never
 * collide with either. Everything after the prefix is the device id, empty
 * meaning "whichever camera the system offers first".
 */
export const CAMERA_PREFIX = "camera:";

export const isCameraBackground = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.startsWith(CAMERA_PREFIX);

export const cameraDeviceOf = (value: string): string | null =>
  value.slice(CAMERA_PREFIX.length) || null;
