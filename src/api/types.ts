/** Mirrors the serde shapes in src-tauri/src. Keep the two in sync. */

export type SectionKind = "verse" | "chorus" | "bridge" | "other";

/** A song built out of pasted lyrics: the sections, and the order they are
 *  sung in — where a chorus appears once in `sections` and as often as it is
 *  sung in `order`. */
export interface LyricsDraft {
  sections: Section[];
  order: string[];
}

export interface Section {
  id: string;
  kind: SectionKind;
  label?: string | null;
  text: string;
}

export interface Song {
  id: number;
  title: string;
  sections: Section[];
  /** Section ids in performance order; ids may repeat. */
  order: string[];
}

export interface SongSummary {
  id: number;
  title: string;
  firstLine: string;
  sectionCount: number;
}

export interface SongbookMeta {
  name: string;
  filename: string;
  songCount: number;
  error: string | null;
}

export interface TranslationMeta {
  name: string;
  filename: string;
  error: string | null;
}

/** A translation lyricverse.app is offering, as the catalogue describes it. */
export interface RemoteTranslation {
  name: string;
  language: string;
  description: string;
  url: string;
  /** Size in bytes; 0 when the catalogue does not say. */
  bytes: number;
  sha256: string | null;
}

/** How far a download has got, pushed while it runs. */
export interface DownloadProgress {
  name: string;
  received: number;
  /** 0 when the server did not say how long the file is. */
  total: number;
}

/** One slide of a parallel reading: a verse of the primary translation with
 *  the same words from every other translation on screen, each under its own
 *  reference. The Psalms are numbered two ways, so those references disagree
 *  for most of the Psalter. */
export interface AlignedRow {
  verses: number[];
  /** "23:1" in the primary's numbering. */
  reference: string;
  text: string;
  others: AlignedOther[];
}

export interface AlignedOther {
  name: string;
  /** What this module calls the book — "Псалми" beside the ESV's "Psalms". */
  book: string;
  /** The same words in that module's own numbering — "22:1". */
  reference: string;
  text: string;
  /** True when that module numbers this passage differently. */
  shifted: boolean;
}

/** One translation's words on a slide, and the reference for them in that
 *  translation's own numbering. */
export interface Passage {
  text: string;
  reference: string;
}

/** The four layouts a preset holds, named the same way everywhere. */
export type LayoutContent = "song" | "bible" | "media" | "timer";

export interface BookInfo {
  number: number;
  shortName: string;
  longName: string;
  color: string;
  chapters: number;
}

export interface VerseRow {
  book: number;
  chapter: number;
  verse: number;
  text: string;
}

export interface SearchHit {
  book: number;
  bookName: string;
  chapter: number;
  verse: number;
  text: string;
  reference: string;
  matchStart: number;
  matchEnd: number;
}

export interface BibleReference {
  book: number;
  chapter: number;
  verse: number;
  endVerse: number;
}

export interface ResolvedReference {
  reference: BibleReference;
  label: string;
  text: string;
}

export interface DisplayInfo {
  id: string;
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
  isOpen: boolean;
}

export type LiveKind =
  | "blank"
  | "song"
  | "bible"
  | "image"
  | "video"
  | "timer"
  | "message"
  /** A live camera on the machine running the console. */
  | "camera";

/** One field per layout element — a display draws whichever ones it is
 *  configured to show. */
export interface LiveState {
  kind: LiveKind;
  /** The section or passage on screen. */
  bodyPart: string;
  /** Song title, or the book name for scripture. */
  title: string;
  /** Song number, or the verse number for scripture. */
  number: string;
  sectionLabel: string;
  reference: string;
  translation: string;
  /** Each translation's words with its own reference, in the order they are
   *  stacked on screen. `bodyPart` is the same words run together. */
  passages: Passage[];
  /** The slide queued after this one — what a confidence screen is for. */
  nextUp: string;
  /** The picture on that queued slide, when it carries one instead of words.
   *  A deck of slides has nothing for `nextUp` to say otherwise. */
  nextMediaPath: string | null;
  sectionKind: string;
  /** Absolute path of the image or video filling the screen. */
  mediaPath: string | null;
  /** YouTube id, when the live item is a link rather than a file. */
  youtubeId: string | null;
  /** Which camera to open, as the browser's device id. Empty means whichever
   *  the system offers first. */
  cameraDeviceId: string | null;
  revision: number;
}

export type TimerMode = "countdown" | "countUp" | "clock";

/**
 * Kept apart from the live state on purpose: a countdown to the start of the
 * service keeps running while the operator moves between songs, and each
 * display ticks it locally from the anchor.
 */
