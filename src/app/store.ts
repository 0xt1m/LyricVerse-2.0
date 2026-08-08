import { create } from "zustand";
import { EVENT, api, errorMessage, on } from "../api";
import type {
  Deck,
  Plan,
  PlanEntry,
  Defaults,
  DisplayConfig,
  DisplayInfo,
  LiveState,
  Preset,
  Settings,
  Timer,
  SongbookMeta,
  TranslationMeta,
  Playback,
  Track,
  WebScreenStatus,
} from "../api/types";
import { translate } from "../lib/i18n";
import { slideToLive } from "../lib/deck";
import { stamped } from "../lib/playback";
import { newPlan, planEntryId, resolvePlanEntry } from "../lib/plan";

/** Every translation on screen, not just the main one. */
export function translationLabel(settings: Settings): string {
  return [settings.activeTranslation ?? "", ...settings.secondaryTranslations]
    .filter(Boolean)
    .join(" · ");
}

export type Tab =
  | "songs"
  | "bible"
  | "presentations"
  | "video"
  | "camera"
  | "audio"
  | "timer"
  | "displays"
  | "settings";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
}

/**
 * One track sounding right now.
 *
 * There can be several: a bed of music under a prayer while a sting fires over
 * it is an ordinary thing to want, and v2 could only ever hold one — starting
 * a second silently killed the first. Each has its own element, its own
 * position and its own level.
 */
export interface AudioPlayer {
  track: Track;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  /** 0..1, live. Mirrors `track.volume`, which is where it is persisted. */
  volume: number;
  /** Bumped by `seekTrack`, so the element can tell a scrub from the position
   *  it just reported itself. */
  seekToken: number;
}

/**
 * Something that went to the screens, kept so it can go there again.
 *
 * The deck is held by reference rather than copied: stepping through a song
 * makes one entry per verse, and all of them point at the same deck object, so
 * a long service costs a handful of integers rather than a hundred decks. It
 * is also a snapshot — a song edited after it was sung replays as it was sung,
 * which is what a record of the service should do.
 */
export interface HistoryEntry {
  id: number;
  deck: Deck;
  index: number;
  /** Wall-clock time it went out, for the list's right-hand column. */
  at: number;
}

interface Store {
  ready: boolean;
  bootError: string | null;
  version: string;
  dataDir: string;

  tab: Tab;
  settings: Settings;
  displays: DisplayInfo[];
  webScreens: WebScreenStatus[];
  /** This machine's address on the network, for the URLs shown to operators. */
  lanAddress: string | null;
  live: LiveState;
  songbooks: SongbookMeta[];
  translations: TranslationMeta[];
  toasts: Toast[];
  /** Pristine values from the backend, used by the "reset" buttons. */
  defaults: Defaults | null;
  /** The countdown/clock overlay, independent of what is on screen. */
  timer: Timer | null;
  playback: Playback;

  /**
   * The tracks sounding in this window, in the order they were started.
   *
   * Audio is the one thing that does not go to a screen: the machine running
   * the console is the one plugged into the desk, so it plays here and keeps
   * playing whichever tab the operator moves to.
   */
  audioPlayers: AudioPlayer[];

  /** What the operator has queued, from whichever tab loaded it. */
  deck: Deck | null;
  /** Index the operator has highlighted. Moving it does NOT change the output. */
  cursor: number;
  /** Index actually on screen, or null when nothing from this deck is live. */
  liveIndex: number | null;
  /** Output is hidden but the cursor is remembered, so it can come back. */
  blanked: boolean;
  /** Bumped by the library event so tabs know to reload their lists. */
  libraryRevision: number;
  /** Which screen the side panel's preview shows; null follows the first
   *  enabled one. */
  sidePreviewDisplayId: string | null;
  setSidePreviewDisplay: (id: string | null) => void;

