import { useCallback, useRef, useState } from "react";

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Rubber-band selection: press on the empty space of a grid and drag a
 * rectangle over the tiles you want.
 *
 * Only presses that land on the container itself start a band — a press on a
 * tile belongs to that tile, for dragging it. Holding ⌘/Ctrl or Shift adds to
 * whatever was already picked instead of replacing it, and a press that never
 * moves simply clears the selection, the way empty space does everywhere else.
 */
export function useMarquee(options: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** How many leading children are selectable — trailing extras such as an
   *  "add" tile are not. */
  count: number;
  onSelect: (indices: number[], additive: boolean) => void;
  onClear: () => void;
}) {
  const { containerRef, count, onSelect, onClear } = options;
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const handlers = useRef({ count, onSelect, onClear });
  handlers.current = { count, onSelect, onClear };

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // A press on a tile is that tile's business.
      if (event.target !== event.currentTarget || event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const origin = { x: event.clientX, y: event.clientY };
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      let moved = false;

      const move = (moveEvent: PointerEvent) => {
        const left = Math.min(origin.x, moveEvent.clientX);
        const top = Math.min(origin.y, moveEvent.clientY);
        const width = Math.abs(moveEvent.clientX - origin.x);
        const height = Math.abs(moveEvent.clientY - origin.y);
        if (!moved && width < 4 && height < 4) return;
        moved = true;

        // Positioned against the container's own box, so the band scrolls
        // with the grid rather than floating over it.
        const box = container.getBoundingClientRect();
        setRect({ left: left - box.left, top: top - box.top, width, height });

        const tiles = Array.from(container.children) as HTMLElement[];
        const hit: number[] = [];
        for (let index = 0; index < Math.min(tiles.length, handlers.current.count); index += 1) {
          const tile = tiles[index]!.getBoundingClientRect();
          const overlaps =
            tile.right >= left &&
            tile.left <= left + width &&
            tile.bottom >= top &&
            tile.top <= top + height;
          if (overlaps) hit.push(index);
        }
        handlers.current.onSelect(hit, additive);
      };

      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        if (!moved && !additive) handlers.current.onClear();
        setRect(null);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    },
    [containerRef],
  );

  return { rect, onPointerDown };
}
