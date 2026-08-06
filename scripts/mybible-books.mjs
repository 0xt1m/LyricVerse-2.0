// The MyBible book scheme, shared by every script that writes a module.
//
// Kept in one place on purpose: two scripts each carrying their own copy of
// this table is two chances for a translation to be numbered differently from
// the ones beside it, which is exactly what breaks a parallel reading.

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


/**
 * Book names as other people write them, mapped to MyBible numbers.
 *
 * Sources disagree about a handful of names — "Revelation of John" against
 * "Revelation", "Song of Solomon" against "Song of Songs" — so the long and
 * short names from the table above are indexed alongside a few known variants
 * rather than each importer inventing its own fuzzy match.
 */
const ALIASES = {
  "revelation of john": 730,
  revelation: 730,
  "song of solomon": 260,
  "song of songs": 260,
  canticles: 260,
  psalm: 230,
  psalms: 230,
  ecclesiastes: 250,
  "acts of the apostles": 510,
  acts: 510,
  "1 esdras": 0,
};

const index = new Map();
for (const [number, shortName, longName] of BOOKS) {
  index.set(longName.toLowerCase(), number);
  index.set(shortName.toLowerCase(), number);
}
for (const [name, number] of Object.entries(ALIASES)) {
  if (number) index.set(name, number);
}

/**
 * Roman numerals as a leading ordinal — "I Samuel", "III John".
 *
 * Several sources number the paired books this way where MyBible uses digits.
 * Left unhandled it silently drops seventeen books, which is not a gap anyone
 * notices until a reading is called for on a Sunday.
 */
const ROMAN = { i: "1", ii: "2", iii: "3" };

/** The MyBible number for a book name, or null when it is not one we know. */
export function bookNumberFor(name) {
  const key = String(name).trim().toLowerCase().replace(/\s+/g, " ");
  const direct = index.get(key);
  if (direct) return direct;

  const ordinal = key.match(/^(i{1,3})\s+(.+)$/);
  if (ordinal) {
    const digits = ROMAN[ordinal[1]];
    if (digits) return index.get(`${digits} ${ordinal[2]}`) ?? null;
  }
  return null;
}

export function longNameFor(number) {
  return BOOKS.find(([n]) => n === number)?.[2] ?? String(number);
}

export function shortNameFor(number) {
  return BOOKS.find(([n]) => n === number)?.[1] ?? String(number);
}

export { BOOKS, colorFor };
