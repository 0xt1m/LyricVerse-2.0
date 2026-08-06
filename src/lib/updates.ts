import { check, type Update } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
import { IS_TAURI } from "../api/net";

/**
 * Keeping the console current without ever interrupting a service.
 *
 * The check runs once at startup and the new version is downloaded there and
 * then — but it is *not* applied. This app is opened a few minutes before a
 * service, which is the worst possible moment to restart it, so the update
 * waits and is installed as the operator closes the window. By the next
 * Sunday the console is already on the new version and nobody has thought
 * about it.
 *
 * Failure here is silence by design: a hall with no wi-fi, a GitHub outage or
 * a release that has not been cut yet are all completely normal, and none of
 * them is worth a message to somebody about to run a service.
 */
let pending: Update | null = null;

/** True once a new version has been fetched and is waiting to be applied. */
export function updateIsWaiting(): boolean {
  return pending !== null;
}

/**
 * Looks for a newer version and downloads it.
 *
 * Resolves to the version that is now waiting, or null when there is nothing
 * to do — including every failure case.
 */
export async function fetchUpdate(): Promise<string | null> {
  if (!IS_TAURI || pending) return null;
  try {
    const update = await check();
    if (!update) return null;
    // Downloaded, not installed. `download` and `install` are separate calls
    // precisely so the two can happen at different times.
    await update.download();
    pending = update;
    return update.version;
  } catch {
    return null;
  }
}

/**
 * Applies a waiting update and closes the app.
 *
 * Returns false when there was nothing waiting, so the caller can let the
 * window close the ordinary way.
 *
 * The exit is deliberate rather than incidental: on Windows the installer
 * takes over and needs the app gone, and on macOS the bundle has just been
 * replaced underneath a running process. Quitting cleanly is the only sane
 * end to either.
 */
export async function installPendingUpdate(): Promise<boolean> {
  if (!pending) return false;
  try {
    await pending.install();
  } catch {
    // A failed install must not trap the operator in a window that will not
    // close; the old version simply runs again next time.
    pending = null;
    return false;
  }
  await exit(0);
  return true;
}
