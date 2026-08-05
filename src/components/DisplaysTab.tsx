import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  BIBLE_ELEMENTS,
  MEDIA_ELEMENTS,
  SONG_ELEMENTS,
  TIMER_ELEMENTS,
  type ElementId,
  type HAlign,
  type Layout,
  type LayoutElement,
  type Panel,
  type Preset,
  type Shadow,
  type VAlign,
  type WebScreenStatus,
} from "../api/types";
import { useStore } from "../app/store";
import { Icon } from "./ui/Icon";
import { ColorField, Empty, Field, Segmented, Slider, Switch } from "./ui/controls";
import { useContextMenu } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";
import { LayoutCanvas, roundRect } from "./LayoutCanvas";
import { BackgroundPicker } from "./BackgroundPicker";
import { SAMPLE_COUNT, sampleLive } from "../lib/sample";
import { PreviewCard } from "./Preview";
import { asDisplayInfo, useScreenTargets, type ScreenTarget } from "../lib/screens";

type Content = "song" | "bible" | "media" | "timer";

export function DisplaysTab() {
  const t = useStore((s) => s.t);
  const settings = useStore((s) => s.settings);
  const live = useStore((s) => s.live);
  const defaults = useStore((s) => s.defaults);
  const patchDisplay = useStore((s) => s.patchDisplay);
  const patchPreset = useStore((s) => s.patchPreset);
  const setPresets = useStore((s) => s.setPresets);
  const toast = useStore((s) => s.toast);
  const refreshDisplays = useStore((s) => s.refreshDisplays);
  const reportError = useStore((s) => s.reportError);
  const addWebScreen = useStore((s) => s.addWebScreen);
  const removeWebScreen = useStore((s) => s.removeWebScreen);
  const updateWebScreen = useStore((s) => s.updateWebScreen);
  const dialogs = useDialogs();

  const openMenu = useContextMenu();
  const [selectedDisplay, setSelectedDisplay] = useState<string | null>(null);
  const [content, setContent] = useState<Content>("song");
  const [selected, setSelected] = useState<ElementId | null>("body");
  const [variant, setVariant] = useState(0);

  const targets: ScreenTarget[] = useScreenTargets();

  const activeId =
    selectedDisplay && targets.some((item) => item.id === selectedDisplay)
      ? selectedDisplay
      : targets[0]?.id;
  const display = targets.find((item) => item.id === activeId) ?? null;
  const config = activeId ? settings.displays[activeId] : undefined;

  const preset = config
    ? settings.presets.find((item) => item.id === config.preset) ?? settings.presets[0]
    : undefined;

  const layout: Layout | null = !preset
    ? null
    : content === "bible"
      ? preset.bible
      : content === "media"
        ? preset.media
        : content === "timer"
          ? preset.timer
          : preset.song;
  const element = layout?.elements.find((item) => item.id === selected) ?? null;

  // The canvas always previews the content type being edited, never whatever
  // happens to be live: arranging the scripture layout must not show lyrics,
  // and the canvas must not change under the operator when a slide advances.
  const canvasLive = sampleLive(content, settings.language, variant);

  // The matching built-in, used by every "reset" button. A preset the operator
  // created has no pristine counterpart, so it falls back to Standard.
  const pristinePreset: Preset | null =
    defaults?.settings.presets.find((item) => item.id === preset?.id) ??
    defaults?.settings.presets[0] ??
    null;
  const pristineLayout: Layout | null = pristinePreset
    ? content === "bible"
      ? pristinePreset.bible
      : content === "media"
        ? pristinePreset.media
        : content === "timer"
          ? pristinePreset.timer
          : pristinePreset.song
    : null;
  const pristineElement =
    pristineLayout?.elements.find((item) => item.id === selected) ?? null;

  // Presets are shared: editing one changes every screen using it, which is
  // the point of having them.
  const patchStyle = (patch: Partial<Preset>) => {
    if (preset) void patchPreset(preset.id, patch);
  };

  const patchLayout = (next: Layout) => patchStyle({ [content]: next } as Partial<Preset>);

  const patchElement = (id: ElementId, patch: Partial<LayoutElement>) => {
    if (!layout) return;
    patchLayout({
      elements: layout.elements.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  };

  // Delete hides the selected element — the same thing its switch does, and
  // what the key is expected to do once a box is selected on the canvas.
  useHideOnDelete(selected, layout, (id) => patchElement(id, { visible: false }));

  if (!preset || !layout || !display || !config || !activeId) {
    return (
      <div className="workspace">
        <section className="panel" style={{ flex: 1 }}>
          <Empty title={t("preset.none")} />
        </section>
      </div>
    );
  }

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: "0 0 250px" }}>
        <div className="panel__head">
          <span className="panel__title">{t("displays.title")}</span>
          <div className="topbar__spacer" />
          <button
            className="btn btn--sm btn--icon"
            onClick={() => void api.identifyDisplays().catch(reportError)}
            title={t("displays.identify")}
          >
            <Icon name="target" size={12} />
          </button>
          <button
            className="btn btn--sm btn--icon"
            onClick={() => void refreshDisplays()}
            title={t("displays.refresh")}
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
        <div className="panel__body">
          <div className="preview">
            {targets.map((item) => {
              const itemConfig = settings.displays[item.id];
              const itemPreset = settings.presets.find((p) => p.id === itemConfig?.preset);
              const on = !!itemConfig?.enabled && !item.isPrimary;
              const info = asDisplayInfo(item);
              return (
                <button
                  key={item.id}
                  onClick={() => setSelectedDisplay(item.id)}
                  onContextMenu={(event) => {
                    setSelectedDisplay(item.id);
                    openMenu(event, [
                      {
                        label: on ? t("menu.disable") : t("menu.enable"),
                        icon: on ? "eyeOff" : "eye",
                        // The console's own screen is never a projection target.
                        disabled: item.isPrimary,
                        onSelect: () => void patchDisplay(item.id, { enabled: !on }),
                      },
                      {
                        label: t("menu.openTest"),
                        icon: "monitor",
                        onSelect: () => void api.openTestWindow(item.id).catch(reportError),
                      },
                      ...(item.web
                        ? ([
                            "separator",
                            {
                              label: t("web.rename"),
                              icon: "pencil",
                              onSelect: () =>
                                void dialogs
                                  .prompt({
                                    title: t("web.rename"),
                                    label: t("common.name"),
                                    value: item.name,
                                  })
                                  .then((name) => {
                                    if (name) void updateWebScreen(item.id, { name });
                                  }),
                            },
                            {
                              label: t("web.remove"),
                              icon: "trash",
                              danger: true,
                              onSelect: () =>
                                void dialogs
                                  .confirm({
                                    title: t("web.remove"),
                                    message: t("web.removeConfirm", { name: item.name }),
                                    confirmLabel: t("common.delete"),
                                    danger: true,
                                  })
                                  .then((ok) => {
                                    if (ok) void removeWebScreen(item.id);
                                  }),
                            },
                          ] as const)
                        : ([
                            {
                              label: t("displays.identify"),
                              icon: "target",
                              onSelect: () => void api.identifyDisplays().catch(reportError),
                            },
                          ] as const)),
                    ]);
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    borderRadius: 10,
                    padding: 8,
                    background: item.id === activeId ? "var(--panel-raised)" : "transparent",
                    border: `1px solid ${item.id === activeId ? "var(--accent-line)" : "transparent"}`,
                  }}
                >
                  <div className="preview__head">
                    <span className="preview__name">{item.name}</span>
                    <span>
                      {item.isPrimary
                        ? t("displays.primary")
                        : item.web
                          ? t("web.badge")
                          : ""}
                    </span>
                  </div>
                  {/* Every screen shows its actual output, including one that
                      is not projecting — that is the only way to see what a
                      preset does before switching it on, and the only preview
                      at all on a single-screen machine. */}
                  {itemPreset ? (
                    <div style={{ opacity: on ? 1 : 0.7 }}>
                      <PreviewCard display={info} preset={itemPreset} live={live} showName={false} />
                    </div>
                  ) : (
                    <div className="preview__frame">
                      <div className="preview__off">
                        <Icon name="eyeOff" size={18} />
                      </div>
                    </div>
                  )}
                  <div className="preview__head" style={{ marginTop: 4 }}>
                    <span>
                      {item.web ? `:${item.web.port}` : `${item.width}×${item.height}`}
                    </span>
                    <span style={{ color: on ? "var(--accent)" : undefined }}>
                      {itemPreset ? (on ? itemPreset.name : t("displays.preview")) : "—"}
                    </span>
                  </div>
                </button>
              );
            })}

            {/* Always last: the tile that adds one more, as on the Slides tab.
                A monitor announces itself; a screen on someone's tablet has to
                be asked for. */}
            <button
              className="tile tile--add"
              style={{ aspectRatio: "16 / 9" }}
              title={t("web.addHint")}
              onClick={() => void addWebScreen("")}
            >
              <Icon name="plus" size={16} />
              {t("web.add")}
            </button>
          </div>
        </div>
      </section>

      {/* --- The example screen ------------------------------------------ */}
      <section className="panel" style={{ flex: 1, minWidth: 380 }}>
        <div className="panel__head">
          <span className="panel__title">{display.name}</span>
          <div className="topbar__spacer" />
          {!display.isPrimary && (
            <Switch
              checked={config.enabled}
              onChange={(enabled) => void patchDisplay(activeId, { enabled })}
              label={t("displays.enabled")}
            />
          )}
          <button
            className="btn btn--sm"
            title={t("displays.testHint")}
            onClick={() => void api.openTestWindow(activeId).catch(reportError)}
          >
            <Icon name="eye" size={12} />
            {t("displays.test")}
          </button>
        </div>

        {/* The preset controls are a row of their own — a switch, a dropdown
            and five buttons will not fit beside a title. */}
        <div className="panel__actions" style={{ alignItems: "center" }}>
          <span className="panel__title" style={{ flex: "none" }}>
            {t("preset.label")}
          </span>
          <PresetPicker
            presets={settings.presets}
            current={preset}
            usedBy={countScreensUsing(settings, preset.id)}
            onPick={(id) => void patchDisplay(activeId, { preset: id })}
            onRename={(name) => void patchPreset(preset.id, { name })}
            onDuplicate={() => {
              const copy = duplicatePreset(preset, settings.presets);
              void setPresets([...settings.presets, copy]).then(() =>
                patchDisplay(activeId, { preset: copy.id }),
              );
              toast(t("preset.created", { name: copy.name }), "success");
            }}
            onDelete={() => {
              if (preset.builtin) return;
              const remaining = settings.presets.filter((item) => item.id !== preset.id);
              // Screens pointing at it are moved off before it disappears.
              const displaysPatch = Object.fromEntries(
                Object.entries(settings.displays).map(([id, entry]) => [
                  id,
                  entry.preset === preset.id ? { ...entry, preset: "standard" } : entry,
                ]),
              );
              void useStore
                .getState()
                .patchSettings({ presets: remaining, displays: displaysPatch });
            }}
            onReset={
              pristinePreset
                ? () =>
                    void patchPreset(preset.id, {
                      ...pristinePreset,
                      id: preset.id,
                      name: preset.name,
                      builtin: preset.builtin,
                    })
                : undefined
            }
          />
        </div>

        <div className="panel__body">
          <div style={{ padding: 14, display: "grid", gap: 12, alignContent: "start" }}>
            {display.isPrimary && (
              <div className="field__hint">{t("displays.primaryNote")}</div>
            )}

            {display.web && (
              <WebScreenAddress
                name={display.name}
                port={display.web.port}
                status={display.web.status}
                enabled={config.enabled}
                onPort={(port) => void updateWebScreen(display.id, { port })}
              />
            )}

            {/* Which set of content this layout is for. Songs and scripture
                are arranged independently — they want different things up. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Segmented
                value={content}
                onChange={setContent}
                options={[
                  { value: "song", label: t("layout.forSongs") },
                  { value: "bible", label: t("layout.forBible") },
                  { value: "media", label: t("layout.forMedia") },
                  { value: "timer", label: t("layout.forTimer") },
                ]}
              />
              <div className="topbar__spacer" />
              {/* The samples vary in length on purpose — a box that reads well
                  for two words can be unreadable for forty. */}
              <button
                className="btn btn--sm"
                title={t("layout.sampleHint")}
                onClick={() => setVariant((current) => (current + 1) % SAMPLE_COUNT)}
              >
                <Icon name="refresh" size={12} />
                {t("layout.sample")} {(variant % SAMPLE_COUNT) + 1}/{SAMPLE_COUNT}
              </button>
            </div>

            <LayoutCanvas
              preset={preset}
              live={canvasLive}
              layout={layout}
              aspect={{ width: display.width, height: display.height }}
              selected={selected}
              onSelect={setSelected}
              onChange={(id, rect) => patchElement(id, { rect: roundRect(rect) })}
            />

            {content === "media" && <div className="field__hint">{t("layout.mediaHint")}</div>}
            {content === "timer" && <div className="field__hint">{t("layout.timerHint")}</div>}

            <div className="hint-row">
              <span>{t("layout.canvasHint")}</span>
              <span className="kbd">Shift</span>
              <span>{t("layout.lockAspect")}</span>
              <span className="kbd">Alt</span>
              <span>{t("layout.noSnap")}</span>
              <span className="kbd">Delete</span>
              <span>{t("layout.deleteHint")}</span>
            </div>

            <ElementList
              layout={layout}
              content={content}
              selected={selected}
              onSelect={setSelected}
              onToggle={(id, visible) => patchElement(id, { visible })}
              onReset={pristineLayout ? () => patchLayout(pristineLayout) : undefined}
              onResetElement={
                pristineLayout
                  ? (id) => {
                      const fresh = pristineLayout.elements.find((item) => item.id === id);
                      if (fresh) patchElement(id, fresh);
                    }
                  : undefined
              }
            />

            <PresetBehaviour preset={preset} onChange={patchStyle} />

            <BackgroundGroup
              preset={preset}
              onChange={patchStyle}
              onReset={
                pristinePreset
                  ? () =>
                      patchStyle({
                        background: pristinePreset.background,
                        backgroundMedia: pristinePreset.backgroundMedia,
                        backgroundFit: pristinePreset.backgroundFit,
                        backgroundDim: pristinePreset.backgroundDim,
                        passiveBackground: pristinePreset.passiveBackground,
                        passiveBackgroundMedia: pristinePreset.passiveBackgroundMedia,
                        passiveBackgroundFit: pristinePreset.passiveBackgroundFit,
                        passiveBackgroundDim: pristinePreset.passiveBackgroundDim,
                      })
                  : undefined
              }
            />
          </div>
        </div>
      </section>

      {/* --- Properties of the selected element --------------------------- */}
      <section className="panel" style={{ flex: "0 0 300px" }}>
        <div className="panel__head">
          <span className="panel__title">
            {element ? t(`element.${element.id}`) : t("layout.noSelection")}
          </span>
        </div>
        <div className="panel__body">
          {element ? (
            <ElementInspector
              element={element}
              pristine={pristineElement}
              onChange={(patch) => patchElement(element.id, patch)}
            />
          ) : (
            <Empty title={t("layout.noSelection")} hint={t("layout.selectHint")} />
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Hides the selected element on Delete/Backspace.
 *
 * The body is exempt: it is the lyrics or the passage, and hiding it would
 * leave a screen that shows nothing at all — so it has no switch either.
 */
function useHideOnDelete(
  selected: ElementId | null,
  /** Null while no screen is selected — the hook still has to run. */
  layout: Layout | null,
  hide: (id: ElementId) => void,
) {
  const t = useStore((s) => s.t);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      // Never steal the key from a field the operator is typing in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!selected || !layout) return;

      event.preventDefault();
      if (selected === "body") {
        toast(t("layout.bodyAlwaysShown"));
        return;
      }
      if (layout.elements.find((item) => item.id === selected)?.visible) {
        hide(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, layout, hide, t, toast]);
}

/**
 * The address to open on the other device, and the port it answers on.
 *
 * The server listens on every interface, so the address shown is this
 * machine's on the local network rather than localhost — typing `localhost`
 * into a tablet would reach the tablet.
 */
function WebScreenAddress({
  name,
  port,
  status,
  enabled,
  onPort,
}: {
  name: string;
  port: number;
  status: WebScreenStatus | null;
  enabled: boolean;
  onPort: (port: number) => void;
}) {
  const t = useStore((s) => s.t);
  const toast = useStore((s) => s.toast);
  const lanAddress = useStore((s) => s.lanAddress);
  const [draft, setDraft] = useState<string | null>(null);

  const running = !!status?.running;
  const primary = status?.urls[0] ?? (lanAddress ? `http://${lanAddress}:${port}` : null);

  const commit = () => {
    if (draft === null) return;
    const next = Number(draft);
    setDraft(null);
    if (Number.isInteger(next) && next >= 1024 && next <= 65535 && next !== port) onPort(next);
  };

  return (
    <div className="group">
      <div className="group__head">
        {t("web.address")}
        <div className="topbar__spacer" />
        <span
          className="field__hint"
          style={{ color: running ? "var(--accent)" : undefined }}
        >
          {running ? t("web.running") : enabled ? t("web.starting") : t("web.stopped")}
        </span>
      </div>
      <div className="group__body">
        {status?.error && <div className="field__hint" style={{ color: "var(--live)" }}>{status.error}</div>}

        {enabled ? (
          primary ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--panel-sunken)",
                  fontSize: 15,
                }}
              >
                {primary}
              </code>
              <button
                className="btn btn--sm btn--icon"
                title={t("web.copy")}
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(primary)
                    .then(() => toast(t("web.copied"), "success"));
                }}
              >
                <Icon name="copy" size={12} />
              </button>
            </div>
          ) : (
            // No route off this machine: a laptop with Wi-Fi off, or one that
            // has only a loopback interface. The server is still up, so say so
            // rather than showing an address nobody can reach.
            <div className="field__hint">{t("web.noNetwork")}</div>
          )
        ) : (
          <div className="field__hint">{t("web.disabledHint")}</div>
        )}

        <div className="field__hint">{t("web.openHint", { name })}</div>

        <Field label={t("web.port")} hint={t("web.portHint")}>
          <input
            className="input"
            style={{ maxWidth: 120 }}
            value={draft ?? String(port)}
            inputMode="numeric"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setDraft(null);
            }}
          />
        </Field>
      </div>
    </div>
  );
}

