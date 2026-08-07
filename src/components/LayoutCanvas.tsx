import { useCallback, useRef, useState } from "react";
import type { ElementId, Layout, LayoutElement, LiveState, Preset, Rect, Timer } from "../api/types";
import { Stage } from "../display/Stage";
import { useElementWidth } from "./ui/controls";

interface Props {
  preset: Preset;
  live: LiveState;
  layout: Layout;
  /** Aspect ratio of the real screen, so the canvas is not a lie. */
  aspect: { width: number; height: number };
  selected: ElementId | null;
  onSelect: (id: ElementId | null) => void;
  onChange: (id: ElementId, rect: Rect) => void;
}

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** A stopped five-minute countdown, so the timer box has something to show. */
const SAMPLE_TIMER: Timer = {
  mode: "countdown",
  label: "",
  anchorMs: 0,
  frozenMs: 5 * 60 * 1000,
  durationMs: 5 * 60 * 1000,
  running: false,
  hideWhenFinished: false,
  overrunColor: "#e5484d",
  warnAtSeconds: 60,
  warnColor: "#f0a83a",
};

/** Positions that snap: screen edges, centres and thirds. */
const SNAP_TARGETS = [0, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 5 / 6, 1].map((f) => f * 100);
const SNAP_TOLERANCE = 1.2; // percent

/**
 * The example screen: a live `Stage` with a draggable, resizable box over each
 * element. Because it renders the very same component the projector does, the
 * auto-fitted type size, wrapping and shadows shown here are exactly what the
 * room will see — not a mock-up of them.
 */
export function LayoutCanvas({
  preset,
  live,
  layout,
  aspect,
  selected,
  onSelect,
  onChange,
}: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const height = width * (aspect.height / aspect.width);
  const [dragging, setDragging] = useState<ElementId | null>(null);
  const [snapLines, setSnapLines] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });

  const surfaceRef = useRef<HTMLDivElement>(null);

  const beginDrag = useCallback(
    (event: React.PointerEvent, element: LayoutElement, handle: Handle) => {
      event.preventDefault();
      event.stopPropagation();
      const surface = surfaceRef.current;
      if (!surface) return;

      onSelect(element.id);
      setDragging(element.id);
      const box = surface.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      const origin = { ...element.rect };
      (event.target as HTMLElement).setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent) => {
        // Convert pixel travel into percentage-of-screen, which is the unit
        // everything is stored in.
        const dx = ((moveEvent.clientX - start.x) / box.width) * 100;
        const dy = ((moveEvent.clientY - start.y) / box.height) * 100;
        // Shift locks the proportions; Alt places freely. Snapping is skipped
        // in both cases — it would pull an edge off the ratio the operator
        // just asked to preserve.
        const lockAspect = moveEvent.shiftKey && handle !== "move";
        const free = moveEvent.altKey || lockAspect;
        const next = apply(origin, handle, dx, dy, lockAspect);
        const { rect, lines } = free ? { rect: next, lines: { x: [], y: [] } } : snap(next, handle);
        setSnapLines(lines);
        onChange(element.id, rect);
      };

      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        setDragging(null);
        setSnapLines({ x: [], y: [] });
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    },
    [onChange, onSelect],
  );

  return (
    <div ref={ref} style={{ width: "100%" }}>
      <div
        ref={surfaceRef}
        onPointerDown={() => onSelect(null)}
        style={{
          position: "relative",
          width: "100%",
          height,
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid var(--border-strong)",
          background: "#000",
          // A checkerboard shows through a chroma-key fill so it reads as
          // "keyed out" rather than "green screen is the design".
          backgroundImage:
            "repeating-conic-gradient(#15181d 0% 25%, #0d1014 0% 50%) 0 0 / 16px 16px",
          touchAction: "none",
        }}
      >
        {height > 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: aspect.width,
              height: aspect.height,
              transformOrigin: "top left",
              transform: `scale(${width / aspect.width})`,
            }}
          >
            <Stage
              preset={preset}
              live={live}
              height={aspect.height}
              alwaysRender
              timer={SAMPLE_TIMER}
              silent
            />
          </div>
        )}

        {/* Snap guides */}
        {snapLines.x.map((x) => (
          <div
            key={`x${x}`}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--accent)",
              opacity: 0.8,
              pointerEvents: "none",
            }}
          />
        ))}
        {snapLines.y.map((y) => (
          <div
            key={`y${y}`}
            style={{
              position: "absolute",
              top: `${y}%`,
              left: 0,
              right: 0,
              height: 1,
              background: "var(--accent)",
              opacity: 0.8,
              pointerEvents: "none",
            }}
          />
        ))}

        {/* Only what is switched on can be grabbed. A hidden element draws
            nothing on screen, so a box for it would be a handle for something
            invisible — switch it on in the list first. Its position is still
            editable numerically in the inspector. */}
        {layout.elements
          .filter((element) => element.visible)
          .map((element) => (
            <ElementBox
              key={element.id}
              element={element}
              selected={element.id === selected}
              dragging={element.id === dragging}
              onBegin={beginDrag}
            />
          ))}
      </div>
    </div>
  );
}

