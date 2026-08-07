import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EVENT, api, on } from "../api";
import { IS_TAURI, pollFrame, type WebFrameState } from "../api/net";
import {
  presetFor,
  type DisplayInfo,
  type LiveState,
  type Preset,
  type Settings,
  type Playback,
  type Timer,
} from "../api/types";
import { seedBackgrounds } from "../lib/backgrounds";
import { Stage } from "./Stage";
import "../styles/global.css";

/**
 * One instance of this document runs per projection window. The window's own
 * label ("display-0", "display-1", …) is the key into the settings, so no
 * query strings or handshakes are needed — a reload picks up exactly where it
 * left off.
 */
function DisplayWindow() {
  const windowLabel = getCurrentWindow().label;
  // A test window is labelled "test-display-0" and renders the configuration
  // of the screen it names.
  const isTest = windowLabel.startsWith("test-");
  const label = isTest ? windowLabel.slice("test-".length) : windowLabel;
  const [preset, setPreset] = useState<Preset | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [info, setInfo] = useState<DisplayInfo | null>(null);
  const [identify, setIdentify] = useState<string | null>(null);
  const [height, setHeight] = useState(() => window.innerHeight);
  const [timer, setTimer] = useState<Timer | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);

  useEffect(() => {
    const apply = (settings: Settings) => setPreset(presetFor(settings, label));
    const applyDisplays = (displays: DisplayInfo[]) =>
      setInfo(displays.find((d) => d.id === label) ?? null);

    // Pull current state rather than waiting for the next event, so a window
    // opened mid-song immediately shows the song.
    void api.getSettings().then(apply);
    void api.getLive().then(setLive);
    void api.getTimer().then(setTimer);
    void api.getPlayback().then(setPlayback);
    void api.listDisplays().then(applyDisplays);

    const unlisten = [
      on<Settings>(EVENT.settings, apply),
      on<LiveState>(EVENT.live, setLive),
      on<Timer | null>(EVENT.timer, setTimer),
      on<Playback>(EVENT.playback, setPlayback),
      on<DisplayInfo[]>(EVENT.displays, applyDisplays),
    ];
    return () => {
      for (const pending of unlisten) void pending.then((off) => off());
    };
  }, [label]);

  useEffect(() => {
    const unlisten = on(EVENT.identify, () => {
      setIdentify(label);
      window.setTimeout(() => setIdentify(null), 2500);
    });
    return () => void unlisten.then((off) => off());
  }, [label]);

  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!preset || !live) {
    return <div style={{ position: "absolute", inset: 0, background: "#000" }} />;
  }

  const identifyLabel = identify
    ? `${info ? info.name : label}\n${info ? `${info.width}×${info.height}` : ""}`
    : null;

  return (
    <Stage
      preset={preset}
      live={live}
      height={height}
      identify={identifyLabel}
      timer={timer}
      playback={playback}
    />
  );
}

/**
 * The same document opened in a browser on another device.
 *
 * Everything below `Stage` is shared with the desktop windows, so a tablet at
 * the back of the hall renders the operator's layout exactly — down to the
 * auto-fitted type size — rather than approximating it. Only the way state
 * arrives is different: a held-open request instead of Tauri's event bus.
 */
function WebDisplay() {
  const [frame, setFrame] = useState<WebFrameState | null>(null);
  const [screenId, setScreenId] = useState<string>("");
  /** How far this device's clock is ahead of the host's, in milliseconds. */
  const [skew, setSkew] = useState(0);
  const [offline, setOffline] = useState(false);
  const [height, setHeight] = useState(() => window.innerHeight);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();

    void (async () => {
      let since = 0;
      while (!stopped) {
        try {
          const next = await pollFrame(since, controller.signal);
          since = next.revision;
          setScreenId(next.screenId);
          if (next.state) {
            seedBackgrounds(next.state.backgrounds ?? []);
            // On a local network the round trip is negligible next to the
            // clock differences this is correcting for.
            if (next.state.now) setSkew(Date.now() - next.state.now);
            setFrame(next.state);
          }
          setOffline(false);
        } catch {
          if (stopped) return;
          // The console has quit, gone to sleep, or moved network. Keep
          // trying rather than leaving a dead screen on the wall.
          setOffline(true);
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!frame) {
    return (
      <div style={WAITING}>
        {offline ? "Reconnecting to LyricVerse…" : "Waiting for LyricVerse…"}
      </div>
    );
  }

  const preset = presetFor(frame.settings, screenId);
  if (!preset) return <div style={{ position: "absolute", inset: 0, background: "#000" }} />;

  // The anchor was stamped by the host's clock; move it onto this device's so
  // the digits here match the digits on the projector.
  const timer = frame.timer ? { ...frame.timer, anchorMs: frame.timer.anchorMs + skew } : null;

  // The transport travels the same way and needs the same correction. Without
  // it a clip on a tablet resolved its position against a clock that could be
  // minutes from the console's, so the web screen played from somewhere else
  // entirely — and re-seeked there every time the operator touched anything.
  const playback = frame.playback
    ? { ...frame.playback, anchorMs: frame.playback.anchorMs + skew }
    : null;

  return (
    <Stage
      preset={preset}
      live={frame.live}
      height={height}
      identify={null}
      timer={timer}
      playback={playback}
      // A browser will not autoplay unmuted media without somebody clicking
      // the page first, so an unmuted clip on a web screen never starts at
      // all. The room's sound comes from the console, not from a tablet at
      // the back, so this costs nothing and is the only way it plays.
      silent
    />
  );
}

const WAITING: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeContent: "center",
  background: "#000",
  color: "#5c5f66",
  font: "500 clamp(14px, 2.2vw, 22px)/1.4 system-ui, sans-serif",
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>{IS_TAURI ? <DisplayWindow /> : <WebDisplay />}</StrictMode>,
);
