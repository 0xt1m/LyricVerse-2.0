import { useStore } from "../app/store";
import {
  type DisplayInfo,
  type LiveState,
  type Preset,
  type Timer,
} from "../api/types";
import { Stage } from "../display/Stage";
import { useElementWidth } from "./ui/controls";

/**
 * A screen's output, rendered by the *same* `Stage` the projection window
 * uses, at the screen's real pixel dimensions and then scaled down — so the
 * auto-fitted type size, wrapping and shadows here are exactly what the room
 * sees, not an impression of them. v1 had no preview at all; the operator
 * found out what a setting did by pushing it to the projector mid-service.
 */
export function PreviewCard({
  display,
  preset,
  live,
  timer: timerOverride,
  showName = true,
}: {
  display: DisplayInfo;
  preset: Preset;
  live: LiveState;
  timer?: Timer | null;
  showName?: boolean;
}) {
  const storeTimer = useStore((s) => s.timer);
  const timer = timerOverride === undefined ? storeTimer : timerOverride;
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const scale = width > 0 ? width / display.width : 0;

  return (
    <div className="preview__card">
      {showName && (
        <div className="preview__head">
          <span className="preview__name">{display.name}</span>
          <span>
            {display.width}×{display.height} · {preset.name}
          </span>
        </div>
      )}
      <div
        ref={ref}
        className="preview__frame"
        data-live={live.kind !== "blank"}
        style={{ aspectRatio: `${display.width} / ${display.height}` }}
      >
        {scale > 0 && (
          <div
            className="preview__scaler"
            style={{
              width: display.width,
              height: display.height,
              transform: `scale(${scale})`,
            }}
          >
            <Stage preset={preset} live={live} height={display.height} timer={timer} />
          </div>
        )}
      </div>
    </div>
  );
}
