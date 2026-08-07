import { useEffect, useRef, useState } from "react";
import { EVENT, api, on } from "../api";
import { IS_TAURI } from "../api/net";
import { applySink } from "../components/AudioEngine";
import { playbackPosition, youtubeCommand } from "../lib/playback";
import { cameraDeviceOf, isCameraBackground, useBackgroundMedia } from "../lib/backgrounds";
import { timerColor, useNow, useTimerText } from "../lib/timer";
import type {
  BackgroundFit,
  ElementId,
  Layout,
  LayoutElement,
  LiveState,
  Playback,
  Settings,
  Panel,
  Preset,
  Shadow,
  Timer,
} from "../api/types";
import { mediaSrc } from "../api/net";
import { AutoFitText } from "./AutoFitText";

interface Props {
  preset: Preset;
  live: LiveState;
  /** Height of the surface in CSS pixels — every size is a % of this. */
  height: number;
  /** Shown instead of the live text while the operator identifies screens. */
  identify?: string | null;
  /** Render even when the state is blank — the layout editor always draws. */
  alwaysRender?: boolean;
  /** The countdown/clock, which runs independently of what is on screen. */
  timer?: Timer | null;
  /** How the clip on screen should be playing. */
  playback?: Playback | null;
  /**
   * This surface must never make a sound, whatever the transport says.
   *
   * Two quite different reasons, one flag. A console preview shares a machine
   * with the projection window already playing the clip, so sound here would
   * be an echo. A browser screen is subject to the autoplay policy: no browser
   * will start unmuted media without a user gesture, so an unmuted clip simply
   * never plays at all. Both still follow the transport — a surface that
   * ignored pause would be showing something the room is not.
   */
  silent?: boolean;
}

/**
 * The projection surface. Used by the real projection windows, the operator's
 * preview thumbnails and the layout editor — so what the editor shows is what
 * the projector shows, not an approximation of it.
 */
export function Stage({
  preset,
  live,
  height,
  identify,
  alwaysRender,
  timer,
  playback,
  silent,
}: Props) {
  const isMedia = live.kind === "image" || live.kind === "video" || live.kind === "camera";
  const isTimer = live.kind === "timer";
  // A typed message belongs to the Slides tab, so it is styled there too —
  // the same layout a picture would use, with its Text element switched on.
  const isSlide = isMedia || live.kind === "message";
  const layout = isTimer
    ? preset.timer
    : isSlide
      ? preset.media
      : live.kind === "bible"
        ? preset.bible
        : preset.song;
  const blank =
    !alwaysRender &&
    !isMedia &&
    !isTimer &&
    (live.kind === "blank" || !live.bodyPart.trim());

  if (identify) {
    return (
      <div style={{ position: "absolute", inset: 0, background: "#101319", display: "grid", placeItems: "center" }}>
        <div
          style={{
            fontSize: height * 0.12,
            fontWeight: 800,
            color: "#f0a83a",
            letterSpacing: "-0.02em",
            textAlign: "center",
            whiteSpace: "pre-line",
            padding: "0 5%",
          }}
        >
          {identify}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: backgroundOf(preset, blank),
        overflow: "hidden",
        transition: "background 180ms ease",
      }}
    >
      {/* Blanking swaps to the idle backdrop rather than removing it — unless
          the preset pins the background, as a chroma key must. */}
      <BackgroundMedia
        media={blank && !preset.constantBackground ? preset.passiveBackgroundMedia : preset.backgroundMedia}
        fit={blank && !preset.constantBackground ? preset.passiveBackgroundFit : preset.backgroundFit}
        dim={blank && !preset.constantBackground ? preset.passiveBackgroundDim : preset.backgroundDim}
      />

      {/* A presentation slide or a clip fills the screen; the layout's text
          elements belong to songs and scripture, so only the timer overlays. */}
      {isMedia && <LiveMedia live={live} playback={playback ?? null} silent={!!silent} />}

      {!blank &&
        visibleElements(layout).map((element) => {
          if (element.id === "timer") {
            return <TimerElement key={element.id} element={element} timer={timer} height={height} />;
          }
          if (isMedia) return null;
          const text = contentOf(element.id, live);
          if (!text.trim()) return null;
          // "Next up" can be a picture of the coming slide instead of a line
          // of its words — a musician looking across at a confidence screen
          // recognises the shape of a verse far faster than they read it.
          if (element.id === "nextUp" && preset.nextPreview) {
            return (
              <NextPreview
                key={element.id}
                element={element}
                body={layout.elements.find((item) => item.id === "body") ?? element}
                text={text}
                preset={preset}
                height={height}
                collapse={preset.collapseLineBreaks}
              />
            );
          }
          return (
            <StageElement
              key={element.id}
              element={element}
              text={element.uppercase ? text.toUpperCase() : text}
              height={height}
              collapse={preset.collapseLineBreaks}
            />
          );
        })}
    </div>
  );
}

