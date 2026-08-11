/**
 * Talking to the console from a phone.
 *
 * Everything goes to the same origin the page was served from, so there is no
 * address to configure: whatever the phone typed into its browser is the
 * machine running the service.
 */

import type { BookInfo, SongSummary, SongbookMeta, TranslationMeta, VerseRow } from "../api/types";

const TOKEN_KEY = "lyricverse.remote.token";

/** What the console has open, as the console describes it. */
export interface RemoteDeck {
  title: string;
  source: string;
  slides: { label: string; kind: string; text: string }[];
  /** The slide on the screens, or null when nothing is. */
  index: number | null;
  /** The slide the operator has highlighted but not shown. */
  cursor: number;
  blanked: boolean;
}

export interface Feed {
  revision: number;
  deck: RemoteDeck | null;
  live: { kind: string; reference: string; title: string; bodyPart: string } | null;
}

export function storedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    // A browser with storage blocked can still be paired; it just has to do it
    // again next time the page is opened.
    return "";
  }
}

export function rememberToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* see above */
  }
}

/** Thrown when the console no longer knows this device — the code was changed,
 *  the remote was switched off, or the session simply aged out. */
export class Unpaired extends Error {}

async function ask<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const query = new URLSearchParams({ token: storedToken() });
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  const response = await fetch(`/api/${path}?${query}`, { cache: "no-store" });
  if (response.status === 401) throw new Unpaired();
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

async function tell(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const remote = {
  /** Trades the six digits for a token. False means the code was wrong. */
  async pair(code: string): Promise<boolean> {
    const response = await tell("pair", { code });
    if (!response.ok) return false;
    const { token } = (await response.json()) as { token?: string };
    if (!token) return false;
    rememberToken(token);
    return true;
  },

  language: () => fetch("/api/hello").then((r) => r.json() as Promise<{ language: string }>),

  /**
   * Held open by the console until something changes, then answered at once.
   *
   * So a slide changed at the laptop is on the phone immediately, without the
   * phone asking every second all morning.
   */
  state: (since: number) =>
    ask<{ revision: number; deck: RemoteDeck | null; state: { live?: Feed["live"] } | null }>(
      "state",
      { since },
    ),

  library: () =>
    ask<{ songbooks: SongbookMeta[]; translations: TranslationMeta[] }>("library"),

  songs: (songbook: string) => ask<{ songs: SongSummary[] }>("songs", { songbook }),

  presentations: () =>
    ask<{ presentations: { id: string; name: string; slides: number }[] }>("presentations"),

  books: (translation: string) => ask<{ books: BookInfo[] }>("books", { translation }),

  verses: (translation: string, book: number, chapter: number) =>
    ask<{ verses: VerseRow[] }>("verses", { translation, book, chapter }),

  /** Asks the console to do something. Nothing comes back but "heard". */
  async send(command: Record<string, unknown>): Promise<void> {
    const response = await tell("command", { ...command, token: storedToken() });
    if (response.status === 401) throw new Unpaired();
  },
};