export interface Timer {
  mode: TimerMode;
  label: string;
  /** Epoch ms the countdown ends, or the count-up began. */
  anchorMs: number;
  /** Milliseconds left or elapsed while paused. */
  frozenMs: number;
  /** What the countdown was set to, so Reset works from anywhere. */
  durationMs: number;
  running: boolean;
  hideWhenFinished: boolean;
  /** Colour once a countdown has passed zero. Overrides the element colour. */
  overrunColor: string;
  /** Seconds left at which the digits change colour. 0 disables it. */
  warnAtSeconds: number;
  warnColor: string;
}

export interface PresentationSlide {
  file: string;
  path: string;
  /** The words, when this slide is a typed message rather than a picture. */
  text: string | null;
}

export interface Presentation {
  id: string;
  name: string;
  slides: PresentationSlide[];
}

export interface Video {
  id: string;
  name: string;
  kind: "file" | "youtube";
  path: string | null;
  youtubeId: string | null;
  /** Start again at the end. Saved per clip. */
  looping: boolean;
  missing: boolean;
}

export interface Shadow {
  enabled: boolean;
  blur: number;
  offsetX: number;
  offsetY: number;
  color: string;
  opacity: number;
}

/** Position and size as percentages of the screen, top-left origin. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ElementId =
  | "body"
  | "title"
  | "number"
  | "sectionLabel"
  | "reference"
  | "translation"
  | "nextUp"
  | "timer";

export const SONG_ELEMENTS: ElementId[] = [
  "body",
  "title",
  "number",
  "sectionLabel",
  "nextUp",
  "timer",
];
/** The words of a message slide, what is coming next on a screen facing the
 *  platform, and the timer that may overlay either. */
export const MEDIA_ELEMENTS: ElementId[] = ["body", "nextUp", "timer"];

/** The timer as the content itself: the digits, plus a line of text below. */
export const TIMER_ELEMENTS: ElementId[] = ["timer", "body"];

export const BIBLE_ELEMENTS: ElementId[] = [
  "body",
  "reference",
  "number",
  "translation",
  "nextUp",
  "timer",
];

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";

/** A plate behind the words; each block of a parallel reading gets one. */
export interface Panel {
  color: string;
  /** 0 hides it. */
  opacity: number;
  /** In `em`, so it scales with the auto-fitted type. */
  padding: number;
  radius: number;
  gap: number;
}

export interface LayoutElement {
  id: ElementId;
  visible: boolean;
  rect: Rect;
  fontFamily: string;
  fontWeight: number;
  /** Ceiling for the auto-fitted size, as a % of screen height. 0 = no cap. */
  maxFontScale: number;
  lineHeight: number;
  letterSpacing: number;
  uppercase: boolean;
  italic: boolean;
  align: HAlign;
  valign: VAlign;
  color: string;
  opacity: number;
  shadow: Shadow;
  panel: Panel;
}

export interface Layout {
  /** Draw order — later entries sit on top. */
  elements: LayoutElement[];
}

export type BackgroundFit = "cover" | "contain" | "fill";

/**
 * A complete named look. v2 hard-coded exactly two of these as a `mode` enum;
 * they were only ever two points in the same space.
 */
export interface Preset {
  id: string;
  name: string;
  /** Ships with the app: editable and resettable, but not deletable. */
  builtin: boolean;

  /** Keep the backdrop identical when blanked — a chroma key must not move. */
  constantBackground: boolean;
  /** Ignore the source's line breaks and let the words wrap to the box. */
  collapseLineBreaks: boolean;
  /** Draw "next up" as a little picture of the coming slide, not a line of
   *  text. For a confidence screen facing the platform. */
  nextPreview: boolean;
  /** Where the references go: "element" puts them all in the Reference box,
   *  wherever it has been placed; "withPassage" puts each one directly under
   *  the words it belongs to. */
  referencePlacement: "element" | "withPassage";

  background: string;
  /** File name inside the Backgrounds folder — an image or a video. */
  backgroundMedia: string | null;
  backgroundFit: BackgroundFit;
  /** Darkens the media so text stays legible, 0–100%. */
  backgroundDim: number;

  /** The same, for when the output is blanked. */
  passiveBackground: string;
  passiveBackgroundMedia: string | null;
  passiveBackgroundFit: BackgroundFit;
  passiveBackgroundDim: number;

  song: Layout;
  bible: Layout;
  /** Presentation slides and video — only what sits *over* the picture. */
  media: Layout;
  /** The countdown shown full screen in its own right. */
  timer: Layout;
}

/** One background state, as the picker works with it. */
export interface Backdrop {
  media: string | null;
  fit: BackgroundFit;
  dim: number;
}

export interface Background {
  filename: string;
  /** Absolute path, for `convertFileSrc`. */
  path: string;
  kind: "image" | "video";
  bytes: number;
}