/**
 * The coming slide, drawn small inside the "next up" element's own box.
 *
 * A miniature of the real thing rather than a second `Stage`: it borrows the
 * body element's typography and the preset's backdrop, so the shape of the
 * verse — how many lines, where they break — is the shape it will have when it
 * goes up. Nesting a whole Stage here would drag in the backgrounds, the timer
 * and the media player for a thumbnail, and would recurse into this very
 * branch.
 *
 * It reuses the element's rect, so it is positioned and resized in the layout
 * editor like everything else, with no new geometry to learn.
 */
function NextPreview({
  element,
  body,
  text,
  preset,
  height,
  collapse,
}: {
  element: LayoutElement;
  /** The element the coming slide will actually be drawn in. */
  body: LayoutElement;
  text: string;
  preset: Preset;
  height: number;
  collapse?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${element.rect.x}%`,
        top: `${element.rect.y}%`,
        width: `${element.rect.width}%`,
        height: `${element.rect.height}%`,
        opacity: element.opacity,
        // Framed and set on the preset's own backdrop, so it reads as a small
        // screen rather than as more text that has drifted into a corner.
        background: preset.background,
        border: `${Math.max(1, height * 0.0015)}px solid ${element.color}`,
        borderRadius: height * 0.008,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <AutoFitText
        text={text}
        maxFontSize={height * 0.05}
        lineHeight={body.lineHeight}
        align={body.align}
        valign="middle"
        signature={`next:${collapse}:${element.rect.width}:${element.rect.height}`}
        style={{
          position: "absolute",
          // A margin of its own, in the miniature's terms rather than the
          // screen's, so the words are not jammed against the frame.
          inset: "6%",
          color: element.color,
          fontFamily: body.fontFamily,
          fontWeight: body.fontWeight,
          fontStyle: body.italic ? "italic" : "normal",
          letterSpacing: `${body.letterSpacing}em`,
        }}
      >
        {collapse ? text.replace(/\s*\n\s*/g, " ").trim() : text}
      </AutoFitText>
    </div>
  );
}

function StageElement({
  element,
  text,
  height,
  color,
  collapse,
}: {
  element: LayoutElement;
  text: string;
  height: number;
  /** Overrides the element's own colour, for the timer's warning states. */
  color?: string | null;
  /** Reflow the words instead of honouring the source's line breaks. */
  collapse?: boolean;
}) {
  return (
    <AutoFitText
      text={text}
      maxFontSize={
        element.maxFontScale > 0 ? (height * element.maxFontScale) / 100 : undefined
      }
      lineHeight={element.lineHeight}
      align={element.align}
      valign={element.valign}
      // The plate's padding and the gap between blocks are part of what has to
      // fit, and collapsing line breaks changes how many lines there are — so
      // any of them changing has to re-run the fit.
      signature={[
        element.panel.opacity,
        element.panel.padding,
        element.panel.radius,
        element.panel.gap,
        collapse,
      ].join(":")}
      style={{
        position: "absolute",
        left: `${element.rect.x}%`,
        top: `${element.rect.y}%`,
        width: `${element.rect.width}%`,
        height: `${element.rect.height}%`,
        color: color ?? element.color,
        opacity: element.opacity,
        fontFamily: element.fontFamily,
        fontWeight: element.fontWeight,
        fontStyle: element.italic ? "italic" : "normal",
        letterSpacing: `${element.letterSpacing}em`,
        textShadow: textShadow(element.shadow, height),
        pointerEvents: "none",
      }}
    >
      <PanelledText
        text={text}
        panel={element.panel}
        align={element.align}
        collapse={collapse}
      />
    </AutoFitText>
  );
}

/**
 * Splits the text on blank lines and gives each block its own plate.
 *
 * That is what separates the translations of a parallel reading — one plate
 * each, rather than two paragraphs the eye has to untangle. Padding, radius
 * and the gap are in `em`, so they grow and shrink with the auto-fitted type
 * instead of drifting out of proportion.
 */
function PanelledText({
  text,
  panel,
  align,
  collapse,
}: {
  text: string;
  panel: Panel;
  align: string;
  collapse?: boolean;
}) {
  // Split into blocks *before* collapsing, so a parallel reading keeps its
  // translations apart while every line break inside one disappears.
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => (collapse ? block.replace(/\s*\n\s*/g, " ").trim() : block))
    .filter((block) => block.trim());
  const visible = panel.opacity > 0;

  // Nothing to separate and no plate wanted: render the words as they are.
  if (!visible && blocks.length <= 1) return <>{blocks[0] ?? ""}</>;

  return (
    <span
      style={{
        display: "flex",
        flexDirection: "column",
        gap: `${panel.gap}em`,
        alignItems: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
        maxWidth: "100%",
      }}
    >
      {blocks.map((block, index) => (
        <span
          key={index}
          style={{
            display: "block",
            maxWidth: "100%",
            // Flex items refuse to shrink below their content width unless
            // this is cleared, which would push a long line past the box.
            minWidth: 0,
            background: visible ? hexToRgba(panel.color, panel.opacity) : undefined,
            padding: visible ? `${panel.padding}em ${panel.padding * 1.4}em` : undefined,
            borderRadius: visible ? `${panel.radius}em` : undefined,
          }}
        >
          {block}
        </span>
      ))}
    </span>
  );
}

/**
 * A clip, following the console's transport.
 *
 * Position arrives as an anchor rather than a stream of updates, so this works
 * out where it ought to be and nudges the element only when it has drifted —
 * setting `currentTime` on every message would stutter the picture.
 */
function VideoClip({
  url,
  playback,
  style,
  silent,
}: {
  url: string;
  playback: Playback | null;
  style: React.CSSProperties;
  silent?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const deviceId = useAudioDevice();

  useEffect(() => {
    const node = ref.current;
    if (!node || !playback) return;

    // The element's own length, so a looping clip resyncs to a point inside
    // itself rather than to however long it has been going round.
    const length = Number.isFinite(node.duration) ? node.duration * 1000 : 0;
    const wanted = playbackPosition(playback, Date.now(), length) / 1000;
    // A third of a second: below what anyone can see, above the jitter of
    // decoding and of the two clocks involved.
    if (Math.abs(node.currentTime - wanted) > 0.34) node.currentTime = wanted;
    // Muting is left to the `muted` prop below. Writing it here as well meant
    // two owners for one property: React re-applied its value on every render
    // — and Stage re-renders constantly, the timer alone ticking it — so the
    // console's mute button went dead on the screen a moment after each press.
    node.loop = playback.looping;
    if (playback.playing) {
      // Never swallowed. A refused `play()` is the only account we get of why
      // a screen is showing a still frame — the autoplay policy, a decode
      // failure and a stalled network all land here and look identical from
      // the outside. Discarding it cost a long hunt through causes that were
      // never the problem.
      void node.play().catch((error: unknown) => {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn(
          `[stage] play() refused: ${reason} · muted=${node.muted} readyState=${node.readyState}` +
            ` networkState=${node.networkState} currentTime=${node.currentTime.toFixed(2)}` +
            ` duration=${Number.isFinite(node.duration) ? node.duration.toFixed(2) : "?"}`,
        );
      });
    }
    else node.pause();
  }, [playback?.revision, playback?.playing, playback?.looping, url]);

  useEffect(() => {
    applySink(ref.current, deviceId);
  }, [deviceId, url]);

  return (
    <video
      ref={ref}
      key={url}
      src={url}
      style={{ ...style, objectFit: "contain", background: "#000" }}
      autoPlay
      playsInline
      controls={false}
      // The only place muting is decided: a surface marked silent, or one with
      // no transport to follow at all, never sounds. Everything else takes the
      // room's own setting.
      muted={silent || !playback || playback.muted}
    />
  );
}

/**
 * A YouTube embed, driven by `postMessage`.
 *
 * Google's player is only controllable through its iframe API. Posting the
 * commands directly gets play, pause, seek and mute without pulling in their
 * script — which the content policy would have to be widened for — but the
 * player's own position never comes back, so the console offers no scrub bar.
 */
function YoutubeClip({
  id,
  playback,
  style,
}: {
  id: string;
  playback: Playback | null;
  style: React.CSSProperties;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // The privacy-preserving host, with the chrome turned down as far as the
  // embed API allows. This is the one thing in the app that needs network.
  const source =
    `https://www.youtube-nocookie.com/embed/${id}` +
    `?autoplay=1&controls=0&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3` +
    `&enablejsapi=1&loop=${playback?.looping ? 1 : 0}&playlist=${id}`;

  useEffect(() => {
    if (!playback) return;
    const frame = ref.current;
    youtubeCommand(frame, playback.playing ? "playVideo" : "pauseVideo");
    youtubeCommand(frame, playback.muted ? "mute" : "unMute");
    youtubeCommand(frame, "seekTo", [playbackPosition(playback, Date.now()) / 1000, true]);
  }, [playback?.revision]);

  return (
    <iframe ref={ref} src={source} style={style} allow="autoplay; encrypted-media" title="" />
  );
}

/** The output device chosen in Settings, for windows that have the store, and
 *  the system default for the browser screens that do not. */
function useAudioDevice(): string {
  const [deviceId, setDeviceId] = useState("");
  useEffect(() => {
    let cancelled = false;
    const apply = (settings: Settings) => !cancelled && setDeviceId(settings.audioDeviceId ?? "");
    if (IS_TAURI) {
      void api.getSettings().then(apply).catch(() => {});
      const off = on<Settings>(EVENT.settings, apply);
      return () => {
        cancelled = true;
        void off.then((stop) => stop());
      };
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return deviceId;
}

function BackgroundMedia({
  media: filename,
  fit,
  dim,
}: {
  media: string | null;
  fit: BackgroundFit;
  dim: number;
}) {
  const media = useBackgroundMedia(filename);
  // Checked after the hook, never before it: a conditional return above a hook
  // would change the order React sees between renders.
  const camera = isCameraBackground(filename);
  if (!media && !camera) return null;

  const fill: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: fit,
  };

  // A live camera behind the words. Dimmed by the same overlay a picture uses,
  // which matters more here than there — lyrics over a moving, unpredictably
  // lit picture need the help.
  if (camera) {
    return (
      <>
        <CameraFeed deviceId={cameraDeviceOf(filename ?? "")} style={fill} />
        {dim > 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `rgba(0, 0, 0, ${Math.min(100, Math.max(0, dim)) / 100})`,
            }}
          />
        )}
      </>
    );
  }

  // Only a file background can reach here; the camera branch has returned.
  if (!media) return null;

  // Dimming is a black overlay rather than a CSS `filter` on the media itself.
  // A filter promotes the element to its own compositing layer, which WebKit
  // can rasterise as blank for images served over a custom scheme — and on a
  // video it would push every frame through an extra pass for no reason.
  const shade = Math.min(100, Math.max(0, Number(dim) || 0)) / 100;

  return (
    <>
      {media.kind === "video" ? (
        <video
          // `key` forces a fresh element when the file changes, so the new clip
          // actually starts rather than the old one continuing.
          key={media.url}
          src={media.url}
          style={fill}
          autoPlay
          loop
          muted
          playsInline
          // Audio would be a surprise on a projector, and browsers block
          // autoplay outright unless the video is muted.
          disablePictureInPicture
        />
      ) : (
        <img key={media.url} src={media.url} style={fill} alt="" draggable={false} />
      )}
      {shade > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `rgba(0, 0, 0, ${shade})`,
            pointerEvents: "none",
          }}
        />
      )}
    </>
  );
}

