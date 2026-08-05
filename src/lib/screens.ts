import { useMemo } from "react";
import { useStore } from "../app/store";
import type { DisplayInfo, WebScreenStatus } from "../api/types";

/**
 * Every screen the operator can send output to, plugged in or not.
 *
 * A monitor announces itself; a web screen is one somebody added by hand and
 * opens in a browser. Everywhere above this — the Displays tab, the footer
 * preview, the layout editor — treats the two the same, which is the whole
 * reason a browser screen gets presets and previews for free.
 */
export interface ScreenTarget {
  id: string;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
  /** Set for a real monitor; null for a web screen. */
  monitor: DisplayInfo | null;
  web: { port: number; status: WebScreenStatus | null } | null;
}

/**
 * A web screen has no size of its own — the device that opens it decides that
 * — so its layout is arranged against 16:9, which is what a TV, a tablet in
 * landscape and a laptop all are.
 */
export const WEB_SIZE = { width: 1920, height: 1080 };

export function useScreenTargets(): ScreenTarget[] {
  const displays = useStore((s) => s.displays);
  const webScreens = useStore((s) => s.settings.webScreens);
  const webStatus = useStore((s) => s.webScreens);

  return useMemo(
    () => [
      ...displays.map((item) => ({
        id: item.id,
        name: item.name,
        width: item.width,
        height: item.height,
        isPrimary: item.isPrimary,
        monitor: item,
        web: null,
      })),
      ...webScreens.map((screen) => ({
        id: screen.id,
        name: screen.name,
        width: WEB_SIZE.width,
        height: WEB_SIZE.height,
        // A web screen is never the console's own; nothing is covered by it.
        isPrimary: false,
        monitor: null,
        web: {
          port: screen.port,
          status: webStatus.find((item) => item.id === screen.id) ?? null,
        },
      })),
    ],
    [displays, webScreens, webStatus],
  );
}

/** What `PreviewCard` needs, for a screen that is not a monitor. */
export function asDisplayInfo(target: ScreenTarget): DisplayInfo {
  return (
    target.monitor ?? {
      id: target.id,
      index: 0,
      name: target.name,
      x: 0,
      y: 0,
      width: target.width,
      height: target.height,
      scaleFactor: 1,
      isPrimary: false,
      isOpen: false,
    }
  );
}