  /**
   * The running order being built, saved or not.
   *
   * Held apart from `plans`, which is what is on disk: a plan is edited freely
   * and only written when the operator says so, the same as any document.
   */
  plan: Plan;
  /** Every saved plan, newest first. */
  plans: Plan[];
  addToPlan: (entry: Omit<PlanEntry, "id">) => void;
  removeFromPlan: (entryId: string) => void;
  movePlanEntry: (from: number, to: number) => void;
  setPlanNote: (entryId: string, note: string) => void;
  /**
   * Opens a plan entry where it lives — the song on the Songs tab, the passage
   * on the Bible tab — with `live` deciding whether it also goes to the
   * screens. Tracks are played rather than shown.
   */
  openPlanEntry: (entryId: string, live?: boolean) => Promise<void>;
  /**
   * What a tab has been asked to select, for the tabs that hold a selection of
   * their own. Cleared by whichever tab takes it.
   */
  openRequest: PlanEntry | null;
  clearOpenRequest: () => void;
  startNewPlan: (name: string) => void;
  renamePlan: (name: string) => void;
  openPlan: (id: string) => void;
  deletePlan: (id: string) => Promise<void>;
  refreshPlans: () => Promise<void>;

  /**
   * A menu action waiting for the Songs tab to carry out.
   *
   * The menu bar cannot open a file picker or know which songbook is open, so
   * a click there arrives here and the tab runs the same code its own buttons
   * do — one implementation, two ways in.
   */
  songCommand: "import" | "exportJson" | "exportTxt" | null;
  clearSongCommand: () => void;

  /** Everything shown this session, newest first. */
  history: HistoryEntry[];
  /** Puts a past slide back on screen, bringing its deck back if it has been
   *  replaced since. */
  replayHistory: (id: number) => Promise<void>;
  clearHistory: () => void;

  t: (key: string, values?: Record<string, string | number>) => string;

  init: () => Promise<void>;
  setTab: (tab: Tab) => void;
  toast: (message: string, tone?: Toast["tone"]) => void;
  dismissToast: (id: number) => void;
  reportError: (error: unknown) => void;

  patchSettings: (patch: Partial<Settings>) => Promise<void>;
  patchDisplay: (id: string, patch: Partial<DisplayConfig>) => Promise<void>;
  addWebScreen: (name: string) => Promise<void>;
  updateWebScreen: (id: string, patch: { name?: string; port?: number }) => Promise<void>;
  removeWebScreen: (id: string) => Promise<void>;
  /** Replaces one preset in place, leaving the rest untouched. */
  patchPreset: (id: string, patch: Partial<Preset>) => Promise<void>;
  setPresets: (presets: Preset[]) => Promise<void>;
  patchPlayback: (patch: Partial<Playback>, positionMs?: number) => Promise<void>;
  /** Starts a track, from the top, alongside anything already sounding. */
  playTrack: (track: Track) => void;
  toggleTrack: (id: string) => void;
  stopTrack: (id: string) => void;
  /** Everything at once — the panic button in the title bar. */
  stopAllAudio: () => void;
  seekTrack: (id: string, ms: number) => void;
  /** Sets a level live and remembers it against the track. */
  setTrackVolume: (id: string, volume: number) => void;
  /** Reported by a track's element as it plays. */
  reportAudio: (id: string, positionMs: number, durationMs: number) => void;
  /**
   * Stops everything sounding or moving — tracks and the clip on screen alike
   * — or sets it all going again if it is already stopped.
   *
   * Returns whether there was anything to act on, so a key bound to this can
   * fall through to its other job when there was not.
   */
  toggleAllMedia: () => boolean;
  updateTimer: (timer: Timer | null) => Promise<void>;
  refreshDisplays: () => Promise<void>;
  refreshLibrary: () => Promise<void>;

  loadDeck: (deck: Deck | null, options?: { goLive?: boolean }) => Promise<void>;
  /** Highlight a slide without sending it to the screens. */
  select: (index: number) => void;
  go: (index: number) => Promise<void>;
  step: (delta: number) => Promise<void>;
  toggleBlank: () => Promise<void>;
}

const EMPTY_SETTINGS: Settings = {
  version: 0,
  language: "en",
  activeSongbook: null,
  activeTranslation: null,
  secondaryTranslations: [],
  blankOnSwitch: false,
  uiScale: 1,
  showStatusBar: true,
  showFilmstrip: true,
  showSidePanel: true,
  sidePanelPlacement: "right",
  sidePanelWidth: 268,
  sidePanelHeight: 208,
  webScreens: [],
  backgroundOrder: [],
  audioDeviceId: "",
  audioVolume: 1,
  favouriteSongs: {},
  favouritesFirst: false,
  songOrder: {},
  presets: [],
  displays: {},
};