/** A presentation slide, a local clip, or the YouTube player. */
/**
 * A camera on this machine, opened by whichever surface is drawing it.
 *
 * The picture is never sent anywhere: the console tells the screens *which*
 * camera, and each screen asks the operating system for it directly. That is
 * why this only works on windows running on the machine the camera is plugged
 * into — a browser on a tablet has no route to it and says so instead.
 *
 * The stream is stopped on unmount without fail. A camera left open keeps its
 * light on and holds the device against every other program on the machine,
 * which on a Sunday morning is somebody else's stream that will not start.
 */
function CameraFeed({
  deviceId,
  style,
  silent,
}: {
  deviceId: string | null;
  style: React.CSSProperties;
  silent?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    void (async () => {
      try {
        // An exact device id would fail outright if that camera has been
        // unplugged since it was chosen; asking for it as a preference falls
        // back to whatever is there, which is what a service needs.
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { ideal: deviceId } } : true,
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setFailed(null);
        if (ref.current) {
          ref.current.srcObject = stream;
          await ref.current.play().catch(() => {});
        }
      } catch (error) {
        // Denied, in use by something else, or simply not there. Said plainly
        // rather than left as a black rectangle nobody can explain.
        if (!cancelled) {
          setFailed(error instanceof Error ? error.name : "error");
        }
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (ref.current) ref.current.srcObject = null;
    };
  }, [deviceId]);

  if (failed) {
    return (
      <div
        style={{
          ...style,
          display: "grid",
          placeItems: "center",
          background: "#000",
          color: "#8b93a1",
          fontSize: "1.6vw",
          textAlign: "center",
          padding: "2vw",
        }}
      >
        {IS_TAURI ? `Camera unavailable (${failed})` : "A web screen cannot show this machine's camera"}
      </div>
    );
  }

  return (
    <video
      ref={ref}
      style={{ ...style, objectFit: "cover", background: "#000" }}
      autoPlay
      playsInline
      // Never any sound from a camera: the room already has the real thing,
      // and an open microphone next to a PA system is feedback.
      muted
      data-silent={silent || undefined}
    />
  );
}

