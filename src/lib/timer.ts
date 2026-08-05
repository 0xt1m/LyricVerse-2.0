import { useEffect, useState } from "react";
import type { Timer } from "../api/types";

/**
 * Timers tick locally.
 *
 * The backend stores only the anchor (when a countdown ends, or when a
 * count-up began) and pushes it once. Every window then derives the digits
 * from its own clock, so a countdown stays smooth and accurate without an IPC
 * round trip every second — and stays correct even if a projection window
 * opens halfway through.
 */

/** Milliseconds remaining (countdown) or elapsed (count-up), signed. */
export function timerValue(timer: Timer, now: number): number {
  switch (timer.mode) {
    case "clock":
      return now;
    case "countdown":
      return timer.running ? timer.anchorMs - now : timer.frozenMs;
    case "countUp":
      return timer.running ? now - timer.anchorMs : timer.frozenMs;
  }
}

export function formatDuration(ms: number): string {
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  const body = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  // A countdown that has run over reads "-0:42" rather than freezing at zero,
  // so the platform can see by how much.
  return negative ? `−${body}` : body;
}

export function formatClock(now: number): string {
  return new Date(now).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function timerText(timer: Timer, now: number): string | null {
  if (timer.mode === "clock") return formatClock(now);
  const value = timerValue(timer, now);
  if (timer.mode === "countdown" && value <= 0 && timer.hideWhenFinished) return null;
  return formatDuration(value);
}

/** Re-renders about four times a second — enough for seconds to look instant. */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [active, intervalMs]);
  return now;
}

/** The text a display should draw, or null when the timer shows nothing. */
export function useTimerText(timer: Timer | null): string | null {
  const active = !!timer && (timer.running || timer.mode === "clock");
  const now = useNow(active);
  if (!timer) return null;
  return timerText(timer, active ? now : Date.now());
}

/**
 * Reads a duration the way an operator types one.
 *
 * "5" is five minutes — the unit people mean when they say a number out loud
 * about a countdown. A colon makes it explicit: "5:30", or "1:05:00" for an
 * hour. Returns seconds, or null when it cannot be read.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().replace(/\s+/g, "");
  if (!text) return null;

  if (text.includes(":")) {
    const parts = text.split(":");
    if (parts.length > 3 || parts.some((part) => part !== "" && !/^\d+$/.test(part))) return null;
    const numbers = parts.map((part) => Number(part || 0));
    const seconds = numbers.reduce((total, value) => total * 60 + value, 0);
    return Number.isFinite(seconds) ? seconds : null;
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Math.round(Number(text) * 60);
}

export function newTimer(mode: Timer["mode"], seconds: number): Timer {
  return {
    mode,
    label: "",
    anchorMs: Date.now() + seconds * 1000,
    frozenMs: mode === "countdown" ? seconds * 1000 : 0,
    durationMs: seconds * 1000,
    running: false,
    hideWhenFinished: false,
    overrunColor: "#e5484d",
    warnAtSeconds: 60,
    warnColor: "#f0a83a",
  };
}

/**
 * The colour the digits should be right now, or null to keep the element's own.
 *
 * A countdown that has run over must be impossible to misread from the back
 * of a room, so it wins over whatever the layout says.
 */
export function timerColor(timer: Timer, now: number): string | null {
  if (timer.mode !== "countdown") return null;
  const remaining = timerValue(timer, now);
  if (remaining < 0) return timer.overrunColor || null;
  if (timer.warnAtSeconds > 0 && remaining <= timer.warnAtSeconds * 1000) {
    return timer.warnColor || null;
  }
  return null;
}

/** Starting resumes from wherever it was paused, not from the original value. */
export function startTimer(timer: Timer): Timer {
  const now = Date.now();
  if (timer.mode === "clock") return { ...timer, running: true };
  return {
    ...timer,
    running: true,
    anchorMs: timer.mode === "countdown" ? now + timer.frozenMs : now - timer.frozenMs,
  };
}

export function pauseTimer(timer: Timer): Timer {
  return { ...timer, running: false, frozenMs: timerValue(timer, Date.now()) };
}

/** Back to the duration it was set to; `seconds` overrides that when given. */
export function resetTimer(timer: Timer, seconds?: number): Timer {
  const durationMs = seconds !== undefined ? seconds * 1000 : timer.durationMs;
  return {
    ...timer,
    running: false,
    durationMs,
    frozenMs: timer.mode === "countdown" ? durationMs : 0,
    anchorMs: Date.now() + durationMs,
  };
}