function ElementBox({
  element,
  selected,
  dragging,
  onBegin,
}: {
  element: LayoutElement;
  selected: boolean;
  dragging: boolean;
  onBegin: (event: React.PointerEvent, element: LayoutElement, handle: Handle) => void;
}) {
  const border = selected ? "1px solid var(--accent)" : "1px dashed rgba(255,255,255,0.28)";

  return (
    <div
      onPointerDown={(event) => onBegin(event, element, "move")}
      style={{
        position: "absolute",
        left: `${element.rect.x}%`,
        top: `${element.rect.y}%`,
        width: `${element.rect.width}%`,
        height: `${element.rect.height}%`,
        border,
        borderRadius: 3,
        cursor: dragging ? "grabbing" : "grab",
        background: selected ? "rgba(240,168,58,0.08)" : "transparent",
        touchAction: "none",
      }}
    >
      {selected &&
        (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((handle) => (
          <div
            key={handle}
            onPointerDown={(event) => onBegin(event, element, handle)}
            style={{
              position: "absolute",
              width: 9,
              height: 9,
              background: "var(--accent)",
              border: "1px solid #12151a",
              borderRadius: 2,
              cursor: `${handle}-resize`,
              ...handlePosition(handle),
            }}
          />
        ))}
    </div>
  );
}

function handlePosition(handle: Handle): React.CSSProperties {
  const edge = -5;
  const mid = "calc(50% - 4.5px)";
  switch (handle) {
    case "nw": return { left: edge, top: edge };
    case "n": return { left: mid, top: edge };
    case "ne": return { right: edge, top: edge };
    case "e": return { right: edge, top: mid };
    case "se": return { right: edge, bottom: edge };
    case "s": return { left: mid, bottom: edge };
    case "sw": return { left: edge, bottom: edge };
    case "w": return { left: edge, top: mid };
    default: return {};
  }
}

const MIN_SIZE = 3;

/**
 * Applies a drag delta for the given handle, keeping the box usable.
 *
 * With `lockAspect`, width and height keep their original ratio. Because both
 * are percentages of the same fixed screen, holding the percentage ratio
 * constant also holds the on-screen ratio constant.
 */
function apply(
  origin: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  lockAspect = false,
): Rect {
  if (handle === "move") {
    return { ...origin, x: origin.x + dx, y: origin.y + dy };
  }

  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");

  let width = origin.width;
  let height = origin.height;
  if (east) width = origin.width + dx;
  if (west) width = origin.width - dx;
  if (south) height = origin.height + dy;
  if (north) height = origin.height - dy;
  width = Math.max(MIN_SIZE, width);
  height = Math.max(MIN_SIZE, height);

  if (lockAspect && origin.width > 0 && origin.height > 0) {
    const ratio = origin.width / origin.height;
    if ((east || west) && (north || south)) {
      // Corner: whichever axis the operator moved further drives the other.
      const byWidth = Math.abs(width - origin.width) / origin.width;
      const byHeight = Math.abs(height - origin.height) / origin.height;
      if (byWidth >= byHeight) height = width / ratio;
      else width = height * ratio;
    } else if (east || west) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
    width = Math.max(MIN_SIZE, width);
    height = Math.max(MIN_SIZE, height);
  }

  // The edge opposite the handle stays put.
  let x = west ? origin.x + (origin.width - width) : origin.x;
  let y = north ? origin.y + (origin.height - height) : origin.y;

  // On an aspect-locked edge drag the perpendicular axis also changed; grow it
  // about the centre so the box does not drift sideways.
  if (lockAspect) {
    if ((east || west) && !north && !south) {
      y = origin.y + (origin.height - height) / 2;
    } else if ((north || south) && !east && !west) {
      x = origin.x + (origin.width - width) / 2;
    }
  }

  return { x, y, width, height };
}

/** Pulls edges and centres onto the guide positions, and reports the hits. */
function snap(rect: Rect, handle: Handle): { rect: Rect; lines: { x: number[]; y: number[] } } {
  const out = { ...rect };
  const lines: { x: number[]; y: number[] } = { x: [], y: [] };

  const nearest = (value: number) => {
    let best: number | null = null;
    for (const target of SNAP_TARGETS) {
      if (Math.abs(value - target) <= SNAP_TOLERANCE) {
        if (best === null || Math.abs(value - target) < Math.abs(value - best)) best = target;
      }
    }
    return best;
  };

  if (handle === "move") {
    // Moving snaps whichever of left / centre / right lands on a guide first.
    const candidates: [number, number][] = [
      [out.x, 0],
      [out.x + out.width / 2, out.width / 2],
      [out.x + out.width, out.width],
    ];
    for (const [value, offset] of candidates) {
      const target = nearest(value);
      if (target !== null) {
        out.x = target - offset;
        lines.x.push(target);
        break;
      }
    }
    const verticals: [number, number][] = [
      [out.y, 0],
      [out.y + out.height / 2, out.height / 2],
      [out.y + out.height, out.height],
    ];
    for (const [value, offset] of verticals) {
      const target = nearest(value);
      if (target !== null) {
        out.y = target - offset;
        lines.y.push(target);
        break;
      }
    }
    return { rect: out, lines };
  }

  // Resizing snaps only the edge being dragged.
  if (handle.includes("w")) {
    const target = nearest(out.x);
    if (target !== null) {
      out.width += out.x - target;
      out.x = target;
      lines.x.push(target);
    }
  }
  if (handle.includes("e")) {
    const target = nearest(out.x + out.width);
    if (target !== null) {
      out.width = target - out.x;
      lines.x.push(target);
    }
  }
  if (handle.includes("n")) {
    const target = nearest(out.y);
    if (target !== null) {
      out.height += out.y - target;
      out.y = target;
      lines.y.push(target);
    }
  }
  if (handle.includes("s")) {
    const target = nearest(out.y + out.height);
    if (target !== null) {
      out.height = target - out.y;
      lines.y.push(target);
    }
  }
  out.width = Math.max(MIN_SIZE, out.width);
  out.height = Math.max(MIN_SIZE, out.height);
  return { rect: out, lines };
}

export const roundRect = (rect: Rect): Rect => ({
  x: Math.round(rect.x * 10) / 10,
  y: Math.round(rect.y * 10) / 10,
  width: Math.round(rect.width * 10) / 10,
  height: Math.round(rect.height * 10) / 10,
});
