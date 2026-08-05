import { useState } from "react";
import type { Timer, TimerMode } from "../api/types";
import { useStore } from "../app/store";
import {
  formatDuration,
  timerColor,
  newTimer,
  pauseTimer,
  resetTimer,
  startTimer,
  timerValue,
  useNow,
} from "../lib/timer";
import { timerDeck } from "../lib/deck";
import { Icon } from "./ui/Icon";
import { ColorField, Field, Segmented, Slider, Switch } from "./ui/controls";

const PRESET_MINUTES = [1, 2, 3, 5, 10, 15, 20, 30];

/**
 * Countdown, count-up or clock.
 *
 * It is deliberately not part of the live state: a countdown to the start of
 * the service has to survive the operator moving between songs. Each screen
 * shows it through the `Timer` layout element, which is off by default — so a
 * countdown can be put on the foyer screen without touching the projector.
 */
export function TimerTab() {
  const t = useStore((s) => s.t);
  const timer = useStore((s) => s.timer);
  const updateTimer = useStore((s) => s.updateTimer);
  const deck = useStore((s) => s.deck);
  const liveIndex = useStore((s) => s.liveIndex);
  const loadDeck = useStore((s) => s.loadDeck);
  const go = useStore((s) => s.go);
  const toggleBlank = useStore((s) => s.toggleBlank);

  // Seeded from the timer so the spinners agree with whatever the top-bar
  // control did.
  const [minutes, setMinutes] = useState(() => Math.floor((timer?.durationMs ?? 300000) / 60000));
  const [seconds, setSeconds] = useState(
    () => Math.floor(((timer?.durationMs ?? 300000) % 60000) / 1000),
  );
  const [caption, setCaption] = useState("");
  const total = minutes * 60 + seconds;

  const now = useNow(!!timer?.running || timer?.mode === "clock");
  const value = timer ? timerValue(timer, now) : 0;

  const set = (next: Timer | null) => void updateTimer(next);
  const onScreen = deck?.source === "timer" && liveIndex !== null;

  // Showing the timer full screen is just going live on a one-slide deck, so
  // the transport bar, Esc and the previews all behave as usual.
  const showFullScreen = async () => {
    await loadDeck(timerDeck(caption, t("tab.timer")));
    await go(0);
  };

  const changeMode = (mode: TimerMode) => {
    // Switching mode starts from a clean, stopped timer rather than carrying
    // a half-elapsed count into a different meaning.
    set({ ...newTimer(mode, total), label: timer?.label ?? "" });
  };

  return (
    <div className="workspace">
      <section className="panel" style={{ flex: 1 }}>
        <div className="panel__head">
          <span className="panel__title">{t("tab.timer")}</span>
          <div className="topbar__spacer" />
          <button
            className={onScreen ? "btn btn--sm" : "btn btn--sm btn--primary"}
            onClick={() => (onScreen ? void toggleBlank() : void showFullScreen())}
            disabled={!timer}
            title={t("timer.showHint")}
          >
            <Icon name={onScreen ? "eyeOff" : "eye"} size={12} />
            {onScreen ? t("transport.blankBtn") : t("timer.show")}
          </button>
          {timer && (
            <button className="btn btn--sm btn--danger" onClick={() => set(null)}>
              <Icon name="x" size={12} />
              {t("timer.clear")}
            </button>
          )}
        </div>

        <div className="panel__body">
          <div className="settings">
            <div className="group">
              <div className="group__head">{t("timer.readout")}</div>
              <div className="group__body">
                <div
                  style={{
                    fontSize: 54,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    textAlign: "center",
                    padding: "10px 0",
                    color: timer
                      ? (timerColor(timer, now) ??
                        (timer.running ? "var(--accent)" : "var(--text)"))
                      : "var(--text)",
                  }}
                >
                  {timer
                    ? timer.mode === "clock"
                      ? new Date(now).toLocaleTimeString(undefined, { hour12: false })
                      : formatDuration(value)
                    : "—"}
                </div>

                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  <button
                    className="btn btn--primary"
                    disabled={!timer || timer.mode === "clock"}
                    onClick={() =>
                      timer && set(timer.running ? pauseTimer(timer) : startTimer(timer))
                    }
                  >
                    <Icon name={timer?.running ? "eyeOff" : "chevronRight"} size={13} />
                    {timer?.running ? t("timer.pause") : t("timer.start")}
                  </button>
                  <button
                    className="btn"
                    disabled={!timer || timer.mode === "clock"}
                    onClick={() => timer && set(resetTimer(timer, total))}
                  >
                    <Icon name="refresh" size={13} />
                    {t("common.reset")}
                  </button>
                </div>
              </div>
            </div>

            <div className="group">
              <div className="group__head">{t("timer.mode")}</div>
              <div className="group__body">
                <Segmented
                  value={timer?.mode ?? "countdown"}
                  onChange={changeMode}
                  options={[
                    { value: "countdown", label: t("timer.countdown") },
                    { value: "countUp", label: t("timer.countUp") },
                    { value: "clock", label: t("timer.clock") },
                  ]}
                />

                {(timer?.mode ?? "countdown") === "countdown" && (
                  <>
                    <div className="grid-2">
                      <Field label={t("timer.minutes")}>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          max={999}
                          value={minutes}
                          onChange={(event) =>
                            setMinutes(Math.max(0, Number(event.target.value) || 0))
                          }
                        />
                      </Field>
                      <Field label={t("timer.seconds")}>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          max={59}
                          value={seconds}
                          onChange={(event) =>
                            setSeconds(Math.min(59, Math.max(0, Number(event.target.value) || 0)))
                          }
                        />
                      </Field>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {PRESET_MINUTES.map((value) => (
                        <button
                          key={value}
                          className="chip"
                          onClick={() => {
                            setMinutes(value);
                            setSeconds(0);
                            set({
                              ...newTimer("countdown", value * 60),
                              label: timer?.label ?? "",
                            });
                          }}
                        >
                          {value} {t("timer.min")}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="group">
              <div className="group__head">{t("timer.display")}</div>
              <div className="group__body">
                <Field label={t("timer.label")} hint={t("timer.labelHint")}>
                  <input
                    className="input"
                    value={timer?.label ?? ""}
                    placeholder={t("timer.labelPlaceholder")}
                    onChange={(event) =>
                      set({ ...(timer ?? newTimer("countdown", total)), label: event.target.value })
                    }
                  />
                </Field>
                <Field label={t("timer.caption")} hint={t("timer.captionHint")}>
                  <input
                    className="input"
                    value={caption}
                    placeholder={t("timer.captionPlaceholder")}
                    onChange={(event) => setCaption(event.target.value)}
                  />
                </Field>
                <Switch
                  checked={timer?.hideWhenFinished ?? false}
                  onChange={(hideWhenFinished) =>
                    set({ ...(timer ?? newTimer("countdown", total)), hideWhenFinished })
                  }
                  label={t("timer.hideWhenFinished")}
                />
                <div className="field__hint">{t("timer.elementHint")}</div>
              </div>
            </div>

            <div className="group">
              <div className="group__head">{t("timer.colors")}</div>
              <div className="group__body">
                <div className="field__hint">{t("timer.colorsHint")}</div>
                <div className="grid-2">
                  <ColorField
                    label={t("timer.warnColor")}
                    value={timer?.warnColor ?? "#f0a83a"}
                    onChange={(warnColor) =>
                      set({ ...(timer ?? newTimer("countdown", total)), warnColor })
                    }
                  />
                  <ColorField
                    label={t("timer.overrunColor")}
                    value={timer?.overrunColor ?? "#e5484d"}
                    onChange={(overrunColor) =>
                      set({ ...(timer ?? newTimer("countdown", total)), overrunColor })
                    }
                  />
                </div>
                <Slider
                  label={t("timer.warnAt")}
                  value={timer?.warnAtSeconds ?? 60}
                  min={0}
                  max={300}
                  step={5}
                  unit=" s"
                  onChange={(warnAtSeconds) =>
                    set({ ...(timer ?? newTimer("countdown", total)), warnAtSeconds })
                  }
                />
                <div className="field__hint">{t("timer.warnAtHint")}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
