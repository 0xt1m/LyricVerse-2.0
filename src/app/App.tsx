import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStore, type Tab } from "./store";
import { BibleTab } from "../components/BibleTab";
import { DisplaysTab } from "../components/DisplaysTab";
import { PresentationsTab } from "../components/PresentationsTab";
import { SettingsTab } from "../components/SettingsTab";
import { SongsTab } from "../components/SongsTab";
import { TimerTab } from "../components/TimerTab";
import { VideoTab } from "../components/VideoTab";
import { AudioTab } from "../components/AudioTab";
import { AudioEngine } from "../components/AudioEngine";
import { ScreenPreview } from "../components/Preview";
import { SidePanel } from "../components/SidePanel";
import { screenName } from "../lib/screens";
import { mediaSrc } from "../api/net";
import { formatTime, percent, playbackPosition, useScrub } from "../lib/playback";
import { Icon, type IconName } from "../components/ui/Icon";
import { useContextMenu } from "../components/ui/ContextMenu";
import {
  formatClock,
  formatDuration,
  newTimer,
  parseDuration,
  pauseTimer,
  resetTimer,
  startTimer,
  timerColor,
  timerValue,
  useNow,
} from "../lib/timer";

/** Content the operator drives during a service. */
const CONTENT_TABS: { id: Tab; icon: IconName; key: string }[] = [
  { id: "songs", icon: "music", key: "tab.songs" },
  { id: "bible", icon: "book", key: "tab.bible" },
  { id: "presentations", icon: "image", key: "tab.presentations" },
  { id: "video", icon: "play", key: "tab.video" },
  { id: "audio", icon: "music", key: "tab.audio" },
  { id: "timer", icon: "clock", key: "tab.timer" },
];

/** Set up once and left alone — kept apart, at the foot of the rail. */
const SETUP_TABS: { id: Tab; icon: IconName; key: string }[] = [
  { id: "displays", icon: "monitor", key: "tab.displays" },
  { id: "settings", icon: "settings", key: "tab.settings" },
];

const TABS = [...CONTENT_TABS, ...SETUP_TABS];

export function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const init = useStore((s) => s.init);
  const tab = useStore((s) => s.tab);
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    void init();
  }, [init]);

  useGlobalShortcuts();

  if (!ready) {
    return <div className="empty" style={{ height: "100%", alignContent: "center" }}>…</div>;
  }

  if (bootError) {
    return (
      <div className="empty" style={{ height: "100%", alignContent: "center" }}>
        <div className="empty__title">LyricVerse could not start</div>
        <div style={{ maxWidth: 520 }}>{bootError}</div>
      </div>
    );
  }

  // The side panel is for driving a service. Wiring up a projector or working
  // through the settings is not that, and both of those tabs would rather have
  // the room.
  const onContentTab = CONTENT_TABS.some((entry) => entry.id === tab);
  const sidePanel = settings.showSidePanel && onContentTab;
  const bottomDock = settings.sidePanelPlacement === "bottom";

  // Rows are built from what is actually shown, so a hidden section gives its
  // height back to the tab rather than leaving a gap behind. The foot is only
  // as tall as what is left in it: a strip on its own needs no room for a
  // preview card.
  const foot = settings.showPreview
    ? "var(--footer-h)"
    : settings.showFilmstrip
      ? "var(--strip-h)"
      : null;
  const rows = ["var(--header-h)", settings.showStatusBar ? "var(--status-h)" : null, "1fr", foot]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="app"
      // The foot's real height, published for anything that has to sit clear
      // of it — the toasts do, and only the shell knows whether the row was
      // built at all.
      style={{ gridTemplateRows: rows, "--foot-h": foot ?? "0px" } as CSSProperties}
    >
      <TopBar />
      {settings.showStatusBar && <StatusBar />}
      <div
        className="app__body"
        data-side={sidePanel ? (bottomDock ? "bottom" : "right") : undefined}
        // The dragged size, per edge. Only the docked one is published, so a
        // half-finished drag on one edge cannot resize the other.
        style={
          {
            [bottomDock ? "--side-h" : "--side-w"]: `${
              bottomDock ? settings.sidePanelHeight : settings.sidePanelWidth
            }px`,
          } as CSSProperties
        }
      >
        <Rail />
        {tab === "songs" && <SongsTab />}
        {tab === "bible" && <BibleTab />}
        {tab === "presentations" && <PresentationsTab />}
        {tab === "video" && <VideoTab />}
        {tab === "audio" && <AudioTab />}
        {tab === "timer" && <TimerTab />}
        {tab === "displays" && <DisplaysTab />}
        {tab === "settings" && <SettingsTab />}
        {sidePanel && <SidePanel />}
      </div>
      {foot && <Transport />}
      {/* No UI of its own: the player that keeps going between tabs. */}
      <AudioEngine />
      <Toasts />
    </div>
  );
}

