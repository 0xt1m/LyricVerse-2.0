# The library every install starts with

What is in here ships inside the app, on every platform, and is copied into the
user's own folder the first time they open it. It is tracked in git — unlike
`seed/` next door, which is whatever library this machine happens to have and
never leaves it.

Two different things, easy to confuse:

| | `seed/` | `seed-default/` |
|---|---|---|
| In git | no | yes |
| In a release build | no | yes |
| In a local `npm run tauri build` | yes | yes |

Adding a translation: put the MyBible module (`.SQLite3`) in
`BibleTranslations/` and name it in `BibleTranslations/translations.json`. A
songbook goes in `Songbooks/` with `Songbooks/songbooks.json`, the same way.
Without a manifest entry the file still ships, named after itself.

Nothing here is forced on anybody. It arrives once, recorded per file in
`.seeded.json` in the user's data folder, so a translation they delete does not
come back — and a translation added here later still reaches people who already
have the app.

**Only put files in here that may be redistributed.** They go out in every
installer, to everyone, which is a different act from having a copy on your own
machine. Public-domain text is safe; most modern translations are licensed and
are not. That is what `seed/` is for.
