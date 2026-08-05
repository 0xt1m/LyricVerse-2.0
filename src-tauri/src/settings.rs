use std::collections::BTreeMap;
use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;
use crate::paths;

pub const SETTINGS_VERSION: u32 = 19;

pub const PRESET_STANDARD: &str = "standard";
pub const PRESET_STREAM: &str = "stream";
pub const PRESET_CONFIDENCE: &str = "confidence";

/// Every geometry value in here is a **percentage of the target screen**, not a
/// pixel count. v1 stored absolute pixels (`info_position: {x: 1400, y: 950}`),
/// which silently mis-positioned everything the moment a projector ran at a
/// different resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub language: String,
    pub active_songbook: Option<String>,
    pub active_translation: Option<String>,
    /// Shown beneath the main translation, in this order. Lets a bilingual
    /// congregation read the same verse in both languages at once.
    pub secondary_translations: Vec<String>,
    /// Blank the output when the operator switches songs, so nothing leaks.
    pub blank_on_switch: bool,
    /// Parts of the window the operator can put away. All default to shown.
    pub show_status_bar: bool,
    pub show_preview: bool,
    pub show_filmstrip: bool,
    /// The preview-and-history panel on the content tabs.
    pub show_side_panel: bool,
    /// Which edge that panel is docked to: "right" or "bottom". A string
    /// rather than an enum so an unknown value from a newer build degrades to
    /// the default instead of refusing to parse the whole settings file.
    pub side_panel_placement: String,
    /// How big the operator has dragged that panel, per edge. Kept as two
    /// numbers rather than one so switching edges restores the size that edge
    /// had, instead of reusing a width as a height.
    pub side_panel_width: f64,
    pub side_panel_height: f64,
    /// Named looks. A screen points at one; several screens may share it.
    pub presets: Vec<Preset>,
    /// Keyed by screen id — monitors and web screens alike, so a browser
    /// screen picks its preset through exactly the same machinery.
    pub displays: BTreeMap<String, DisplayConfig>,
    /// Screens served over the network rather than driven by a cable.
    pub web_screens: Vec<WebScreen>,
    /// Which sound device audio and video go out of. Empty means the system
    /// default — the browser device id otherwise, which is stable per machine.
    pub audio_device_id: String,
    /// 0..1, applied to tracks and clips alike.
    pub audio_volume: f64,
    /// Song ids marked as favourites, keyed by songbook name.
    ///
    /// Kept here rather than in the songbook itself: those files are the v1
    /// format and are still opened by the old app, so growing a column in one
    /// would be a change the other cannot read.
    pub favourite_songs: BTreeMap<String, Vec<i64>>,
    /// Sort the song list with favourites at the top.
    pub favourites_first: bool,
    /// The background picker's grid, in the order the operator arranged it.
    ///
    /// Entries are either a flat colour (`#rrggbb`) or the file name of an
    /// imported picture or clip — one list, because the two are shuffled
    /// together in the same grid. Shared across presets, like the files
    /// themselves: a colour added while setting up one preset is there for
    /// every other one too.
    pub background_order: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            language: "uk".into(),
            active_songbook: None,
            active_translation: None,
            secondary_translations: Vec::new(),
            blank_on_switch: false,
            show_status_bar: true,
            show_preview: true,
            show_filmstrip: true,
            show_side_panel: true,
            side_panel_placement: "right".into(),
            side_panel_width: 268.0,
            side_panel_height: 208.0,
            presets: builtin_presets(),
            displays: BTreeMap::new(),
            web_screens: Vec::new(),
            audio_device_id: String::new(),
            audio_volume: 1.0,
            favourite_songs: BTreeMap::new(),
            favourites_first: false,
            background_order: default_palette(),
        }
    }
}

/// What the picker offers before anyone adds anything: the colours the
/// built-in presets themselves use, plus white for a lit room.
fn default_palette() -> Vec<String> {
    ["#000000", "#08090b", "#101820", "#1b2430", "#ffffff", "#00ff00"]
        .iter()
        .map(|c| c.to_string())
        .collect()
}