function LiveMedia({
  live,
  playback,
  silent,
}: {
  live: LiveState;
  playback: Playback | null;
  silent: boolean;
}) {
  const fill: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    border: 0,
  };

  if (live.kind === "camera") {
    return <CameraFeed deviceId={live.cameraDeviceId} style={fill} silent={silent} />;
  }

  if (live.youtubeId) {
    return <YoutubeClip id={live.youtubeId} playback={playback} style={fill} />;
  }

  if (!live.mediaPath) return null;
  const url = mediaSrc(live.mediaPath);

  if (live.kind === "video") {
    return <VideoClip url={url} playback={playback} style={fill} silent={silent} />;
  }
  return (
    <img
      key={url}
      src={url}
      alt=""
      draggable={false}
      style={{ ...fill, objectFit: "contain" }}
    />
  );
}

function TimerElement({
  element,
  timer,
  height,
}: {
  element: LayoutElement;
  timer?: Timer | null;
  /** How the clip on screen should be playing. */
  playback?: Playback | null;
  height: number;
}) {
  const text = useTimerText(timer ?? null);
  // Ticks alongside the text so the colour changes at the same moment.
  const now = useNow(!!timer?.running);
  if (!text) return null;
  const label = timer?.label?.trim();
  return (
    <StageElement
      element={element}
      text={label ? `${label}\n${text}` : text}
      height={height}
      color={timer ? timerColor(timer, now) : null}
      // The caption sits above the digits on purpose, so this one keeps its
      // line break whatever the preset says.
      collapse={false}
    />
  );
}