/** Nothing playing, and no clip to play. */
const IDLE_PLAYBACK: Playback = {
  playing: false,
  muted: false,
  looping: false,
  positionMs: 0,
  anchorMs: 0,
  revision: 0,
};

const EMPTY_LIVE: LiveState = {
  kind: "blank",
  bodyPart: "",
  title: "",
  number: "",
  sectionLabel: "",
  reference: "",
  translation: "",
  nextUp: "",
  nextMediaPath: null,
  sectionKind: "",
  mediaPath: null,
  youtubeId: null,
  cameraDeviceId: null,
  revision: 0,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// --- Debounced track levels -------------------------------------------------
// Riding a fader writes the manifest once the hand stops, not sixty times a
// second on the way there. Keyed by track, so two faders moved together each
// land their own final value.

const VOLUME_SAVE_MS = 260;
const volumeTimers = new Map<string, number>();

function scheduleVolumeSave(id: string, volume: number, get: () => Store) {
  const pending = volumeTimers.get(id);
  if (pending !== undefined) window.clearTimeout(pending);
  volumeTimers.set(
    id,
    window.setTimeout(() => {
      volumeTimers.delete(id);
      api.setTrackVolume(id, volume).catch((error) => get().reportError(error));
    }, VOLUME_SAVE_MS),
  );
}

/** Which tab each kind of plan entry belongs to. */
const TAB_FOR_PLAN: Record<PlanEntry["kind"], Tab> = {
  song: "songs",
  bible: "bible",
  presentation: "presentations",
  video: "video",
  audio: "audio",
};

// --- Plan autosave ----------------------------------------------------------
// A running order is worked on continuously — dragging a song up, adding one
// more, typing a note — and asking someone to remember to save it is asking
// them to lose it. Written shortly after the last change instead.

const PLAN_SAVE_MS = 600;
let planTimer: number | undefined;

/** A plan with no name yet is called after the day it was made. */
function planName(plan: Plan, get: () => Store): string {
  const named = plan.name.trim();
  if (named) return named;
  return get().t("plan.defaultName", { date: new Date().toLocaleDateString() });
}

async function writePlan(get: () => Store) {
  const plan = useStore.getState().plan;
  // An empty, unnamed plan is not a document yet — saving it would litter the
  // list with blanks every time somebody pressed "new".
  if (plan.entries.length === 0 && !plan.name.trim()) return;
  try {
    const saved = await api.savePlan({ ...plan, name: planName(plan, get) });
    // Only the identity and name are taken back: the entries may have moved on
    // while this was in flight, and the operator's list must not snap back.
    useStore.setState((state) =>
      state.plan.id === saved.id
        ? { plan: { ...state.plan, name: saved.name, updatedMs: saved.updatedMs } }
        : {},
    );
    await get().refreshPlans();
  } catch (error) {
    get().reportError(error);
  }
}

function schedulePlanSave(get: () => Store) {
  if (planTimer !== undefined) window.clearTimeout(planTimer);
  planTimer = window.setTimeout(() => {
    planTimer = undefined;
    void writePlan(get);
  }, PLAN_SAVE_MS);
}

/** Persist now — used when the plan being edited is about to be replaced. */
function flushPlan(get: () => Store) {
  if (planTimer !== undefined) {
    window.clearTimeout(planTimer);
    planTimer = undefined;
  }
  void writePlan(get);
}

let toastSeq = 0;

// --- Show history ----------------------------------------------------------

let historySeq = 0;

/** Long enough to cover any service, short enough never to be thought about. */
const HISTORY_LIMIT = 250;

/**
 * Records what has just gone out.
 *
 * Called from `go` once the screens have taken it, so a failed send leaves no
 * trace of something the room never saw.
 */
function remember(deck: Deck, index: number) {
  useStore.setState((state) => {
    const newest = state.history[0];
    // Showing again what is already at the top — coming back from a blank, or
    // a second press on the slide already up — is not a new event.
    if (newest && newest.deck.key === deck.key && newest.index === index) return {};
    const entry: HistoryEntry = { id: ++historySeq, deck, index, at: Date.now() };
    return { history: [entry, ...state.history].slice(0, HISTORY_LIMIT) };
  });
}

// --- Debounced settings persistence ---------------------------------------
// Writing on every pointer-move would mean ~60 disk writes and 60 window
// reconciliations a second while a layout box is being dragged. The UI state
// is already updated optimistically, so only the trip to disk is delayed.

const SAVE_DELAY_MS = 140;
let saveTimer: number | undefined;
let pending: Settings | null = null;
let saveSeq = 0;

function scheduleSave(next: Settings, get: () => Store) {
  pending = next;
  const mine = ++saveSeq;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(mine, get), SAVE_DELAY_MS);
}