/// A screen an operator adds by hand, reached by opening a URL in a browser.
///
/// It has no size of its own — whatever device opens it decides that — so
/// unlike a monitor there is nothing here to enumerate, only what to call it
/// and which port to answer on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebScreen {
    pub id: String,
    pub name: String,
    pub port: u16,
}

impl Default for WebScreen {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), port: crate::webscreen::DEFAULT_PORT }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DisplayConfig {
    /// Whether a projection window is opened on this screen at all.
    pub enabled: bool,
    /// Id of the preset this screen renders with.
    pub preset: String,
    /// What the operator calls this screen. Empty means the name the system
    /// gives it — kept as the fallback rather than copied in, so a monitor
    /// that is never renamed still follows whatever the OS reports.
    pub name: String,
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self { enabled: false, preset: PRESET_STANDARD.into(), name: String::new() }
    }
}

/// A complete look: backdrop, behaviour, and a layout for each content type.
///
/// v2 hard-coded exactly two of these as a `mode` enum. They were only ever
/// two points in the same space — a projector look and a lower-third look — so
/// they are now just the first entries in an editable list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preset {
    pub id: String,
    pub name: String,
    /// Ships with the app: can be edited and reset, but not deleted.
    pub builtin: bool,

    /// Keep the backdrop identical when blanked. A chroma-key fill must not
    /// change colour, or the video switcher's key breaks mid-service.
    pub constant_background: bool,
    /// Ignore the line breaks in the source text and let the words wrap to
    /// the box instead. Songbooks and Bible modules break lines to suit the
    /// page they were typeset for, which rarely suits a projector.
    pub collapse_line_breaks: bool,

    pub background: String,
    /// File name inside the Backgrounds folder — an image or a video.
    pub background_media: Option<String>,
    /// How the media fills the screen: "cover" | "contain" | "fill".
    pub background_fit: String,
    /// Darkens the media so text stays legible, 0–100%.
    pub background_dim: f64,

    /// The same, for when the output is blanked.
    pub passive_background: String,
    pub passive_background_media: Option<String>,
    pub passive_background_fit: String,
    pub passive_background_dim: f64,

    pub song: Layout,
    pub bible: Layout,
    /// Presentation slides and video. The picture fills the screen, so this
    /// layout only carries what may sit *over* it.
    pub media: Layout,
    /// The countdown shown as the content in its own right — a foyer screen
    /// counting down to the start, rather than a corner overlay.
    pub timer: Layout,
}

impl Default for Preset {
    fn default() -> Self {
        Self {
            id: PRESET_STANDARD.into(),
            name: "Standard".into(),
            builtin: false,
            constant_background: false,
            collapse_line_breaks: true,
            background: "#000000".into(),
            background_media: None,
            background_fit: "cover".into(),
            background_dim: 0.0,
            passive_background: "#000000".into(),
            passive_background_media: None,
            passive_background_fit: "cover".into(),
            passive_background_dim: 0.0,
            song: Layout::song_standard(),
            bible: Layout::bible_standard(),
            media: Layout::media_default(),
            timer: Layout::timer_default(),
        }
    }
}

pub fn builtin_presets() -> Vec<Preset> {
    vec![
        // A projector or stage screen: the words, full bleed, on black.
        Preset {
            id: PRESET_STANDARD.into(),
            name: "Standard".into(),
            builtin: true,
            ..Preset::default()
        },
        // A lower-third band over a key colour, one line at a time.
        Preset {
            id: PRESET_STREAM.into(),
            name: "Stream".into(),
            builtin: true,
            constant_background: true,
            background: "#00ff00".into(),
            passive_background: "#00ff00".into(),
            song: Layout::song_stream(),
            bible: Layout::bible_stream(),
            ..Preset::default()
        },
        // Facing the platform: what is up now, what is next, and where we are.
        Preset {
            id: PRESET_CONFIDENCE.into(),
            name: "Confidence".into(),
            builtin: true,
            background: "#08090b".into(),
            passive_background: "#08090b".into(),
            song: Layout::song_confidence(),
            bible: Layout::bible_confidence(),
            ..Preset::default()
        },
    ]
}

