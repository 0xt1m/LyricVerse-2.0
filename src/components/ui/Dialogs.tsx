import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "../../app/store";
import { Modal } from "./controls";

/**
 * In-app replacements for `window.prompt` and `window.confirm`.
 *
 * WKWebView — the engine Tauri uses on macOS — does not implement either.
 * They return `null`/`false` without showing anything, so every "rename…" and
 * "are you sure?" silently did nothing. These render real dialogs, and as a
 * bonus they match the rest of the app and can be dismissed with Escape.
 */

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** A message spans several lines; a name does not. */
  multiline?: boolean;
  /**
   * Whether an empty answer is a real answer.
   *
   * A name is not — a songbook called nothing is a mistake — so the confirm
   * button stays disabled by default. A note or a duration is: clearing one is
   * exactly how somebody takes it off again, and without this the only way out
   * was Cancel, which changed nothing.
   */
  allowEmpty?: boolean;
}

interface ColorOptions {
  title: string;
  label?: string;
  value?: string;
  confirmLabel?: string;
}

interface DialogApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  /** Pick from the system picker or type a value. Resolves null on cancel. */
  color: (options: ColorOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogApi>({
  confirm: async () => false,
  prompt: async () => null,
  color: async () => null,
});

export function useDialogs(): DialogApi {
  return useContext(DialogContext);
}

type Pending =
  | { kind: "confirm"; options: ConfirmOptions }
  | { kind: "prompt"; options: PromptOptions }
  | { kind: "color"; options: ColorOptions };

export function DialogProvider({ children }: { children: ReactNode }) {
  const t = useStore((state) => state.t);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const resolver = useRef<((value: never) => void) | null>(null);

  const settle = useCallback((value: boolean | string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(value as never);
  }, []);

  const api: DialogApi = {
    confirm: useCallback(
      (options) =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve as (value: never) => void;
          setPending({ kind: "confirm", options });
        }),
      [],
    ),
    prompt: useCallback(
      (options) =>
        new Promise<string | null>((resolve) => {
          resolver.current = resolve as (value: never) => void;
          setDraft(options.value ?? "");
          setPending({ kind: "prompt", options });
        }),
      [],
    ),
    color: useCallback(
      (options) =>
        new Promise<string | null>((resolve) => {
          resolver.current = resolve as (value: never) => void;
          setDraft(options.value?.trim() || "#000000");
          setPending({ kind: "color", options });
        }),
      [],
    ),
  };

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending?.kind === "confirm" && (
        <Modal
          title={pending.options.title}
          // Dismissing any way other than the confirm button means "no".
          onClose={() => settle(false)}
          footer={
            <>
              <button className="btn" onClick={() => settle(false)}>
                {pending.options.cancelLabel ?? t("common.cancel")}
              </button>
              <button
                className={pending.options.danger ? "btn btn--danger" : "btn btn--primary"}
                onClick={() => settle(true)}
                autoFocus
              >
                {pending.options.confirmLabel ?? t("common.confirm")}
              </button>
            </>
          }
        >
          {pending.options.message && (
            <p style={{ margin: 0, color: "var(--text-muted)" }}>{pending.options.message}</p>
          )}
        </Modal>
      )}

      {pending?.kind === "prompt" && (
        <Modal
          title={pending.options.title}
          onClose={() => settle(null)}
          footer={
            <>
              <button className="btn" onClick={() => settle(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn--primary"
                disabled={!pending.options.allowEmpty && !draft.trim()}
                onClick={() => settle(draft.trim())}
              >
                {pending.options.confirmLabel ?? t("common.save")}
              </button>
            </>
          }
        >
          <label className="field">
            {pending.options.label && (
              <span className="field__label">{pending.options.label}</span>
            )}
            {pending.options.multiline ? (
              <textarea
                className="textarea"
                rows={6}
                value={draft}
                autoFocus
                placeholder={pending.options.placeholder}
                onChange={(event) => setDraft(event.target.value)}
                // Enter is a newline here; ⌘/Ctrl+Enter commits, as it does
                // in the song editor.
                onKeyDown={(event) => {
                  const ready = pending.options.allowEmpty || draft.trim();
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && ready) {
                    event.preventDefault();
                    settle(draft.trim());
                  }
                }}
              />
            ) : (
              <input
                className="input"
                value={draft}
                autoFocus
                placeholder={pending.options.placeholder}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && draft.trim()) settle(draft.trim());
                }}
              />
            )}
          </label>
        </Modal>
      )}
      {pending?.kind === "color" && (
        <Modal
          title={pending.options.title}
          onClose={() => settle(null)}
          footer={
            <>
              <button className="btn" onClick={() => settle(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn--primary"
                disabled={!isColor(draft)}
                onClick={() => settle(draft.trim())}
              >
                {pending.options.confirmLabel ?? t("common.save")}
              </button>
            </>
          }
        >
          <label className="field">
            {pending.options.label && (
              <span className="field__label">{pending.options.label}</span>
            )}
            {/* Swatch and text field, either of which drives the other: pick it
                off the wheel, or paste the hex from a brand guide. */}
            <div className="color">
              <input
                type="color"
                value={isColor(draft) ? normaliseColor(draft) : "#000000"}
                onChange={(event) => setDraft(event.target.value)}
              />
              <input
                className="input"
                value={draft}
                autoFocus
                spellCheck={false}
                placeholder="#1b2430"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isColor(draft)) settle(draft.trim());
                }}
              />
            </div>
            <div
              style={{
                marginTop: 8,
                height: 44,
                borderRadius: 6,
                border: "1px solid var(--border-strong)",
                background: isColor(draft) ? draft.trim() : "transparent",
              }}
            />
          </label>
        </Modal>
      )}
    </DialogContext.Provider>
  );
}

/** `#abc` and `#aabbcc`, the two forms people actually type. */
function isColor(value: string): boolean {
  return /^#([\da-f]{3}|[\da-f]{6})$/i.test(value.trim());
}

/** The six-digit form `<input type="color">` insists on. */
function normaliseColor(value: string): string {
  const text = value.trim();
  if (text.length !== 4) return text;
  const [, r, g, b] = text;
  return `#${r}${r}${g}${g}${b}${b}`;
}
