//! What is currently on the screens.
//!
//! Held in the backend rather than in the operator window so a projection
//! window that opens (or reloads) mid-service immediately renders the right
//! thing instead of coming up blank.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveKind {
    Blank,
    Song,
    Bible,
    /// A presentation slide — the whole screen is one image.
    Image,
    /// A clip, either an imported file or a YouTube link.
    Video,
    /// The countdown, shown full screen in its own right.
    Timer,
    /// A slide of words typed in the app — an announcement, a notice. Drawn
    /// with the Slides layout, since that is where it lives.
    Message,
    /// A live camera on this machine, filling the screen.
    ///
    /// Unlike everything else here, the picture never travels: each projection
    /// window opens the camera itself. A browser screen on another device
    /// cannot, and says so rather than sitting blank.
    Camera,
}

/// One field per layout element. A display draws whichever of these its layout
/// says to show, so turning the song number on for the stream screen and off
/// for the projector needs no extra plumbing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    pub kind: LiveKind,
    /// The section or passage on screen.
    pub body_part: String,
    /// Song title, or the book name for scripture.
    pub title: String,
    /// Song number, or the verse number for scripture.
    pub number: String,
    /// "Куплет 2" / "Chorus".
    pub section_label: String,
    /// "Івана 3:16".
    pub reference: String,
    /// The translation's name.
    pub translation: String,
    /// Each translation's words with its own reference, in the order they are
    /// stacked on screen.
    ///
    /// `body_part` holds the same words run together, which is what a screen
    /// showing one translation needs. This is what a screen putting each
    /// reference under its own passage needs, and only the display knows
    /// which of the two it is.
    pub passages: Vec<Passage>,
    /// The slide queued after this one. A confidence screen exists to show it.
    pub next_up: String,
    /// The picture on that queued slide, when it has one instead of words —
    /// a deck of slides is what a confidence screen struggles with otherwise,
    /// since "coming next" is an image nobody can describe in a line of text.
    pub next_media_path: Option<String>,
    /// "verse" | "chorus" | "bridge" | "other" | "scripture" — drives the
    /// operator-side colour coding.
    pub section_kind: String,
    /// Absolute path of the image or video to fill the screen with.
    pub media_path: Option<String>,
    /// YouTube video id, when the live item is a link rather than a file.
    pub youtube_id: Option<String>,
    /// Which camera to open, as the browser's device id. Empty means whichever
    /// one the system offers first, which is right for a machine with one.
    pub camera_device_id: Option<String>,
    /// Bumped on every change so displays can ignore stale events.
    pub revision: u64,
}

impl Default for LiveState {
    fn default() -> Self {
        Self {
            kind: LiveKind::Blank,
            body_part: String::new(),
            title: String::new(),
            number: String::new(),
            section_label: String::new(),
            reference: String::new(),
            translation: String::new(),
            passages: Vec::new(),
            next_up: String::new(),
            next_media_path: None,
            section_kind: String::new(),
            media_path: None,
            youtube_id: None,
            camera_device_id: None,
            revision: 0,
        }
    }
}

/// Payload the frontend sends; `revision` is assigned by the backend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveInput {
    pub kind: LiveKind,
    #[serde(default)]
    pub body_part: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub number: String,
    #[serde(default)]
    pub section_label: String,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub passages: Vec<Passage>,
    #[serde(default)]
    pub next_up: String,
    #[serde(default)]
    pub next_media_path: Option<String>,
    #[serde(default)]
    pub section_kind: String,
    #[serde(default)]
    pub media_path: Option<String>,
    #[serde(default)]
    pub camera_device_id: Option<String>,
    #[serde(default)]
    pub youtube_id: Option<String>,
}


/// One translation's words on a slide, with the reference for those words in
/// that translation's own numbering.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub text: String,
    /// "Псалми 22:1" — empty when there is nothing worth naming.
    #[serde(default)]
    pub reference: String,
}

/// A countdown, count-up or wall clock, drawn by the `timer` layout element.
///
/// Kept apart from [`LiveState`] on purpose: a countdown to the start of the
/// service has to keep running while the operator moves between songs, and
/// each display ticks it locally from the anchor rather than the backend
/// pushing an event every second.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimerMode {
    /// Counts down to zero and then keeps going negative, so an overrun is
    /// visible rather than the display simply freezing at 00:00.
    Countdown,
    CountUp,
    /// The time of day.
    Clock,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub mode: TimerMode,
    /// Shown above or beside the digits, e.g. "Служба починається за".
    #[serde(default)]
    pub label: String,
    /// Epoch milliseconds: when a countdown reaches zero, or when a count-up
    /// began. Ignored in clock mode.
    #[serde(default)]
    pub anchor_ms: i64,
    /// Milliseconds left (countdown) or elapsed (count-up) while paused.
    #[serde(default)]
    pub frozen_ms: i64,
    /// What the countdown was set to. Kept so Reset works from anywhere,
    /// rather than only from the tab that happens to hold the spinner value.
    #[serde(default)]
    pub duration_ms: i64,
    pub running: bool,
    /// Hide the digits once a countdown passes zero.
    #[serde(default)]
    pub hide_when_finished: bool,

    /// Colour once a countdown has passed zero and is counting up in the
    /// negative. Overrides the layout element's colour, on every screen.
    pub overrun_color: String,
    /// Seconds left at which the digits switch to `warn_color`. 0 disables it.
    #[serde(default)]
    pub warn_at_seconds: i64,
    pub warn_color: String,
}

impl Default for Timer {
    fn default() -> Self {
        Self {
            mode: TimerMode::Countdown,
            label: String::new(),
            anchor_ms: 0,
            frozen_ms: 0,
            duration_ms: 0,
            running: false,
            hide_when_finished: false,
            overrun_color: "#e5484d".into(),
            warn_at_seconds: 60,
            warn_color: "#f0a83a".into(),
        }
    }
}

/// How the clip on screen should be playing.
///
/// The console is the authority; every display follows. Position travels as an
/// anchor rather than a ticking number for the same reason the timer does — a
/// clip must not need an IPC message per frame to stay in step, and a window
/// that opens halfway through has to be able to work out where it is.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    pub playing: bool,
    pub muted: bool,
    /// Start again at the end — for a loop behind the words.
    #[serde(default)]
    pub looping: bool,
    /// Where the clip was, in milliseconds, at `anchor_ms`.
    #[serde(default)]
    pub position_ms: f64,
    /// Epoch milliseconds when `position_ms` was stamped.
    #[serde(default)]
    pub anchor_ms: f64,
    /// Bumped on every command so a display can tell a fresh instruction from
    /// a repeat of one it has already carried out.
    #[serde(default)]
    pub revision: u64,
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            // A clip put on screen starts playing; that is what putting it on
            // screen means.
            playing: true,
            muted: false,
            looping: false,
            position_ms: 0.0,
            anchor_ms: 0.0,
            revision: 0,
        }
    }
}