/// The pieces of text that can appear on screen. A layout holds one entry per
/// id; hidden ones keep their geometry so toggling them back restores position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ElementId {
    /// The lyrics or the passage itself.
    Body,
    /// Song title, or the book name for scripture.
    Title,
    /// Song number, or the verse number for scripture.
    Number,
    /// "Куплет 2" / "Chorus".
    SectionLabel,
    /// "Івана 3:16".
    Reference,
    /// The translation's name.
    Translation,
    /// What the operator will show next — the point of a confidence screen.
    NextUp,
    /// A countdown, count-up or clock, ticked locally by each display.
    Timer,
}

pub const SONG_ELEMENTS: [ElementId; 6] = [
    ElementId::Body,
    ElementId::Title,
    ElementId::Number,
    ElementId::SectionLabel,
    ElementId::NextUp,
    ElementId::Timer,
];

/// A picture or a clip fills the screen by itself, so the only things here
/// are the words of a typed message slide and the timer that may overlay
/// either. Anything more would be drawing text over someone's artwork.
pub const MEDIA_ELEMENTS: [ElementId; 2] = [ElementId::Body, ElementId::Timer];

/// The timer as the content itself: the digits, plus a line of text under
/// them for "Doors open at 10" and the like.
pub const TIMER_ELEMENTS: [ElementId; 2] = [ElementId::Timer, ElementId::Body];

pub const BIBLE_ELEMENTS: [ElementId; 6] = [
    ElementId::Body,
    ElementId::Reference,
    ElementId::Number,
    ElementId::Translation,
    ElementId::NextUp,
    ElementId::Timer,
];

