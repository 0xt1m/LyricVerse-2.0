import { api } from "../api";
import { useStore } from "../app/store";
import { LANGUAGES, LANGUAGE_NAMES, type Language } from "../lib/i18n";
import { checkForUpdate, type UpdateCheck } from "../lib/updates";
import { Icon } from "./ui/Icon";
import { useEffect, useState } from "react";
import { Field, Slider, Switch } from "./ui/controls";
import { canRouteAudio } from "./AudioEngine";
import { SongbookManager } from "./SongbookManager";
import { TranslationManager } from "./TranslationManager";

const SHORTCUTS: [string, string[]][] = [
  ["shortcut.next", ["→", "PgDn"]],
  ["shortcut.prev", ["←", "PgUp"]],
  // Space does one or the other depending on what is happening, so it is
  // listed as the thing it does first rather than left under "next slide".
  ["shortcut.toggleMedia", ["Space"]],
  ["shortcut.blank", ["Esc", "B"]],
  ["shortcut.search", ["/"]],
  ["shortcut.edit", ["E"]],
  ["shortcut.tabs", ["⌘1", "⌘2", "⌘3", "⌘4"]],
];

/**
 * Which sound device tracks and clips come out of.
 *
 * Device labels are only readable once the browser trusts the page with them,
 * and `setSinkId` is missing from some engines entirely — so this reports what
 * it can actually do rather than offering a control that does nothing.
 */
