// Builds an English MyBible module from a public-domain Bible text.
//
// LyricVerse reads the MyBible `.SQLite3` format (books + verses tables). No
// canonical English module ships with the app, so this generates one from the
// King James Version — public domain — and numbers the books using the exact
// `book_number` scheme taken from the Ukrainian modules already installed, so
// cross-translation references line up.
//
//   node scripts/build-english-bible.mjs
//
// Writes seed/BibleTranslations/KJV.SQLite3 and registers
// it in that folder's translations.json.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
// Written into the project's own seed directory, not the staging copy, so it
// survives a clean of src-tauri/resources and travels with the folder.
const seedDir = join(projectRoot, "seed", "BibleTranslations");

const SOURCE =
  "https://raw.githubusercontent.com/thiagobodruk/bible/master/json/en_kjv.json";
const TRANSLATION_NAME = "King James Version";
const FILENAME = "KJV.SQLite3";

/**
 * MyBible's book_number scheme (Genesis 10, Exodus 20, … Revelation 730).
 * Verified against the Ogienko modules: 670=1 Peter, 690=1 John, 730=Revelation.
 * Listed explicitly rather than derived, so the mapping is auditable.
 */
const BOOKS = [
  [10, "Gen", "Genesis"], [20, "Exo", "Exodus"], [30, "Lev", "Leviticus"],
  [40, "Num", "Numbers"], [50, "Deu", "Deuteronomy"], [60, "Jos", "Joshua"],
  [70, "Jdg", "Judges"], [80, "Rut", "Ruth"], [90, "1Sa", "1 Samuel"],
  [100, "2Sa", "2 Samuel"], [110, "1Ki", "1 Kings"], [120, "2Ki", "2 Kings"],
  [130, "1Ch", "1 Chronicles"], [140, "2Ch", "2 Chronicles"], [150, "Ezr", "Ezra"],
  [160, "Neh", "Nehemiah"], [190, "Est", "Esther"], [220, "Job", "Job"],
  [230, "Psa", "Psalms"], [240, "Pro", "Proverbs"], [250, "Ecc", "Ecclesiastes"],
  [260, "Sng", "Song of Solomon"], [290, "Isa", "Isaiah"], [300, "Jer", "Jeremiah"],
  [310, "Lam", "Lamentations"], [330, "Eze", "Ezekiel"], [340, "Dan", "Daniel"],
  [350, "Hos", "Hosea"], [360, "Joe", "Joel"], [370, "Amo", "Amos"],
  [380, "Oba", "Obadiah"], [390, "Jon", "Jonah"], [400, "Mic", "Micah"],
  [410, "Nah", "Nahum"], [420, "Hab", "Habakkuk"], [430, "Zep", "Zephaniah"],
  [440, "Hag", "Haggai"], [450, "Zec", "Zechariah"], [460, "Mal", "Malachi"],
  [470, "Mat", "Matthew"], [480, "Mar", "Mark"], [490, "Luk", "Luke"],
  [500, "Joh", "John"], [510, "Act", "Acts"], [520, "Rom", "Romans"],
  [530, "1Co", "1 Corinthians"], [540, "2Co", "2 Corinthians"], [550, "Gal", "Galatians"],
  [560, "Eph", "Ephesians"], [570, "Php", "Philippians"], [580, "Col", "Colossians"],
  [590, "1Th", "1 Thessalonians"], [600, "2Th", "2 Thessalonians"], [610, "1Ti", "1 Timothy"],
  [620, "2Ti", "2 Timothy"], [630, "Tit", "Titus"], [640, "Phm", "Philemon"],
  [650, "Heb", "Hebrews"], [660, "Jas", "James"], [670, "1Pe", "1 Peter"],
  [680, "2Pe", "2 Peter"], [690, "1Jn", "1 John"], [700, "2Jn", "2 John"],
  [710, "3Jn", "3 John"], [720, "Jud", "Jude"], [730, "Rev", "Revelation"],
];

/** MyBible colours books by section; matches the Ogienko modules' palette. */
const colorFor = (n) =>
  n <= 50 ? "#ccccff" : n <= 160 ? "#ffcc99" : n <= 260 ? "#ffff99" :
  n <= 460 ? "#99ff99" : n <= 500 ? "#ff9999" : n <= 510 ? "#ffff99" : "#ffcccc";

const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function fetchSource() {
  const cache = join(here, ".cache-en_kjv.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));

  console.log(`[build-english-bible] downloading ${SOURCE}`);
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  // The file is served as latin-1-ish; decode explicitly so curly quotes and
  // the occasional accented name survive.
  const raw = new TextDecoder("utf-8").decode(await response.arrayBuffer());
  const parsed = JSON.parse(raw.replace(/^﻿/, ""));
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify(parsed), "utf8");
  return parsed;
}

async function main() {
  const source = await fetchSource();
  if (!Array.isArray(source) || source.length !== BOOKS.length) {
    throw new Error(`expected ${BOOKS.length} books, got ${source?.length}`);
  }

  const statements = [
    "PRAGMA journal_mode=OFF;",
    "BEGIN;",
    `CREATE TABLE info (name TEXT, value TEXT);`,
    `CREATE TABLE books (book_number NUMERIC NOT NULL, short_name TEXT NOT NULL,
        long_name TEXT NOT NULL, book_color TEXT NOT NULL, PRIMARY KEY (book_number));`,
    `CREATE TABLE verses (book_number NUMERIC NOT NULL, chapter NUMERIC NOT NULL,
        verse NUMERIC NOT NULL, text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (book_number, chapter, verse));`,
    `INSERT INTO info VALUES ('description', ${sql(TRANSLATION_NAME)}),
        ('language', 'en'), ('detailed_info', 'King James Version — public domain.');`,
  ];

  let verseCount = 0;
  BOOKS.forEach(([number, shortName, longName], index) => {
    statements.push(
      `INSERT INTO books VALUES (${number}, ${sql(shortName)}, ${sql(longName)}, ${sql(colorFor(number))});`,
    );
    const chapters = source[index].chapters;
    if (!Array.isArray(chapters)) throw new Error(`${longName}: no chapters`);

    const rows = [];
    chapters.forEach((verses, chapterIndex) => {
      verses.forEach((text, verseIndex) => {
        const clean = String(text).replace(/\s+/g, " ").trim();
        if (!clean) return;
        rows.push(`(${number},${chapterIndex + 1},${verseIndex + 1},${sql(clean)})`);
        verseCount += 1;
      });
    });
    // Chunked so no single statement gets absurdly long for sqlite3's parser.
    for (let i = 0; i < rows.length; i += 500) {
      statements.push(`INSERT INTO verses VALUES ${rows.slice(i, i + 500).join(",")};`);
    }
  });
  statements.push("COMMIT;");

  mkdirSync(seedDir, { recursive: true });
  const target = join(seedDir, FILENAME);
  rmSync(target, { force: true });

  const scriptPath = join(here, ".build-en-bible.sql");
  writeFileSync(scriptPath, statements.join("\n"), "utf8");
  execFileSync("sqlite3", [target], { input: readFileSync(scriptPath), stdio: ["pipe", "inherit", "inherit"] });
  rmSync(scriptPath, { force: true });

  // Register it beside the Ukrainian modules.
  const manifestPath = join(seedDir, "translations.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  manifest[TRANSLATION_NAME] = { filename: FILENAME };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `[build-english-bible] wrote ${FILENAME}: ${BOOKS.length} books, ${verseCount} verses`,
  );
}

main().catch((error) => {
  console.error("[build-english-bible] failed:", error.message);
  process.exit(1);
});
