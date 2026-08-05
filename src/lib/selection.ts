import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Multi-select for a grid of tiles.
 *
 * Follows the conventions every file manager uses, so it needs no explaining:
 * a plain click selects one, ⌘/Ctrl-click toggles one, and Shift-click takes
 * the range from the last plain click. The anchor deliberately does not move
 * on a Shift-click, so extending a range twice grows it from the same origin
 * rather than walking away from it.
 */
export interface TileSelection {
  selected: ReadonlySet<number>;
  /** True when more than one tile is picked — the cue for bulk actions. */
  isMulti: boolean;
  /** Returns true when the click was a modifier one and handled here, so the
   *  caller can skip its own "select and show" behaviour. */
  handleClick: (index: number, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => boolean;
  selectOnly: (index: number) => void;
  /** Replaces the selection, or adds to it — used by rubber-band dragging. */
  setMany: (indices: number[], additive: boolean) => void;
  clear: () => void;
  /** The picked indices, ascending — the order a bulk action should use. */
  ordered: () => number[];
}

export function useTileSelection(count: number, resetKey?: unknown): TileSelection {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);

  // A different song or deck means the old indices mean nothing.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [resetKey]);

  // Tiles removed underneath us must not leave phantom selections behind.
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((index) => index < count));
      return next.size === current.size ? current : next;
    });
  }, [count]);

  const selectOnly = useCallback((index: number) => {
    anchor.current = index;
    setSelected(new Set([index]));
  }, []);

  const handleClick = useCallback<TileSelection["handleClick"]>((index, event) => {
    if (event.metaKey || event.ctrlKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
      anchor.current = index;
      return true;
    }

    if (event.shiftKey) {
      const from = anchor.current ?? index;
      const [low, high] = from <= index ? [from, index] : [index, from];
      const range = new Set<number>();
      for (let i = low; i <= high; i += 1) range.add(i);
      setSelected(range);
      return true;
    }

    selectOnly(index);
    return false;
  }, [selectOnly]);

  const setMany = useCallback<TileSelection["setMany"]>((indices, additive) => {
    setSelected((current) => {
      const next = additive ? new Set(current) : new Set<number>();
      for (const index of indices) next.add(index);
      return next;
    });
  }, []);

  return {
    selected,
    isMulti: selected.size > 1,
    handleClick,
    selectOnly,
    setMany,
    clear: useCallback(() => setSelected(new Set()), []),
    ordered: useCallback(() => [...selected].sort((a, b) => a - b), [selected]),
  };
}
