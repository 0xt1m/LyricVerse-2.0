# Changelog

## 2.2.3

The service plan grows up, scripture gets the numbering and the references it
should always have had, and your phone becomes a remote control.

### Control the screens from your phone

Settings → **Phone remote** turns on a small server on this machine. Open the
address it gives you on any phone or tablet on the same wifi, type the
six-digit code, and you can drive the service from your hand.

- **Live** — the song's sections or the chapter's verses, colour-coded as on
  the console, with the live one highlighted; tap any of them to jump there.
- **Songs** — pick a songbook, search by number, title or first line, tap to
  show.
- **Bible** — translation, book, chapter, verse; tap a verse to put it up.
- **Slides** — your presentation decks by name; tap one to show it.
- Back, Hide and Next sit along the bottom edge, thumb-sized, wherever you are
  in the app. On a tablet they move into a side column so the list runs full
  height.

Each device has to type the code before it can do anything, wrong codes are
rate-limited, and "New code" unpairs everything using the old one. The remote
never decides how a slide looks — it names what it wants, and the console
builds it with the settings in front of it.

### Service plans

- **Durations.** Give any item a length, and the plan adds them up. Set a
  service start time and every item shows the clock time it is due at.
- **Folders and items.** Add a folder ("Worship", "Communion") or a plain line
  ("Sermon", "Notices"). Drag items into folders, out again, and into other
  folders; fold a folder away when you are not in it; rename either from the
  right-click menu.
- **Multi-select.** ⌘-click, ⌘A, or drag a box over the rows; move the
  selection as one; delete it with the Delete key or from the menu.
- **Click, then click again.** One click selects a line, a second puts it on
  the screens — with a background that leaves no doubt which one is live.
- **Timers.** An item with a duration loads the timer at the top of the window
  ready to start, without starting it.
- The plan you closed the app on is the one that opens with it, and a Bible
  item opens at exactly the verse it names.

### Scripture

- **The Psalms line up.** Hebrew and Greek numbering disagree from Psalm 9 to
  147, which used to put two different psalms side by side in a parallel
  reading. Now every verse is matched to the verse that actually says the same
  thing, both references are shown, and a verse split or merged between the
  traditions lands on one slide carrying both. Verified against the real
  modules: every verse of all 150 psalms round-trips.
- **Where the references go.** A new per-screen setting: keep them in the
  Reference box, or put each one directly under the passage it belongs to. The
  layout editor previews the choice, and the Reference box disappears when it
  is not being used. The reference sits clearly on the plate rather than
  looking printed underneath it.

### Songs

A song is now written in one place: a dialog with the words on the left and the
sections they make on the right, updating as you type. It opens from **+ → New
song**, from **Edit**, from right-clicking a song, or by pressing **E**.

- **Paste a whole song in** — from a website or anywhere else — and it is cut
  into sections, with a chorus written out three times folded back into one
  section sung three times.
- **Buttons for the parts**: Verse, Chorus, Bridge, Section drop a heading in
  at the caret, numbering verses as they go. **Split** cuts the part the caret
  is in, in two.
- **Arrange by dragging** the section tiles, or from their buttons and
  right-click menu: move, duplicate, delete.
- **⌘Z undoes** anything in there — including a drag or a delete, which no
  browser can undo on its own.
- **Key, tempo and duration** are set in the same dialog. The key is a picker
  with an *m* switch for minor; the key and tempo show as badges in the song
  list, and the duration becomes the item's length when the song goes into a
  plan.
- **Drag to reorder** songs in a songbook, with a button to restore number
  order. **Delete** removes the selected songs.
- The slide grid in the tab is now purely a preview and a way to drive: one
  click selects, a second — or **Enter** — puts it on the screens.
- Right-click the songs or presentations list to add a new one, and a fresh
  install starts with a songbook called **001** so there is somewhere to put
  the first song.

### Displays and the console

- The projection window fills the screen properly, with the macOS menu bar out
  of the way.
- The confidence screen shows the next slide as well as the current one.
- Every tab remembers where it was — the passage, the song, the deck, and even
  which screen and element you were editing.
- Backgrounds apply to every mode automatically, so the button that said so is
  gone.
- **Escape hides and only hides.** Pressed twice in a hurry it can no longer
  put the wrong thing back in front of the room. **B** is still the toggle.
- **The Camera tab can be switched off** — in the View menu or Settings — for a
  hall that has no camera. It leaves the ⌘-number order in step behind it.
- **Update now.** When a new version has been downloaded, the message offering
  it carries a button rather than waiting for you to quit.
- A Bible verse, like a song section, takes one click to choose and a second —
  or Enter — to show.

### Fixes

- One press of Next moved two slides on the remote: the console was carrying
  out every command twice.
- Selecting plan lines with a drag no longer grabs the first row the moment the
  drag begins, and a box that catches nothing leaves the selection alone.
- The plan keeps what you had selected when you look at History and come back.
- Empty durations and notes can be saved again — clearing one now removes it.
- A double hairline where the plan panel meets the slide strip.
- Assorted cramped and misaligned spots: the plan rows, the song row badges,
  the settings panels.
