import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * The image formats the backend will accept, fetched once.
 *
 * Kept on the Rust side so the file-picker filters, the drop filter and the
 * importer cannot drift apart — the importer is the thing that actually knows
 * what it can decode.
 */
let imageExtensions: string[] | null = null;

export function useImageExtensions(): string[] {
  const [extensions, setExtensions] = useState<string[]>(imageExtensions ?? []);
  useEffect(() => {
    if (imageExtensions) return;
    let cancelled = false;
    void api
      .supportedImageExtensions()
      .then((list) => {
        imageExtensions = list;
        if (!cancelled) setExtensions(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return extensions;
}

/**
 * Whether a drag position falls inside an element.
 *
 * Drop events arrive for the whole webview, so a window with more than one
 * drop zone — two background pickers, or the presentation list beside its
 * slides — has to work out which one the pointer was actually over.
 */
export function within(
  ref: React.RefObject<HTMLElement | null>,
  point: { x: number; y: number },
): boolean {
  const box = ref.current?.getBoundingClientRect();
  return (
    !!box &&
    point.x >= box.left &&
    point.x <= box.right &&
    point.y >= box.top &&
    point.y <= box.bottom
  );
}

/**
 * Files dropped onto the window.
 *
 * Uses Tauri's own drag-drop events rather than HTML5 drag-and-drop. Tauri
 * intercepts those events before the page sees them, and its version hands
 * back real filesystem *paths* — which is what the import commands need.
 * HTML5 would only give a sandboxed `File`, forcing the bytes through the
 * webview for no reason.
 */
export function useFileDrop(options: {
  /** Lower-case extensions to accept, without the dot. */
  extensions: string[];
  onDrop: (paths: string[], position: { x: number; y: number }) => void;
  /** Anything dropped that the extensions list does not cover. Without this
   *  an unsupported file would simply vanish with no explanation. The position
   *  is passed so a window with several drop zones can leave the complaint to
   *  whichever one was actually dropped on. */
  onReject?: (paths: string[], position: { x: number; y: number }) => void;
  enabled?: boolean;
}) {
  const { extensions, onDrop, onReject, enabled = true } = options;
  /** Where the pointer is while dragging, in CSS pixels — null when not. */
  const [over, setOver] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOver(null);
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const split = (paths: string[]) => {
      const usable: string[] = [];
      const rejected: string[] = [];
      for (const path of paths) {
        const extension = path.split(".").pop()?.toLowerCase() ?? "";
        (extensions.includes(extension) ? usable : rejected).push(path);
      }
      return { usable, rejected };
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        // Physical pixels from the OS; the DOM works in CSS pixels.
        const ratio = window.devicePixelRatio || 1;
        const toCss = (point: { x: number; y: number }) => ({
          x: point.x / ratio,
          y: point.y / ratio,
        });

        if (event.payload.type === "over") {
          // Tracked continuously so the caller can light up whichever zone
          // the pointer is actually over.
          setOver(toCss(event.payload.position));
        } else if (event.payload.type === "drop") {
          setOver(null);
          const { usable, rejected } = split(event.payload.paths);
          if (usable.length > 0) onDrop(usable, toCss(event.payload.position));
          if (rejected.length > 0) onReject?.(rejected, toCss(event.payload.position));
        } else {
          setOver(null);
        }
      })
      .then((off) => {
        // The listener resolves asynchronously; if the tab closed first, drop
        // it immediately rather than leaking a handler onto the next tab.
        if (cancelled) off();
        else unlisten = off;
      });

    return () => {
      cancelled = true;
      unlisten?.();
      setOver(null);
    };
  }, [enabled, onDrop, onReject, extensions.join(",")]);

  return over;
}
