// Copies the seed data (songbooks + MyBible translations) shipped with the app
// into src-tauri/resources so Tauri can bundle it.
//
// The source is this project's own `seed/` directory, so the folder is
// self-contained and can be moved or cloned on its own. The v1 tree next door
// is still read as a fallback, for a checkout that predates `seed/`.
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const repoRoot = resolve(projectRoot, "..");
const legacyRoot = join(repoRoot, "LyricVerse");
/** This project's own copy — the source of truth. */
const localSeed = join(projectRoot, "seed");
/**
 * The library every install starts with: tracked in git, and shipped even by a
 * release, which `seed/` deliberately is not. Only redistributable text
 * belongs here — see seed-default/README.md.
 */
const defaultSeed = join(projectRoot, "seed-default");
const seedRoot = join(projectRoot, "src-tauri", "resources", "seed");

/** Prefers the local copy, and falls back to the v1 tree beside it. */
function sourceDir(local, legacy) {
  const mine = join(localSeed, local);
  return existsSync(mine) ? mine : join(legacyRoot, legacy);
}

const SONGBOOK_EXT = [".db"];
const TRANSLATION_EXT = [".sqlite3", ".sqlite", ".db"];

async function copyMatching(fromDir, toDir, extensions, { skip = [] } = {}) {
  if (!existsSync(fromDir)) return [];
  await mkdir(toDir, { recursive: true });
  const copied = [];
  for (const name of await readdir(fromDir)) {
    if (skip.includes(name)) continue;
    const lower = name.toLowerCase();
    if (!extensions.some((ext) => lower.endsWith(ext))) continue;
    const src = join(fromDir, name);
    if (!(await stat(src)).isFile()) continue;
    await cp(src, join(toDir, name));
    copied.push(name);
  }
  return copied;
}

/**
 * Keep this machine's own library out of the build.
 *
 * Songbooks and Bible translations belong to a congregation, not to the
 * program: they are often licensed text that must not be redistributed, and a
 * fresh install is expected to be filled from Settings. CI sets this, so it
 * holds even when a release is built on a machine whose own `seed/` is full.
 *
 * It does not touch `seed-default/`, which is the small set chosen to go out
 * to everybody and is in git for exactly that reason.
 */
const emptyRelease = process.env.LYRICVERSE_EMPTY_SEED === "1";

async function main() {
  // Cleared, not merged into. Whatever a previous run staged is not evidence
  // of what this one should ship — a translation removed from `seed/`, or a
  // build switched to an empty release, would otherwise leave the old file
  // sitting in the bundle.
  await rm(seedRoot, { recursive: true, force: true });
  await mkdir(seedRoot, { recursive: true });

  // The default library first, so that when a name collides it is the chosen
  // file that ships and this machine's copy of the same translation that is
  // passed over — not whichever happened to be copied last.
  const songbooks = await copyMatching(
    join(defaultSeed, "Songbooks"),
    join(seedRoot, "Songbooks"),
    SONGBOOK_EXT,
  );
  const translations = await copyMatching(
    join(defaultSeed, "BibleTranslations"),
    join(seedRoot, "BibleTranslations"),
    TRANSLATION_EXT,
  );

  if (emptyRelease) {
    console.log(
      "[prepare-resources] LYRICVERSE_EMPTY_SEED=1 — this machine's own seed/ is not being shipped.",
    );
  } else {
    songbooks.push(
      ...(await copyMatching(
        sourceDir("Songbooks", "Songbooks"),
        join(seedRoot, "Songbooks"),
        SONGBOOK_EXT,
        { skip: songbooks },
      )),
    );
    // `1.SQLite3` is an unnamed leftover in the v1 tree — it is not referenced by
    // bible_translations.json, so it is not worth ~14 MB of bundle.
    translations.push(
      ...(await copyMatching(
        sourceDir("BibleTranslations", "bible_translations"),
        join(seedRoot, "BibleTranslations"),
        TRANSLATION_EXT,
        { skip: ["1.SQLite3", ...translations] },
      )),
    );
  }

  // Note: no Bible module is generated here any more. Releases ship with no
  // scripture and no songbooks at all — see `emptyRelease` below — and the
  // generator needed the network and the `sqlite3` CLI, neither of which a
  // Windows runner has. `npm run build-english-bible` still builds one by hand
  // for anyone who wants it locally.

  for (const [dir, files, jsonName] of [
    [join(seedRoot, "Songbooks"), songbooks, "songbooks.json"],
    [join(seedRoot, "BibleTranslations"), translations, "translations.json"],
  ]) {
    if (!files.length) continue;
    // Merge, never replace: the manifest may already hold generated entries
    // (the KJV module) that have no counterpart in the seed directory.
    const manifestPath = join(dir, jsonName);
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : {};
    const known = new Set(Object.values(manifest).map((entry) => entry?.filename));
    // Seeded entries are named after the v1 manifest when one exists,
    // otherwise after the filename.
    const legacyManifest = readLegacyManifest(jsonName);
    for (const filename of files.sort()) {
      if (known.has(filename)) continue;
      const name = legacyManifest.get(filename) ?? filename.replace(/\.[^.]+$/, "");
      manifest[name] = { filename };
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  // Keep an always-present marker so the Tauri `resources` glob never resolves
  // to zero files (which makes the bundler error out).
  await writeFile(
    join(seedRoot, "SEED_INFO.json"),
    JSON.stringify(
      { songbooks, translations, generatedBy: "scripts/prepare-resources.mjs" },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(
    `[prepare-resources] ${songbooks.length} songbook(s), ${translations.length} translation(s) staged in src-tauri/resources/seed`,
  );
  if (!songbooks.length && !translations.length) {
    console.log("[prepare-resources] no seed data found — the app will start empty.");
  }
}

/**
 * name -> filename mappings from the manifests beside the data files, inverted
 * to filename -> name, so a staged file is registered under the name somebody
 * chose for it rather than whatever its file is called.
 *
 * In order of authority: the default library, this machine's own seed, then
 * the v1 tree. First to name a file wins — the one nearest to hand is the one
 * that was meant.
 */
function readLegacyManifest(jsonName) {
  const candidates =
    jsonName === "songbooks.json"
      ? [
          join(defaultSeed, "Songbooks", "songbooks.json"),
          join(localSeed, "Songbooks", "songbooks.json"),
          join(legacyRoot, "Songbooks", "songbooks.json"),
        ]
      : [
          join(defaultSeed, "BibleTranslations", "translations.json"),
          join(localSeed, "BibleTranslations", "translations.json"),
          join(localSeed, "BibleTranslations", "bible_translations.json"),
          join(legacyRoot, "bible_translations", "bible_translations.json"),
        ];
  const out = new Map();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      for (const [name, value] of Object.entries(parsed)) {
        if (value && typeof value.filename === "string" && !out.has(value.filename)) {
          out.set(value.filename, name);
        }
      }
    } catch {
      /* a malformed manifest just means we fall back to filenames */
    }
  }
  return out;
}

main().catch((err) => {
  console.error("[prepare-resources] failed:", err);
  process.exit(1);
});