function TopBar() {
  const t = useStore((s) => s.t);
  const version = useStore((s) => s.version);
  const displays = useStore((s) => s.displays);
  const settings = useStore((s) => s.settings);
  const setTab = useStore((s) => s.setTab);
  const patchDisplay = useStore((s) => s.patchDisplay);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark">
          <Icon name="music" size={13} />
        </span>
        LyricVerse
        <span className="topbar__version">{version}</span>
      </div>
      <ViewMenu />
      <div className="topbar__spacer" />
      <MediaControl />
      <TimerControl />
      <div className="topbar__spacer" />
      {displays.map((display) => {
        const config = settings.displays[display.id];
        if (!config) return null;
        // The console's own screen is shown for orientation but cannot be
        // toggled — output never goes there.
        const name = screenName(settings.displays, display);
        if (display.isPrimary) {
          return (
            <button
              key={display.id}
              className="chip"
              style={{ opacity: 0.55, cursor: "default" }}
              title={`${name} — ${t("displays.primaryLocked")}`}
              onClick={() => setTab("displays")}
            >
              <span className="chip__dot" />
              {display.index + 1} · {t("displays.primary")}
            </button>
          );
        }
        return (
          <button
            key={display.id}
            className="chip"
            data-active={config.enabled}
            title={`${name} · ${display.width}×${display.height}`}
            onDoubleClick={() => setTab("displays")}
            onClick={() => void patchDisplay(display.id, { enabled: !config.enabled })}
          >
            <span className="chip__dot" />
            {display.index + 1}
            {config.enabled ? ` · ${presetName(settings, config.preset)}` : ""}
          </button>
        );
      })}
    </header>
  );
}

/**
 * Which parts of the window are on show.
 *
 * A projectionist working on a laptop wants the tab itself as tall as it will
 * go; one at a desk wants the preview visible at all times. Neither is right
 * for everyone, so both are a tick away and the choice is remembered.
 */
function ViewMenu() {
  const t = useStore((s) => s.t);
  const settings = useStore((s) => s.settings);
  const patchSettings = useStore((s) => s.patchSettings);
  const openMenu = useContextMenu();

  return (
    <button
      className="btn btn--sm"
      title={t("view.hint")}
      onClick={(event) =>
        openMenu(event, [
          {
            label: t("view.statusBar"),
            checked: settings.showStatusBar,
            onSelect: () => void patchSettings({ showStatusBar: !settings.showStatusBar }),
          },
          {
            label: t("view.preview"),
            checked: settings.showPreview,
            onSelect: () => void patchSettings({ showPreview: !settings.showPreview }),
          },
          {
            label: t("view.filmstrip"),
            checked: settings.showFilmstrip,
            onSelect: () => void patchSettings({ showFilmstrip: !settings.showFilmstrip }),
          },
          {
            label: t("view.sidePanel"),
            checked: settings.showSidePanel,
            onSelect: () => void patchSettings({ showSidePanel: !settings.showSidePanel }),
          },
          // Which edge it docks to. Ticks rather than a submenu, and picking
          // the one already set is a no-op — this is a choice between two
          // places, not a third switch that can turn the panel off.
          {
            label: t("view.sidePanelRight"),
            checked: settings.sidePanelPlacement !== "bottom",
            onSelect: () => void patchSettings({ sidePanelPlacement: "right" }),
          },
          {
            label: t("view.sidePanelBottom"),
            checked: settings.sidePanelPlacement === "bottom",
            onSelect: () => void patchSettings({ sidePanelPlacement: "bottom" }),
          },
        ])
      }
    >
      <Icon name="eye" size={13} />
      {t("view.title")}
    </button>
  );
}

/**
 * Video and audio transport, reachable from every tab.
 *
 * A clip or a track is usually running while the operator is somewhere else
 * entirely — lining up the next song, finding a reading — and "stop the music"
 * has to be one press away from wherever that is. Each half appears only when
 * there is something for it to control.
 */