export interface DisplayConfig {
  enabled: boolean;
  /** Id of the preset this screen renders with. */
  preset: string;
  /** What the operator calls this screen; empty means the system's own name. */
  name: string;
}

export interface Settings {
  version: number;
  language: string;
  activeSongbook: string | null;
  activeTranslation: string | null;
  /** The plan open when the app was last closed, reopened on the next start. */
  activePlan: string | null;
  /** Shown beneath the main translation, in this order. */
  secondaryTranslations: string[];
  blankOnSwitch: boolean;
  /** How large the console's own text and controls are drawn; 1 is the
   *  designed size. The projection screens are never scaled by it. */
  uiScale: number;
  /** Parts of the window the operator can put away. */
  showStatusBar: boolean;
  showFilmstrip: boolean;
  /** The preview-and-history panel on the content tabs. */
  showSidePanel: boolean;
  /** Which edge that panel is docked to. */
  sidePanelPlacement: "right" | "bottom";
  /** How big the operator has dragged it, per edge — so switching edges
   *  restores that edge's size rather than reusing a width as a height. */
  sidePanelWidth: number;
  sidePanelHeight: number;
  /** Screens served over the network rather than driven by a cable. */
  webScreens: WebScreen[];
  /** Which sound device audio and video go out of; empty is the system default. */
  audioDeviceId: string;
  /** 0..1, applied to tracks and clips alike. */
  audioVolume: number;
  /** Song ids marked as favourites, keyed by songbook name. */
  favouriteSongs: Record<string, number[]>;
  /** Sort the song list with favourites at the top. */
  favouritesFirst: boolean;
  /** Song ids in the order they were dragged into, by songbook name. A book
   *  that was never reordered is absent and stays in number order. */
  songOrder: Record<string, number[]>;
  /** How long each song runs in minutes, by songbook name and song id. Used
   *  as the starting length when a song is added to a plan. */
  songMinutes: Record<string, Record<string, number>>;
  /** The key each song is played in, by songbook name and song id. Free text
   *  — "G", "Am", "B♭", "capo 2" — because a band's shorthand is its own. */
  songKeys: Record<string, Record<string, string>>;
  /** The tempo each song is played at, in beats per minute, by songbook name
   *  and song id. */
  songBpm: Record<string, Record<string, number>>;
  /** The background picker's grid in order: `#rrggbb` colours and file names
   *  of imported pictures and clips, mixed. */
  backgroundOrder: string[];
  /** Whether the phone remote is serving, which port it uses, and the six
   *  digits a phone types to pair with it. */
  remoteEnabled: boolean;
  remotePort: number;
  remoteCode: string;
  /** Named looks, shared across screens. */
  presets: Preset[];
  displays: Record<string, DisplayConfig>;
}

/** Resolves the preset a screen renders with. */
export function presetFor(settings: Settings, displayId: string): Preset | null {
  const id = settings.displays[displayId]?.preset;
  return settings.presets.find((preset) => preset.id === id) ?? settings.presets[0] ?? null;
}

/** A screen an operator adds by hand and opens in a browser. */
export interface WebScreen {
  id: string;
  name: string;
  port: number;
}

export interface WebScreenStatus {
  id: string;
  running: boolean;
  port: number;
  /** Addresses to type into a browser, the network one first. */
  urls: string[];
  error: string | null;
}

/** How the clip on screen should be playing. The console decides; every
 *  display follows. */
/** A track in the audio library. */
export interface Track {
  id: string;
  name: string;
  path: string;
  /** Start again at the end. Saved per track. */
  looping: boolean;
  /** How loud this track sits against the others, 0..1. Saved per track. */
  volume: number;
  missing: boolean;
}

export interface Playback {
  playing: boolean;
  muted: boolean;
  looping: boolean;
  /** Where the clip was, in milliseconds, at `anchorMs`. */
  positionMs: number;
  /** Epoch milliseconds when `positionMs` was stamped. */
  anchorMs: number;
  revision: number;
}

export interface Defaults {
  settings: Settings;
  display: DisplayConfig;
}

export interface Bootstrap {
  settings: Settings;
  playback: Playback;
  webScreens: WebScreenStatus[];
  displays: DisplayInfo[];
  live: LiveState;
  songbooks: SongbookMeta[];
  translations: TranslationMeta[];
  dataDir: string;
  version: string;
  defaults: Defaults;
  timer: Timer | null;
}

/**
 * One thing the operator can put on screen. Songs and scripture both compile
 * down to this, so the transport controls and keyboard shortcuts work
 * identically in either tab.
 */