export function visibleElements(layout: Layout): LayoutElement[] {
  return layout.elements.filter((element) => element.visible);
}

function backgroundOf(preset: Preset, blank: boolean): string {
  // A pinned background stays put even when blanked — a video switcher is
  // keying on that colour and must not see it change.
  if (preset.constantBackground) return preset.background;
  return blank ? preset.passiveBackground : preset.background;
}

function contentOf(id: ElementId, live: LiveState): string {
  switch (id) {
    case "body":
      return live.bodyPart;
    case "nextUp":
      return live.nextUp;
    case "title":
      return live.title;
    case "number":
      return live.number;
    case "sectionLabel":
      return live.sectionLabel;
    case "reference":
      return live.reference;
    case "translation":
      return live.translation;
    case "timer":
      // Drawn by TimerElement, which ticks on its own clock.
      return "";
  }
}

/**
 * Shadow offsets and blur scale with the screen, so a look tuned on a 1080p
 * preview survives being sent to a 4K projector. v1 stored raw pixels.
 */
function textShadow(shadow: Shadow, height: number): string | undefined {
  if (!shadow.enabled) return undefined;
  const unit = height / 1080;
  const rgba = hexToRgba(shadow.color, shadow.opacity);
  return `${shadow.offsetX * unit}px ${shadow.offsetY * unit}px ${shadow.blur * unit}px ${rgba}`;
}

function hexToRgba(color: string, opacity: number): string {
  const match = /^#?([\da-f]{6})$/i.exec(color.trim());
  if (!match?.[1]) return color;
  const value = parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}
