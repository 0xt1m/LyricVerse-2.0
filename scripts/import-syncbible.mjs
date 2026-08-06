// Turns a syncbible translation into a MyBible module LyricVerse can read.
//
//   node scripts/import-syncbible.mjs <file|url> --name "English Standard Version"
//        [--file ESV.SQLite3] [--dest library|seed] [--lang en]
//
// syncbible publishes each translation as JSON (or as a `.js` file assigning
// that JSON to a variable), with books keyed by English name and every verse
// held as a list of word tokens. LyricVerse reads the MyBible `.SQLite3`
// format — books and verses tables — which is what the Ukrainian modules
// already installed use.
//
// Converting on the way in rather than teaching the app a second format keeps
// one reader, one search index, and one book-numbering scheme; the numbering
// in particular is what lets two translations sit side by side in a parallel
// reading, and it has to be applied somewhere regardless.
//
// `--dest library` (the default) writes into the app's own data directory, so
// the translation belongs to this machine's library. `--dest seed` writes into
// the repository's `seed/`, which is committed — only for texts that may be
// redistributed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bookNumberFor, colorFor, longNameFor, shortNameFor } from "./mybible-books.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

/**
 * Where the running app keeps a congregation's own translations.
 *
 * The same directory Tauri resolves for the app on each platform, so this
 * script keeps working now that the app is heading for Linux and Windows too.
 */
function appDataDir() {
  const id = "app.lyricverse.desktop";
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", id);
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id);
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), id);
}

const LIBRARY = join(appDataDir(), "BibleTranslations");
const SEED = join(projectRoot, "seed", "BibleTranslations");

function parseArgs(argv) {
  const [source, ...rest] = argv;
  if (!source) throw new Error("usage: import-syncbible.mjs <file|url> --name <name> [--file x.SQLite3] [--dest library|seed] [--lang en]");
  const options = { source, dest: "library" };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (!key || rest[i + 1] === undefined) throw new Error(`missing value for --${key}`);
    options[key] = rest[i + 1];
  }
  return options;
}

async function readSource(source) {
  const raw = /^https?:/.test(source)
    ? await fetch(source).then((response) => {
        if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
        return response.text();
      })
    : readFileSync(source, "utf8");

  // A `.js` file assigns the same object to a variable; take what is between
  // the first brace and the last, so a trailing semicolon or export does not
  // have to be anticipated.
  const text = raw.replace(/^﻿/, "").trim();
  if (text.startsWith("{")) return JSON.parse(text);
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) throw new Error("could not find a JSON object in the source");
  return JSON.parse(text.slice(open, close + 1));
}

/**
 * A Strong's concordance reference — "H7225", "G2316", sometimes with a
 * homograph letter after it.
 *
 * syncbible is a study tool, so its verses carry these alongside the words.
 * They are not part of the text and must not reach a screen.
 */
const STRONGS = /^[HG]\d+[a-z]?$/;

/**
 * Joins a verse's word tokens back into a sentence.
 *
 * A token is `[word]` or `[word, strongs]` — the word always first, the
 * reference always after it. Only the leading string is taken, with the
 * pattern check as a second line of defence in case a source puts one
 * somewhere else: collecting every string in the array is what produced
 * "In the beginning H7225, God H430 created H1254 …" on the projector.
 *
 * The words are then joined with spaces and tidied, since punctuation arrives
 * as tokens of its own and must not be pushed away from the word it belongs
 * to — a projector shows a stray space before a comma a foot high.
 */
function verseText(tokens) {
  const words = [];
  for (const token of tokens ?? []) {
    let word = null;
    if (typeof token === "string") {
      word = token;
    } else if (Array.isArray(token)) {
      word = token.find((part) => typeof part === "string") ?? null;
    } else if (token && typeof token === "object") {
      const value = token.text ?? token.word ?? token.t;
      if (typeof value === "string") word = value;
    }
    if (word === null || STRONGS.test(word)) continue;
    words.push(word);
  }
  return words
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?’”)\]])/g, "$1")
    .replace(/([“‘(\[])\s+/g, "$1")
    .trim();
}

const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = await readSource(options.source);
  const books = source.books;
  if (!books || typeof books !== "object") throw new Error("the source has no `books`");

  const name = options.name ?? source.versionName ?? source.version;
  if (!name) throw new Error("no --name given and the source does not name itself");
  const filename = options.file ?? `${(source.version ?? name).replace(/[^\w.-]+/g, "_")}.SQLite3`;
  const language = options.lang ?? "en";
  const dir = options.dest === "seed" ? SEED : LIBRARY;

  const statements = [
    "PRAGMA journal_mode=OFF;",
    "BEGIN;",
    "CREATE TABLE info (name TEXT, value TEXT);",
    `CREATE TABLE books (book_number NUMERIC NOT NULL, short_name TEXT NOT NULL,
        long_name TEXT NOT NULL, book_color TEXT NOT NULL, PRIMARY KEY (book_number));`,
    `CREATE TABLE verses (book_number NUMERIC NOT NULL, chapter NUMERIC NOT NULL,
        verse NUMERIC NOT NULL, text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (book_number, chapter, verse));`,
    `INSERT INTO info VALUES ('description', ${sql(name)}), ('language', ${sql(language)}),
        ('detailed_info', ${sql(`Imported from ${options.source}`)});`,
  ];

  let verses = 0;
  const unknown = [];

  for (const [bookName, chapters] of Object.entries(books)) {
    const number = bookNumberFor(bookName);
    if (!number) {
      // Named and skipped rather than guessed at: a book landing on the wrong
      // number would put the wrong passage on screen, which is worse than a
      // book that is plainly absent.
      unknown.push(bookName);
      continue;
    }
    statements.push(
      `INSERT INTO books VALUES (${number}, ${sql(shortNameFor(number))}, ${sql(longNameFor(number))}, ${sql(colorFor(number))});`,
    );

    const rows = [];
    chapters.forEach((chapter, chapterIndex) => {
      chapter.forEach((verse, verseIndex) => {
        const text = verseText(verse);
        if (!text) return;
        rows.push(`(${number},${chapterIndex + 1},${verseIndex + 1},${sql(text)})`);
        verses += 1;
      });
    });
    // Chunked so no single statement gets absurdly long for sqlite3's parser.
    for (let i = 0; i < rows.length; i += 500) {
      statements.push(`INSERT INTO verses VALUES ${rows.slice(i, i + 500).join(",")};`);
    }
  }
  statements.push("COMMIT;");

  mkdirSync(dir, { recursive: true });
  const target = join(dir, filename);
  rmSync(target, { force: true });

  const scriptPath = join(here, ".import-syncbible.sql");
  writeFileSync(scriptPath, statements.join("\n"), "utf8");
  execFileSync("sqlite3", [target], {
    input: readFileSync(scriptPath),
    stdio: ["pipe", "inherit", "inherit"],
    maxBuffer: 1 << 28,
  });
  rmSync(scriptPath, { force: true });

  // The seed folder carries a manifest naming each module; the app's own
  // library discovers files directly and needs none.
  if (options.dest === "seed") {
    const manifestPath = join(dir, "translations.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    manifest[name] = { filename };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  console.log(`[import-syncbible] ${name} → ${target}`);
  console.log(`[import-syncbible] ${verses} verses`);
  if (unknown.length > 0) {
    console.log(`[import-syncbible] skipped unknown books: ${unknown.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`[import-syncbible] ${error.message}`);
  process.exit(1);
});
