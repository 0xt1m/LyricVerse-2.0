import { useStore } from "../app/store";
import { LANGUAGES, LANGUAGE_NAMES, type Language } from "../lib/i18n";
import { Icon } from "./ui/Icon";
import { useEffect, useState } from "react";
import { Field, Slider, Switch } from "./ui/controls";
import { canRouteAudio } from "./AudioEngine";

const SHORTCUTS: [string, string[]][] = [
  ["shortcut.next", ["Space", "→", "PgDn"]],
  ["shortcut.prev", ["←", "PgUp"]],
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
  const patchSettings = useStore((s) => s.patchSettings);
  const toast = useStore((s) => s.toast);

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__body">
          <div className="settings">
            <div className="group">
              <div className="group__head">{t("settings.general")}</div>
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

                <Switch
                  checked={settings.blankOnSwitch}
                  onChange={(blankOnSwitch) => void patchSettings({ blankOnSwitch })}
                  label={t("settings.blankOnSwitch")}
                />
              </div>
            </div>

            <div className="group">
              <div className="group__head">{t("settings.audio")}</div>
              <div className="group__body">
                <AudioOutputPicker />
              </div>
            </div>

            {/* The same three switches as the View menu in the title bar —
                one place to find them while setting the machine up, and one
                within reach mid-service. */}
            <div className="group">
              <div className="group__head">{t("view.title")}</div>
              <div className="group__body" style={{ gap: 10 }}>
                <Field hint={t("view.hint")}>
                  <Switch
                    checked={settings.showStatusBar}
                    onChange={(showStatusBar) => void patchSettings({ showStatusBar })}
                    label={t("view.statusBar")}
                  />
                </Field>
                <Switch
                  checked={settings.showPreview}
                  onChange={(showPreview) => void patchSettings({ showPreview })}
                  label={t("view.preview")}
                />
                <Switch
                  checked={settings.showFilmstrip}
                  onChange={(showFilmstrip) => void patchSettings({ showFilmstrip })}
                  label={t("view.filmstrip")}
                />
              </div>
            </div>

            <div className="group">
              <div className="group__head">{t("settings.shortcuts")}</div>
              <div className="group__body" style={{ gap: 8 }}>
                {SHORTCUTS.map(([key, keys]) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ flex: 1, color: "var(--text-muted)" }}>{t(key)}</span>
                    {keys.map((label) => (
                      <span key={label} className="kbd">
                        {label}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="group">
              <div className="group__head">{t("settings.about")}</div>
              <div className="group__body">
                <Field label={t("settings.dataFolder")}>
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
                  </div>
                </Field>
                <div className="field__hint">
                  LyricVerse {version} · Tauri + React + TypeScript
                </div>
                <div className="field__hint">{t("settings.aboutText")}</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