/// A timer box that sits out of the way until it is switched on.
fn timer_element() -> Element {
    Element {
        visible: false,
        rect: Rect { x: 30.0, y: 40.0, width: 40.0, height: 20.0 },
        font_weight: 700,
        ..Element::labelled(ElementId::Timer, "center")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    /// Draw order — later entries sit on top. The editor reorders this list.
    pub elements: Vec<Element>,
}

impl Default for Layout {
    fn default() -> Self {
        Self::song_standard()
    }
}

impl Layout {
    fn song_standard() -> Self {
        Self {
            elements: vec![
                Element::body(Rect { x: 5.0, y: 9.0, width: 90.0, height: 74.0 }),
                Element {
                    visible: false,
                    rect: Rect { x: 5.0, y: 1.5, width: 90.0, height: 6.0 },
                    ..Element::labelled(ElementId::Title, "center")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 1.5, y: 1.5, width: 12.0, height: 6.0 },
                    ..Element::labelled(ElementId::Number, "left")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 5.0, y: 86.0, width: 90.0, height: 5.5 },
                    opacity: 0.7,
                    ..Element::labelled(ElementId::SectionLabel, "center")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 5.0, y: 92.0, width: 90.0, height: 6.0 },
                    opacity: 0.45,
                    ..Element::labelled(ElementId::NextUp, "center")
                },
                timer_element(),
            ],
        }
    }

    fn bible_standard() -> Self {
        Self {
            elements: vec![
                Element::body(Rect { x: 6.0, y: 10.0, width: 88.0, height: 68.0 }),
                Element {
                    rect: Rect { x: 6.0, y: 81.0, width: 88.0, height: 7.0 },
                    italic: true,
                    ..Element::labelled(ElementId::Reference, "center")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 6.0, y: 89.0, width: 88.0, height: 5.0 },
                    opacity: 0.65,
                    ..Element::labelled(ElementId::Translation, "center")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 1.5, y: 1.5, width: 10.0, height: 6.0 },
                    opacity: 0.7,
                    ..Element::labelled(ElementId::Number, "left")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 6.0, y: 92.0, width: 88.0, height: 6.0 },
                    opacity: 0.45,
                    ..Element::labelled(ElementId::NextUp, "center")
                },
                timer_element(),
            ],
        }
    }

    fn song_stream() -> Self {
        Self {
            elements: vec![
                Element::body(Rect { x: 6.0, y: 76.0, width: 88.0, height: 16.0 }),
                Element {
                    visible: false,
                    rect: Rect { x: 6.0, y: 69.0, width: 60.0, height: 5.0 },
                    ..Element::labelled(ElementId::Title, "left")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 1.5, y: 69.0, width: 8.0, height: 5.0 },
                    ..Element::labelled(ElementId::Number, "left")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 70.0, y: 69.0, width: 24.0, height: 5.0 },
                    opacity: 0.75,
                    ..Element::labelled(ElementId::SectionLabel, "right")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 6.0, y: 93.0, width: 88.0, height: 5.0 },
                    opacity: 0.5,
                    ..Element::labelled(ElementId::NextUp, "center")
                },
                timer_element(),
            ],
        }
    }

    fn bible_stream() -> Self {
        Self {
            elements: vec![
                Element::body(Rect { x: 6.0, y: 62.0, width: 88.0, height: 26.0 }),
                Element {
                    rect: Rect { x: 6.0, y: 89.0, width: 88.0, height: 5.5 },
                    italic: true,
                    ..Element::labelled(ElementId::Reference, "right")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 6.0, y: 56.0, width: 40.0, height: 5.0 },
                    opacity: 0.7,
                    ..Element::labelled(ElementId::Translation, "left")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 1.5, y: 56.0, width: 8.0, height: 5.0 },
                    ..Element::labelled(ElementId::Number, "left")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 6.0, y: 95.0, width: 88.0, height: 4.0 },
                    opacity: 0.5,
                    ..Element::labelled(ElementId::NextUp, "center")
                },
                timer_element(),
            ],
        }
    }

    /// The platform's own screen: current words big, next words underneath,
    /// and the labels that tell a musician where they are.
    fn song_confidence() -> Self {
        Self {
            elements: vec![
                Element::body(Rect { x: 4.0, y: 12.0, width: 92.0, height: 58.0 }),
                Element {
                    rect: Rect { x: 14.0, y: 2.0, width: 58.0, height: 7.0 },
                    ..Element::labelled(ElementId::Title, "left")
                },
                Element {
                    rect: Rect { x: 4.0, y: 2.0, width: 9.0, height: 7.0 },
                    opacity: 0.8,
                    ..Element::labelled(ElementId::Number, "left")
                },
                Element {
                    rect: Rect { x: 74.0, y: 2.0, width: 22.0, height: 7.0 },
                    color: "#f0a83a".into(),
                    ..Element::labelled(ElementId::SectionLabel, "right")
                },
                Element {
                    rect: Rect { x: 4.0, y: 73.0, width: 92.0, height: 24.0 },
                    opacity: 0.42,
                    ..Element::labelled(ElementId::NextUp, "center")
                },
                timer_element(),
            ],
        }
    }

    fn bible_confidence() -> Self {
        Self {
            elements: vec![
                Element::body(Rect { x: 4.0, y: 12.0, width: 92.0, height: 58.0 }),
                Element {
                    rect: Rect { x: 4.0, y: 2.0, width: 60.0, height: 7.0 },
                    color: "#f0a83a".into(),
                    ..Element::labelled(ElementId::Reference, "left")
                },
                Element {
                    rect: Rect { x: 66.0, y: 2.0, width: 30.0, height: 7.0 },
                    opacity: 0.7,
                    ..Element::labelled(ElementId::Translation, "right")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 4.0, y: 10.0, width: 8.0, height: 6.0 },
                    ..Element::labelled(ElementId::Number, "left")
                },
                Element {
                    rect: Rect { x: 4.0, y: 73.0, width: 92.0, height: 24.0 },
                    opacity: 0.42,
                    ..Element::labelled(ElementId::NextUp, "center")
                },
                timer_element(),
            ],
        }
    }

    fn media_default() -> Self {
        Self {
            elements: vec![
                // The words of a message slide. Ignored by pictures and clips,
                // which fill the screen themselves.
                Element::body(Rect { x: 8.0, y: 14.0, width: 84.0, height: 66.0 }),
                Element {
                    visible: false,
                    rect: Rect { x: 70.0, y: 4.0, width: 26.0, height: 10.0 },
                    ..Element::labelled(ElementId::Timer, "right")
                },
            ],
        }
    }

    fn timer_default() -> Self {
        Self {
            elements: vec![
                Element {
                    visible: true,
                    rect: Rect { x: 8.0, y: 26.0, width: 84.0, height: 40.0 },
                    font_weight: 700,
                    ..Element::labelled(ElementId::Timer, "center")
                },
                Element {
                    visible: false,
                    rect: Rect { x: 8.0, y: 70.0, width: 84.0, height: 10.0 },
                    opacity: 0.7,
                    ..Element::labelled(ElementId::Body, "center")
                },
            ],
        }
    }

    fn defaults_for(preset_id: &str, is_song: bool) -> Self {
        match (preset_id, is_song) {
            (PRESET_STREAM, true) => Self::song_stream(),
            (PRESET_STREAM, false) => Self::bible_stream(),
            (PRESET_CONFIDENCE, true) => Self::song_confidence(),
            (PRESET_CONFIDENCE, false) => Self::bible_confidence(),
            (_, true) => Self::song_standard(),
            (_, false) => Self::bible_standard(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Element {
    pub id: ElementId,
    pub visible: bool,
    pub rect: Rect,
    pub font_family: String,
    pub font_weight: u16,
    /// Ceiling for the auto-fitted size, as a % of screen height. 0 means no
    /// ceiling — the text simply grows until it hits the edge of its box.
    /// A cap keeps a two-word chorus from dwarfing the verse before it.
    pub max_font_scale: f64,
    pub line_height: f64,
    pub letter_spacing: f64,
    pub uppercase: bool,
    pub italic: bool,
    /// Horizontal text alignment inside the box.
    pub align: String,
    /// Vertical alignment inside the box: "top" | "middle" | "bottom".
    pub valign: String,
    pub color: String,
    pub opacity: f64,
    pub shadow: Shadow,

    /// A plate drawn behind the words. With a parallel Bible reading each
    /// translation gets its own, which is what separates them; with a single
    /// block it is simply a background for the text.
    pub panel: Panel,
}

impl Default for Element {
    fn default() -> Self {
        Self {
            id: ElementId::Body,
            visible: true,
            rect: Rect::default(),
            font_family: default_font(),
            font_weight: 700,
            max_font_scale: 0.0,
            line_height: 1.18,
            letter_spacing: 0.0,
            uppercase: false,
            italic: false,
            align: "center".into(),
            valign: "middle".into(),
            color: "#ffffff".into(),
            opacity: 1.0,
            shadow: Shadow::default(),
            panel: Panel::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Panel {
    pub color: String,
    /// 0 hides it, which is the default — most layouts want bare text.
    pub opacity: f64,
    /// Padding and corner radius are in `em`, so they scale with the
    /// auto-fitted type rather than drifting as the text resizes.
    pub padding: f64,
    pub radius: f64,
    /// Space between blocks, also in `em`.
    pub gap: f64,
}

impl Default for Panel {
    fn default() -> Self {
        Self { color: "#000000".into(), opacity: 0.0, padding: 0.4, radius: 0.3, gap: 0.4 }
    }
}

impl Element {
    fn body(rect: Rect) -> Self {
        Self { id: ElementId::Body, rect, ..Self::default() }
    }

    /// A secondary label: lighter weight than the body, so the words stay
    /// dominant even when several extras are switched on.
    fn labelled(id: ElementId, align: &str) -> Self {
        Self { id, font_weight: 600, align: align.into(), line_height: 1.1, ..Self::default() }
    }
}

/// Position and size as percentages of the screen, top-left origin.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for Rect {
    fn default() -> Self {
        Self { x: 5.0, y: 40.0, width: 90.0, height: 20.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shadow {
    pub enabled: bool,
    pub blur: f64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub color: String,
    pub opacity: f64,
}

impl Default for Shadow {
    fn default() -> Self {
        Self {
            enabled: true,
            blur: 14.0,
            offset_x: 0.0,
            offset_y: 3.0,
            color: "#000000".into(),
            opacity: 0.7,
        }
    }
}

fn default_font() -> String {
    // Covers Cyrillic on every platform LyricVerse targets.
    "Inter, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif".into()
}

// --- Consistency ----------------------------------------------------------

/// Guarantees the three built-ins exist, every layout holds exactly the
/// elements it should, and every screen points at a preset that is present.
pub fn repair(settings: &mut Settings) {
    for builtin in builtin_presets() {
        if !settings.presets.iter().any(|preset| preset.id == builtin.id) {
            settings.presets.push(builtin);
        }
    }
    // A built-in cannot be deleted, so mark them even if a hand-edited file
    // claims otherwise.
    let builtin_ids = [PRESET_STANDARD, PRESET_STREAM, PRESET_CONFIDENCE];
    for preset in &mut settings.presets {
        preset.builtin = builtin_ids.contains(&preset.id.as_str());
        if preset.name.trim().is_empty() {
            preset.name = preset.id.clone();
        }
        fill(&mut preset.song, &SONG_ELEMENTS, &preset.id, true);
        fill(&mut preset.bible, &BIBLE_ELEMENTS, &preset.id, false);
        fill_media(&mut preset.media);
        fill_fixed(&mut preset.timer, &TIMER_ELEMENTS, &Layout::timer_default());
    }

    // A web screen with no entry in `displays` could never be switched on or
    // given a preset, so make sure every one has a place to hold that.
    settings.web_screens.retain(|screen| !screen.id.trim().is_empty());
    for screen in &settings.web_screens {
        settings.displays.entry(screen.id.clone()).or_default();
    }

    let known: Vec<String> = settings.presets.iter().map(|p| p.id.clone()).collect();
    for display in settings.displays.values_mut() {
        if !known.contains(&display.preset) {
            display.preset = PRESET_STANDARD.into();
        }
    }
}

fn fill_media(layout: &mut Layout) {
    fill_fixed(layout, &MEDIA_ELEMENTS, &Layout::media_default());
}

/// Rebuilds a layout that has one fixed element list, keeping any edits.
fn fill_fixed(layout: &mut Layout, wanted: &[ElementId], defaults: &Layout) {
    let mut rebuilt = Vec::with_capacity(wanted.len());
    for id in wanted {
        rebuilt.push(
            layout
                .elements
                .iter()
                .find(|element| element.id == *id)
                .or_else(|| defaults.elements.iter().find(|element| element.id == *id))
                .cloned()
                .unwrap_or_default(),
        );
    }
    layout.elements = rebuilt;
    clamp(layout);
}

fn clamp(layout: &mut Layout) {
    for element in &mut layout.elements {
        element.rect.width = element.rect.width.clamp(2.0, 100.0);
        element.rect.height = element.rect.height.clamp(2.0, 100.0);
        element.rect.x = element.rect.x.clamp(-50.0, 100.0);
        element.rect.y = element.rect.y.clamp(-50.0, 100.0);
        element.opacity = element.opacity.clamp(0.0, 1.0);
        element.max_font_scale = element.max_font_scale.clamp(0.0, 60.0);
        element.panel.opacity = element.panel.opacity.clamp(0.0, 1.0);
        element.panel.padding = element.panel.padding.clamp(0.0, 4.0);
        element.panel.radius = element.panel.radius.clamp(0.0, 4.0);
        element.panel.gap = element.panel.gap.clamp(0.0, 4.0);
        if element.font_family.trim().is_empty() {
            element.font_family = default_font();
        }
    }
}

fn fill(layout: &mut Layout, wanted: &[ElementId], preset_id: &str, is_song: bool) {
    let defaults = Layout::defaults_for(preset_id, is_song);

    let mut rebuilt: Vec<Element> = Vec::with_capacity(wanted.len());
    for id in wanted {
        let existing = layout.elements.iter().find(|element| element.id == *id);
        rebuilt.push(match existing {
            Some(element) => element.clone(),
            None => defaults
                .elements
                .iter()
                .find(|element| element.id == *id)
                .cloned()
                .unwrap_or_default(),
        });
    }
    layout.elements = rebuilt;
    // A zero-size box would be invisible and un-grabbable in the editor; clamp
    // everything back into something the operator can find.
    clamp(layout);
}

// --- Persistence ---------------------------------------------------------

pub fn load(app: &AppHandle) -> Result<Settings> {
    let file = paths::settings_file(app)?;
    if !file.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&file)?;

    // A corrupt settings file must never stop the app from starting — a
    // service is usually about to begin.
    let value: Value = serde_json::from_str(&raw).unwrap_or_else(|err| {
        eprintln!("[lyricverse] settings.json unreadable ({err}); falling back to defaults");
        Value::Null
    });
    let value = migrate(value);

    let mut settings: Settings = serde_json::from_value(value).unwrap_or_else(|err| {
        eprintln!("[lyricverse] settings.json could not be loaded ({err}); using defaults");
        Settings::default()
    });
    repair(&mut settings);
    Ok(settings)
}

/// Converts a pre-preset file (`mode` + `standard`/`stream` per screen) into
/// the preset model, keeping whatever the operator had customised.
fn migrate(value: Value) -> Value {
    let Value::Object(mut root) = value else { return Value::Null };
    let version = root.get("version").and_then(Value::as_u64).unwrap_or(0);

    // The palette grew to hold the pictures as well, so that both can be
    // arranged in one grid. Carry over whatever colours were saved rather than
    // dropping the operator back to the defaults.
    if !root.contains_key("backgroundOrder") {
        if let Some(colors) = root.remove("backgroundColors") {
            root.insert("backgroundOrder".into(), colors);
        }
    }

    if version >= 6 {
        return Value::Object(root);
    }

    let mut presets: Vec<Value> = builtin_presets()
        .into_iter()
        .map(|preset| serde_json::to_value(preset).unwrap_or(Value::Null))
        .collect();

    if let Some(Value::Object(displays)) = root.get_mut("displays") {
        for (id, display) in displays.iter_mut() {
            let Value::Object(entry) = display else { continue };
            let mode = entry
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or(PRESET_STANDARD)
                .to_string();

            let builtin = builtin_presets()
                .into_iter()
                .find(|preset| preset.id == mode)
                .unwrap_or_default();
            let pristine = serde_json::to_value(&builtin).unwrap_or(Value::Null);

            // The style this screen was actually using, if it was customised.
            match entry.get(&mode).cloned().filter(Value::is_object) {
                Some(style) => {
                    let mut candidate = pristine.clone();
                    merge_style(&mut candidate, &style);

                    if candidate == pristine {
                        entry.insert("preset".into(), Value::String(mode.clone()));
                    } else {
                        // Presets are shared, but the old styles were
                        // per-screen — so a customised screen gets its own
                        // preset rather than silently rewriting the shared one.
                        let new_id = format!("{mode}-{id}");
                        if let Value::Object(object) = &mut candidate {
                            object.insert("id".into(), Value::String(new_id.clone()));
                            object.insert(
                                "name".into(),
                                Value::String(format!("{} ({id})", builtin.name)),
                            );
                            object.insert("builtin".into(), Value::Bool(false));
                        }
                        presets.push(candidate);
                        entry.insert("preset".into(), Value::String(new_id));
                    }
                }
                None => {
                    entry.insert("preset".into(), Value::String(mode.clone()));
                }
            }

            entry.remove("mode");
            entry.remove("standard");
            entry.remove("stream");
        }
    }

    root.insert("presets".into(), Value::Array(presets));
    root.insert("version".into(), Value::from(SETTINGS_VERSION));
    Value::Object(root)
}

/// Copies the backdrop and layout keys of an old `ModeStyle` onto a preset.
fn merge_style(target: &mut Value, style: &Value) {
    let (Value::Object(target), Value::Object(style)) = (target, style) else { return };
    for key in [
        "background",
        "backgroundMedia",
        "backgroundFit",
        "backgroundDim",
        "passiveBackground",
        "passiveBackgroundMedia",
        "passiveBackgroundFit",
        "passiveBackgroundDim",
        "song",
        "bible",
        "media",
        "timer",
    ] {
        if let Some(value) = style.get(key) {
            target.insert(key.into(), value.clone());
        }
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    let file = paths::settings_file(app)?;
    let mut to_write = settings.clone();
    to_write.version = SETTINGS_VERSION;
    repair(&mut to_write);
    // Write-then-rename so a crash mid-write cannot truncate the file.
    let temp = file.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_string_pretty(&to_write)?)?;
    fs::rename(&temp, &file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ships_three_presets() {
        let settings = Settings::default();
        let ids: Vec<&str> = settings.presets.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec![PRESET_STANDARD, PRESET_STREAM, PRESET_CONFIDENCE]);
        assert!(settings.presets.iter().all(|p| p.builtin));
    }

    #[test]
    fn repair_restores_missing_builtins_and_elements() {
        let mut settings = Settings::default();
        settings.presets.remove(1);
        settings.presets[0].song.elements.clear();
        repair(&mut settings);
        assert_eq!(settings.presets.len(), 3);
        let standard = settings.presets.iter().find(|p| p.id == PRESET_STANDARD).unwrap();
        assert_eq!(standard.song.elements.len(), SONG_ELEMENTS.len());
    }

    #[test]
    fn repair_points_a_dangling_screen_at_a_real_preset() {
        let mut settings = Settings::default();
        settings
            .displays
            .insert(
                "display-0".into(),
                DisplayConfig { enabled: true, preset: "gone".into(), ..Default::default() },
            );
        repair(&mut settings);
        assert_eq!(settings.displays["display-0"].preset, PRESET_STANDARD);
    }

    #[test]
    fn migrates_an_untouched_mode_to_the_shared_builtin() {
        let raw = serde_json::json!({
            "version": 5,
            "displays": { "display-1": { "enabled": true, "mode": "stream" } }
        });
        let mut settings: Settings = serde_json::from_value(migrate(raw)).unwrap();
        repair(&mut settings);
        assert_eq!(settings.displays["display-1"].preset, PRESET_STREAM);
        // No extra preset was invented for a screen that had no edits.
        assert_eq!(settings.presets.len(), 3);
    }

    #[test]
    fn migrates_a_customised_mode_into_its_own_preset() {
        let raw = serde_json::json!({
            "version": 5,
            "displays": {
                "display-0": {
                    "enabled": true,
                    "mode": "standard",
                    "standard": { "background": "#123456" }
                }
            }
        });
        let mut settings: Settings = serde_json::from_value(migrate(raw)).unwrap();
        repair(&mut settings);

        let id = &settings.displays["display-0"].preset;
        assert_ne!(id, PRESET_STANDARD, "a customised screen must not overwrite the shared preset");
        let preset = settings.presets.iter().find(|p| &p.id == id).unwrap();
        assert_eq!(preset.background, "#123456");
        assert!(!preset.builtin);
        // The untouched built-in is still there for other screens.
        assert_eq!(
            settings.presets.iter().find(|p| p.id == PRESET_STANDARD).unwrap().background,
            "#000000"
        );
    }
}
