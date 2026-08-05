import { useLayoutEffect, useRef } from "react";
import type { HAlign, VAlign } from "../api/types";

interface Props {
  text: string;
  /** Largest size in px the text may reach. Omitted means the box decides. */
  maxFontSize?: number;
  minFontSize?: number;
  lineHeight: number;
  align?: HAlign;
  valign?: VAlign;
  className?: string;
  style?: React.CSSProperties;
  /** Rendered instead of `text`. `text` is still used to decide when to
   *  re-fit, so pass the same words it is built from. */
  children?: React.ReactNode;
  /**
   * Anything besides the words that changes how they lay out — a plate's
   * padding, or whether line breaks are collapsed.
   *
   * `children` cannot be a dependency: React builds a fresh element every
   * render, so the fit would re-run forever. This is the caller's summary of
   * what actually matters, and changing it re-runs the fit.
   */
  signature?: string;
}

const JUSTIFY: Record<HAlign, string> = { left: "start", center: "center", right: "end" };
const ALIGN: Record<VAlign, string> = { top: "start", middle: "center", bottom: "end" };

/**
 * Renders `text` at the largest size that still fits its box.
 *
 * v1's `SmartLabel.ownWordWrap` walked the font size up in steps of 2 and at
 * each step re-wrapped the text by hand with `QFontMetrics`, inserting literal
 * newlines. That was O(size × words), produced ragged breaks, and left the
 * label wrapped for whatever size happened to be current when the loop broke.
 *
 * Here the browser does the wrapping and we binary-search the size — about
 * nine layout passes regardless of how long the text is.
 */
export function AutoFitText({
  text,
  maxFontSize,
  minFontSize = 6,
  lineHeight,
  align = "center",
  valign = "middle",
  className,
  style,
  children,
  signature,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const node = textRef.current;
    if (!box || !node) return;

    const fit = () => {
      const width = box.clientWidth;
      const height = box.clientHeight;
      if (!text.trim() || width <= 0 || height <= 0) return;

      // Measured from the rendered geometry rather than `scrollHeight`.
      // `scrollHeight` on an `overflow: visible` element does not report
      // children that spill out of it, so once the content became a nested
      // flex column (the plates behind each block) every size looked like it
      // fitted and the search ran to the ceiling.
      //
      // Both rectangles are read the same way, so this stays correct inside
      // the previews, which render the stage under a CSS `scale()`.
      const outer = box.getBoundingClientRect();
      if (outer.width <= 0 || outer.height <= 0) return;
      // One layout pixel, expressed at whatever scale the box is rendered
      // at, to absorb sub-pixel rounding.
      const slack = outer.height / height;

      const fits = (size: number) => {
        node.style.fontSize = `${size}px`;
        const inner = node.getBoundingClientRect();
        return inner.height <= outer.height + slack && inner.width <= outer.width + slack;
      };

      // The box is the size control: text grows until it hits an edge. No
      // glyph can be taller than its container and still fit, so the box
      // height is a safe upper bound — lowered further by an explicit cap.
      const ceiling = maxFontSize && maxFontSize > 0 ? Math.min(height, maxFontSize) : height;
      let low = minFontSize;
      let high = Math.max(minFontSize, Math.ceil(ceiling));
      let best = minFontSize;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (fits(mid)) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      node.style.fontSize = `${best}px`;
    };

    fit();

    // Re-fit on resize (screen swap, resolution change, editor drag) and once
    // webfonts land, since metrics change under us.
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) fit();
    });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [
    text,
    maxFontSize,
    minFontSize,
    lineHeight,
    align,
    style?.fontFamily,
    style?.fontWeight,
    style?.fontStyle,
    style?.letterSpacing,
    signature,
  ]);

  return (
    <div
      ref={boxRef}
      className={className}
      style={{
        ...style,
        display: "grid",
        justifyItems: JUSTIFY[align],
        alignItems: ALIGN[valign],
      }}
    >
      <div
        ref={textRef}
        style={{
          lineHeight,
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          textAlign: align,
          maxWidth: "100%",
        }}
      >
        {children ?? text}
      </div>
    </div>
  );
}
