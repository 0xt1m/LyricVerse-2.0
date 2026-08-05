import { useCallback, useRef, useState } from "react";

/**
 * Pointer-driven reordering for a grid or list of tiles.
 *
 * Not HTML5 drag-and-drop: WebKit refuses to start a drag unless the handler
 * calls `dataTransfer.setData`, and Tauri's file-drop handling sits in front
 * of those events. A press has to travel a few pixels before it counts as a
 * drag, so a plain click still selects.
 */
export function useGridReorder(options: {
  /** Element whose children are the tiles, in visual order. */
  containerRef: React.RefObject<HTMLElement | null>;
  onMove: (from: number, to: number) => void;
  /** Fired when the press never became a drag. */
  onClick?: (index: number, event: PointerEvent) => void;
  /** How many leading children may be dropped on — trailing extras such as an
   *  "add" tile are not targets. Defaults to all of them. */
  count?: number;
  threshold?: number;
}) {
  const { containerRef, onMove, onClick, count, threshold = 4 } = options;
  const [dragging, setDragging] = useState<number | null>(null);
  // Kept in a ref so the listeners always see the current callbacks without
  // being torn down and rebuilt mid-drag.
  const handlers = useRef({ onMove, onClick });
  handlers.current = { onMove, onClick };

  const beginPress = useCallback(
    (event: React.PointerEvent, index: number) => {
      if (event.button !== 0) return;
      const start = { x: event.clientX, y: event.clientY };
      let current = index;
      let started = false;

      const move = (moveEvent: PointerEvent) => {
        if (!started) {
          const travelled = Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y);
          if (travelled < threshold) return;
          started = true;
          setDragging(current);
        }
        const tiles = Array.from(containerRef.current?.children ?? []) as HTMLElement[];
        const target = tiles.findIndex((tile) => {
          const box = tile.getBoundingClientRect();
          return (
            moveEvent.clientX >= box.left &&
            moveEvent.clientX <= box.right &&
            moveEvent.clientY >= box.top &&
            moveEvent.clientY <= box.bottom
          );
        });
        const limit = count ?? tiles.length;
        if (target >= 0 && target < limit && target !== current) {
          handlers.current.onMove(current, target);
          current = target;
          setDragging(target);
        }
      };

      const end = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        if (!started) handlers.current.onClick?.(index, upEvent);
        setDragging(null);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    },
    [containerRef, count, threshold],
  );

  return { dragging, beginPress };
}