async function flushSave(seq: number, get: () => Store) {
  const payload = pending;
  saveTimer = undefined;
  if (!payload) return;
  try {
    const saved = await api.saveSettings(payload);
    // A newer edit landed while this was in flight; keep the local value or
    // the operator's drag would snap backwards.
    if (seq === saveSeq) {
      pending = null;
      useStore.setState({ settings: saved });
    }
  } catch (error) {
    get().reportError(error);
  }
}

/** Persist immediately — used when the window is going away. */
export function flushSettings() {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (pending) void api.saveSettings(pending).catch(() => {});
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  bootError: null,
  version: "",
  dataDir: "",

  tab: "songs",
  settings: EMPTY_SETTINGS,
  displays: [],
  webScreens: [],
  lanAddress: null,
  live: EMPTY_LIVE,
  songbooks: [],
  translations: [],
  toasts: [],
  defaults: null,
  timer: null,
  playback: IDLE_PLAYBACK,
  audioPlayers: [],

  deck: null,
  cursor: 0,
  liveIndex: null,
  blanked: false,
  libraryRevision: 0,
  plan: newPlan(""),
  plans: [],
  openRequest: null,
  songCommand: null,
  sidePreviewDisplayId: null,
  history: [],

  t: (key, values) => translate(get().settings.language, key, values),

  async init() {
    try {
      const boot = await api.bootstrap();
      set({
        ready: true,
        bootError: null,
        version: boot.version,
        dataDir: boot.dataDir,
        settings: boot.settings,
        displays: boot.displays,
        webScreens: boot.webScreens,
        live: boot.live,
        songbooks: boot.songbooks,
        translations: boot.translations,
        defaults: boot.defaults,
        timer: boot.timer,
        playback: boot.playback,
        blanked: boot.live.kind === "blank",
      });
    } catch (error) {
      set({ ready: true, bootError: errorMessage(error) });
      return;
    }

    // After the console is up, not before: working this out opens a socket,
    // and on Windows that can sit behind a firewall prompt. Only the Displays
    // tab wants it, and it can manage without it until it arrives.
    void api
      .lanAddress()
      .then((lanAddress) => set({ lanAddress }))
      .catch(() => {});

    void on<LiveState>(EVENT.live, (live) => set({ live }));
    void on<Timer | null>(EVENT.timer, (timer) => set({ timer }));
    void on<Playback>(EVENT.playback, (playback) => set({ playback }));
    void on<Settings>(EVENT.settings, (settings) => set({ settings }));
    void on<DisplayInfo[]>(EVENT.displays, (displays) => set({ displays }));
    void on<WebScreenStatus[]>(EVENT.webScreens, (webScreens) => set({ webScreens }));
    void on(EVENT.library, () => {
      set((state) => ({ libraryRevision: state.libraryRevision + 1 }));
      void get().refreshLibrary();
    });

    // Menu actions the window has to run. The tab is brought forward first,
    // so the file picker never opens over a tab that has nothing to do with
    // what is about to happen.
    void on<string>(EVENT.menu, (id) => {
      const command =
        id === "songs.import"
          ? "import"
          : id === "songs.exportJson"
            ? "exportJson"
            : id === "songs.exportTxt"
              ? "exportTxt"
              : null;
      if (command) set({ tab: "songs", songCommand: command });
    });

    void get().refreshPlans();
  },

  setTab: (tab) => set({ tab }),

  setSidePreviewDisplay: (sidePreviewDisplayId) => set({ sidePreviewDisplayId }),

  toast(message, tone = "info") {
    const id = ++toastSeq;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }));
    window.setTimeout(() => get().dismissToast(id), tone === "error" ? 6000 : 3200);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  reportError: (error) => get().toast(errorMessage(error), "error"),

  async patchSettings(patch) {
    const next = { ...get().settings, ...patch };
    // Optimistic: dragging a box in the layout editor updates at pointer rate,
    // and the console's own preview must not lag behind the cursor.
    set({ settings: next });
    scheduleSave(next, get);
  },

  async patchDisplay(id, patch) {
    const current = get().settings.displays[id];
    if (!current) return;
    await get().patchSettings({
      displays: { ...get().settings.displays, [id]: { ...current, ...patch } },
    });
  },

  async addWebScreen(name) {
    try {
      // The command writes settings itself — a new screen means a server has
      // to be started, which the debounced settings save cannot do.
      set({ settings: await api.addWebScreen(name), webScreens: await api.listWebScreens() });
    } catch (error) {
      get().reportError(error);
    }
  },

  async updateWebScreen(id, patch) {
    try {
      set({ settings: await api.updateWebScreen(id, patch), webScreens: await api.listWebScreens() });
    } catch (error) {
      get().reportError(error);
    }
  },

  async removeWebScreen(id) {
    try {
      set({ settings: await api.removeWebScreen(id), webScreens: await api.listWebScreens() });
    } catch (error) {
      get().reportError(error);
    }
  },

  async patchPreset(id, patch) {
    const presets = get().settings.presets.map((preset) =>
      preset.id === id ? { ...preset, ...patch } : preset,
    );
    await get().patchSettings({ presets });
  },

  async setPresets(presets) {
    await get().patchSettings({ presets });
  },

  /** Stamps a transport change against the clock and pushes it to the screens. */
  async patchPlayback(patch, positionMs) {
    const next = stamped(get().playback, patch, positionMs);
    set({ playback: next });
    try {
      await api.setPlayback(next);
    } catch (error) {
      get().reportError(error);
    }
  },

  playTrack(track) {
    set((state) => {
      const existing = state.audioPlayers.find((player) => player.track.id === track.id);
      // Choosing a track always starts it from the beginning: picking one off
      // the list is an instruction to play it, not merely to select it. One
      // already sounding restarts rather than doubling up on itself.
      if (existing) {
        return {
          audioPlayers: state.audioPlayers.map((player) =>
            player.track.id === track.id
              ? { ...player, track, playing: true, positionMs: 0, seekToken: player.seekToken + 1 }
              : player,
          ),
        };
      }
      const player: AudioPlayer = {
        track,
        playing: true,
        positionMs: 0,
        durationMs: 0,
        volume: clamp01(track.volume),
        seekToken: 0,
      };
      return { audioPlayers: [...state.audioPlayers, player] };
    });
  },

  toggleTrack: (id) =>
    set((state) => ({
      audioPlayers: state.audioPlayers.map((player) =>
        player.track.id === id ? { ...player, playing: !player.playing } : player,
      ),
    })),

  stopTrack: (id) =>
    set((state) => ({
      audioPlayers: state.audioPlayers.filter((player) => player.track.id !== id),
    })),

  stopAllAudio: () => set({ audioPlayers: [] }),

  seekTrack: (id, ms) =>
    set((state) => ({
      audioPlayers: state.audioPlayers.map((player) =>
        player.track.id === id
          ? { ...player, positionMs: Math.max(0, ms), seekToken: player.seekToken + 1 }
          : player,
      ),
    })),

  setTrackVolume(id, volume) {
    const next = clamp01(volume);
    // Live at once, on disk in a moment: a slider drags at pointer rate, and
    // the mixer must not lag the hand that is riding it.
    set((state) => ({
      audioPlayers: state.audioPlayers.map((player) =>
        player.track.id === id
          ? { ...player, volume: next, track: { ...player.track, volume: next } }
          : player,
      ),
    }));
    scheduleVolumeSave(id, next, get);
  },

  toggleAllMedia() {
    const { audioPlayers, live, playback } = get();
    const hasClip = live.kind === "video";
    const sounding = audioPlayers.some((player) => player.playing);
    const moving = hasClip && playback.playing;

    // Anything running stops. Paused, not cleared: this is the key a hand
    // finds in the dark, and it should never be the one that loses the
    // operator their place.
    if (sounding || moving) {
      if (sounding) {
        set({ audioPlayers: audioPlayers.map((player) => ({ ...player, playing: false })) });
      }
      if (moving) void get().patchPlayback({ playing: false });
      return true;
    }

    // Nothing running, but something is sitting there stopped: set it going.
    if (audioPlayers.length > 0) {
      set({ audioPlayers: audioPlayers.map((player) => ({ ...player, playing: true })) });
    }
    if (hasClip) void get().patchPlayback({ playing: true });
    return audioPlayers.length > 0 || hasClip;
  },

  reportAudio: (id, positionMs, durationMs) =>
    set((state) => ({
      audioPlayers: state.audioPlayers.map((player) =>
        player.track.id === id ? { ...player, positionMs, durationMs } : player,
      ),
    })),

  async updateTimer(timer) {
    set({ timer });
    try {
      await api.setTimer(timer);
    } catch (error) {
      get().reportError(error);
    }
  },

  async refreshDisplays() {
    try {
      set({ displays: await api.syncDisplays() });
    } catch (error) {
      get().reportError(error);
    }
  },

  async refreshLibrary() {
    try {
      const [songbooks, translations] = await Promise.all([
        api.listSongbooks(),
        api.listTranslations(),
      ]);
      set({ songbooks, translations });
    } catch (error) {
      get().reportError(error);
    }
  },

  async loadDeck(deck, options) {
    const previous = get().deck;
    // Reloading the same deck — because its song was just edited — keeps the
    // operator's place. Only a genuinely different deck resets it.
    const same = !!deck && !!previous && deck.key === previous.key;
    const last = Math.max(0, (deck?.slides.length ?? 0) - 1);
    const liveIndex = get().liveIndex;

    set({
      deck,
      cursor: same ? Math.min(get().cursor, last) : 0,
      liveIndex: same && liveIndex !== null ? Math.min(liveIndex, last) : null,
    });
    if (!deck || deck.slides.length === 0) return;
    if (same) return;
    if (options?.goLive) {
      await get().go(0);
    } else if (get().settings.blankOnSwitch && !get().blanked) {
      await get().toggleBlank();
    }
  },

  select(index) {
    const { deck } = get();
    if (!deck || index < 0 || index >= deck.slides.length) return;
    set({ cursor: index });
  },

  async go(index) {
    const { deck } = get();
    if (!deck || !deck.slides[index]) return;
    set({ cursor: index, liveIndex: index, blanked: false });
    const payload = slideToLive(deck, index, translationLabel(get().settings));
    if (!payload) return;
    try {
      await api.setLive(payload);
      remember(deck, index);
      // `set_live` restarts the transport; give it the clip's own loop setting
      // before anything has had time to play.
      const slide = deck.slides[index];
      if (payload.kind === "video") {
        await get().patchPlayback({ playing: true, looping: !!slide?.looping }, 0);
      }
    } catch (error) {
      get().reportError(error);
    }
  },

  /**
   * Adds something to the running order.
   *
   * The plan is a document being edited, so this only touches memory — it is
   * written when the operator saves, and the dirty flag is what tells them
   * there is something to write.
   */
  addToPlan(entry) {
    set((state) => ({
      plan: {
        ...state.plan,
        entries: [...state.plan.entries, { ...entry, id: planEntryId() } as PlanEntry],
      },
    }));
    schedulePlanSave(get);
    get().toast(get().t("plan.added", { name: entry.label }), "success");
  },

  removeFromPlan(entryId) {
    set((state) => ({
      plan: {
        ...state.plan,
        entries: state.plan.entries.filter((entry) => entry.id !== entryId),
      },
    }));
    schedulePlanSave(get);
  },

  movePlanEntry(from, to) {
    set((state) => {
      const entries = [...state.plan.entries];
      if (from < 0 || to < 0 || from >= entries.length || to >= entries.length) return {};
      const [moved] = entries.splice(from, 1);
      if (!moved) return {};
      entries.splice(to, 0, moved);
      return { plan: { ...state.plan, entries } };
    });
    schedulePlanSave(get);
  },

  setPlanNote(entryId, note) {
    set((state) => ({
      plan: {
        ...state.plan,
        entries: state.plan.entries.map((entry) =>
          entry.id === entryId ? { ...entry, note } : entry,
        ),
      },
    }));
    schedulePlanSave(get);
  },

  async openPlanEntry(entryId, live = false) {
    const entry = get().plan.entries.find((item) => item.id === entryId);
    if (!entry) return;
    try {
      const action = await resolvePlanEntry(entry, get().settings);
      // Gone from the library since it was added. The line stays in the plan
      // — an operator needs to see that it is missing, not have it vanish on
      // the morning it was needed.
      if (!action) {
        get().toast(get().t("plan.missing", { name: entry.label }), "error");
        return;
      }
      if (action.kind === "track") {
        set({ tab: "audio" });
        get().playTrack(action.track);
        return;
      }

      // Opened where it lives, not just pushed at the screens: the operator
      // wants the song in front of them so they can pick a verse, skip a
      // chorus, see what is in it. The deck is loaded here as well as by the
      // tab, which is harmless — reloading the same key keeps the place.
      await get().loadDeck(action.deck);
      set({ tab: TAB_FOR_PLAN[entry.kind], openRequest: entry });
      if (live) await get().go(0);
    } catch (error) {
      get().reportError(error);
    }
  },

  clearOpenRequest: () => set({ openRequest: null }),

  clearSongCommand: () => set({ songCommand: null }),

  startNewPlan: (name) => {
    // Anything pending belongs to the plan being left behind, so it is written
    // before the new one takes its place.
    flushPlan(get);
    set({ plan: newPlan(name) });
  },

  renamePlan(name) {
    set((state) => ({ plan: { ...state.plan, name } }));
    schedulePlanSave(get);
  },

  openPlan: (id) => {
    flushPlan(get);
    const found = get().plans.find((item) => item.id === id);
    if (found) set({ plan: found });
  },

  async deletePlan(id) {
    try {
      await api.deletePlan(id);
      await get().refreshPlans();
      // The open plan was the one deleted: keep its contents on screen but
      // detach it, so nothing the operator was looking at disappears and the
      // next save creates it afresh.
      // The open plan was the one deleted: keep what is on screen but give it
      // a fresh identity, so the next change writes a new plan rather than
      // resurrecting the deleted one.
      if (get().plan.id === id) set({ plan: { ...get().plan, id: newPlan("").id } });
    } catch (error) {
      get().reportError(error);
    }
  },

  async refreshPlans() {
    try {
      set({ plans: await api.listPlans() });
    } catch (error) {
      get().reportError(error);
    }
  },

  async replayHistory(id) {
    const entry = get().history.find((item) => item.id === id);
    if (!entry) return;
    // The deck has usually moved on, so its own deck goes back first or `go`
    // would index into whatever is open now.
    //
    // Deliberately not `loadDeck`: that honours `blankOnSwitch`, which exists
    // so nothing leaks while the operator hunts for the next thing. Here they
    // have already picked it, and a blank frame between the click and the
    // slide would be a flicker for no reason.
    if (get().deck?.key !== entry.deck.key) {
      set({ deck: entry.deck, cursor: entry.index, liveIndex: null });
    }
    await get().go(entry.index);
  },

  clearHistory: () => set({ history: [] }),

  async step(delta) {
    const { deck, cursor, blanked, liveIndex } = get();
    if (!deck || deck.slides.length === 0) return;
    // When nothing from this deck is on screen — because it was just loaded,
    // or blanked — the first press shows what is highlighted rather than
    // skipping past it.
    if (blanked || liveIndex === null) {
      await get().go(cursor);
      return;
    }
    const next = Math.min(deck.slides.length - 1, Math.max(0, cursor + delta));
    if (next !== cursor) await get().go(next);
  },

  async toggleBlank() {
    const { blanked, cursor } = get();
    try {
      if (blanked) {
        await get().go(cursor);
      } else {
        set({ blanked: true, liveIndex: null });
        await api.blank();
      }
    } catch (error) {
      get().reportError(error);
    }
  },
}));
