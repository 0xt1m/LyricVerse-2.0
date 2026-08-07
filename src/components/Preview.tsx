import { useStore } from "../app/store";
import {
  presetFor,
  type DisplayInfo,
  type LiveState,
  type Preset,
  type Timer,
} from "../api/types";
import { Stage } from "../display/Stage";
import { asDisplayInfo, useScreenTargets } from "../lib/screens";
import { useElementWidth } from "./ui/controls";
import { Icon } from "./ui/Icon";

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
  // The transport, so a clip previewed here pauses, seeks and loops with the
  // room. Without it the preview autoplayed on its own and drifted away from
  // the screen the moment anyone touched a control.
  const playback = useStore((s) => s.playback);
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
            <Stage
              preset={preset}
              live={live}
              height={display.height}
              timer={timer}
              playback={playback}
              silent
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A pickable preview of one screen: the chooser, the output, and whether it is
 * actually live.
 *
 * Shared by the foot of the window and the side panel so the two cannot drift
 * apart. Which screen each one watches is passed in rather than read here —
 * with both on show, pointing them at the same output would waste one of them.
 */
export function ScreenPreview({
  chosen,
  onPick,
  className,
}: {
  chosen: string | null;
  onPick: (id: string) => void;
  className?: string;
}) {
  const t = useStore((s) => s.t);
  // Every screen, cabled or served over the network — a web screen is exactly
  // as previewable as a projector, and is often the one nobody can see.
  const screens = useScreenTargets();
  const settings = useStore((s) => s.settings);
  const live = useStore((s) => s.live);
  const timer = useStore((s) => s.timer);

  // Every screen can be previewed, including the console's own. Refusing to
  // project onto it is about not covering the operator's workspace; looking at
  // what its preset produces is harmless — and on a one-screen machine it is
  // the only preview there is.
  const projecting = (display: { id: string; isPrimary: boolean }) =>
    !display.isPrimary && !!settings.displays[display.id]?.enabled;

  const screen =
    screens.find((item) => item.id === chosen) ?? screens.find(projecting) ?? screens[0] ?? null;
  const display = screen ? asDisplayInfo(screen) : null;
  const preset = screen ? presetFor(settings, screen.id) : null;

  const classes = ["preview__pane", className].filter(Boolean).join(" ");

  if (!screen || !display || !preset) {
    return (
      <div className={`${classes} preview__pane--empty`} title={t("displays.noneHint")}>
        <Icon name="eyeOff" size={14} />
      </div>
    );
  }

  return (
    <div className={classes}>
      {/* Always rendered, even with a single screen — otherwise there is no
          visible sign that the preview can be pointed somewhere else. */}
      <select
        className="select preview__pick"
        value={screen.id}
        onChange={(event) => onPick(event.target.value)}
        title={t("displays.preview")}
      >
        {screens.map((item) => (
          <option key={item.id} value={item.id}>
            {/* Says plainly when a screen is not actually projecting, so a
                preview is never mistaken for live output. */}
            {projecting(item) ? item.name : `${item.name} — ${t("displays.preview")}`}
          </option>
        ))}
      </select>
      <PreviewCard display={display} preset={preset} live={live} timer={timer} showName={false} />
      <div className="preview__caption" data-live={live.kind !== "blank"}>
        <span className="chip__dot" />
        {live.kind !== "blank" ? t("transport.live") : t("transport.blank")}
      </div>
    </div>
  );
}