function MediaControl() {
  return (
    <>
      <VideoTransport />
      <AudioTransport />
    </>
  );
}

function VideoTransport() {
  const t = useStore((s) => s.t);
  const live = useStore((s) => s.live);
  const playback = useStore((s) => s.playback);
  const patchPlayback = useStore((s) => s.patchPlayback);
  const blank = useStore((s) => s.toggleBlank);
  const isVideo = live.kind === "video";
  const now = useNow(isVideo && playback.playing);
  const [duration, setDuration] = useState(0);
  // `duration` feeds the position so a looping clip's readout wraps with the
  // clip instead of counting on past its own end.
  const scrub = useScrub(playbackPosition(playback, now, duration), (positionMs) =>
    void patchPlayback({}, positionMs),
  );

  // The clip's length is a property of the file, so it is read here rather
  // than asked of a projection window that may not even be open.
  useEffect(() => {
    setDuration(0);
    if (!isVideo || !live.mediaPath) return;
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = mediaSrc(live.mediaPath);
    const onMeta = () => {
      if (Number.isFinite(probe.duration)) setDuration(probe.duration * 1000);
    };
    probe.addEventListener("loadedmetadata", onMeta);
    return () => {
      probe.removeEventListener("loadedmetadata", onMeta);
      probe.src = "";
    };
  }, [isVideo, live.mediaPath]);

  if (!isVideo) return null;
  const position = playbackPosition(playback, now, duration);
  // YouTube plays inside Google's own player, which does not report where it
  // is without loading their script — so that one gets the buttons, not a bar.
  const scrubbable = duration > 0 && !live.youtubeId;

  // A clip that has run out is still `playing` as far as the transport state
  // knows — nothing sends a message back when it reaches the end. So the end
  // is worked out here, or the button would offer to pause a clip that has
  // been sitting on its last frame for a minute.
  const ended = duration > 0 && !playback.looping && position >= duration;
  const running = playback.playing && !ended;

  return (
    <div className="timerbar">
      <button
        className="btn btn--sm btn--icon"
        title={running ? t("media.pause") : t("media.play")}
        // Pressing play on a finished clip starts it again from the top, which
        // is the only thing that press could sensibly mean.
        onClick={() => void patchPlayback({ playing: !running }, ended ? 0 : undefined)}
      >
        <Icon name={running ? "pause" : "play"} size={13} />
      </button>

      {scrubbable ? (
        <>
          <input
            className="scrub timerbar__scrub"
            type="range"
            min={0}
            max={Math.round(duration)}
            value={Math.min(Math.round(scrub.value), Math.round(duration))}
            style={{ "--played": `${percent(scrub.value, duration)}%` } as CSSProperties}
            onChange={(event) => scrub.onChange(Number(event.target.value))}
            onKeyUp={scrub.onKeyUp}
          />
          <span className="timerbar__value" style={{ fontSize: 12 }}>
            {formatTime(scrub.value)} / {formatTime(duration)}
          </span>
        </>
      ) : (
        <span className="timerbar__value" style={{ fontSize: 12 }}>
          {live.youtubeId ? "YouTube" : formatTime(position)}
        </span>
      )}

      <button
        className={playback.looping ? "btn btn--sm btn--icon btn--primary" : "btn btn--sm btn--icon"}
        title={t("media.loop")}
        onClick={() => void patchPlayback({ looping: !playback.looping })}
      >
        <Icon name="repeat" size={12} />
      </button>
      <button
        className={playback.muted ? "btn btn--sm btn--icon btn--primary" : "btn btn--sm btn--icon"}
        title={t("media.mute")}
        onClick={() => void patchPlayback({ muted: !playback.muted })}
      >
        <Icon name={playback.muted ? "volumeOff" : "volume"} size={12} />
      </button>
      {/* The same cross the audio transport ends with, and the same meaning:
          done with this, take it away. For a clip that is the screen going
          blank — pausing would leave the last frame standing in the room. */}
      <button className="btn btn--sm btn--icon" title={t("media.stop")} onClick={() => void blank()}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/**
 * Audio in the title bar.
 *
 * Several tracks can be sounding at once, and a row of full transports would
 * take the whole bar — so this shows the one most recently started, says how
 * many others are behind it, and its stop button stops the lot. Riding levels
 * against each other is the mixer's job, on the tab; this is the panic button
 * and the glance.
 */
function AudioTransport() {
  const t = useStore((s) => s.t);
  const setTab = useStore((s) => s.setTab);
  const players = useStore((s) => s.audioPlayers);
  const toggleTrack = useStore((s) => s.toggleTrack);
  const stopAllAudio = useStore((s) => s.stopAllAudio);
  const seekTrack = useStore((s) => s.seekTrack);
  const newest = players[players.length - 1] ?? null;
  const scrub = useScrub(newest?.positionMs ?? 0, (ms) => {
    if (newest) seekTrack(newest.track.id, ms);
  });

  if (!newest) return null;
  const durationMs = newest.durationMs;

  return (
    <div className="timerbar">
      <button
        className="btn btn--sm btn--icon"
        title={newest.playing ? t("audio.pause") : t("audio.play")}
        onClick={() => toggleTrack(newest.track.id)}
      >
        <Icon name={newest.playing ? "pause" : "play"} size={13} />
      </button>
      <button
        className="timerbar__label"
        title={newest.track.name}
        onClick={() => setTab("audio")}
        style={{ all: "unset", cursor: "pointer", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}
      >
        {newest.track.name}
      </button>
      {/* Only when there is something hidden behind it — a lone track needs no
          count, and the bar is short of room as it is. */}
      {players.length > 1 && (
        <button
          className="chip"
          title={t("audio.mixer")}
          onClick={() => setTab("audio")}
          style={{ fontSize: 11 }}
        >
          +{players.length - 1}
        </button>
      )}
      {durationMs > 0 && (
        <input
          className="scrub timerbar__scrub"
          type="range"
          min={0}
          max={Math.round(durationMs)}
          value={Math.min(Math.round(scrub.value), Math.round(durationMs))}
          style={{ "--played": `${percent(scrub.value, durationMs)}%` } as CSSProperties}
          onChange={(event) => scrub.onChange(Number(event.target.value))}
          onKeyUp={scrub.onKeyUp}
        />
      )}
      <span className="timerbar__value" style={{ fontSize: 12 }}>
        {formatTime(scrub.value)}
      </span>
      <button
        className="btn btn--sm btn--icon"
        title={players.length > 1 ? t("audio.stopAll") : t("audio.stop")}
        onClick={stopAllAudio}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/**
 * The timer, reachable from every tab.
 *
 * A countdown to the start of the service is usually running while the
 * operator is somewhere else entirely, so it belongs in the chrome rather
 * than only on its own tab.
 */
function TimerControl() {
  const t = useStore((s) => s.t);
  const timer = useStore((s) => s.timer);
  const updateTimer = useStore((s) => s.updateTimer);
  const setTab = useStore((s) => s.setTab);

  const now = useNow(!!timer?.running || timer?.mode === "clock");
  const [draft, setDraft] = useState<string | null>(null);

  /**
   * Re-arms the countdown at a new length. A running timer keeps running from
   * the new value — changing the duration mid-countdown means "make it this
   * long", not "stop".
   */
  const applyDuration = (seconds: number) => {
    if (!timer) return;
    const rearmed = resetTimer(timer, seconds);
    void updateTimer(timer.running ? startTimer(rearmed) : rearmed);
  };

  if (!timer) {
    return (
      <button
        className="btn btn--sm"
        title={t("timer.createHint")}
        onClick={() => void updateTimer(newTimer("countdown", 5 * 60))}
      >
        <Icon name="clock" size={13} />
        {t("tab.timer")}
      </button>
    );
  }

  const value = timerValue(timer, now);
  const isClock = timer.mode === "clock";

  return (
    <div className="timerbar">
      {draft !== null && !isClock ? (
        <input
          className="input timerbar__input"
          value={draft}
          autoFocus
          spellCheck={false}
          placeholder="5:00"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(null);
              return;
            }
            if (event.key !== "Enter") return;
            const seconds = parseDuration(draft);
            if (seconds !== null) applyDuration(seconds);
            setDraft(null);
          }}
        />
      ) : (
        <button
          className="timerbar__readout"
          data-running={timer.running || undefined}
          // The operator sees exactly the colour the room sees.
          style={{ color: timerColor(timer, now) ?? undefined }}
          title={isClock ? t("timer.openTab") : t("timer.setHint")}
          onClick={() => {
            // A clock has no length to set, so it just opens the tab.
            if (isClock) setTab("timer");
            else setDraft(formatDuration(timer.durationMs));
          }}
        >
          {isClock ? formatClock(now) : formatDuration(value)}
        </button>
      )}

      {!isClock && (
        <>
          <button
            className="btn btn--sm btn--icon"
            title={timer.running ? t("timer.pause") : t("timer.start")}
            onClick={() => void updateTimer(timer.running ? pauseTimer(timer) : startTimer(timer))}
          >
            <Icon name={timer.running ? "pause" : "play"} size={12} />
          </button>
          <button
            className="btn btn--sm btn--icon"
            title={t("common.reset")}
            onClick={() => void updateTimer(resetTimer(timer))}
          >
            <Icon name="refresh" size={12} />
          </button>
        </>
      )}
      <button
        className="btn btn--sm btn--icon"
        title={t("timer.openTab")}
        onClick={() => setTab("timer")}
      >
        <Icon name="settings" size={12} />
      </button>
      <button
        className="btn btn--sm btn--icon"
        title={t("timer.clear")}
        onClick={() => void updateTimer(null)}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/** Label for a screen's preset, for the top-bar chips. */
function presetName(settings: ReturnType<typeof useStore.getState>["settings"], id: string) {
  return settings.presets.find((preset) => preset.id === id)?.name ?? id;
}

function Rail() {
  const t = useStore((s) => s.t);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);

  const item = (entry: { id: Tab; icon: IconName; key: string }) => (
    <button
      key={entry.id}
      className="rail__item"
      aria-selected={tab === entry.id}
      onClick={() => setTab(entry.id)}
    >
      <Icon name={entry.icon} size={19} />
      <span className="rail__label">{t(entry.key)}</span>
    </button>
  );

  return (
    <nav className="rail">
      {CONTENT_TABS.map(item)}
      <div className="rail__spacer" />
      {SETUP_TABS.map(item)}
    </nav>
  );
}

/**
 * What is on screen, and the controls that change it.
 *
 * Directly under the title bar rather than at the foot: it is the one thing
 * the operator glances at constantly, and it belongs beside the LIVE
 * indicator rather than below the preview.
 */
function StatusBar() {
  const t = useStore((s) => s.t);
  const deck = useStore((s) => s.deck);
  const cursor = useStore((s) => s.cursor);
  const blanked = useStore((s) => s.blanked);
  const live = useStore((s) => s.live);
  const step = useStore((s) => s.step);
  const toggleBlank = useStore((s) => s.toggleBlank);

  const slide = deck?.slides[cursor];
  const onScreen = live.kind !== "blank";

  return (
    <div className="statusbar">
      <span className={onScreen ? "chip chip--live" : "chip"}>
        <span className="chip__dot" />
        {onScreen ? t("transport.live") : t("transport.blank")}
      </span>

      <div className="transport__status">
        <span className="transport__label">{deck?.title ?? ""}</span>
        <span className={onScreen ? "transport__value" : "transport__value transport__value--blank"}>
          {onScreen
            ? live.bodyPart.replace(/\s*\n\s*/g, " · ")
            : t("transport.nothing")}
        </span>
      </div>

      {slide && (
        <span className="field__hint" style={{ whiteSpace: "nowrap" }}>
          {cursor + 1} / {deck!.slides.length}
        </span>
      )}

      <button
        className="btn"
        onClick={() => void step(-1)}
        disabled={!deck || cursor === 0}
        title={t("transport.prev")}
      >
        <Icon name="chevronLeft" />
      </button>
      <button
        className="btn"
        onClick={() => void step(1)}
        disabled={!deck || cursor >= (deck.slides.length ?? 1) - 1}
        title={t("transport.next")}
      >
        <Icon name="chevronRight" />
      </button>
      <button
        className={blanked ? "btn btn--primary" : "btn"}
        onClick={() => void toggleBlank()}
        title={t("shortcut.blank")}
      >
        <Icon name={blanked ? "eye" : "eyeOff"} />
        {blanked ? t("transport.showBtn") : t("transport.blankBtn")}
      </button>
    </div>
  );
}

/** The foot of the window: the live output and the whole deck. Either half can
 *  be put away on its own; with both off the row disappears entirely. */
function Transport() {
  const showPreview = useStore((s) => s.settings.showPreview);
  const showFilmstrip = useStore((s) => s.settings.showFilmstrip);
  return (
    <footer className="transport">
      {showPreview && <TransportPreview />}
      {showFilmstrip && <Filmstrip />}
    </footer>
  );
}

/**
 * What one screen is actually showing, in the chrome.
 *
 * The same `Stage` the projector runs, at the screen's true aspect ratio — so
 * this is the output, not an impression of it. One screen at a time rather
 * than all of them: at this size a row of thumbnails would be unreadable, and
 * the operator is normally watching a single output.
 */
function TransportPreview() {
  const chosen = useStore((s) => s.previewDisplayId);
  const setPreviewDisplay = useStore((s) => s.setPreviewDisplay);
  return (
    <ScreenPreview
      chosen={chosen}
      onPick={setPreviewDisplay}
      className="transport__preview"
    />
  );
}

/**
 * The open deck, end to end, in the chrome.
 *
 * Someone calls an audible — "back to the last chorus" — and the answer should
 * not be "return to the Songs tab and find it". Clicking a tile puts it on
 * screen, from whichever tab the operator happens to be on.
 */
function Filmstrip() {
  const t = useStore((s) => s.t);
  const deck = useStore((s) => s.deck);
  const cursor = useStore((s) => s.cursor);
  const liveIndex = useStore((s) => s.liveIndex);
  const blanked = useStore((s) => s.blanked);
  const go = useStore((s) => s.go);
  const stripRef = useRef<HTMLDivElement>(null);

  // Follows the service: advancing off the end of the visible run scrolls the
  // strip rather than leaving the operator looking at slides already sung.
  useEffect(() => {
    const strip = stripRef.current;
    const target = strip?.children[cursor] as HTMLElement | undefined;
    target?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [cursor, deck?.key]);

  if (!deck || deck.slides.length === 0) {
    return (
      <div className="filmstrip filmstrip--empty">
        <span className="field__hint">{t("transport.noDeck")}</span>
      </div>
    );
  }

  return (
    <div className="filmstrip" ref={stripRef}>
      {deck.slides.map((slide, index) => {
        const isLive = !blanked && liveIndex === index;
        // A clip has a path too, but an <img> cannot show one — so a moving
        // slide gets a play mark rather than a broken thumbnail.
        const kind = slide.liveKind ?? deck.source;
        const thumb = kind === "image" || kind === "message" ? slide.mediaPath : null;
        return (
          <button
            key={slide.id}
            className="filmstrip__tile"
            data-live={isLive || undefined}
            data-selected={cursor === index || undefined}
            title={slide.summary ?? slide.part}
            onClick={() => void go(index)}
          >
            <span className="filmstrip__index">{index + 1}</span>
            {thumb ? (
              <img className="filmstrip__thumb" src={mediaSrc(thumb)} alt="" />
            ) : kind === "video" ? (
              <span className="filmstrip__glyph">
                <Icon name="play" size={18} />
              </span>
            ) : (
              <span className="filmstrip__text">{slide.summary ?? slide.part}</span>
            )}
            <span className="filmstrip__label">{slide.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-tone={toast.tone} onClick={() => dismiss(toast.id)}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

/**
 * Presentation shortcuts. Deliberately inert while a text field has focus, so
 * typing a search query cannot advance the projector mid-service.
 */
function useGlobalShortcuts() {
  const step = useStore((s) => s.step);
  const toggleBlank = useStore((s) => s.toggleBlank);
  const setTab = useStore((s) => s.setTab);
  const toggleAllMedia = useStore((s) => s.toggleAllMedia);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

      if ((event.metaKey || event.ctrlKey) && /^[1-7]$/.test(event.key)) {
        event.preventDefault();
        setTab(TABS[Number(event.key) - 1]?.id ?? "songs");
        return;
      }

      if (event.key === "Escape") {
        if (typing) {
          target?.blur();
          return;
        }
        event.preventDefault();
        void toggleBlank();
        return;
      }

      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        // Space starts and stops whatever is playing — a clip, a track,
        // several tracks — before it does anything else. With no media in
        // hand at all it keeps its usual job of moving the service on, so the
        // key nobody has to look for still advances a song.
        case " ":
          event.preventDefault();
          if (toggleAllMedia()) break;
          void step(1);
          break;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
          event.preventDefault();
          void step(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          void step(-1);
          break;
        case "b":
        case "B":
        case "б":
        case "Б":
          event.preventDefault();
          void toggleBlank();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, toggleBlank, setTab, toggleAllMedia]);
}
