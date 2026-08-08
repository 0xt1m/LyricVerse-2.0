import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Background,
  BibleReference,
  Presentation,
  Timer,
  Video,
  BookInfo,
  Bootstrap,
  DisplayInfo,
  LiveKind,
  LiveState,
  ResolvedReference,
  SearchHit,
  Settings,
  LyricsDraft,
  Section,
  Song,
  SongSummary,
  SongbookMeta,
  TranslationMeta,
  RemoteTranslation,
  VerseRow,
  Playback,
  WebScreenStatus,
  ImportReport,
  Plan,
  SongFormat,
  Track,
} from "./types";

export const EVENT = {
  live: "lyricverse://live",
  settings: "lyricverse://settings",
  displays: "lyricverse://displays",
  library: "lyricverse://library",
  identify: "lyricverse://identify",
  timer: "lyricverse://timer",
  playback: "lyricverse://playback",
  menu: "lyricverse://menu",
  webScreens: "lyricverse://webscreens",
  download: "lyricverse://download",
} as const;

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  getDataDir: () => invoke<string>("get_data_dir"),
  listFonts: () => invoke<string[]>("list_fonts"),
  supportedImageExtensions: () => invoke<string[]>("supported_image_extensions"),

  getTimer: () => invoke<Timer | null>("get_timer"),
  setTimer: (timer: Timer | null) => invoke<void>("set_timer", { timer }),

  getPlayback: () => invoke<Playback>("get_playback"),
  setPlayback: (playback: Playback) => invoke<Playback>("set_playback", { playback }),

  listPresentations: () => invoke<Presentation[]>("list_presentations"),
  createPresentation: (name: string) => invoke<Presentation>("create_presentation", { name }),
  renamePresentation: (id: string, name: string) =>
    invoke<void>("rename_presentation", { id, name }),
  deletePresentation: (id: string) => invoke<void>("delete_presentation", { id }),
  addPresentationImage: (id: string, path: string) =>
    invoke<Presentation>("add_presentation_image", { id, path }),
  addPresentationPage: (id: string, data: string) =>
    invoke<Presentation>("add_presentation_page", { id, data }),
  readFileBase64: (path: string) => invoke<string>("read_file_base64", { path }),
  addPresentationText: (id: string, text: string) =>
    invoke<Presentation>("add_presentation_text", { id, text }),
  setPresentationText: (id: string, file: string, text: string) =>
    invoke<Presentation>("set_presentation_text", { id, file, text }),
  reorderPresentation: (id: string, order: string[]) =>
    invoke<Presentation>("reorder_presentation", { id, order }),
  removePresentationSlide: (id: string, file: string) =>
    invoke<Presentation>("remove_presentation_slide", { id, file }),

  listTracks: () => invoke<Track[]>("list_tracks"),
  importTrack: (path: string) => invoke<Track>("import_track", { path }),
  renameTrack: (id: string, name: string) => invoke<void>("rename_track", { id, name }),
  setTrackLooping: (id: string, looping: boolean) =>
    invoke<void>("set_track_looping", { id, looping }),
  setTrackVolume: (id: string, volume: number) =>
    invoke<void>("set_track_volume", { id, volume }),
  deleteTrack: (id: string, deleteFile: boolean) =>
    invoke<void>("delete_track", { id, deleteFile }),
  supportedAudioExtensions: () => invoke<string[]>("supported_audio_extensions"),

  listVideos: () => invoke<Video[]>("list_videos"),
  setVideoLooping: (id: string, looping: boolean) =>
    invoke<void>("set_video_looping", { id, looping }),
  importVideo: (path: string) => invoke<Video>("import_video", { path }),
  addYoutubeVideo: (name: string, url: string) =>
    invoke<Video>("add_youtube_video", { name, url }),
  renameVideo: (id: string, name: string) => invoke<void>("rename_video", { id, name }),
  deleteVideo: (id: string, deleteFile: boolean) =>
    invoke<void>("delete_video", { id, deleteFile }),

  listBackgrounds: () => invoke<Background[]>("list_backgrounds"),
  importBackground: (path: string) => invoke<Background>("import_background", { path }),
  deleteBackground: (filename: string) => invoke<void>("delete_background", { filename }),

  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (next: Settings) => invoke<Settings>("save_settings", { next }),

  listDisplays: () => invoke<DisplayInfo[]>("list_displays"),

  listWebScreens: () => invoke<WebScreenStatus[]>("list_web_screens"),
  /** Asked for after boot, never during it — see the Rust side for why. */
  lanAddress: () => invoke<string | null>("lan_address"),
  addWebScreen: (name: string) => invoke<Settings>("add_web_screen", { name }),
  updateWebScreen: (id: string, patch: { name?: string; port?: number }) =>
    invoke<Settings>("update_web_screen", { id, ...patch }),
  removeWebScreen: (id: string) => invoke<Settings>("remove_web_screen", { id }),

  syncDisplays: () => invoke<DisplayInfo[]>("sync_displays"),
  identifyDisplays: () => invoke<void>("identify_displays"),
  openTestWindow: (displayId: string) => invoke<void>("open_test_window", { displayId }),

  getLive: () => invoke<LiveState>("get_live"),
  setLive: (input: {
    kind: LiveKind;
    bodyPart: string;
    title: string;
    number: string;
    sectionLabel: string;
    reference: string;
    translation: string;
    nextUp: string;
    nextMediaPath?: string | null;
    sectionKind: string;
    mediaPath?: string | null;
    youtubeId?: string | null;
    cameraDeviceId?: string | null;
  }) => invoke<LiveState>("set_live", { input }),
  blank: () => invoke<LiveState>("blank"),

  listSongbooks: () => invoke<SongbookMeta[]>("list_songbooks"),
  listSongs: (songbook: string) => invoke<SongSummary[]>("list_songs", { songbook }),
  getSong: (songbook: string, id: number) => invoke<Song>("get_song", { songbook, id }),
  saveSong: (songbook: string, song: Song) => invoke<number>("save_song", { songbook, song }),
  deleteSong: (songbook: string, id: number) => invoke<void>("delete_song", { songbook, id }),
  createSongbook: (name: string) => invoke<SongbookMeta>("create_songbook", { name }),
  parseSections: (text: string) => invoke<Section[]>("parse_sections", { text }),
  parseLyrics: (text: string) => invoke<LyricsDraft>("parse_lyrics", { text }),
  importSongbook: (path: string, name?: string) =>
    invoke<SongbookMeta>("import_songbook", { path, name: name ?? null }),
  renameSongbook: (from: string, to: string) => invoke<void>("rename_songbook", { from, to }),
  deleteSongbook: (name: string, deleteFile: boolean) =>
    invoke<void>("delete_songbook", { name, deleteFile }),

  /** JSON writes one file holding every song; txt writes one file per song. */
  exportSongs: (songbook: string, ids: number[], format: SongFormat, destination: string) =>
    invoke<string[]>("export_songs", { songbook, ids, format, destination }),
  importSongs: (songbook: string, paths: string[]) =>
    invoke<ImportReport>("import_songs", { songbook, paths }),

  listPlans: () => invoke<Plan[]>("list_plans"),
  savePlan: (plan: Plan) => invoke<Plan>("save_plan", { plan }),
  deletePlan: (id: string) => invoke<void>("delete_plan", { id }),

  listTranslations: () => invoke<TranslationMeta[]>("list_translations"),
  getBooks: (translationName: string) => invoke<BookInfo[]>("get_books", { translationName }),
  getChapters: (translationName: string, book: number) =>
    invoke<number[]>("get_chapters", { translationName, book }),
  getVerses: (translationName: string, book: number, chapter: number) =>
    invoke<VerseRow[]>("get_verses", { translationName, book, chapter }),
  searchBible: (translationName: string, query: string, limit?: number) =>
    invoke<SearchHit[]>("search_bible", { translationName, query, limit: limit ?? null }),
  resolveReference: (translationName: string, query: string) =>
    invoke<ResolvedReference | null>("resolve_reference", { translationName, query }),
  getPassage: (translationName: string, reference: BibleReference) =>
    invoke<ResolvedReference>("get_passage", { translationName, reference }),
  importTranslation: (path: string, name?: string) =>
    invoke<TranslationMeta>("import_translation", { path, name: name ?? null }),
  deleteTranslation: (name: string, deleteFile: boolean) =>
    invoke<void>("delete_translation", { name, deleteFile }),
  openDataFolder: () => invoke<void>("open_data_folder"),
  listDownloadableTranslations: () =>
    invoke<RemoteTranslation[]>("list_downloadable_translations"),
  downloadTranslation: (entry: RemoteTranslation) =>
    invoke<TranslationMeta>("download_translation", { entry }),
};

/** Backend errors arrive as plain strings; normalise anything else. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (message) => handler(message.payload));
}