export interface DeckSlide {
  id: string;
  /** "Куплет 2", "Приспів", or a verse number — the operator's list label. */
  label: string;
  kind: SectionKind | "scripture";
  /** The text that goes on screen. */
  part: string;
  /** What the operator's list shows. Absent means "same as `part`" — it
   *  differs only when the projected text combines several sources, such as a
   *  parallel Bible reading, which would make the list unreadable. */
  summary?: string;
  /** Song title, or the book name for scripture. */
  title: string;
  /** Song number, or the verse number for scripture. */
  number: string;
  sectionLabel: string;
  reference: string;
  /** Slides sharing a group belong to the same section/verse. */
  groupId: string;
  /** Overrides the deck's kind for this slide — a message inside a deck of
   *  pictures is drawn as words, not as an image. */
  liveKind?: LiveKind;
  /** Each translation's words with its own reference, for a parallel reading.
   *  Absent on everything else, where `part` is the whole slide. */
  passages?: Passage[];
  /** Absolute path, for a presentation slide or a local clip. */
  mediaPath?: string | null;
  youtubeId?: string | null;
  /** Set on a camera slide: which camera the screens should open. */
  cameraDeviceId?: string | null;
  /** A clip that restarts at the end. Carried from the video's own setting. */
  looping?: boolean;
}

export interface Deck {
  source: LiveKind;
  /** Identifies *what* is loaded, independent of its contents. Reloading a
   *  deck with the same key keeps the operator's place — editing a song must
   *  not knock the live slide off the screen. */
  key: string;
  title: string;
  slides: DeckSlide[];
}

/** The phone remote's server, as the settings screen shows it. */
export interface RemoteStatus {
  running: boolean;
  port: number;
  /** Addresses to open on a phone; the LAN one first. */
  urls: string[];
  error: string | null;
  /** Devices paired right now. */
  devices: number;
}

/**
 * Something a phone has asked for.
 *
 * Deliberately coarse: a phone names what it wants shown, and the console
 * works out what that means with the settings in front of it. Anything finer
 * would be the remote knowing how decks are built, which is how two versions
 * of that knowledge start to drift apart.
 */
export type RemoteCommand =
  | { kind: "song"; songbook: string; songId: number }
  | { kind: "bible"; translation: string; book: number; chapter: number; verse: number }
  | { kind: "presentation"; presentationId: string }
  | { kind: "go"; index: number }
  | { kind: "step"; delta: number }
  | { kind: "blank" }
  | { kind: "show" };

// --- Service plans ---------------------------------------------------------

export type PlanKind =
  | "song"
  | "bible"
  | "presentation"
  | "video"
  | "audio"
  /** Something the operator typed — "Sermon", "Notices", "Offering". A line of
   *  the running order that shows nothing. */
  | "custom"
  /** A group: "Worship", "Communion". Holds items and other folders, and can
   *  be folded away. Distinct from an item — a folder is where things go, an
   *  item is a thing. */
  | "folder";

/**
 * One item in a running order.
 *
 * A reference, not a copy: a song corrected on Saturday night is corrected in
 * Sunday's plan too. `label` is what it was called when it was added, kept so
 * the plan still reads sensibly if the thing it points at has been deleted
 * from under it.
 */
export type PlanEntry =
  | PlanEntryBase<"song", { songbook: string; songId: number }>
  | PlanEntryBase<
      "bible",
      { translation: string; book: number; chapter: number; start: number; end: number }
    >
  | PlanEntryBase<"presentation", { presentationId: string }>
  | PlanEntryBase<"video", { videoId: string }>
  | PlanEntryBase<"audio", { trackId: string }>
  | PlanEntryBase<"custom", Record<string, never>>
  | PlanEntryBase<"folder", Record<string, never>>;

interface PlanEntryBase<K extends PlanKind, R> {
  id: string;
  kind: K;
  label: string;
  /** The operator's own note — "after the notices", "2 verses only". */
  note: string;
  /** Expected length in minutes; 0 when nobody has said. */
  minutes: number;
  /** 0 for a line of the running order, 1 for something under the line above
   *  it — the readings belonging to a sermon. One level only. */
  depth: number;
  /** A folded folder: what is under it is hidden until it is opened again. */
  collapsed: boolean;
  ref: R;
}

export interface Plan {
  id: string;
  name: string;
  entries: PlanEntry[];
  /** When the service starts, as "HH:MM". Empty means the plan is a running
   *  order only, and each item shows its own length instead of a clock. */
  startsAt: string;
  /** Epoch milliseconds of the last save, newest first in the list. */
  updatedMs: number;
}

/** What a bulk song import managed, and what it could not read. */
export interface ImportReport {
  imported: number;
  /** One entry per file that failed, as "name: why". */
  failed: string[];
}

export type SongFormat = "json" | "txt";