function AudioOutputPicker() {
  const t = useStore((s) => s.t);
  const settings = useStore((s) => s.settings);
  const patchSettings = useStore((s) => s.patchSettings);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const routable = canRouteAudio();

  useEffect(() => {
    if (!routable || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const load = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (!cancelled) setDevices(all.filter((device) => device.kind === "audiooutput"));
        })
        .catch(() => {});
    };
    load();
    navigator.mediaDevices.addEventListener?.("devicechange", load);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", load);
    };
  }, [routable]);

  if (!routable) {
    return <div className="field__hint">{t("settings.audioDeviceUnsupported")}</div>;
  }

  return (
    <>
      <Field label={t("settings.audioDevice")} hint={t("settings.audioDeviceHint")}>
        <select
          className="select"
          value={settings.audioDeviceId}
          onChange={(event) => void patchSettings({ audioDeviceId: event.target.value })}
        >
          <option value="">{t("settings.audioDeviceDefault")}</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {/* An unlabelled device means the page has not been granted the
                  names yet; the id is at least distinguishable. */}
              {device.label || `${t("settings.audioDeviceUnnamed")} ${device.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      </Field>
      <Slider
        label={t("settings.audioVolume")}
        value={settings.audioVolume}
        min={0}
        max={1}
        step={0.05}
        onChange={(audioVolume) => void patchSettings({ audioVolume })}
      />
    </>
  );
}

export function SettingsTab() {
  const t = useStore((s) => s.t);
  const settings = useStore((s) => s.settings);
  const dataDir = useStore((s) => s.dataDir);
  const version = useStore((s) => s.version);
  const songbooks = useStore((s) => s.songbooks);
  const translations = useStore((s) => s.translations);
  const patchSettings = useStore((s) => s.patchSettings);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);
  const [managing, setManaging] = useState<"songbooks" | "translations" | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateCheck | null>(null);

  /**
   * The startup check says nothing unless it found something, which is right
   * then and wrong here: somebody who pressed the button is owed an answer,
   * including "could not reach it".
   */
  const checkUpdate = async () => {
    setChecking(true);
    try {
      const result = await checkForUpdate();
      setUpdateState(result);
      if (result.state === "waiting") toast(t("update.ready", result), "success");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__body">
          {/* Two columns of cards, in the order a machine is actually set up:
              how the console behaves, then what is on it, then the reference
              material nobody changes. The two long cards run the full width
              rather than being squeezed into a column. */}
          <div className="settings">
            <div className="group">
              <div className="group__head">
                <Icon name="settings" size={13} />
                {t("settings.general")}
              </div>
              <div className="group__body">
                <Field label={t("settings.language")}>
                  <select
                    className="select"
                    value={settings.language}
                    onChange={(event) =>
                      void patchSettings({ language: event.target.value as Language })
                    }
                  >
                    {LANGUAGES.map((code) => (
                      <option key={code} value={code}>
                        {LANGUAGE_NAMES[code]}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field hint={t("settings.blankOnSwitchHint")}>
                  <Switch
                    checked={settings.blankOnSwitch}
                    onChange={(blankOnSwitch) => void patchSettings({ blankOnSwitch })}
                    label={t("settings.blankOnSwitch")}
                  />
                </Field>

                {/* The Songs tab has this as a button over the list, where it
                    is changed mid-service. Here it is where somebody setting a
                    machine up would look for it. */}
                <Field hint={t("settings.favouritesFirstHint")}>
                  <Switch
                    checked={settings.favouritesFirst}
                    onChange={(favouritesFirst) => void patchSettings({ favouritesFirst })}
                    label={t("songs.favouritesFirst")}
                  />
                </Field>
              </div>
            </div>

            {/* The same three switches as the View menu in the title bar —
                one place to find them while setting the machine up, and one
                within reach mid-service. */}
            <div className="group">
              <div className="group__head">
                <Icon name="eye" size={13} />
                {t("view.title")}
              </div>
              <div className="group__body" style={{ gap: 10 }}>
                <Field hint={t("view.hint")}>
                  <Switch
                    checked={settings.showStatusBar}
                    onChange={(showStatusBar) => void patchSettings({ showStatusBar })}
                    label={t("view.statusBar")}
                  />
                </Field>
                <Switch
                  checked={settings.showFilmstrip}
                  onChange={(showFilmstrip) => void patchSettings({ showFilmstrip })}
                  label={t("view.filmstrip")}
                />
                <Switch
                  checked={settings.showSidePanel}
                  onChange={(showSidePanel) => void patchSettings({ showSidePanel })}
                  label={t("view.sidePanel")}
                />

                {/* Which edge the panel docks to — a choice between two
                    places, so a picker rather than a third switch. Disabled
                    while the panel is off, when it decides nothing. */}
                <Field label={t("settings.sidePanelPlacement")}>
                  <select
                    className="select"
                    value={settings.sidePanelPlacement}
                    disabled={!settings.showSidePanel}
                    onChange={(event) =>
                      void patchSettings({
                        sidePanelPlacement: event.target.value as "right" | "bottom",
                      })
                    }
                  >
                    <option value="right">{t("view.sidePanelRight")}</option>
                    <option value="bottom">{t("view.sidePanelBottom")}</option>
                  </select>
                </Field>
              </div>
            </div>

            {/* Setting a machine up is a different job from running a service:
                here the whole library is in front of you at once, rather than
                the one songbook or translation being read from. The same
                managers the Songs and Bible tabs open, so there is one way
                each of these works and not two. */}
            <div className="group">
              <div className="group__head">
                <Icon name="book" size={13} />
                {t("settings.library")}
              </div>
              <div className="group__body" style={{ gap: 12 }}>
                <div className="settings-row">
                  <span className="settings-row__label">
                    {t("songbook.label")}
                    <div className="settings-row__sub">
                      {t("songbook.count", { n: songbooks.length })}
                    </div>
                  </span>
                  <button className="btn" onClick={() => setManaging("songbooks")}>
                    <Icon name="folder" size={13} />
                    {t("common.manage")}
                  </button>
                </div>
                <div className="settings-row">
                  <span className="settings-row__label">
                    {t("bible.translation")}
                    <div className="settings-row__sub">
                      {t("bible.count", { n: translations.length })}
                    </div>
                  </span>
                  <button className="btn" onClick={() => setManaging("translations")}>
                    <Icon name="book" size={13} />
                    {t("common.manage")}
                  </button>
                </div>

                {/* The folder belongs with the library it holds, not filed
                    under "about" — it is what somebody opens to back the
                    congregation's songs up, or to drop a module in by hand. */}
                <Field label={t("settings.dataFolder")} hint={t("settings.libraryHint")}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="input" value={dataDir} readOnly spellCheck={false} />
                    <button
                      className="btn btn--icon"
                      title={t("common.copy")}
                      onClick={() => {
                        void navigator.clipboard.writeText(dataDir);
                        toast(t("common.copied"), "success");
                      }}
                    >
                      <Icon name="copy" size={13} />
                    </button>
                    <button
                      className="btn"
                      onClick={() => void api.openDataFolder().catch(reportError)}
                    >
                      <Icon name="folder" size={13} />
                      {t("settings.openFolder")}
                    </button>
                  </div>
                </Field>
              </div>
            </div>

            <div className="group">
              <div className="group__head">
                <Icon name="volume" size={13} />
                {t("settings.audio")}
              </div>
              <div className="group__body">
                <AudioOutputPicker />
              </div>
            </div>

            <div className="group group--wide">
              <div className="group__head">
                <Icon name="grip" size={13} />
                {t("settings.shortcuts")}
              </div>
              <div className="group__body">
                <div className="shortcuts">
                  {SHORTCUTS.map(([key, keys]) => (
                    <div key={key} className="shortcut">
                      <span className="shortcut__name">{t(key)}</span>
                      {keys.map((label) => (
                        <span key={label} className="kbd">
                          {label}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="group group--wide">
              <div className="group__head">
                <Icon name="star" size={13} />
                {t("settings.about")}
              </div>
              <div className="group__body" style={{ gap: 10 }}>
                <div className="settings-row">
                  <span className="settings-row__label">
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>
                      LyricVerse {version}
                    </span>
                    <div className="settings-row__sub">
                      {updateState ? t(`update.${updateState.state}`, updateState) : t("update.auto")}
                    </div>
                  </span>
                  <button className="btn" onClick={() => void checkUpdate()} disabled={checking}>
                    <Icon name="refresh" size={13} />
                    {t("update.check")}
                  </button>
                </div>
                <div className="field__hint">{t("settings.aboutText")}</div>
                <div className="field__hint">Tauri + React + TypeScript</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {managing === "songbooks" && <SongbookManager onClose={() => setManaging(null)} />}
      {managing === "translations" && <TranslationManager onClose={() => setManaging(null)} />}
    </div>
  );
}