// --- Element list with visibility toggles ---------------------------------

function ElementList({
  layout,
  content,
  selected,
  onSelect,
  onToggle,
  onReset,
  onResetElement,
}: {
  layout: Layout;
  content: Content;
  selected: ElementId | null;
  onSelect: (id: ElementId) => void;
  onToggle: (id: ElementId, visible: boolean) => void;
  onReset?: () => void;
  onResetElement?: (id: ElementId) => void;
}) {
  const t = useStore((s) => s.t);
  const openMenu = useContextMenu();
  const order =
    content === "bible"
      ? BIBLE_ELEMENTS
      : content === "media"
        ? MEDIA_ELEMENTS
        : content === "timer"
          ? TIMER_ELEMENTS
          : SONG_ELEMENTS;
  const byId = new Map(layout.elements.map((element) => [element.id, element]));

  return (
    <div className="group">
      <div className="group__head">
        {t("layout.elements")}
        {onReset && (
          <>
            <div className="topbar__spacer" />
            <span className="field__hint">{t("layout.resetAll")}</span>
            <ResetButton onClick={onReset} />
          </>
        )}
      </div>
      {/* Two or more to a row: these are short labels with a switch, and a
          column of full-width rows wastes most of the panel on empty space. */}
      <div
        className="group__body"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: 6,
        }}
      >
        {order.map((id) => {
          const element = byId.get(id);
          if (!element) return null;
          return (
            <div
              key={id}
              onClick={() => onSelect(id)}
              onContextMenu={(event) => {
                onSelect(id);
                openMenu(event, [
                  {
                    label: element.visible ? t("menu.hide") : t("menu.showElement"),
                    icon: element.visible ? "eyeOff" : "eye",
                    // Hiding the body would leave a screen showing nothing.
                    disabled: id === "body",
                    hint: id === "body" ? undefined : "Delete",
                    onSelect: () => onToggle(id, !element.visible),
                  },
                  {
                    label: t("menu.resetElement"),
                    icon: "refresh",
                    disabled: !onResetElement,
                    onSelect: () => onResetElement?.(id),
                  },
                ]);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "5px 9px",
                borderRadius: 6,
                cursor: "pointer",
                background: id === selected ? "var(--accent-soft)" : "var(--panel-sunken)",
                border: `1px solid ${id === selected ? "var(--accent-line)" : "var(--border)"}`,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  opacity: element.visible ? 1 : 0.5,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t(`element.${id}`)}
                {!element.visible && (
                  <span className="field__hint" style={{ marginLeft: 6 }}>
                    {t("layout.hidden")}
                  </span>
                )}
              </span>
              {/* The body is what the whole thing is for; hiding it would just
                  produce a blank screen. */}
              {id === "body" && content !== "timer" ? (
                <span className="field__hint">{t("layout.always")}</span>
              ) : (
                <Switch
                  checked={element.visible}
                  onChange={(visible) => onToggle(id, visible)}
                  label=""
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Inspector -------------------------------------------------------------

function ElementInspector({
  element,
  pristine,
  onChange,
}: {
  element: LayoutElement;
  /** The same element as a fresh install would have it. */
  pristine: LayoutElement | null;
  onChange: (patch: Partial<LayoutElement>) => void;
}) {
  const t = useStore((s) => s.t);
  // Each group resets only the keys it owns, so resetting the font does not
  // move a box the operator has already placed.
  const reset = (...keys: (keyof LayoutElement)[]) =>
    pristine
      ? () => onChange(Object.fromEntries(keys.map((key) => [key, pristine[key]])))
      : undefined;

  return (
    <div className="settings" style={{ maxWidth: "none", padding: 12 }}>
      <Group
        title={t("style.font")}
        onReset={reset(
          "fontFamily",
          "fontWeight",
          "maxFontScale",
          "lineHeight",
          "letterSpacing",
          "uppercase",
          "italic",
        )}
      >
        <FontPicker
          value={element.fontFamily}
          onChange={(fontFamily) => onChange({ fontFamily })}
        />
        <div className="field__hint">{t("style.autoSize")}</div>
        <Slider
          label={t("style.maxSize")}
          value={element.maxFontScale}
          min={0}
          max={40}
          step={0.5}
          unit={element.maxFontScale > 0 ? "%" : ""}
          onChange={(maxFontScale) => onChange({ maxFontScale })}
        />
        <div className="field__hint">
          {element.maxFontScale > 0 ? t("style.maxSizeOn") : t("style.maxSizeOff")}
        </div>
        <div className="grid-2">
          <Slider
            label={t("style.weight")}
            value={element.fontWeight}
            min={100}
            max={900}
            step={100}
            onChange={(fontWeight) => onChange({ fontWeight })}
          />
          <Slider
            label={t("style.lineHeight")}
            value={element.lineHeight}
            min={0.8}
            max={2.2}
            step={0.01}
            onChange={(lineHeight) => onChange({ lineHeight })}
          />
        </div>
        <Slider
          label={t("style.letterSpacing")}
          value={element.letterSpacing}
          min={-0.05}
          max={0.3}
          step={0.005}
          unit="em"
          onChange={(letterSpacing) => onChange({ letterSpacing })}
        />
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Switch
            checked={element.uppercase}
            onChange={(uppercase) => onChange({ uppercase })}
            label={t("style.uppercase")}
          />
          <Switch
            checked={element.italic}
            onChange={(italic) => onChange({ italic })}
            label={t("style.italic")}
          />
        </div>
      </Group>

      <Group title={t("style.color")} onReset={reset("color", "opacity")}>
        <ColorField
          label={t("style.textColor")}
          value={element.color}
          onChange={(color) => onChange({ color })}
        />
        <Slider
          label={t("style.opacity")}
          value={element.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(opacity) => onChange({ opacity })}
        />
      </Group>

      <Group title={t("style.align")} onReset={reset("align", "valign")}>
        <Field label={t("style.horizontal")}>
          <Segmented
            value={element.align}
            onChange={(align: HAlign) => onChange({ align })}
            options={[
              { value: "left", label: t("style.left") },
              { value: "center", label: t("style.center") },
              { value: "right", label: t("style.right") },
            ]}
          />
        </Field>
        <Field label={t("style.vertical")}>
          <Segmented
            value={element.valign}
            onChange={(valign: VAlign) => onChange({ valign })}
            options={[
              { value: "top", label: t("style.top") },
              { value: "middle", label: t("style.middle") },
              { value: "bottom", label: t("style.bottom") },
            ]}
          />
        </Field>
      </Group>

      <PanelGroup
        panel={element.panel}
        onReset={reset("panel")}
        onChange={(panel) => onChange({ panel })}
      />

      <ShadowGroup
        shadow={element.shadow}
        onReset={reset("shadow")}
        onChange={(shadow) => onChange({ shadow })}
      />
    </div>
  );
}

function FontPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useStore((s) => s.t);
  const reportError = useStore((s) => s.reportError);
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .listFonts()
      .then((list) => !cancelled && setFonts(list))
      .catch((error) => !cancelled && reportError(error));
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  // The stored value is a CSS font stack; the picker matches on its first
  // family so a stack chosen earlier still shows as selected.
  const current = useMemo(() => value.split(",")[0]?.replace(/['"]/g, "").trim() ?? "", [value]);
  const known = fonts.includes(current);

  return (
    <Field label={t("style.font")} hint={t("style.fontHint")}>
      <select
        className="select"
        value={known ? current : ""}
        onChange={(event) => {
          const family = event.target.value;
          // Keep a sans-serif fallback so a missing glyph still renders.
          onChange(family ? `${JSON.stringify(family)}, sans-serif` : value);
        }}
      >
        {!known && <option value="">{current || t("style.fontDefault")}</option>}
        {fonts.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </select>
      <div
        style={{
          marginTop: 6,
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--panel-sunken)",
          fontFamily: value,
          fontSize: 17,
          textAlign: "center",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        }}
      >
        Аа Бб Вв · Aa Bb Cc 123
      </div>
    </Field>
  );
}

/**
 * The plate behind the words. Its main use is a parallel Bible reading, where
 * one plate per translation is what tells them apart.
 */
function PanelGroup({
  panel,
  onReset,
  onChange,
}: {
  panel: Panel;
  onReset?: () => void;
  onChange: (panel: Panel) => void;
}) {
  const t = useStore((s) => s.t);
  const on = panel.opacity > 0;
  return (
    <div className="group">
      <div className="group__head">
        {t("style.panel")}
        <div className="topbar__spacer" />
        {onReset && <ResetButton onClick={onReset} />}
        <Switch
          checked={on}
          // Switching it on lands at something visible rather than at zero.
          onChange={(next) => onChange({ ...panel, opacity: next ? 0.55 : 0 })}
          label=""
        />
      </div>
      {on && (
        <div className="group__body">
          <div className="field__hint">{t("style.panelHint")}</div>
          <ColorField
            label={t("style.panelColor")}
            value={panel.color}
            onChange={(color) => onChange({ ...panel, color })}
          />
          <Slider
            label={t("style.opacity")}
            value={panel.opacity}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(opacity) => onChange({ ...panel, opacity })}
          />
          <div className="grid-2">
            <Slider
              label={t("style.panelPadding")}
              value={panel.padding}
              min={0}
              max={2}
              step={0.05}
              unit="em"
              onChange={(padding) => onChange({ ...panel, padding })}
            />
            <Slider
              label={t("style.panelRadius")}
              value={panel.radius}
              min={0}
              max={2}
              step={0.05}
              unit="em"
              onChange={(radius) => onChange({ ...panel, radius })}
            />
          </div>
          <Slider
            label={t("style.panelGap")}
            value={panel.gap}
            min={0}
            max={2}
            step={0.05}
            unit="em"
            onChange={(gap) => onChange({ ...panel, gap })}
          />
          <div className="field__hint">{t("style.panelUnits")}</div>
        </div>
      )}
    </div>
  );
}

function ShadowGroup({
  shadow,
  onReset,
  onChange,
}: {
  shadow: Shadow;
  onReset?: () => void;
  onChange: (shadow: Shadow) => void;
}) {
  const t = useStore((s) => s.t);
  return (
    <div className="group">
      <div className="group__head">
        {t("style.shadow")}
        <div className="topbar__spacer" />
        {onReset && <ResetButton onClick={onReset} />}
        <Switch
          checked={shadow.enabled}
          onChange={(enabled) => onChange({ ...shadow, enabled })}
          label=""
        />
      </div>
      {shadow.enabled && (
        <div className="group__body">
          <div className="grid-2">
            <Slider
              label={t("style.blur")}
              value={shadow.blur}
              min={0}
              max={80}
              onChange={(blur) => onChange({ ...shadow, blur })}
            />
            <Slider
              label={t("style.opacity")}
              value={shadow.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(opacity) => onChange({ ...shadow, opacity })}
            />
            <Slider
              label={t("style.offsetX")}
              value={shadow.offsetX}
              min={-40}
              max={40}
              onChange={(offsetX) => onChange({ ...shadow, offsetX })}
            />
            <Slider
              label={t("style.offsetY")}
              value={shadow.offsetY}
              min={-40}
              max={40}
              onChange={(offsetY) => onChange({ ...shadow, offsetY })}
            />
          </div>
          <ColorField
            label={t("style.shadow")}
            value={shadow.color}
            onChange={(color) => onChange({ ...shadow, color })}
          />
        </div>
      )}
    </div>
  );
}

function BackgroundGroup({
  preset,
  onReset,
  onChange,
}: {
  preset: Preset;
  onReset?: () => void;
  onChange: (patch: Partial<Preset>) => void;
}) {
  const t = useStore((s) => s.t);
  const presets = useStore((s) => s.settings.presets);
  const setPresets = useStore((s) => s.setPresets);
  const toast = useStore((s) => s.toast);

  /**
   * Copies this backdrop onto every other preset.
   *
   * The background already covers songs, scripture, slides and the timer —
   * it belongs to the preset, not to one of its layouts. What it does *not*
   * cross is presets, so this is the one that saves real work: set the look
   * once and give it to the confidence screen and the stream feed too.
   */
  const applyEverywhere = () => {
    const backdrop = {
      background: preset.background,
      backgroundMedia: preset.backgroundMedia,
      backgroundFit: preset.backgroundFit,
      backgroundDim: preset.backgroundDim,
      passiveBackground: preset.passiveBackground,
      passiveBackgroundMedia: preset.passiveBackgroundMedia,
      passiveBackgroundFit: preset.passiveBackgroundFit,
      passiveBackgroundDim: preset.passiveBackgroundDim,
    };
    void setPresets(
      presets.map((item) =>
        item.id === preset.id
          ? item
          : {
              ...item,
              ...backdrop,
              // A chroma key has to stay a flat keyable colour, so it keeps
              // its own fill rather than being given someone's photograph.
              ...(item.constantBackground ? { backgroundMedia: null, passiveBackgroundMedia: null } : {}),
            },
      ),
    );
    toast(t("style.backgroundAppliedAll", { n: presets.length - 1 }), "success");
  };
  return (
    <div className="group">
      <div className="group__head">
        {t("style.background")}
        {onReset && (
          <>
            <div className="topbar__spacer" />
            <ResetButton onClick={onReset} />
          </>
        )}
      </div>
      <div className="group__body">
        {preset.constantBackground && (
          <ColorField
            label={t("style.chroma")}
            value={preset.background}
            onChange={(background) => onChange({ background })}
          />
        )}

        {!preset.constantBackground ? (
          // Two independent backdrops: what shows behind the text, and what
          // the screen falls back to when the output is blanked. Side by side,
          // because the point of setting one is comparing it with the other —
          // and they fall back to a column when the panel is narrow.
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 20,
              alignItems: "start",
            }}
          >
            <div style={{ display: "grid", gap: 13, minWidth: 0, alignContent: "start" }}>
              <div className="group__head" style={{ padding: "8px 0 0", border: 0 }}>
                {t("style.backgroundActive")}
              </div>
              <BackgroundPicker
                backdrop={{
                  media: preset.backgroundMedia,
                  fit: preset.backgroundFit,
                  dim: preset.backgroundDim,
                }}
                color={preset.background}
                onColor={(background) => onChange({ background })}
                onChange={(patch) =>
                  onChange({
                    ...("media" in patch ? { backgroundMedia: patch.media ?? null } : {}),
                    ...(patch.fit ? { backgroundFit: patch.fit } : {}),
                    ...(patch.dim !== undefined ? { backgroundDim: patch.dim } : {}),
                  })
                }
              />
            </div>

            <div style={{ display: "grid", gap: 13, minWidth: 0, alignContent: "start" }}>
              <div className="group__head" style={{ padding: "8px 0 0", border: 0 }}>
                {t("style.backgroundPassive")}
              </div>
              <BackgroundPicker
                backdrop={{
                  media: preset.passiveBackgroundMedia,
                  fit: preset.passiveBackgroundFit,
                  dim: preset.passiveBackgroundDim,
                }}
                color={preset.passiveBackground}
                onColor={(passiveBackground) => onChange({ passiveBackground })}
                onChange={(patch) =>
                  onChange({
                    ...("media" in patch ? { passiveBackgroundMedia: patch.media ?? null } : {}),
                    ...(patch.fit ? { passiveBackgroundFit: patch.fit } : {}),
                    ...(patch.dim !== undefined ? { passiveBackgroundDim: patch.dim } : {}),
                  })
                }
              />
            </div>
          </div>
        ) : (
          // A chroma-key fill has to stay one flat colour for the switcher to
          // key on, so media is not offered here.
          <div className="field__hint">{t("style.noMediaInStream")}</div>
        )}

        {presets.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn--sm" onClick={applyEverywhere}>
              <Icon name="copy" size={12} />
              {t("style.backgroundApplyAll")}
            </button>
            <span className="field__hint" style={{ flex: 1, minWidth: 180 }}>
              {t("style.backgroundApplyAllHint")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="group">
      <div className="group__head">
        {title}
        {onReset && (
          <>
            <div className="topbar__spacer" />
            <ResetButton onClick={onReset} />
          </>
        )}
      </div>
      <div className="group__body">{children}</div>
    </div>
  );
}

/** Restores one section to the values a fresh install would have. */
function ResetButton({ onClick }: { onClick: () => void }) {
  const t = useStore((s) => s.t);
  return (
    <button
      className="btn btn--ghost btn--icon btn--sm"
      title={t("common.resetSection")}
      onClick={onClick}
    >
      <Icon name="refresh" size={11} />
    </button>
  );
}


// --- Presets --------------------------------------------------------------

function countScreensUsing(
  settings: { displays: Record<string, { preset: string }> },
  id: string,
): number {
  return Object.values(settings.displays).filter((entry) => entry.preset === id).length;
}

/** A copy under a fresh id, so the original is never edited by accident. */
function duplicatePreset(preset: Preset, existing: Preset[]): Preset {
  const base = preset.id.replace(/-copy-\d+$/, "");
  let index = 2;
  let id = `${base}-copy-${index}`;
  while (existing.some((item) => item.id === id)) {
    index += 1;
    id = `${base}-copy-${index}`;
  }
  return { ...preset, id, name: `${preset.name} (${index})`, builtin: false };
}

function PresetPicker({
  presets,
  current,
  usedBy,
  onPick,
  onRename,
  onDuplicate,
  onDelete,
  onReset,
}: {
  presets: Preset[];
  current: Preset;
  usedBy: number;
  onPick: (id: string) => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onReset?: () => void;
}) {
  const t = useStore((s) => s.t);
  const dialogs = useDialogs();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
      <select
        className="select"
        style={{ flex: 1, minWidth: 120 }}
        value={current.id}
        onChange={(event) => onPick(event.target.value)}
      >
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.name}
          </option>
        ))}
      </select>
      {/* Editing a preset changes every screen using it, so say how many. */}
      {usedBy > 1 && (
        <span className="field__hint" title={t("preset.sharedHint")}>
          ×{usedBy}
        </span>
      )}
      <button
        className="btn btn--sm btn--icon"
        title={t("preset.rename")}
        onClick={() => {
          void dialogs
            .prompt({ title: t("preset.rename"), label: t("common.name"), value: current.name })
            .then((name) => name && onRename(name));
        }}
      >
        <Icon name="pencil" size={12} />
      </button>
      <button className="btn btn--sm btn--icon" title={t("preset.duplicate")} onClick={onDuplicate}>
        <Icon name="copy" size={12} />
      </button>
      {onReset && (
        <button className="btn btn--sm btn--icon" title={t("preset.reset")} onClick={onReset}>
          <Icon name="refresh" size={12} />
        </button>
      )}
      <button
        className="btn btn--sm btn--icon btn--danger"
        title={current.builtin ? t("preset.builtinLocked") : t("preset.delete")}
        disabled={current.builtin}
        onClick={() => {
          void dialogs
            .confirm({
              title: t("preset.delete"),
              message: t("preset.deleteConfirm", { name: current.name }),
              confirmLabel: t("common.delete"),
              danger: true,
            })
            .then((ok) => ok && onDelete());
        }}
      >
        <Icon name="trash" size={12} />
      </button>
    </div>
  );
}

/** The two behaviours that used to be baked into the standard/stream modes. */
function PresetBehaviour({
  preset,
  onChange,
}: {
  preset: Preset;
  onChange: (patch: Partial<Preset>) => void;
}) {
  const t = useStore((s) => s.t);
  return (
    <div className="group">
      <div className="group__head">{t("preset.behaviour")}</div>
      {/* Two switches with a line of explanation each: side by side they read
          as a pair of choices rather than a list that keeps going. */}
      <div
        className="group__body"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}
      >
        <Field hint={t("preset.collapseHint")}>
          <Switch
            checked={preset.collapseLineBreaks}
            onChange={(collapseLineBreaks) => onChange({ collapseLineBreaks })}
            label={t("preset.collapse")}
          />
        </Field>
        <Field hint={t("preset.constantBackgroundHint")}>
          <Switch
            checked={preset.constantBackground}
            onChange={(constantBackground) => onChange({ constantBackground })}
            label={t("preset.constantBackground")}
          />
        </Field>
      </div>
    </div>
  );
}
