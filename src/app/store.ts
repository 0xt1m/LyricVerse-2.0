import { create } from "zustand";
import { EVENT, api, errorMessage, on } from "../api";
import type {
  Deck,
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
  | "audio"
  | "timer"
  | "displays"
  | "settings";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
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
   * The track playing in this window.
   *
   * Audio is the one thing that does not go to a screen: the machine running
   * the console is the one plugged into the desk, so it plays here and keeps
   * playing whichever tab the operator moves to.
   */
  audioTrack: Track | null;
  audioPlaying: boolean;
  audioPositionMs: number;
  audioDurationMs: number;
  /** Bumped by `seekAudio`, so the element can tell a scrub from the position
   *  it just reported itself. */
  audioSeekToken: number;

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
  /** Which screen the footer preview shows; null follows the first enabled. */
  previewDisplayId: string | null;
  setPreviewDisplay: (id: string | null) => void;

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
  playTrack: (track: Track | null) => void;
  toggleAudio: () => void;
  stopAudio: () => void;
  seekAudio: (ms: number) => void;
  /** Reported by the audio element as it plays. */
  reportAudio: (positionMs: number, durationMs: number) => void;
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
  language: "uk",
  activeSongbook: null,
  activeTranslation: null,
  secondaryTranslations: [],
  blankOnSwitch: false,
  showStatusBar: true,
  showPreview: true,
  showFilmstrip: true,
  webScreens: [],
  backgroundOrder: [],
  audioDeviceId: "",
  audioVolume: 1,
  favouriteSongs: {},
  favouritesFirst: false,
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
  sectionKind: "",
  mediaPath: null,
  youtubeId: null,
  revision: 0,
};

let toastSeq = 0;

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
  audioTrack: null,
  audioPlaying: false,
  audioPositionMs: 0,
  audioDurationMs: 0,
  audioSeekToken: 0,

  deck: null,
  cursor: 0,
  liveIndex: null,
  blanked: false,
  libraryRevision: 0,
  previewDisplayId: null,

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
        lanAddress: boot.lanAddress,
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
  },

  setTab: (tab) => set({ tab }),

  setPreviewDisplay: (previewDisplayId) => set({ previewDisplayId }),

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
    // Choosing a track always starts it from the beginning: picking one off
    // the list is an instruction to play it, not merely to select it.
    set({ audioTrack: track, audioPlaying: !!track, audioPositionMs: 0, audioDurationMs: 0 });
  },

  toggleAudio: () => set((state) => ({ audioPlaying: !!state.audioTrack && !state.audioPlaying })),

  stopAudio: () => set({ audioTrack: null, audioPlaying: false, audioPositionMs: 0 }),

  seekAudio: (ms) =>
    set((state) => ({
      audioPositionMs: Math.max(0, ms),
      audioSeekToken: state.audioSeekToken + 1,
    })),

  reportAudio: (audioPositionMs, audioDurationMs) => set({ audioPositionMs, audioDurationMs }),

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
